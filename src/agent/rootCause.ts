import type { LlmProvider } from '../llm/types'
import type { HistoryEntry, TestRun } from './types'
import { serializeOutline, serializeHistory } from './planner'
import { describeAction, findFailedStep } from './failureReport'

/** Builds the "why did this fail" prompt from *only* what the LLM already
 * saw during the run — the failed step's own outline (`serializeOutline`,
 * the same capped element list that step's own turn already sent), the
 * goal, and prior history (`serializeHistory`) — plus the failing action's
 * own specified values, never a live, previously-undisclosed value.
 *
 * That last clause matters: `failed.failureDetail` is not safe to reuse
 * unconditionally. For `assert_text` specifically, `browser.ts`'s
 * `executeAction` embeds the real, live `text.trim()` read from the page
 * *after* the snapshot the LLM actually saw, and because an assertion
 * failure ends the run immediately, this one step's detail is never
 * serialized into a next turn's prompt the way every other step's is. A
 * page rendering "Welcome, alice@example.com" under an `assert_text`
 * expecting different text would otherwise send that email to the LLM for
 * the first time, right here. `describeAction` itself is safe (it only
 * ever echoes `expectedText`, the model's own prior output) — the live
 * mismatched value is deliberately left out instead, replaced with a plain
 * "the actual text did not match" note. Every other action type's
 * `failureDetail` is safe: `assert_visible` only names an already-disclosed
 * outline element, `click`/`fill` failures are Playwright's own internal
 * timeout/error text. */
export function buildRootCausePrompt(run: TestRun): string | undefined {
  const failed = findFailedStep(run)
  if (!failed) return undefined

  const priorHistory: HistoryEntry[] = run.steps
    .filter((s) => s.step !== failed.step)
    .map((s) => ({
      action: s.action,
      result: s.ok ? 'ok' : 'failed',
      detail: s.ok ? (s.healed ? 'succeeded after healing a stale selector' : '') : (s.failureDetail ?? 'failed'),
    }))

  const failureSummary =
    failed.action.action === 'assert_text'
      ? `${describeAction(failed)} — the actual text on the page did not match (the specific mismatched value is intentionally excluded from this analysis; it was never sent to the LLM during the run itself)`
      : `${describeAction(failed)} -> failed: ${failed.failureDetail ?? '(no detail captured)'}`

  return [
    `You are analyzing why a web UI test's assertion failed. You are not being asked to take any action or write code — only to suggest a likely root cause and what a human should check, based only on what the testing agent itself could see at the moment of failure.`,
    ``,
    `Goal: ${run.goal}`,
    ``,
    `Steps taken before the failure:`,
    serializeHistory(priorHistory),
    ``,
    `The failing step: ${failureSummary}`,
    ``,
    `Interactive elements visible on the page at the moment of failure (buttons, links, inputs, and anything with an ARIA role — NOT all visible content):`,
    serializeOutline(failed.outline),
    ``,
    `Important: the list above is scoped to INTERACTIVE elements only. A short or even single-item list does NOT mean the page was blank, failed to load, or is broken — plain text (headings, paragraphs, prices, descriptions) with no button/link/input/ARIA-role markup never appears in it at all, no matter how much of it is actually rendered. Do not infer "the page failed to load" or "the page is blank" from a sparse list here; if you cannot tell whether the page rendered real content from what's given, say so rather than guessing.`,
    ``,
    `Respond with:`,
    `1. A short (1-3 sentence) hypothesis for the most likely root cause.`,
    `2. 1-3 concrete things a human should check to confirm or investigate it.`,
    ``,
    `Be honest if the available information isn't enough for a confident hypothesis — say so rather than guessing confidently. This is a hypothesis for a human to investigate, not a diagnosis, and no code changes should be made on its basis alone.`,
  ].join('\n')
}

/** Always resolves — never rejects. A network failure, rate limit, or any
 * other provider error becomes an honest in-report note instead of an
 * uncaught rejection — `runApiTestCommand`'s main LLM-driving call once
 * had a gap exactly this shape (zero try/catch, letting an exception reach
 * main()'s bare catch-all unredacted), so this new, adjacent call path must
 * not reintroduce it. The returned text flows into `formatFailureReport`'s
 * output, which callers already pipe through `redactSecrets` — no separate
 * redaction call needed here. */
export async function generateRootCauseHypothesis(run: TestRun, provider: LlmProvider, apiKey: string): Promise<string> {
  const prompt = buildRootCausePrompt(run)
  if (!prompt) return "couldn't generate a root-cause hypothesis: no failed step found in this run"
  try {
    const text = await provider.complete(prompt, apiKey)
    return text.trim() || '(the LLM returned an empty response for this analysis)'
  } catch (err) {
    return `couldn't generate a root-cause hypothesis: ${err instanceof Error ? err.message : String(err)}`
  }
}
