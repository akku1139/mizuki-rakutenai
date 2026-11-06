// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextChannel } from 'discord.js';
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import { resetModelMetaCache } from '../src/ai/model-meta.ts';
import { Thread, User } from '@evex/rakutenai';

const cwd = process.cwd();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mizuki-handler-'));
process.chdir(dir);
const { config } = await import('../src/config.ts');
config.ai = { defaultProvider: 'openai', contextWindowTokens: 128000, openaiProfiles: { openai: { apiKey: 'test', baseUrl: 'https://llm.invalid/v1', model: 'test' } } };
const { aiHandler, createChatSession, deleteAIReplies, getAIStatus } = await import('../src/ai/mod.ts');
const { setUserProvider } = await import('../src/ai/prefs.ts');
const { DISCORD_USER_ID, discord } = await import('../src/clients.ts');
const { loadMemory, rememberFact, saveMemory } = await import('../src/memory/store.ts');
test.after(async () => { process.chdir(cwd); await fs.rm(dir, { recursive: true, force: true }); });

let nextId = 10000;
const channels = new Map<string, TextChannel>();
const fixtures = (channelId: string, emojiFetch: () => Promise<unknown[]> = async () => [], guildId = channelId) => {
  const sent: Array<{ content: string, deleted: boolean, options: unknown }> = [];
  let typing = 0;
  const send = async (options: string | { content: string }) => {
    const record = { content: typeof options === 'string' ? options : options.content, deleted: false, options };
    sent.push(record);
    return { id: String(++nextId), delete: async () => { record.deleted = true; }, edit: async () => {} };
  };
  const guild = { id: guildId, name: 'test guild', emojis: { fetch: emojiFetch }, roles: { everyone: {} }, channels: { fetch: async (id: string) => channels.get(id) } };
  const channel = Object.create(TextChannel.prototype) as unknown as TextChannel;
  for (const [key, value] of Object.entries({ id: channelId, name: 'test', guild, parentId: null, nsfw: false, permissionsFor: () => ({ has: () => true }), isTextBased: () => true, isDMBased: () => false, sendTyping: async () => { typing++; }, send, messages: { fetch: async () => new Map<string, unknown>() } })) {
    Object.defineProperty(channel, key, { value, configurable: true });
  }
  channels.set(channelId, channel);
  const message = (id: string, user = 'u1', content = `<@${DISCORD_USER_ID}> hi`) => ({
    id, guild, channelId, channel, client: discord, content, author: { id: user, bot: false, displayName: user, username: user }, member: null,
    createdAt: new Date(), createdTimestamp: Date.now(), reference: null, messageSnapshots: new Map<string, unknown>(), attachments: new Map<string, unknown>(), embeds: [],
    mentions: { users: new Map([[DISCORD_USER_ID, {}]]) }, reply: send,
  }) as unknown as OmitPartialGroupDMChannel<Message>;
  return { sent, message, channel, typing: () => typing };
};
const response = (content: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);

test('初回の同時呼び出しも1セッションに並び、最新の記憶を毎ターン載せる', async t => {
  let release!: () => void, initializations = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixtures('111', async () => { initializations++; await gate; return []; });
  const requests: Array<{ messages: Array<{ role: string, content: string }> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1) {
      const memory = await loadMemory('111');
      rememberFact(memory, { scope: 'guild', text: '新しく覚えたこと' });
      await saveMemory(memory);
    }
    return response(`answer${requests.length}`);
  });
  const a = aiHandler(f.message('100'));
  const b = aiHandler(f.message('101'));
  release();
  await Promise.all([a, b]);
  assert.equal(initializations, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.role === 'assistant' && m.content === 'answer1'));
  assert.ok(requests[1].messages.some(m => m.role === 'user' && m.content.includes('新しく覚えたこと')));
  assert.equal(getAIStatus().waiting, 0);
  assert.equal(getAIStatus().processing, 0);
  assert.equal(f.typing(), 2);
  assert.ok(f.sent.every(s => typeof s.options === 'object' && 'allowedMentions' in s.options!));
  t.mock.method(discord.channels, 'fetch', async () => ({ isTextBased: () => true, messages: { delete: async () => {} } }));
  await deleteAIReplies('100');
  assert.equal(f.sent[0].deleted, true);
  assert.equal(f.sent[1].deleted, false);
});

