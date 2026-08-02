import type { RunOutcome } from './types'

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** What one `five46 api` run is allowed to do — read-only by default
 * (the user's explicit choice, given an agent with HTTP method freedom has
 * no natural blast-radius ceiling the way a browser click does), with
 * independent opt-ins for writes vs. deletes: POST/PUT/PATCH are
 * recoverable (re-create, re-update), DELETE often isn't, especially
 * against a real dev/staging DB with no soft-delete — HTTP's own
 * safe/idempotent/unsafe taxonomy, not one coarse switch. `allowedHosts` is
 * an explicit allowlist, not a same-origin kill switch — an OAuth token
 * endpoint on a second host can be named without opening the agent to
 * arbitrary hosts. */
export interface SafetyMode {
  allowWrites: boolean
  allowDeletes: boolean
  targetOrigin: string
  allowedHosts: ReadonlySet<string>
}

/** Co-located with `SafetyMode` (not duplicated in both `apiPlanner.ts` and
 * `apiExecutor.ts`, which both need it — parse-time rejection and
 * per-redirect-hop rechecking respectively) so the two checks can't drift
 * out of sync with each other. */
export function isMethodAllowed(method: HttpMethod, safety: SafetyMode): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  if (method === 'DELETE') return safety.allowDeletes
  return safety.allowWrites // POST, PUT, PATCH
}

/** Exported so `apiPlanner.ts` (which already needed an identical set for
 * its own "is this a recognized method at all" validation) has one source
 * of truth to import instead of a second, independently-drifting copy. */
export const VALID_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** Header names, checked case-insensitively (real HTTP header names are),
 * that real server frameworks commonly honor to execute a *different*
 * method than the one an HTTP client literally declares — Google's own
 * documented convention, IBM's, and what many Rails (`Rack::MethodOverride`)
 * and Express/Laravel setups accept out of the box. */
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override'])

/** Returns the method a real server could actually execute for this
 * request — not just the one declared in `method` — by checking known
 * method-override conventions (a header above, or Rails/Laravel/Sinatra's
 * long-standing `?_method=` query-parameter equivalent for form-friendly
 * clients that can't natively send DELETE/PUT). Found via a real, live
 * run: a model blocked from DELETE (no `--allow-deletes`) sent `POST` with
 * `X-HTTP-Method-Override: DELETE` instead. Confirmed empirically against
 * that specific real target that the attempt was a no-op (it doesn't honor
 * the header) — but `isMethodAllowed(method, safety)` alone only ever
 * inspects the literally-declared method, so against any real target that
 * *does* honor one of these conventions, that exact same request would
 * have genuinely bypassed `--allow-deletes` while five46's own gate
 * believed it was only permitting a plain, already-allowed POST. Both call
 * sites that gate a `request` action (`apiPlanner.ts`'s parse-time check,
 * `apiRunner.ts`'s fast-path re-check) must check this, not just `method`
 * — the same "no single point of failure" posture already applied to
 * `isMethodAllowed`/`isHostAllowed` themselves. */
export function effectiveMethod(method: HttpMethod, url: string, headers?: Record<string, string>): HttpMethod {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (!METHOD_OVERRIDE_HEADERS.has(key.toLowerCase())) continue
      const upper = value.trim().toUpperCase()
      if (VALID_METHODS.has(upper as HttpMethod)) return upper as HttpMethod
    }
  }
  try {
    const overrideParam = new URL(url).searchParams.get('_method')
    if (overrideParam) {
      const upper = overrideParam.trim().toUpperCase()
      if (VALID_METHODS.has(upper as HttpMethod)) return upper as HttpMethod
    }
  } catch {
    // A malformed URL is already handled by isHostAllowed's own identical
    // fail-closed catch — nothing extra to do here.
  }
  return method
}

/** True if `url`'s origin is the target's own origin, or its hostname is on
 * the explicit allowlist. Never throws on a malformed URL — treated as not
 * allowed, the same honest-fail-closed posture as everything else here. */
export function isHostAllowed(url: string, safety: SafetyMode): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.origin === safety.targetOrigin || safety.allowedHosts.has(parsed.hostname)
}

/** One action the agent can take against an API. Deliberately a small,
 * closed set — never arbitrary code — mirroring `AgentAction`'s browser
 * counterpart exactly in spirit: `request` is the only side-effecting
 * action, `assert_status`/`assert_json_path_exists`/`assert_json_path_equals`
 * only ever check the *last* response, `done` ends the run. `saveAs`
 * extracts one scalar value (via `jsonPath.ts`) from the response into a
 * named variable later steps can reference as `{{name}}` in `url`/
 * `headers`/`body` — resolved by `apiExecutor.ts`'s `resolvePlaceholders`
 * on a local copy only, exactly like `browser.ts`'s `substitutePlaceholders`
 * for credentials; this action object itself is never mutated with a
 * resolved value. */
export type ApiAction =
  | {
      action: 'request'
      method: HttpMethod
      url: string
      headers?: Record<string, string>
      body?: string
      saveAs?: { name: string; path: string }
      reason: string
    }
  | { action: 'assert_status'; expected: number; reason: string }
  | { action: 'assert_json_path_exists'; path: string; reason: string }
  | { action: 'assert_json_path_equals'; path: string; expected: string; reason: string }
  | { action: 'done'; outcome: 'goal-reached' | 'goal-unreachable'; reason: string }

export interface ApiHistoryEntry {
  action: ApiAction
  result: 'ok' | 'failed'
  detail: string
}

/** One step as actually executed. `action` is always the original,
 * unresolved action (any `{{var}}` references intact) — never mutated with
 * a resolved value, for the same reason `ExecutedStep.action` never is:
 * `generateApiSpec.ts` needs the symbolic reference to re-derive the chain
 * as real code, not a frozen, stale literal from this one run. */
export interface ExecutedApiStep {
  step: number
  action: ApiAction
  ok: boolean
  /** Present for a `request` action that completed — even a 404 is a
   * normal completed response, not an execution failure. Absent for
   * assertion actions and for a request that never completed (network
   * error, timeout, blocked by `SafetyMode`). */
  responseStatus?: number
  /** A capped, disclosed excerpt of the response body actually fed into
   * the next prompt — never the full body. Mirrors `PageOutline.truncated`'s
   * cap-and-disclose shape, for the same two reasons: bounding token cost,
   * and bounding accidental exposure of a large response (which, per the
   * design's own safety disclosure, may itself contain a live secret). */
  responseBodyExcerpt?: string
  failureDetail?: string
}

/** An upfront plan is just `ApiAction[]` — unlike the browser engine's
 * `PlannedStep` (which needs a `target` prediction in place of a `ref`,
 * since a DOM element can't be referenced before its page has even
 * loaded), an API `request`'s `url`/`method` has no structural-matching
 * ambiguity at all: a planned request is already the exact same shape as a
 * live one, `{{var}}` placeholders and all. Genuinely simpler here than
 * the browser engine, not just described that way. */
export interface ApiPlan {
  steps: ApiAction[]
}

export interface ApiTestRun {
  runId: string
  baseUrl: string
  goal: string
  steps: ExecutedApiStep[]
  outcome: RunOutcome
  unparseableResponse?: string
  /** Same meaning as `TestRun.providerError` — see its own doc comment and
   * `RunOutcome`'s. */
  providerError?: string
  /** Same shape/meaning as `TestRun.planStats` — see its own doc comment. */
  planStats?: { plannedSteps: number; fastPathedSteps: number }
}
