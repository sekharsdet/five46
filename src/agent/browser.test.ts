import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchAgentBrowser, snapshot, executeAction, substitutePlaceholders, evaluateWithNavigationRaceRetry, USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './browser'
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

test('snapshot finds a real icon-only click target with no button/a tag and no role, matching demoqa.com\'s actual edit-icon markup', async (t) => {
  // Real, live-found gap: confirmed by driving a real browser against
  // demoqa.com/webtables and dumping the rendered row HTML — the edit
  // control is exactly this shape (a <span> with a title and a pointer
  // cursor, wrapping an <svg>, no button/a tag, no role at all). No amount
  // of good prompting helps if the target was never in the outline to
  // begin with.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <span id="edit-record-4" data-toggle="tooltip" title="Edit" style="cursor: pointer;"><svg></svg></span>
    `)
    const outline = await snapshot(browser.page)
    const el = outline.elements.find((e) => e.selector === '[id="edit-record-4"]')
    assert.ok(el, 'the icon-only span must appear in the outline')
    assert.equal(el!.name, 'Edit', 'title must be used as the accessible name, since textContent is empty (just an svg)')
    assert.equal(el!.role, 'span', 'honest fallback to the real tag name — never a guessed semantic role it has not earned')
  } finally {
    await browser.close()
  }
})

test('snapshot excludes a plain tooltip that has a title but is not actually clickable', async (t) => {
  // The false-positive this guards against: title alone is common (an
  // <abbr>, an <img>) and mostly does not mean "clickable" — only the
  // combination of a real name source AND an actual pointer cursor
  // qualifies, matching the real edit-icon case above.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<abbr id="not-clickable" title="World Wide Web">WWW</abbr>`)
    const outline = await snapshot(browser.page)
    assert.ok(!outline.elements.some((e) => e.selector === '[id="not-clickable"]'), 'a title-only, non-pointer-cursor element must not appear in the outline')
  } finally {
    await browser.close()
  }
})

test('snapshot never lists an element twice when it already matches the base selector and also has a title', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<button id="save-btn" title="Save this record">Save</button>`)
    const outline = await snapshot(browser.page)
    const matches = outline.elements.filter((e) => e.selector === '[id="save-btn"]')
    assert.equal(matches.length, 1, 'an element already covered by the base selector must never be duplicated by the icon-candidate check')
    assert.equal(matches[0].role, 'button', 'the base selector\'s own role computation must win, unaffected by the icon check')
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

test('executeAction assert_value checks a real input\'s current VALUE, which assert_text can never see — a real, live-found gap found via src/eval/\'s double-click-to-edit regression probe: body.innerText() genuinely never includes an input\'s value string, confirmed directly', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<input id="notes" value="Edited!" /><p>Some unrelated visible text</p>`)
    const bodyText = await browser.page.locator('body').innerText()
    assert.ok(!bodyText.includes('Edited!'), 'test setup: the value must NOT be part of the page\'s visible text for this to prove anything')

    const outline = await snapshot(browser.page)
    const input = outline.elements.find((el) => el.role === 'textbox')
    assert.ok(input, `expected the input as a candidate, got: ${JSON.stringify(outline.elements)}`)

    const result = await executeAction(browser.page, { action: 'assert_value', ref: input!.ref, expectedValue: 'Edited!', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
  }
})

