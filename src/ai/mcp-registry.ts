// SPDX-License-Identifier: AGPL-3.0-or-later

/// MCP サーバーの接続管理とツール呼び出し。

import { config, get } from '../config.ts';
import { log, error } from '../log.ts';
import { connectMcp, flattenToolName, splitToolName, type McpConnection, type McpServerConfig, type McpTool } from './mcp.ts';
import { McpAuthStore, ServerAuth, listenForCallback, FLOW_TIMEOUT_MS } from './mcp-oauth-manager.ts';

interface State {
  cfg: McpServerConfig;
  conn?: McpConnection;
  tools: McpTool[];
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'disabled' | 'authorizing';
  lastError?: string;
  oauthRequired?: boolean;
}

const states = new Map<string, State>();
const auths = new Map<string, ServerAuth>();
let store: McpAuthStore | null = null;
const flows = new Map<string, { redirectUrl: string; wait: (t: number) => Promise<{ code: string; iss?: string }>; close: () => Promise<void> }>();

export const applyMcpConfigs = (configs: McpServerConfig[]): void => {
  if (!store) store = new McpAuthStore('./data');
  const wanted = new Set(configs.map(c => c.name));
  for (const [name, st] of states) {
    if (!wanted.has(name)) {
      void st.conn?.close();
      states.delete(name);
    }
  }
  for (const cfg of configs) {
    if (!states.has(cfg.name)) {
      states.set(cfg.name, { cfg, tools: [], status: cfg.enabled === false ? 'disabled' : 'disconnected' });
    } else {
      const st = states.get(cfg.name)!;
      if (JSON.stringify(st.cfg) !== JSON.stringify(cfg)) {
        void st.conn?.close();
        st.conn = undefined;
        st.tools = [];
        st.status = cfg.enabled === false ? 'disabled' : 'disconnected';
      }
      st.cfg = cfg;
    }
  }
};

const authFor = async (name: string, redirectUrl = 'http://127.0.0.1/callback'): Promise<ServerAuth | undefined> => {
  if (!store) store = new McpAuthStore('./data');
  const existing = auths.get(name);
  if (existing) return existing;
  const stored = await store.get(name);
  const auth = new ServerAuth(name, redirectUrl, (server, data) => store!.set(server, data));
  await auth.hydrate(stored);
  auths.set(name, auth);
  return auth;
};

export const connectMcpServer = async (name: string): Promise<void> => {
  const st = states.get(name);
  if (!st) throw new Error(`no such MCP server: ${name}`);
  st.status = 'connecting';
  st.lastError = undefined;
  const auth = await authFor(name);
  const authArg = auth ? { provider: auth } : undefined;
  try {
    const conn = await connectMcp(st.cfg, authArg);
    st.conn = conn;
    st.tools = await conn.tools();
    st.status = 'connected';
    st.oauthRequired = false;
  } catch (e: any) {
    st.status = 'error';
    st.lastError = e?.message ?? String(e);
    const needsAuth = e?.status === 401 || e?.status === 403 || /unauthoriz|invalid_token|authorization required/i.test(e?.message ?? '');
    if (needsAuth) {
      st.oauthRequired = true;
      st.lastError = 'this server requires OAuth — use authorize';
    }
    throw e;
  }
};

export const connectAllMcp = async (): Promise<void> => {
  const cfgs = get(config, 'mcpServers', []) as McpServerConfig[];
  applyMcpConfigs(cfgs);
  await Promise.all([...states.keys()].map(async name => {
    const st = states.get(name)!;
    if (st.cfg.enabled === false) { st.status = 'disabled'; return; }
    st.status = 'connecting';
    const auth = await authFor(name);
    const authArg = auth ? { provider: auth } : undefined;
    try {
      const conn = await connectMcp(st.cfg, authArg);
      st.conn = conn;
      st.tools = await conn.tools();
      st.status = 'connected';
      st.oauthRequired = false;
    } catch (e: any) {
      st.status = 'error';
      st.lastError = e?.message ?? String(e);
      const needsAuth = e?.status === 401 || e?.status === 403 || /unauthoriz|invalid_token|authorization required/i.test(e?.message ?? '');
      if (needsAuth) {
        st.oauthRequired = true;
        st.lastError = 'this server requires OAuth — use authorize';
      }
      error('mcp connect failed:', st.cfg.name, e);
    }
  }));
};

