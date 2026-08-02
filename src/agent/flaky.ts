import type { RunOutcome } from './types'
import { diffSpecFiles } from './diffSpecs'

/** One `--repeat` iteration's result — engine-agnostic: both `runE2eTest`
 * and `runApiTestCommand` produce this same shape (`specBody` is whatever
 * `generateAgentSpec`/`generateApiSpec` rendered for that iteration, before
 * it's ever written to disk), so `classifyRepeatResults` below has no idea
 * which engine produced it. */
export interface RepeatIterationResult {
  iteration: number
  outcome: RunOutcome
  specBody: string
}

export interface RepeatClassification {
  allGoalReached: boolean
  identicalBodies: boolean
  /** = !allGoalReached || !identicalBodies — this literally IS the
   * `--repeat` CI exit-code rule; a caller doesn't need to re-derive it. */
  flaky: boolean
  /** 1-based iteration numbers whose generated body differs from iteration
   * 1 (the baseline every other iteration is diffed against — a
   * first-vs-rest comparison, O(N) diffs rather than full O(N²) pairwise,
   * since "which ones disagree with the first" is already the actionable
   * signal; knowing iterations 3 and 5 also disagree with each other on
   * top of that wouldn't change what a user does next). */
  differingIterations: number[]
}

/** Classifies a batch of `--repeat N` iterations as flaky or not. Reuses
 * `diffSpecFiles` (the same primitive `five46 diff` itself uses) rather
 * than inventing a second comparison format — "flaky" is defined as
 * literally "the diff isn't empty," so the two features can never
 * independently drift on what counts as a real difference. */
export function classifyRepeatResults(results: RepeatIterationResult[]): RepeatClassification {
  const allGoalReached = results.every((r) => r.outcome === 'goal-reached')
  const baseline = results[0]
  const differingIterations: number[] = []
  for (const r of results.slice(1)) {
    const diff = diffSpecFiles(baseline.specBody, r.specBody)
    if (diff.some((line) => line.type !== 'context')) differingIterations.push(r.iteration)
  }
  const identicalBodies = differingIterations.length === 0
  return { allGoalReached, identicalBodies, flaky: !allGoalReached || !identicalBodies, differingIterations }
}
