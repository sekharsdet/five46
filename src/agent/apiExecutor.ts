import type { ApiAction, SafetyMode } from './apiTypes'
import { isHostAllowed } from './apiTypes'
import { evaluateJsonPath, jsonValueToString } from './jsonPath'
import type { JsonValue } from './jsonPath'

const REQUEST_TIMEOUT_MS = 5000
const MAX_REDIRECTS = 5
/** Response bodies are fed into the next LLM prompt (so the model can
 * decide what to do next) — capped and disclosed for the same two reasons
 * `PageOutline.truncated` already caps a page's element list: bounding
 * token cost, and bounding accidental exposure of a large response, which
 * (per this feature's own safety disclosure) may itself contain a live
 * secret such as a session token. */
const RESPONSE_EXCERPT_LIMIT = 500

const VAR_PATTERN = /\{\{(\w+)\}\}/g

/** Substitutes `{{name}}` references for real values in a plain string,
 * returning a new string — never mutates anything. Mirrors
 * `browser.ts`'s `substitutePlaceholders` exactly, for the identical
 * reason: the caller must only ever use the *return value* for the real
 * network call, never for anything recorded into history/steps or fed back
 * into a future prompt — those must keep referencing the original,
 * unresolved `{{name}}` text, or a chained value from *this* run gets
 * frozen into the generated spec and the next prompt instead of staying a
 * live, symbolic reference. An unrecognized name is left as the literal
 * `{{name}}` text (never silently dropped) — `apiPlanner.ts`'s
 * `parseApiAction` is responsible for rejecting an action referencing an
 * unknown var *before* it ever reaches here, so this is a defensive
 * fallback, not the primary validation. */
export function resolvePlaceholders(value: string, vars: ReadonlyMap<string, string>): string {
  return value.replace(VAR_PATTERN, (whole, name: string) => (vars.has(name) ? vars.get(name)! : whole))
}

/** Every `{{name}}` reference actually present in a string, for
 * `apiPlanner.ts` to validate against the run's cumulative `validVarNames`
 * before accepting an action. */
export function extractPlaceholderNames(value: string): string[] {
  return [...value.matchAll(VAR_PATTERN)].map((m) => m[1])
}

/** Minimal, per-origin cookie jar — native `fetch` doesn't persist
 * `Set-Cookie` across calls the way Playwright's `APIRequestContext`
 * (deliberately not used here, see DEVELOPMENT.md) does automatically.
 * Scoped per-origin so a cookie set by one allowlisted host is never sent
 * to a different one. Uses `Headers.getSetCookie()` when available
 * (correctly handles multiple `Set-Cookie` headers on one response —
 * confirmed available on this project's real Node/undici `fetch`), falling
 * back to the single-header form on older runtimes. */
export class CookieJar {
  private readonly byOrigin = new Map<string, Map<string, string>>()

  applyResponse(origin: string, response: Response): void {
    const headersWithGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] }
    const raw =
      typeof headersWithGetSetCookie.getSetCookie === 'function'
        ? headersWithGetSetCookie.getSetCookie()
        : response.headers.get('set-cookie')
          ? [response.headers.get('set-cookie')!]
          : []
    if (raw.length === 0) return
    const jar = this.byOrigin.get(origin) ?? new Map<string, string>()
    for (const cookieString of raw) {
      const pair = cookieString.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    this.byOrigin.set(origin, jar)
  }

  cookieHeaderFor(origin: string): string | undefined {
    const jar = this.byOrigin.get(origin)
    if (!jar || jar.size === 0) return undefined
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /** Seeds this jar from a `five46 login`-captured Playwright
   * `storageState` — "log in once via UI, reuse the session for API
   * testing too" (`five46 api --storage-state <path>`), a real,
   * low-effort integration between the two features rather than making API
   * testing re-implement its own login flow. Only cookies whose `domain`
   * actually matches `targetOrigin`'s hostname (or is one of its parent
   * domains, per the cookie spec's own leading-dot convention — Playwright's
   * own docs: "prefix domain with a dot" to apply to subdomains) are
   * applied — a storage state can legitimately contain cookies for other
   * origins entirely, which must not leak into a request against this
   * target. */
  seedFromStorageState(cookies: readonly { name: string; value: string; domain: string }[], targetOrigin: string): void {
    let targetHostname: string
    try {
      targetHostname = new URL(targetOrigin).hostname
    } catch {
      return
    }
    const jar = this.byOrigin.get(targetOrigin) ?? new Map<string, string>()
    for (const cookie of cookies) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
      const matches = targetHostname === domain || targetHostname.endsWith(`.${domain}`)
      if (matches) jar.set(cookie.name, cookie.value)
    }
    if (jar.size > 0) this.byOrigin.set(targetOrigin, jar)
  }
}

