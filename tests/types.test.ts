// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('本体・テスト・生成コードに明示的な型チェックの抜け道を増やさない', () => {
  const roots = ['src', 'tests', 'mexc-proto'];
  const files = ['index.ts', 'mexc.ts', 'emojisync.ts'];
  for (const root of roots) for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.join(entry.parentPath, entry.name));
  }
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bas\s+any\b|[:=<,]\s*any\b|@\x74s-(?:ignore|nocheck)/, file);
  }
});
