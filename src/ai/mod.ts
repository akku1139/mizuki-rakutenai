// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from '../log.ts';

/// Mention-triggered AI assistant (RakutenAI / OpenAI互換API).

import {
  type Message,
  MessageReferenceType,
  PermissionFlagsBits,
  TextChannel,
  ThreadChannel,
  type OmitPartialGroupDMChannel,
  type Snowflake,
} from 'discord.js';
import { type Thread, User } from '@evex/rakutenai';
import process from 'node:process';
import { config, get } from '../config.ts';
import { DISCORD_USER_ID, discord, FLUXER_USER_ID, fluxer } from '../clients.ts';
import { whMapFluxer } from '../fluxsync/state.ts';
import { createFileFromUrl, getFileName, isEffectivelyEmpty, numberMessageLinks, splitLongString, suppressEmbeds } from '../utils.ts';
import { formatUsage, runAgent } from './agent.ts';
import { buildContextBlock } from './context.ts';
import { recall } from '../memory/recall.ts';
import { loadMemory } from '../memory/store.ts';
import { embedImageUrls } from './embeds.ts';
import { OpenAICompatChat } from './openai.ts';
import { getUserModel, getUserProvider, loadPrefs, setUserProvider } from './prefs.ts';
import { fetchModelListCached } from './model-meta.ts';
import { participationTarget } from './participation.ts';
import { rememberReply, removeSavedReplies } from './replies.ts';
import { buildSystemPrompt } from './prompt.ts';
import { getAitoolsSpec, refreshMcpTools } from './tools.ts';
import { connectAllMcp } from './mcp-registry.ts';
import type { AIEvent, ChatContents, ChatSession, ProviderName } from './types.ts';
import { isProviderName, PROVIDERS } from './types.ts';

/** RakutenAIのThreadをChatSessionに適合させる */
class RakutenAIChat implements ChatSession {
  readonly label = 'rakutenai';
  readonly id: string;
  readonly t: Thread;

  constructor(t: Thread) {
    this.t = t;
    this.id = t.id;
  }

  uploadFile(opts: { file: File, isImage?: boolean }) {
    return this.t.uploadFile(opts);
  }

  async *sendMessage(message: {
    mode?: 'USER_INPUT' | 'DEEP_THINK' | 'AI_READ',
    contents: ChatContents,
  }): AsyncGenerator<AIEvent> {
    yield* this.t.sendMessage({
      mode: message.mode ?? 'USER_INPUT',
      contents: message.contents,
    } as never);
  }
}

/** The message and the messages forwarded in it, whose attachments and embeds live in the snapshots. */
const withSnapshots = (m: Message<boolean>) => [m, ...m.messageSnapshots.values()];

const uploadMessageFiles = async (chat: ChatSession, messages: Message<boolean>[], seen: Set<string>): Promise<ChatContents> => {
  const sources = messages.flatMap(m => withSnapshots(m).flatMap(s => [
    ...[...s.attachments.values()].map(a => ({ url: a.proxyURL, name: a.name, imageOnly: false })),
    ...embedImageUrls(s.embeds).map(url => ({ url, name: getFileName(url) || 'image', imageOnly: true })),
  ]));
  const out: ChatContents = [];
  for (const { url, name, imageOnly } of sources) {
    if (seen.has(url) || seen.size >= 20) continue;
    seen.add(url);
    try {
      const file = await createFileFromUrl(url, name);
      const isImage = file.type.startsWith('image/');
      if (imageOnly && !isImage) continue;
      out.push({ type: 'file', file: await chat.uploadFile({ file, isImage }) });
    } catch (e) { error('failed to load a file:', url, e); }
  }
  return out;
};

/**
 * The replied-to message and the posts by the same author around it,
 * which often carry the images or links the question is about.
 * Replies to our own messages are skipped; the conversation already has them.
 */
