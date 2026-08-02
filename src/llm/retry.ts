import type { LlmProvider } from './types'
import { LlmHttpError } from './httpError'

export interface RetryOptions {
  /** Default 4 — the first attempt plus 3 real retries. Raised from an
   * original default of 3 after live testing against
   * automationintesting.online: with each attempt now individually bounded
   * by `fetchWithTimeout`'s 30s cap (see that file's own doc comment), 3
   * consecutive attempts landing on Gemini's rare 30s+ tail-latency outliers
   * back-to-back is unlikely but real — observed live, once, in the same
   * session this cap was added. Real per-call latency samples from that
   * same run (post-fix, uninstrumented) were 3-8s, so a 4th attempt costs
   * little in the common case while meaningfully improving the odds of
   * surviving a bad streak instead of failing the whole run outright. */
  maxAttempts?: number
  /** Default 1000ms. */
  baseDelayMs?: number
  /** Default 8000ms — dead at the default `maxAttempts` of 4 (three waits
   * ever happen: 1s, 2s, 4s), only relevant if a caller raises `maxAttempts`
   * past 5. Kept as a real cap rather than removed, since a future caller
   * (MCP progress-streaming, say) may reasonably want more attempts without
   * an unbounded wait between them. */
  maxDelayMs?: number
  /** Fired once per retry, right before the wait — never fired on the
   * final, non-retried failure (there's nothing to wait for at that
   * point). Left `undefined` by MCP's own call sites so retries stay
   * silent there (MCP's stdout is the literal JSON-RPC transport; nothing
   * about this callback may ever touch it). `cli.ts` passes one that
   * prints, mirroring the existing `onWrite`/`onDestructiveClick`
   * disclosure precedent — the engine layer here stays I/O-free, same as
   * everywhere else in this codebase. */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void
  /** Injectable purely for tests — never real wall-clock waiting in the
   * suite. Defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const RETRYABLE_AWS_EXCEPTION_NAMES = new Set(['ThrottlingException', 'ServiceUnavailableException', 'ModelTimeoutException', 'TooManyRequestsException'])
const RETRYABLE_NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'])

/** Classifies an error thrown by `LlmProvider.complete()` as transient
 * (worth retrying) or not. Deliberately conservative: anything not
 * positively recognized as one of the three shapes below is treated as
 * NOT retryable — never burn a retry attempt on a genuinely non-transient
 * failure (a bad API key, a malformed request, an unknown-shaped error)
 * just because it happened to be uncertain.
 *
 * Three recognized shapes, found by reasoning through what each of this
 * project's 5 real providers can actually throw, not guessed in the
 * abstract:
 * 1. `LlmHttpError` (the 4 fetch-based providers) — 429 or any 5xx.
 * 2. An AWS-SDK-shaped error (Bedrock) — `$metadata.httpStatusCode` in
 *    that same range, or a recognized throttling/service exception name.
 * 3. A real network-level failure — `fetch` itself rejects with a plain
 *    error (never reaching `!response.ok`, so it can never become an
 *    `LlmHttpError`) on a connection reset/timeout/refusal/DNS failure, or
 *    an aborted request. This is arguably the single most common real
 *    transient failure a local BYOK CLI user hits day-to-day (a flaky
 *    wifi connection), and was a real, concrete gap in an earlier draft
 *    of this classifier that only considered HTTP-shaped errors.
 *
 * Deliberately NOT attempted: distinguishing a genuinely transient 429
 * (a per-minute rate limit that will clear) from a permanently-broken one
 * (Gemini's own real, previously-documented "zero free-tier quota" case;
 * Groq's own real per-day token cap, hit live during this project's own
 * testing) — both present as an ordinary 429 with no reliable structured
 * signal to tell them apart short of fragile, provider-specific parsing
 * of the error message text. A permanently-broken 429 will still pay the
 * full retry cost (a few seconds) every time it's hit — an accepted,
 * disclosed cost, not a silent false promise that retrying will help. */
export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof LlmHttpError) {
    return err.status === 429 || err.status >= 500
  }
  if (err && typeof err === 'object') {
    const httpStatusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (typeof httpStatusCode === 'number' && (httpStatusCode === 429 || httpStatusCode >= 500)) return true
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string' && RETRYABLE_AWS_EXCEPTION_NAMES.has(name)) return true
    // 'AbortError': a manually-aborted fetch. 'TimeoutError': what a fetch
    // actually rejects with when aborted by `AbortSignal.timeout()`
    // specifically (per WHATWG spec, not the generic abort name), and also
    // what @smithy/node-http-handler's own requestTimeout throws (Bedrock) —
    // both are the timeout added in fetchWithTimeout.ts/bedrock.ts, and both
    // must be retried the same way a slow-but-erroring request would be.
    if (name === 'AbortError' || name === 'TimeoutError') return true
    const code = (err as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string' && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return true
  }
  return false
}

/** Wraps an `LlmProvider` so a transient failure (see
 * `isRetryableLlmError`) gets retried with exponential backoff instead of
 * immediately killing whatever's calling it — found necessary via real,
 * live testing that hit both a per-minute and a per-day 429 from Groq in
 * the same session, each of which previously ended the entire run
 * outright with zero retry. Same `id`, so nothing that keys off
 * `provider.id` (a printed banner, say) can tell the difference. */
export function withRetry(provider: LlmProvider, options?: RetryOptions): LlmProvider {
  const maxAttempts = options?.maxAttempts ?? 4
  const baseDelayMs = options?.baseDelayMs ?? 1000
  const maxDelayMs = options?.maxDelayMs ?? 8000
  const sleep = options?.sleep ?? defaultSleep

  return {
    id: provider.id,
    async complete(prompt, apiKey) {
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await provider.complete(prompt, apiKey)
        } catch (err) {
          lastError = err
          if (attempt === maxAttempts || !isRetryableLlmError(err)) throw err
          const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
          options?.onRetry?.({ attempt, maxAttempts, delayMs, error: err })
          await sleep(delayMs)
        }
      }
      // Unreachable — the loop above always either returns or throws before
      // falling off the end (the final iteration's `attempt === maxAttempts`
      // branch always throws). Satisfies TypeScript's control-flow analysis.
      throw lastError
    },
  }
}
