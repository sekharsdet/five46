import type { LlmProvider } from '../llm/types'
import { launchAgentBrowser, snapshot, executeAction, substitutePlaceholders } from './browser'
import type { LoginCredentials, StorageState } from './browser'
import { buildActionPrompt, buildPlanPrompt, parseAgentAction, parsePlan, countConfirmationClauses, isDestructiveClickTarget, isImplausibleFillTarget, resolvePlannedTarget, clauseLikelyMatches } from './planner'
import { splitConfirmationClauses } from './clauseSplitter'
import { domShapeSignature } from './actionCache'
import type { AgentAction, AgentPlan, CallerPlanStep, ExecutedStep, HistoryEntry, PageOutline, PlannedStep, TestRun } from './types'
import { DEFAULT_MAX_STEPS, HARD_MAX_STEPS, makeRunId, ACTION_MAX_OUTPUT_TOKENS, PLAN_MAX_OUTPUT_TOKENS } from './runLoop'

export interface RunAgentOptions {
  url: string
  goal: string
  provider: LlmProvider
  apiKey: string
  /** Default 15, hard-capped at 50 regardless of what's passed — bounds
   * worst-case BYOK cost even if a caller passes something unreasonable. */
  maxSteps?: number
  headless?: boolean
  artifactDir: string
  /** A previously captured session (see `five46 login`) to start the
   * browser context already authenticated with. */
  storageState?: StorageState
  /** Presence of these makes the placeholder tokens available to the model
   * (see `planner.ts`) and enables real substitution at execution time (see
   * `browser.ts`'s `substitutePlaceholders`) — never logged, never recorded
   * into `history`/`steps`/`TestRun`. */
  credentials?: LoginCredentials
  /** Invoked once, only on an accepted `goal-reached` outcome, before the
   * browser closes — given the real `BrowserContext` and the storageState
   * captured immediately after the initial navigation (before any actions),
   * so the caller can compare it against the context's current state itself
   * and decide what "nothing actually changed" should mean, without
   * `runner.ts` needing an opinion about it. This is how `five46 login`
   * captures a session, deliberately kept out of `TestRun`'s own shape so
   * `generateSpec.ts`/`failureReport.ts` are structurally unable to ever
   * touch it. */
  onGoalReached?: (context: import('playwright').BrowserContext, baselineState: StorageState) => Promise<void>
  /** Default false — a `click` whose target looks like it deletes/
   * deactivates/closes an account or permanently erases data (see
   * `planner.ts`'s `isDestructiveClickTarget`) is blocked instead of
   * executed. The browser engine's only analog to the API engine's
   * `SafetyMode.allowDeletes` — deliberately has no `allowWrites` analog;
   * see DEVELOPMENT.md's "browser-engine destructive-action gating"
   * section for why. */
  allowDeletes?: boolean
  /** Invoked synchronously right before a real, allowed destructive click
   * executes (`allowDeletes: true`) — mirrors `RunApiTestOptions`'s
   * `onWrite`: a destructive click's blast radius has no natural ceiling,
   * so this gives real-time visibility instead of only a place in the
   * final report. */
  onDestructiveClick?: (elementName: string, reason: string) => void
  /** Records the whole session as a `.webm` into `artifactDir` — see
   * `browser.ts`'s `AgentBrowser.close()` doc comment for exactly when the
   * file is finalized and how its path is recovered. No API-engine
   * analog — no browser, structurally impossible, matching the existing
   * "no analog, and that's correct, not a gap" precedent already
   * established for self-healing selectors. */
  recordVideo?: boolean
  /** Default false at this engine layer — `runAgent()` itself doesn't
   * default this to `true`; `cli.ts` is the caller responsible for
   * defaulting it to `true` for the `test` command (see
   * `resolveStructuredPlan`), so every existing test calling `runAgent()`
   * directly without setting this is unaffected by that CLI-level default.
   * MCP (`src/mcp/tools.ts`) also never sets this on its own, so an
   * ordinary MCP `goal`/`story` call stays fully-adaptive — a deliberate
   * scope boundary, not an oversight. The one exception: an MCP call that
   * supplies `callerPlanSteps` (below) forces this on, since there's
   * otherwise nowhere for those steps to go. When set: one extra upfront
   * `provider.complete()` call plans
   * the whole goal (see `planner.ts`'s `buildPlanPrompt`), and most planned
   * steps then execute directly against a fresh page snapshot with no
   * further LLM call at all — see the dedicated fast-path section in this
   * file. The ordinary fully-adaptive loop (every existing behavior/test)
   * is completely unchanged unless this is set. */
  useStructuredPlan?: boolean
  /** Default false — opt-in via `--fast-steps`, deliberately not default-on
   * (unlike `useStructuredPlan`, which earned that status only after this
   * project's own live validation). When set, every per-turn live action
   * decision passes `fastPath: true` to the provider (see
   * `LlmCompleteOptions`), which Groq/Gemini map to a genuinely faster
   * model tier; OpenAI/Anthropic/Bedrock ignore it. The one-time upfront
   * plan call and the root-cause call never set this, regardless of this
   * option — only the high-frequency per-step call is affected. A smaller
   * model is a real, currently-unquantified risk to per-step decision
   * quality, which is exactly why this isn't the default. */
  useFastSteps?: boolean
  /** Opt-in cross-run action cache (`--action-cache`, off by default — see
   * `agent/actionCache.ts`/`config/actionCache.ts`). The caller (`cli.ts`)
   * is responsible for all cache file I/O — looking up an entry keyed to
   * this goal/URL/project scope before calling `runAgent`, and persisting
   * a fresh one afterward using `TestRun.steps`/`domSignature` — `runner.ts`
   * itself never touches the cache file, only consults whatever entry (if
   * any) is handed to it here. Only ever consulted when `useStructuredPlan`
   * is also set (the cache is an alternative *source* for the upfront plan,
   * not a parallel mechanism — see the dedicated fast-path section). A
   * `domSignature` mismatch against this run's own real initial outline
   * (computed live, never trusted from the cache entry itself) means the
   * page looks different than when the cache was written — degrades
   * silently to a live plan call, the exact same "never worse off for
   * having tried" posture a malformed live plan response already gets. */
  cachedPlan?: { domSignature: string; steps: PlannedStep[] }
  /** MCP-only (`five46_test`'s `steps` param — see `mcp/tools.ts`): a
   * caller-authored hint list fed into the upfront plan call (`planner.ts`'s
   * `buildPlanPrompt`) instead of letting the model invent its own
   * decomposition. Only meaningful when `useStructuredPlan` is also set (MCP
   * forces it on whenever this is present); ignored otherwise. Never
   * consulted by `cachedPlan` or any execution logic below — it only ever
   * reaches `buildPlanPrompt`, so every safety/resolution mechanism in this
   * file treats a caller-seeded plan identically to a self-invented one. */
  callerPlanSteps?: CallerPlanStep[]
}