test('executeAction assert_value fails honestly, naming the mismatch, when the value genuinely does not match', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<input id="notes" value="something else" />`)
    const outline = await snapshot(browser.page)
    const input = outline.elements.find((el) => el.role === 'textbox')
    const result = await executeAction(browser.page, { action: 'assert_value', ref: input!.ref, expectedValue: 'Edited!', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
    assert.equal(result.ok, false)
    assert.match(result.failureDetail ?? '', /Edited!/)
  } finally {
    await browser.close()
  }
})

test('executeAction assert_page_text finds real page text that was never in the interactive-elements outline at all', async (t) => {
  // The real, deeper gap this fixes: real, rendered text with no
  // accessible representation at all — a plain `<div>`/`<span>` with no
  // ARIA role and no `aria-label`, confirmed live to still be genuinely
  // outline-invisible even under the new accessibility-tree-based discovery
  // (unlike a heading or a `role="status"` message, which that mechanism
  // now legitimately surfaces on its own — a real, deliberate improvement,
  // see DEVELOPMENT.md — so this repro deliberately avoids that shape). No
  // amount of waiting makes such text assertable via assert_visible/
  // assert_text, since there's never a `ref` for it.
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    await browser.page.evaluate(`(() => {
      const el = document.createElement('div')
      el.textContent = 'Visible But Not Accessible'
      document.body.appendChild(el)
    })()`)
    const outline = await snapshot(browser.page)
    assert.ok(!outline.elements.some((el) => el.name.includes('Visible But Not Accessible')), 'test setup: the div must NOT be in the outline for this to prove anything')

    const result = await executeAction(browser.page, { action: 'assert_page_text', expectedText: 'Visible But Not Accessible', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 1)
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

test('executeAction assert_page_text_absent passes once a real click removes the target text from the DOM entirely, and fails honestly while the text is still there', async (t) => {
  // Real, live-found gap: every other assertion only ever proves presence.
  // A goal confirming something is GONE (a TodoMVC item removed from the
  // DOM under an "Active" filter, confirmed live — not merely CSS-hidden)
  // had no honest action to express at all, so the model looped instead.
  // This fixture's #notice is removed via a real .remove() call, the same
  // shape as that live case.
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)

    const stillPresent = await executeAction(
      browser.page,
      { action: 'assert_page_text_absent', expectedText: 'You have unread notifications', reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(stillPresent.ok, false, 'must fail honestly while the text is genuinely still on the page')

    const dismissRef = outline.elements.find((el) => el.name === 'Dismiss notice')!.ref
    const clickResult = await executeAction(browser.page, { action: 'click', ref: dismissRef, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-agent-test-')), 2)
    assert.equal(clickResult.ok, true)

    const nowAbsent = await executeAction(
      browser.page,
      { action: 'assert_page_text_absent', expectedText: 'You have unread notifications', reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      3
    )
    assert.equal(nowAbsent.ok, true)
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

test('executeAction on a failing assertion captures the page\'s real visible text to a local file, even when the interactive-elements outline is sparse', async (t) => {
  // Reproduces the real, live-found bug directly: a page with rich TEXT
  // content but almost no ELEMENT the outline surfaces — the exact shape
  // that made a root-cause hypothesis wrongly call a fully-rendered real
  // page "blank." Proves the captured file holds the real content the
  // sparse outline alone would never reveal. `aria-hidden="true"` is used
  // (rather than plain text/headings, which `snapshot()`'s accessibility-
  // tree-based discovery now surfaces on its own — a real, deliberate
  // improvement to the exact bug this test guards, see DEVELOPMENT.md) to
  // keep this specific repro genuinely reproducible regardless: content
  // explicitly hidden from the accessibility tree is still real, rendered,
  // *visible* text a human — and this file's own visibleTextPath capture,
  // which reads the page directly, not through any outline — must still see.
  const browser = await withRealBrowser(t)
  if (!browser) return
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    await browser.page.setContent(`
      <div aria-hidden="true">
        <h1>Single Room</h1>
        <p>A cozy, accessible room with a view.</p>
        <div>£100 per night</div>
      </div>
      <button id="unrelated-btn">Unrelated</button>
    `)
    const outline = await snapshot(browser.page)
    // Confirms the real gap: the outline the root-cause LLM used to see
    // never mentions the room's actual description/price at all, despite
    // the page being full of that real, rendered content.
    assert.ok(!outline.elements.some((el) => el.name.includes('£100')), 'test setup: the price must not be in the outline for this to prove anything')

    // A ref that never existed in this outline — a simple, reliable way to
    // force a genuine failure through the same fail() path any real
    // assertion/click/fill failure goes through.
    const result = await executeAction(browser.page, { action: 'assert_visible', ref: 'e-does-not-exist', reason: 'test' }, outline, artifactDir, 1)
    assert.equal(result.ok, false)
    assert.ok(result.visibleTextPath && existsSync(result.visibleTextPath))
    const capturedText = readFileSync(result.visibleTextPath!, 'utf8')
    assert.ok(capturedText.includes('Single Room'))
    assert.ok(capturedText.includes('£100 per night'), 'the real content missing from the sparse outline must be in the captured file')
  } finally {
    await browser.close()
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

test('executeAction records a live-verified getByRole locator when it resolves uniquely to the real target element', async (t) => {
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
    assert.deepEqual(result.verifiedRoleLocator, { role: 'button', name: 'Show secret message' })
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction does not record a verified getByRole locator when two elements share the same role and name', async (t) => {
  // A real, live risk this guards against: `getByRole` would resolve
  // ambiguously (matching both), so preferring it in the generated spec
  // would produce a broken, strict-mode-violating standalone test —
  // falling back to the raw, always-unique positional selector instead.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<button id="a">Delete</button><button id="b">Delete</button>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.selector.includes('"a"'))!.ref

    const result = await executeAction(
      browser.page,
      { action: 'click', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, true)
    assert.equal(result.verifiedRoleLocator, undefined)
  } finally {
    await browser.close()
  }
})

test('executeAction still records a verified getByRole locator when the accessible name was truncated to 80 chars, via substring (not exact) matching', async (t) => {
  // `accessibleName()` truncates textContent to 80 chars — an exact-match
  // getByRole call against that truncated name would never resolve against
  // the real, untruncated element, silently defeating the feature on
  // exactly the long product-title links it exists for on real sites.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    const longText = 'A'.repeat(120)
    await browser.page.setContent(`<a href="#" id="long-link">${longText}</a>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements[0].ref
    assert.equal(outline.elements[0].name.length, 80, 'test setup: the outline name must actually be the truncated 80-char version')

    const result = await executeAction(
      browser.page,
      { action: 'click', ref, reason: 'test' },
      outline,
      mkdtempSync(join(tmpdir(), 'five46-agent-test-')),
      1
    )
    assert.equal(result.ok, true)
    assert.ok(result.verifiedRoleLocator, 'must still verify via substring match against the truncated name')
    assert.equal(result.verifiedRoleLocator!.role, 'link')
  } finally {
    await browser.close()
  }
})

