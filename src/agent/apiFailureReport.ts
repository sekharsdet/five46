import type { ApiTestRun } from './apiTypes'
import { describeApiAction } from './apiPlanner'

/** Mirrors `failureReport.ts`'s `findFailedStep` exactly, for the same
 * reason — exported so `apiRootCause.ts`'s prompt builder and this file's
 * own report can never independently drift on "which step is 'the'
 * failure." */
export function findFailedApiStep(run: ApiTestRun): ApiTestRun['steps'][number] | undefined {
  return [...run.steps].reverse().find((s) => !s.ok)
}

/** Mirrors `failureReport.ts`'s `planNote` exactly — see its own doc
 * comment. Printed on every run when `--structured-plan` was used and a
 * plan was actually adopted. */
function planNote(run: ApiTestRun): string[] {
  if (!run.planStats) return []
  const { plannedSteps, fastPathedSteps } = run.planStats
  return [`Structured plan: ${plannedSteps} step(s) planned upfront, ${fastPathedSteps} executed without a live LLM decision.`]
}

/** Formats an `ApiTestRun`'s outcome for the console — the API-testing
 * counterpart to `failureReport.ts`'s `formatFailureReport`, same posture:
 * an `'assertion-failed'` outcome is a real finding about the API under
 * test; every other non-`'goal-reached'` outcome is a tooling outcome, kept
 * visibly separate so a stale-{{var}}/parsing hiccup never gets mistaken
 * for a genuine bug report (or vice versa).
 *
 * `rootCauseHypothesis` mirrors `formatFailureReport`'s identical
 * parameter — see that file's doc comment for why it's a parameter, not an
 * `ApiTestRun` field. */
export function formatApiFailureReport(run: ApiTestRun, rootCauseHypothesis?: string): string {
  const lines: string[] = []
  const successCount = run.steps.filter((s) => s.ok).length

  if (run.outcome === 'goal-reached') {
    lines.push(`--- Run ${run.runId} succeeded: goal reached in ${successCount} step(s) ---`, ...planNote(run))
    return lines.join('\n')
  }

  if (run.outcome === 'goal-unreachable') {
    lines.push(`--- Run ${run.runId}: the agent concluded the goal isn't reachable against this API ---`)
    const last = run.steps[run.steps.length - 1]
    if (last) lines.push(`Last completed step: ${describeApiAction(last.action)} (${last.ok ? 'ok' : 'failed'})`)
    lines.push(`${successCount} step(s) succeeded before stopping and were written as real code.`, ...planNote(run))
    return lines.join('\n')
  }

  if (run.outcome === 'assertion-failed') {
    const failed = findFailedApiStep(run)
    lines.push(`--- Run ${run.runId} failed: an assertion did not hold — this is a real finding about the API ---`)
    if (failed) {
      lines.push(`Step ${failed.step}: ${describeApiAction(failed.action)}`)
      lines.push(`${failed.failureDetail ?? '(no detail captured)'}`)
    }
    lines.push(
      ``,
      rootCauseHypothesis
        ? `Possible root cause — an LLM-generated hypothesis, not a confirmed diagnosis:\n${rootCauseHypothesis}`
        : `No root-cause hypothesis or suggested fix in this version — that's a real,\ndeferred capability, not silently omitted.`,
      `${successCount} step(s) before this succeeded and were written as real, runnable code.`,
      ...planNote(run)
    )
    return lines.join('\n')
  }

  // Everything below is a tooling outcome, not a finding about the API.
  if (run.outcome === 'unparseable-response') {
    lines.push(`--- Run ${run.runId} stopped: the LLM's response couldn't be safely parsed (tooling issue, not a finding about the API) ---`)
    lines.push(`Raw response: ${run.unparseableResponse ?? '(none captured)'}`)
  } else if (run.outcome === 'stuck-repeating') {
    lines.push(`--- Run ${run.runId} stopped: the agent repeated the same action twice in a row (tooling issue, not a finding about the API) ---`)
  } else if (run.outcome === 'stopped-by-cap') {
    lines.push(`--- Run ${run.runId} stopped: reached the step limit before finishing (tooling issue, not a finding about the API) ---`)
  } else if (run.outcome === 'provider-unavailable') {
    lines.push(`--- Run ${run.runId} stopped: the LLM provider became unavailable mid-run (tooling issue, not a finding about the API) ---`)
    lines.push(`Error: ${run.providerError ?? '(no detail captured)'}`)
  }
  lines.push(`${successCount} step(s) succeeded before stopping and were written as real code.`, ...planNote(run))
  return lines.join('\n')
}
