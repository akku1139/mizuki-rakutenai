// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { connectMcp } from '../src/ai/mcp.ts';

test('OAuth完了時はSDKの型に合わせてHTTPにはissuer付き引数、SSEにはcodeを渡す', async t => {
  t.mock.method(Client.prototype, 'connect', async () => {});
  t.mock.method(Client.prototype, 'close', async () => {});
  const httpArgs: unknown[] = [], sseArgs: unknown[] = [];
  t.mock.method(StreamableHTTPClientTransport.prototype, 'finishAuth', async (value: unknown) => { httpArgs.push(value); });
  t.mock.method(SSEClientTransport.prototype, 'finishAuth', async (value: unknown) => { sseArgs.push(value); });
  const http = await connectMcp({ name: 'http', url: 'https://mcp.invalid', transport: 'http' });
  await http.finishAuth('code', 'https://issuer.invalid');
  const sse = await connectMcp({ name: 'sse', url: 'https://mcp.invalid', transport: 'sse' });
  await sse.finishAuth('legacy-code', 'https://issuer.invalid');
  assert.ok(httpArgs[0] instanceof URLSearchParams);
  assert.equal(httpArgs[0].get('code'), 'code');
  assert.equal(httpArgs[0].get('iss'), 'https://issuer.invalid');
  assert.deepEqual(sseArgs, ['legacy-code']);
});
