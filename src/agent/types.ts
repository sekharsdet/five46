/** One visible, interactive element found on the page during a single
 * snapshot. `ref` is an opaque handle scoped to *this* snapshot only — the
 * LLM picks a `ref`, never authors a selector itself, so a hallucinated or
 * stale ref is a cheap parse-level failure (see `planner.ts`'s
 * `parseAgentAction`) instead of a confidently-wrong click somewhere in the
 * real page. */
export interface OutlineElement {
  ref: string
  tag: string
  role: string
  name: string
  /** The real, already-resolved Playwright selector for this element,
   * computed once at snapshot time in `browser.ts` — never reconstructed
   * from the LLM's own guess. */
  selector: string
}

/** The result of one `snapshot()` call. `truncated` discloses capping
 * explicitly: capping silently would let the agent make decisions on an
 * incomplete picture of the page without ever knowing that happened. */
export interface PageOutline {
  elements: OutlineElement[]
  truncated: boolean
  totalFound: number
}

/** How any agent run (browser-driven or API-driven) can end — shared so the
 * two engines' outcome vocabulary can't independently drift into two
 * near-identical copies. `'stopped-by-cap'` means the step budget ran out
 * before the agent reached `done` — a real, honest outcome, not hidden
 * behind a generic failure. `'unparseable-response'` means the LLM's
 * response couldn't be safely parsed on some step — stop and say so, never
 * guess at what the model probably meant. `'provider-unavailable'` means a
 * live per-step decision call itself never returned a response at all —
 * distinct from `'unparseable-response'` (which got a response, just an
 * unusable one) — after `llm/retry.ts`'s own retry budget (4 attempts) was
 * already exhausted. Found via a real, live run that hit a sustained
 * Gemini 503 patch: before this outcome existed, that error propagated
 * all the way out of `runAgent`/`runApiTest` uncaught, discarding every
 * step already completed — a caller opting into more steps or
 * `--structured-plan` must never end up *worse off* than a plain failure
 * for having tried, the same posture already applied to a malformed plan
 * response. */
export type RunOutcome = 'goal-reached' | 'goal-unreachable' | 'stuck-repeating' | 'stopped-by-cap' | 'unparseable-response' | 'assertion-failed' | 'provider-unavailable'

/** One step the agent decided to take. `ref` (when present) must be a ref
 * from the *same* PageOutline the action was decided against — the caller
 * is responsible for validating this before execution (see
 * `parseAgentAction`). `fill`'s optional `submit` presses Enter afterward,
 * covering the extremely common "type into a field, hit enter" flow
 * without a whole separate action type. An assertion's optional
 * `clauseIndex` is the model's own self-declared claim about which of the
 * goal's confirm-clauses (see `clauseSplitter.ts`) this assertion is
 * meant to satisfy — only ever present/consulted when the run actually
 * split the goal into more than one clause (`runner.ts`/`apiRunner.ts`);
 * absent or out-of-range simply means the step still executes for real
 * but doesn't count toward per-clause coverage. Never trusted blindly —
 * `planner.ts`'s `clauseLikelyMatches` is a mechanical backstop against a
 * clearly mismatched claim, the same "never trust self-report alone"
 * posture the `baselineBodyText` tautology guard already established. */
