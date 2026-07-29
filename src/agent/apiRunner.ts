import type { LlmProvider } from '../llm/types'
import type { StorageState } from './browser'
import { CookieJar, executeApiAction, resolvePlaceholders } from './apiExecutor'
import type { LastResponse, ApiExecutionContext } from './apiExecutor'
import { buildApiActionPrompt, parseApiAction } from './apiPlanner'
import { requiresConfirmation } from './planner'
import type { ApiAction, ApiHistoryEntry, ApiTestRun, ExecutedApiStep, HttpMethod, SafetyMode } from './apiTypes'
import { DEFAULT_MAX_STEPS, HARD_MAX_STEPS, makeRunId } from './runLoop'

export interface RunApiTestOptions {
  baseUrl: string
  goal: string
  provider: LlmProvider
  apiKey: string
  /** Default 15, hard-capped at 50 — same posture as `runAgent`'s
   * `maxSteps`: one `request`/assertion action is one turn of this loop, so
   * the existing step cap already bounds the total request count without a
   * second counter. */
  maxSteps?: number
  safety: SafetyMode
  /** Attached to every outgoing request's headers, silently — never shown
   * to the LLM or referenced in a prompt at all, unlike UI login
   * credentials (which the agent has to locate/fill a field for). See
   * `credentials.ts`'s `resolveApiAuthHeaders`. */
  authHeaders?: Record<string, string>
  /** A previously captured `five46 login` session — seeds the cookie
   * jar with whatever cookies apply to `safety.targetOrigin`, so a session
   * captured via the UI can be reused for API testing without logging in
   * again. */
  storageState?: StorageState
  /** Invoked synchronously right before a real, allowed, non-safe-method
   * (`POST`/`PUT`/`PATCH`/`DELETE`) request executes — a `DELETE`'s blast
   * radius has no natural ceiling the way a browser click's does, so this
   * gives real-time visibility instead of only a place in the final report.
   * Kept as a callback (not a direct console call) so this orchestrator
   * stays free of I/O, matching `runAgent`'s own precedent of zero direct
   * console output. */
  onWrite?: (method: HttpMethod, url: string, reason: string) => void
}

const SAFE_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS'])

function actionSignature(action: ApiAction): string {
  switch (action.action) {
    case 'request':
      return `request:${action.method}:${action.url}:${action.body ?? ''}`
    case 'assert_status':
      return `assert_status:${action.expected}`
    case 'assert_json_path_exists':
      return `assert_json_path_exists:${action.path}`
    case 'assert_json_path_equals':
      return `assert_json_path_equals:${action.path}:${action.expected}`
    case 'done':
      return 'done'
  }
}

function describeResultDetail(action: ApiAction, result: { responseStatus?: number; responseBodyExcerpt?: string; responseBodyTruncated?: boolean; savedVar?: { name: string; value: string } }): string {
  if (action.action !== 'request' || result.responseStatus === undefined) return ''
  const parts = [`status ${result.responseStatus}`]
  if (result.savedVar) parts.push(`saved {{${result.savedVar.name}}}="${result.savedVar.value}"`)
  if (result.responseBodyExcerpt) parts.push(`body: ${result.responseBodyExcerpt}${result.responseBodyTruncated ? ' (truncated)' : ''}`)
  return parts.join(', ')
}

/** Orchestrates the API-testing agentic loop — the same single-shot,
 * one-action-per-turn shape as `runAgent`, extended to HTTP requests
 * instead of browser actions: repeatedly ask the LLM for the next action,
 * strictly parse it (rejecting a disallowed method/host/`{{var}}` reference
 * at the parse layer, same honest-failure posture as `parseAgentAction`),
 * execute it, and record the result, until `done`, a real assertion fails,
 * the same action repeats twice in a row, or the step cap is reached.
 *
 * A failed `request` does not end the run by itself — recorded in history,
 * loop continues, same as a failed `click`/`fill` — only an assertion
 * failure is the run's actual verdict about the API. `{{var}}` names saved
 * via `saveAs` accumulate across the *whole* run (unlike `validRefs`, which
 * is rebuilt fresh every turn for browser actions) — a value saved in step
 * 2 must still resolve in step 8. */
