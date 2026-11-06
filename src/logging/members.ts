// SPDX-License-Identifier: AGPL-3.0-or-later

/** 参加から5分以内の退出を即抜けとして記録する。 */
export const quickLeaveNote = (joinedAt: number | null, now = Date.now()): string => {
  if (joinedAt === null || now < joinedAt || now - joinedAt > 5 * 60_000) return '';
  return ` (即抜け: 参加から${Math.floor((now - joinedAt) / 1000)}秒)`;
};
