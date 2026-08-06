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
  // None of these five has a ref/selector at all — `renderStep` intercepts
  // `scroll`/`wait`/`assert_page_text`/`assert_page_text_absent` before ever
  // calling this, but the guard is required here regardless for the
  // discriminated-union narrowing below to type-check.
  if (
    action.action === 'done' ||
    action.action === 'scroll' ||
    action.action === 'wait' ||
    action.action === 'assert_page_text' ||
    action.action === 'assert_page_text_absent'
  )
    return undefined
  return step.outline.elements.find((el) => el.ref === action.ref)?.selector
}

/** Renders the real Playwright root expression a step's locator is built
 * on — `pageVar` itself (see `generateAgentSpec`'s per-tab variable
 * tracking) for a main-page element (no `frameChain`, or an empty one), or
 * a chained `pageVar.frameLocator("...").frameLocator("...")` for one that
 * lives inside one or more nested iframes/frames, mirroring exactly what
 * `browser.ts`'s `resolveRoot()` builds and resolved against during the
 * live run itself — the exported spec and the run that produced it must
 * agree on this or a healthy-looking generated step would silently target
 * the wrong document. */
function rootExprFor(pageVar: string, frameChain?: string[]): string {
  return (frameChain ?? []).reduce((expr, selector) => `${expr}.frameLocator(${JSON.stringify(selector)})`, pageVar)
}

/** The Playwright locator expression a generated step should use — prefers
 * `pageVar.getByRole(role, { name })` when `browser.ts`'s
 * `verifyRoleLocator()` confirmed live, during the actual run, that it
 * resolves uniquely to the exact element this step acted on (see
 * `ExecutedStep.verifiedRoleLocator`'s own doc comment for the full
 * reasoning); falls back to the raw, always-correct
 * `pageVar.locator(selector)` otherwise — the exact, unchanged behavior
 * from before this feature (when `pageVar` is always `'page'`). A
 * `getByRole` locator is far more resilient to future DOM restructuring
 * than a positional CSS path, since the whole point of a generated spec is
 * to be re-run standalone, for a long time, with no five46 involved. */
function locatorExprFor(step: ExecutedStep, selector: string, pageVar: string): string {
  const root = rootExprFor(pageVar, step.frameChain)
  if (step.verifiedRoleLocator) {
    const { role, name } = step.verifiedRoleLocator
    return `${root}.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`
  }
  return `${root}.locator(${JSON.stringify(selector)})`
}

// `%` has no special meaning in a regex, so the placeholder tokens
// (`%%USERNAME%%`/`%%PASSWORD%%`) need no escaping to be used literally here.
const PLACEHOLDER_SPLIT_PATTERN = new RegExp(`(${USERNAME_PLACEHOLDER}|${PASSWORD_PLACEHOLDER})`, 'g')

function escapeTemplateLiteralSegment(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Escapes regex metacharacters in a literal string — used only by
 * `assert_value`'s codegen (see its own case below): the live run matches
 * an input's value via `.includes()` (substring, same convention
 * `assert_text` already uses), but Playwright's own `toHaveValue()`
 * assertion does an *exact* match unless given a `RegExp` — escaping first
 * and wrapping in `new RegExp(...)` keeps the exported spec's semantics
 * identical to what the live run actually checked, rather than silently
 * tightening it to an exact match a real live pass wouldn't have required. */
function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * the LLM from authoring its own selectors during the run itself.
 *
 * `pageVar` is which page variable this step's action actually ran
 * against (`'page'` for the tab `test()` was given, `'page1'`/`'page2'`/...
 * for a tab opened later in the run — see `generateAgentSpec`'s own
 * tracking). `hasFrames` — true only when *some* step in this whole run
 * touched a non-main-frame element — switches `assert_page_text` from the
 * plain single-body check to one that also searches every other frame on
 * the page, matching `browser.ts`'s own live `executeAction` behavior for
 * this action; kept conditional (not always emitted) so the overwhelming
 * majority of generated specs (no iframes at all) keep the exact same
 * simple one-liner as before this feature. */
