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
 * guess at what the model probably meant. */
export type RunOutcome = 'goal-reached' | 'goal-unreachable' | 'stuck-repeating' | 'stopped-by-cap' | 'unparseable-response' | 'assertion-failed'

/** One step the agent decided to take. `ref` (when present) must be a ref
 * from the *same* PageOutline the action was decided against — the caller
 * is responsible for validating this before execution (see
 * `parseAgentAction`). `fill`'s optional `submit` presses Enter afterward,
 * covering the extremely common "type into a field, hit enter" flow
 * without a whole separate action type. */
export type AgentAction =
  | { action: 'click'; ref: string; reason: string }
  | { action: 'fill'; ref: string; value: string; submit?: boolean; reason: string }
  | { action: 'assert_visible'; ref: string; reason: string }
  | { action: 'assert_text'; ref: string; expectedText: string; reason: string }
  /** Scrolls the whole page (`window`) by one viewport height — never a
   * specific nested scroll container (a modal's internal `overflow:auto`
   * region, say). No `ref`: unlike every other action, this doesn't target
   * a specific element, only a direction. */
  | { action: 'scroll'; direction: 'up' | 'down'; reason: string }
  | { action: 'done'; outcome: 'goal-reached' | 'goal-unreachable' | 'stuck-repeating'; reason: string }

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
  /** Populated when `RunAgentOptions.recordVideo` was set and the
   * recording was actually finalized — see `browser.ts`'s
   * `AgentBrowser.close()`. `ApiTestRun` has no equivalent field: no
   * browser, structurally impossible to record a video of. */
  videoPath?: string
}
