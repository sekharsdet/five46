/** Every fetch-based LLM provider used to call bare `fetch()` with no
 * timeout — confirmed via live, instrumented testing to let a single slow
 * upstream response (Gemini's free-tier endpoint, observed live taking
 * 120s+ against a ~5s baseline for the same prompt shape on the same run)
 * block an entire agent run with zero recourse: no retry, no failure, just
 * a silent multi-minute stall. `AbortSignal.timeout()` bounds that: a
 * request that exceeds `timeoutMs` rejects with a `TimeoutError`-named
 * error, which `llm/retry.ts`'s classifier treats as retryable — so a
 * stuck request now fails fast and gets a fresh attempt instead of hanging
 * indefinitely. 30s default: comfortably above every real per-step call
 * observed in live testing (4-6s) while still bounding the worst case to a
 * few timeout-and-retry cycles rather than minutes. */
export const DEFAULT_LLM_TIMEOUT_MS = 30000

export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_LLM_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}
