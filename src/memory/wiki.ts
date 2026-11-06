// SPDX-License-Identifier: AGPL-3.0-or-later

/// 既存の記憶JSONを読むだけのWiki。公開用DBやNotionの複製は持たない。

import http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.ts';
import { discord } from '../clients.ts';
import { error } from '../log.ts';
import { loadMemory, type GuildMemory, type MemoryFact } from './store.ts';

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const signWikiSession = (value: string, secret: string): string =>
  `${Buffer.from(value).toString('base64url')}.${createHmac('sha256', secret).update(value).digest('base64url')}`;

export const readWikiSession = (signed: string, secret: string): string | undefined => {
  const [encoded, signature] = signed.split('.');
  if (!encoded || !signature) return;
  const value = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = signWikiSession(value, secret).split('.')[1]!;
  const a = Buffer.from(signature), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? value : undefined;
};

const sourceUrl = (fact: MemoryFact, guildId: string): string | undefined =>
  fact.source && new RegExp(`^https://discord\\.com/channels/${guildId}/\\d+/\\d+$`).test(fact.source) ? fact.source : undefined;

/** HTMLは全てエスケープし、出典のリンクだけを許す。 */
export const renderWiki = (memory: GuildMemory, query = '', month = '', id = ''): string => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const facts = memory.facts.filter(f => (!id || f.id === id)
    && (!month || new Date(f.createdAt).toISOString().startsWith(month))
    && terms.every(term => `${f.text} ${f.tags.join(' ')}`.toLowerCase().includes(term)))
    .sort((a, b) => b.createdAt - a.createdAt);
  const root = `/${encodeURIComponent(memory.guildId)}/wiki`;
  const months = [...new Set(memory.facts.map(f => new Date(f.createdAt).toISOString().slice(0, 7)))].sort().reverse();
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>瑞稀の記憶</title>
<style>body{font:18px/1.7 system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;color:#222}a{color:#165b91}li{margin:1rem 0}small{display:block;color:#555}nav{display:flex;gap:1rem;flex-wrap:wrap}input{font:inherit;max-width:70%}@media(prefers-color-scheme:dark){body{background:#17191c;color:#eee}a{color:#94c6fa}small{color:#bbb}}</style>
<h1><a href="${root}">瑞稀の記憶</a></h1><p>サーバー ${escape(memory.guildId)} · 保存した事実と出典。記憶には誤りや古い情報が含まれることがあります。</p>
<form action="${root}"><label>検索 <input name="q" value="${escape(query)}"></label><button>探す</button></form>
<nav aria-label="年表">${months.map(m => `<a href="${root}?month=${m}">${m}</a>`).join(' ')}</nav>
<p>${facts.length}件</p><ul>${facts.map(f => `<li id="${escape(f.id)}"><a href="${root}/${encodeURIComponent(f.id)}">${escape(f.text)}</a><small>${new Date(f.createdAt).toISOString().slice(0, 10)} · ${f.tags.map(t => `<a href="${root}?q=${encodeURIComponent(t)}">${escape(t)}</a>`).join(' ')}${sourceUrl(f, memory.guildId) ? ` · <a rel="noreferrer" href="${escape(f.source!)}">元の発言</a>` : ''}</small></li>`).join('')}</ul></html>`;
};

/** 公開チャンネルの存在する発言を根拠に持つ記憶だけを表示する。 */
export const visibleWikiFacts = async (memory: GuildMemory): Promise<MemoryFact[]> => {
  const guild = await discord.guilds.fetch(memory.guildId);
  const checks = new Map<string, Promise<boolean>>();
  const visible = async (fact: MemoryFact): Promise<boolean> => {
    const url = sourceUrl(fact, memory.guildId);
    if (!url) return false;
    if (!checks.has(url)) checks.set(url, (async () => {
      try {
        const [, channelId, messageId] = /\/channels\/\d+\/(\d+)\/(\d+)$/.exec(url)!;
        const ch = await guild.channels.fetch(channelId, { force: true });
        if (!ch?.isTextBased() || ch.isThread() || ('nsfw' in ch && ch.nsfw)) return false;
        if ((config.blacklistedChannels ?? []).some(id => id === ch.id || id === ch.parentId)) return false;
        const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
        if (!ch.permissionsFor(guild.roles.everyone)?.has(permissions) || !guild.members.me || !ch.permissionsFor(guild.members.me)?.has(permissions)) return false;
        await ch.messages.fetch({ message: messageId, force: true, cache: false });
        return true;
      } catch { return false; }
    })());
    return checks.get(url)!;
  };
  const out: MemoryFact[] = [];
  // Discordのrate limitに任せて大量に並列取得せず、少数ずつ確認する。
  for (let start = 0; start < memory.facts.length; start += 5) {
    const batch = memory.facts.slice(start, start + 5);
    const flags = await Promise.all(batch.map(visible));
    out.push(...batch.filter((_, i) => flags[i]));
  }
  return out;
};

export const setupMemoryWiki = (): http.Server | undefined => {
  const settings = config.memorySite;
  if (!settings || !Object.values(settings.guilds).some(mode => mode !== 'off')) return;
  const origin = new URL(settings.origin).origin;
  if (!origin.startsWith('https://')) throw new Error('memorySite.origin は HTTPS が必要です');
  if (Object.values(settings.guilds).includes('members') && (!settings.clientId || !settings.clientSecret || !settings.sessionSecret || settings.sessionSecret.length < 32)) {
    throw new Error('メンバー限定Wikiには clientId/clientSecret と32文字以上の sessionSecret が必要です');
  }
  const secret = settings.sessionSecret ?? randomBytes(32).toString('hex');
  const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status: number, text: string, html = false) => { res.writeHead(status, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' }); res.end(text); };
    const redirect = (url: string) => { res.writeHead(302, { Location: url }); res.end(); };
    try {
      if (req.method !== 'GET') { send(405, 'Method not allowed'); return; }
      const url = new URL(req.url ?? '/', origin);
      const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')));
      if (url.pathname === '/auth/callback') {
        const state = readWikiSession(cookies['wiki_state'] ?? '', secret);
        const [guildId, nonce, expires] = (state ?? '').split(':');
        res.setHeader('Set-Cookie', cookie('wiki_state', '', 0));
        if (!guildId || settings.guilds[guildId] !== 'members' || !nonce || nonce !== url.searchParams.get('state') || Number(expires) < Date.now() || !url.searchParams.get('code')) { send(403, 'ログインをやり直してください'); return; }
        const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: `${origin}/auth/callback`, client_id: settings.clientId!, client_secret: settings.clientSecret! }), signal: AbortSignal.timeout(10_000),
        });
        if (!tokenResponse.ok) { send(403, 'ログインに失敗しました'); return; }
        const { access_token: token } = await tokenResponse.json() as { access_token: string };
        let member = false;
        try {
          const guilds = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
          if (guilds.ok) member = (await guilds.json() as Array<{ id: string }>).some(g => g.id === guildId);
        } finally {
          await fetch('https://discord.com/api/v10/oauth2/token/revoke', { method: 'POST', body: new URLSearchParams({ token, client_id: settings.clientId!, client_secret: settings.clientSecret! }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
        }
        if (!member) { send(403, 'サーバーのメンバーだけが読めます'); return; }
        res.setHeader('Set-Cookie', cookie(`wiki_${guildId}`, signWikiSession(`${guildId}:${Date.now() + 15 * 60_000}`, secret), 15 * 60));
        redirect(`/${guildId}/wiki`); return;
      }
      const route = /^\/(\d+)\/wiki(?:\/(m_[a-f0-9]+))?$/.exec(url.pathname);
      const guildId = route?.[1];
      if (!guildId || !settings.guilds[guildId] || settings.guilds[guildId] === 'off') { send(404, 'Not found'); return; }
      if (settings.guilds[guildId] === 'members') {
        const session = readWikiSession(cookies[`wiki_${guildId}`] ?? '', secret)?.split(':');
        if (session?.[0] !== guildId || !session[1] || Number(session[1]) <= Date.now()) {
          const nonce = randomBytes(24).toString('hex');
          res.setHeader('Set-Cookie', cookie('wiki_state', signWikiSession(`${guildId}:${nonce}:${Date.now() + 5 * 60_000}`, secret), 300));
          redirect(`https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: settings.clientId!, redirect_uri: `${origin}/auth/callback`, response_type: 'code', scope: 'identify guilds', state: nonce })}`); return;
        }
      }
      const memory = await loadMemory(guildId);
      const facts = await visibleWikiFacts(memory);
      const id = route?.[2] ?? '';
      if (id && !facts.some(f => f.id === id)) { send(404, 'Not found'); return; }
      send(200, renderWiki({ ...memory, facts }, (url.searchParams.get('q') ?? '').slice(0, 200), url.searchParams.get('month') ?? '', id), true);
    } catch (e) { error('wiki failed:', e); if (!res.headersSent) send(503, '読み込めませんでした'); else res.end(); }
  });
  server.listen(settings.port ?? 8081, '127.0.0.1');
  return server;
};
