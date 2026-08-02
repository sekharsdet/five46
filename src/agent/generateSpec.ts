import type { AgentAction, ExecutedStep, TestRun } from './types'
import { USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER, WAIT_ACTION_MS } from './browser'

function selectorFor(step: ExecutedStep): string | undefined {
  // A healed step's selector must come from `resolvedSelector`, never the
  // ref→outline lookup below: `step.outline` is the pre-action snapshot
  // taken *before* healing found a fresh element, and `ref` is only
  // meaningful within the exact snapshot it came from — looking it up
  // against a different (fresh, post-heal) snapshot would silently either
  // find nothing or resolve to an unrelated element.
  if (step.resolvedSelector) return step.resolvedSelector
  const action = step.action
  // None of these four has a ref/selector at all — `renderStep` intercepts
  // `scroll`/`wait`/`assert_page_text` before ever calling this, but the
  // guard is required here regardless for the discriminated-union
  // narrowing below to type-check.
  if (action.action === 'done' || action.action === 'scroll' || action.action === 'wait' || action.action === 'assert_page_text') return undefined
  return step.outline.elements.find((el) => el.ref === action.ref)?.selector
}

// `%` has no special meaning in a regex, so the placeholder tokens
// (`%%USERNAME%%`/`%%PASSWORD%%`) need no escaping to be used literally here.
const PLACEHOLDER_SPLIT_PATTERN = new RegExp(`(${USERNAME_PLACEHOLDER}|${PASSWORD_PLACEHOLDER})`, 'g')

function escapeTemplateLiteralSegment(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Renders a `fill`/`assert_text` string value as a real JS expression. A
 * plain string with no credential placeholder becomes an ordinary
 * `JSON.stringify`'d literal, unchanged from before this feature. A string
 * containing `%%USERNAME%%`/`%%PASSWORD%%` — including mixed with literal
 * text, e.g. `"prefix-%%USERNAME%%"` — becomes a template literal
 * referencing `process.env.FIVE46_LOGIN_USERNAME`/`_PASSWORD` instead:
 * the real secret is never written into this file, only a reference a
 * human reading/running the generated spec would recognize and supply
 * themselves via the environment, the same way a responsibly-written
 * Playwright test would. This function never receives the actual
 * credential values at all — it only ever sees the placeholder tokens —
 * so it's structurally incapable of leaking the real secret, only capable
 * of mishandling the token itself. */
function renderCredentialAwareExpression(value: string): string {
  if (!value.includes(USERNAME_PLACEHOLDER) && !value.includes(PASSWORD_PLACEHOLDER)) {
    return JSON.stringify(value)
  }
  const parts = value.split(PLACEHOLDER_SPLIT_PATTERN)
  let template = '`'
  for (const part of parts) {
    if (part === USERNAME_PLACEHOLDER) template += '${process.env.FIVE46_LOGIN_USERNAME}'
    else if (part === PASSWORD_PLACEHOLDER) template += '${process.env.FIVE46_LOGIN_PASSWORD}'
    else template += escapeTemplateLiteralSegment(part)
  }
  return template + '`'
}

/** Renders one executed step as real, idiomatic Playwright code — a human
 * reading this file should see ordinary Playwright, not anything referring
 * back to five46's own ref/outline machinery, which only exists to keep
 * the LLM from authoring its own selectors during the run itself. */
function renderStep(step: ExecutedStep): string | undefined {
  // scroll/wait/assert_page_text have no selector at all — handled before
  // selectorFor, not as one of its branches, since selectorFor's whole job
  // is finding *a* selector for the step's target and none of these three
  // has one.
  if (step.action.action === 'scroll') {
    const top = step.action.direction === 'down' ? 'window.innerHeight' : '-window.innerHeight'
    return `  await page.evaluate(() => window.scrollBy({ top: ${top}, left: 0, behavior: 'instant' }))`
  }
  if (step.action.action === 'wait') {
    return `  await page.waitForTimeout(${WAIT_ACTION_MS})`
  }
  if (step.action.action === 'assert_page_text') {
    return `  await expect(page.locator('body')).toContainText(${renderCredentialAwareExpression(step.action.expectedText)})`
  }

  const selector = selectorFor(step)
  if (!selector) return undefined
  const action = step.action as Exclude<AgentAction, { action: 'done' | 'scroll' | 'wait' | 'assert_page_text' }>
  const sel = JSON.stringify(selector)

  switch (action.action) {
    case 'click':
      return `  await page.locator(${sel}).click()`
    case 'fill': {
      const lines = [`  await page.locator(${sel}).fill(${renderCredentialAwareExpression(action.value)})`]
      if (action.submit) lines.push(`  await page.locator(${sel}).press('Enter')`)
      return lines.join('\n')
    }
    case 'assert_visible':
      return `  await expect(page.locator(${sel})).toBeVisible()`
    case 'assert_text':
      return `  await expect(page.locator(${sel})).toContainText(${renderCredentialAwareExpression(action.expectedText)})`
  }
}

/** Turns one `TestRun` into a real, standalone `.spec.ts` a human can read,
 * edit, and re-run in CI with plain `npx playwright test` — no five46,
 * no LLM, no network call involved in re-running it. Only steps that
 * actually succeeded are included; if the run ended in a failure, whatever
 * succeeded *before* that point is still real, working coverage, so it's
 * still written out rather than discarded. This file is a frozen recording
 * of one specific run, not a deterministic re-derivation the way every
 * other generated file in this project is — see the header comment this
 * function writes, and `five46 test`'s printed non-determinism
 * disclosure in `cli.ts`. */
export function generateAgentSpec(run: TestRun): string {
  const successfulSteps = run.steps.filter((s) => s.ok)
  const lines: string[] = []

  lines.push(
    `// Auto-generated by five46 test from a real agent run against ${run.url}`,
    `// Goal: ${run.goal}`,
    `// Run ${run.runId} — outcome: ${run.outcome}`,
    ...(run.planStats ? [`// Structured plan: ${run.planStats.plannedSteps} step(s) planned upfront, ${run.planStats.fastPathedSteps} executed without a live LLM decision`] : []),
    `//`,
    `// Unlike five46's static-analysis output, this file is a frozen recording`,
    `// of ONE specific run, not a deterministic re-derivation — the agent's exact`,
    `// path through the page isn't guaranteed to repeat on a future "five46 test"`,
    `// run against the same goal/page. This file itself, once generated, is a real,`,
    `// ordinary Playwright spec — re-run it any time with no five46/LLM involved.`,
    `import { test, expect } from '@playwright/test'`,
    ``,
    `test(${JSON.stringify(run.goal)}, async ({ page }) => {`,
    `  await page.goto(${JSON.stringify(run.url)})`,
    ``
  )

  if (successfulSteps.length === 0) {
    lines.push(`  // No steps completed successfully in this run — nothing to replay.`)
  }
  for (const step of successfulSteps) {
    const rendered = renderStep(step)
    if (rendered) lines.push(rendered)
  }

  if (run.outcome === 'assertion-failed' || run.outcome === 'unparseable-response' || run.outcome === 'stuck-repeating' || run.outcome === 'stopped-by-cap') {
    lines.push(
      ``,
      `  // This run did not reach "goal-reached" (outcome: ${run.outcome}) — only the`,
      `  // steps above were confirmed working. See the printed failure report for detail.`
    )
  }

  lines.push(`})`, ``)
  return lines.join('\n')
}