test('executeAction re-verifies against the healed candidate, not the original stale element, after healing a stale selector', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="container"><button id="original-btn" onclick="window.__clickedId=this.id">Delete</button></div>`)
    const outline = await snapshot(browser.page)
    const ref = outline.elements.find((el) => el.name === 'Delete')!.ref

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
    assert.deepEqual(result.verifiedRoleLocator, { role: 'button', name: 'Delete' })
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

test('evaluateWithNavigationRaceRetry retries exactly once on the specific "Execution context was destroyed" error, then returns the real result', async () => {
  let calls = 0
  let settled = false
  const result = await evaluateWithNavigationRaceRetry(
    async () => {
      calls++
      if (calls === 1) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')
      return 'ok'
    },
    async () => {
      settled = true
    }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
  assert.ok(settled, 'expected settle() to be awaited before the retry')
})

test('evaluateWithNavigationRaceRetry lets a second consecutive failure propagate — only one retry, never a loop', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      evaluateWithNavigationRaceRetry(
        async () => {
          calls++
          throw new Error('Execution context was destroyed, most likely because of a navigation')
        },
        async () => {}
      ),
    /Execution context was destroyed/
  )
  assert.equal(calls, 2, 'expected exactly one retry (two total attempts), not an unbounded loop')
})

test('evaluateWithNavigationRaceRetry does not retry an unrelated error — only this exact transient race is special-cased', async () => {
  let calls = 0
  let settleCalled = false
  await assert.rejects(
    () =>
      evaluateWithNavigationRaceRetry(
        async () => {
          calls++
          throw new Error('some genuine script error')
        },
        async () => {
          settleCalled = true
        }
      ),
    /genuine script error/
  )
  assert.equal(calls, 1, 'a real, unrelated error must fail immediately, not be retried')
  assert.equal(settleCalled, false)
})

test('evaluateWithNavigationRaceRetry never calls settle() or retries when the first attempt already succeeds', async () => {
  let calls = 0
  let settleCalled = false
  const result = await evaluateWithNavigationRaceRetry(
    async () => {
      calls++
      return 'first-try'
    },
    async () => {
      settleCalled = true
    }
  )
  assert.equal(result, 'first-try')
  assert.equal(calls, 1)
  assert.equal(settleCalled, false)
})

test('evaluateWithNavigationRaceRetry survives a settle() that itself throws — the retry still runs', async () => {
  let calls = 0
  const result = await evaluateWithNavigationRaceRetry(
    async () => {
      calls++
      if (calls === 1) throw new Error('Execution context was destroyed, most likely because of a navigation')
      return 'recovered'
    },
    async () => {
      throw new Error('waitForLoadState timed out')
    }
  )
  assert.equal(result, 'recovered')
  assert.equal(calls, 2)
})

test('snapshot() genuinely recovers from a real navigation race against a real browser, not just the isolated retry helper', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    // Fires a real navigation without awaiting it, then immediately calls
    // snapshot() so it genuinely races the frame's context teardown — the
    // same shape of race that produced the live-caught exception this fix
    // targets, not a mocked stand-in. Whether this particular run actually
    // wins the race is inherently timing-dependent (that's what makes it
    // "transient"), so this asserts the one thing that must always be true
    // either way: snapshot() still returns a real, usable outline afterward
    // instead of throwing — the deterministic tests above already cover the
    // retry policy itself precisely.
    const navigation = browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    await navigation
    assert.ok(outline.elements.length > 0, 'expected a real outline back, whether or not this run actually hit the race')
  } finally {
    await browser.close()
    await server.close()
  }
})

test('executeAction hover triggers a real :hover state, revealing CSS-gated content — a real, live gap: the-internet.herokuapp.com/hovers had no hover action at all, only click/fill', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <style>#tip { display: none; } #target:hover + #tip { display: block; }</style>
      <button id="target">Hover for tip</button>
      <p id="tip" role="status">Tip revealed</p>
    `)
    const outline = await snapshot(browser.page)
    const target = outline.elements.find((el) => el.name === 'Hover for tip')
    assert.ok(target, `expected a "Hover for tip" element, got: ${JSON.stringify(outline.elements)}`)
    const result = await executeAction(browser.page, { action: 'hover', ref: target!.ref, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-')), 1)
    assert.equal(result.ok, true)
    await assert.doesNotReject(browser.page.locator('#tip').waitFor({ state: 'visible', timeout: 2000 }), 'hovering should have revealed the CSS-gated tip')
  } finally {
    await browser.close()
  }
})