export const getMcpTools = (): McpTool[] =>
  [...states.values()].filter(s => s.status === 'connected').flatMap(s => s.tools);

export const callMcpTool = async (flatName: string, args: unknown): Promise<{ ok: boolean; text: string } | null> => {
  const parts = splitToolName(flatName);
  if (!parts) return null;
  const st = states.get(parts.server);
  if (!st) return { ok: false, text: `no such MCP server: ${parts.server}` };
  if (st.status !== 'connected' || !st.conn) {
    try { await connectAllMcp(); } catch {}
    const st2 = states.get(parts.server);
    if (!st2 || st2.status !== 'connected' || !st2.conn) {
      return { ok: false, text: `MCP server "${parts.server}" is not connected` };
    }
  }
  try {
    return await states.get(parts.server)!.conn!.call(parts.tool, args);
  } catch (e: any) {
    return { ok: false, text: `MCP call failed: ${e?.message ?? e}` };
  }
};

export const getMcpStatus = (): Array<{ name: string; status: string; toolCount: number; lastError?: string; oauthRequired?: boolean }> =>
  [...states.values()].map(s => ({ name: s.cfg.name, status: s.status, toolCount: s.tools.length, lastError: s.lastError, oauthRequired: s.oauthRequired }));

export const startMcpOAuth = async (name: string): Promise<{ url: string }> => {
  const st = states.get(name);
  if (!st) throw new Error(`no such MCP server: ${name}`);
  if (!st.cfg.url) throw new Error('OAuth needs an http(s) url; a stdio server has no authorizer');
  const existing = flows.get(name);
  if (existing) await existing.close().catch(() => {});

  const loop = await listenForCallback();
  const auth = new ServerAuth(name, loop.redirectUrl, (server, data) => store!.set(server, data));
  if (store) await auth.hydrate(await store.get(name));
  auths.set(name, auth);

  const pending = { redirectUrl: loop.redirectUrl, wait: loop.wait, close: loop.close };
  flows.set(name, pending);

  st.oauthRequired = true;
  let pendingConn: McpConnection | null = null;
  try {
    const conn = await connectMcp(st.cfg, { provider: auth });
    st.conn = conn;
    st.tools = await conn.tools();
    st.status = 'connected';
    st.oauthRequired = false;
    await loop.close().catch(() => {});
    flows.delete(name);
    return { url: '' };
  } catch (err: any) {
    pendingConn = (err as { connection?: McpConnection }).connection ?? null;
    const url = auth.pendingUrl?.() ?? (auth as any).authUrl?.toString?.();
    if (!url) {
      const message = err?.message ?? String(err);
      auth.markError(message);
      await loop.close().catch(() => {});
      flows.delete(name);
      throw new Error(`could not start the authorization flow: ${message}`);
    }
    st.status = 'authorizing';
    void (async () => {
      try {
        const { code, iss } = await loop.wait(FLOW_TIMEOUT_MS);
        const conn = pendingConn;
        if (!conn) throw new Error('the authorization flow lost its connection');
        const live = await conn.finishAuth(code, iss ?? auth.expectedIssuer());
        await conn.close().catch(() => {});
        st.conn = live;
        st.tools = await live.tools();
        st.status = 'connected';
        st.oauthRequired = false;
        st.lastError = undefined;
        await loop.close().catch(() => {});
        flows.delete(name);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        auth.markError(msg);
        if (st.status === 'authorizing') st.status = 'error';
        st.lastError = msg;
        await loop.close().catch(() => {});
        flows.delete(name);
      }
    })();
    return { url };
  }
};
