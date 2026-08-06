import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateAgentSpec } from './generateSpec'
import { USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './browser'
import type { TestRun, ExecutedStep, PageOutline } from './types'

function outlineWith(ref: string, selector: string): PageOutline {
  return { elements: [{ ref, tag: 'button', role: 'button', name: 'x', selector }], truncated: false, totalFound: 1 }
}

test('generateAgentSpec renders real, standalone Playwright code for successful steps', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'click', ref: 'e1', reason: 'open' }, outline: outlineWith('e1', '#reveal-btn'), ok: true },
    {
      step: 2,
      action: { action: 'assert_text', ref: 'e2', expectedText: 'agentic testing works', reason: 'confirm' },
      outline: outlineWith('e2', '[id="secret"]'),
      ok: true,
    },
  ]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'reveal the secret', steps, outcome: 'goal-reached' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes("import { test, expect } from '@playwright/test'"))
  assert.ok(spec.includes("await page.goto(\"http://localhost:1234\")"))
  assert.ok(spec.includes('await page.locator("#reveal-btn").click()'))
  assert.ok(spec.includes('await expect(page.locator("[id=\\"secret\\"]")).toContainText("agentic testing works")'))
  assert.ok(spec.includes('frozen recording'), 'must disclose non-determinism in the header')
})

test('generateAgentSpec renders a scroll step as real, standalone Playwright code, not silently dropped', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'scroll', direction: 'down', reason: 'reach the target' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true },
    { step: 2, action: { action: 'click', ref: 'e1', reason: 'click it' }, outline: outlineWith('e1', '#bottom-btn'), ok: true },
  ]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'scroll and click', steps, outcome: 'goal-reached' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes("window.scrollBy({ top: window.innerHeight, left: 0, behavior: 'instant' })"))
  assert.ok(spec.includes('await page.locator("#bottom-btn").click()'), 'the step after the scroll must still render too')
})

test('generateAgentSpec renders an upward scroll with a negated delta', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'scroll', direction: 'up', reason: 'back to the top' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true },
  ]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'scroll up', steps, outcome: 'goal-reached' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes("window.scrollBy({ top: -window.innerHeight, left: 0, behavior: 'instant' })"))
})

test('generateAgentSpec renders a wait step as a real page.waitForTimeout call, using the same duration the live run actually paused for', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'wait', reason: 'content may still be loading' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true },
    { step: 2, action: { action: 'click', ref: 'e1', reason: 'click it' }, outline: outlineWith('e1', '#bottom-btn'), ok: true },
  ]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'wait then click', steps, outcome: 'goal-reached' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.waitForTimeout(3000)'))
  assert.ok(spec.includes('await page.locator("#bottom-btn").click()'), 'the step after the wait must still render too')
})

test('generateAgentSpec renders assert_page_text as a real body-wide toContainText assertion, needing no selector', () => {
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'assert_page_text', expectedText: 'Hello World!', reason: 'confirm it appeared' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true }]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'confirm text appears', steps, outcome: 'goal-reached' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes(`await expect(page.locator('body')).toContainText("Hello World!")`))
})

test('generateAgentSpec renders assert_page_text_absent as a real body-wide not.toContainText assertion, needing no selector', () => {
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'assert_page_text_absent', expectedText: 'Deleted item', reason: 'confirm it is gone' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true }]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'confirm text is gone', steps, outcome: 'goal-reached' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes(`await expect(page.locator('body')).not.toContainText("Deleted item")`))
})

test('generateAgentSpec still writes the steps that succeeded before a failure, with an honest note about the outcome', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'click', ref: 'e1', reason: 'open' }, outline: outlineWith('e1', '#reveal-btn'), ok: true },
    {
      step: 2,
      action: { action: 'assert_text', ref: 'e2', expectedText: 'wrong text', reason: 'confirm' },
      outline: outlineWith('e2', '[id="secret"]'),
      ok: false,
      failureDetail: 'expected text containing "wrong text", got "..."',
    },
  ]
  const run: TestRun = { runId: 'abc123', url: 'http://localhost:1234', goal: 'reveal the secret', steps, outcome: 'assertion-failed' }

  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.locator("#reveal-btn").click()'), 'the successful step must still be written')
  assert.ok(!spec.includes('wrong text'), 'the failed assertion itself must not be written as if it were confirmed working')
  assert.ok(spec.includes('outcome: assertion-failed'))
})

