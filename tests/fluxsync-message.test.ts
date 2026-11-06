// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, type Attachment, type Message, type Sticker } from 'discord.js';
import { discord, fluxer } from '../src/clients.ts';
import { setupFluxSync } from '../src/fluxsync/mod.ts';
import { whMapDiscord, whMapFluxer } from '../src/fluxsync/state.ts';

test('Fluxer webhookへsnake_caseのアバター・返信・メンション抑止を送る', async t => {
  whMapDiscord['100'] = { whID: '10', whToken: 'test', targetChannelID: '200' };
  whMapFluxer['200'] = { whID: '20', whToken: 'test', targetChannelID: '100' };
  setupFluxSync();
  const handler = discord.listeners('messageCreate').at(-1)!;
  const payloads: Array<{ avatar_url: string, message_reference?: { message_id: string }, allowed_mentions: { parse: string[] } }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), 'https://api.fluxer.app/webhooks/20/test?wait=true');
    payloads.push(JSON.parse(String((init.body as FormData).get('payload_json'))) as (typeof payloads)[number]);
    return Response.json({ id: String(301 + payloads.length - 1) });
  });
  const message = (id: string, replyTo?: string) => ({ id, channelId: '100', client: discord, content: 'hello', member: null,
    author: { id: '1', displayName: 'user', avatarURL: () => null, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
    reference: replyTo ? { messageId: replyTo } : null, attachments: new Collection<string, Attachment>(), stickers: new Collection<string, Sticker>(), embeds: [], tts: false,
  }) as unknown as Message;
  try {
    await handler(message('300') as never);
    await handler(message('302', '300') as never);
    assert.equal(payloads[0].avatar_url, 'https://cdn.discordapp.com/embed/avatars/0.png');
    assert.deepEqual(payloads[1].message_reference, { message_id: '301' });
    assert.deepEqual(payloads[1].allowed_mentions, { parse: [] });
  } finally {
    discord.removeAllListeners(); fluxer.removeAllListeners();
    delete whMapDiscord['100']; delete whMapFluxer['200'];
  }
});
