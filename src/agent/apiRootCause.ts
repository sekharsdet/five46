import type { LlmProvider } from '../llm/types'
import type { ApiHistoryEntry, ApiTestRun } from './apiTypes'
import { describeApiAction, serializeApiHistory } from './apiPlanner'
import { findFailedApiStep } from './apiFailureReport'
import { ROOT_CAUSE_MAX_OUTPUT_TOKENS } from './runLoop'

/** API-engine counterpart to `rootCause.ts`'s `buildRootCausePrompt` — see
 * that file's doc comment for the full exposure-fix reasoning this mirrors.
 * The one API-specific risk, verified directly against `apiExecutor.ts`:
 * `assert_json_path_equals`'s `failureDetail` embeds the real, extracted
 * response value, raw, independent of the capped `responseBodyExcerpt` —
 * a live value never previously disclosed to the LLM, for the identical
 * "the run ends before a next turn could serialize it" reason as the
 * browser engine's `assert_text`. `describeApiAction` itself is safe (only
 * echoes `action.expected`, the model's own prior output); the live
 * mismatched value is deliberately excluded instead. Every other assertion
 * type's `failureDetail` (`assert_status`, `assert_json_path_exists`) was
 * checked and only ever references a status code or the action's own path
 * — safe as-is. */
export function buildApiRootCausePrompt(run: ApiTestRun): string | undefined {
  const failed = findFailedApiStep(run)
  if (!failed) return undefined

  const priorHistory: ApiHistoryEntry[] = run.steps
    .filter((s) => s.step !== failed.step)
    .map((s) => ({
      action: s.action,
      result: s.ok ? 'ok' : 'failed',
      detail: s.ok
        ? `status ${s.responseStatus ?? '(none)'}${s.responseBodyExcerpt ? `, body: ${s.responseBodyExcerpt}` : ''}`
        : (s.failureDetail ?? 'failed'),
    }))

  const failureSummary =
    failed.action.action === 'assert_json_path_equals'
      ? `${describeApiAction(failed.action)} — the actual value did not match (the specific mismatched value is intentionally excluded from this analysis; it was never sent to the LLM during the run itself)`
      : `${describeApiAction(failed.action)} -> failed: ${failed.failureDetail ?? '(no detail captured)'}`

  return [
    `You are analyzing why an API test's assertion failed. You are not being asked to take any action or write code — only to suggest a likely root cause and what a human should check, based only on what the testing agent itself could see at the moment of failure.`,
    ``,
    `Goal: ${run.goal}`,
    ``,
    `Requests/checks made before the failure:`,
    serializeApiHistory(priorHistory),
    ``,
    `The failing step: ${failureSummary}`,
    ``,
    `Respond with:`,
    `1. A short (1-3 sentence) hypothesis for the most likely root cause.`,
    `2. 1-3 concrete things a human should check to confirm or investigate it.`,
    ``,
    `Be honest if the available information isn't enough for a confident hypothesis — say so rather than guessing confidently. This is a hypothesis for a human to investigate, not a diagnosis, and no code changes should be made on its basis alone.`,
  ].join('\n')
}

/** Always resolves — never rejects. See `rootCause.ts`'s
 * `generateRootCauseHypothesis` for the full reasoning (the same lesson
 * `runApiTestCommand`'s original missing try/catch already taught this
 * codebase once). */
export async function generateApiRootCauseHypothesis(run: ApiTestRun, provider: LlmProvider, apiKey: string): Promise<string> {
  const prompt = buildApiRootCausePrompt(run)
  if (!prompt) return "couldn't generate a root-cause hypothesis: no failed step found in this run"
  try {
    const text = await provider.complete(prompt, apiKey, { maxOutputTokens: ROOT_CAUSE_MAX_OUTPUT_TOKENS })
    return text.trim() || '(the LLM returned an empty response for this analysis)'
  } catch (err) {
    return `couldn't generate a root-cause hypothesis: ${err instanceof Error ? err.message : String(err)}`
  }
}