test('allowlist外と保存済みの禁止モデルはAPIへ送らず、許可モデルだけ選べる', async t => {
  const f = fixtures('1212');
  const profile = config.ai!.openaiProfiles!.openai;
  profile.allowedModels = ['safe-model'];
  const requests: Array<{ model: string }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return response('ok'); });
  try {
    await aiHandler(f.message('1200', 'allowed', '=aimodel openai fable'));
    assert.match(f.sent.at(-1)!.content, /allowlist/);
    assert.equal(requests.length, 0);
    await setUserProvider('stored-unsafe', 'openai', 'fable');
    await aiHandler(f.message('1201', 'stored-unsafe'));
    assert.equal(requests.length, 0);
    await assert.rejects(createChatSession('openai', undefined, 'fable'), /許可/);
    await aiHandler(f.message('1202', 'allowed', '=aimodel openai safe-model'));
    await aiHandler(f.message('1203', 'allowed'));
    assert.equal(requests[0].model, 'safe-model');
    delete profile.allowedModels;
    await aiHandler(f.message('1204', 'allowed'));
    assert.equal(requests.length, 1);
    await assert.rejects(createChatSession('openai', undefined, 'safe-model'), /許可/);
  } finally { delete profile.allowedModels; }
});

test('自動参加の返信先が過去でも最新発言を生成に渡す', async t => {
  const f = fixtures('1313');
  const old = f.message('1300', 'earlier', '前の質問');
  const current = f.message('1302', 'latest', '最新の補足情報');
  let deleted = false;
  const reply = t.mock.method(old, 'reply', async (options: unknown) => ({ id: '1303', delete: async () => { deleted = true; }, edit: async () => {} }));
  const requests: Array<{ messages: Array<{ role: string, content: string }> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return response('回答'); });
  await aiHandler(current, old);
  const input = requests[0].messages.at(-1)!.content;
  assert.match(input, /前の質問/);
  assert.match(input, /最新の補足情報/);
  assert.equal(reply.mock.callCount(), 1);
  assert.ok(getAIStatus().sessions.some(s => s.key.endsWith(':latest')));
  await deleteAIReplies(current.id);
  assert.equal(deleted, true);
});

test('記憶と共有チャンネルの前置きも含めて1万文字以内に収める', async t => {
  const f = fixtures('1414');
  const memory = await loadMemory('1414');
  for (let i = 0; i < 5; i++) rememberFact(memory, { scope: 'guild', text: `memory${i}:` + '記'.repeat(290) });
  const history = new Map(Array.from({ length: 100 }, (_, i) => [String(1400 + i), f.message(String(1400 + i), 'history', '履'.repeat(300))]));
  Object.defineProperty(f.channel, 'messages', { value: { fetch: async () => history }, configurable: true });
  const requests: Array<{ messages: Array<{ role: string, content: string }> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return response('ok'); });
  config.ai!.shareChannelContext = true;
  try {
    await aiHandler(f.message('1500', 'budget', '今回の依頼'));
    const input = requests[0].messages.at(-1)!.content;
    assert.ok(input.length <= 10000, String(input.length));
    assert.match(input, /memory/);
    assert.match(input, /現在のチャンネル/);
    assert.match(input, /今回の依頼/);
  } finally { config.ai!.shareChannelContext = false; }
});

const fakeSocket = () => {
  const socket = { onmessage: null, onerror: null, onclose: null as null | (() => void), sent: 0, closed: 0,
    send: () => { socket.sent++; }, close: () => { socket.closed++; socket.onclose?.(); } };
  return socket;
};