test('executeAction dblclick triggers a real dblclick event, distinct from two ordinary clicks — a real, live-found gap found via src/eval/\'s regression corpus: an inline-edit-mode UI has no honest action without this', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="label" aria-label="Double-click to edit" ondblclick="document.getElementById('result').textContent='edit mode'">Double-click to edit</div><p id="result" role="status"></p>`)
    const outline = await snapshot(browser.page)
    const target = outline.elements.find((el) => el.name.includes('Double-click'))
    assert.ok(target, `expected the label as a candidate, got: ${JSON.stringify(outline.elements)}`)
    const result = await executeAction(browser.page, { action: 'dblclick', ref: target!.ref, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-')), 1)
    assert.equal(result.ok, true)
    assert.equal(await browser.page.locator('#result').textContent(), 'edit mode')
  } finally {
    await browser.close()
  }
})

test('executeAction drag performs a real drag gesture that a mouse-event-based custom sortable list (not native HTML5 draggable) actually responds to — a real, live-found gap found via src/eval/\'s regression corpus: no existing action could express a drag at all', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <ul id="list">
        <li id="item-a" data-name="A">A</li>
        <li id="item-b" data-name="B">B</li>
      </ul>
      <p id="order" role="status">Order: A, B</p>
      <script>
        let dragging = null;
        document.querySelectorAll('#list li').forEach((li) => li.addEventListener('mousedown', () => { dragging = li; }));
        document.addEventListener('mousemove', (e) => {
          if (!dragging) return;
          for (const item of document.querySelectorAll('#list li')) {
            if (item === dragging) continue;
            const rect = item.getBoundingClientRect();
            if (e.clientY > rect.top && e.clientY < rect.bottom) {
              item.parentNode.insertBefore(dragging, item);
              break;
            }
          }
        });
        document.addEventListener('mouseup', () => {
          if (dragging) document.getElementById('order').textContent = 'Order: ' + Array.from(document.querySelectorAll('#list li')).map((el) => el.dataset.name).join(', ');
          dragging = null;
        });
      </script>
    `)
    const outline = await snapshot(browser.page)
    const itemA = outline.elements.find((el) => el.name === 'A')
    const itemB = outline.elements.find((el) => el.name === 'B')
    assert.ok(itemA && itemB, `expected both list items as candidates, got: ${JSON.stringify(outline.elements)}`)
    const result = await executeAction(browser.page, { action: 'drag', ref: itemB!.ref, targetRef: itemA!.ref, reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-')), 1)
    assert.equal(result.ok, true)
    assert.equal(await browser.page.locator('#order').textContent(), 'Order: B, A')
  } finally {
    await browser.close()
  }
})

test('executeAction press_key dispatches a real keyboard event — unlike fill, which only sets a value directly and never fires keydown/keyup at all', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <input id="target" type="text" />
      <p id="result" role="status"></p>
      <script>
        document.getElementById('target').addEventListener('keydown', (e) => {
          document.getElementById('result').textContent = 'Key: ' + e.key;
        });
      </script>
    `)
    const outline = await snapshot(browser.page)
    const target = outline.elements.find((el) => el.role === 'textbox')
    assert.ok(target)
    const result = await executeAction(browser.page, { action: 'press_key', ref: target!.ref, key: 'Escape', reason: 'test' }, outline, mkdtempSync(join(tmpdir(), 'five46-')), 1)
    assert.equal(result.ok, true)
    assert.equal(await browser.page.locator('#result').textContent(), 'Key: Escape')
  } finally {
    await browser.close()
  }
})

test('snapshot flags a real <input type="file"> with isFileInput, and executeAction upload actually attaches the file — fill silently no-ops on this element type instead', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const dir = mkdtempSync(join(tmpdir(), 'five46-upload-'))
  const filePath = join(dir, 'sample.txt')
  writeFileSync(filePath, 'five46 upload test fixture')
  try {
    await browser.page.setContent(`
      <input id="file-input" type="file" />
      <input id="text-input" type="text" />
      <p id="result" role="status"></p>
      <script>
        document.getElementById('file-input').addEventListener('change', (e) => {
          document.getElementById('result').textContent = 'File: ' + (e.target.files[0] ? e.target.files[0].name : 'none');
        });
      </script>
    `)
    const outline = await snapshot(browser.page)
    const fileInput = outline.elements.find((el) => el.selector === '[id="file-input"]')
    const textInput = outline.elements.find((el) => el.selector === '[id="text-input"]')
    assert.equal(fileInput?.isFileInput, true)
    assert.equal(textInput?.isFileInput, undefined, 'an ordinary text input must not be flagged as a file input')

    const result = await executeAction(browser.page, { action: 'upload', ref: fileInput!.ref, filePath, reason: 'test' }, outline, dir, 1)
    assert.equal(result.ok, true)
    assert.equal(await browser.page.locator('#result').textContent(), 'File: sample.txt')
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('launchAgentBrowser auto-accepts a native confirm() dialog by default — Playwright itself auto-dismisses (Cancel) with no handler at all, a real, live-found gap', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <button id="confirm-btn" onclick="document.getElementById('result').textContent = confirm('sure?') ? 'accepted' : 'dismissed'">Confirm</button>
      <p id="result" role="status"></p>
    `)
    await browser.page.locator('#confirm-btn').click()
    await assert.doesNotReject(
      browser.page.locator('#result').filter({ hasText: 'accepted' }).waitFor({ state: 'visible', timeout: 2000 }),
      'expected the confirm() dialog to be auto-accepted, not left at Playwright\'s own default (auto-dismiss/Cancel)'
    )
  } finally {
    await browser.close()
  }
})