function renderStep(step: ExecutedStep, pageVar: string, hasFrames: boolean): string | undefined {
  // scroll/wait/assert_page_text have no selector at all — handled before
  // selectorFor, not as one of its branches, since selectorFor's whole job
  // is finding *a* selector for the step's target and none of these three
  // has one.
  if (step.action.action === 'scroll') {
    const top = step.action.direction === 'down' ? 'window.innerHeight' : '-window.innerHeight'
    return `  await ${pageVar}.evaluate(() => window.scrollBy({ top: ${top}, left: 0, behavior: 'instant' }))`
  }
  if (step.action.action === 'wait') {
    return `  await ${pageVar}.waitForTimeout(${WAIT_ACTION_MS})`
  }
  if (step.action.action === 'assert_page_text') {
    const expected = renderCredentialAwareExpression(step.action.expectedText)
    if (!hasFrames) {
      return `  await expect(${pageVar}.locator('body')).toContainText(${expected})`
    }
    // Mirrors browser.ts's own live assert_page_text check (main body,
    // then every other frame) — a plain single-body toContainText() would
    // silently and permanently fail here for a run whose matching text
    // actually came from inside an iframe, even though the live run that
    // produced this exact step genuinely observed it.
    return [
      `  await expect(async () => {`,
      `    let combinedText = await ${pageVar}.locator('body').innerText()`,
      `    for (const frame of ${pageVar}.frames()) {`,
      `      if (frame === ${pageVar}.mainFrame()) continue`,
      `      combinedText += await frame.locator('body').innerText().catch(() => '')`,
      `    }`,
      `    expect(combinedText).toContain(${expected})`,
      `  }).toPass({ timeout: 5000 })`,
    ].join('\n')
  }
  if (step.action.action === 'assert_page_text_absent') {
    const expected = renderCredentialAwareExpression(step.action.expectedText)
    if (!hasFrames) {
      // Playwright's own `.not.toContainText()` already auto-retries until
      // the condition holds (or times out) — the exact inverted-polling
      // behavior `browser.ts`'s live `assert_page_text_absent` check
      // implements by hand, no custom retry loop needed for this branch.
      return `  await expect(${pageVar}.locator('body')).not.toContainText(${expected})`
    }
    // Same frame-inclusion reasoning as assert_page_text's own multi-frame
    // branch above, inverted condition — the built-in `.not.toContainText()`
    // has no equivalent for "combined text across several locators," so
    // this still needs the same hand-rolled `toPass` retry wrapper.
    return [
      `  await expect(async () => {`,
      `    let combinedText = await ${pageVar}.locator('body').innerText()`,
      `    for (const frame of ${pageVar}.frames()) {`,
      `      if (frame === ${pageVar}.mainFrame()) continue`,
      `      combinedText += await frame.locator('body').innerText().catch(() => '')`,
      `    }`,
      `    expect(combinedText).not.toContain(${expected})`,
      `  }).toPass({ timeout: 5000 })`,
    ].join('\n')
  }

  const selector = selectorFor(step)
  if (!selector) return undefined
  const action = step.action as Exclude<AgentAction, { action: 'done' | 'scroll' | 'wait' | 'assert_page_text' | 'assert_page_text_absent' }>
  const locatorExpr = locatorExprFor(step, selector, pageVar)

  switch (action.action) {
    case 'click':
      return `  await ${locatorExpr}.click()`
    case 'fill': {
      const lines = [`  await ${locatorExpr}.fill(${renderCredentialAwareExpression(action.value)})`]
      if (action.submit) lines.push(`  await ${locatorExpr}.press('Enter')`)
      return lines.join('\n')
    }
    case 'hover':
      return `  await ${locatorExpr}.hover()`
    case 'dblclick':
      return `  await ${locatorExpr}.dblclick()`
    case 'drag': {
      // The destination ref is never eligible for self-healing (same as
      // the source — see browser.ts's own doc comment on `drag`'s healing
      // exclusion), so its selector/frameChain come straight from this
      // step's own pre-action outline, no `resolvedSelector` fallback
      // needed. Looked up independently rather than reusing `locatorExpr`'s
      // own `frameChain`/`verifiedRoleLocator` — the destination is a
      // different element, in principle a different frame, with no
      // live-verified getByRole equivalent of its own.
      const targetOutlineEl = step.outline.elements.find((el) => el.ref === action.targetRef)
      if (!targetOutlineEl) return undefined
      const targetRoot = rootExprFor(pageVar, targetOutlineEl.frameChain)
      const targetExpr = `${targetRoot}.locator(${JSON.stringify(targetOutlineEl.selector)})`
      return `  await ${locatorExpr}.dragTo(${targetExpr})`
    }
    case 'press_key':
      return `  await ${locatorExpr}.press(${JSON.stringify(action.key)})`
    case 'upload':
      return `  await ${locatorExpr}.setInputFiles(${JSON.stringify(action.filePath)})`
    case 'assert_visible':
      return `  await expect(${locatorExpr}).toBeVisible()`
    case 'assert_text':
      return `  await expect(${locatorExpr}).toContainText(${renderCredentialAwareExpression(action.expectedText)})`
    case 'assert_value':
      return `  await expect(${locatorExpr}).toHaveValue(new RegExp(${renderCredentialAwareExpression(escapeRegExpLiteral(action.expectedValue))}))`
  }
}

