import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The maps are read from ./data when the module loads, so prepare a scratch working directory first
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mizuki-fluxsync-'));
process.chdir(dir);
await fs.mkdir('data');
const link = { whID: 'w1', whToken: 't1', targetChannelID: 'd1' };
await fs.writeFile('data/fluxersync_fluxer.json', JSON.stringify({ f1: link }));
// fluxersync_discord.json is missing, as on the first start
const { saveWhMap, whMapDiscord, whMapFluxer } = await import('../src/fluxsync/state.ts');

test.after(() => fs.rm(dir, { recursive: true, force: true }));

test('existing links are loaded and a missing file starts empty', () => {
  assert.deepEqual(whMapFluxer, { f1: link });
  assert.deepEqual(whMapDiscord, {});
});

test('saveWhMap writes both maps', async () => {
  whMapDiscord['d1'] = { whID: 'w2', whToken: 't2', targetChannelID: 'f1' };
  await saveWhMap();
  assert.deepEqual(JSON.parse(await fs.readFile('data/fluxersync_fluxer.json', 'utf8')), { f1: link });
  assert.deepEqual(JSON.parse(await fs.readFile('data/fluxersync_discord.json', 'utf8')), whMapDiscord);
});
