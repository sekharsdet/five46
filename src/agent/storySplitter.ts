import type { LlmProvider } from '../llm/types'
import { PLAN_MAX_OUTPUT_TOKENS, HARD_MAX_SCENARIOS } from './runLoop'

/** Builds the "split this raw user story into independent goals" prompt —
 * a one-time upfront call, same call-shape class as `buildPlanPrompt`
 * (planner.ts), made once per `--story` run before anything else happens.
 * Deliberately never asks the model to invent new acceptance criteria, only
 * to identify and rewrite the ones already present — the whole point is to
 * preserve the developer's own intent, not add coverage they didn't ask for. */
export function buildStorySplitPrompt(story: string): string {
  return [
    `You are preparing a raw user story (which may bundle several acceptance criteria together) to be tested one scenario at a time by a web/API testing agent.`,
    ``,
    `Identify each distinct, independently-testable scenario described in the story below, and rewrite each one as a single, clear, standalone, actionable goal in an imperative style (e.g. "log in with valid credentials and confirm the dashboard is shown"). Treat mutually-exclusive variations of the same flow (e.g. a valid case and an invalid case) as SEPARATE goals, since they cannot both happen in one run. Never invent a new scenario or criterion that isn't actually described or implied by the story — only identify and clarify what's already there. If the story only really describes one scenario, return just that one goal.`,
    ``,
    `Story:`,
    story,
    ``,
    `Respond with exactly one JSON object: {"goals": ["<goal 1>", "<goal 2>", ...]}`,
    ``,
    `Respond with ONLY the JSON object — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

export type ParseStorySplitResult = { ok: true; goals: string[] } | { ok: false; error: string; raw: string }

/** Strictly parses a split response — mirrors `parsePlan`'s shape and
 * "malformed is not fatal" posture exactly, but the fallback here is even
 * simpler: the caller (`splitUserStory` below) treats any parse failure as
 * "this story is just one goal," which is *already* today's entire existing
 * behavior with no story-splitting at all. A caller who opts into `--story`
 * for convenience must never end up worse off than not using it. */
export function parseStorySplit(raw: string): ParseStorySplitResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, error: 'split response was not valid JSON', raw }
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).goals)) {
    return { ok: false, error: 'split response was not a JSON object with a "goals" array', raw }
  }

  const goals = (parsed as { goals: unknown[] }).goals.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim())
  if (goals.length === 0) return { ok: false, error: 'split response contained no non-empty goals', raw }
  return { ok: true, goals }
}

/** Splits a raw user story into one or more independent, standalone goals —
 * one LLM call, never fatal. Any failure (a network/provider error, a
 * malformed response, an empty result) degrades to `[story]`: the whole
 * story text treated as a single goal, identical to today's existing
 * behavior with no splitting at all. A response naming more than
 * `HARD_MAX_SCENARIOS` goals is clamped, not rejected outright — same
 * "bound worst-case BYOK cost, disclose when clamped" pattern `--repeat`
 * already established for `HARD_MAX_REPEAT`. */
export async function splitUserStory(story: string, provider: LlmProvider, apiKey: string): Promise<{ goals: string[]; clamped: boolean }> {
  const trimmedStory = story.trim()
  if (!trimmedStory) return { goals: [story], clamped: false }

  let raw: string
  try {
    raw = await provider.complete(buildStorySplitPrompt(trimmedStory), apiKey, { maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS })
  } catch {
    return { goals: [trimmedStory], clamped: false }
  }

  const result = parseStorySplit(raw)
  if (!result.ok) return { goals: [trimmedStory], clamped: false }

  if (result.goals.length > HARD_MAX_SCENARIOS) {
    return { goals: result.goals.slice(0, HARD_MAX_SCENARIOS), clamped: true }
  }
  return { goals: result.goals, clamped: false }
}
