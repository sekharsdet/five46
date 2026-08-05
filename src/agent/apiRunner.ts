import type { LlmProvider } from '../llm/types'
import type { StorageState } from './browser'
import { CookieJar, executeApiAction, resolvePlaceholders } from './apiExecutor'
import type { LastResponse, ApiExecutionContext } from './apiExecutor'
import { buildApiActionPrompt, buildApiPlanPrompt, checkVarReferences, parseApiAction, parseApiPlan } from './apiPlanner'
import { countConfirmationClauses, clauseLikelyMatches } from './planner'
import { splitConfirmationClauses } from './clauseSplitter'
import { isHostAllowed, isMethodAllowed, effectiveMethod } from './apiTypes'
import type { ApiAction, ApiHistoryEntry, ApiPlan, ApiTestRun, ExecutedApiStep, HttpMethod, SafetyMode } from './apiTypes'
import { DEFAULT_MAX_STEPS, HARD_MAX_STEPS, makeRunId, API_ACTION_MAX_OUTPUT_TOKENS, PLAN_MAX_OUTPUT_TOKENS } from './runLoop'

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
  /** Same meaning as `RunAgentOptions.useStructuredPlan` — see its own doc
   * comment, including the "default false at this engine layer, `cli.ts`
   * defaults it to true for the `api` command, MCP never sets it" nuance.
   * The ordinary fully-adaptive loop is completely unchanged unless this is
   * set. */
  useStructuredPlan?: boolean
  /** Same meaning as `RunAgentOptions.useFastSteps` — see its own doc
   * comment. Default false, opt-in via `--fast-steps`, only affects the
   * per-turn live action-decision call, never the upfront plan call. */
  useFastSteps?: boolean
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

/** What an assertion is actually checking — `'$status'` for `assert_status`
 * (a reserved key, never a real JSON path), the path itself for
 * `assert_json_path_exists`/`assert_json_path_equals`, `undefined` for
 * anything else. Used to catch the API-engine analog of a real,
 * live-found gap on the browser side: an indecisive model alternating
 * between different assertion *types* checking the *same* thing
 * (`assert_json_path_exists` then `assert_json_path_equals` on the same
 * path, then `assert_json_path_exists` again) never produces two
 * identical consecutive `actionSignature`s, so it evades the signature-repeat
 * guard below exactly the way alternating `assert_visible`/`assert_text` on
 * an unchanged ref did in `runner.ts`. Checking two *different* things in a
 * row (status, then a path) is a completely normal multi-property
 * verification and must not trip this — only a *third* check of the *same*
 * thing does, mirroring `runner.ts`'s "two is a normal verify pattern,
 * three is redundant" threshold exactly. */
function assertionCheckKey(action: ApiAction): string | undefined {
  if (action.action === 'assert_status') return '$status'
  if (action.action === 'assert_json_path_exists' || action.action === 'assert_json_path_equals') return action.path
  return undefined
}

/** Narrows `ApiAction`'s union before reading `clauseIndex` — mirrors
 * `runner.ts`'s identical `getClauseIndex` exactly (TypeScript can't narrow
 * through a separately-computed `isAssertion` boolean). */
function getClauseIndex(action: ApiAction): number | undefined {
  if (action.action === 'assert_status' || action.action === 'assert_json_path_exists' || action.action === 'assert_json_path_equals') return action.clauseIndex
  return undefined
}

/** The text an assertion's self-declared `clauseIndex` is checked against
 * via `clauseLikelyMatches` (planner.ts) — mirrors `runner.ts`'s identical
 * `clauseComparisonText`. `assert_status` deliberately returns `''`: a bare
 * HTTP status code carries no keyword semantics to compare against a
 * clause's own text at all, and `clauseLikelyMatches` already treats an
 * empty side as inconclusive (passes) — so this naturally reduces to
 * "always trust a declared clauseIndex for assert_status outright," without
 * a separate special case. `assert_json_path_exists`/`assert_json_path_equals`
 * compare against their `path` (and `expected`, when present) — often
 * genuinely meaningful (e.g. a path like "cart.items" sharing "cart" with
 * a clause about the cart). */
