/** Shared between `runner.ts` (browser engine) and `apiRunner.ts` (API
 * engine) — both loops are one LLM call per turn, capped the same way, with
 * runs identified the same way. Unlike `actionSignature`/the "stuck
 * repeating" progress semantics (which genuinely differ per engine and stay
 * duplicated on purpose), there is no reason for these to ever diverge. */

/** Default 15, hard-capped at 50 regardless of what a caller passes —
 * bounds worst-case BYOK cost even given an unreasonable `maxSteps`. */
export const DEFAULT_MAX_STEPS = 15
export const HARD_MAX_STEPS = 50

/** Hard cap on `--repeat N` (cli.ts), regardless of what a caller passes —
 * bounds worst-case BYOK cost the same way `HARD_MAX_STEPS` bounds a single
 * run's, but disclosed explicitly when it clamps (unlike `maxSteps`'s own
 * silent clamp): each repeat unit is a whole extra LLM-driven run, a much
 * larger cost multiplier than one extra step, and this is new code with no
 * existing gap to match. */
export const HARD_MAX_REPEAT = 10

/** Hard cap on the number of scenarios `storySplitter.ts` will split a single
 * `--story` into, regardless of what the split-LLM-call returns — bounds
 * worst-case BYOK cost the same way `HARD_MAX_REPEAT` bounds `--repeat`'s (each
 * scenario is a whole extra LLM-driven run), disclosed explicitly when it clamps. */
export const HARD_MAX_SCENARIOS = 10

/** Hard cap on the number of confirm-clauses `clauseSplitter.ts` will split a
 * single goal into, regardless of what the split-LLM-call returns —
 * conceptually distinct from `HARD_MAX_SCENARIOS` (a whole extra run per
 * scenario there; here it's just bookkeeping within one already-running
 * run, so the cost/risk profile doesn't actually match `--repeat`/`--story`'s
 * own reasoning closely enough to reuse the same constant), but the same
 * "bound the worst case, disclose when clamped" posture. A real goal
 * realistically names at most a handful of distinct milestones; a response
 * naming far more than that is far more likely a malformed/hallucinated
 * split than a genuinely enormous goal. */
export const HARD_MAX_CLAUSES = 10

/** Hard cap on how many entries `~/.five46/cache.json` (`config/actionCache.ts`)
 * ever holds — evicted oldest-`cachedAt`-first on write when exceeded (see
 * `cli.ts`'s `--action-cache` handling). Unlike `HARD_MAX_STEPS`/
 * `HARD_MAX_REPEAT`/`HARD_MAX_CLAUSES`, this doesn't bound a single run's
 * worst-case BYOK cost — it bounds an unrelated, unbounded-by-default risk:
 * a long-lived local file that would otherwise grow forever across every
 * distinct (project, goal, url) combination ever run with `--action-cache`
 * on the same machine. */
export const HARD_MAX_CACHE_ENTRIES = 200

/** Bounded-concurrency defaults for running a `--story`'s split-out scenarios.
 * `DEFAULT_CONCURRENCY` (API engine) is faster in aggregate than `--repeat`'s
 * strict sequencing without risking a live-LLM rate-limit storm; several
 * concurrent plain HTTP requests carry a much smaller footprint against a
 * live site than several concurrent real browser sessions do, so
 * `DEFAULT_BROWSER_CONCURRENCY` defaults lower — real live testing this
 * project has done showed multiple concurrent headless-Chromium sessions
 * hitting one origin at once reads as more bot-like than one. Both are only
 * *defaults*: an explicit `--concurrency`/`FIVE46_MCP_CONCURRENCY` still
 * wins, hard-capped at `HARD_MAX_CONCURRENCY` regardless of engine, mirroring
 * `HARD_MAX_STEPS`/`HARD_MAX_REPEAT`'s own clamps. */
export const DEFAULT_CONCURRENCY = 3
export const DEFAULT_BROWSER_CONCURRENCY = 2
export const HARD_MAX_CONCURRENCY = 5

/** Output-token caps per LLM call type — see DEVELOPMENT.md's "Bounding LLM
 * output tokens" section for the sizing rationale. A too-generous cap costs
 * nothing (providers stop naturally at a real end-of-response); a too-tight
 * one risks truncating a legitimate response mid-JSON, which fails parsing
 * exactly like any other unparseable response and is NOT caught by any
 * provider's empty-completion diagnostics (those only fire on a genuinely
 * empty completion, not a truncated-but-non-empty one). Chosen with real
 * margin above the actual prompt schemas (planner.ts/apiPlanner.ts), not
 * guessed — see planner.test.ts's sizing sanity check for PLAN_MAX_OUTPUT_TOKENS. */
/** Raised from an original 400, then 1024, after two real live failures —
 * both against the SAME root cause, just two different severities of it.
 * gemini.ts's own doc comment already names the mechanism: Gemini's
 * "thinking" tokens are drawn from the same `maxOutputTokens` budget as the
 * visible JSON answer, and `thinkingConfig.thinkingBudget: 1` is a hint, not
 * a hard ceiling. The first raise (400 -> 1024) was tuned against
 * `thoughtsTokenCount` in the 33-60 range, observed directly at the time.
 * Re-measured live 2026-08-06 (`gemini-flash-latest` currently resolves to
 * `gemini-3.6-flash`, confirmed via `modelVersion` in the raw response — see
 * gemini.ts's own doc comment on alias drift) against realistic
 * buildActionPrompt output: `thoughtsTokenCount` now ranges roughly 250-980
 * on the exact same task shape, a real 10-15x jump from when 1024 was
 * chosen — not a guess, a live repro that hit `finishReason: "MAX_TOKENS"`
 * and failed to parse at the old cap. Raised again with real margin above
 * that new observed ceiling, same non-guessed sizing standard as
 * PLAN_MAX_OUTPUT_TOKENS itself. */
export const ACTION_MAX_OUTPUT_TOKENS = 3072
/** Scaled up proportionally to ACTION_MAX_OUTPUT_TOKENS's own 2026-08-06
 * re-measurement (see its doc comment) — the same underlying Gemini
 * thinking-token mechanism applies uniformly to every per-step decision
 * call regardless of which engine (browser vs. API) made it; nothing about
 * `apiRunner.ts`'s prompt shape changes that. Kept smaller than
 * ACTION_MAX_OUTPUT_TOKENS, preserving the original relative sizing (an API
 * `request` action's own JSON is typically smaller than a browser action's,
 * even though a request body can occasionally be a real multi-field
 * payload). */
export const API_ACTION_MAX_OUTPUT_TOKENS = 2048
/** Covers an upfront plan of up to HARD_MAX_STEPS (50) step objects. */
export const PLAN_MAX_OUTPUT_TOKENS = 4096
/** A "1-3 sentence hypothesis" plus a short suggestion — see rootCause.ts. */
export const ROOT_CAUSE_MAX_OUTPUT_TOKENS = 600

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