export type AgentAction =
  | { action: 'click'; ref: string; reason: string }
  | { action: 'fill'; ref: string; value: string; submit?: boolean; reason: string }
  | { action: 'assert_visible'; ref: string; reason: string; clauseIndex?: number }
  | { action: 'assert_text'; ref: string; expectedText: string; reason: string; clauseIndex?: number }
  /** Checks the *whole rendered page*'s visible text for a substring — no
   * `ref`, unlike every other assertion. Added alongside `wait` after the
   * same real, live gap: `snapshot()`'s outline only ever includes
   * `button, a, input, select, textarea, [role]` (see `browser.ts`), so a
   * plain `<h4>`/`<div>`/`<p>` success message with no ARIA role — a
   * genuinely common real-world pattern, confirmed on
   * `the-internet.herokuapp.com`'s own dynamic-loading demo (`<h4>Hello
   * World!</h4>`, no `role` attribute at all) — can never appear as an
   * assertable `ref`, no matter how long the model waits for it. This is
   * the fallback for exactly that case: it searches rendered page text
   * directly, the same thing `page.getByText()`/`toContainText()` on
   * `body` does in idiomatic Playwright, rather than requiring the target
   * to be one of the interactive elements the outline was built to list
   * for *acting on*, not for *reading*. */
  | { action: 'assert_page_text'; expectedText: string; reason: string; clauseIndex?: number }
  /** Scrolls the whole page (`window`) by one viewport height — never a
   * specific nested scroll container (a modal's internal `overflow:auto`
   * region, say). No `ref`: unlike every other action, this doesn't target
   * a specific element, only a direction. */
  | { action: 'scroll'; direction: 'up' | 'down'; reason: string }
  /** Pauses for a fixed, server-controlled duration (`browser.ts`'s
   * `WAIT_ACTION_MS`) — never a model-supplied number, matching this
   * codebase's "never trust the model with a raw magic number when a fixed
   * default suffices" posture (the same reasoning behind the hardcoded 5s
   * click/fill timeouts). Added after a real, live gap: a page whose target
   * content only appears after an async delay (a loading spinner with no
   * XHR — `page.waitForLoadState('networkidle')` would resolve immediately
   * and not actually help) left the model with no tool to use except
   * scrolling, which doesn't advance time; it scrolled twice, found nothing
   * new, and gave up declaring the goal unreachable. No `ref`, same as
   * `scroll` — this doesn't target an element either. */
  | { action: 'wait'; reason: string }
  | { action: 'done'; outcome: 'goal-reached' | 'goal-unreachable' | 'stuck-repeating'; reason: string }

/** A prediction, not a verified reference — the planning call (see
 * `planner.ts`'s `buildPlanPrompt`) sees only the *first* page's outline,
 * so a step targeting a later page can only describe what it *expects* to
 * find there. `role` is required (not optional) whenever a target is
 * needed: role is a genuinely strong discriminator (see `browser.ts`'s
 * `roleOf()`), and a target is inherently uncertain already — allowing
 * name-only matching would make the fast-path resolution below too weak
 * to trust. Execution resolves this against a *fresh* snapshot taken right
 * before the step runs (see `runner.ts`), exactly one candidate or it
 * falls back to a live decision — never a guess. */
export interface PlannedStepTarget {
  role: string
  nameContains: string
}

/** One step of an upfront plan (`buildPlanPrompt`/`parsePlan`) — mirrors
 * `AgentAction`'s shape but with `target` (a prediction) in place of `ref`
 * (a verified, this-turn-only reference), since a plan step decided before
 * any of its own page state existed cannot possibly hold a real ref. */
export type PlannedStep =
  | { action: 'click'; target: PlannedStepTarget; reason: string }
  | { action: 'fill'; target: PlannedStepTarget; value: string; submit?: boolean; reason: string }
  | { action: 'assert_visible'; target: PlannedStepTarget; reason: string; clauseIndex?: number }
  | { action: 'assert_text'; target: PlannedStepTarget; expectedText: string; reason: string; clauseIndex?: number }
  | { action: 'assert_page_text'; expectedText: string; reason: string; clauseIndex?: number }
  | { action: 'scroll'; direction: 'up' | 'down'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'done'; outcome: 'goal-reached' | 'goal-unreachable'; reason: string }

export interface AgentPlan {
  steps: PlannedStep[]
}

/** Whether login credentials are configured — *presence only*, never the
 * actual values. Passed to `planner.ts`'s `buildActionPrompt` specifically
 * as booleans (not the real `LoginCredentials` from `browser.ts`) so that
 * function is structurally incapable of leaking a secret into a prompt
 * string, regardless of what else changes inside it later. */
export interface CredentialAvailability {
  username: boolean
  password: boolean
}

/** One completed turn of the loop, kept in `history` and fed back into the
 * next turn's prompt (bounded — see `buildActionPrompt`). */
