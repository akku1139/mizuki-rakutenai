// SPDX-License-Identifier: AGPL-3.0-or-later

/// Watches the MEXC deals stream of 114514USDT and posts periodic reports.

import { type SendableChannels } from 'discord.js';
import { MexcWebsocketClient } from '../mexc.ts';
import { discord } from './clients.ts';

let lastPrice: string = "0";
let totalVolume: number = 0;
let lastSide: string = "";
let lastSymbol: string = "";
let hasNewData: boolean = false;
let lastTxCount: number = 0;
let watch114514channel: SendableChannels;

discord.on('clientReady', async (c) => {
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
  if (!hasNewData || watch114514channel === undefined) return;

  const message = `📊 **【${lastSymbol}】定期報告**\n` +
                  `💰 現在価格: \`${lastPrice} USDT\`\n` +
                  `動向: ${lastSide}\n` +
                  `直近30秒の出来高: \`${totalVolume.toFixed(2)} USDT\`\n` +
                  `📈 取引回数: ${lastTxCount} Trades\n`;
  await watch114514channel.send({ embeds: [{
    description: message,
    timestamp: new Date().toISOString(),
  }] });
  // console.log(message);

  // 送信後にバッファをリセット
  hasNewData = false;
  totalVolume = 0;
  lastTxCount = 0;
}, 30000); // 10000ms = 10秒

export const setupCoinWatch = (): void => {
  mexc.subscribe(['spot@public.aggre.deals.v3.api.pb@100ms@114514USDT']);
  mexc.connect();
};
