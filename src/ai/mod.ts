// SPDX-License-Identifier: AGPL-3.0-or-later

/// Mention-triggered AI assistant (RakutenAI thread per channel).

import {
  type Message,
  TextChannel,
  ThreadChannel,
  type OmitPartialGroupDMChannel,
  type Snowflake,
} from 'discord.js';
import { type Thread, User } from '@evex/rakutenai';
import { DISCORD_USER_ID, discord, FLUXER_USER_ID, fluxer } from '../clients.ts';
import { whMapFluxer } from '../fluxsync/state.ts';
import { createFileFromUrl, isEffectivelyEmpty, splitLongString } from '../utils.ts';
import { buildContextBlock } from './context.ts';
import { buildSystemPrompt } from './prompt.ts';

interface ChatState {
  t: Thread,
  q: Promise<void>,
  lastIds: Snowflake[],
}

const chatStore: Map<string, ChatState> = new Map();

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
    const contextKey = whMapFluxer[m.channelId] ? whMapFluxer[m.channelId].targetClannelID : m.channelId;

    if (m.content === `<@${DISCORD_USER_ID}> clear` || m.content === `<@${FLUXER_USER_ID}> clear`) {
      chatStore.delete(contextKey);
      await m.reply('chat context destroyed.');
      return;
    }
    if (m.content === `<@${DISCORD_USER_ID}> chatlist` || m.content === `<@${FLUXER_USER_ID}> chatlist`) {
      await m.reply(`job queue: \`{ waiting: ${aiWaitingJobs}, processing : ${aiProcessingJobs} }\`\ncontext list:\n\`\`\`json\n${JSON.stringify(Array.from(chatStore.keys()), null, 2)}\n\`\`\``);
      return;
    }

    let rep: string = '';
    const chat = chatStore.get(contextKey) ?? await (async () => {
      const newChat = {
        t: await (await User.create()).createThread(),
        q: Promise.resolve(),
        lastIds: [] as Snowflake[],
      };
      chatStore.set(contextKey, newChat);
      rep = await buildSystemPrompt(m.guild);
      return newChat;
    })();

    const previousTask = chat.q;
    let resolveNext: () => void = () => console.error(m.id, 'Execute off-queue');
    chat.q = new Promise((resolve) => {
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
      const lastBotMsgId = chat.lastIds.length > 0
        ? chat.lastIds[chat.lastIds.length - 1]  // 一番最後に送信したID
        : undefined;

      // 直近のメッセージを取得（自分が最後に投稿したIDより後だけ）
      const recentMessages = await m.channel.messages.fetch({
        limit: 35,
        before: m.id,
        // after: lastBotMsgId,
      });

      const sorted = [...recentMessages.values()]
        .filter(msg => !lastBotMsgId || BigInt(msg.id) > BigInt(lastBotMsgId))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      const contextBlock = buildContextBlock(m, sorted, chat.lastIds, rep.length);

      const files = await Promise.all(m.attachments.map(async f => {
        console.log('file:', f.url, f.name);
        const file = await createFileFromUrl(f.proxyURL, f.name);
        return chat.t.uploadFile({ file, isImage: file.type.startsWith('image/') })
      }));

      const input = rep + contextBlock;

      console.log(m.id, input);

      const res = chat.t.sendMessage({
        mode: "USER_INPUT",
        contents: [
          { type: 'text', text: input },
          ...(files.map(f => ({ type: 'file', file: f } as const))),
        ],
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
      text += `\n-# model: rakutenai ${toolCount.size > 0 ? `(${Array.from(toolCount, ([k, v]) => `${k}: ${v}`).join(', ')})` : ""}`;
      const finalMsgs = await sendMessage(text, m, first);
      sentMessageIds.push(...finalMsgs.map(msg => msg.id));

      // 今回のメッセージIDを保存
      chat.lastIds = sentMessageIds;

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
};