test('generateAgentSpec renders a fill action, with an optional submit press', () => {
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'fill', ref: 'e1', value: 'Ada', submit: true, reason: 'enter name' },
      outline: outlineWith('e1', '[id="name-input"]'),
      ok: true,
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.locator("[id=\\"name-input\\"]").fill("Ada")'))
  assert.ok(spec.includes('.press(\'Enter\')') || spec.includes('.press("Enter")'))
})

test('generateAgentSpec translates a credential placeholder into a process.env reference, never the literal token', () => {
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'fill', ref: 'e1', value: USERNAME_PLACEHOLDER, reason: 'enter username' },
      outline: outlineWith('e1', '#username'),
      ok: true,
    },
    {
      step: 2,
      action: { action: 'fill', ref: 'e2', value: PASSWORD_PLACEHOLDER, reason: 'enter password' },
      outline: outlineWith('e2', '#password'),
      ok: true,
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'log in', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)

  assert.ok(spec.includes('process.env.FIVE46_LOGIN_USERNAME'))
  assert.ok(spec.includes('process.env.FIVE46_LOGIN_PASSWORD'))
  assert.ok(!spec.includes(USERNAME_PLACEHOLDER), 'the literal placeholder token must never appear in the generated file')
  assert.ok(!spec.includes(PASSWORD_PLACEHOLDER))
})

test('generateAgentSpec translates a placeholder mixed with literal text into a template literal', () => {
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'fill', ref: 'e1', value: `prefix-${USERNAME_PLACEHOLDER}-suffix`, reason: 'enter' },
      outline: outlineWith('e1', '#field'),
      ok: true,
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)

  assert.ok(spec.includes('`prefix-${process.env.FIVE46_LOGIN_USERNAME}-suffix`'))
  assert.ok(!spec.includes(USERNAME_PLACEHOLDER))
})

test('generateAgentSpec translates a credential placeholder inside assert_text too, not just fill', () => {
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'assert_text', ref: 'e1', expectedText: USERNAME_PLACEHOLDER, reason: 'confirm welcome banner' },
      outline: outlineWith('e1', '#welcome'),
      ok: true,
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)

  assert.ok(spec.includes('toContainText(`${process.env.FIVE46_LOGIN_USERNAME}`)'))
  assert.ok(!spec.includes(USERNAME_PLACEHOLDER))
})

test('generateAgentSpec renders assert_value as a real toHaveValue() regex assertion — substring semantics, matching the live run\'s own .includes() check, not toHaveValue()\'s own default exact-match behavior', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'assert_value', ref: 'e1', expectedValue: 'Edited!', reason: 'confirm the field updated' }, outline: outlineWith('e1', '#notes'), ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await expect(page.locator("#notes")).toHaveValue(new RegExp("Edited!"))'), spec)
})

test('generateAgentSpec escapes regex metacharacters in an assert_value expectedValue, so a literal value containing them still matches literally', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'assert_value', ref: 'e1', expectedValue: '$19.99 (was $25.00)', reason: 'confirm price field' }, outline: outlineWith('e1', '#price'), ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('new RegExp("\\\\$19\\\\.99 \\\\(was \\\\$25\\\\.00\\\\)")'), spec)
})

test('generateAgentSpec leaves an ordinary string with no placeholder completely unchanged (unaffected by this feature)', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'fill', ref: 'e1', value: 'ordinary text', reason: 'x' }, outline: outlineWith('e1', '#field'), ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('.fill("ordinary text")'))
})

test('generateAgentSpec uses a healed step\'s resolvedSelector, never the stale ref->outline-derived selector', () => {
  // Regression test: `outline` on a healed step is still the pre-heal
  // snapshot (the one whose selector is now known to be stale) — `ref`
  // only means what it meant in *that* snapshot, so looking it up there
  // would silently either find nothing or resolve to an unrelated element.
  // `resolvedSelector` must win whenever it's present.
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'click', ref: 'e1', reason: 'delete the row' },
      // The pre-heal outline still maps e1 to the now-stale selector.
      outline: outlineWith('e1', '[id="original-btn"]'),
      ok: true,
      healed: true,
      resolvedSelector: '[id="rerendered-btn"]',
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('page.locator("[id=\\"rerendered-btn\\"]").click()'), spec)
  assert.ok(!spec.includes('original-btn'), 'must never bake in the selector already known to be stale')
})