function actionSignature(action: AgentAction): string {
  switch (action.action) {
    case 'click':
    case 'assert_visible':
      return `${action.action}:${action.ref}`
    case 'fill':
      return `${action.action}:${action.ref}:${action.value}`
    case 'hover':
      return `hover:${action.ref}`
    case 'dblclick':
      return `dblclick:${action.ref}`
    case 'drag':
      return `drag:${action.ref}:${action.targetRef}`
    case 'press_key':
      return `press_key:${action.ref}:${action.key}`
    case 'upload':
      return `upload:${action.ref}:${action.filePath}`
    case 'assert_text':
      return `${action.action}:${action.ref}:${action.expectedText}`
    case 'assert_value':
      return `${action.action}:${action.ref}:${action.expectedValue}`
    case 'assert_page_text':
      return `assert_page_text:${action.expectedText}`
    case 'assert_page_text_absent':
      return `assert_page_text_absent:${action.expectedText}`
    case 'scroll':
      // Up/down must be distinct repeat-buckets, matching how fill/
      // assert_text already key off their value, not just the action
      // type — otherwise two consecutive scrolls in opposite directions
      // would be treated as the same repeated action.
      return `scroll:${action.direction}`
    case 'wait':
      // Same signature every time, deliberately — two consecutive waits are
      // allowed (see `browser.ts`'s `WAIT_ACTION_MS` doc comment), but a
      // third identical one in a row should trip the same stuck-repeating
      // guard an endlessly-clicking model would hit.
      return `wait`
    case 'done':
      return `done`
  }
}

/** The text an assertion's self-declared `clauseIndex` is checked against
 * via `clauseLikelyMatches` (planner.ts) — the target element's accessible
 * name for `assert_visible` (no expected value to compare), name +
 * expected text for `assert_text`, and just the expected text for
 * `assert_page_text` (no ref/name at all). Returns `''` for any other
 * action, which `clauseLikelyMatches` already treats as inconclusive
 * (passes) since it has nothing to compare — this function is only ever
 * called on an already-confirmed assertion action, so that case never
 * actually arises in practice. */
/** Narrows `AgentAction`'s union before reading `clauseIndex` — TypeScript
 * can't narrow through a separately-computed `isAssertion` boolean, only a
 * direct `action.action === '...'` check in the same expression, so this
 * exists purely to keep the call site (a dense, already-nested block)
 * readable rather than repeating a three-way `action.action === ...` check
 * inline. Returns `undefined` for any non-assertion action, which the
 * caller already only calls this for real assertions in practice. */
function getClauseIndex(action: AgentAction): number | undefined {
  if (
    action.action === 'assert_visible' ||
    action.action === 'assert_text' ||
    action.action === 'assert_value' ||
    action.action === 'assert_page_text' ||
    action.action === 'assert_page_text_absent'
  )
    return action.clauseIndex
  return undefined
}

function clauseComparisonText(action: AgentAction, outline: PageOutline): string {
  switch (action.action) {
    case 'assert_visible':
      return outline.elements.find((el) => el.ref === action.ref)?.name ?? ''
    case 'assert_text': {
      const name = outline.elements.find((el) => el.ref === action.ref)?.name ?? ''
      return `${name} ${action.expectedText}`
    }
    case 'assert_value': {
      const name = outline.elements.find((el) => el.ref === action.ref)?.name ?? ''
      return `${name} ${action.expectedValue}`
    }
    case 'assert_page_text':
    case 'assert_page_text_absent':
      return action.expectedText
    default:
      return ''
  }
}