test('snapshot finds elements inside a real iframe, tagged with frameChain, and executeAction resolves them via a chained frameLocator — a real, live-found gap: a TinyMCE-style editor iframe was previously completely invisible to both snapshot() and executeAction()', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<h1>Outer</h1><iframe id="inner-frame"></iframe>`)
    const frame = browser.page.frames().find((f) => f !== browser.page.mainFrame())
    assert.ok(frame, 'expected a real child frame for the iframe element')
    await frame!.setContent(`
      <input id="inner-input" />
      <button id="inner-btn" onclick="document.getElementById('inner-result').textContent='clicked'">Go</button>
      <p id="inner-result" role="status"></p>
    `)

    const outline = await snapshot(browser.page)
    const innerInput = outline.elements.find((el) => el.role === 'textbox')
    const innerBtn = outline.elements.find((el) => el.role === 'button')
    assert.ok(innerInput, `expected a textbox from inside the iframe, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(innerBtn)
    assert.ok(innerInput!.frameChain && innerInput!.frameChain.length === 1, 'expected a one-level frameChain for a direct child iframe')

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const fillResult = await executeAction(browser.page, { action: 'fill', ref: innerInput!.ref, value: 'hi', reason: 'test' }, outline, dir, 1)
    assert.equal(fillResult.ok, true)
    const clickResult = await executeAction(browser.page, { action: 'click', ref: innerBtn!.ref, reason: 'test' }, outline, dir, 2)
    assert.equal(clickResult.ok, true)

    assert.equal(await frame!.locator('#inner-result').textContent(), 'clicked')
  } finally {
    await browser.close()
  }
})

test('snapshot finds a contenteditable region with an implicit "textbox" role and executeAction fills it via a real click+type — a real, live-found gap: a rich-text editor\'s actual editable surface (a plain div/body with contenteditable="true", not an <input>/<textarea>) was previously invisible to the outline entirely', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <div id="toolbar"><button id="bold-btn">Bold</button></div>
      <div id="editor" contenteditable="true" aria-label="Message body"></div>
      <div id="readonly-note" contenteditable="false">Not editable</div>
    `)

    const outline = await snapshot(browser.page)
    const editable = outline.elements.find((el) => el.name === 'Message body')
    const readonlyNote = outline.elements.find((el) => el.name === 'Not editable')
    assert.ok(editable, `expected the contenteditable div as a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.equal(editable!.role, 'textbox')
    assert.equal(readonlyNote, undefined, 'contenteditable="false" must never be surfaced as a fillable candidate')

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const fillResult = await executeAction(browser.page, { action: 'fill', ref: editable!.ref, value: 'hello from five46', reason: 'test' }, outline, dir, 1)
    assert.equal(fillResult.ok, true)
    assert.equal(await browser.page.locator('#editor').innerText(), 'hello from five46')
  } finally {
    await browser.close()
  }
})

