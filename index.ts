// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client, GatewayIntentBits, type Message, TextChannel, ThreadChannel, type OmitPartialGroupDMChannel, type SendableChannels, type Snowflake, WebhookClient } from 'discord.js';
import { type Thread, User } from '@evex/rakutenai';
import { MexcWebsocketClient } from './mexc.ts';
import process from 'node:process';

process.on('unhandledRejection', (reason, promise) => {
  console.error('unhandledRejection', reason, promise);
});

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

const isEffectivelyEmpty = (text: string): boolean => {
  // 正規表現の解説:
  // [ \u3000\n\r] : 半角スペース、全角スペース(\u3000)、改行(\n)、復帰(\r)
  // /g : 文字列全体を対象（グローバルマッチ）
  const cleanedText = text.replace(/[ 　\n\r]/g, '');

  return cleanedText.length === 0;
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

const getFileName = (urlString: string): string => {
  try {
    const url = new URL(urlString);
    // パス（/media/G53TrWRbYAEXaOP.jpg:medium）の最後のセグメントを取得
    const lastSegment = url.pathname.split('/').pop() || '';

    // コロン（:）以降が含まれる場合は、それより前を抽出
    return lastSegment.split(':')[0];
  } catch (error) {
    console.error("Invalid URL", error);
    return '';
  }
};

/// AI feature

const chatStore: Map<string, {
  t: Thread,
  q: Promise<void>,
}> = new Map();

let aiWaitingJobs = 0;
let aiProcessingJobs = 0;

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
    if(m.content === '<@1379433738143924284> chatlist') {
      await m.reply(`joob queue: \`{ waiting: ${aiWaitingJobs}, processing : ${aiProcessingJobs} }\`\ncontext list:\n\`\`\`json\n${JSON.stringify(Array.from(chatStore.keys()), null, 2)}\n\`\`\``);
      return;
    }
    let rep: string = ''; // リプとかシステムプロンプトとか
    const chat = chatStore.get(m.channelId) ?? await (async () => {
      const newChat = {
        t: await (await User.create()).createThread(),
        q: Promise.resolve(),
      };
      chatStore.set(m.channelId, newChat);
      rep = `===== 指示 (重要) =====
あなたはDiscord上で活動するAIエージェントです。
あなたのユーザーIDは 1379433738143924284 です。
レスポンスは簡潔にし、長文は避けてください。
全角英数字、全角記号、半角カタカナの使用は避け、代わりに半角英数字/記号、全角カタカナを用いてください。
==========
`;
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

      const files = await Promise.all(m.attachments.map(async f => {
        console.log('file:', f.url, f.name);
        const file = await createFileFromUrl(f.proxyURL, f.name);
        return chat.t.uploadFile({ file, isImage: file.type.startsWith('image/') })
      }));

      if(m.reference?.messageId) {
        const ref = await m.channel.messages.fetch(m.reference.messageId).catch(console.error);
        if(ref && ref?.author.id !== '1379433738143924284') {
          rep = `> from: ${ref.member?.displayName ?? ref.author.displayName} (${ref.author.username}, ${ref.author.id}) >\n` +(await Promise.all(
            (await m.channel.messages.fetch({ around: m.reference.messageId, limit: 10 }))
              .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
              .filter(fm => fm.author.id === ref?.author.id) // 非連続でも拾うけどいいよね
              .map(async (fm, i) => {
                // 副作用
                files.push(...await Promise.all([
                  ...fm.attachments.map(a => a),
                  ...(fm.embeds.length === 0 ? [] : fm.embeds.filter(a => a.image?.url)
                    .map((a, j) => ({
                      url: a.image!.url, proxyURL: a.image?.proxyURL ?? a.image!.url,
                      name: getFileName(a.image!.url) || `embed-${i}-${j}.png`, // 適当
                    }))
                  ),
                ].map(async f => {
                  console.log('file:', f.url, f.name);
                  const file = await createFileFromUrl(f.proxyURL, f.name);
                  return chat.t.uploadFile({ file, isImage: file.type.startsWith('image/') })
                })) );
                return fm.content.replace(/^/gm, "> ") + ( (fm.embeds && fm.embeds.length !== 0) ? ('\n> embed > ' + JSON.stringify(fm.embeds)) : '');
              })
          )).join('\n');
          rep += '\n\n';
        }
      }

      const input = (rep + `from: ${m.member?.displayName ?? m.author.displayName} (${m.author.username}, ${m.author.id})\n` + m.content).replaceAll('<@1379433738143924284>', '');
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

            if(!isEffectivelyEmpty(text)) {
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
            console.log('function call:');
            m.channel.sendTyping();
            break;

          case 'tool-call-detail':
            console.log('fc:', gen);
            if(!isEffectivelyEmpty(text)) {
              await sendMessage(text, m, first);
              text = '';
              first = false;
            }
            await m.channel.send(`-# ${gen.data.description} (${gen.data.name})`);
            break;

          case 'error':
            await m.reply(`ERROR:\n\`\`\`json\n${JSON.stringify(gen, null, 2)}\n\`\`\``);
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
      await m.reply(`ERROR:\n\`\`\`\n${e}\n\`\`\``);
    } finally {
      --aiProcessingJobs;
      resolveNext();
    }
  }
});


