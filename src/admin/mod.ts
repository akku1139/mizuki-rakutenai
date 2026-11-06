// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseJson } from '../utils.ts';

/// LAN 向けの読み取り専用管理パネル (Node 組み込み http)。

import http from 'node:http';
import { ChannelType, type ThreadChannel } from 'discord.js';
import type { McpServerConfig } from '../config.ts';
import fs from 'node:fs';
import { config, get, saveConfig } from '../config.ts';
import { getLogEntries, log } from '../log.ts';
import { getAIStatus } from '../ai/mod.ts';
import { getAllPrefs } from '../ai/prefs.ts';
import { getAnkas } from '../anka.ts';
import { getSyncPairs } from '../fluxsync/mod.ts';
import { cancelJob, clearFinishedJobs, enqueueJob, getJob, jobSummary, listJobs } from '../jobs/mod.ts';
import { discord, fluxer } from '../clients.ts';
import { getMcpStatus, applyMcpConfigs, connectMcpServer, startMcpOAuth } from '../ai/mcp-registry.ts';

const PORT = get(config, 'admin.port', 8080);
const TOKEN = get<string | null>(config, 'admin.token', null);

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
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      try {
        const cfg = parseJson(body) as McpServerConfig;
        config.mcpServers = config.mcpServers ?? [];
        const idx = config.mcpServers.findIndex(c => c.name === cfg.name);
        if (idx >= 0) config.mcpServers[idx] = cfg;
        else config.mcpServers.push(cfg);
        await saveConfig();
        applyMcpConfigs(config.mcpServers);
        try { await connectMcpServer(cfg.name); } catch {}
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/mcp' && req.method === 'DELETE') {
    const name = parsed.searchParams.get('name');
    if (!name) { json(res, 400, { error: 'name required' }); return; }
    config.mcpServers = (config.mcpServers ?? []).filter(c => c.name !== name);
    await saveConfig();
    applyMcpConfigs(config.mcpServers);
    json(res, 200, { ok: true });
    return;
  }
  if (parsed.pathname === '/api/mcp/oauth' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      try {
        const { name } = parseJson(body) as { name: string };
        const r = await startMcpOAuth(name);
        json(res, 200, r);
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/mcp/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      try {
        const { name } = parseJson(body) as { name: string };
        await connectMcpServer(name);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/channels' && req.method === 'GET') {
    const out: Array<{ id: string, name: string, platform: string, position?: number, blacklisted: boolean }> = [];
    for (const [client, platform] of [[discord, 'discord'], [fluxer, 'fluxer']] as const) {
      for (const g of client.guilds.cache.values()) {
        const cats = new Map((g.channels.cache.filter(c => c.type === ChannelType.GuildCategory).map(c => [c.id, c.name])));
        const channels = [...g.channels.cache.values()]
          .filter(c => c.isTextBased() && !c.isThread())
          .sort((a, b) => ('rawPosition' in a ? a.rawPosition : 0) - ('rawPosition' in b ? b.rawPosition : 0));
        for (const c of channels) {
          const cat = c.parentId ? cats.get(c.parentId) : undefined;
          out.push({ id: c.id, name: `${g.name} / ${cat ? cat + ' / ' : ''}${c.name}`, platform, position: ('rawPosition' in c ? c.rawPosition : 0), blacklisted: (config.blacklistedChannels ?? []).includes(c.id) || (!!c.parentId && (config.blacklistedChannels ?? []).includes(c.parentId)) });
        }
        let threads: ThreadChannel[] = [];
        try {
          const fetched = await g.channels.fetchActiveThreads();
          threads = fetched ? [...fetched.threads.values()] : [...g.channels.cache.filter(c => c.isThread()).values()];
        } catch {
          threads = [...g.channels.cache.filter(c => c.isThread()).values()];
        }
        for (const t of threads) {
          let parent = t.parent;
          if (!parent && t.parentId) {
            try {
              const fetched = await client.channels.fetch(t.parentId);
              if (fetched?.type === ChannelType.GuildText || fetched?.type === ChannelType.GuildAnnouncement || fetched?.type === ChannelType.GuildForum || fetched?.type === ChannelType.GuildMedia) parent = fetched;
            } catch { parent = null; }
          }
          const cat = parent?.parentId ? cats.get(parent.parentId) : undefined;
          const parentName = parent?.name ?? (t.parentId ? t.parentId : '?');
          out.push({ id: t.id, name: `${g.name} / ${cat ? cat + ' / ' : ''}#${parentName} / ${t.name}`, platform, position: 0, blacklisted: (config.blacklistedChannels ?? []).includes(t.id) || (!!t.parentId && (config.blacklistedChannels ?? []).includes(t.parentId)) });
        }
      }
    }
    json(res, 200, out);
    return;
  }
  if (parsed.pathname === '/api/blacklist' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      try {
        const { channelId, blacklisted } = parseJson(body) as { channelId: string, blacklisted: boolean };
        // スレッドの場合は親チャンネルIDを保存する
        let targetId = channelId;
        for (const client of [discord, fluxer]) {
          for (const g of client.guilds.cache.values()) {
            const ch = g.channels.cache.get(channelId);
            if (ch && 'parentId' in ch && ch.parentId) { targetId = ch.parentId; break; }
          }
        }
        config.blacklistedChannels = config.blacklistedChannels ?? [];
        if (blacklisted) {
          if (!config.blacklistedChannels.includes(targetId)) config.blacklistedChannels.push(targetId);
        } else {
          config.blacklistedChannels = config.blacklistedChannels.filter(x => x !== targetId);
        }
        await saveConfig();
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/jobs' && req.method === 'GET') {
    const id = parsed.searchParams.get('id');
    if (id !== null) {
      const job = getJob(id);
      if (job === undefined) { json(res, 404, { error: 'no such job' }); return; }
      json(res, 200, job);
      return;
    }
    json(res, 200, { ...jobSummary(), jobs: listJobs() });
    return;
  }
  if (parsed.pathname === '/api/jobs' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      try {
        const request = parseJson(body) as Parameters<typeof enqueueJob>[0];
        json(res, 200, enqueueJob(request));
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/jobs/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      try {
        const { id } = parseJson(body) as { id?: string };
        if (typeof id !== 'string') { json(res, 400, { error: 'id required' }); return; }
        json(res, 200, { ok: cancelJob(id) });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  if (parsed.pathname === '/api/jobs/clear' && req.method === 'POST') {
    json(res, 200, { removed: clearFinishedJobs() });
    return;
  }
  json(res, 404, { error: 'not found' });
  });
  server.listen(PORT, () => {
    log(`admin panel listening on http://0.0.0.0:${PORT}/`);
  });
};
