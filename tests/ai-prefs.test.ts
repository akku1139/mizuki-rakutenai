import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isProviderName, PROVIDERS } from '../src/ai/types.ts';

// The settings file is relative to the working directory, so work in a scratch one
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mizuki-prefs-'));
process.chdir(dir);
const { getUserProvider, loadPrefs, setUserProvider } = await import('../src/ai/prefs.ts');

test.after(() => fs.rm(dir, { recursive: true, force: true }));

test('isProviderName accepts only the known providers', () => {
  for (const p of PROVIDERS) assert.equal(isProviderName(p), true);
  assert.equal(isProviderName('gemini'), false);
  assert.equal(isProviderName(''), false);
});

test('a missing or broken settings file starts with no preferences', async () => {
  await loadPrefs();
  assert.equal(getUserProvider('u1'), undefined);
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/ai_prefs.json', '{broken');
  await loadPrefs();
  assert.equal(getUserProvider('u1'), undefined);
});

test('a preference is saved to data/ai_prefs.json', async () => {
  await fs.rm('data', { recursive: true, force: true });
  await setUserProvider('u1', 'openai');
  assert.equal(getUserProvider('u1'), 'openai');
  assert.deepEqual(JSON.parse(await fs.readFile('data/ai_prefs.json', 'utf8')), { u1: 'openai' });
});

test('loading skips unknown providers and values that are not strings', async () => {
  await fs.writeFile('data/ai_prefs.json', JSON.stringify({ u2: 'rakutenai', u3: 'gemini', u4: 1 }));
  await loadPrefs();
  assert.equal(getUserProvider('u2'), 'rakutenai');
  assert.equal(getUserProvider('u3'), undefined);
  assert.equal(getUserProvider('u4'), undefined);
});
