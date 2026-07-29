/** Shared between `runner.ts` (browser engine) and `apiRunner.ts` (API
 * engine) — both loops are one LLM call per turn, capped the same way, with
 * runs identified the same way. Unlike `actionSignature`/the "stuck
 * repeating" progress semantics (which genuinely differ per engine and stay
 * duplicated on purpose), there is no reason for these to ever diverge. */

/** Default 15, hard-capped at 50 regardless of what a caller passes —
 * bounds worst-case BYOK cost even given an unreasonable `maxSteps`. */
export const DEFAULT_MAX_STEPS = 15
export const HARD_MAX_STEPS = 50

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
