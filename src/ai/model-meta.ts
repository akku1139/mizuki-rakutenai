// SPDX-License-Identifier: AGPL-3.0-or-later

/// モデルの能力 (コンテキストウィンドウ) を、モデルカタログから引く。
/// ../teapot の `src/model-meta.ts` の移植 (使わない能力 (値段・modalities・effort) は落としてある)。
///
/// models.dev を正とする理由: 実際に使っているプロバイダのうち、能力を公開しているのは
/// OpenRouter だけだった。Command Code・Google・orcarouter の `/models` は id と名前と
/// `context_length` しか返さないので、`/models` を自前でパースする実装はプロバイダごとに
/// 増えて壊れやすい。models.dev は 233 プロバイダ (commandcode・opencode を含む) を
/// API ホストで引ける形で持っている。
///
/// ただし models.dev だけでは足りない。プロバイダが実際に配信しているモデルの一覧は
/// プロバイダが正で、models.dev は遅れる/抜ける (実測: `reflection/beam:free` は
/// Command Code が配信しているのに models.dev の commandcode には無い)。
/// だから **一覧はプロバイダ優先、値はプロバイダ優先、models.dev は穴埋め** にする。

export interface ModelMeta {
  id: string;
  name?: string;
  /** コンテキストウィンドウ (トークン) */
  contextLength?: number;
}

/** models.dev の 1 レコードのうち、ここで使う分 */
type MdModel = {
  id?: string;
  name?: string;
  limit?: { context?: number };
};

type MdProvider = { id?: string; api?: string | null; models?: Record<string, MdModel> };

const DB_URL = 'https://models.dev/api.json';
/** DB 全体は約 6MB。変わるのは日単位なので 1 時間で十分 */
const TTL = 60 * 60_000;
/** 失敗を毎回やり直さない (エージェントごとに 8 秒待つ事故を防ぐ) */
const NEGATIVE_TTL = 5 * 60_000;

type Snapshot = { at: number; providers: Map<string, MdProvider>; negative?: boolean };
let db: Snapshot | undefined;
let inFlight: Promise<Snapshot> | undefined;

const hostOf = (baseUrl: string | undefined): string => {
  try {
    return new URL(String(baseUrl ?? '')).host.toLowerCase();
  } catch {
    return '';
  }
};

const pathOf = (baseUrl: string | undefined): string => {
  try {
    return new URL(String(baseUrl ?? '')).pathname;
  } catch {
    return '';
  }
};

const fresh = (s: Snapshot | undefined): s is Snapshot =>
  !!s && Date.now() - s.at < (s.negative === true ? NEGATIVE_TTL : TTL);

/** OpenRouter 系にはレート制限の扱いが変わるヘッダーを付ける */
const providerHeaders = (baseUrl: string): Record<string, string> => {
  try {
    const host = new URL(baseUrl).host;
    if (/(^|\.)openrouter\.ai$/i.test(host)) {
      return {
        'HTTP-Referer': 'https://github.com/akku1139/mizuki-rakutenai',
        'X-OpenRouter-Title': 'mizuki-rakutenai',
        'X-OpenRouter-Categories': 'general-chat',
      };
    }
  } catch { /* ホストが読めないときは何も付けない */ }
  return {};
};

/**
 * baseUrl に対応する models.dev のプロバイダを探す。
 *
 * ホストで引き、パスの食い違いだけをタイブレークに使う。ホスト一致だけだと、
 * 同じホストを複数のカタログに分けているプロバイダ (opencode / opencode-go など) で
 * 取り違える。パスが全く違うときはモデル数が多い (= 一般の) カタログを採る。
 */
export const providerFor = (providers: Map<string, MdProvider>, baseUrl: string | undefined): MdProvider | undefined => {
  const host = hostOf(baseUrl);
  if (!host) return undefined;
  const sameHost = [...providers.values()].filter(p => hostOf(p.api ?? undefined) === host);
  if (sameHost.length <= 1) return sameHost[0];
  const path = pathOf(baseUrl);
  const scored = sameHost
    .map(p => {
      const apiPath = pathOf(p.api ?? undefined);
      let common = 0;
      for (let i = 0; i < Math.min(apiPath.length, path.length) && apiPath[i] === path[i]; i++) common++;
      return { p, common, models: Object.keys(p.models ?? {}).length };
    })
    .sort((a, b) => b.common - a.common || b.models - a.models);
  return scored[0]?.p ?? sameHost[0];
};

