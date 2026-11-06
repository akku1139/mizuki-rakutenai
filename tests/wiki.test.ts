// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWikiSession, renderWiki, setupMemoryWiki, signWikiSession, visibleWikiFacts } from '../src/memory/wiki.ts';
import { config } from '../src/config.ts';
import { discord } from '../src/clients.ts';
import type { GuildMemory } from '../src/memory/store.ts';
import { loadMemory } from '../src/memory/store.ts';
import { once } from 'node:events';

const memory: GuildMemory = { guildId: '123', facts: [
  { id: 'm_123', scope: 'guild', text: '<script>alert(1)</script>', tags: ['<tag>'], source: 'https://discord.com/channels/123/456/789', createdAt: Date.UTC(2026, 10, 1), updatedAt: 1 },
  { id: 'm_456', scope: 'user', subject: 'someone', text: '別の出来事', tags: [], source: 'javascript:alert(1)', createdAt: Date.UTC(2026, 9, 1), updatedAt: 1 },
] };

test('WikiはHTMLをエスケープし、検索・月・記事IDで絞れる', () => {
  const html = renderWiki(memory, '<script>');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!renderWiki(memory, '', '2026-11').includes('別の出来事'));
  assert.ok(!renderWiki(memory, '', '', 'm_123').includes('別の出来事'));
  assert.ok(renderWiki(memory).includes('https://discord.com/channels/123/456/789'));
});

test('Wikiセッションは改ざんと別の秘密鍵を拒否する', () => {
  const token = signWikiSession('123:123456789', 'secret');
  assert.equal(readWikiSession(token, 'secret'), '123:123456789');
  assert.equal(readWikiSession(token + 'x', 'secret'), undefined);
  assert.equal(readWikiSession(token, 'other'), undefined);
});

test('非公開・NSFW・削除済み・別サーバー・出典無しの記憶を公開しない', async t => {
  let readable = true, exists = true, nsfw = false;
  t.mock.method(discord.guilds, 'fetch', async () => ({
    roles: { everyone: {} }, members: { me: {} },
    channels: { fetch: async () => ({ id: '456', parentId: null, nsfw, isTextBased: () => true, isThread: () => false,
      permissionsFor: () => ({ has: () => readable }), messages: { fetch: async () => { if (!exists) throw new Error('deleted'); return {}; } },
    }) },
  }));
  assert.deepEqual((await visibleWikiFacts(memory)).map(f => f.id), ['m_123']);
  readable = false;
  assert.equal((await visibleWikiFacts(memory)).length, 0);
  readable = true; exists = false;
  assert.equal((await visibleWikiFacts(memory)).length, 0);
  exists = true; nsfw = true;
  assert.equal((await visibleWikiFacts(memory)).length, 0);
  assert.equal((await visibleWikiFacts({ ...memory, guildId: '999' })).length, 0);
});

test('未設定・offのWikiは起動せず、membersの認証設定不足は拒否する', () => {
  const previous = config.memorySite;
  try {
    delete config.memorySite;
    assert.equal(setupMemoryWiki(), undefined);
    config.memorySite = { origin: 'https://wiki.invalid', guilds: { '123': 'off' } };
    assert.equal(setupMemoryWiki(), undefined);
    config.memorySite.guilds['123'] = 'members';
    assert.throws(setupMemoryWiki, /clientId/);
  } finally { config.memorySite = previous; }
});

test('OAuthのstate・メンバー確認・サーバー別セッションをHTTP経由で検査する', async t => {
  const previous = config.memorySite;
  config.memorySite = { origin: 'https://wiki.invalid', port: 0, guilds: { '123': 'members', '999': 'members' }, clientId: 'test', clientSecret: 'test', sessionSecret: 'x'.repeat(32) };
  const server = setupMemoryWiki()!;
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  let member = true, revoked = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://discord.com/')) return originalFetch(url, init);
    if (url.endsWith('/token/revoke')) { revoked++; return Response.json({}); }
    if (url.endsWith('/token')) return Response.json({ access_token: 'ephemeral' });
    return Response.json(member ? [{ id: '123' }] : []);
  });
  try {
    const start = await fetch(`${base}/123/wiki`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    const stateCookie = start.headers.get('set-cookie')!.split(';')[0];
    const callback = `${base}/auth/callback?code=test&state=${state}`;
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 403);
    const login = await fetch(callback, { redirect: 'manual', headers: { cookie: stateCookie } });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/123/wiki');
    assert.ok(login.headers.getSetCookie().some(c => c.startsWith(stateCookie.split('=')[0] + '=;') && c.includes('Max-Age=0')));
    const sessionCookie = login.headers.getSetCookie().find(c => c.startsWith('wiki_123='))!.split(';')[0];
    assert.ok(sessionCookie.startsWith('wiki_123='));
    const other = await fetch(`${base}/999/wiki`, { redirect: 'manual', headers: { cookie: sessionCookie } });
    assert.equal(other.status, 302);
    member = false;
    assert.equal((await fetch(callback, { redirect: 'manual', headers: { cookie: stateCookie } })).status, 403);
    assert.equal(revoked, 2);
    assert.equal((await fetch(`${base}/987/wiki`)).status, 404);
  } finally {
    config.memorySite = previous;
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});