test('RakutenAI生成中のclearはSDKの実ストリームとWebSocketを閉じ、再接続しない', async t => {
  const f = fixtures('1515');
  const socket = fakeSocket();
  const thread = new Thread('test-thread', {} as User, socket as unknown as WebSocket);
  const reconnect = t.mock.method(Thread, 'connectWS', async () => { throw new Error('再接続は禁止'); });
  t.mock.method(User, 'create', async () => ({ createThread: async () => thread } as unknown as User));
  const old = config.ai!.defaultProvider;
  config.ai!.defaultProvider = 'rakutenai';
  try {
    const task = aiHandler(f.message('1600', 'rakuten-cancel'));
    for (let i = 0; i < 100 && socket.sent === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(socket.sent, 1);
    await aiHandler(f.message('1601', 'rakuten-cancel', `<@${DISCORD_USER_ID}> clear`));
    await task;
    assert.equal(socket.closed, 1);
    assert.equal(socket.onclose, null);
    assert.equal(reconnect.mock.callCount(), 0);
    assert.equal(getAIStatus().processing, 0);
  } finally { thread.close(); config.ai!.defaultProvider = old; }
});

test('キャンセル後にSDKの初期化が完了しても接続を閉じて生成しない', async t => {
  const f = fixtures('1616');
  const socket = fakeSocket();
  const thread = new Thread('late-thread', {} as User, socket as unknown as WebSocket);
  let release!: () => void, creating = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(User, 'create', async () => ({ createThread: async () => { creating = true; await gate; return thread; } } as unknown as User));
  const old = config.ai!.defaultProvider;
  config.ai!.defaultProvider = 'rakutenai';
  try {
    const task = aiHandler(f.message('1700', 'late-rakuten'));
    for (let i = 0; i < 100 && !creating; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(creating, true);
    await aiHandler(f.message('1701', 'late-rakuten', `<@${DISCORD_USER_ID}> clear`));
    await task;
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(socket.closed, 1);
    assert.equal(socket.sent, 0);
  } finally { release(); thread.close(); config.ai!.defaultProvider = old; }
});

test('ユーザーが違えば同時に生成できる', async t => {
  const f = fixtures('222');
  const waiting: Array<() => void> = [];
  t.mock.method(globalThis, 'fetch', async () => { await new Promise<void>(resolve => waiting.push(resolve)); return response('ok'); });
  const tasks = [aiHandler(f.message('200', 'alice')), aiHandler(f.message('201', 'bob'))];
  for (let i = 0; i < 100 && waiting.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(waiting.length, 2);
  waiting.forEach(resolve => resolve());
  await Promise.all(tasks);
});

test('=aimodelはメンション無しで動き、他チャンネルの既存セッションも破棄する', async t => {
  const f = fixtures('333'), g = fixtures('444');
  t.mock.method(globalThis, 'fetch', async () => response('ok'));
  await aiHandler(f.message('300', 'switcher'));
  await aiHandler(g.message('301', 'switcher'));
  const command = f.message('302', 'switcher', '=aimodel rakutenai');
  command.mentions.users.clear();
  await aiHandler(command);
  assert.equal(getAIStatus().sessions.some(s => s.key.endsWith(':switcher')), false);
  assert.ok(f.sent.at(-1)?.content.includes('switched'));
});

test('clearに続く依頼は新しい履歴で処理する', async t => {
  const f = fixtures('555');
  const requests: Array<{ messages: Array<{ role: string, content: string }> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return response('ok'); });
  await aiHandler(f.message('400', 'clearer'));
  await aiHandler(f.message('401', 'clearer', `<@${DISCORD_USER_ID}> clear 新しい話題`));
  assert.equal(requests[1].messages.filter(m => m.role === 'user').length, 1);
  assert.ok(requests[1].messages.some(m => m.content.includes('新しい話題')));
});

test('セッション初期化が止まっていてもclearで解除し、次の依頼を受け付ける', async t => {
  let initializations = 0;
  const f = fixtures('666', async () => { if (++initializations === 1) await new Promise(() => {}); return []; });
  t.mock.method(globalThis, 'fetch', async () => response('new answer'));
  const pending = aiHandler(f.message('500', 'stopped'));
  await new Promise(resolve => setTimeout(resolve, 1));
  await aiHandler(f.message('501', 'stopped', `<@${DISCORD_USER_ID}> clear`));
  await pending;
  await aiHandler(f.message('502', 'stopped'));
  assert.equal(getAIStatus().processing, 0);
  assert.equal(getAIStatus().waiting, 0);
  assert.equal(f.sent.at(-1)?.content.includes('new answer'), true);
});

test('生成中の呼び出し削除で投稿を止め、後続の依頼は新しいセッションで処理する', async t => {
  const f = fixtures('777');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { if (++requests === 1) await blocked; return response('ok'); });
  const pending = aiHandler(f.message('600', 'deleter'));
  for (let i = 0; i < 100 && requests === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await deleteAIReplies('600');
  await pending;
  assert.equal(f.sent.length, 0);
  await aiHandler(f.message('601', 'deleter'));
  assert.ok(f.sent.at(-1)?.content.includes('ok'));
  release();
});

test('非公開チャンネルも設定時は共有し、本人が読めなくなれば履歴を捨てる', async t => {
  const f = fixtures('888', undefined, '999'), g = fixtures('889', undefined, '999');
  Object.defineProperty(f.channel, 'permissionsFor', { value: (principal: unknown) => ({ has: () => principal !== f.channel.guild.roles.everyone }), configurable: true });
  const requests: Array<{ messages: Array<{ role: string, content: string }> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return response('shared answer'); });
  config.ai!.shareChannelContext = true;
  try {
    await aiHandler(f.message('700', 'sharer'));
    await aiHandler(g.message('701', 'sharer'));
    assert.ok(requests[1].messages.some(m => m.role === 'assistant' && m.content === 'shared answer'));
    Object.defineProperty(f.channel, 'permissionsFor', { value: () => ({ has: () => false }), configurable: true });
    await aiHandler(g.message('702', 'sharer'));
    assert.equal(requests[2].messages.filter(m => m.role === 'user').length, 1);
  } finally { config.ai!.shareChannelContext = false; }
});

test('ツール境界で他の並列返信と新着発言をマージし、取得した過去画像も渡す', async t => {
  resetModelMetaCache();
  const f = fixtures('1010');
  const old = f.message('799', 'old');
  old.attachments.set('img', { name: 'a.png', url: 'https://img.invalid/a.png', proxyURL: 'https://img.invalid/a.png' } as never);
  const newer = f.message('801', 'other', '追加のお願い');
  const bot = f.message('802', 'other-bot', '別の並列返信');
  Object.defineProperty(bot.author, 'bot', { value: true });
  Object.defineProperty(f.channel, 'messages', { value: { fetch: async (options: unknown) => typeof options === 'string' ? old
    : (options as { before?: string }).before ? new Map<string, unknown>() : new Map([['801', newer], ['802', bot]]) }, configurable: true });
  t.mock.method(discord.channels, 'fetch', async () => f.channel);
  const requests: Array<{ messages: Array<{ role: string, content: unknown }> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === 'https://models.dev/api.json') return Response.json({ test: { api: 'https://llm.invalid/v1', models: { test: { id: 'test', modalities: { input: ['text', 'image'] } } } } });
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'test' }] });
    if (String(url) === 'https://img.invalid/a.png') return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'fetch_message', arguments: JSON.stringify({ url: 'https://discord.com/channels/1010/1010/799' }) } }] } }] })}\n\ndata: [DONE]\n\n`);
    return response('見えた');
  });
  await aiHandler(f.message('800', 'buffer'));
  const merged = JSON.stringify(requests[1].messages.at(-1)?.content);
  assert.match(merged, /追加のお願い/);
  assert.match(merged, /別の並列返信/);
  assert.match(merged, /data:image\/png;base64/);
});

test('送信中のtypingも完了してから最終返信を送り、後からtypingを復活させない', async t => {
  const f = fixtures('1111');
  let release!: () => void, started = false;
  const typing = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(f.channel, 'sendTyping', { value: async () => { started = true; await typing; }, configurable: true });
  t.mock.method(globalThis, 'fetch', async () => response('finished'));
  const pending = aiHandler(f.message('900', 'typing'));
  for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(started, true);
  assert.equal(f.sent.length, 0);
  release();
  await pending;
  assert.ok(f.sent.at(-1)?.content.includes('finished'));
});

test('返信キャッシュはチャンネルごとに直近100呼び出しだけを保持する', async t => {
  const a = fixtures('cache-a'), b = fixtures('cache-b');
  t.mock.method(globalThis, 'fetch', async () => response('ok'));
  await aiHandler(b.message('9900000', 'cache-user'));
  for (let i = 0; i < 101; i++) await aiHandler(a.message(String(9910000 + i), 'cache-user'));
  await deleteAIReplies('9910000', 'cache-a');
  assert.equal(a.sent[0].deleted, false);
  await deleteAIReplies('9910001', 'cache-a');
  assert.equal(a.sent[1].deleted, true);
  await deleteAIReplies('9900000', 'cache-b');
  assert.equal(b.sent[0].deleted, true);
});