const loadDb = async (): Promise<Snapshot> => {
  if (fresh(db)) return db;
  if (inFlight !== undefined) return inFlight;
  const p = (async (): Promise<Snapshot> => {
    try {
      const res = await fetch(DB_URL, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Record<string, MdProvider>;
      const providers = new Map<string, MdProvider>();
      for (const [key, value] of Object.entries(json)) {
        if (value !== null && typeof value === 'object') providers.set(key, value);
      }
      const snapshot: Snapshot = { at: Date.now(), providers };
      db = snapshot;
      return snapshot;
    } catch {
      // 失敗を短く記憶する。空のマップは「分からない」であって「非対応」ではない
      const snapshot: Snapshot = { at: Date.now(), providers: new Map(), negative: true };
      db = snapshot;
      return snapshot;
    }
  })();
  inFlight = p;
  try {
    return await p;
  } finally {
    inFlight = undefined;
  }
};

/** models.dev の 1 レコード → こちらの形。無い項目は作らない */
export const metaFrom = (m: MdModel): ModelMeta => ({
  id: String(m.id ?? ''),
  ...(typeof m.name === 'string' ? { name: m.name } : {}),
  ...(typeof m.limit?.context === 'number' ? { contextLength: m.limit.context } : {}),
});

/** プロバイダ自身の `/models`。使える形で返らなければ null */
const fetchProviderModels = async (baseUrl: string, apiKey?: string): Promise<ModelMeta[] | null> => {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  const res = await fetch(url, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...providerHeaders(baseUrl) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown }> };
  const out: ModelMeta[] = [];
  for (const m of json.data ?? []) {
    if (typeof m.id !== 'string' || m.id === '') continue;
    out.push({
      id: m.id,
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(typeof m.context_length === 'number' ? { contextLength: m.context_length } : {}),
    });
  }
  return out.length > 0 ? out : null;
};

/** プロバイダの値が勝ち、models.dev は穴だけ埋める */
const mergeMeta = (own: ModelMeta, fromDb: ModelMeta | undefined): ModelMeta => {
  if (fromDb === undefined) return own;
  const contextLength = own.contextLength ?? fromDb.contextLength;
  const name = own.name ?? fromDb.name;
  return {
    id: own.id,
    ...(name !== undefined ? { name } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
  };
};

/** プロバイダのモデル一覧 (無ければ models.dev の一覧) */
export const fetchModelList = async (baseUrl: string, apiKey?: string): Promise<ModelMeta[]> => {
  const [snapshot, upstream] = await Promise.all([
    loadDb(),
    fetchProviderModels(baseUrl, apiKey).catch(() => null),
  ]);
  const provider = providerFor(snapshot.providers, baseUrl);
  const dbModels = provider?.models !== undefined
    ? Object.values(provider.models).map(metaFrom).filter(m => m.id !== '')
    : [];
  if (upstream === null) return dbModels;
  const byId = new Map(dbModels.map(m => [m.id, m]));
  return upstream.map(m => mergeMeta(m, byId.get(m.id)));
};

/**
 * プロバイダの `/models` は 1 セッションにつき 1 回は必ず引くので、同じ baseUrl の結果を
 * 10 分だけ使い回す (セッションが増えても外部へのリクエストは増やさない)。
 */
const LISTS_TTL = 10 * 60_000;
const lists = new Map<string, { at: number; value: Promise<ModelMeta[]> }>();

export const fetchModelListCached = (baseUrl: string, apiKey?: string): Promise<ModelMeta[]> => {
  const key = `${baseUrl}\u0000${apiKey ?? ''}`;
  const hit = lists.get(key);
  if (hit !== undefined && Date.now() - hit.at < LISTS_TTL) return hit.value;
  const value = fetchModelList(baseUrl, apiKey);
  lists.set(key, { at: Date.now(), value });
  // 失敗を握り続けない (次の呼び出しでやり直す)
  void value.catch(() => { lists.delete(key); });
  return value;
};

/** テスト用: キャッシュ (models.dev の DB・モデル一覧) を捨てる */
export const resetModelMetaCache = (): void => {
  db = undefined;
  inFlight = undefined;
  lists.clear();
};

/** モデルのコンテキストウィンドウ。カタログに無ければ undefined */
export const contextLengthFor = (list: ModelMeta[], model: string): number | undefined =>
  list.find(m => m.id === model)?.contextLength;
