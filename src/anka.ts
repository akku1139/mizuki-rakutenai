// SPDX-License-Identifier: AGPL-3.0-or-later

/// 安価 (>>n anchor) feature.

import { type Message, type OmitPartialGroupDMChannel, type Snowflake } from 'discord.js';
import { discord } from './clients.ts';

const ankas = new Map<Snowflake, { msg: Message, target: number, count: number }>();

export const setupAnka = (): void => {
  discord.on('messageCreate', async m => {
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
};