test('generateAgentSpec prefers a live-verified getByRole locator over the raw selector, for click/fill/assert_visible/assert_text alike', () => {
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'click', ref: 'e1', reason: 'open the menu' },
      outline: outlineWith('e1', 'body > div:nth-of-type(3) > a:nth-of-type(2)'),
      ok: true,
      verifiedRoleLocator: { role: 'link', name: 'Show secret message' },
    },
    {
      step: 2,
      action: { action: 'assert_visible', ref: 'e2', reason: 'confirm revealed' },
      outline: outlineWith('e2', 'body > p:nth-of-type(4)'),
      ok: true,
      verifiedRoleLocator: { role: 'status', name: 'agentic testing works' },
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('page.getByRole("link", { name: "Show secret message" }).click()'), spec)
  assert.ok(spec.includes('expect(page.getByRole("status", { name: "agentic testing works" })).toBeVisible()'), spec)
  assert.ok(!spec.includes('nth-of-type'), 'must never fall back to the raw positional selector once verified')
})

test('generateAgentSpec falls back to the raw selector, completely unchanged, when a step has no verifiedRoleLocator', () => {
  // The exact production case this feature exists for: a real, unlabeled
  // production site where no meaningful role/name round-trip is possible —
  // must degrade to today's existing, always-correct behavior, never break.
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'click', ref: 'e1', reason: 'click it' }, outline: outlineWith('e1', 'body > div:nth-of-type(1) > a:nth-of-type(1)'), ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('page.locator("body > div:nth-of-type(1) > a:nth-of-type(1)").click()'), spec)
  assert.ok(!spec.includes('getByRole'))
})

test('generateAgentSpec prefers getByRole for a fill action too, on both the fill and the submit press', () => {
  const steps: ExecutedStep[] = [
    {
      step: 1,
      action: { action: 'fill', ref: 'e1', value: 'hello', submit: true, reason: 'search' },
      outline: outlineWith('e1', 'body > div:nth-of-type(1) > input:nth-of-type(1)'),
      ok: true,
      verifiedRoleLocator: { role: 'textbox', name: 'Search' },
    },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('page.getByRole("textbox", { name: "Search" }).fill("hello")'), spec)
  assert.ok(spec.includes('page.getByRole("textbox", { name: "Search" }).press(\'Enter\')'), spec)
})

test('generateAgentSpec always emits a dialog auto-accept handler, matching the live run\'s own always-on default', () => {
  // The live run this file was recorded from always had confirm()/alert()/
  // prompt() dialogs auto-accepted for its entire duration (see
  // browser.ts's launchAgentBrowser) — a faithful standalone replay must
  // set up the same handler, unconditionally, or a step that only worked
  // live because of this would silently regress to Playwright's own
  // default (auto-dismiss) once five46 is no longer involved.
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'x' }, outline: outlineWith('e1', '#btn'), ok: true }]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes(`page.on('dialog', (dialog) => dialog.accept().catch(() => {}))`), spec)
})

test('generateAgentSpec renders hover, press_key, and upload as real, standalone Playwright calls', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'hover', ref: 'e1', reason: 'reveal tooltip' }, outline: outlineWith('e1', '#target'), ok: true },
    { step: 2, action: { action: 'press_key', ref: 'e1', key: 'Escape', reason: 'dismiss' }, outline: outlineWith('e1', '#target'), ok: true },
    { step: 3, action: { action: 'upload', ref: 'e1', filePath: '/tmp/resume.pdf', reason: 'attach' }, outline: outlineWith('e1', '#file-input'), ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.locator("#target").hover()'), spec)
  assert.ok(spec.includes('await page.locator("#target").press("Escape")'), spec)
  assert.ok(spec.includes('await page.locator("#file-input").setInputFiles("/tmp/resume.pdf")'), spec)
})

test('generateAgentSpec renders dblclick as a real, standalone Playwright dblclick() call', () => {
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'dblclick', ref: 'e1', reason: 'enter edit mode' }, outline: outlineWith('e1', '#label'), ok: true }]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.locator("#label").dblclick()'), spec)
})

test('generateAgentSpec renders drag as a real, standalone Playwright dragTo() call, resolving BOTH the source and destination selectors from the step\'s own outline', () => {
  const outline: PageOutline = {
    elements: [
      { ref: 'e1', tag: 'li', role: 'listitem', name: 'Item C', selector: '#item-c' },
      { ref: 'e2', tag: 'li', role: 'listitem', name: 'Item A', selector: '#item-a' },
    ],
    truncated: false,
    totalFound: 2,
  }
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'drag', ref: 'e1', targetRef: 'e2', reason: 'reorder' }, outline, ok: true }]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.locator("#item-c").dragTo(page.locator("#item-a"))'), spec)
})