function clauseComparisonText(action: ApiAction): string {
  switch (action.action) {
    case 'assert_status':
      return ''
    case 'assert_json_path_exists':
      return action.path
    case 'assert_json_path_equals':
      return `${action.path} ${action.expected}`
    default:
      return ''
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
 * 2 must still resolve in step 8.
 *
 * Same unconditional-floor-of-1 assertion requirement as `runAgent` — see
 * its own doc comment for the full reasoning. */
export async function runApiTest(options: RunApiTestOptions): Promise<ApiTestRun> {
  const runId = makeRunId()
  const maxSteps = Math.min(options.maxSteps ?? DEFAULT_MAX_STEPS, HARD_MAX_STEPS)
  // Unconditional floor of 1, not just when the goal's own wording asks
  // for it — see runner.ts's identical fix/doc comment for the real,
  // live-found bug this closes (a goal with zero confirm/verify language
  // got a false goal-reached claim on a real production site).
  // countConfirmationClauses still raises the floor above 1 when the goal
  // explicitly asks for more than one check.
  const requiredConfirmationCount = Math.max(1, countConfirmationClauses(options.goal))
  // Mirrors runner.ts's identical block exactly — see its own doc comment
  // for the full reasoning (gated behind the cheap regex pre-filter, never
  // fatal, closes DEVELOPMENT.md's documented gap #3).
  let clauses: string[] = [options.goal]
  if (countConfirmationClauses(options.goal) >= 2) {
    try {
      clauses = (await splitConfirmationClauses(options.goal, options.provider, options.apiKey)).clauses
    } catch {
      // Never fatal — matches splitConfirmationClauses' own posture.
    }
  }
  const clauseTrackingActive = clauses.length > 1

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
  // How many assertions have succeeded across the WHOLE run — mirrors
  // runner.ts's identical counter (see countConfirmationClauses' own doc
  // comment for the real bug this closes). Unlike hasSucceededAssertion,
  // never reset by a state change.
  let succeededAssertionCount = 0
  // Only consulted when `clauseTrackingActive` — mirrors runner.ts's
  // identical `satisfiedClauses` exactly, see its own doc comment for the
  // full reasoning (why no staleness-reset is needed, unlike
  // hasSucceededAssertion above).
  const satisfiedClauses = new Set<number>()
  // Catches the API-engine analog of a real gap the signature-repeat guard
  // missed on the browser side (see `assertionCheckKey`'s doc comment).
  // Any `request` resets this, mirroring `runner.ts`'s "any click/fill/
  // scroll attempt resets it" — the model was at least trying to change
  // something, not purely re-checking the same still-unchanged response.
  let repeatedCheckKey: string | undefined
  let repeatedCheckCount = 0

  // One extra, independent LLM call — same pattern as `runner.ts`'s
  // identical block, see its own doc comment for the full reasoning
  // (never fatal to the run; a malformed/truncated response just skips
  // structured planning for this run entirely).
  let plan: ApiPlan | undefined
  let planStepIndex = 0
  let fastPathedSteps = 0
  if (options.useStructuredPlan) {
    try {
      const planRaw = await options.provider.complete(
        buildApiPlanPrompt(options.goal, options.safety, clauseTrackingActive ? clauses : undefined),
        options.apiKey,
        { maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS }
      )
      const parsedPlan = parseApiPlan(planRaw)
      if (parsedPlan.ok) plan = parsedPlan.plan
    } catch {
      // Network failure, provider error, etc. — same "not fatal" posture.
    }
  }
  const withPlanStats = (run: ApiTestRun): ApiTestRun => {
    if (plan) run.planStats = { plannedSteps: plan.steps.length, fastPathedSteps }
    return run
  }
  // True only when the immediately-preceding *actually-executed* step (not
  // the planned one) was a successful `request` — the fast path's own gate
  // for assertions, narrower than the browser engine's blanket exclusion.
  // Reasoning: `lastResponse` (below) only updates on a successful request;
  // if the preceding *planned* request instead failed for any of its
  // already-handled, non-fatal reasons (a blocked host, a timeout, an
  // unexpected 4xx — all "recoverable, keep going" already) and the loop
  // moved on, `lastResponse` would silently still hold an earlier,
  // unrelated response. A fast-pathed assertion right after would evaluate
  // against that stale state — a plausible-looking but wrong verdict. This
  // is the API-engine equivalent of "matched the wrong DOM element" the
  // browser engine's assertion exclusion exists to prevent — matched the
  // wrong *response*, via mutable sequencing state, not structural
  // ambiguity, so the fix is narrower than a blanket ban.
  let precedingWasSuccessfulRequest = false

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
    const plannedStep = plan && planStepIndex < plan.steps.length ? plan.steps[planStepIndex] : undefined
    if (plannedStep) planStepIndex++

    let action: ApiAction | undefined

    if (plannedStep && plannedStep.action === 'done') {
      // Fully deterministic, no live call needed — safe because the
      // unverified-success gate below (`unverifiedSuccess`) lives in the
      // shared loop body, applying identically regardless of provenance.
      action = plannedStep
      fastPathedSteps++
    } else if (plannedStep && plannedStep.action === 'request') {
      const validVarNamesNow = new Set(vars.keys())
      const varError = checkVarReferences([plannedStep.url, plannedStep.body, ...(plannedStep.headers ? Object.values(plannedStep.headers) : [])], validVarNamesNow)
      if (varError) {
        // Unresolved {{var}} — the plan itself doesn't make sense yet at
        // this point in the run; fall back to a live decision so the model
        // judges what actually makes sense given the real history, rather
        // than record a confusing failure for something never really
        // attempted.
      } else {
        const resolvedUrl = resolvePlaceholders(plannedStep.url, vars)
        // The fast path's own copy of parseApiAction's identical checks —
        // this codebase's `SafetyMode` gating lives inside that parser
        // today, which the fast path deliberately never calls, so it must
        // be reproduced here explicitly. This is the fix for the single
        // most important risk in this whole feature: without it, a
        // fast-pathed request could fire for real with zero method/host
        // gating even at default safety settings.
        // Gated on the *effective* method, not just the declared one — see
        // effectiveMethod's own doc comment (apiTypes.ts) for the real,
        // live finding: a plan step carrying a method-override header could
        // otherwise fast-path past this exact check.
        const effective = effectiveMethod(plannedStep.method, resolvedUrl, plannedStep.headers)
        if (!isMethodAllowed(effective, options.safety)) {
          const attempted: ApiAction = plannedStep
          const overrideNote = effective !== plannedStep.method ? ` (effectively ${effective} via a method-override header/param)` : ''
          steps.push({ step: stepNumber, action: attempted, ok: false, failureDetail: `method "${plannedStep.method}"${overrideNote} is not allowed this run (see --allow-writes/--allow-deletes)` })
          history.push({ action: attempted, result: 'failed', detail: 'blocked: disallowed method' })
          precedingWasSuccessfulRequest = false
          continue
        }
        if (!isHostAllowed(resolvedUrl, options.safety)) {
          const attempted: ApiAction = plannedStep
          steps.push({ step: stepNumber, action: attempted, ok: false, failureDetail: `"${resolvedUrl}" is not the target origin or an allowlisted host (see --allow-host)` })
          history.push({ action: attempted, result: 'failed', detail: 'blocked: disallowed host' })
          precedingWasSuccessfulRequest = false
          continue
        }
        action = plannedStep
        fastPathedSteps++
      }
    } else if (plannedStep && precedingWasSuccessfulRequest) {
      // assert_status/assert_json_path_exists/assert_json_path_equals,
      // only when the gate above holds — see its own doc comment. When
      // clause tracking is active, also requires a usable clauseIndex —
      // mirrors runner.ts's identical fast-path refusal exactly: fast-
      // pathing an assertion that can never count toward any clause would
      // be silently identical to the model quietly skipping a milestone it
      // was supposed to verify.
      const plannedClauseIndex = getClauseIndex(plannedStep)
      const clauseIndexUsable = !clauseTrackingActive || (plannedClauseIndex !== undefined && plannedClauseIndex >= 0 && plannedClauseIndex < clauses.length)
      if (clauseIndexUsable) {
        action = plannedStep
        fastPathedSteps++
      }
      // else: refuses to fast-path this one step, falls through to a live
      // decision below, same as an unresolved {{var}} reference above.
    }

    if (!action) {
      const validVarNames = new Set(vars.keys())
      const prompt = buildApiActionPrompt(options.goal, history, validVarNames, options.safety, clauseTrackingActive ? clauses : undefined)
      let raw: string
      try {
        raw = await options.provider.complete(prompt, options.apiKey, { maxOutputTokens: API_ACTION_MAX_OUTPUT_TOKENS, fastPath: options.useFastSteps })
      } catch (err) {
        // Same real, live-found gap as runner.ts's identical catch — see
        // its own doc comment. llm/retry.ts's own retry budget is already
        // exhausted by the time this throws; preserving `steps` and
        // returning a real outcome instead of letting this propagate
        // uncaught out of runApiTest matches the "never worse off for
        // having tried" posture already applied everywhere else here.
        return withPlanStats({
          runId,
          baseUrl: options.baseUrl,
          goal: options.goal,
          steps,
          outcome: 'provider-unavailable',
          providerError: err instanceof Error ? err.message : String(err),
        })
      }
      const parsed = parseApiAction(raw, validVarNames, options.safety)

      if (!parsed.ok) {
        if (parsed.recoverable) {
          // A structurally valid request the safety mode or {{var}} check
          // blocked — the API equivalent of a failed click/fill: record it
          // and keep going, rather than ending the whole run the first time
          // the model tries a disallowed write.
          steps.push({ step: stepNumber, action: parsed.attemptedAction, ok: false, failureDetail: parsed.error })
          history.push({ action: parsed.attemptedAction, result: 'failed', detail: parsed.error })
          precedingWasSuccessfulRequest = false
          continue
        }
        return withPlanStats({ runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'unparseable-response', unparseableResponse: parsed.raw })
      }
      action = parsed.action
    }

    const signature = actionSignature(action)
    if (signature === lastSignature && lastActionMadeProgress) {
      repeatCount = 0
    } else if (signature === lastSignature) {
      repeatCount++
      if (repeatCount >= 2) {
        return withPlanStats({ runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'stuck-repeating' })
      }
    } else {
      repeatCount = 0
    }
    lastSignature = signature

    const checkKey = assertionCheckKey(action)
    if (checkKey !== undefined) {
      // Mirrors runner.ts's identical fix to its `repeatedAssertionRef`
      // guard: when clause tracking is active, fold the self-declared
      // clauseIndex into the repeat-identity too, so re-checking the same
      // status/path to legitimately claim a different, not-yet-satisfied
      // clause isn't treated as "the same check again." A missing/
      // out-of-range index still folds into one uniform key — see
      // runner.ts's fuller comment on the same reasoning.
      const key = clauseTrackingActive ? `${checkKey}::clause${getClauseIndex(action)}` : checkKey
      if (key === repeatedCheckKey) {
        repeatedCheckCount++
        if (repeatedCheckCount >= 3) {
          return withPlanStats({ runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'stuck-repeating' })
        }
      } else {
        repeatedCheckKey = key
        repeatedCheckCount = 1
      }
    } else if (action.action === 'request') {
      repeatedCheckKey = undefined
      repeatedCheckCount = 0
    }

    if (action.action === 'done') {
      lastActionMadeProgress = false
      const unverifiedSuccess =
        action.outcome === 'goal-reached' &&
        (clauseTrackingActive ? satisfiedClauses.size < clauses.length : !hasSucceededAssertion || succeededAssertionCount < requiredConfirmationCount)
      if (unverifiedSuccess) {
        history.push({
          action,
          result: 'failed',
          detail: clauseTrackingActive
            ? `rejected: this goal asks to confirm ${clauses.length} distinct thing(s), but only ${satisfiedClauses.size} of them have been verified so far — perform the rest before declaring done`
            : succeededAssertionCount < requiredConfirmationCount
              ? `rejected: this goal asks to confirm/verify ${requiredConfirmationCount} thing(s), but only ${succeededAssertionCount} assertion(s) have succeeded so far — perform another before declaring done`
              : 'rejected: this goal asks to confirm/verify something, but no assert_status/assert_json_path_exists/assert_json_path_equals has succeeded yet — perform one before declaring done',
        })
        precedingWasSuccessfulRequest = false
        continue
      }
      return withPlanStats({ runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: action.outcome })
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
    // Tracks the fast path's own assertion-eligibility gate (see its doc
    // comment above) — updated for every actually-executed step, fast-
    // pathed or live-decided alike, exactly like `lastResponse` itself.
    precedingWasSuccessfulRequest = action.action === 'request' && result.ok

    const isAssertion = action.action === 'assert_status' || action.action === 'assert_json_path_exists' || action.action === 'assert_json_path_equals'
    if (isAssertion && result.ok) {
      if (clauseTrackingActive) {
        // Never trusted blindly — mirrors runner.ts's identical logic, see
        // its own doc comment. assert_status always passes this check (see
        // clauseComparisonText's own doc comment) since a bare HTTP code
        // has no keyword semantics to compare against a clause's text.
        const declaredIndex = getClauseIndex(action)
        if (
          declaredIndex !== undefined &&
          declaredIndex >= 0 &&
          declaredIndex < clauses.length &&
          clauseLikelyMatches(clauses[declaredIndex], clauseComparisonText(action))
        ) {
          satisfiedClauses.add(declaredIndex)
        }
      } else {
        hasSucceededAssertion = true
        succeededAssertionCount++
      }
    }
    // Mirrors runner.ts's identical fix — see its own doc comment for the
    // full reasoning and the real, live-found bug this closes. A successful
    // write (POST/PUT/PATCH/DELETE) after the last succeeded assertion means
    // that evidence may no longer reflect the current state; a read (GET/
    // HEAD/OPTIONS) doesn't change state, so it doesn't invalidate it.
    else if (action.action === 'request' && result.ok && !SAFE_METHODS.has(action.method)) hasSucceededAssertion = false
    if (!result.ok && isAssertion) {
      return withPlanStats({ runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'assertion-failed' })
    }
  }

  return withPlanStats({ runId, baseUrl: options.baseUrl, goal: options.goal, steps, outcome: 'stopped-by-cap' })
}