/** Renders the click that opens a new tab, wrapped so the resulting `Page`
 * is actually captured — a bare, sequential `await ...click()` followed by
 * a later `context.waitForEvent('page')` would race the popup's own 'page'
 * event, which can fire before a separately-awaited `waitForEvent` call
 * even starts listening. `Promise.all` starts the listener and fires the
 * click in the same tick, matching Playwright's own documented pattern for
 * this exact scenario. `newVar.waitForLoadState()` (best-effort) mirrors
 * `browser.ts`'s own live behavior of only switching `AgentBrowser.page`
 * once the new tab's navigation has actually settled. `clickLine` is
 * `renderStep`'s own already-rendered `  await X.click()` line for this
 * exact step — reused rather than re-derived, so this can never silently
 * drift from what `renderStep` would otherwise have emitted for the same
 * step. */
function renderPopupCapture(clickLine: string, newVar: string): string {
  const clickExpr = clickLine.trim().replace(/^await /, '').replace(/;$/, '')
  return [
    `  const [${newVar}] = await Promise.all([`,
    `    context.waitForEvent('page'),`,
    `    ${clickExpr},`,
    `  ])`,
    `  await ${newVar}.waitForLoadState().catch(() => {})`,
  ].join('\n')
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
  const hasFrames = run.steps.some((s) => s.frameChain && s.frameChain.length > 0)
  // True only when this run ever actually drove a tab other than the
  // original — see `ExecutedStep.pageIndex`'s own doc comment for why its
  // mere presence (not just a non-zero value) is the right check: absent
  // means "still page 0" by construction.
  const hasPopups = successfulSteps.some((s) => (s.pageIndex ?? 0) > 0)
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
    `test(${JSON.stringify(run.goal)}, async ({ page${hasPopups ? ', context' : ''} }) => {`,
    `  await page.goto(${JSON.stringify(run.url)})`,
    // Matches browser.ts's own launchAgentBrowser default, unconditionally
    // (never gated on whether a dialog actually appeared) — the live run
    // this file was recorded from always had this active for its entire
    // duration, so a faithful standalone replay must too, or a step that
    // only worked live because a confirm()/prompt() got auto-accepted
    // would silently regress to Playwright's own default (auto-dismiss)
    // the moment five46 is no longer involved. `context.on('page', ...)`
    // covers a tab opened later in the run the same way
    // `launchAgentBrowser` itself does.
    `  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))`,
    ...(hasPopups ? [`  context.on('page', (p) => p.on('dialog', (dialog) => dialog.accept().catch(() => {})))`] : []),
    ``
  )

  if (successfulSteps.length === 0) {
    lines.push(`  // No steps completed successfully in this run — nothing to replay.`)
  }

  // Tracks which page variable each subsequent step's action should target
  // — 'page' until/unless a step's own recorded `pageIndex` says otherwise
  // (see ExecutedStep.pageIndex's own doc comment). `pageVarForIndex` only
  // ever grows: once a tab is captured into its own variable, every later
  // step on that same tab reuses it.
  let currentPageVar = 'page'
  let currentPageIndex = 0
  const pageVarForIndex = new Map<number, string>([[0, 'page']])

  for (let i = 0; i < successfulSteps.length; i++) {
    const step = successfulSteps[i]
    const stepPageIndex = step.pageIndex ?? 0
    if (stepPageIndex !== currentPageIndex) {
      const known = pageVarForIndex.get(stepPageIndex)
      if (known) {
        currentPageVar = known
        currentPageIndex = stepPageIndex
      }
      // If not yet known, the lookahead capture below should have already
      // handled it when rendering the previous step — falling through
      // here just means this step renders against whatever `currentPageVar`
      // still is, the same graceful-degrade posture as every other
      // best-effort part of this codebase (never throw, worst case one
      // step's generated line targets a not-yet-switched tab).
    }

    const rendered = renderStep(step, currentPageVar, hasFrames)
    if (!rendered) continue

    // A click is the only action that can plausibly open a new tab — if
    // the *next* successful step happens on a tab not yet captured, this
    // click is where that capture must happen (see renderPopupCapture's
    // own doc comment for why it must wrap the click, not follow it).
    const next = successfulSteps[i + 1]
    const nextPageIndex = next?.pageIndex ?? 0
    if (next && step.action.action === 'click' && nextPageIndex !== currentPageIndex && !pageVarForIndex.has(nextPageIndex)) {
      const newVar = `page${nextPageIndex}`
      pageVarForIndex.set(nextPageIndex, newVar)
      lines.push(renderPopupCapture(rendered, newVar))
    } else {
      lines.push(rendered)
    }
  }

  if (
    run.outcome === 'assertion-failed' ||
    run.outcome === 'unparseable-response' ||
    run.outcome === 'stuck-repeating' ||
    run.outcome === 'stopped-by-cap' ||
    run.outcome === 'provider-unavailable'
  ) {
    lines.push(
      ``,
      `  // This run did not reach "goal-reached" (outcome: ${run.outcome}) — only the`,
      `  // steps above were confirmed working. See the printed failure report for detail.`
    )
  }

  lines.push(`})`, ``)
  return lines.join('\n')
}