/** Orchestrates the full agentic loop: launch the browser (before any paid
 * LLM call, so a missing-setup environment fails fast and cheap — see
 * `AgentBrowserUnavailableError`), then repeatedly snapshot the page, ask
 * the LLM for the next single action, strictly parse it, execute it, and
 * record the result, until the model says `done`, a real assertion fails
 * (the actual test verdict), the same action repeats twice in a row (a
 * stuck agent, not worth burning the rest of the step budget on), or the
 * step cap is reached. A `click`/`fill` failure does *not* end the run by
 * itself — it's recorded in history and the loop continues, so the model
 * can see the failure and try something else next turn; only an
 * `assert_visible`/`assert_text` failure is treated as the run's actual
 * verdict about the app, matching how a real test's assertions (not its
 * incidental navigation steps) are what a test is actually for.
 *
 * A `done`/`goal-reached` claim is always rejected (fed back into history,
 * loop continues) unless at least one `assert_visible`/`assert_text`/
 * `assert_page_text` has already succeeded — found via a real, live run (a
 * Shopify demo store, "...then confirm the cart shows an item"): the model
 * added a real item to the cart, then declared goal-reached without ever
 * calling an assertion. The end state happened to be correct, but nothing
 * in the run actually verified it, despite the goal explicitly asking for
 * verification — the same "don't accept an unverified confident claim"
 * posture as everywhere else in this project, applied to the model's own
 * self-reported success.
 *
 * The required count is `Math.max(1, countConfirmationClauses(goal))` —
 * an unconditional floor of 1, not just when the goal's own wording asks
 * for it. Originally this only applied when `requiresConfirmation(goal)`
 * matched confirm/verify/ensure/etc. language in the goal text; found via
 * live testing against real production sites (Flipkart, Amazon.in) that a
 * goal phrased as plain procedure ("add to cart, then open login," no
 * confirm/verify wording at all) got a false `goal-reached` claim after a
 * single incidental click (closing an unrelated popup), since the old
 * clause-count-only threshold computed 0 for it — zero forced
 * verification, by design, for exactly the kind of natural task
 * description a real user is likely to write. `countConfirmationClauses`
 * still raises the floor above 1 when the goal explicitly asks for more
 * than one check — this only changed the *minimum*, never the ceiling. */
