import type { LlmProvider } from '../llm/types'
import { launchAgentBrowser, snapshot, executeAction } from './browser'
import type { LoginCredentials, StorageState } from './browser'
import { buildActionPrompt, buildPlanPrompt, parseAgentAction, parsePlan, requiresConfirmation, isDestructiveClickTarget, resolvePlannedTarget } from './planner'
import type { AgentAction, AgentPlan, ExecutedStep, HistoryEntry, PageOutline, PlannedStep, TestRun } from './types'
import { DEFAULT_MAX_STEPS, HARD_MAX_STEPS, makeRunId } from './runLoop'

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
  /** Forces the same unverified-success gating `requiresConfirmation(goal)`
   * would trigger, regardless of the goal's exact wording — used by
   * `five46 login`, where an unverified false success is worse than the
   * original bug this gating was built for: it produces a *reusable*
   * session file that would silently mislead every future `test
   * --storage-state` run, not just this one. */
  forceConfirmation?: boolean
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
  /** Default false. When set: one extra upfront `provider.complete()` call
   * plans the whole goal (see `planner.ts`'s `buildPlanPrompt`), and most
   * planned steps then execute directly against a fresh page snapshot with
   * no further LLM call at all — see the dedicated fast-path section in
   * this file. Off by default; the ordinary fully-adaptive loop (every
   * existing behavior/test) is completely unchanged unless this is set. */
  useStructuredPlan?: boolean
}

function actionSignature(action: AgentAction): string {
  switch (action.action) {
    case 'click':
    case 'assert_visible':
      return `${action.action}:${action.ref}`
    case 'fill':
      return `${action.action}:${action.ref}:${action.value}`
    case 'assert_text':
      return `${action.action}:${action.ref}:${action.expectedText}`
    case 'assert_page_text':
      return `assert_page_text:${action.expectedText}`
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
 * When `requiresConfirmation(goal)` is true, a `done`/`goal-reached` claim
 * is rejected (fed back into history, loop continues) unless at least one
 * `assert_visible`/`assert_text` has already succeeded — found via a real,
 * live run (a Shopify demo store, "...then confirm the cart shows an
 * item"): the model added a real item to the cart, then declared
 * goal-reached without ever calling an assertion. The end state happened to
 * be correct, but nothing in the run actually verified it, despite the
 * goal explicitly asking for verification — the same "don't accept an
 * unverified confident claim" posture as everywhere else in this project,
 * applied to the model's own self-reported success. */
export async function runAgent(options: RunAgentOptions): Promise<TestRun> {
  const runId = makeRunId()
  const maxSteps = Math.min(options.maxSteps ?? DEFAULT_MAX_STEPS, HARD_MAX_STEPS)
  const needsConfirmation = options.forceConfirmation || requiresConfirmation(options.goal)
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
  const done = (run: TestRun): TestRun => {
    if (plan) run.planStats = { plannedSteps: plan.steps.length, fastPathedSteps }
    result = run
    return run
  }
  try {
    await browser.page.goto(options.url)
    const baselineState = await browser.context.storageState()

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
      try {
        const initialOutline = await snapshot(browser.page, undefined, true)
        const planRaw = await options.provider.complete(buildPlanPrompt(options.goal, initialOutline), options.apiKey)
        const parsedPlan = parsePlan(planRaw)
        if (parsedPlan.ok) plan = parsedPlan.plan
      } catch {
        // Network failure, provider error, etc. — same "not fatal" posture.
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
        // assert_visible/assert_text never fast-path, full stop — matches
        // self-healing's own explicit, permanent exclusion of assertions
        // exactly, for the identical reason: those are the run's actual
        // verdict, and a structurally-matched-but-wrong target could
        // convert a genuine app regression into a false pass. Only
        // click/fill are attempted below. A planned `assert_page_text` step
        // isn't listed in either branch condition above, so it falls
        // through to the live decision below by construction — the same
        // permanent exclusion, for the same reason.
        if (plannedStep.action === 'click' || plannedStep.action === 'fill') {
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
            action =
              plannedStep.action === 'click'
                ? { action: 'click', ref: candidate.ref, reason: plannedStep.reason }
                : { action: 'fill', ref: candidate.ref, value: plannedStep.value, submit: plannedStep.submit, reason: plannedStep.reason }
            outline = freshOutline
            fastPathedSteps++
          }
          // Zero or multiple candidates: refuse to guess, same as
          // self-healing — falls through to the live decision below.
        }
      }

      if (!action || !outline) {
        // Reached when there's no plan, the plan is exhausted, this step
        // was an assertion (always live), or a click/fill target didn't
        // resolve to exactly one candidate — the exact, unmodified live
        // flow that exists regardless of `useStructuredPlan`.
        //
        // prioritizeViewport: true here (and only here) — self-healing's
        // own re-snapshot call in browser.ts deliberately leaves this off.
        // See snapshot()'s doc comment for why the two must not share this.
        outline = await snapshot(browser.page, undefined, true)
        const planStepNote = plannedStep && plan ? { index: planStepIndex - 1, total: plan.steps.length, step: plannedStep } : undefined
        const prompt = buildActionPrompt(options.goal, history, outline, credentialsAvailable, options.allowDeletes, planStepNote)
        let raw: string
        try {
          raw = await options.provider.complete(prompt, options.apiKey)
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

      if (action.action === 'assert_visible' || action.action === 'assert_text' || action.action === 'assert_page_text') {
        // assert_page_text has no `ref` (that's the whole point — see its
        // own doc comment), so it's tracked by `expectedText` instead,
        // reusing the same "current assertion target" slot rather than a
        // second parallel counter.
        const key = action.action === 'assert_page_text' ? `page-text:${action.expectedText}` : action.ref
        if (key === repeatedAssertionRef) {
          repeatedAssertionCount++
          if (repeatedAssertionCount >= 3) {
            return done({ runId, url: options.url, goal: options.goal, steps, outcome: 'stuck-repeating' })
          }
        } else {
          repeatedAssertionRef = key
          repeatedAssertionCount = 1
        }
      } else if (action.action === 'click' || action.action === 'fill' || action.action === 'scroll' || action.action === 'wait') {
        repeatedAssertionRef = undefined
        repeatedAssertionCount = 0
      }

      if (action.action === 'done') {
        lastActionMadeProgress = false
        const unverifiedSuccess = action.outcome === 'goal-reached' && needsConfirmation && !hasSucceededAssertion
        if (unverifiedSuccess) {
          history.push({
            action,
            result: 'failed',
            detail: 'rejected: this goal asks to confirm/verify something, but no assert_visible/assert_text has succeeded yet — perform one before declaring done',
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
        detail: result.ok ? (result.healed ? 'succeeded after healing a stale selector' : '') : (result.failureDetail ?? 'failed'),
      })

      const isAssertion = action.action === 'assert_visible' || action.action === 'assert_text' || action.action === 'assert_page_text'
      if (isAssertion && result.ok) hasSucceededAssertion = true
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
    const { videoPath } = await browser.close()
    // `result` is `undefined` only if something above threw rather than
    // returning normally — in that case there's no TestRun to attach a
    // video path to, and this is skipped entirely (no new failure mode).
    if (result && videoPath) result.videoPath = videoPath
  }
}