function excerpt(text: string): { text: string; truncated: boolean } {
  if (text.length <= RESPONSE_EXCERPT_LIMIT) return { text, truncated: false }
  return { text: text.slice(0, RESPONSE_EXCERPT_LIMIT), truncated: true }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Walks redirects manually (`redirect: 'manual'`) rather than letting
 * `fetch` auto-follow them, and re-checks `isHostAllowed` on *every hop's
 * target*, not just the initial request URL. Native `fetch`'s default
 * `redirect: 'follow'` would silently defeat the same-origin/allowlist
 * safety check otherwise: a same-origin request can 302 to a different
 * host, and a check on the request URL alone would never see it — covered
 * by a dedicated regression test against a real server that actually does
 * this.
 * A 307/308 preserves the original method and body; anything else (301,
 * 302, 303) follows as a plain GET, matching standard browser/fetch
 * redirect semantics. */
async function fetchFollowingRedirects(
  url: string,
  init: RequestInit,
  safety: SafetyMode,
  authHeaderKeys: ReadonlySet<string>
): Promise<{ ok: true; response: Response } | { ok: false; failureDetail: string }> {
  let currentUrl = url
  let currentInit = init
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isHostAllowed(currentUrl, safety)) {
      return { ok: false, failureDetail: `blocked: "${currentUrl}" is not the target origin or an allowlisted host (--allow-host)` }
    }
    // authHeaders are scoped to the target origin only (see executeRequest)
    // — but a redirect can hop to a different allowlisted host mid-flight,
    // so the same scoping has to be re-applied on every hop, not just the
    // first request, the same reason isHostAllowed itself is rechecked here
    // rather than just once up front.
    let hopHeaders = currentInit.headers as Record<string, string> | undefined
    let hopOrigin: string | undefined
    try {
      hopOrigin = new URL(currentUrl).origin
    } catch {
      hopOrigin = undefined
    }
    if (hopHeaders && hopOrigin !== safety.targetOrigin && authHeaderKeys.size > 0) {
      hopHeaders = { ...hopHeaders }
      for (const key of authHeaderKeys) delete hopHeaders[key]
    }
    let response: Response
    try {
      response = await fetchWithTimeout(currentUrl, { ...currentInit, headers: hopHeaders, redirect: 'manual' })
    } catch (err) {
      // A network-level failure (timeout/abort, DNS failure, connection
      // refused, TLS error, ...) — never lets a single flaky request throw
      // out of the whole agent run and crash it; recorded as an honest
      // failed step instead, the same posture as a blocked host or a
      // failed assertion.
      const isAbort = err instanceof Error && err.name === 'AbortError'
      const detail = isAbort ? `request to "${currentUrl}" timed out after ${REQUEST_TIMEOUT_MS}ms` : `request to "${currentUrl}" failed: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, failureDetail: detail }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { ok: true, response }
      currentUrl = new URL(location, currentUrl).toString()
      currentInit = response.status === 307 || response.status === 308 ? currentInit : { ...currentInit, method: 'GET', body: undefined }
      continue
    }
    return { ok: true, response }
  }
  return { ok: false, failureDetail: `too many redirects (>${MAX_REDIRECTS})` }
}

export interface LastResponse {
  status: number
  bodyText: string
  parsedJson?: JsonValue
}

export interface ExecuteApiActionResult {
  ok: boolean
  responseStatus?: number
  responseBodyExcerpt?: string
  responseBodyTruncated?: boolean
  failureDetail?: string
  /** Present only after a successful `request` — the caller (`apiRunner.ts`)
   * merges this into its own running "last response" state. */
  response?: LastResponse
  /** Present only when the executed `request` had a `saveAs` and the path
   * actually resolved to something. */
  savedVar?: { name: string; value: string }
}

export interface ApiExecutionContext {
  cookieJar: CookieJar
  authHeaders?: Record<string, string>
  safety: SafetyMode
  vars: ReadonlyMap<string, string>
}

async function executeRequest(
  action: Extract<ApiAction, { action: 'request' }>,
  context: ApiExecutionContext
): Promise<ExecuteApiActionResult> {
  const resolvedUrl = resolvePlaceholders(action.url, context.vars)

  let origin: string
  try {
    origin = new URL(resolvedUrl).origin
  } catch {
    return { ok: false, failureDetail: `"${resolvedUrl}" is not a valid URL` }
  }

  // authHeaders (e.g. a configured bearer token) are only ever attached
  // when this request's origin is the actual target origin — never to a
  // request against a secondary --allow-host, which may be a wholly
  // different service (an OAuth token endpoint, a CDN, ...) that this
  // run's target-origin credential was never meant to reach. Mirrors
  // CookieJar's own per-origin scoping just below.
  const resolvedHeaders: Record<string, string> = origin === context.safety.targetOrigin ? { ...context.authHeaders } : {}
  const authHeaderKeys = new Set(Object.keys(context.authHeaders ?? {}))
  for (const [key, value] of Object.entries(action.headers ?? {})) {
    resolvedHeaders[key] = resolvePlaceholders(value, context.vars)
  }
  const resolvedBody = action.body !== undefined ? resolvePlaceholders(action.body, context.vars) : undefined

  const cookieHeader = context.cookieJar.cookieHeaderFor(origin)
  if (cookieHeader) resolvedHeaders['Cookie'] = cookieHeader

  const redirectResult = await fetchFollowingRedirects(resolvedUrl, { method: action.method, headers: resolvedHeaders, body: resolvedBody }, context.safety, authHeaderKeys)
  if (!redirectResult.ok) return { ok: false, failureDetail: redirectResult.failureDetail }

  const response = redirectResult.response
  const finalOrigin = new URL(response.url || resolvedUrl).origin
  context.cookieJar.applyResponse(finalOrigin, response)

  const bodyText = await response.text().catch(() => '')
  let parsedJson: JsonValue | undefined
  try {
    parsedJson = bodyText ? (JSON.parse(bodyText) as JsonValue) : undefined
  } catch {
    parsedJson = undefined
  }
  const { text: excerptText, truncated } = excerpt(bodyText)

  let savedVar: { name: string; value: string } | undefined
  if (action.saveAs) {
    const extracted = evaluateJsonPath(parsedJson, action.saveAs.path)
    const asString = jsonValueToString(extracted)
    if (asString !== undefined) savedVar = { name: action.saveAs.name, value: asString }
  }

  return {
    ok: true,
    responseStatus: response.status,
    responseBodyExcerpt: excerptText,
    responseBodyTruncated: truncated,
    response: { status: response.status, bodyText, parsedJson },
    savedVar,
  }
}

/** Handles every `ApiAction` type, mirroring `browser.ts`'s `executeAction`
 * exactly in shape: the one place a real network call or a real assertion
 * comparison happens, given an already-parsed, already-validated action.
 * Assertions check against `lastResponse` — the most recently completed
 * `request`'s result, tracked by the caller (`apiRunner.ts`), the same way
 * a browser assertion checks the current page rather than something the
 * action itself re-fetches. */
export async function executeApiAction(
  action: ApiAction,
  context: ApiExecutionContext,
  lastResponse: LastResponse | undefined
): Promise<ExecuteApiActionResult> {
  if (action.action === 'done') return { ok: true }

  if (action.action === 'request') return executeRequest(action, context)

  if (action.action === 'assert_status') {
    if (!lastResponse) return { ok: false, failureDetail: 'no request has completed yet to check the status of' }
    return lastResponse.status === action.expected
      ? { ok: true }
      : { ok: false, failureDetail: `expected status ${action.expected}, got ${lastResponse.status}` }
  }

  if (action.action === 'assert_json_path_exists') {
    if (!lastResponse) return { ok: false, failureDetail: 'no request has completed yet to check' }
    const value = evaluateJsonPath(lastResponse.parsedJson, action.path)
    return value !== undefined ? { ok: true } : { ok: false, failureDetail: `"${action.path}" does not exist in the last response body` }
  }

  // assert_json_path_equals
  if (!lastResponse) return { ok: false, failureDetail: 'no request has completed yet to check' }
  const value = jsonValueToString(evaluateJsonPath(lastResponse.parsedJson, action.path))
  return value === action.expected
    ? { ok: true }
    : { ok: false, failureDetail: `expected "${action.path}" to equal "${action.expected}", got ${value === undefined ? '(missing)' : `"${value}"`}` }
}