export interface HistoryEntry {
  action: AgentAction
  result: 'ok' | 'failed'
  /** Short, human-readable outcome description — e.g. "clicked", "element
   * not visible", "assertion failed: expected X, got Y" — not the full
   * error object, to keep prompt size bounded. */
  detail: string
}

/** One step as actually executed, with everything needed to either write it
 * into a generated `.spec.ts` (on success) or a failure report (on
 * failure). */
export interface ExecutedStep {
  step: number
  action: AgentAction
  outline: PageOutline
  ok: boolean
  /** Present only when `ok` is false. */
  failureDetail?: string
  screenshotPath?: string
  domSnapshotPath?: string
  /** Present only when `ok` is false — a local `.txt` file holding the
   * page's actual rendered text at the moment of failure, for a human to
   * open directly (see `browser.ts`'s `StepExecutionResult.visibleTextPath`
   * doc comment for the full reasoning, including why this is a file never
   * fed into any LLM prompt: `outline` above is scoped to *interactive*
   * elements only and can be near-empty on a fully-rendered, content-rich
   * page, which previously caused a real root-cause hypothesis to wrongly
   * call a working page "blank"). */
  visibleTextPath?: string
  /** Present only when this step's original selector had gone stale (0
   * matches) and a fresh re-match by (tag, role, name) found exactly one
   * unambiguous replacement. `generateSpec.ts` must prefer this over its
   * normal ref→outline lookup — that lookup would otherwise still resolve
   * to the now-known-stale selector, since `outline` above is this step's
   * pre-action snapshot, not the fresh one healing re-derived from. */
  resolvedSelector?: string
  /** True exactly when `resolvedSelector` is present — kept as an explicit
   * boolean (not just "check resolvedSelector is defined") so a reader or
   * the printed report can key off intent rather than an implementation
   * detail of which field happens to be populated. */
  healed?: boolean
  /** Present only when `browser.ts`'s `verifyRoleLocator()` confirmed,
   * live, that `page.getByRole(role, { name })` resolves uniquely to the
   * exact same element this step actually acted on — mirrors
   * `StepExecutionResult.verifiedRoleLocator` (`browser.ts`) exactly.
   * `generateSpec.ts` prefers this over the raw `selector`/
   * `resolvedSelector` above when present, since a `getByRole` locator is
   * far more resilient to future DOM restructuring than a positional CSS
   * path — never used for anything during the live run itself, which
   * always already used the guaranteed-correct selector regardless. */
  verifiedRoleLocator?: { role: string; name: string }
}

/** The full record of one `runAgent()` call — the single source of truth
 * both `generateSpec.ts` and `failureReport.ts` render from. */
export interface TestRun {
  runId: string
  url: string
  goal: string
  steps: ExecutedStep[]
  outcome: RunOutcome
  /** Populated when `outcome` is `'unparseable-response'` — the raw text
   * that failed to parse, kept for the failure report. */
  unparseableResponse?: string
  /** Populated when `outcome` is `'provider-unavailable'` — the underlying
   * error's message, after `llm/retry.ts`'s own retry budget was already
   * exhausted. See `RunOutcome`'s own doc comment for the full reasoning. */
  providerError?: string
  /** Populated when `RunAgentOptions.recordVideo` was set and the
   * recording was actually finalized — see `browser.ts`'s
   * `AgentBrowser.close()`. `ApiTestRun` has no equivalent field: no
   * browser, structurally impossible to record a video of. */
  videoPath?: string
  /** Populated when `RunAgentOptions.useStructuredPlan` was set and a plan
   * was actually generated (absent if the planning call itself failed to
   * parse — that degrades silently to the ordinary adaptive loop for the
   * whole run, see `runner.ts`). `plannedSteps` is the plan's own length;
   * `fastPathedSteps` is how many of `steps` executed without a live LLM
   * decision — the efficiency this feature actually buys, disclosed rather
   * than left for a reader to infer from step count alone. */
  planStats?: { plannedSteps: number; fastPathedSteps: number }
}
