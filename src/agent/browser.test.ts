import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchAgentBrowser, snapshot, executeAction, substitutePlaceholders, USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './browser'
import { startFixtureServer, startScrollFixtureServer } from './testServer'
import { startLoginFixtureServer, LOGIN_FIXTURE_USERNAME, LOGIN_FIXTURE_PASSWORD } from './loginTestServer'
import type { AgentBrowser } from './browser'

async function withRealBrowser(t: import('node:test').TestContext): Promise<AgentBrowser | undefined> {
  try {
    return await launchAgentBrowser({ headless: true })
  } catch (err) {
    t.skip(`playwright unavailable in this environment: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

test('snapshot finds real visible interactive elements and excludes a genuinely hidden one', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)

    const names = outline.elements.map((el) => el.name)
    assert.ok(names.some((n) => n.includes('Show secret message')))
    assert.ok(names.some((n) => n.includes('Greet me')))
    assert.ok(
      !names.some((n) => n.includes('Should never appear')),
      'a display:none element must not be reported as visible'
    )
    assert.equal(outline.truncated, false)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('snapshot resolves an unlabeled field\'s accessible name from an associated <label for>, not just aria-label/placeholder', async (t) => {
  // Regression test for a real, high-impact gap found while building the
  // login fixture: <label for="username">Username</label> + a plain
  // <input id="username"> with no aria-label/placeholder — an extremely
  // common, unremarkable real-world form pattern (this project's own
  // loginTestServer fixture uses it) — previously produced a completely
  // nameless field, which the LLM agent has no way to identify at all.
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startLoginFixtureServer()
  try {
    await browser.page.goto(server.url + '/login')
    const outline = await snapshot(browser.page)
    const names = outline.elements.map((el) => el.name)
    assert.ok(names.some((n) => n.toLowerCase().includes('username')), `expected a "username"-named field, got: ${JSON.stringify(names)}`)
    assert.ok(names.some((n) => n.toLowerCase().includes('password')), `expected a "password"-named field, got: ${JSON.stringify(names)}`)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('snapshot reports the correct implicit ARIA role for non-text <input> types, not just "textbox" for every input', async (t) => {
  // Regression test for a real bug found via a live run against
  // the-internet.herokuapp.com/checkboxes: roleOf() only ever branched on
  // tag name, so a checkbox reported role "textbox" — the same role a
  // plain text field gets — which could genuinely mislead the model into
  // reaching for `fill` on something it should `click`.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <input type="checkbox" id="cb" />
      <input type="radio" id="rb" />
      <input type="submit" value="Go" />
      <input type="text" id="txt" />
    `)
    const outline = await snapshot(browser.page)
    const roleOf = (id: string) => outline.elements.find((el) => el.selector === `[id="${id}"]`)?.role
    assert.equal(roleOf('cb'), 'checkbox')
    assert.equal(roleOf('rb'), 'radio')
    assert.equal(roleOf('txt'), 'textbox', 'an ordinary text input must keep its existing role, unaffected by this fix')
    const submitRole = outline.elements.find((el) => el.name === 'Go')?.role
    assert.equal(submitRole, 'button')
  } finally {
    await browser.close()
  }
})