/// watch 114514 coin
let lastPrice: string = "0";
let totalVolume: number = 0;
let lastSide: string = "";
let lastSymbol: string = "";
let hasNewData: boolean = false;
let lastTxCount: number = 0;
let watch114514channel: SendableChannels;
client.on('ready', async (c) => {
  const ch = await c.channels.fetch('1468910632119308289');
  if(!ch || !ch.isSendable()) throw new Error('failed to get 114514 channel');
  watch114514channel = ch;
});

const mexc = new MexcWebsocketClient((event) => {
  // console.log(event);
  if (event.type === 'MARKET_DATA') {
    const wrapper = event.data;
    const publicDeals = wrapper.publicAggreDeals;

    if (publicDeals) {
      lastSymbol = wrapper.symbol;
      const dealsArray = publicDeals.deals;

      if (dealsArray && dealsArray.length > 0) {
        // 10秒間の最後の約定データを最新として保持
        const lastTrade = dealsArray[dealsArray.length - 1];
        lastPrice = lastTrade.price;
        lastSide = lastTrade.tradeType === 1 ? '🟢 BUY' : '🔴 SELL';

        dealsArray.forEach(d => {
          totalVolume += parseFloat(d.quantity);
        });

        lastTxCount += dealsArray.length;
        hasNewData = true; // データが更新されたフラグ
      }
    }
  }
});

setInterval(async () => {
  // 新しいデータがない場合は送らない
  if (!hasNewData) return;

  const message = `📊 **【${lastSymbol}】定期報告**\n` +
                  `💰 現在価格: \`${lastPrice} USDT\`\n` +
                  `動向: ${lastSide}\n` +
                  `直近30秒の出来高: \`${totalVolume.toFixed(2)} USDT\`\n` +
                  `📈 取引回数: ${lastTxCount} Trades\n`;
  watch114514channel.send({ embeds: [{
    description: message,
    timestamp: new Date().toISOString(),
  }] });
  // console.log(message);

  // 送信後にバッファをリセット
  hasNewData = false;
  totalVolume = 0;
  lastTxCount = 0;
}, 30000); // 10000ms = 10秒

mexc.subscribe(['spot@public.aggre.deals.v3.api.pb@100ms@114514USDT']);
mexc.connect();


/// anka feature
const ankas = new Map<Snowflake, { msg: Message, target: number, count: number }>();

client.on('messageCreate', async m => {
  if(m.author.bot) return;

  if(m.content === '=anka') {
    const ls: Array<string> = [];
    ankas.forEach(a => {
      if(m.channelId !== a.msg.channelId) return;
      ls.push(`>>${a.target} (${a.count}/${a.target}) ${a.msg.url}`);
    });
    m.reply(ls.length === 0 ? 'このチャンネルで進行中の安価はありません' : ls.join('\n'));

    return;
  }

  let toSend = '';
  ankas.forEach((a, k) => {
    if(a.count >= a.target) { ankas.delete(k); return; }
    if(m.channelId !== a.msg.channelId || a.target !== ++a.count) return;
    ankas.delete(k);
    toSend += `[>>${a.target}](${a.msg.url}) <@${a.msg.author.id}>\n`;
  });
  if(toSend !== '') m.reply("安価されました\n" + toSend);

  let i = 0;
  m.content.match(/>>\d+/g)?.forEach((a) => {
    const t = Number(a.slice(2));
    if(t === 0 || t > 200) return;
    ankas.set(`${m.id}+${i}`, { msg: m, target: t, count: 0 });
    ++i;
  });
});


// Fluxer sync
const fluxer = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  rest: {
    api: 'https://web.fluxer.app/api/',
    version: '1',
    cdn: 'https://fluxerusercontent.com/'
  },
  ws: {
    version: 1,
  },
});

const discordWHID = '1493988795849113723';
const discordWH = new WebhookClient({ id: discordWHID, token: process.env['DISCORD_WH_TOKEN']! });
const discordTargetCh = '1493982933025816576';
const fluxerWHID = '1493982452663773810';
const fluxerWH = new WebhookClient({ id: fluxerWHID, token: process.env['FLUXER_WH_TOKEN']! });
const fluxerTargetCh = '1493971310876907609';

client.on('messageCreate', async m => {
  if(m.channelId !== discordTargetCh
    || m.author.id === discordWHID) return;
  await fluxerWH.send({
    allowedMentions: {
      parse: [], // とりあえずメンション無し
    },
    username: `${m.member?.nickname ?? m.author.displayName}#Discord`,
    avatarURL: m.member?.avatarURL() ?? m.author.avatarURL() ?? void 0,
    content: m.content,
    embeds: m.embeds,
    files: [...m.attachments.values()],
    tts: m.tts,
    withComponents: false,
  });
});

fluxer.on('messageCreate', async m => {
  if(m.channelId !== fluxerTargetCh
    || m.author.id === fluxerWHID) return;
  await discordWH.send({
    allowedMentions: {
      parse: [], // とりあえずメンション無し
    },
    username: `${m.member?.nickname ?? m.author.displayName}#Fluxer`,
    avatarURL: m.member?.avatarURL() ?? m.author.avatarURL() ?? void 0,
    content: m.content,
    embeds: m.embeds,
    files: [...m.attachments.values()],
    tts: m.tts,
    withComponents: false,
    threadId: '1493982933025816576',
  });
});

client.login(process.env['DISCORD_TOKEN']);
