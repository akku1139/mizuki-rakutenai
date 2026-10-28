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

/** ツール結果の中の 1 ブロックを、モデルに渡せるテキストにする */
const blockText = async (
  block: any,
  read: (uri: string) => Promise<string>,
): Promise<string> => {
  const type = block?.type;
  if (type === 'text' && typeof block.text === 'string') return block.text;
  if (type === 'image') {
    return `[画像 ${block.mimeType ?? '不明'} (${Math.round((block.data?.length ?? 0) * 0.75).toLocaleString()} バイト)]`;
  }
  if (type === 'audio') {
    return `[音声 ${block.mimeType ?? '不明'} (${Math.round((block.data?.length ?? 0) * 0.75).toLocaleString()} バイト)]`;
  }
  // 埋め込みリソース: テキストなら中身、blob なら概要、uri だけなら取りに行く
  if (type === 'resource') {
    const resource = block.resource ?? {};
    if (typeof resource.text === 'string') return resource.text;
    if (typeof resource.blob === 'string') {
      return `[バイナリ ${resource.mimeType ?? '不明'} (${Math.round(resource.blob.length * 0.75).toLocaleString()} バイト)]`;
    }
    if (typeof resource.uri === 'string') return await read(resource.uri);
    return '[resource content omitted]';
  }
  // リソースへのリンク: 中身を取りに行く (取れなければリンクを返す)
  if (type === 'resource_link') {
    if (typeof block.uri === 'string') {
      const body = await read(block.uri);
      if (body !== '') return body;
      return `[${block.name ?? 'resource'}] ${block.uri}`;
    }
    return '[resource_link content omitted]';
  }
  return type === undefined ? '' : `[${type} content omitted]`;
};

/**
 * ツールの結果をテキストにする。
 *
 * MCP のツール結果は text だけではない。GitHub MCP の `get_file_contents` のように
 * `resource` (埋め込みリソース) で返す実装があり、text 以外を捨てるとモデルには
 * 「[resource content omitted]」しか届かない (実際にこれでファイルの中身が読めなかった)。
 */
export async function resultText(
  result: { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean },
  readResource: (uri: string) => Promise<string>,
): Promise<{ text: string; ok: boolean }> {
  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    const text = await blockText(block, readResource);
    if (text !== '') parts.push(text);
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join('\n').trim();
  return { text: text === '' ? '(no content)' : text, ok: result?.isError !== true };
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
      return resultText(res, async (uri: string) => {
        try {
          const read: any = await client.readResource({ uri });
          const contents: any[] = read?.contents ?? [];
          return contents
            .map(c => (typeof c?.text === 'string'
              ? c.text
              : `[バイナリ ${c?.mimeType ?? '不明'} (${Math.round((c?.blob?.length ?? 0) * 0.75).toLocaleString()} バイト)]`))
            .join('\n')
            .trim();
        } catch (err) {
          return `[${uri} は読めませんでした: ${err instanceof Error ? err.message : String(err)}]`;
        }
      });
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