test('snapshot computes a positional selector that is actually unique and resolves to the right element, even when a page-global tag count would pick the wrong one', async (t) => {
  // Regression test for a real bug found via a live run against
  // the-internet.herokuapp.com's login flow: a genuine successful login
  // was reported as an "element not visible" failure. Root cause: the
  // positional-selector fallback counted same-tag elements with a single
  // page-wide counter, then built `tag:nth-of-type(N)` from it — but
  // `:nth-of-type()` is scoped to siblings under the *same parent* in real
  // CSS, not page-global. This fixture reproduces that exact shape: three
  // <a> tags under three different parents, where the *target* link is the
  // first <a> under its own parent but the third <a> in document order —
  // exactly the mismatch that made the herokuapp page's real "Logout" link
  // resolve to zero elements.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <div><a href="#">First link</a></div>
      <div><a href="#">Second link</a></div>
      <div><a href="#">Target link</a></div>
    `)
    const outline = await snapshot(browser.page)
    const target = outline.elements.find((el) => el.name === 'Target link')
    assert.ok(target, `expected to find "Target link" in the outline, got: ${JSON.stringify(outline.elements.map((e) => e.name))}`)

    const matches = await browser.page.locator(target!.selector).count()
    assert.equal(matches, 1, `selector "${target!.selector}" must resolve to exactly one element, got ${matches}`)

    const text = await browser.page.locator(target!.selector).first().textContent()
    assert.equal(text, 'Target link', `selector "${target!.selector}" resolved to the wrong element: "${text}"`)

    const visible = await browser.page.locator(target!.selector).first().isVisible()
    assert.equal(visible, true)
  } finally {
    await browser.close()
  }
})

test('snapshot with prioritizeViewport surfaces an off-screen element only once scrolled into view, unlike the plain document-order cap', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <button id="a">Top button</button>
      <div style="height: 3000px;"></div>
      <button id="b">Bottom button</button>
    `)

    // maxElements: 1, so the cap genuinely has to choose between the two —
    // at the top of the page, both the prioritized and plain cap agree.
    const atTop = await snapshot(browser.page, 1, true)
    assert.equal(atTop.elements[0]?.name, 'Top button')

    // Scroll down until the bottom button is actually in the viewport —
    // bounded loop, robust to whatever the real test viewport height is.
    for (let i = 0; i < 20; i++) {
      const current = await snapshot(browser.page, 1, true)
      if (current.elements[0]?.name === 'Bottom button') break
      await browser.page.evaluate(`window.scrollBy({ top: window.innerHeight, left: 0, behavior: 'instant' })`)
    }
    const afterScroll = await snapshot(browser.page, 1, true)
    assert.equal(afterScroll.elements[0]?.name, 'Bottom button', 'prioritizeViewport must surface the now-on-screen element once capped to 1')

    // The plain document-order cap must NOT depend on scroll position at
    // all — still "Top button" even after scrolling all the way down,
    // confirming the difference above is really due to prioritizeViewport.
    const unprioritized = await snapshot(browser.page, 1, false)
    assert.equal(unprioritized.elements[0]?.name, 'Top button')
  } finally {
    await browser.close()
  }
})