test('snapshot surfaces a plain, non-decorative <img> as a hover candidate — a real, live-found gap: the-internet.herokuapp.com/hovers reveals a caption on :hover, but the avatar image triggering it has no role, no title, and no pointer cursor, so it was completely invisible to every existing candidate signal', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <style>.figcaption { display: none; } .figure:hover .figcaption { display: block; }</style>
      <div class="figure">
        <img src="/avatar1.jpg" alt="User Avatar 1">
        <div class="figcaption" role="status">name: user1</div>
      </div>
      <a href="/profile"><img src="/avatar2.jpg" alt="User Avatar 2"></a>
      <img src="/spacer.gif" alt="">
    `)

    const outline = await snapshot(browser.page)
    const avatar1 = outline.elements.find((el) => el.name === 'User Avatar 1')
    const avatar2 = outline.elements.find((el) => el.role === 'img' && el.name === 'User Avatar 2')
    const spacer = outline.elements.find((el) => el.tag === 'img' && el.name === '')
    assert.ok(avatar1, `expected the standalone avatar image as a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.equal(avatar1!.role, 'img')
    // An image inside a real <a> is a genuinely distinct accessibility-tree
    // node from the link itself (both are real, legitimate targets — hover
    // the image specifically, or click the link) — a deliberate behavior
    // change from the old, bespoke img-fallback heuristic's own anti-
    // duplication rule, which doesn't apply to this discovery mechanism.
    assert.ok(avatar2, `expected the linked avatar image to also be a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.equal(spacer, undefined, 'alt="" is the explicit decorative-image signal and must never be surfaced')

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const hoverResult = await executeAction(browser.page, { action: 'hover', ref: avatar1!.ref, reason: 'test' }, outline, dir, 1)
    assert.equal(hoverResult.ok, true)
    await browser.page.locator('.figcaption').waitFor({ state: 'visible', timeout: 2000 })
  } finally {
    await browser.close()
  }
})

test('AgentBrowser.page/pageIndex automatically switch to a newly opened tab once its navigation settles — a real, live-found gap: every subsequent snapshot/action used to keep silently operating on the now-stale original tab', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    const originalPage = browser.page
    assert.equal(browser.pageIndex, 0)
    await browser.page.goto(server.url)
    // A real http:// target (not a data: URL) — Chromium blocks a
    // target="_blank" navigation straight to a data: URL outright, which
    // isn't what this test is about (that's a browser security policy, not
    // this feature). A plain string page.evaluate() (not a typed function)
    // matches this file's own SNAPSHOT_SCRIPT-style convention: this
    // project's tsconfig deliberately has no "dom" lib, so a real function
    // referencing `document` wouldn't type-check here either.
    await browser.page.evaluate(`(() => {
      const a = document.createElement('a')
      a.id = 'open-link'
      a.href = ${JSON.stringify(server.url)}
      a.target = '_blank'
      a.textContent = 'Open'
      document.body.appendChild(a)
    })()`)
    await browser.page.locator('#open-link').click()

    const deadline = Date.now() + 5000
    while (browser.page === originalPage && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.notEqual(browser.page, originalPage, 'expected AgentBrowser.page to switch to the newly opened tab')
    assert.equal(browser.pageIndex, 1)
    assert.equal(browser.page.url(), server.url + '/', 'expected the new tab to have really navigated to the fixture server')
  } finally {
    await browser.close()
    await server.close()
  }
})

// snapshot — replaces SNAPSHOT_SCRIPT's hand-rolled
// querySelectorAll/accessibleName()/roleOf() reimplementation with
// Playwright's own ariaSnapshot({ mode: 'ai' }), a first-party API purpose-
// built for AI browser agents. See DEVELOPMENT.md's "Migrating element
// discovery to Playwright's own accessibility snapshot" for the full
// investigation and root-cause diagnosis: every "gap found on a new site"
// across three separate live-testing sessions traced back to the OLD
// mechanism reimplementing accessible-name/role computation instead of using
// the browser's own, already-correct implementation of it. Every test below
// mirrors a real, historical "found via live gap" fix from those sessions,
// proving the new mechanism covers it natively rather than needing its own
// bespoke patch.

test('snapshot finds ordinary interactive elements with correct role/name, same as the old mechanism', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  const server = await startFixtureServer()
  try {
    await browser.page.goto(server.url)
    const outline = await snapshot(browser.page)
    const revealBtn = outline.elements.find((el) => el.name === 'Show secret message')
    const nameInput = outline.elements.find((el) => el.role === 'textbox')
    assert.ok(revealBtn, `expected the reveal button, got: ${JSON.stringify(outline.elements)}`)
    assert.equal(revealBtn!.role, 'button')
    assert.ok(nameInput)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('snapshot finds a contenteditable region natively, with executeAction able to fill it — no bespoke contenteditable heuristic needed', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <div id="toolbar"><button id="bold-btn">Bold</button></div>
      <div id="editor" contenteditable="true" aria-label="Message body"></div>
      <div id="readonly-note" contenteditable="false">Not editable</div>
    `)
    const outline = await snapshot(browser.page)
    const editable = outline.elements.find((el) => el.name === 'Message body')
    assert.ok(editable, `expected the contenteditable div as a candidate, got: ${JSON.stringify(outline.elements)}`)

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const fillResult = await executeAction(browser.page, { action: 'fill', ref: editable!.ref, value: 'hello from five46', reason: 'test' }, outline, dir, 1)
    assert.equal(fillResult.ok, true)
    assert.equal(await browser.page.locator('#editor').innerText(), 'hello from five46')
  } finally {
    await browser.close()
  }
})

test('snapshot finds a plain heading with no ARIA role natively, assertable directly instead of needing assert_page_text', async (t) => {
  // The exact real, live-found gap that motivated assert_page_text in the
  // first place (the-internet.herokuapp.com's own <h4>Hello World!</h4>) —
  // now a real, directly-assertable ref instead of only reachable via a
  // whole-page text search.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<h4 id="plain-heading">Hello World!</h4>`)
    const outline = await snapshot(browser.page)
    const heading = outline.elements.find((el) => el.name === 'Hello World!')
    assert.ok(heading, `expected the plain heading as a candidate, got: ${JSON.stringify(outline.elements)}`)

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const result = await executeAction(browser.page, { action: 'assert_visible', ref: heading!.ref, reason: 'test' }, outline, dir, 1)
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
  }
})

test('snapshot finds a plain <img alt> as a hover candidate natively — no bespoke img[alt] heuristic needed', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <style>.figcaption { display: none; } .figure:hover .figcaption { display: block; }</style>
      <div class="figure">
        <img src="/avatar1.jpg" alt="User Avatar 1">
        <div class="figcaption" role="status">name: user1</div>
      </div>
    `)
    const outline = await snapshot(browser.page)
    const avatar = outline.elements.find((el) => el.name === 'User Avatar 1')
    assert.ok(avatar, `expected the avatar image as a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.equal(avatar!.role, 'img')

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const hoverResult = await executeAction(browser.page, { action: 'hover', ref: avatar!.ref, reason: 'test' }, outline, dir, 1)
    assert.equal(hoverResult.ok, true)
    await browser.page.locator('.figcaption').waitFor({ state: 'visible', timeout: 2000 })
  } finally {
    await browser.close()
  }
})

