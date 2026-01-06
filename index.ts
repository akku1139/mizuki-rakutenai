// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client, GatewayIntentBits, type Message, TextChannel, ThreadChannel, type OmitPartialGroupDMChannel } from 'discord.js';
import { type Thread, User } from '@evex/rakutenai';
import { MexcWebsocketClient } from './mexc.ts';

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
] });

export const splitLongString = (text: string, len: number): Array<string> => {
  const result: Array<string> = [];

  let rest = text;
  while(true) {
    if(rest.length <= len) {
      result.push(rest);
      break;
    }
    const part = rest.substring(0, len);
    const i = part.lastIndexOf('\n');
    if(i === -1) {
      result.push(part);
      rest = rest.substring(len);
    } else {
      result.push(part.substring(0, i+1)); // i+1をiにすると改行は消化される
      rest = rest.substring(i+1);
    }
    if(rest==='') break;
  }

  return result; // 空文字列をfilterしてあげればいい
};

const createFileFromUrl = async (url: string, fileName: string): Promise<File> => {
  // 1. URLからデータを取得
  const response = await fetch(url);

  // 2. ResponseをBlob（バイナリデータ）に変換
  const data = await response.blob();

  // 3. Blobのメタデータを元にFileオブジェクトを作成
  // 第二引数にはファイル名、第三引数にはMIMEタイプ（任意）を指定
  const metadata = { type: data.type ?? 'text/plain' };
  return new File([data], fileName, metadata);
}

client.on('error', async err => {
  console.error(err.stack ?? err.name + '\n' + err.message);
});

client.on('ready', readyClient => {
  console.info(`Logged in as ${readyClient.user.tag}!`);
});


/// AI feature

const chatStore: Map<string, {
  t: Thread,
  q: Promise<void>,
}> = new Map();

const sendMessage = async (text: string, m: OmitPartialGroupDMChannel<Message>, first: boolean): Promise<Message> => {
  const parts = splitLongString(text
    .replace(/^####+ /gm, '### ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s>)]+)\)/g, "[$1](<$2>)")
  , 1500);

  let sent: Message = m; // ここゴミ

  for(const part of parts) {
    if(first) {
      sent = await m.reply(part);
      first = false;
    } else {
      sent = await m.channel.send(part);
    }
  }

  return sent;
}

client.on('messageCreate', async m => {
  if(
      !m.author.bot
    && m.mentions.users.has(client.user!.id)
    && (m.channel instanceof TextChannel || m.channel instanceof ThreadChannel)
    && m.guild !== null
  ) {
    if(m.content === '<@1379433738143924284> clear') {
      chatStore.delete(m.channelId);
      await m.reply('chat context destroyed.');
      return;
    }
    const chat = chatStore.get(m.channelId) ?? await (async () => {
      const newChat = {
        t: await (await User.create()).createThread(),
        q: Promise.resolve(),
      };
      chatStore.set(m.channelId, newChat);
      return newChat;
    })();
    const previousTask = chat.q;
    let resolveNext: () => void = () => console.error(m.id, 'Execute off-queue');
    chat.q = new Promise((resolve) => {
      resolveNext = resolve;
    });

    try {
      await previousTask;
      console.info(m.id, ': start');

      m.channel.sendTyping();

      const files = await Promise.all(m.attachments.map(async f => {
        console.log('file:', f.url, f.name);
        const file = await createFileFromUrl(f.proxyURL, f.name);
        return chat.t.uploadFile({ file, isImage: file.type.startsWith('image/') })
      }));

      const res = chat.t.sendMessage({
        mode: "USER_INPUT",
        contents: [
          { type: 'text', text: m.content.replaceAll('<@1379433738143924284>', '') },
          ...(files.map(f => ({ type: 'file', file: f } as const))),
        ],
      });

      let text = '';
      let c = 0;

      let first = true;
      let last: Message|undefined;

      for await (const gen of res) {
        if(++c%7 === 0)
          m.channel.sendTyping();
        switch(gen.type) {
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

            if(text) {
              await sendMessage(text, m, first);
              text = '';
              first = false;
            }

            if(last) await last.edit({ content: gen.url });
            else last = await sendMessage(gen.url, m, first);

            if(gen.type === 'image') last = void 0;

            /* なぜかembedの画像が一瞬で消える
            await m.channel.send({ embeds: [
              { image: { url: gen.url } },
            ] });
            */
            break;

          case 'tool-call':
            m.channel.sendTyping();
            await m.channel.send('-# function call...');
            break;

          default:
            console.log(m.id, 'gen :', gen);
            break;
        }
      }

      text += '\n-# model: rakutenai';
      await sendMessage(text, m, first);
    } catch(e) {
      console.error(m.id, ': An error occurred during processing\n', e);
    } finally {
      resolveNext();
    }
  }
});


/// watch 114514 coin


client.login(process.env['DISCORD_TOKEN']);