const fetchRepliedMessages = async (m: OmitPartialGroupDMChannel<Message<boolean>>): Promise<Message<boolean>[]> => {
  // 転送も reference を持つが、中身は messageSnapshots にある
  if (!m.reference || m.reference.type === MessageReferenceType.Forward || m.reference.channelId !== m.channelId) return [];
  const refId = m.reference.messageId;
  if (!refId) return [];
  try {
    const ref = await m.channel.messages.fetch(refId);
    if (ref.author.id === DISCORD_USER_ID || ref.author.id === FLUXER_USER_ID) return [];
    const around = await m.channel.messages.fetch({ around: refId, limit: 10 });
    return [...around.values()]
      .filter(msg => msg.author.id === ref.author.id && msg.id !== m.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  } catch (e) {
    error('failed to fetch the replied message:', e);
    return [];
  }
};

interface ChatEntry {
  ready?: Promise<{ t: ChatSession, rep: string }>,
  t?: ChatSession,
  q: Promise<void>,
  lastIds: Snowflake[],
  provider: ProviderName,
  controller: AbortController,
  jobs: number,
  touched: number,
  channels: Set<string>,
}

/** 既定のプロバイダ (env: AI_PROVIDER、未指定なら rakutenai) */
const defaultProvider = (): ProviderName => {
  const v = get(config, 'ai.defaultProvider', process.env['AI_PROVIDER'] ?? 'rakutenai');
  return isProviderName(v) ? v : 'rakutenai';
};

const openAIConfig = (model?: string) => {
  const active = get(config, 'ai.activeOpenaiProfile', null);
  const profile = active ? get(config, `ai.openaiProfiles.${active}`, {}) : {};
  return {
    baseUrl: profile.baseUrl ?? get(config, 'ai.openaiProfiles.openai.baseUrl', process.env['OPENAI_BASE_URL']),
    apiKey: profile.apiKey ?? get(config, 'ai.openaiProfiles.openai.apiKey', process.env['OPENAI_API_KEY']),
    model: model ?? profile.model ?? get(config, 'ai.openaiProfiles.openai.model', process.env['OPENAI_MODEL']),
    contextWindowTokens: profile.contextWindowTokens ?? get(config, 'ai.contextWindowTokens', undefined),
  };
};

/**
 * チャンネルごとの新しいセッションを作る。
 * - rakutenai: システムプロンプトは毎回の入力の先頭に結合して渡す (サーバー側でツールを提供)
 * - openai: 環境変数 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL を使用し、
 *   システムプロンプトは setSystemPrompt で渡す。ツール (function calling) もこちらにのみ渡す
 */
export const createChatSession = async (
  provider: ProviderName,
  meta?: { guildName?: string, channelName?: string },
  model?: string,
): Promise<ChatSession> => {
  if (provider === 'openai') {
    const chat = new OpenAICompatChat(
      openAIConfig(model),
      getAitoolsSpec(),
    );
    if (meta?.guildName !== undefined && meta.channelName !== undefined) {
      chat.setServerContext(meta.guildName, meta.channelName);
    }
    return chat;
  }
  return new RakutenAIChat(await (await User.create()).createThread());
};

/** 新規エントリを作成する。RakutenAIの場合はシステムプロンプトを返す */
const newEntry = async (
  provider: ProviderName,
  m: OmitPartialGroupDMChannel<Message<boolean>>,
): Promise<{ t: ChatSession, rep: string }> => {
  const rep = await buildSystemPrompt(m.guild, provider);
  const t = await createChatSession(provider, {
    guildName: m.guild?.name,
    channelName: m.channel.isDMBased() ? undefined : m.channel.name,
  }, getUserModel(m.author.id));
  t.setSystemPrompt?.(rep);
  return {
    t,
    rep: t.setSystemPrompt == null ? rep : '',
  };
};

const chatStore = new Map<string, ChatEntry>();
const replies = new Map<string, { controller: AbortController, messages: Message[], touched: number }>();

export const deleteAIReplies = async (id: string): Promise<void> => {
  const reply = replies.get(id);
  reply?.controller.abort();
  await Promise.all((reply?.messages ?? []).map(msg => msg.delete().catch(e => error('reply delete failed:', e))));
  await removeSavedReplies(id).catch(e => error('saved reply delete failed:', e));
};

const resetSessions = (userId: string, key?: string): void => {
  for (const [k, entry] of chatStore) {
    if (!k.endsWith(`:${userId}`) || (key !== undefined && k !== key)) continue;
    entry.controller.abort();
    chatStore.delete(k);
  }
};

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [key, entry] of chatStore) if (entry.jobs === 0 && entry.touched < cutoff) chatStore.delete(key);
  for (const [key, reply] of replies) if (reply.touched < cutoff) replies.delete(key);
}, 60_000).unref();