test('snapshot finds elements inside a real iframe natively, tagged with frameChain, resolved via a chained frameLocator for codegen', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<h1>Outer</h1><iframe id="inner-frame"></iframe>`)
    const frame = browser.page.frames().find((f) => f !== browser.page.mainFrame())
    await frame!.setContent(`
      <input id="inner-input" />
      <button id="inner-btn" onclick="document.getElementById('inner-result').textContent='clicked'">Go</button>
      <p id="inner-result" role="status"></p>
    `)

    const outline = await snapshot(browser.page)
    const innerInput = outline.elements.find((el) => el.role === 'textbox')
    const innerBtn = outline.elements.find((el) => el.role === 'button' && el.name === 'Go')
    assert.ok(innerInput, `expected a textbox from inside the iframe, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(innerBtn)
    assert.ok(innerInput!.frameChain && innerInput!.frameChain.length === 1, 'expected a one-level frameChain for a direct child iframe')

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const fillResult = await executeAction(browser.page, { action: 'fill', ref: innerInput!.ref, value: 'hi', reason: 'test' }, outline, dir, 1)
    assert.equal(fillResult.ok, true)
    const clickResult = await executeAction(browser.page, { action: 'click', ref: innerBtn!.ref, reason: 'test' }, outline, dir, 2)
    assert.equal(clickResult.ok, true)

    assert.equal(await frame!.locator('#inner-result').textContent(), 'clicked')
  } finally {
    await browser.close()
  }
})

test('snapshot finds elements inside a doubly-nested iframe, with a correct two-level frameChain — deeper than SNAPSHOT_SCRIPT was ever live-tested against', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<iframe id="outer-frame"></iframe>`)
    const outerFrame = browser.page.frames().find((f) => f !== browser.page.mainFrame())!
    await outerFrame.setContent(`<iframe id="inner-frame"></iframe>`)
    const innerFrame = outerFrame.childFrames()[0]
    await innerFrame.setContent(`<button id="deep-btn">Deep button</button>`)

    const outline = await snapshot(browser.page)
    const deepBtn = outline.elements.find((el) => el.name === 'Deep button')
    assert.ok(deepBtn, `expected the doubly-nested button, got: ${JSON.stringify(outline.elements)}`)
    assert.equal(deepBtn!.frameChain?.length, 2, 'expected a two-level frameChain')

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const clickResult = await executeAction(browser.page, { action: 'click', ref: deepBtn!.ref, reason: 'test' }, outline, dir, 1)
    assert.equal(clickResult.ok, true)
  } finally {
    await browser.close()
  }
})

test('snapshot assigns correct checkbox/radio roles and flags a real <input type="file">', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <input id="cb" type="checkbox" /><label for="cb">Subscribe</label>
      <input id="r1" type="radio" name="g" /><label for="r1">Option A</label>
      <input id="resume" type="file" />
    `)
    const outline = await snapshot(browser.page)
    const checkbox = outline.elements.find((el) => el.name === 'Subscribe')
    const radio = outline.elements.find((el) => el.name === 'Option A')
    const fileInput = outline.elements.find((el) => el.isFileInput)
    assert.equal(checkbox?.role, 'checkbox')
    assert.equal(radio?.role, 'radio')
    assert.ok(fileInput, `expected a file input candidate, got: ${JSON.stringify(outline.elements)}`)
  } finally {
    await browser.close()
  }
})

test('snapshot excludes a genuinely hidden element, same as the old mechanism', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div style="display:none"><button id="hidden-btn">Should never appear</button></div>`)
    const outline = await snapshot(browser.page)
    assert.ok(!outline.elements.some((el) => el.name.includes('never appear')), `hidden element must not appear, got: ${JSON.stringify(outline.elements)}`)
  } finally {
    await browser.close()
  }
})

test('snapshot does not crash on a classic <frameset> page, which has no real <body> element at all', async (t) => {
  // Real, live-found gap: confirmed against the-internet.herokuapp.com's own
  // nested_frames demo (a genuine <frameset>-based page — `<html><frameset>
  // ...`, no <body> tag at all). `document.body` itself is truthy for such a
  // page (the HTML spec's own IDL getter returns either <body> OR
  // <frameset>), but there is no actual <body> element for a real DOM query
  // to match — `page.locator('body').ariaSnapshot()` threw outright
  // ("Selector \"body\" does not match any element"), a hard crash, not a
  // graceful degradation, since discovery is a one-shot call with no
  // per-iteration retry the way assert_page_text's own 'body' usage
  // elsewhere in this file already tolerates. Fixed by scoping to 'html'
  // instead, present on every real page regardless.
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<frameset rows="50%,50%"><frame src="about:blank"><frame src="about:blank"></frameset>`)
    const outline = await snapshot(browser.page)
    assert.ok(outline, 'snapshot() must not throw on a frameset page with no <body>')
  } finally {
    await browser.close()
  }
})

test('snapshot finds and executeAction clicks a real element inside an open shadow root — a genuine bonus of the accessibility-tree-based mechanism, the old querySelectorAll-based one structurally could not do this at all', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="host"></div>`)
    await browser.page.evaluate(`(() => {
      const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
      shadow.innerHTML = '<button id="shadow-btn">Click me (in shadow DOM)</button>'
    })()`)
    const outline = await snapshot(browser.page)
    const shadowBtn = outline.elements.find((el) => el.name.includes('shadow DOM'))
    assert.ok(shadowBtn, `expected the shadow-DOM button as a candidate, got: ${JSON.stringify(outline.elements)}`)

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const result = await executeAction(browser.page, { action: 'click', ref: shadowBtn!.ref, reason: 'test' }, outline, dir, 1)
    assert.equal(result.ok, true)
  } finally {
    await browser.close()
  }
})

