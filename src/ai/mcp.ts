// SPDX-License-Identifier: AGPL-3.0-or-later

/// MCP クライアント接続 (teapot の実装を移植)。

import type { Client } from '@modelcontextprotocol/client';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SSEClientTransport } from '@modelcontextprotocol/client';
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

type McpSdk = typeof import('@modelcontextprotocol/client') & {
  StdioClientTransport: typeof import('@modelcontextprotocol/client/stdio').StdioClientTransport;
};
let sdkPromise: Promise<McpSdk> | undefined;
async function mcpSdk(): Promise<McpSdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const [client, stdio] = await Promise.all([
        import('@modelcontextprotocol/client'),
        import('@modelcontextprotocol/client/stdio'),
      ]);
      return { ...client, StdioClientTransport: stdio.StdioClientTransport } as McpSdk;
    })();
  }
  return sdkPromise;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
}

export interface McpServerConfig {
  name: string;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  transport?: 'http' | 'sse' | 'stdio';
  enabled?: boolean;
  timeoutMs?: number;
}

export interface McpAuth { provider: unknown; }

export interface McpConnection {
  tools(): Promise<McpTool[]>;
  call(name: string, args: unknown): Promise<{ text: string; ok: boolean }>;
  finishAuth(code: string, iss?: string): Promise<McpConnection>;
  close(): Promise<void>;
}

function resultText(result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }): { text: string; ok: boolean } {
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type) parts.push(`[${c.type} content omitted]`);
  }
  return { text: parts.join('\n') || '(no content)', ok: result?.isError !== true };
}

function toTools(list: { tools?: Array<Record<string, unknown>> }, server: string): McpTool[] {
  const out: McpTool[] = [];
  for (const t of list?.tools ?? []) {
    const name = typeof t.name === 'string' ? t.name : '';
    if (!name) continue;
    const schema = t.inputSchema;
    out.push({
      name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Record<string, unknown>) : { type: 'object', properties: {} },
      server,
    });
  }
  return out;
}

export async function connectMcp(cfg: McpServerConfig, auth?: { provider: any }): Promise<McpConnection> {
  const sdk = await mcpSdk();
  const transport = cfg.transport ?? (cfg.command && !cfg.url ? 'stdio' : 'http');
  const client = new sdk.Client({ name: 'mizuki', version: '1' });
  let session: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

  if (transport === 'stdio') {
    if (!cfg.command) throw new Error(`MCP server "${cfg.name}" has no command`);
    session = new sdk.StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      stderr: 'inherit',
    });
  } else if (transport === 'sse') {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has no url`);
    const url = new URL(cfg.url);
    session = new sdk.SSEClientTransport(url, {
      redirectPolicy: 'same-origin',
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      ...(auth ? { authProvider: auth.provider } : {}),
    });
  } else {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has no url`);
    const url = new URL(cfg.url);
    session = new sdk.StreamableHTTPClientTransport(url, {
      redirectPolicy: 'same-origin',
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      ...(auth ? { authProvider: auth.provider } : {}),
    });
  }

  try {
    await client.connect(session);
  } catch (err) {
    if (auth) {
      const conn = {
        async tools() { return []; },
        async call() { return { text: 'not connected', ok: false }; },
        async finishAuth(code: string, iss?: string) {
          if (typeof (session as any).finishAuth !== 'function') throw new Error('this transport has no OAuth flow');
          await (session as any).finishAuth(iss === undefined ? code : new URLSearchParams({ code, iss }));
          await client.close().catch(() => {});
          return await connectMcp(cfg, auth);
        },
        async close() { await client.close().catch(() => {}); },
      } as McpConnection;
      throw Object.assign(err as Error, { connection: conn });
    }
    throw err;
  }
  return {
    async tools() {
      const all: McpTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const res: any = await client.listTools(cursor ? { cursor } : undefined);
        all.push(...toTools(res, cfg.name));
        const next = res?.nextCursor;
        if (typeof next !== 'string') return all;
        if (seen.has(next)) throw new Error('MCP tool pagination returned the same cursor twice');
        seen.add(next);
        cursor = next;
      }
      throw new Error('MCP tools/list did not finish within 50 pages');
    },
    async call(name, args) {
      const res: any = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
      return resultText(res);
    },
    async finishAuth(code: string, iss?: string) {
      if (typeof (session as any).finishAuth !== 'function') throw new Error('this transport has no OAuth flow');
      await (session as any).finishAuth(iss === undefined ? code : new URLSearchParams({ code, iss }));
      await client.close().catch(() => {});
      return await connectMcp(cfg, auth);
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

export function flattenToolName(server: string, tool: string): string {
  const s = server.replace(/__/g, '_');
  return `mcp__${s}__${tool}`;
}

export function splitToolName(flat: string): { server: string; tool: string } | null {
  if (!flat.startsWith('mcp__')) return null;
  const rest = flat.slice('mcp__'.length);
  const at = rest.indexOf('__');
  if (at <= 0 || at === rest.length - 2) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}
