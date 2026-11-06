// SPDX-License-Identifier: AGPL-3.0-or-later

/// 同期とAI返信で共用する、再起動で消えるメッセージ対応キャッシュ。

export const MESSAGE_CACHE_LIMIT = 5000;

export const cacheMessage = <T>(cache: Map<string, T>, id: string, value: T): void => {
  cache.set(id, value);
  if (cache.size > MESSAGE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
};