let aiWaitingJobs = 0;
let aiProcessingJobs = 0;

const sendMessage = async (text: string, m: OmitPartialGroupDMChannel<Message>, first: boolean, signal?: AbortSignal): Promise<Message[]> => {
  const parts = splitLongString(suppressEmbeds(numberMessageLinks(text.replace(/^####+ /gm, '### '))), 1500);

  const sentMessages: Message[] = [];

  for(const part of parts) {
    const reply = replies.get(m.id);
    if (reply?.controller.signal.aborted || signal?.aborted) break;
    if(first) {
      sentMessages.push(await m.reply({ content: part, allowedMentions: { parse: [], repliedUser: false } }));
      first = false;
    } else {
      sentMessages.push(await m.channel.send({ content: part, allowedMentions: { parse: [], repliedUser: false } }));
    }
    const sent = sentMessages.at(-1)!;
    reply?.messages.push(sent);
    if (!reply?.controller.signal.aborted && !signal?.aborted) await rememberReply(m, sent.id);
    if (reply?.controller.signal.aborted || signal?.aborted) await sent.delete().catch(() => {});
  }

  return sentMessages;
};

export const aiHandler = async (m: OmitPartialGroupDMChannel<Message<boolean>>, automatic = false) => {
  if (
    !m.author.bot
    && (automatic || m.mentions.users.has(DISCORD_USER_ID) || m.mentions.users.has(FLUXER_USER_ID) || /mizuki|瑞稀/i.test(m.content) || /^=aimodel(?:\s|$)/.test(m.content))
    && (m.channel instanceof TextChannel || m.channel instanceof ThreadChannel)
    && m.guild !== null
  ) {
    // セッションは「チャンネル x ユーザー」単位。Fluxer同期チャンネルはDiscord側のIDに正規化する。
    const parentId = m.channel.parentId;
    if ((config.blacklistedChannels ?? []).some(id => id === m.channelId || id === parentId)) return;
    const channelKey = whMapFluxer[m.channelId] ? whMapFluxer[m.channelId].targetChannelID : m.channelId;
    const publicChannel = (channel: TextChannel | ThreadChannel): boolean => channel instanceof TextChannel
      && !channel.nsfw && !!channel.permissionsFor(m.guild!.roles.everyone)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
    const shared = config.ai?.sharePublicChannelContext === true && publicChannel(m.channel);
    const contextKey = `${shared ? `${m.client === discord ? 'discord' : 'fluxer'}:${m.guild.id}:public` : channelKey}:${m.author.id}`;

    const clearMatch = automatic ? null : m.content.match(new RegExp(`^<@!?(${DISCORD_USER_ID}|${FLUXER_USER_ID})>\\s+clear(?:\\s+([\\s\\S]*))?$`));
    if (clearMatch) {
      resetSessions(m.author.id, contextKey);
      if (!clearMatch[2]?.trim()) {
        await m.reply('chat context destroyed.');
        return;
      }
    }
    if (m.content === `<@${DISCORD_USER_ID}> chatlist` || m.content === `<@${FLUXER_USER_ID}> chatlist`) {
      await m.reply(`job queue: \`{ waiting: ${aiWaitingJobs}, processing : ${aiProcessingJobs} }\`\ncontext list:\n\`\`\`json\n${JSON.stringify(Array.from(chatStore.entries()).map(([k, v]) => [k, v.provider, v.t?.label ?? 'initializing']), null, 2)}\n\`\`\``);
      return;
    }

    // aimodel [provider]: 呼び出したユーザーのAIバックエンドを表示/切り替える (=aimodel でも可)
    const modelMatch = !automatic && m.content.match(new RegExp(`^(?:<@!?(${DISCORD_USER_ID}|${FLUXER_USER_ID})>\\s+)?=?aimodel(?:\\s+(\\S+))?(?:\\s+(\\S+))?$`));
    if (modelMatch) {
      const p = modelMatch[2];
      const model = modelMatch[3];
      if (p === undefined) {
        const current = getUserProvider(m.author.id) ?? defaultProvider();
        await m.reply(`your AI model: \`${current}\`${getUserModel(m.author.id) ? ` / \`${getUserModel(m.author.id)}\`` : ''}\navailable: ${PROVIDERS.map(x => `\`${x}\``).join(', ')}\nusage: \`=aimodel <provider> [model]\``);
        return;
      }
      if (!isProviderName(p)) {
        await m.reply(`unknown provider: \`${p}\`\navailable: ${PROVIDERS.map(x => `\`${x}\``).join(', ')}`);
        return;
      }
      try {
        if (model) {
          const settings = openAIConfig();
          const models = await fetchModelListCached(settings.baseUrl, settings.apiKey);
          if (p !== 'openai' || !models.some(x => x.id === model)) {
            await m.reply('選択できないモデルです。openai のプロバイダが公開するモデルIDを指定してください。');
            return;
          }
        }
        await setUserProvider(m.author.id, p, model);
        resetSessions(m.author.id);
        await m.reply(`AI model switched to \`${p}\`. chat context was reset.`);
      } catch (e) {
        await m.reply(`failed to switch: ${e}`);
      }
      return;
    }

    let entry = chatStore.get(contextKey);
    if (entry === undefined) {
      // ユーザー単位の設定 > env (AI_PROVIDER) の既定
      const provider = getUserProvider(m.author.id) ?? defaultProvider();
      entry = { q: Promise.resolve(), lastIds: [], provider, controller: new AbortController(), jobs: 0, touched: Date.now(), channels: new Set() };
      chatStore.set(contextKey, entry);
    }
    entry.jobs++;
    const response = { controller: new AbortController(), messages: [] as Message[], touched: Date.now() };
    replies.set(m.id, response);
    const signal = AbortSignal.any([entry.controller.signal, response.controller.signal]);
    const wait = async <T>(pending: Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let abort: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error('中断しました'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('AIの準備が120秒間進みませんでした')), 120_000);
        timer.unref();
      });
      try { return await Promise.race([pending, stopped]); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    };

    const previousTask = entry.q;
    let resolveNext: () => void = () => error(m.id, 'Execute off-queue');
    entry.q = new Promise((resolve) => {
      resolveNext = resolve;
    });
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    const stopTyping = () => clearInterval(typingTimer);

    try {
      ++aiWaitingJobs;
      await previousTask;
      --aiWaitingJobs;
      ++aiProcessingJobs;
      signal.throwIfAborted();
      if (shared) {
        // 以前のチャンネルが非公開になっていたら、そこの履歴を持ち出さない。
        for (const id of entry.channels) {
          const channel = await wait(m.guild.channels.fetch(id, { force: true }));
          if (!(channel instanceof TextChannel) || !publicChannel(channel)) {
            entry.ready = undefined;
            entry.lastIds = [];
            entry.channels.clear();
            break;
          }
        }
        entry.channels.add(m.channelId);
      }
      const { t: chat, rep } = await wait(entry.ready ??= newEntry(entry.provider, m));
      entry.t = chat;
      info(m.id, ': start');

      let typingInFlight: Promise<void> | undefined;
      const typing = () => {
        if (!signal.aborted && !typingInFlight) typingInFlight = m.channel.sendTyping().catch(() => {}).finally(() => { typingInFlight = undefined; });
      };
      typing();
      typingTimer = setInterval(typing, 8_000);
      typingTimer.unref();
      signal.addEventListener('abort', stopTyping, { once: true });

      // ★ 最後に自分が投稿したメッセージID（存在すれば after に指定）
      const lastBotMsgId = !shared && entry.lastIds.length > 0
        ? entry.lastIds[entry.lastIds.length - 1]  // 一番最後に送信したID
        : undefined;

      // 直近のメッセージを取得（自分が最後に投稿したIDより後だけ）
      const recentMessages = await wait(m.channel.messages.fetch({ limit: 100, before: m.id }));

      const sorted = (clearMatch ? [] : [...recentMessages.values()])
        .filter(msg => !lastBotMsgId || BigInt(msg.id) > BigInt(lastBotMsgId))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      const replied = await wait(fetchRepliedMessages(m));
      const contextBlock = buildContextBlock(m, sorted, entry.lastIds, rep.length, replied);

      // 覚えていること (ChatGPT の user memory と同じく、検索せず毎ターン常駐させる)
      let memoryBlock = '';
      try {
        memoryBlock = recall({
          memory: await loadMemory(m.guild.id),
          userId: m.author.id,
          text: [m.content, ...replied.map(r => r.content)].join('\n'),
        }).text;
      } catch (e) {
        // 記憶が読めなくても会話は止めない
        error('memory recall failed:', e);
      }

      const attached = new Set<string>();
      const files = await wait(uploadMessageFiles(chat, [m, ...replied, ...[...sorted].reverse()], attached));

      const input = rep + memoryBlock + (memoryBlock === '' ? '' : '\n')
        + (shared ? `[System] 現在のチャンネル: #${m.channel.name} (${m.channelId})\n` : '')
        + (clearMatch?.[2] ? `[System] 履歴はリセット済み。今回の依頼: ${clearMatch[2]}\n` : '') + contextBlock;

      log(m.id, `[${chat.label}]`, input);

      // エージェントループは共通実装 (src/ai/agent.ts)。ここは Discord への出し方だけを持つ
      let pending = '';
      let first = true;
      let last: Message | undefined;
      const sentMessageIds: Snowflake[] = [];
      let toolLogMsg: Message | undefined;

      const flushText = async (generationSignal: AbortSignal): Promise<void> => {
        if (isEffectivelyEmpty(pending)) return;
        const msgs = await sendMessage(pending, m, first, generationSignal);
        sentMessageIds.push(...msgs.map(msg => msg.id));
        pending = '';
        first = false;
      };

      let cursor = m.id;
      const toolFiles: ChatContents = [];
      const result = await runAgent(
        chat,
        [
          { type: 'text', text: input },
          ...files,
        ],
        { msg: m, attachMessage: async (message: Message<boolean>) => { toolFiles.push(...await uploadMessageFiles(chat, [message], attached)); } },
        {
          signal,
          beforeRequest: async () => {
            signal.throwIfAborted();
            const latest = await m.channel.messages.fetch({ limit: 100 });
            const buffered = [...latest.values()].filter(msg => BigInt(msg.id) > BigInt(cursor) && !response.messages.some(sent => sent.id === msg.id))
              .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const extra = toolFiles.splice(0);
            if (!buffered.length) return extra;
            cursor = buffered.at(-1)!.id;
            const trigger = buffered.at(-1)! as OmitPartialGroupDMChannel<Message>;
            return [{ type: 'text', text: buildContextBlock(trigger, buffered.slice(0, -1), [], 0) }, ...extra, ...await uploadMessageFiles(chat, buffered, attached)];
          },
          onEvent: async (gen, generationSignal) => {
            if (generationSignal.aborted) return;
            switch (gen.type) {
              case 'reasoning-start':
                log('start reasoning...');
                break;

              case 'reasoning-delta':
                log('reasoning:', gen.text);
                break;

              case 'text-delta':
                log('gen:', gen.text);
                pending += gen.text;
                break;

              case 'image-thumbnail':
              case 'image':
                log('image:', gen.url);

                await flushText(generationSignal);

                if (last) await last.edit({ content: gen.url });
                else {
                  const msgs = await sendMessage(gen.url, m, first, generationSignal);
                  last = msgs[0];
                  sentMessageIds.push(...msgs.map(msg => msg.id));
                }

                if (gen.type === 'image') last = void 0;
                break;

              case 'tool-call':
                log('function call:');
                await flushText(generationSignal);
                break;

              case 'tool-call-detail': {
                await flushText(generationSignal);
                log('fc:', gen);
                const toolText = `-# ${gen.data.description !== '' ? `${gen.data.description} ` : ''}(\`${gen.data.name}\`)...`
                if (!toolLogMsg)
                  try {
                    toolLogMsg = await m.channel.send({ content: toolText, allowedMentions: { parse: [], repliedUser: false } });
                  } catch (e) {
                    error('error:', e);
                  }
                else
                  await toolLogMsg.edit(toolText);
                if (generationSignal.aborted) { await toolLogMsg?.delete().catch(() => {}); return; }
                if (toolLogMsg && !response.messages.includes(toolLogMsg)) response.messages.push(toolLogMsg);
                if (toolLogMsg) await rememberReply(m, toolLogMsg.id);
                break;
              }

              case 'tool-result':
                log('tool result:', gen.data);
                break;

              case 'error':
                pending += `ERROR:\n\`\`\`json\n${JSON.stringify(gen, null, 2)}\n\`\`\`\n`;
                break;

              case 'usage':
                log('usage:', gen.usage);
                break;

              default:
                log(m.id, 'gen :', gen);
                break;
            }
          },
        },
      );

      clearInterval(typingTimer);
      if (typingInFlight) await wait(typingInFlight);
      if (result.error || result.aborted) {
        entry.ready = undefined;
        entry.t = undefined;
        entry.lastIds = [];
      }
      if (signal.aborted) return;
      if (result.error?.code === 'timeout') {
        pending += `\n${result.error.message}`;
      }

      let text = pending.trim();
      const usage = result.usage;
      text += `\n-# model: ${chat.label}${result.tools.size > 0 ? ` (${Array.from(result.tools, ([k, v]) => `\`${k}\`: ${v}`).join(', ')})` : ""}${usage !== undefined ? ` (tokens: ${formatUsage(usage)})` : ''}`;
      if (toolLogMsg) await toolLogMsg.delete().catch(() => {});
      const finalMsgs = await sendMessage(text, m, first);
      sentMessageIds.push(...finalMsgs.map(msg => msg.id));

      // 今回のメッセージIDを保存
      if (!result.error) entry.lastIds = sentMessageIds;
    } catch (e) {
      entry.ready = undefined;
      entry.t = undefined;
      entry.lastIds = [];
      if (signal.aborted) return;
      error(m.id, ': An error occurred during processing\n', e);
      await sendMessage(`ERROR:\n\`\`\`\n${e}\n\`\`\``, m, true);
    } finally {
      stopTyping();
      signal.removeEventListener('abort', stopTyping);
      --aiProcessingJobs;
      entry.jobs--;
      entry.touched = Date.now();
      resolveNext();
    }
  }
};

