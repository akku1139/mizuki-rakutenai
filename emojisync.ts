// SPDX-License-Identifier: AGPL-3.0-or-later

// EvexのDiscordサーバーのアニメーション絵文字とスタンプ(スティッカー)をFluxerサーバーへコピーする。
// 静止画の絵文字は移行済みなので対象にしない。
// 一度きりの移行用。重複チェックはしないので、流した回数だけ同じものが増える。
//   node --env-file=.env emojisync.ts

import { Client, GatewayIntentBits, type Guild } from 'discord.js';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const DISCORD_GUILD = '1255359848644608035';
const FLUXER_GUILD = '1493971310876907609';

/**
 * Fluxerの絵文字・スタンプのサイズ上限は512KiB(524288バイト)だが、
 * base64の長さでも別途上限を見ており、そちらは ceil(524288 * 4/3) = 699051 文字。
 * 524288バイトはbase64で699052文字になって長さの方に引っかかるので、実質の上限は2バイト小さい。
 */
const MAX_BYTES = 524286;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildExpressions,
  ],
});

const fluxer = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildExpressions,
  ],
  rest: {
    // do not add / at the last
    api: 'https://api.fluxer.app',
    version: '1',
    cdn: 'https://fluxerusercontent.com',
  },
  ws: {
    version: 1,
  },
});

// Fluxerは厳密にはAPI互換ではないので、拾いきれないrejectionでスクリプトごと落ちないようにする
process.on('unhandledRejection', (reason, promise) => {
  console.error('unhandledRejection', reason, promise);
});

const download = async (url: string): Promise<Buffer> =>
  Buffer.from(await (await fetch(url)).arrayBuffer());

/**
 * Fluxerはこの data: の後のMIMEタイプを見ておらず、実際のバイト列から形式を判定するので、
 * ここで何を書いても結果は変わらない。実物に合わせておくだけ。
 */
const dataUri = (buf: Buffer, mime: string): string =>
  `data:${mime};base64,${buf.toString('base64')}`;

/** StickerFormatType -> MIMEタイプ (PNG=1, APNG=2, LOTTIE=3, GIF=4) */
const stickerMime: Record<number, string> = {
  1: 'image/png',
  2: 'image/apng',
  3: 'application/json',
  4: 'image/gif',
};

/** 失敗の原因が分かるように、APIが返した中身まで出す */
const describeError = (err: unknown): string => {
  if (err !== null && typeof err === 'object') {
    const e = err as { status?: number, code?: number | string, message?: string, rawError?: unknown };
    if (e.status !== undefined || e.code !== undefined) {
      return `HTTP ${e.status ?? '?'} code ${e.code ?? '?'}: ${e.message ?? ''} ${JSON.stringify(e.rawError ?? {})}`;
    }
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
};

/**
 * DiscordからFluxerへアニメーション絵文字をコピーする（重複チェックなし）。
 *
 * 絵文字の作成はDiscordもFluxerも {name, image} のJSONなので、discord.jsのcreate()がそのまま使える。
 * 前回アニメーションだけ失敗したのは、Fluxerの512KiB制限に引っかかっていたためと思われる。
 * Fluxerの公式クライアントは静止画を128pxのPNGに再エンコードしてから送るので上限に当たらないが、
 * アニメーションは無加工で送られるので、大きいものはクライアント側で弾かれる。
 * discord.jsは何も縮小しないため、静止画だけ通ってアニメーションが落ちる形になる。
 */
const syncEmojis = async (from: Guild, to: Guild, label: string): Promise<void> => {
  const fromEmojis = await from.emojis.fetch();

  let created = 0;
  let failed = 0;
  let tooBig = 0;

  for (const e of fromEmojis.values()) {
    if (!e.name || !e.animated) continue;

    try {
      // e.url任せにするとwebpで返ることがあるので、GIFを明示して取得する
      const buf = await download(e.imageURL({ extension: 'gif' }));

      if (buf.length > MAX_BYTES) {
        // 縮小には外部ツールが要るので、ここでは対象を挙げるだけにする
        console.error(`  - emoji ${e.name}: ${buf.length} bytes (over ${MAX_BYTES}), needs shrinking by hand`);
        ++tooBig;
        continue;
      }

      await to.emojis.create({ attachment: dataUri(buf, 'image/gif'), name: e.name });
      console.log(`  + emoji ${e.name} (${buf.length} bytes)`);
      ++created;
    } catch (err) {
      console.error(`  ! emoji ${e.name}:`, describeError(err));
      ++failed;
    }
  }

  console.log(`${label} animated emojis: ${created} created${tooBig > 0 ? `, ${tooBig} too big` : ''}${failed > 0 ? `, ${failed} failed` : ''}`);
};

/**
 * DiscordからFluxerへスタンプをコピーする（重複チェックなし）。
 *
 * Fluxerのスタンプ作成は絵文字と同じ {name, image} 形式のJSONで、multipartは受け付けない。
 * discord.jsのstickers.create()はmultipartで送るため、Fluxer側はJSONとして読めず空とみなし、
 * 「nameとimageが無い」という400を返す。つまり何を送っても通らないので、RESTを直接叩く。
 * tagsもDiscordはカンマ区切りの文字列、Fluxerは文字列の配列で、形が違う。
 */
const syncStickers = async (from: Guild, to: Guild, label: string): Promise<void> => {
  const fromStickers = await from.stickers.fetch();

  let created = 0;
  let failed = 0;
  let tooBig = 0;

  for (const s of fromStickers.values()) {
    try {
      const buf = await download(s.url);

      if (buf.length > MAX_BYTES) {
        console.error(`  - sticker ${s.name}: ${buf.length} bytes (over ${MAX_BYTES}), needs shrinking by hand`);
        ++tooBig;
        continue;
      }

      await to.client.rest.post(`/guilds/${to.id}/stickers`, {
        body: {
          name: s.name,
          description: s.description ?? undefined,
          tags: (s.tags ?? '').split(',').map(t => t.trim()).filter(t => t.length > 0).slice(0, 10),
          image: dataUri(buf, stickerMime[s.format] ?? 'image/png'),
        },
      });
      console.log(`  + sticker ${s.name} (${buf.length} bytes)`);
      ++created;
    } catch (err) {
      console.error(`  ! sticker ${s.name}:`, describeError(err));
      ++failed;
    }
  }

  console.log(`${label} stickers: ${created} created${tooBig > 0 ? `, ${tooBig} too big` : ''}${failed > 0 ? `, ${failed} failed` : ''}`);
};

if (!process.env['DISCORD_TOKEN'] || !process.env['FLUXER_TOKEN']) {
  console.error('DISCORD_TOKEN and FLUXER_TOKEN environment variables are required.');
  process.exit(1);
}

const discordReady = new Promise<void>((resolve) => client.once('clientReady', () => resolve()));
const fluxerReady = new Promise<void>((resolve) => fluxer.once('clientReady', () => resolve()));

await Promise.all([
  client.login(process.env['DISCORD_TOKEN']),
  fluxer.login(process.env['FLUXER_TOKEN']),
]);
await Promise.all([discordReady, fluxerReady]);

const discordGuild = await client.guilds.fetch(DISCORD_GUILD);
const fluxerGuild = await fluxer.guilds.fetch(FLUXER_GUILD);

await syncEmojis(discordGuild, fluxerGuild, 'Discord -> Fluxer');
await syncStickers(discordGuild, fluxerGuild, 'Discord -> Fluxer');

await client.destroy();
await fluxer.destroy();
