import type { LlmProvider } from '../llm/types'
import { PLAN_MAX_OUTPUT_TOKENS, HARD_MAX_CLAUSES } from './runLoop'

/** Builds the "split this goal into its distinct confirm-worthy milestones"
 * prompt — same call-shape class as `buildStorySplitPrompt` (storySplitter.ts)
 * and `buildPlanPrompt` (planner.ts), a one-time upfront call made only when
 * `countConfirmationClauses(goal)` (planner.ts) already found 2+ confirm-
 * language occurrences (see `runner.ts`/`apiRunner.ts` — this is deliberately
 * never called for the common single/zero-clause case, keeping this feature's
 * cost at zero extra LLM calls for the overwhelming majority of goals).
 * Deliberately never asks the model to invent a milestone the goal doesn't
 * already describe or imply — only to identify and separate the ones already
 * there, the same "clarify, don't add coverage" posture `buildStorySplitPrompt`
 * already established for a structurally identical problem one level up
 * (splitting a whole story into goals, vs. splitting one goal into clauses). */
export function buildClauseSplitPrompt(goal: string): string {
  return [
    `You are preparing a goal for a web/API testing agent that will need to prove EACH of its distinct milestones was actually verified, not just that some assertion succeeded somewhere.`,
    ``,
    `Identify each distinct, independently-verifiable confirm/check milestone described in the goal below, and rewrite each one as a short, standalone description of what must be true (e.g. "the cart shows at least 1 item", "a login field is visible"). Preserve the goal's own order. Never invent a milestone that isn't actually described or implied by the goal — only identify and clarify what's already there. If the goal only really describes one milestone to confirm, return just that one.`,
    ``,
    `Goal:`,
    goal,
    ``,
    `Respond with exactly one JSON object: {"clauses": ["<clause 1>", "<clause 2>", ...]}`,
    ``,
    `Respond with ONLY the JSON object — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

export type ParseClauseSplitResult = { ok: true; clauses: string[] } | { ok: false; error: string; raw: string }

/** Strictly parses a clause-split response — mirrors `parseStorySplit`'s
 * shape and "malformed is not fatal" posture exactly. The caller
 * (`splitConfirmationClauses` below) treats any parse failure as "this goal
 * is just one clause," which deactivates per-clause tracking entirely and
 * falls back to today's existing scalar `Math.max(1, countConfirmationClauses(goal))`
 * gate — a caller must never end up worse off than before this feature existed. */
export function parseClauseSplit(raw: string): ParseClauseSplitResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, error: 'clause split response was not valid JSON', raw }
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).clauses)) {
    return { ok: false, error: 'clause split response was not a JSON object with a "clauses" array', raw }
  }

  const clauses = (parsed as { clauses: unknown[] }).clauses.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
  if (clauses.length === 0) return { ok: false, error: 'clause split response contained no non-empty clauses', raw }
  return { ok: true, clauses }
}

/** Splits a goal into its distinct confirm-worthy clauses — one LLM call,
 * never fatal. Any failure (a network/provider error, a malformed response,
 * an empty result) degrades to `[goal]`: a single clause, which the caller
 * treats identically to "this goal has no compound structure worth tracking
 * per-clause" — see this file's other doc comments for why that's always a
 * safe, no-worse-off-than-today fallback. A response naming more than
 * `HARD_MAX_CLAUSES` clauses is clamped, not rejected outright, same
 * "bound worst-case, disclose when clamped" pattern `splitUserStory` already
 * established for `HARD_MAX_SCENARIOS`. */
export async function splitConfirmationClauses(goal: string, provider: LlmProvider, apiKey: string): Promise<{ clauses: string[]; clamped: boolean }> {
  const trimmedGoal = goal.trim()
  if (!trimmedGoal) return { clauses: [goal], clamped: false }

  let raw: string
  try {
    raw = await provider.complete(buildClauseSplitPrompt(trimmedGoal), apiKey, { maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS })
  } catch {
    return { clauses: [trimmedGoal], clamped: false }
  }

  const result = parseClauseSplit(raw)
  if (!result.ok) return { clauses: [trimmedGoal], clamped: false }

  if (result.clauses.length > HARD_MAX_CLAUSES) {
    return { clauses: result.clauses.slice(0, HARD_MAX_CLAUSES), clamped: true }
  }
  return { clauses: result.clauses, clamped: false }
}
