import type { LlmProvider } from '../llm/types'
import { launchAgentBrowser, snapshot, executeAction } from './browser'
import type { LoginCredentials, StorageState } from './browser'
import { buildActionPrompt, parseAgentAction, requiresConfirmation, isDestructiveClickTarget } from './planner'
import type { AgentAction, ExecutedStep, HistoryEntry, TestRun } from './types'
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

  const browser = await launchAgentBrowser({ headless: options.headless, storageState: options.storageState })
  try {
    await browser.page.goto(options.url)
    const baselineState = await browser.context.storageState()

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

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      const outline = await snapshot(browser.page)
      const prompt = buildActionPrompt(options.goal, history, outline, credentialsAvailable, options.allowDeletes)
      const raw = await options.provider.complete(prompt, options.apiKey)
      const parsed = parseAgentAction(raw, outline, options.allowDeletes ?? false)

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
        return { runId, url: options.url, goal: options.goal, steps, outcome: 'unparseable-response', unparseableResponse: parsed.raw }
      }

      const { action } = parsed

      const signature = actionSignature(action)
      if (signature === lastSignature && lastActionMadeProgress) {
        repeatCount = 0
      } else if (signature === lastSignature) {
        repeatCount++
        if (repeatCount >= 2) {
          return { runId, url: options.url, goal: options.goal, steps, outcome: 'stuck-repeating' }
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
            detail: 'rejected: this goal asks to confirm/verify something, but no assert_visible/assert_text has succeeded yet — perform one before declaring done',
          })
          continue
        }
        if (action.outcome === 'goal-reached') {
          await options.onGoalReached?.(browser.context, baselineState)
        }
        return { runId, url: options.url, goal: options.goal, steps, outcome: action.outcome }
      }

      if (action.action === 'click' && options.allowDeletes) {
        const name = outline.elements.find((el) => el.ref === action.ref)?.name ?? ''
        if (isDestructiveClickTarget(name)) options.onDestructiveClick?.(name, action.reason)
      }

      const result = await executeAction(browser.page, action, outline, options.artifactDir, stepNumber, options.credentials)
      lastActionMadeProgress = (action.action === 'click' || action.action === 'fill') && result.ok
      steps.push({
        step: stepNumber,
        action,
        outline,
        ok: result.ok,
        failureDetail: result.failureDetail,
        screenshotPath: result.screenshotPath,
        domSnapshotPath: result.domSnapshotPath,
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

      const isAssertion = action.action === 'assert_visible' || action.action === 'assert_text'
      if (isAssertion && result.ok) hasSucceededAssertion = true
      if (!result.ok && isAssertion) {
        return { runId, url: options.url, goal: options.goal, steps, outcome: 'assertion-failed' }
      }
    }

    return { runId, url: options.url, goal: options.goal, steps, outcome: 'stopped-by-cap' }
  } finally {
    await browser.close()
  }
}