test('並列のOAuthログインはサーバーやタブが違ってもstateを上書きしない', async t => {
  const previous = config.memorySite;
  config.memorySite = { origin: 'https://wiki.invalid', port: 0, guilds: { '123': 'members', '999': 'members' }, clientId: 'test', clientSecret: 'test', sessionSecret: 'x'.repeat(32) };
  const server = setupMemoryWiki()!;
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!url.startsWith('https://discord.com/')) return originalFetch(url, init);
    return Response.json(url.endsWith('/guilds') ? [{ id: '123' }, { id: '999' }] : { access_token: 'ephemeral' });
  });
  try {
    const starts = await Promise.all(['123', '999', '123'].map(g => fetch(`${base}/${g}/wiki`, { redirect: 'manual' })));
    const cookies = starts.map(r => r.headers.get('set-cookie')!.split(';')[0]);
    assert.equal(new Set(cookies.map(c => c.split('=')[0])).size, 3);
    for (const [i, start] of starts.entries()) {
      const state = new URL(start.headers.get('location')!).searchParams.get('state');
      const callback = await fetch(`${base}/auth/callback?code=test&state=${state}`, { redirect: 'manual', headers: { cookie: cookies.join('; ') } });
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get('location'), `/${i === 1 ? '999' : '123'}/wiki`);
      const removed = callback.headers.getSetCookie().filter(c => c.includes('Max-Age=0'));
      assert.equal(removed.length, 1);
      assert.ok(removed[0].startsWith(cookies[i].split('=')[0] + '='));
    }
  } finally { config.memorySite = previous; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('記憶500件でも1ページはチャンネル1回・メッセージ20回だけ確認する', async t => {
  const previous = config.memorySite;
  const guildId = '9000000000000000123';
  const stored = await loadMemory(guildId);
  stored.facts = Array.from({ length: 500 }, (_, i) => ({ id: `m_${i.toString(16)}`, scope: 'guild', text: `fact ${i}`, tags: [], source: `https://discord.com/channels/${guildId}/456/${1000 + i}`, createdAt: 500 - i, updatedAt: 1 }));
  let channelFetches = 0, messageFetches = 0;
  t.mock.method(discord.guilds, 'fetch', async () => ({ roles: { everyone: {} }, members: { me: {} }, channels: { fetch: async () => {
    channelFetches++;
    return { id: '456', parentId: null, isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => { messageFetches++; return {}; } } };
  } } }));
  config.memorySite = { origin: 'https://wiki.invalid', port: 0, guilds: { [guildId]: 'public' } };
  const server = setupMemoryWiki()!;
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/${guildId}/wiki`;
  try {
    const first = await fetch(base);
    assert.equal(first.status, 200);
    const html = await first.text();
    assert.match(html, /page=1/);
    assert.equal(channelFetches, 1);
    assert.equal(messageFetches, 20);
    assert.ok(!html.includes('fact 20'));
    const second = await fetch(`${base}?page=1`);
    assert.ok((await second.text()).includes('fact 20'));
    assert.equal(channelFetches, 2);
    assert.equal(messageFetches, 40);
    await fetch(`${base}/m_1f0`);
    assert.equal(messageFetches, 41);
    assert.equal((await fetch(`${base}?page=-1`)).status, 400);
  } finally { stored.facts = []; config.memorySite = previous; await new Promise<void>(resolve => server.close(() => resolve())); }
});