export async function runAgent(options: RunAgentOptions): Promise<TestRun> {
  const runId = makeRunId()
  const maxSteps = Math.min(options.maxSteps ?? DEFAULT_MAX_STEPS, HARD_MAX_STEPS)
  const requiredConfirmationCount = Math.max(1, countConfirmationClauses(options.goal))
  const credentialsAvailable = options.credentials
    ? { username: Boolean(options.credentials.username), password: Boolean(options.credentials.password) }
    : undefined

  const browser = await launchAgentBrowser({
    headless: options.headless,
    storageState: options.storageState,
    recordVideoDir: options.recordVideo ? options.artifactDir : undefined,
  })
  // The video path is only known after teardown (`browser.close()`, in the
  // `finally` block below), which runs *after* every one of this
  // function's several `return` statements has already been decided. A
  // `finally` can't attach a field to an already-returned literal, but it
  // *can* mutate an object those returns already reference, since `finally`
  // runs before control actually leaves the function — so every `return`
  // below goes through this `done()` wrapper instead of a bare object
  // literal, purely so the `finally` block has something to mutate.
  let result: TestRun | undefined
  // Structured-plan state, declared here (not inside `try`) so `done()`'s
  // closure captures the same mutable bindings the loop below updates —
  // by the time any `return done(...)` actually runs, these hold their
  // real, current values, the same "finally-block mutation" trick already
  // used for `videoPath`.
  let plan: AgentPlan | undefined
  let fastPathedSteps = 0
  let planSource: 'live' | 'cache' | undefined
  let domSignature: string | undefined
  const done = (run: TestRun): TestRun => {
    if (plan) run.planStats = { plannedSteps: plan.steps.length, fastPathedSteps, source: planSource }
    if (domSignature) run.domSignature = domSignature
    result = run
    return run
  }
  try {
    await browser.page.goto(options.url)
    const baselineState = await browser.context.storageState()
    // Captured once, before any action ever runs — the mechanical basis
    // for the assert_page_text tautology guard below (see its own doc
    // comment). Best-effort: an unreadable/not-yet-settled body at this
    // exact moment degrades to an empty baseline, not a thrown error —
    // the guard simply can't flag anything against an empty baseline,
    // which is the same "fail open, never fail the whole run" posture
    // every other best-effort capture in this codebase already uses.
    const baselineBodyText = await browser.page
      .locator('body')
      .innerText()
      .catch(() => '')

    // Only ever attempted when the goal already shows 2+ confirm-language
    // occurrences (`countConfirmationClauses`) — keeps this feature at zero
    // extra LLM calls for the overwhelming majority of goals (single/zero-
    // clause), which keep today's unchanged scalar `requiredConfirmationCount`
    // gate below untouched. Never fatal: any failure (network, malformed
    // response) degrades `clauses` to `[options.goal]`, which
    // `clauseTrackingActive` then treats identically to "no compound
    // structure worth tracking," same posture as `parsePlan`'s own
    // never-fatal degrade. Closes DEVELOPMENT.md's documented gap #3: a
    // scalar count of successful assertions couldn't tell "verified
    // milestone A twice" apart from "verified A once, B once" — see
    // `splitConfirmationClauses`/`clauseLikelyMatches` (planner.ts) for the
    // rest of the mechanism.
    let clauses: string[] = [options.goal]
    if (countConfirmationClauses(options.goal) >= 2) {
      try {
        clauses = (await splitConfirmationClauses(options.goal, options.provider, options.apiKey)).clauses
      } catch {
        // Never fatal — matches splitConfirmationClauses' own posture.
      }
    }
    const clauseTrackingActive = clauses.length > 1

    // One extra, independent LLM call — the same second-`complete()`-call
    // pattern `rootCause.ts` already uses, not a change to `LlmProvider`
    // itself. A malformed/truncated plan response, or a thrown error making
    // this call at all, is deliberately never fatal to the run: silently
    // skip structured planning and fall through to the ordinary,
    // fully-adaptive loop for the entire step budget below — a caller who
    // opted into `useStructuredPlan` for efficiency must never end up with
    // a strictly worse worst case than not opting in at all. See
    // `parsePlan`'s own doc comment for the full reasoning.
    if (options.useStructuredPlan) {
      const initialOutline = await snapshot(browser.page, undefined, true)
      // Exposed on the returned TestRun regardless of whether a cache was
      // consulted or hit — see TestRun.domSignature's own doc comment for
      // why (`cli.ts` needs it to write a fresh entry after a real
      // goal-reached outcome, without runner.ts itself doing cache I/O).
      domSignature = domShapeSignature(initialOutline)
      // A cache hit is an alternative SOURCE for `plan`, never a parallel
      // execution mechanism — every downstream mechanism (resolvePlannedTarget's
      // fresh-snapshot resolve-or-refuse, the inline safety-gate re-checks,
      // assert_text/assert_page_text's permanent fast-path exclusion, the
      // clause-tracking fast-path refusal above) applies completely
      // unmodified regardless of whether `plan` came from here or the live
      // call below. The signature comparison is always computed against
      // THIS run's own real, live initial outline — never trusted from the
      // cache entry itself — so a stale cache (the page genuinely changed)
      // degrades to the live call below exactly like a cache miss would.
      if (options.cachedPlan && options.cachedPlan.domSignature === domSignature) {
        plan = { steps: options.cachedPlan.steps }
        planSource = 'cache'
      } else {
        try {
          const planRaw = await options.provider.complete(
            buildPlanPrompt(options.goal, initialOutline, clauseTrackingActive ? clauses : undefined, options.callerPlanSteps),
            options.apiKey,
            { maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS }
          )
          const parsedPlan = parsePlan(planRaw)
          if (parsedPlan.ok) {
            plan = parsedPlan.plan
            planSource = 'live'
          }
        } catch {
          // Network failure, provider error, etc. — same "not fatal" posture.
        }
      }
    }
    let planStepIndex = 0

    const history: HistoryEntry[] = []
    const steps: ExecutedStep[] = []
    let lastSignature: string | undefined
    let repeatCount = 0
    // True only when the *previous* occurrence of `lastSignature` was a
    // click/fill that actually succeeded — real, live evidence found via a
    // goal that legitimately needs the same action several times in a row
    // ("click Add Element three times"): a click/fill genuinely changes
    // page state each time it succeeds, so repeating one that keeps working
    // is forward progress, not a stuck agent, and must not trip this guard
    // — only `maxSteps` should bound it. A repeated `done` or a repeated
    // *failing* click/fill is never "progress" this way, so both keep
    // exactly today's behavior (never set true for `done`; forced false
    // below whenever the action isn't a successful click/fill). Assertions
    // are deliberately excluded too: a repeated assert_visible succeeding
    // twice in a row means the model re-checked something already
    // confirmed, not that anything changed — still a real stuck-loop sign.
    let lastActionMadeProgress = false
    let hasSucceededAssertion = false
    // How many assertions have succeeded across the WHOLE run — unlike
    // hasSucceededAssertion, never reset by a state change: an earlier
    // successful confirm still counts toward the total the goal asked for,
    // even once it's no longer the *freshest* evidence. See
    // countConfirmationClauses' own doc comment for the real bug this
    // closes (a compound goal skipping an earlier confirm-clause entirely).
    let succeededAssertionCount = 0
    // Only consulted when `clauseTrackingActive` — the per-clause
    // replacement for `succeededAssertionCount`'s scalar total, closing
    // DEVELOPMENT.md's documented gap #3 (a count couldn't tell "verified
    // milestone A twice" apart from "verified A once, B once"). Unlike
    // `hasSucceededAssertion` below, this deliberately does NOT reset on a
    // later click/fill: a `Set` keyed by clause index has no staleness
    // ambiguity the way a bare scalar count does — clause 0 being satisfied
    // says nothing about clause 1, so a later state change can't silently
    // invalidate it the way it can a scalar "some assertion succeeded
    // recently enough" flag. If a later action genuinely invalidates an
    // earlier clause's evidence, that's only expressible by the goal naming
    // it as its own distinct clause, same limit `clauseSplitter.ts` itself
    // already has (it only identifies what the goal already describes).
    const satisfiedClauses = new Set<number>()
    // Catches a real gap the signature-repeat guard above misses: a model
    // that keeps re-verifying the same still-unchanged element by
    // alternating assertion types (assert_visible, assert_text,
    // assert_visible, ...) never produces two *identical* consecutive
    // signatures, so it evades that guard entirely — confirmed against a
    // real model in practice, not a hypothetical. Two assertions in a row
    // on the same ref (e.g. "confirm visible, then confirm the text") is a
    // completely normal verification pattern and must not trip this; a
    // third, still on the same ref with nothing else attempted in between,
    // is genuinely redundant — the page hasn't changed, so re-checking it
    // again provides no new information. Any click/fill/scroll attempt
    // resets this, since the model was at least trying to change
    // something, not purely re-asserting.
    let repeatedAssertionRef: string | undefined
    let repeatedAssertionCount = 0
    // The (role, name) of whatever the most recent *actually-executed*
    // click/fill targeted — used by parseAgentAction to block a
    // tautological assert_visible on that exact same element (see its own
    // doc comment). Deliberately loop state, not derived from `steps` each
    // turn: a *blocked* attempt (this same tautology check, or a blocked
    // destructive click) never reaches execution at all, so it must leave
    // this unchanged — re-deriving from `steps[steps.length - 1]` would
    // instead see the blocked attempt itself as "the last step" and
    // silently forget what was really last interacted with, letting a
    // second, identical attempt through unblocked. Cleared on any other
    // *executed* action (scroll, any assertion, successful or not) — the
    // "just interacted with X" context is stale once something else
    // genuinely happened.
    let lastInteractedElement: { role: string; name: string } | undefined

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      // A pending planned step (if any) for this iteration — consumed
      // (index advanced) regardless of whether it actually fast-paths, so a
      // step whose prediction doesn't resolve cleanly gets exactly one live
      // decision, not repeated forever. Once the plan runs out, every
      // remaining iteration falls straight through to the unmodified live
      // flow below, for the rest of the step budget — a deliberate v1 scope
      // decision (see the plan doc): the plan is a fast-path scaffold, not
      // a hard contract, so exhaustion degrades gracefully instead of
      // triggering explicit re-planning.
      const plannedStep: PlannedStep | undefined = plan && planStepIndex < plan.steps.length ? plan.steps[planStepIndex] : undefined
      if (plannedStep) planStepIndex++

      let action: AgentAction | undefined
      let outline: PageOutline | undefined

      if (plannedStep && (plannedStep.action === 'scroll' || plannedStep.action === 'wait' || plannedStep.action === 'done')) {
        // Fully deterministic — no target to resolve, no ambiguity
        // possible, no LLM call needed at all. `outline` is a placeholder;
        // executeAction() never reads it for any of these three actions
        // (scroll acts on `window`, wait just pauses, done returns
        // immediately), and generateSpec.ts's selectorFor() never looks any
        // of them up by ref.
        action = plannedStep
        outline = { elements: [], truncated: false, totalFound: 0 }
        fastPathedSteps++
      } else if (plannedStep && (plannedStep.action === 'click' || plannedStep.action === 'fill' || plannedStep.action === 'assert_visible' || plannedStep.action === 'assert_text')) {
        // assert_text never fast-paths, full stop — predicting an exact
        // expected *text value* for a page the plan never actually saw is a
        // categorically bigger risk than predicting an element's role+name:
        // a wrong prediction here can silently produce a false pass or a
        // false assertion-failed, not just "picked a plausible element."
        // assert_visible carries only the resolution-ambiguity risk
        // click/fill fast-pathing already accepts (see below) — no expected
        // *value* to get wrong, only "does this resolved element genuinely
        // exist and is it visible," which the real execution path still
        // checks for real. A planned `assert_page_text` step isn't listed in
        // either branch condition above, so it falls through to the live
        // decision below by construction — same reasoning as assert_text,
        // since it also requires predicting an exact expected substring.
        if (plannedStep.action === 'click' || plannedStep.action === 'fill' || plannedStep.action === 'assert_visible') {
          // prioritizeViewport: false — matches self-healing's own
          // re-match call, not the live loop's per-turn one just below.
          // Both this fast path and self-healing are "resolve-and-refuse-
          // on-ambiguity against a fresh snapshot"; viewport-prioritized
          // capping would make an "ambiguous, refuse" case
          // scroll-position-dependently flip to "one match, proceed" —
          // self-healing already opted out of exactly this bug class once.
          const freshOutline = await snapshot(browser.page, undefined, false)
          const candidates = resolvePlannedTarget(freshOutline, plannedStep.target)

          if (candidates.length === 1) {
            const candidate = candidates[0]
            if (plannedStep.action === 'click' && !options.allowDeletes && isDestructiveClickTarget(candidate.name)) {
              // The fast-path's own copy of parseAgentAction's identical
              // click-branch gate (planner.ts) — this check lives inside
              // that parser today, which the fast path deliberately never
              // calls, so it must be reproduced here explicitly. This is
              // the fix for the single most important risk in this whole
              // feature: without it, a plan step that happened to resolve
              // to a destructive-looking button would execute with zero
              // gating even at default safety settings.
              const attempted: AgentAction = { action: 'click', ref: candidate.ref, reason: plannedStep.reason }
              steps.push({
                step: stepNumber,
                action: attempted,
                outline: freshOutline,
                ok: false,
                failureDetail: `clicking "${candidate.name}" looks like it deletes/deactivates/closes an account or permanently erases data — blocked this run (see --allow-deletes)`,
              })
              history.push({ action: attempted, result: 'failed', detail: 'blocked: destructive-looking click' })
              continue
            }
            // The fast-path's own copy of parseAgentAction's identical
            // fill-role-plausibility gate (planner.ts) — reproduced here
            // for the exact same reason the destructive-click gate above
            // is: this fast path deliberately never calls that parser at
            // all. Unlike the destructive-click gate (a hard safety stop),
            // an implausible fill target isn't unsafe, just probably a bad
            // prediction — refusing to fast-path it and falling through to
            // a live decision (below) gives the model a real chance to
            // reconsider within the same step, rather than burning a whole
            // step on a guaranteed-wrong action the way a hard fail would.
            const fillTargetPlausible = plannedStep.action !== 'fill' || !isImplausibleFillTarget(candidate.role)
            // When clause tracking is active, an assert_visible plan step
            // with no usable clauseIndex (missing, or out of range for
            // this run's actual clause list — e.g. a plan made before
            // splitting settled on a different count) refuses to fast-path,
            // matching "exactly one candidate or refuse" applied to clause
            // coverage too, not just structural ambiguity: fast-pathing it
            // anyway would silently execute a real assertion that can never
            // count toward any clause, no different from the model quietly
            // skipping a milestone it was supposed to verify.
            const clauseIndexUsable =
              plannedStep.action !== 'assert_visible' ||
              !clauseTrackingActive ||
              (plannedStep.clauseIndex !== undefined && plannedStep.clauseIndex >= 0 && plannedStep.clauseIndex < clauses.length)
            if (clauseIndexUsable && fillTargetPlausible) {
              action =
                plannedStep.action === 'click'
                  ? { action: 'click', ref: candidate.ref, reason: plannedStep.reason }
                  : plannedStep.action === 'fill'
                    ? { action: 'fill', ref: candidate.ref, value: plannedStep.value, submit: plannedStep.submit, reason: plannedStep.reason }
                    : { action: 'assert_visible', ref: candidate.ref, reason: plannedStep.reason, ...(plannedStep.clauseIndex !== undefined ? { clauseIndex: plannedStep.clauseIndex } : {}) }
              outline = freshOutline
              fastPathedSteps++
            }
          }
          // Zero or multiple candidates: refuse to guess, same as
          // self-healing — falls through to the live decision below.
        }
      }

      if (!action || !outline) {
        // Reached when there's no plan, the plan is exhausted, this step
        // was an assert_text/assert_page_text (always live), or a
        // click/fill/assert_visible target didn't resolve to exactly one
        // candidate — the exact, unmodified live flow that exists
        // regardless of `useStructuredPlan`.
        //
        // prioritizeViewport: true here (and only here) — self-healing's
        // own re-snapshot call in browser.ts deliberately leaves this off.
        // See snapshot()'s doc comment for why the two must not share this.
        outline = await snapshot(browser.page, undefined, true)
        const planStepNote = plannedStep && plan ? { index: planStepIndex - 1, total: plan.steps.length, step: plannedStep } : undefined
        const prompt = buildActionPrompt(options.goal, history, outline, credentialsAvailable, options.allowDeletes, planStepNote, clauseTrackingActive ? clauses : undefined)
        let raw: string
        try {
          raw = await options.provider.complete(prompt, options.apiKey, { maxOutputTokens: ACTION_MAX_OUTPUT_TOKENS, fastPath: options.useFastSteps })
        } catch (err) {
          // llm/retry.ts's own retry budget (4 attempts) is already
          // exhausted by the time this throws — found via a real, live run
          // that hit a sustained Gemini 503 patch: before this catch
          // existed, this error propagated straight out of runAgent
          // uncaught, discarding every step already completed. Preserving
          // `steps` here and returning a real, honest outcome instead
          // matches this codebase's "a caller must never end up worse off
          // for having tried" posture everywhere else (a malformed plan
          // response, a recoverable parse rejection, ...).
          return done({
            runId,
            url: options.url,
            goal: options.goal,
            steps,
            outcome: 'provider-unavailable',
            providerError: err instanceof Error ? err.message : String(err),
          })
        }
        const parsed = parseAgentAction(raw, outline, options.allowDeletes ?? false, lastInteractedElement)

        if (!parsed.ok) {
          if (parsed.recoverable) {
            // A structurally valid click a destructive-target check blocked —
            // the browser equivalent of a failed click/fill: record it and
            // keep going, mirroring apiRunner.ts's identical handling of a
            // disallowed method/host, rather than ending the whole run the
            // first time the model tries a delete-looking click.
            steps.push({ step: stepNumber, action: parsed.attemptedAction, outline, ok: false, failureDetail: parsed.error })
            history.push({ action: parsed.attemptedAction, result: 'failed', detail: parsed.error })
            continue
          }
          return done({ runId, url: options.url, goal: options.goal, steps, outcome: 'unparseable-response', unparseableResponse: parsed.raw })
        }
        action = parsed.action
      }

      const signature = actionSignature(action)
      if (signature === lastSignature && lastActionMadeProgress) {
        repeatCount = 0
      } else if (signature === lastSignature) {
        repeatCount++
        if (repeatCount >= 2) {
          return done({ runId, url: options.url, goal: options.goal, steps, outcome: 'stuck-repeating' })
        }
      } else {
        repeatCount = 0
      }
      lastSignature = signature

      if (
        action.action === 'assert_visible' ||
        action.action === 'assert_text' ||
        action.action === 'assert_value' ||
        action.action === 'assert_page_text' ||
        action.action === 'assert_page_text_absent'
      ) {
        // assert_page_text/assert_page_text_absent have no `ref` (that's the
        // whole point — see their own doc comments), so they're tracked by
        // `expectedText` instead, reusing the same "current assertion
        // target" slot rather than a second parallel counter. The action
        // type is folded into the key too — otherwise asserting text present
        // then immediately asserting the SAME text absent (a legitimate,
        // meaningful pair of checks) would collide into one repeat-tracked
        // key and risk tripping the guard on two actions that are opposites
        // of each other, not repeats.
        const baseKey =
          action.action === 'assert_page_text' || action.action === 'assert_page_text_absent'
            ? `${action.action}:${action.expectedText}`
            : action.ref
        // When clause tracking is active, a self-declared clauseIndex is
        // part of the repeat-identity too. Live-caught on GitHub: a model
        // legitimately re-asserted the exact same ref via assert_text twice
        // to claim two DIFFERENT, not-yet-satisfied clauses (valid — one
        // piece of evidence can support two distinct claims, e.g.
        // "microsoft/playwright" text satisfies both a "playwright" clause
        // and a "microsoft" clause). This guard predates clause tracking
        // and only ever compared the base ref/text, so it saw "the same
        // check again" and could trip stuck-repeating before both clauses
        // ever got credited — even though nothing was actually stuck.
        // assert_page_text mostly evades this already (expectedText itself
        // usually varies per clause), which is why the live repro used
        // assert_text. A missing/out-of-range declared index still folds
        // into one uniform key (not exempted per-attempt) — an unusable
        // clauseIndex should still count as a genuine repeat of the base
        // check, same as clause tracking being inactive entirely.
        const key = clauseTrackingActive ? `${baseKey}::clause${getClauseIndex(action)}` : baseKey
        if (key === repeatedAssertionRef) {
          repeatedAssertionCount++
          if (repeatedAssertionCount >= 3) {
            return done({ runId, url: options.url, goal: options.goal, steps, outcome: 'stuck-repeating' })
          }
        } else {
          repeatedAssertionRef = key
          repeatedAssertionCount = 1
        }
      } else if (
        action.action === 'click' ||
        action.action === 'fill' ||
        action.action === 'hover' ||
        action.action === 'press_key' ||
        action.action === 'upload' ||
        action.action === 'scroll' ||
        action.action === 'wait'
      ) {
        repeatedAssertionRef = undefined
        repeatedAssertionCount = 0
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
                : 'rejected: this goal asks to confirm/verify something, but no assert_visible/assert_text has succeeded yet — perform one before declaring done',
          })
          continue
        }
        if (action.outcome === 'goal-reached') {
          await options.onGoalReached?.(browser.context, baselineState)
        }
        return done({ runId, url: options.url, goal: options.goal, steps, outcome: action.outcome })
      }

      if (action.action === 'click' && options.allowDeletes) {
        const name = outline.elements.find((el) => el.ref === action.ref)?.name ?? ''
        if (isDestructiveClickTarget(name)) options.onDestructiveClick?.(name, action.reason)
      }

      const result = await executeAction(browser.page, action, outline, options.artifactDir, stepNumber, options.credentials)
      // A checkbox/radio click *toggles* state — repeating it is never
      // progress the way repeating a click on an additive control (a
      // counter, "Add Element") is; two identical clicks net out to
      // exactly where it started. Confirmed against a real model in
      // practice: an indecisive model clicked the same checkbox 8 times in
      // a row (an even count — the opposite of the goal) before ever
      // exhausting the step budget, since the general click-repeat
      // exemption below didn't distinguish the two cases. Excluded from
      // that exemption here, so two identical clicks on the same
      // checkbox/radio fall back to the ordinary repeat-guard above.
      const clickedRole = action.action === 'click' ? outline.elements.find((el) => el.ref === action.ref)?.role : undefined
      const isToggleControlClick = action.action === 'click' && (clickedRole === 'checkbox' || clickedRole === 'radio')
      // A scroll that actually moved the page counts as progress the same
      // way a successful non-toggle click/fill does — a scroll already at
      // a page boundary still returns ok:true but scrolled:false, and that
      // must NOT count as progress, or a genuinely stuck no-op scroll
      // would never trip the guard.
      const isProgressableClickOrFill = (action.action === 'click' && !isToggleControlClick) || action.action === 'fill'
      lastActionMadeProgress = (isProgressableClickOrFill && result.ok) || (action.action === 'scroll' && result.scrolled === true)
      lastInteractedElement =
        (action.action === 'click' || action.action === 'fill') && result.ok
          ? outline.elements.find((el) => el.ref === action.ref)
          : undefined
      // assert_page_text against text that was ALREADY present before any
      // actions ran proves nothing — found via a real, live run (Flipkart,
      // reproduced twice): the model satisfied the confirmation requirement
      // by asserting a persistent header link ("Login") true on every page
      // regardless of state, then never completed the rest of the goal.
      // Prompt guidance alone (buildActionPrompt's assertionQualityNote)
      // was live-retested and did NOT change this — same "wording alone
      // doesn't reliably work" lesson as parsePlan's immediate-done
      // rejection — so this closes the gap mechanically instead. Scoped to
      // assert_page_text only (the exact reproduced vector): assert_visible/
      // assert_text are ref-based and already covered by the narrower
      // `recentlyInteracted` tautology guard at parse time. Still recorded
      // as a real, correctly-executed `ok: true` step below — the check
      // genuinely passed, and the generated spec should faithfully replay
      // it — only withheld from the confirmation-gate credit.
      const isTautologicalPageText =
        action.action === 'assert_page_text' && result.ok && baselineBodyText.includes(substitutePlaceholders(action.expectedText, options.credentials))
      // The mirror-image gap for the negative case, arguably more important
      // than the positive one: without this, a model could "confirm" a
      // deletion/removal it never actually attempted just by asserting the
      // absence of text that was never on the page to begin with (the
      // baseline, captured before any action this run, already never
      // contained it) — a trivially-true check that proves nothing about
      // whether the goal's actual removal step worked.
      const isTautologicalPageTextAbsent =
        action.action === 'assert_page_text_absent' && result.ok && !baselineBodyText.includes(substitutePlaceholders(action.expectedText, options.credentials))

      // Copied from the pre-action outline (not affected by healing — a
      // heal re-matches within the same frame, never a different one, see
      // browser.ts's own frameChain-equality filter in its healing
      // candidates check) — see ExecutedStep.frameChain's own doc comment
      // for why generateSpec.ts needs this alongside resolvedSelector.
      const frameChain = 'ref' in action ? outline.elements.find((el) => el.ref === action.ref)?.frameChain : undefined

      steps.push({
        step: stepNumber,
        action,
        outline,
        ok: result.ok,
        failureDetail: result.failureDetail,
        screenshotPath: result.screenshotPath,
        domSnapshotPath: result.domSnapshotPath,
        visibleTextPath: result.visibleTextPath,
        healed: result.healed,
        resolvedSelector: result.healedSelector,
        verifiedRoleLocator: result.verifiedRoleLocator,
        frameChain,
        // Absent (not 0) for the overwhelming majority case — see
        // ExecutedStep.pageIndex's own doc comment for why the mere
        // presence of this field is itself a meaningful signal to
        // generateSpec.ts.
        pageIndex: browser.pageIndex || undefined,
      })
      history.push({
        action,
        result: result.ok ? 'ok' : 'failed',
        // A short, generic phrase only when healed — never the raw
        // selector. `detail` is serialized into every subsequent prompt
        // (see `planner.ts`'s `serializeHistory`), so a real DOM attribute
        // value here would leak to the third-party LLM provider on every
        // future turn, the same class of concern already disclosed for API
        // response bodies.
        detail: isTautologicalPageText
          ? 'succeeded, but this exact text was already present before any actions ran this run — does not count as confirmation of anything'
          : isTautologicalPageTextAbsent
            ? 'succeeded, but this exact text was already absent before any actions ran this run — does not count as confirmation of anything'
            : result.ok
              ? result.healed
                ? 'succeeded after healing a stale selector'
                : ''
              : (result.failureDetail ?? 'failed'),
      })

      const isAssertion =
        action.action === 'assert_visible' ||
        action.action === 'assert_text' ||
        action.action === 'assert_value' ||
        action.action === 'assert_page_text' ||
        action.action === 'assert_page_text_absent'
      if (isAssertion && result.ok && !isTautologicalPageText && !isTautologicalPageTextAbsent) {
        if (clauseTrackingActive) {
          // Never trusted blindly — `action.clauseIndex` is the model's own
          // self-declared claim (see `AgentAction`'s doc comment). Requires
          // both a valid in-range index AND `clauseLikelyMatches`'s
          // mechanical keyword-overlap backstop before crediting it, the
          // same "don't trust self-report alone" lesson `isTautologicalPageText`
          // above already applies to a structurally identical problem one
          // level up (a whole compound goal vs. one specific clause of it).
          const declaredIndex = getClauseIndex(action)
          if (
            declaredIndex !== undefined &&
            declaredIndex >= 0 &&
            declaredIndex < clauses.length &&
            clauseLikelyMatches(clauses[declaredIndex], clauseComparisonText(action, outline))
          ) {
            satisfiedClauses.add(declaredIndex)
          }
        } else {
          hasSucceededAssertion = true
          succeededAssertionCount++
        }
      }
      // A click/fill after the last succeeded assertion means the page may
      // have changed since — that assertion no longer necessarily reflects
      // the *current* state, so it can't keep justifying a later done claim.
      // Found via a real, live run: a multi-part goal ("add a record,
      // confirm it appears, edit it, confirm the update") had its first
      // confirm-clause succeed, permanently satisfying this flag, then
      // silently never attempted the second clause — the run still declared
      // goal-reached, since this flag had no way to express "that evidence
      // is now stale." Same condition already used to update
      // lastInteractedElement above — click/fill are the only real
      // state-mutating actions in this engine's vocabulary; scroll/wait
      // don't change app state and must not reset this.
      else if ((action.action === 'click' || action.action === 'fill') && result.ok) hasSucceededAssertion = false
      if (!result.ok && isAssertion) {
        return done({ runId, url: options.url, goal: options.goal, steps, outcome: 'assertion-failed' })
      }
    }

    return done({ runId, url: options.url, goal: options.goal, steps, outcome: 'stopped-by-cap' })
  } finally {
    // A teardown failure (`context.close()`/`browser.close()` throwing
    // inside `AgentBrowser.close()` — a real, if uncommon, possibility: a
    // crashed browser process, an OS-level resource issue) must never
    // overwrite the `result` already computed above. An exception thrown
    // inside a `finally` block silently *replaces* whatever the `try` was
    // about to return — found via a deliberate review of this exact risk
    // (an untested edge case, not a live incident), the same class of bug
    // the story-mode batch-robustness fix closed elsewhere: a run that
    // genuinely reached `goal-reached` could have that entire, hard-won
    // result discarded and replaced with an uncaught exception, purely
    // because browser teardown — completely unrelated to whether the
    // actual goal was achieved — happened to fail. Best-effort here, same
    // posture as `video.path()`'s own try/catch inside `close()` itself.
    try {
      const { videoPath } = await browser.close()
      // `result` is `undefined` only if something above threw rather than
      // returning normally — in that case there's no TestRun to attach a
      // video path to, and this is skipped entirely (no new failure mode).
      if (result && videoPath) result.videoPath = videoPath
    } catch {
      // Teardown failing must never mask the real run outcome above.
    }
  }
}
