import { Client, GatewayIntentBits, TextChannel, ThreadChannel } from 'discord.js';
import { type Thread, User } from '@evex/rakutenai';

const aiUser = await User.create();

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

client.on('error', async err => {
  console.error(err.stack ?? err.name + '\n' + err.message);
});

client.on('ready', readyClient => {
  console.info(`Logged in as ${readyClient.user.tag}!`);
});

const chatStore: Map<string, {
  t: Thread,
  q: Promise<void>,
}> = new Map();

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
        t: await aiUser.createThread(),
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

      const res = chat.t.sendMessage({
        mode: "USER_INPUT",
        contents: [
          { type: 'text', text: m.content.replaceAll('<@1379433738143924284>', '') },
        ],
      });

      let text = '';
      let c = 0;

      for await (const gen of res) {
        if(++c%7 === 0)
          await m.channel.sendTyping();
        switch(gen.type) {
          case 'reasoning-start':
            console.log('start reasoning...');
            break;
          case 'reasoning-delta':
            console.log('reasoning:', gen.text);
            break;
          case 'text-delta':
            console.log('gen:', gen.text);
            if(gen.text.startsWith('fc_') && gen.text.length === 53) {
              await m.channel.sendTyping();
              await m.channel.send('-# function call...');
              break; // ex: fc_09665a3dab3773fc0169493feb2210819fb242672633635b84
            }
            text += gen.text;
            break;
          default:
            console.log(m.id, 'gen :', gen);
            break;
        }
      }

      text += '\n-# model: rakutenai';

      const parts = splitLongString(text
        .replace(/^####+ /gm, '### ')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s>)]+)\)/g, "[$1](<$2>)")
      , 1500);
      let first = true;

      for(const part of parts) {
        if(first) {
          await m.reply(part);
          first = false;
        } else {
          await m.channel.send(part);
        }
      }
    } catch(e) {
      console.error(m.id, ': An error occurred during processing\n', e);
    } finally {
      resolveNext();
    }
  }
});

client.login(process.env['DISCORD_TOKEN']);
