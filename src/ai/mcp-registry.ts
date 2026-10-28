// SPDX-License-Identifier: AGPL-3.0-or-later

/// MCP サーバーの接続管理とツール呼び出し。

import { config, get } from '../config.ts';
import { log, error } from '../log.ts';
import { connectMcp, flattenToolName, type McpConnection, type McpServerConfig, type McpTool } from './mcp.ts';

interface State {
  cfg: McpServerConfig;
  conn?: McpConnection;
  tools: McpTool[];
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'disabled';
  lastError?: string;
}

const states = new Map<string, State>();

export const applyMcpConfigs = (configs: McpServerConfig[]): void => {
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

export const connectMcpServer = async (name: string): Promise<void> => {
  const st = states.get(name);
  if (!st) throw new Error(`no such MCP server: ${name}`);
  st.status = 'connecting';
  st.lastError = undefined;
  try {
    const conn = await connectMcp(st.cfg);
    st.conn = conn;
    st.tools = await conn.tools();
    st.status = 'connected';
  } catch (e: any) {
    st.status = 'error';
    st.lastError = e?.message ?? String(e);
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
    try {
      const conn = await connectMcp(st.cfg);
      st.conn = conn;
      st.tools = await conn.tools();
      st.status = 'connected';
    } catch (e: any) {
      st.status = 'error';
      st.lastError = e?.message ?? String(e);
      error('mcp connect failed:', st.cfg.name, e);
    }
  }));
};

export const getMcpTools = (): McpTool[] =>
  [...states.values()].filter(s => s.status === 'connected').flatMap(s => s.tools);

export const callMcpTool = async (flatName: string, args: unknown): Promise<{ ok: boolean; text: string } | null> => {
  const parts = (await import('./mcp.ts')).splitToolName(flatName);
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

export const getMcpStatus = (): Array<{ name: string; status: string; toolCount: number; lastError?: string }> =>
  [...states.values()].map(s => ({ name: s.cfg.name, status: s.status, toolCount: s.tools.length, lastError: s.lastError }));
