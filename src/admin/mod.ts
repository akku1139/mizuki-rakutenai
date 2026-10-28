// SPDX-License-Identifier: AGPL-3.0-or-later

/// LAN 向けの読み取り専用管理パネル (Node 組み込み http)。

import http from 'node:http';
import fs from 'node:fs';
import { config, get, saveConfig } from '../config.ts';
import { getLogEntries, log } from '../log.ts';
import { getAIStatus } from '../ai/mod.ts';
import { getAllPrefs } from '../ai/prefs.ts';
import { getAnkas } from '../anka.ts';
import { getSyncPairs } from '../fluxsync/mod.ts';
import { discord, fluxer } from '../clients.ts';
import { getMcpStatus, applyMcpConfigs, connectMcpServer, startMcpOAuth } from '../ai/mcp-registry.ts';

const PORT = get(config, 'admin.port', 8080);
const TOKEN = get(config, 'admin.token', null);

const UI = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

const send = (res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
};

const json = (res: http.ServerResponse, status: number, data: unknown): void =>
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');

const authorized = (req: http.IncomingMessage): boolean => {
  if (!TOKEN) return true;
  const h = req.headers['authorization'] ?? '';
  return h === `Bearer ${TOKEN}`;
};

export const setupAdmin = (): void => {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
  const parsed = new URL(url, 'http://localhost');
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    send(res, 200, UI, 'text/html; charset=utf-8');
    return;
  }
  if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
  if (parsed.pathname === '/api/status') {
    json(res, 200, { ...getAIStatus(), ankas: getAnkas() });
    return;
  }
  if (parsed.pathname === '/api/sync') {
    json(res, 200, getSyncPairs());
    return;
  }
  if (parsed.pathname === '/api/ai-prefs') {
    json(res, 200, getAllPrefs());
    return;
  }
  if (parsed.pathname === '/api/logs') {
    json(res, 200, getLogEntries());
    return;
  }
  if (parsed.pathname === '/api/mcp' && req.method === 'GET') {
    const statuses = new Map(getMcpStatus().map(s => [s.name, s]));
    const out = (config.mcpServers ?? []).map(c => ({ ...c, ...(statuses.get(c.name) ?? {}) }));
    json(res, 200, out);
    return;
  }
  if (parsed.pathname === '/api/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const cfg = JSON.parse(body);
        config.mcpServers = config.mcpServers ?? [];
        const idx = config.mcpServers.findIndex(c => c.name === cfg.name);
        if (idx >= 0) config.mcpServers[idx] = cfg;
        else config.mcpServers.push(cfg);
        saveConfig();
        applyMcpConfigs(config.mcpServers);
        try { await connectMcpServer(cfg.name); } catch {}
        json(res, 200, { ok: true });
      } catch (e: any) {
        json(res, 400, { error: e?.message ?? String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/mcp' && req.method === 'DELETE') {
    const name = parsed.searchParams.get('name');
    if (!name) { json(res, 400, { error: 'name required' }); return; }
    config.mcpServers = (config.mcpServers ?? []).filter(c => c.name !== name);
    saveConfig();
    applyMcpConfigs(config.mcpServers);
    json(res, 200, { ok: true });
    return;
  }
  if (parsed.pathname === '/api/mcp/oauth' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name } = JSON.parse(body);
        const r = await startMcpOAuth(name);
        json(res, 200, r);
      } catch (e: any) {
        json(res, 400, { error: e?.message ?? String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/mcp/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name } = JSON.parse(body);
        await connectMcpServer(name);
        json(res, 200, { ok: true });
      } catch (e: any) {
        json(res, 400, { error: e?.message ?? String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/channels' && req.method === 'GET') {
    const out: Array<{ id: string, name: string, platform: string, position?: number, blacklisted: boolean }> = [];
    for (const [client, platform] of [[discord, 'discord'], [fluxer, 'fluxer']] as const) {
      for (const g of client.guilds.cache.values()) {
        const cats = new Map((g.channels.cache.filter((c: any) => c.type === 4).map((c: any) => [c.id, c.name])));
        const channels = [...g.channels.cache.values()]
          .filter((c: any) => c.isTextBased && c.isTextBased())
          .sort((a: any, b: any) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));
        for (const c of channels) {
          const cat = c.parentId ? cats.get(c.parentId) : undefined;
          out.push({ id: c.id, name: `${g.name} / ${cat ? cat + ' / ' : ''}${c.name}`, platform, position: (c as any).rawPosition ?? (c as any).position ?? 0, blacklisted: (config.blacklistedChannels ?? []).includes(c.id) || (!!c.parentId && (config.blacklistedChannels ?? []).includes(c.parentId)) });
        }
        let threads: any[] = [];
        try {
          const fetched = await (g as any).threads?.fetchActive?.();
          threads = fetched ? [...fetched.threads.values()] : [...((g as any).threads?.cache?.values?.() ?? [])];
        } catch {
          threads = [...((g as any).threads?.cache?.values?.() ?? [])];
        }
        for (const t of threads) {
          let parent = t.parent;
          if (!parent && t.parentId) {
            try { parent = await client.channels.fetch(t.parentId); } catch { parent = null; }
          }
          const cat = parent?.parentId ? cats.get(parent.parentId) : undefined;
          const parentName = parent?.name ?? (t.parentId ? t.parentId : '?');
          out.push({ id: t.id, name: `${g.name} / ${cat ? cat + ' / ' : ''}#${parentName} / ${t.name}`, platform, position: (t as any).rawPosition ?? 0, blacklisted: (config.blacklistedChannels ?? []).includes(t.id) || (!!t.parentId && (config.blacklistedChannels ?? []).includes(t.parentId)) });
        }
      }
    }
    json(res, 200, out);
    return;
  }
  if (parsed.pathname === '/api/blacklist' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { channelId, blacklisted } = JSON.parse(body);
        // スレッドの場合は親チャンネルIDを保存する
        let targetId = channelId;
        for (const client of [discord, fluxer]) {
          for (const g of client.guilds.cache.values()) {
            const ch = g.channels.cache.get(channelId) ?? (g as any).threads?.cache?.get?.(channelId);
            if (ch && 'parentId' in ch && ch.parentId) { targetId = ch.parentId; break; }
          }
        }
        config.blacklistedChannels = config.blacklistedChannels ?? [];
        if (blacklisted) {
          if (!config.blacklistedChannels.includes(targetId)) config.blacklistedChannels.push(targetId);
        } else {
          config.blacklistedChannels = config.blacklistedChannels.filter(x => x !== targetId);
        }
        saveConfig();
        json(res, 200, { ok: true });
      } catch (e: any) {
        json(res, 400, { error: e?.message ?? String(e) });
      }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
  });
  server.listen(PORT, () => {
    log(`admin panel listening on http://0.0.0.0:${PORT}/`);
  });
};
