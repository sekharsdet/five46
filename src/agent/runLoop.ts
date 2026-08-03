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

/** Output-token caps per LLM call type — see DEVELOPMENT.md's "Bounding LLM
 * output tokens" section for the sizing rationale. A too-generous cap costs
 * nothing (providers stop naturally at a real end-of-response); a too-tight
 * one risks truncating a legitimate response mid-JSON, which fails parsing
 * exactly like any other unparseable response and is NOT caught by any
 * provider's empty-completion diagnostics (those only fire on a genuinely
 * empty completion, not a truncated-but-non-empty one). Chosen with real
 * margin above the actual prompt schemas (planner.ts/apiPlanner.ts), not
 * guessed — see planner.test.ts's sizing sanity check for PLAN_MAX_OUTPUT_TOKENS. */
/** Raised from an original 400 after a real live failure: even with Gemini's
 * `thinkingBudget: 1` (gemini.ts), thinking-token usage still has real
 * variance on a realistic prompt (33-60+ tokens observed, confirmed via
 * direct calls) — occasionally enough to truncate a legitimate response mid-JSON
 * at 400. Raised to match the shared 1024 fallback every provider already
 * uses when a caller omits maxOutputTokens entirely, removing the
 * Gemini-fragile special case rather than tuning it tighter. */
export const ACTION_MAX_OUTPUT_TOKENS = 1024
/** Larger than the browser engine's action cap: an API `request` action can
 * carry a real request body (e.g. a multi-field JSON payload for a POST),
 * meaningfully bigger than a browser action's `{"action":"click","ref":"e3",...}`. */
export const API_ACTION_MAX_OUTPUT_TOKENS = 800
/** Covers an upfront plan of up to HARD_MAX_STEPS (50) step objects. */
export const PLAN_MAX_OUTPUT_TOKENS = 4096
/** A "1-3 sentence hypothesis" plus a short suggestion — see rootCause.ts. */
export const ROOT_CAUSE_MAX_OUTPUT_TOKENS = 600

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