export async function runApiTest(options: RunApiTestOptions): Promise<ApiTestRun> {
  const runId = makeRunId()
  const maxSteps = Math.min(options.maxSteps ?? DEFAULT_MAX_STEPS, HARD_MAX_STEPS)
  const needsConfirmation = requiresConfirmation(options.goal)

  const cookieJar = new CookieJar()
  if (options.storageState) cookieJar.seedFromStorageState(options.storageState.cookies, options.safety.targetOrigin)

  const vars = new Map<string, string>()
  const history: ApiHistoryEntry[] = []
  const steps: ExecutedApiStep[] = []
  let lastResponse: LastResponse | undefined
  let lastSignature: string | undefined
  let repeatCount = 0
  // Mirrors runner.ts's identical fix, found via the same class of live
  // run: a goal legitimately requiring the same successful `request` many
  // times ("create 3 widgets") must not trip stuck-repeating just because
  // each attempt is identical. Narrower than the browser engine's version,
  // found while testing this exact fix: `result.ok` alone isn't "progress"
  // here the way it is for a click — a GET to the same URL always
  // completes as a normal HTTP exchange (even a 404 is `ok: true`, see
  // `apiExecutor.ts`) with zero side effect, so a repeated *read* must
  // still trip the guard. Only a repeated *write* (POST/PUT/PATCH/DELETE)
  // with a real (< 400) response status counts as progress — a repeated
  // failing request, a repeated safe/read method, or a repeated
  // assertion/`done`, all still trip it exactly as before.
  let lastActionMadeProgress = false
  let hasSucceededAssertion = false

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
    const validVarNames = new Set(vars.keys())
    const prompt = buildApiActionPrompt(options.goal, history, validVarNames, options.safety)
    const raw = await options.provider.complete(prompt, options.apiKey)
    const parsed = parseApiAction(raw, validVarNames, options.safety)

    if (!parsed.ok) {
      if (parsed.recoverable) {
        // A structurally valid request the safety mode or {{var}} check
        // blocked — the API equivalent of a failed click/fill: record it
        // and keep going, rather than ending the whole run the first time
        // the model tries a disallowed write.
        steps.push({ step: stepNumber, action: parsed.attemptedAction, ok: false, failureDetail: parsed.error })
        history.push({ action: parsed.attemptedAction, result: 'failed', detail: parsed.error })
        continue
      }
      return { runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'unparseable-response', unparseableResponse: parsed.raw }
    }

    const { action } = parsed

    const signature = actionSignature(action)
    if (signature === lastSignature && lastActionMadeProgress) {
      repeatCount = 0
    } else if (signature === lastSignature) {
      repeatCount++
      if (repeatCount >= 2) {
        return { runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'stuck-repeating' }
      }
    } else {
      repeatCount = 0
    }
    lastSignature = signature

    if (action.action === 'done') {
      lastActionMadeProgress = false
      const unverifiedSuccess = action.outcome === 'goal-reached' && needsConfirmation && !hasSucceededAssertion
      if (unverifiedSuccess) {
        history.push({
          action,
          result: 'failed',
          detail:
            'rejected: this goal asks to confirm/verify something, but no assert_status/assert_json_path_exists/assert_json_path_equals has succeeded yet — perform one before declaring done',
        })
        continue
      }
      return { runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: action.outcome }
    }

    if (action.action === 'request' && !SAFE_METHODS.has(action.method)) {
      options.onWrite?.(action.method, resolvePlaceholders(action.url, vars), action.reason)
    }

    const context: ApiExecutionContext = { cookieJar, authHeaders: options.authHeaders, safety: options.safety, vars }
    const result = await executeApiAction(action, context, lastResponse)
    lastActionMadeProgress =
      action.action === 'request' && result.ok && !SAFE_METHODS.has(action.method) && result.responseStatus !== undefined && result.responseStatus < 400

    steps.push({
      step: stepNumber,
      action,
      ok: result.ok,
      responseStatus: result.responseStatus,
      responseBodyExcerpt: result.responseBodyExcerpt,
      failureDetail: result.failureDetail,
    })
    history.push({
      action,
      result: result.ok ? 'ok' : 'failed',
      detail: result.ok ? describeResultDetail(action, result) : (result.failureDetail ?? 'failed'),
    })

    if (result.ok && result.response) lastResponse = result.response
    if (result.ok && result.savedVar) vars.set(result.savedVar.name, result.savedVar.value)

    const isAssertion = action.action === 'assert_status' || action.action === 'assert_json_path_exists' || action.action === 'assert_json_path_equals'
    if (isAssertion && result.ok) hasSucceededAssertion = true
    if (!result.ok && isAssertion) {
      return { runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'assertion-failed' }
    }
  }

  return { runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'stopped-by-cap' }
}