test('snapshot still cannot see inside a CLOSED shadow root — deliberately inaccessible to external tooling in general, not a five46-specific gap', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<div id="host"></div>`)
    await browser.page.evaluate(`(() => {
      const shadow = document.getElementById('host').attachShadow({ mode: 'closed' })
      shadow.innerHTML = '<button id="shadow-btn">Click me (closed shadow)</button>'
    })()`)
    const outline = await snapshot(browser.page)
    assert.ok(!outline.elements.some((el) => el.name.includes('closed shadow')), `a closed shadow root must not be visible, got: ${JSON.stringify(outline.elements)}`)
  } finally {
    await browser.close()
  }
})

test('snapshot still finds a genuinely clickable icon-only control via the title+cursor:pointer fallback — the one real case the accessibility tree itself does not cover', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<span id="edit-icon" data-toggle="tooltip" title="Edit" style="cursor:pointer" onclick="window.__clicked=true">&#9998;</span>`)
    const outline = await snapshot(browser.page)
    const icon = outline.elements.find((el) => el.name === 'Edit')
    assert.ok(icon, `expected the icon-only control via the title+cursor fallback, got: ${JSON.stringify(outline.elements)}`)

    const dir = mkdtempSync(join(tmpdir(), 'five46-'))
    const clickResult = await executeAction(browser.page, { action: 'click', ref: icon!.ref, reason: 'test' }, outline, dir, 1)
    assert.equal(clickResult.ok, true)
    assert.equal(await browser.page.evaluate('window.__clicked'), true)
  } finally {
    await browser.close()
  }
})

test('snapshot excludes pure structural/layout noise (an unnamed generic wrapper, the iframe host, the list wrapper, an unnamed listitem wrapping its own already-listed child) from the candidate list', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <div>
        <ul>
          <li><button>Nested 1</button></li>
          <li><button>Nested 2</button></li>
        </ul>
      </div>
      <iframe id="empty-frame"></iframe>
    `)
    const outline = await snapshot(browser.page)
    assert.ok(!outline.elements.some((el) => el.role === 'generic' && !el.name), `no unnamed generic wrapper should appear, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(!outline.elements.some((el) => el.role === 'iframe'), `the iframe host itself should not be a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(!outline.elements.some((el) => el.role === 'list'), `the <ul> wrapper itself should not be a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(!outline.elements.some((el) => el.role === 'listitem'), `a listitem wrapping its own already-listed button should not ALSO be a candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(outline.elements.some((el) => el.name === 'Nested 1'))
    assert.ok(outline.elements.some((el) => el.name === 'Nested 2'))
  } finally {
    await browser.close()
  }
})

test('snapshot gives a bare <li> with no other markup inside its own real, named candidate — a real, live-found gap found via src/eval/\'s drag-and-drop regression probe: blanket-excluding listitem (like list itself) left a plain sortable-list item with ZERO candidates at all, not just a missing drag action', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`<ul><li id="item-a">Item A</li><li id="item-b">Item B</li></ul>`)
    const outline = await snapshot(browser.page)
    const itemA = outline.elements.find((el) => el.name === 'Item A')
    const itemB = outline.elements.find((el) => el.name === 'Item B')
    assert.ok(itemA, `expected the bare listitem to be its own named candidate, got: ${JSON.stringify(outline.elements)}`)
    assert.ok(itemB)
    assert.equal(itemA!.role, 'listitem')
  } finally {
    await browser.close()
  }
})

test('snapshot correctly parses a name containing a literal quote and a name containing a colon — both force a different underlying YAML quoting style, confirmed to round-trip identically', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    await browser.page.setContent(`
      <button id="quote-btn">Say "hi" to the "world"</button>
      <button id="colon-btn">Price: $100</button>
    `)
    const outline = await snapshot(browser.page)
    assert.ok(
      outline.elements.some((el) => el.name === 'Say "hi" to the "world"'),
      `expected the literal-quote name to round-trip correctly, got: ${JSON.stringify(outline.elements)}`
    )
    assert.ok(
      outline.elements.some((el) => el.name === 'Price: $100'),
      `expected the colon-containing name to round-trip correctly, got: ${JSON.stringify(outline.elements)}`
    )
  } finally {
    await browser.close()
  }
})

test('snapshot respects maxElements and discloses truncation, same contract as the old mechanism', async (t) => {
  const browser = await withRealBrowser(t)
  if (!browser) return
  try {
    const buttons = Array.from({ length: 10 }, (_, i) => `<button>Button ${i}</button>`).join('')
    await browser.page.setContent(`<div>${buttons}</div>`)
    const outline = await snapshot(browser.page, 5)
    assert.equal(outline.elements.length, 5)
    assert.equal(outline.truncated, true)
    assert.equal(outline.totalFound, 10)
  } finally {
    await browser.close()
  }
})