test('generateAgentSpec renders a drag whose destination lives inside an iframe with its own chained frameLocator, independent of the source\'s own frame', () => {
  const outline: PageOutline = {
    elements: [
      { ref: 'e1', tag: 'li', role: 'listitem', name: 'Item C', selector: '#item-c' },
      { ref: 'e2', tag: 'li', role: 'listitem', name: 'Item A', selector: '#item-a', frameChain: ['[id="board-frame"]'] },
    ],
    truncated: false,
    totalFound: 2,
  }
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'drag', ref: 'e1', targetRef: 'e2', reason: 'reorder' }, outline, ok: true }]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.locator("#item-c").dragTo(page.frameLocator("[id=\\"board-frame\\"]").locator("#item-a"))'), spec)
})

test('generateAgentSpec renders a frame-scoped element via a chained frameLocator, matching browser.ts\'s own live resolveRoot()', () => {
  const outline: PageOutline = {
    elements: [{ ref: 'e1', tag: 'input', role: 'textbox', name: 'Cardholder name', selector: '[id="cardname"]', frameChain: ['[id="payment-frame"]'] }],
    truncated: false,
    totalFound: 1,
  }
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'fill', ref: 'e1', value: 'Jane Doe', reason: 'x' }, outline, ok: true, frameChain: ['[id="payment-frame"]'] }]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('await page.frameLocator("[id=\\"payment-frame\\"]").locator("[id=\\"cardname\\"]").fill("Jane Doe")'), spec)
})

test('generateAgentSpec renders assert_page_text as a frame-aware check when the run touched any iframe, not just the plain single-body one', () => {
  const frameOutline: PageOutline = {
    elements: [{ ref: 'e1', tag: 'input', role: 'textbox', name: 'x', selector: '#x', frameChain: ['#payment-frame'] }],
    truncated: false,
    totalFound: 1,
  }
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'fill', ref: 'e1', value: 'x', reason: 'x' }, outline: frameOutline, ok: true, frameChain: ['#payment-frame'] },
    { step: 2, action: { action: 'assert_page_text', expectedText: 'Payment submitted', reason: 'confirm' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('for (const frame of page.frames())'), spec)
  assert.ok(spec.includes('expect(combinedText).toContain("Payment submitted")'), spec)
})

test('generateAgentSpec renders assert_page_text_absent as a frame-aware check when the run touched any iframe, not just the plain single-body one', () => {
  const frameOutline: PageOutline = {
    elements: [{ ref: 'e1', tag: 'input', role: 'textbox', name: 'x', selector: '#x', frameChain: ['#payment-frame'] }],
    truncated: false,
    totalFound: 1,
  }
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'fill', ref: 'e1', value: 'x', reason: 'x' }, outline: frameOutline, ok: true, frameChain: ['#payment-frame'] },
    { step: 2, action: { action: 'assert_page_text_absent', expectedText: 'Payment pending', reason: 'confirm' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes('for (const frame of page.frames())'), spec)
  assert.ok(spec.includes('expect(combinedText).not.toContain("Payment pending")'), spec)
})

test('generateAgentSpec captures a newly opened tab with Promise.all + context.waitForEvent, and switches later steps to it', () => {
  // The exact race-safety pattern this exists for: a bare `await ...click()`
  // followed by a separate `await context.waitForEvent('page')` risks
  // missing the popup's own 'page' event if it fires before the second
  // await even starts listening — Promise.all starts listening and fires
  // the click in the same tick.
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'click', ref: 'e1', reason: 'open new tab' }, outline: outlineWith('e1', '#open-link'), ok: true },
    { step: 2, action: { action: 'assert_page_text', expectedText: 'New Window', reason: 'confirm' }, outline: { elements: [], truncated: false, totalFound: 0 }, ok: true, pageIndex: 1 },
  ]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes(`async ({ page, context }) =>`), spec)
  assert.ok(spec.includes(`const [page1] = await Promise.all([`), spec)
  assert.ok(spec.includes(`context.waitForEvent('page'),`), spec)
  assert.ok(spec.includes(`page.locator("#open-link").click(),`), spec)
  assert.ok(spec.includes(`await page1.waitForLoadState().catch(() => {})`), spec)
  assert.ok(spec.includes(`await expect(page1.locator('body')).toContainText("New Window")`), spec)
})

test('generateAgentSpec never adds the context fixture or any popup machinery when no step ever switched tabs', () => {
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'x' }, outline: outlineWith('e1', '#btn'), ok: true }]
  const run: TestRun = { runId: 'x', url: 'http://localhost:1', goal: 'g', steps, outcome: 'goal-reached' }
  const spec = generateAgentSpec(run)
  assert.ok(spec.includes(`async ({ page }) =>`), spec)
  assert.ok(!spec.includes('context'), 'the ordinary, no-popup case must stay exactly as simple as before this feature')
})
