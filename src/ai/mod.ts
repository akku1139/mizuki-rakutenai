// SPDX-License-Identifier: AGPL-3.0-or-later

/// Mention-triggered AI assistant (RakutenAI / OpenAI互換API).

import {
  type Message,
  TextChannel,
  ThreadChannel,
  type OmitPartialGroupDMChannel,
  type Snowflake,
} from 'discord.js';
import { type Thread, User } from '@evex/rakutenai';
import process from 'node:process';
import { DISCORD_USER_ID, discord, FLUXER_USER_ID, fluxer } from '../clients.ts';
import { whMapFluxer } from '../fluxsync/state.ts';
import { createFileFromUrl, isEffectivelyEmpty, splitLongString } from '../utils.ts';
import { buildContextBlock } from './context.ts';
import { OpenAICompatChat } from './openai.ts';
import { getUserProvider, loadPrefs, setUserProvider } from './prefs.ts';
import { buildSystemPrompt } from './prompt.ts';
import { aitoolsSpec } from './tools.ts';
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

interface ChatEntry {
  t: ChatSession,
  q: Promise<void>,
  lastIds: Snowflake[],
  provider: ProviderName,
}

/** 既定のプロバイダ (env: AI_PROVIDER、未指定なら rakutenai) */
const defaultProvider = (): ProviderName => {
  const v = process.env['AI_PROVIDER'] ?? 'rakutenai';
  return isProviderName(v) ? v : 'rakutenai';
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
): Promise<ChatSession> => {
  if (provider === 'openai') {
    const chat = new OpenAICompatChat(
      {
        baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
        apiKey: process.env['OPENAI_API_KEY'] ?? '',
        model: process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
      },
      aitoolsSpec,
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
): Promise<{ entry: ChatEntry, rep: string }> => {
  const rep = await buildSystemPrompt(m.guild);
  const t = await createChatSession(provider, {
    guildName: m.guild?.name,
    channelName: m.channel.isDMBased() ? undefined : m.channel.name,
  });
  t.setSystemPrompt?.(rep);
  return {
    entry: { t, q: Promise.resolve(), lastIds: [], provider },
    rep: t.setSystemPrompt == null ? rep : '',
  };
};

const chatStore = new Map<string, ChatEntry>();

let aiWaitingJobs = 0;
let aiProcessingJobs = 0;

const sendMessage = async (text: string, m: OmitPartialGroupDMChannel<Message>, first: boolean): Promise<Message[]> => {
  const parts = splitLongString(text
    .replace(/^####+ /gm, '### ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s>)]+)\)/g, "[$1](<$2>)")
  , 1500);

  const sentMessages: Message[] = [];

  for(const part of parts) {
    if(first) {
      sentMessages.push(await m.reply(part));
      first = false;
    } else {
      sentMessages.push(await m.channel.send(part));
    }
  }

  return sentMessages;
};

const aiHandler = async (m: OmitPartialGroupDMChannel<Message<boolean>>) => {
  if (
    !m.author.bot
    && (m.mentions.users.has(discord.user!.id) || m.mentions.users.has(fluxer.user!.id))
    && (m.channel instanceof TextChannel || m.channel instanceof ThreadChannel)
    && m.guild !== null
  ) {
    // セッションは「チャンネル x ユーザー」単位。Fluxer同期チャンネルはDiscord側のIDに正規化する。
    const channelKey = whMapFluxer[m.channelId] ? whMapFluxer[m.channelId].targetChannelID : m.channelId;
    const contextKey = `${channelKey}:${m.author.id}`;

    if (m.content === `<@${DISCORD_USER_ID}> clear` || m.content === `<@${FLUXER_USER_ID}> clear`) {
      chatStore.delete(contextKey);
      await m.reply('chat context destroyed.');
      return;
    }
    if (m.content === `<@${DISCORD_USER_ID}> chatlist` || m.content === `<@${FLUXER_USER_ID}> chatlist`) {
      await m.reply(`job queue: \`{ waiting: ${aiWaitingJobs}, processing : ${aiProcessingJobs} }\`\ncontext list:\n\`\`\`json\n${JSON.stringify(Array.from(chatStore.entries()).map(([k, v]) => [k, v.provider, v.t.label]), null, 2)}\n\`\`\``);
      return;
    }

    // aimodel [provider]: 呼び出したユーザーのAIバックエンドを表示/切り替える (=aimodel でも可)
    const modelMatch = m.content.match(`^<@(${DISCORD_USER_ID}|${FLUXER_USER_ID})> =?aimodel(\\s+(\\S+))?$`);
    if (modelMatch) {
      const p = modelMatch[3];
      if (p === undefined) {
        const current = getUserProvider(m.author.id) ?? defaultProvider();
        await m.reply(`your AI model: \`${current}\`\navailable: ${PROVIDERS.map(x => `\`${x}\``).join(', ')}\nusage: \`@bot aimodel <provider>\``);
        return;
      }
      if (!isProviderName(p)) {
        await m.reply(`unknown provider: \`${p}\`\navailable: ${PROVIDERS.map(x => `\`${x}\``).join(', ')}`);
        return;
      }
      try {
        await setUserProvider(m.author.id, p); // 永続化
        chatStore.delete(contextKey);          // 履歴はリセットして新モデルで開始
        await m.reply(`AI model switched to \`${p}\`. chat context was reset.`);
      } catch (e) {
        await m.reply(`failed to switch: ${e}`);
      }
      return;
    }

    let rep: string = '';
    let entry = chatStore.get(contextKey);
    if (entry === undefined) {
      // ユーザー単位の設定 > env (AI_PROVIDER) の既定
      ({ entry, rep } = await newEntry(getUserProvider(m.author.id) ?? defaultProvider(), m));
      chatStore.set(contextKey, entry);
    }

    const { t: chat } = entry;

    const previousTask = entry.q;
    let resolveNext: () => void = () => console.error(m.id, 'Execute off-queue');
    entry.q = new Promise((resolve) => {
      resolveNext = resolve;
    });

    try {
      ++aiWaitingJobs;
      await previousTask;
      --aiWaitingJobs;
      ++aiProcessingJobs;
      console.info(m.id, ': start');

      m.channel.sendTyping();

      const toolCount = new Map<string, number>();

      // ★ 最後に自分が投稿したメッセージID（存在すれば after に指定）
      const lastBotMsgId = entry.lastIds.length > 0
        ? entry.lastIds[entry.lastIds.length - 1]  // 一番最後に送信したID
        : undefined;

      // 直近のメッセージを取得（自分が最後に投稿したIDより後だけ）
      const recentMessages = await m.channel.messages.fetch({ limit: 35, before: m.id });

      const sorted = [...recentMessages.values()]
        .filter(msg => !lastBotMsgId || BigInt(msg.id) > BigInt(lastBotMsgId))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      const contextBlock = buildContextBlock(m, sorted, entry.lastIds, rep.length);

      const files = await Promise.all(m.attachments.map(async f => {
        console.log('file:', f.url, f.name);
        const file = await createFileFromUrl(f.proxyURL, f.name);
        return chat.uploadFile({ file, isImage: file.type.startsWith('image/') })
      }));

      const input = rep + contextBlock;

      console.log(m.id, `[${chat.label}]`, input);

      const res = chat.sendMessage({
        mode: "USER_INPUT",
        contents: [
          { type: 'text', text: input },
          ...(files.map(f => ({ type: 'file', file: f } as const))),
        ],
        meta: { msg: m },
      });

      let text = '';
      let c = 0;

      let first = true;
      let last: Message | undefined;
      const sentMessageIds: Snowflake[] = [];

      for await (const gen of res) {
        if (++c % 7 === 0)
          m.channel.sendTyping();
        switch (gen.type) {
          case 'reasoning-start':
            console.log('start reasoning...');
            break;

          case 'reasoning-delta':
            console.log('reasoning:', gen.text);
            break;

          case 'text-delta':
            console.log('gen:', gen.text);
            text += gen.text;
            break;

          case 'image-thumbnail':
          case 'image':
            console.log('image:', gen.url);
            m.channel.sendTyping();

            if (!isEffectivelyEmpty(text)) {
              const msgs = await sendMessage(text, m, first);
              sentMessageIds.push(...msgs.map(msg => msg.id));
              text = '';
              first = false;
            }

            if (last) await last.edit({ content: gen.url });
            else {
              const msgs = await sendMessage(gen.url, m, first);
              last = msgs[0];
              sentMessageIds.push(...msgs.map(msg => msg.id));
            }

            if (gen.type === 'image') last = void 0;

            /* なぜかembedの画像が一瞬で消える
            await m.channel.send({ embeds: [
              { image: { url: gen.url } },
            ] });
            */
            break;

          case 'tool-call':
            console.log('function call:');
            m.channel.sendTyping();
            break;

          case 'tool-call-detail':
            console.log('fc:', gen);
            toolCount.set(gen.data.name, (toolCount.get(gen.data.name) ?? 0) + 1);
            // 進捗表示 (evex-quotesと同様)
            await m.channel.send(`-# ${gen.data.description !== '' ? `${gen.data.description} ` : ''}(${gen.data.name})...`);
            break;

          case 'tool-result':
            console.log('tool result:', gen.data);
            m.channel.sendTyping();
            break;

          case 'error':
            text += `ERROR:\n\`\`\`json\n${JSON.stringify(gen, null, 2)}\n\`\`\`\n`;
            chatStore.delete(contextKey);
            break;

          case 'usage':
            console.log('usage:', gen.usage);
            break;

          default:
            console.log(m.id, 'gen :', gen);
            break;
        }
      }

      text = text.trim();
      text += `\n-# model: ${chat.label}${toolCount.size > 0 ? ` (${Array.from(toolCount, ([k, v]) => `${k}: ${v}`).join(', ')})` : ""}`;
      const finalMsgs = await sendMessage(text, m, first);
      sentMessageIds.push(...finalMsgs.map(msg => msg.id));

      // 今回のメッセージIDを保存
      entry.lastIds = sentMessageIds;

    } catch (e) {
      console.error(m.id, ': An error occurred during processing\n', e);
      await m.reply(`ERROR:\n\`\`\`\n${e}\n\`\`\``);
    } finally {
      --aiProcessingJobs;
      resolveNext();
    }
  }
};

export const setupAI = (): void => {
  discord.on('messageCreate', aiHandler);
  fluxer.on('messageCreate', aiHandler);
  void loadPrefs();
};
