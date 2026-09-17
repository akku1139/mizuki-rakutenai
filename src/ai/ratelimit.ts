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

/** Retries only rejected HTTP requests, never a successful response's stream or tools. */
export const fetchWithRateLimitRetry = async (
  request: () => Promise<Response>,
  dependencies: Partial<RetryDependencies> = {},
): Promise<Response> => {
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    const response = await request();
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response;

    // Quota/billing failures cannot be resolved by waiting. Inspect a clone so
    // the caller can still read the original response on terminal errors.
    let code: unknown;
    let type: unknown;
    try {
      const body = await response.clone().json() as { error?: { code?: unknown; type?: unknown } };
      code = body.error?.code;
      type = body.error?.type;
    } catch { /* Compatible servers may send a plain-text error. */ }
    const permanent = ['insufficient_quota', 'billing_hard_limit_reached'];
    if (permanent.includes(String(code)) || permanent.includes(String(type))) return response;

    const delay = retryAfterMs(response.headers.get('retry-after'), now())
      ?? Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt + Math.floor(random() * 1000));
    // Do not shorten a server-requested cooldown just to fit our wait budget.
    if (delay > MAX_WAIT_MS) return response;
    await response.body?.cancel();
    await sleep(delay);
  }
};
