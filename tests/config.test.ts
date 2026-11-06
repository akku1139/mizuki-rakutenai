// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('設定保存はdata作成を共通化し、並列書き込みでも最後の設定を残す', async () => {
  const original = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mizuki-config-'));
  process.chdir(dir);
  try {
    const { config, get, saveConfig } = await import('../src/config.ts');
    config.ai = { defaultProvider: 'rakutenai' };
    const a = saveConfig();
    config.ai.defaultProvider = 'openai';
    const b = saveConfig();
    await Promise.all([a, b]);
    const stored: unknown = JSON.parse(await fs.readFile('data/config.json', 'utf8'));
    assert.equal(get(stored, 'ai.defaultProvider', ''), 'openai');
    assert.equal(get(null, 'ai.model', 'fallback'), 'fallback');
    assert.equal(await fs.stat('data/config.json.tmp').then(() => true, () => false), false);
  } finally { process.chdir(original); await fs.rm(dir, { recursive: true, force: true }); }
});
