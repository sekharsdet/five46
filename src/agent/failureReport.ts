import type { TestRun } from './types'

export function describeAction(step: TestRun['steps'][number]): string {
  const a = step.action
  switch (a.action) {
    case 'click':
      return `click`
    case 'fill':
      return `fill (${JSON.stringify(a.value)})`
    case 'assert_visible':
      return `assert visible`
    case 'assert_text':
      return `assert text contains ${JSON.stringify(a.expectedText)}`
    case 'assert_page_text':
      return `assert page contains ${JSON.stringify(a.expectedText)}`
    case 'scroll':
      return `scroll ${a.direction}`
    case 'wait':
      return `wait`
    case 'done':
      return `done`
  }
}

/** The step (if any) that actually failed and ended the run — always the
 * *last* step for an `'assertion-failed'` outcome, since `runner.ts`
 * returns immediately the moment an assertion fails. Exported so
 * `rootCause.ts`'s prompt builder and this file's own report can never
 * independently drift on "which step is 'the' failure." */
export function findFailedStep(run: TestRun): TestRun['steps'][number] | undefined {
  return [...run.steps].reverse().find((s) => !s.ok)
}

/** Formats a `TestRun`'s outcome for the console. The one thing this
 * deliberately gets right: an `'assertion-failed'` outcome is printed as a
 * real finding about the app under test, while every other non-
 * `'goal-reached'` outcome (unparseable response, stuck repeating, stopped
 * by cap) is printed as a *tooling* outcome — conflating the two risks a
 * user mistaking a stale-selector/parsing hiccup for a genuine bug report,
 * or dismissing a real assertion failure as "just the agent being flaky."
 *
 * `rootCauseHypothesis`, when passed (see `rootCause.ts`), is an
 * LLM-generated hypothesis about an `'assertion-failed'` outcome — kept as
 * a parameter rather than a `TestRun` field since generating it needs a
 * real network call and this function must stay pure/synchronous;
 * omitting it (the only option before this feature, and still what a
 * caller gets if it chooses not to spend the extra call) falls back to
 * the original "not produced" text unchanged. */
/** A disclosed, never-silent note whenever any step needed self-healing —
 * printed regardless of the run's overall outcome, matching this
 * codebase's "disclose, don't silently paper over" precedent elsewhere
 * (`PageOutline.truncated`, API response-body-truncation disclosure). Only
 * step numbers are listed here, never a raw selector — this text is local
 * console output only (unlike `HistoryEntry.detail`, which flows into the
 * next LLM prompt), so there's no leak concern, but there's also no reason
 * to print a selector a human reading the report doesn't need. */
function healedStepsNote(run: TestRun): string[] {
  const healedSteps = run.steps.filter((s) => s.healed).map((s) => s.step)
  if (healedSteps.length === 0) return []
  return [`Note: step(s) ${healedSteps.join(', ')} needed self-healing — their original selector had gone stale and was automatically re-matched.`]
}

/** Printed on every run when `--record-video` was used — unlike a
 * screenshot (failure-only), a video covers the whole session regardless
 * of outcome, so this is spread into every branch below, not just the
 * failure ones, reusing the exact same always-on-disclosure mechanism
 * `healedStepsNote` already established. */
function videoNote(run: TestRun): string[] {
  return run.videoPath ? [`Video: ${run.videoPath}`] : []
}

/** Printed on every run when `--structured-plan` was used and a plan was
 * actually generated — the efficiency this feature buys (fewer live LLM
 * decisions) is otherwise invisible in the report, since a fast-pathed
 * step produces the exact same `ExecutedStep` shape as a live-decided one.
 * Absent entirely if the planning call itself failed to parse (silently
 * degrades to the ordinary adaptive loop — see `runner.ts`), same
 * always-on-disclosure mechanism as `healedStepsNote`/`videoNote`. */
function planNote(run: TestRun): string[] {
  if (!run.planStats) return []
  const { plannedSteps, fastPathedSteps } = run.planStats
  return [`Structured plan: ${plannedSteps} step(s) planned upfront, ${fastPathedSteps} executed without a live LLM decision.`]
}

export function formatFailureReport(run: TestRun, rootCauseHypothesis?: string): string {
  const lines: string[] = []
  const successCount = run.steps.filter((s) => s.ok).length

  if (run.outcome === 'goal-reached') {
    lines.push(`--- Run ${run.runId} succeeded: goal reached in ${successCount} step(s) ---`, ...healedStepsNote(run), ...videoNote(run), ...planNote(run))
    return lines.join('\n')
  }

  if (run.outcome === 'goal-unreachable') {
    lines.push(`--- Run ${run.runId}: the agent concluded the goal isn't reachable on this page ---`)
    const last = run.steps[run.steps.length - 1]
    if (last) lines.push(`Last completed step: ${describeAction(last)} (${last.ok ? 'ok' : 'failed'})`)
    lines.push(`${successCount} step(s) succeeded before stopping and were written as real code.`, ...healedStepsNote(run), ...videoNote(run), ...planNote(run))
    return lines.join('\n')
  }

  if (run.outcome === 'assertion-failed') {
    const failed = findFailedStep(run)
    lines.push(`--- Run ${run.runId} failed: an assertion did not hold — this is a real finding about the app ---`)
    if (failed) {
      lines.push(`Step ${failed.step}: ${describeAction(failed)}`)
      lines.push(`${failed.failureDetail ?? '(no detail captured)'}`)
      if (failed.screenshotPath) lines.push(`Screenshot: ${failed.screenshotPath}`)
      if (failed.domSnapshotPath) lines.push(`DOM snapshot: ${failed.domSnapshotPath}`)
      if (failed.visibleTextPath) lines.push(`Page's visible text at failure: ${failed.visibleTextPath}`)
    }
    lines.push(
      ``,
      rootCauseHypothesis
        ? `Possible root cause — an LLM-generated hypothesis, not a confirmed diagnosis:\n${rootCauseHypothesis}`
        : `No root-cause hypothesis or suggested fix in this version — that's a real,\ndeferred capability, not silently omitted.`,
      `${successCount} step(s) before this succeeded and were written as real, runnable code.`,
      ...healedStepsNote(run),
      ...videoNote(run), ...planNote(run)
    )
    return lines.join('\n')
  }

  // Everything below is a tooling outcome, not a finding about the app.
  if (run.outcome === 'unparseable-response') {
    lines.push(`--- Run ${run.runId} stopped: the LLM's response couldn't be safely parsed (tooling issue, not a finding about the app) ---`)
    lines.push(`Raw response: ${run.unparseableResponse ?? '(none captured)'}`)
  } else if (run.outcome === 'stuck-repeating') {
    lines.push(`--- Run ${run.runId} stopped: the agent repeated the same action twice in a row (tooling issue, not a finding about the app) ---`)
  } else if (run.outcome === 'stopped-by-cap') {
    lines.push(`--- Run ${run.runId} stopped: reached the step limit before finishing (tooling issue, not a finding about the app) ---`)
  } else if (run.outcome === 'provider-unavailable') {
    lines.push(`--- Run ${run.runId} stopped: the LLM provider became unavailable mid-run (tooling issue, not a finding about the app) ---`)
    lines.push(`Error: ${run.providerError ?? '(no detail captured)'}`)
  }
  lines.push(`${successCount} step(s) succeeded before stopping and were written as real code.`, ...healedStepsNote(run), ...videoNote(run), ...planNote(run))
  return lines.join('\n')
}
