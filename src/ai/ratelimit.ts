// SPDX-License-Identifier: AGPL-3.0-or-later

const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;

interface RetryDependencies {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
}

/** Retry-After supports seconds (including fractions) and HTTP dates. */
export const retryAfterMs = (value: string | null, now: number): number | undefined => {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
};

/** 再試行する価値のある状態か (上流の一時障害)。4xx のうち 408/425 以外は恒久的として扱う */
export const isRetryableStatus = (status: number): boolean =>
  status === 429 || status === 408 || status === 425 || (status >= 500 && status <= 599);

/**
 * 400 でも再試行する価値があるもの。
 * ゲートウェイが「このモデルのプロンプトに変換できない」を返すことがあり、
 * ルーティング先が変わると同じ本文で通ることがある (fallbacksAvailable がある実装)。
 * 本文が別の理由 (パラメータ不正など) の 400 は再試行しない。
 */
const isRenderableFailure = (body: string): boolean => /could not be rendered into a prompt/i.test(body);

/** 状態ごとの待ち時間。429 は Retry-After を優先し、それ以外は短く (失敗を長引かせない) */
const backoffMs = (attempt: number, random: () => number): number =>
  Math.min(MAX_WAIT_MS, 250 * 2 ** attempt + Math.floor(random() * 250));

const rateLimitBackoffMs = (attempt: number, random: () => number): number =>
  Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt + Math.floor(random() * 1000));

/**
 * 失敗したリクエストを再試行する。
 *
 * - 429: `Retry-After` に従う (無ければ 1/2/4 秒 + ジッタ)。60 秒を超える要求は諦める
 * - 5xx / 408 / 425 / 接続断: 上流が一時的に落ちていることがあるので短いバックオフで再試行する
 * - 400/401/403/404 など: 何度送っても同じなので再試行しない
 * - 残高不足・クォータは待っても解決しないので再試行しない
 *
 * 成功したレスポンスのストリームや、実行済みのツールはやり直さない。
 */
export const fetchWithRetry = async (
  request: () => Promise<Response>,
  dependencies: Partial<RetryDependencies> = {},
): Promise<Response> => {
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request();
    } catch (err) {
      // 接続断・タイムアウト (上流が落ちている) は再試行する
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt, random));
      continue;
    }
    if (response.status === 400) {
      const body = await response.clone().text().catch(() => '');
      // 描画失敗は 1 回だけ。他の 400 は何度送っても同じ
      if (!isRenderableFailure(body) || attempt >= 1) return response;
      await response.body?.cancel();
      await sleep(backoffMs(attempt, random));
      continue;
    }
    if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) return response;

    // 残高不足・クォータは待っても解決しない。本体は呼び出し側が読めるよう clone で調べる
    if (response.status === 429) {
      let code: unknown;
      let type: unknown;
      try {
        const body = await response.clone().json() as { error?: { code?: unknown; type?: unknown } };
        code = body.error?.code;
        type = body.error?.type;
      } catch { /* 互換サーバーは平文のエラーを返すことがある */ }
      const permanent = ['insufficient_quota', 'billing_hard_limit_reached'];
      if (permanent.includes(String(code)) || permanent.includes(String(type))) return response;
    }

    const delay = response.status === 429
      ? (retryAfterMs(response.headers.get('retry-after'), now()) ?? rateLimitBackoffMs(attempt, random))
      : backoffMs(attempt, random);
    // サーバーが要求した待ち時間を勝手に縮めない
    if (delay > MAX_WAIT_MS) return response;
    await response.body?.cancel();
    await sleep(delay);
  }
};

/** 旧名 (互換のため残す)。429 だけだった頃の呼び出し元とテストが使う */
export const fetchWithRateLimitRetry = fetchWithRetry;
