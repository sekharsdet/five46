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

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