export const getAIStatus = (): { waiting: number, processing: number, sessions: Array<{ key: string, provider: string, label: string }> } => ({
  waiting: aiWaitingJobs,
  processing: aiProcessingJobs,
  sessions: Array.from(chatStore.entries()).map(([k, v]) => ({ key: k, provider: v.provider, label: v.t?.label ?? 'initializing' })),
});

export const setupAI = async (): Promise<void> => {
  for (const client of [discord, fluxer]) {
    client.on('messageDelete', m => void deleteAIReplies(m.id));
    client.on('messageDeleteBulk', ms => { for (const id of ms.keys()) void deleteAIReplies(id); });
  }
  await loadPrefs();
  const received = async (m: OmitPartialGroupDMChannel<Message<boolean>>) => {
    if (m.author.bot) return;
    if (m.mentions.users.has(DISCORD_USER_ID) || m.mentions.users.has(FLUXER_USER_ID) || /mizuki|瑞稀/i.test(m.content) || /^=aimodel(?:\s|$)/.test(m.content)) {
      await aiHandler(m);
      return;
    }
    const target = await participationTarget(m);
    if (target) await aiHandler(target === m.id ? m : await m.channel.messages.fetch(target) as OmitPartialGroupDMChannel<Message<boolean>>, true);
  };
  discord.on('messageCreate', m => void received(m).catch(e => error('ai failed:', e)));
  fluxer.on('messageCreate', m => void received(m).catch(e => error('ai failed:', e)));
  try {
    await connectAllMcp();
    refreshMcpTools();
  } catch (e) {
    error('mcp setup failed:', e);
  }
};
