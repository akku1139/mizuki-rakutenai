// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickLeaveNote } from '../src/logging/members.ts';

test('5分以内の退出だけに即抜けの経過秒数を付ける', () => {
  assert.equal(quickLeaveNote(1000, 31000), ' (即抜け: 参加から30秒)');
  assert.equal(quickLeaveNote(1000, 301000), ' (即抜け: 参加から300秒)');
  assert.equal(quickLeaveNote(1000, 301001), '');
  assert.equal(quickLeaveNote(null), '');
  assert.equal(quickLeaveNote(2000, 1000), '');
});