test('executeAction clicking a real ref actually clicks the real element in the real page', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const revealRef = outline.elements.find((el) => el.name.includes('Show secret message'))!.ref

    const result = await executeAction(
      browser.page,
      { action: 'click', ref: revealRef, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, true)
    assert.equal(await browser.page.locator('#secret').isVisible(), true)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction wait pauses for a real, bounded duration and reports ok', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const before = Date.now()
    const result = await executeAction(browser.page, { action: 'wait', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
    const elapsed = Date.now() - before
    assert.equal(result.ok, true)
    // Bounded both ways — a real pause happened (not a no-op), and it's not
    // unboundedly long (WAIT_ACTION_MS, not something open-ended).
    assert.ok(elapsed >= 2500 && elapsed <= 6000, `expected ~3000ms, got ${elapsed}ms`)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction assert_visible succeeds against content that only appears after a real async delay, instead of failing instantly', async (t) => {
  // The real, live-found bug this fixes: a page whose target content
  // appears only after an async delay (a client-side setTimeout, not a
  // network request) used to fail an assert_visible on the very first
  // instantaneous check. This proves the new poll-based check actually
  // waits it out, matching what `expect(locator).toBeVisible()` would do
  // in the generated spec for the identical assertion.
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const revealRef = outline.elements.find((el) => el.name === 'Load content')!.ref
    const clickResult = await executeAction(browser.page, { action: 'click', ref: revealRef, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
    assert.equal(clickResult.ok, true)

    // The secret paragraph isn't a real snapshot-eligible interactive
    // element, so a hand-built single-element outline stands in for what a
    // real snapshot would report if it were — same pattern the failing-
    // assertion test below uses.
    const secretRef = 'e1'
    const delayedOutline = { elements: [{ ref: secretRef, tag: 'p', role: 'text', name: 'delayed-secret', selector: '#delayed-secret' }], truncated: false, totalFound: 1 }
    // Immediately after the click — the fixture's 800ms delay hasn't
    // elapsed yet, so this genuinely races the async reveal.
    const result = await executeAction(browser.page, { action: 'assert_visible', ref: secretRef, reason: 'test' }, delayedOutline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 2)
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction assert_text succeeds against text that only appears after a real async delay, instead of failing instantly', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const revealRef = outline.elements.find((el) => el.name === 'Load content')!.ref
    await executeAction(browser.page, { action: 'click', ref: revealRef, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)

    const secretRef = 'e1'
    const delayedOutline = { elements: [{ ref: secretRef, tag: 'p', role: 'text', name: 'delayed-secret', selector: '#delayed-secret' }], truncated: false, totalFound: 1 }
    const result = await executeAction(
      browser.page,
      { action: 'assert_text', ref: secretRef, expectedText: 'Delayed content loaded', reason: 'test' },
      delayedOutline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      2
    )
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction assert_page_text finds real page text that was never in the interactive-elements outline at all', async (t) => {
  // The real, deeper gap this fixes: snapshot()'s SELECTOR
  // ('button, a, input, select, textarea, [role]') never includes a plain
  // heading with no ARIA role — confirmed live against
  // the-internet.herokuapp.com's own `<h4>Hello World!</h4>`, no `role`
  // attribute at all. No amount of waiting makes such text assertable via
  // assert_visible/assert_text, since there's never a `ref` for it. This
  // fixture's own `<h1>Simple Reveal</h1>` is the same shape (no `role`).
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    assert.ok(!outline.elements.some((el) => el.name.includes('Simple Reveal')), 'test setup: the heading must NOT be in the outline for this to prove anything')

    const result = await executeAction(browser.page, { action: 'assert_page_text', expectedText: 'Simple Reveal', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction assert_page_text succeeds against text with no ARIA role that only appears after a real async delay', async (t) => {
  // Combines both real, live-found gaps in one scenario: an element with no
  // role (so assert_visible/assert_text could never target it even
  // instantly) whose content also only appears after an async delay (so
  // even a whole-page instant text check would have missed it without the
  // poll-based retry in assert_page_text's own implementation).
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const btnRef = outline.elements.find((el) => el.name === 'Load heading')!.ref
    const clickResult = await executeAction(browser.page, { action: 'click', ref: btnRef, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
    assert.equal(clickResult.ok, true)

    // Immediately after the click — the fixture's 800ms delay hasn't
    // elapsed yet, so this genuinely races the async reveal, same as the
    // assert_visible/assert_text poll tests above.
    const result = await executeAction(browser.page, { action: 'assert_page_text', expectedText: 'Hello World!', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 2)
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction on a failing assertion captures a real screenshot and DOM snapshot as evidence', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    await browser.page.goto(server.url)
    // The secret paragraph isn't a real snapshot-eligible interactive
    // element, so a hand-built single-element outline stands in for what a
    // real snapshot would report if it were.
    const secretRef = 'e1'
    const outline = { elements: [{ ref: secretRef, tag: 'p', role: 'text', name: 'secret', selector: '#secret' }], truncated: false, totalFound: 1 }

    // The secret paragraph starts hidden — asserting it's visible without
    // clicking reveal first must genuinely fail, not silently pass.
    const result = await executeAction(
      browser.page,
      { action: 'assert_visible', ref: secretRef, reason: 'test' },
      outline,
      artifactDir,
      1
    )
    assert.equal(result.ok, false)
    assert.ok(result.screenshotPath && existsSync(result.screenshotPath))
    assert.ok(result.domSnapshotPath && existsSync(result.domSnapshotPath))
  } finally {
    await browser.close()
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

// Self-healing selectors: real repro of "the page changed between snapshot
// and action execution" via page.evaluate() DOM mutation, rather than
// relying on a real timing race. Each test snapshots first, then mutates,
// then calls executeAction with the now-stale outline/ref — exactly the
// shape a real async re-render or node replacement produces.

test('executeAction heals a click when its selector goes stale between snapshot and execution, and discloses it', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="container"><button id="original-btn" onclick="window.__clickedId=this.id">Delete</button></div>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Delete')!.ref

    // Simulates a real re-render replacing the node (e.g. a framework
    // re-generating an id) — the original selector now matches nothing.
    // A plain string, not a typed arrow function, matches this project's
    // own `SNAPSHOT_SCRIPT` convention — the tsconfig has no `dom` lib, so
    // an inline callback referencing `document`/`window` doesn't typecheck.
    await browser.page.evaluate(
      `document.getElementById('original-btn').outerHTML = '<button id="rerendered-btn" onclick="window.__clickedId=this.id">Delete</button>'`
    )

    const result = await executeAction(
      browser.page,
      { action: 'click', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, true)
    assert.equal(result.healed, true)
    assert.ok(result.healedSelector, 'must disclose the healed selector on the result')

    const clickedId = await browser.page.evaluate('window.__clickedId')
    assert.equal(clickedId, 'rerendered-btn', 'the click must have actually landed on the new element, not silently no-opped')
  } finally {
    await browser.close()
  }
})

test('executeAction refuses to heal when re-matching by name finds more than one ambiguous candidate', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="container"><button id="original-btn">Delete</button></div>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Delete')!.ref

    await browser.page.evaluate(
      `document.getElementById('original-btn').outerHTML = '<button id="a" onclick="window.__clickedId=this.id">Delete</button><button id="b" onclick="window.__clickedId=this.id">Delete</button>'`
    )

    const result = await executeAction(
      browser.page,
      { action: 'click', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, false)
    assert.match(result.failureDetail ?? '', /ambiguous/)

    const clickedId = await browser.page.evaluate('window.__clickedId')
    assert.equal(clickedId, undefined, 'must never guess which ambiguous candidate to click')
  } finally {
    await browser.close()
  }
})

test('executeAction never lets self-healing\'s ambiguity check depend on current scroll position', async (t) => {
  // The direct regression test for a design-review finding: if healing's
  // re-match snapshot used the same viewport-priority ordering the main
  // agentic loop opts into, an off-screen duplicate could silently fall
  // out of the (still 40-max) capped candidate list purely because of
  // where the page happened to be scrolled — flipping a correct "2
  // ambiguous candidates, refuse" into an incorrect "1 match, heal it."
  // `original-btn` here is fixed-position (always "in-viewport" by
  // definition), `far-delete` starts genuinely off-screen, and 40 filler
  // buttons (also fixed-position, so always in-viewport) push the total
  // past the 40-element cap — exactly the shape that would expose the bug
  // if the heal path used prioritizeViewport. It must not.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <button id="original-btn" style="position:fixed;top:0;left:0;">Delete</button>
      <div style="height: 3000px;"></div>
      <button id="far-delete">Delete</button>
      <div id="fillers"></div>
      <script>
        const fillers = document.getElementById('fillers')
        for (let i = 0; i < 40; i++) {
          const b = document.createElement('button')
          b.textContent = 'Filler'
          b.style.position = 'fixed'
          b.style.top = '0px'
          b.style.left = (i + 2) + 'px'
          b.style.width = '1px'
          b.style.height = '1px'
          fillers.appendChild(b)
        }
      </script>
    `)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Delete')!.ref

    // Rename the id so the outline's original selector ([id="original-btn"])
    // goes stale (0 matches), forcing a heal re-match by (tag, role, name)
    // — the page is still scrolled to the very top, so `far-delete` is
    // genuinely off-screen at this exact moment.
    await browser.page.evaluate(`document.getElementById('original-btn').id = 'renamed'`)

    const result = await executeAction(
      browser.page,
      { action: 'click', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, false)
    assert.match(result.failureDetail ?? '', /ambiguous/, `expected an honest ambiguous-refusal, got: ${result.failureDetail}`)
  } finally {
    await browser.close()
  }
})

test('executeAction scroll actually moves the page and reports scrolled:true, then honestly reports scrolled:false once at the bottom', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startScrollFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))

    const first = await executeAction(browser.page, { action: 'scroll', direction: 'down', reason: 'r' }, outline, artifactDir, 1)
    assert.equal(first.ok, true)
    assert.equal(first.scrolled, true)

    // Keep scrolling down until it genuinely stops moving anything —
    // bounded loop, robust to the real fixture/viewport height.
    let last = first
    for (let i = 0; i < 30 && last.scrolled; i++) {
      last = await executeAction(browser.page, { action: 'scroll', direction: 'down', reason: 'r' }, outline, artifactDir, 1)
    }
    assert.equal(last.scrolled, false, 'a scroll already at the page boundary must honestly report no movement')
    assert.equal(last.ok, true, 'a no-op scroll at a boundary is not itself a failure')
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction fails honestly, naming the reason, when re-matching by name finds no candidate at all', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="container"><button id="original-btn">Delete</button></div>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Delete')!.ref

    await browser.page.evaluate(`document.getElementById('original-btn').remove()`)

    const result = await executeAction(
      browser.page,
      { action: 'click', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, false)
    assert.match(result.failureDetail ?? '', /no candidate/)
  } finally {
    await browser.close()
  }
})

test('executeAction never heals a credential fill, even when an unambiguous healing candidate exists', async (t) => {
  // A heuristic (tag, role, name) match could land the real credential in
  // the wrong element — a missed step is strictly safer than a
  // misdirected secret. This must hold even in the easy case (exactly one
  // candidate available) to prove it's a hard rule, not just usually true.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<input id="original-input" placeholder="Username" />`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Username')!.ref

    await browser.page.evaluate(`document.getElementById('original-input').outerHTML = '<input id="rerendered-input" placeholder="Username" />'`)

    const result = await executeAction(
      browser.page,
      { action: 'fill', ref, value: USERNAME_PLACEHOLDER, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1,
      { username: 'ada', password: 'hunter2' }
    )
    assert.equal(result.ok, false)
    assert.equal(result.healed, undefined, 'a credential fill must never heal, not even attempt it')
  } finally {
    await browser.close()
  }
})

test('executeAction heals a fill+submit as one unit — both the fill and the Enter press land on the healed element', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <form onsubmit="window.__submitted=true; return false;">
        <input id="original-input" placeholder="Search" />
      </form>
    `)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Search')!.ref

    await browser.page.evaluate(`document.getElementById('original-input').outerHTML = '<input id="rerendered-input" placeholder="Search" />'`)

    const result = await executeAction(
      browser.page,
      { action: 'fill', ref, value: 'hello', submit: true, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, true)
    assert.equal(result.healed, true)

    const value = await browser.page.locator('#rerendered-input').inputValue()
    assert.equal(value, 'hello', 'the fill must have landed on the healed element')
    const submitted = await browser.page.evaluate('window.__submitted')
    assert.equal(submitted, true, 'the Enter press must also have landed on the healed element, not just the fill')
  } finally {
    await browser.close()
  }
})

test('executeAction never heals an assert_visible/assert_text, even when an unambiguous healing candidate exists', async (t) => {
  // The action-type boundary is the feature's single most important
  // safety property: assertions are the run's actual verdict, and healing
  // them would risk converting a genuine app regression into a false pass.
  // Both halves of this test now take ~ASSERT_WAIT_MS (5s) each, not an
  // instant fail: `assert_visible`/`assert_text` poll for that long before
  // giving up (see `ASSERT_WAIT_MS`'s own doc comment) — assertions are
  // still never healed (out of scope entirely, see DEVELOPMENT.md), they
  // just no longer give up on the very first instantaneous check either.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="container"><button id="original-btn">Delete</button></div>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Delete')!.ref

    // A real, unambiguous healing candidate exists — proving the assertion
    // still fails is not just "healing wasn't needed," it's "healing was
    // never attempted at all" for this action type.
    await browser.page.evaluate(`document.getElementById('original-btn').outerHTML = '<button id="rerendered-btn">Delete</button>'`)

    const visibleResult = await executeAction(
      browser.page,
      { action: 'assert_visible', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(visibleResult.ok, false)
    assert.equal(visibleResult.healed, undefined)

    const textResult = await executeAction(
      browser.page,
      { action: 'assert_text', ref, expectedText: 'Delete', reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      2
    )
    assert.equal(textResult.ok, false)
    assert.equal(textResult.healed, undefined)
  } finally {
    await browser.close()
  }
})

test('substitutePlaceholders replaces the exact tokens with real values, without mutating anything', () => {
  const original = `user: ${USERNAME_PLACEHOLDER}, pass: ${PASSWORD_PLACEHOLDER}`
  const result = substitutePlaceholders(original, { username: 'ada', password: 'hunter2' })
  assert.equal(result, 'user: ada, pass: hunter2')
  // The input string itself is unchanged — strings are immutable in JS, but
  // this also documents the contract: substitutePlaceholders must always
  // return a new string, never attempt to write back into anything.
  assert.equal(original, `user: ${USERNAME_PLACEHOLDER}, pass: ${PASSWORD_PLACEHOLDER}`)
})

test('substitutePlaceholders handles a placeholder mixed with literal text', () => {
  assert.equal(substitutePlaceholders(`prefix-${USERNAME_PLACEHOLDER}-suffix`, { username: 'ada' }), 'prefix-ada-suffix')
})

test('substitutePlaceholders leaves a value with no placeholder completely unchanged', () => {
  assert.equal(substitutePlaceholders('plain text', { username: 'ada', password: 'hunter2' }), 'plain text')
})

test('substitutePlaceholders leaves the placeholder token itself in place when no credentials are configured', () => {
  // Regression coverage for the "never guess" posture: if a credential
  // isn't actually configured, this must not silently produce an empty
  // string or throw — the token stays literally in the output, which the
  // real .fill() call downstream will then (correctly) fail to find a
  // matching field for, an honest failure rather than a silent wrong value.
  assert.equal(substitutePlaceholders(USERNAME_PLACEHOLDER, undefined), USERNAME_PLACEHOLDER)
  assert.equal(substitutePlaceholders(USERNAME_PLACEHOLDER, {}), USERNAME_PLACEHOLDER)
})

test('executeAction never mutates the action object when substituting a credential placeholder', async (t) => {
  // Regression test: runner.ts pushes this same action object reference
  // into `steps`/`history` right after executeAction returns — if the
  // substitution mutated `action.value` in place, the real secret would
  // leak into the generated spec and the next LLM prompt.
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startLoginFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    await browser.page.goto(server.url + '/login')
    const outline = await snapshot(browser.page)
    const usernameRef = outline.elements.find((el) => el.name.toLowerCase().includes('username'))!.ref

    const action = { action: 'fill' as const, ref: usernameRef, value: USERNAME_PLACEHOLDER, reason: 'test' }
    const result = await executeAction(browser.page, action, outline, artifactDir, 1, {
      username: LOGIN_FIXTURE_USERNAME,
      password: LOGIN_FIXTURE_PASSWORD,
    })

    assert.equal(result.ok, true)
    assert.equal(action.value, USERNAME_PLACEHOLDER, 'the action object must still show the placeholder, never the real value')
    assert.equal(
      await browser.page.locator('#username').inputValue(),
      LOGIN_FIXTURE_USERNAME,
      'but the real page must have received the real, substituted value'
    )
  } finally {
    await browser.close()
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('launchAgentBrowser with a captured storageState starts already authenticated', async (t) => {
  const probeBrowser = await withRealBrowser(t)
  if (!probeBrowser) return
  await probeBrowser.close()

  const server = await startLoginFixtureServer()
  try {
    // Log in for real once, in a throwaway browser, to capture a real session.
    const loginBrowser = await launchAgentBrowser({ headless: true })
    await loginBrowser.page.goto(server.url + '/login')
    await loginBrowser.page.locator('#username').fill(LOGIN_FIXTURE_USERNAME)
    await loginBrowser.page.locator('#password').fill(LOGIN_FIXTURE_PASSWORD)
    await loginBrowser.page.locator('#submit-btn').click()
    await loginBrowser.page.waitForURL(/\/dashboard/)
    const state = await loginBrowser.context.storageState()
    await loginBrowser.close()

    // Fresh browser, loaded with that captured session — should reach the
    // gated page directly, no login flow needed.
    const testBrowser = await launchAgentBrowser({ headless: true, storageState: state })
    await testBrowser.page.goto(server.url + '/dashboard')
    assert.ok(testBrowser.page.url().endsWith('/dashboard'), 'must not have been redirected back to /login')
    assert.equal(await testBrowser.page.locator('#welcome').isVisible(), true)
    await testBrowser.close()
  } finally {
    await server.close()
  }
})

test('launchAgentBrowser uses the same default viewport with or without the explicit newContext() call', async (t) => {
  // Regression test for the newContext()/newPage() refactor needed to
  // support storageState — verified directly (not just trusted from
  // Playwright's own doc wording) that switching from the newPage()
  // shortcut to explicit newContext()+newPage() doesn't silently change
  // default behavior for the existing, non-auth path.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    const viewport = browser.page.viewportSize()
    assert.ok(viewport && viewport.width > 0 && viewport.height > 0, 'expected a real, non-empty default viewport')
  } finally {
    await browser.close()
  }
})

test('launchAgentBrowser with recordVideoDir records a real, nonempty .webm on close', async (t) => {
  // Regression test for the highest-risk edit in the --record-video
  // feature: close() must actually call context.close() (not just
  // browser.close()) for Playwright to finalize/flush the video file —
  // verified against a real Chromium recording, not assumed from docs.
  const videoDir = mkdtempSync(join(tmpdir(), 'five46-video-test-'))
  let browser: AgentBrowser
  try {
    browser = await launchAgentBrowser({ headless: true, recordVideoDir: videoDir })
  } catch (err) {
    t.skip(`playwright unavailable in this environment: ${err instanceof Error ? err.message : String(err)}`)
    rmSync(videoDir, { recursive: true, force: true })
    return
  }
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    await browser.page.locator('#reveal-btn').click()
    const { videoPath } = await browser.close()
    assert.ok(videoPath, 'expected a real video path to be returned')
    assert.ok(existsSync(videoPath!), 'expected the video file to actually exist on disk')
    assert.ok(statSync(videoPath!).size > 0, 'expected a nonempty video file, not just an empty placeholder')
  } finally {
    await server.close()
    rmSync(videoDir, { recursive: true, force: true })
  }
})

test('launchAgentBrowser without recordVideoDir returns no videoPath on close — the feature is opt-in', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const { videoPath } = await browser.close()
    assert.equal(videoPath, undefined)
  } finally {
    await server.close()
  }
})
