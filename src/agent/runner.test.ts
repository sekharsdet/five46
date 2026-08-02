import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runAgent } from './runner'
import { launchAgentBrowser, USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './browser'
import { startFixtureServer, startScrollFixtureServer } from './testServer'
import { startLoginFixtureServer, LOGIN_FIXTURE_USERNAME, LOGIN_FIXTURE_PASSWORD } from './loginTestServer'
import type { LlmProvider } from '../llm/types'
import type { StorageState } from './browser'

/** Finds the ref to act on by matching the *real* prompt text the fake
 * provider actually received, rather than hardcoding an assumed ref value
 * — ref-assignment order isn't part of `snapshot()`'s public contract, so
 * hardcoding "e1" here would silently couple this test to an
 * implementation detail. This exercises the real `serializeOutline`/
 * `buildActionPrompt` output, not just the fake's own assumptions. */
function refFor(prompt: string, nameSubstring: string): string {
  const match = prompt.match(new RegExp(`\\[(e\\d+)\\][^\\n]*${nameSubstring}`))
  if (!match) throw new Error(`test setup: no outline element matching "${nameSubstring}" in prompt:\n${prompt}`)
  return match[1]
}

async function playwrightAvailable(): Promise<boolean> {
  try {
    const browser = await launchAgentBrowser({ headless: true })
    await browser.close()
    return true
  } catch {
    return false
  }
}

test('runAgent drives a real browser through a real multi-step flow scripted by a fake LlmProvider, and writes real successful steps', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.steps.length, 2)
    assert.ok(run.steps.every((s) => s.ok))
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent recovers from a real async-loading page by using wait, where scrolling alone previously left it stuck', async (t) => {
  // The real, live-found gap this fixes: a page whose target content only
  // appears after an async client-side delay (the-internet.herokuapp.com's
  // dynamic-loading demo) left the agent with no tool but scrolling to
  // "pass time" — scrolling doesn't advance a setTimeout, so it gave up
  // declaring goal-unreachable after two scrolls. This fixture's
  // delayed-reveal-btn/delayed-secret reproduces the same shape (a real
  // 800ms async delay, no network request involved) at test-suite speed.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Load content'), reason: 'trigger the delayed content' })
        // Right after the click, the content genuinely isn't there yet
        // (real 800ms delay, negligible time has passed) — a real agent
        // faced with this uses `wait` rather than giving up.
        if (turn === 2) return JSON.stringify({ action: 'wait', reason: 'the page may still be loading' })
        // By now WAIT_ACTION_MS (3000ms) has elapsed, well past the
        // fixture's 800ms delay — the content should be there.
        if (turn === 3) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'Delayed content loaded'), reason: 'confirm it appeared' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'load the delayed content and confirm it appears',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.steps.length, 3)
    assert.deepEqual(
      run.steps.map((s) => s.action.action),
      ['click', 'wait', 'assert_visible']
    )
    assert.ok(run.steps.every((s) => s.ok))
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent recovers from a real async-loading, no-ARIA-role page using wait + assert_page_text — the exact shape of the real bug that motivated both fixes', async (t) => {
  // Reproduces the-internet.herokuapp.com/dynamic_loading/1 exactly: click
  // Start, a client-side async delay, then a plain `<h4>` with no ARIA
  // role at all (never in the interactive-elements outline, regardless of
  // timing). Before this pair of fixes, the agent had no tool to wait out
  // the delay AND no way to assert non-outline content even once it
  // appeared — it scrolled twice, found nothing, and gave up.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Load heading'), reason: 'trigger the delayed heading' })
        if (turn === 2) return JSON.stringify({ action: 'wait', reason: 'the page may still be loading' })
        // "Hello World!" is never a ref in any outline — no interactive
        // tag, no role attribute — so the model must reach for
        // assert_page_text, not assert_visible/assert_text.
        if (turn === 3) return JSON.stringify({ action: 'assert_page_text', expectedText: 'Hello World!', reason: 'confirm it appeared anywhere on the page' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'load the delayed heading and confirm Hello World! appears',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.deepEqual(
      run.steps.map((s) => s.action.action),
      ['click', 'wait', 'assert_page_text']
    )
    assert.ok(run.steps.every((s) => s.ok))
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent stops with stuck-repeating on a third consecutive wait, rather than burning the whole step budget doing nothing', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete() {
        return JSON.stringify({ action: 'wait', reason: 'still waiting' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'anything',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 20,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 20, 'must stop well before the step cap once repetition is detected')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with recordVideo: true attaches a real, existing videoPath to the returned TestRun', async (t) => {
  // This is the test that specifically exercises the done()/finally
  // plumbing: the video path is only known after teardown, inside
  // runAgent's own `finally` block, well after every `return` statement
  // has already been decided — this proves that value actually reaches
  // the caller's TestRun, not just that browser.close() itself works
  // (already covered directly in browser.test.ts).
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      recordVideo: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.ok(run.videoPath, 'expected a real videoPath on the returned TestRun')
    assert.ok(existsSync(run.videoPath!), 'expected the video file to actually exist on disk')
    assert.ok(statSync(run.videoPath!).size > 0, 'expected a nonempty video file')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent stops with assertion-failed (a real finding) when a real assertion genuinely does not hold', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        // "Your name" (the fixture's real <label for="name-input">), not the
        // placeholder text — real accessible-name computation prioritizes an
        // associated label over a placeholder, and so does snapshot() now.
        if (turn === 1) return JSON.stringify({ action: 'fill', ref: refFor(prompt, 'Your name'), value: 'Ada', reason: 'fill name' })
        if (turn === 2) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Greet me'), reason: 'submit' })
        // The real greeting will read "Hello, Ada!" — asserting a
        // deliberately wrong expected text here must genuinely fail
        // against the real rendered result, not just because the code
        // says so.
        return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'Hello'), expectedText: 'Goodbye, Ada!', reason: 'wrong on purpose' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'fill the name and check the greeting',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'assertion-failed')
    assert.equal(run.steps.length, 3)
    assert.equal(run.steps[0].ok, true)
    assert.equal(run.steps[1].ok, true)
    assert.equal(run.steps[2].ok, false)
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent stops honestly with unparseable-response rather than guessing an action', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete() {
        return 'I will click the button now.'
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'anything',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'unparseable-response')
    assert.equal(run.unparseableResponse, 'I will click the button now.')
    assert.equal(run.steps.length, 0)
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent rejects an unverified goal-reached claim on a confirmation-requiring goal, then accepts it once a real assertion actually succeeds', async (t) => {
  // Regression test for a real, live finding (a Shopify demo store, goal:
  // "...then confirm the cart shows an item"): the model clicked its way to
  // a real, correct outcome, then declared goal-reached WITHOUT ever
  // calling assert_visible/assert_text — the end state happened to be
  // right, but nothing in the run actually verified it, despite the goal
  // explicitly asking for confirmation. This mirrors that exact shape: the
  // fake provider tries to finish early without asserting, gets rejected,
  // then does the right thing.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        // Premature — no assertion has happened yet. Must be rejected, not
        // accepted as a real finish.
        if (turn === 2) return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'I clicked it, must be done' })
        if (turn === 3) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'actually confirm it now' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'now verified' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it becomes visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached')
    // Only the click and the real assertion are real executed steps — the
    // two rejected/accepted "done" turns never touch the page.
    assert.equal(run.steps.length, 2)
    assert.equal(run.steps[0].action.action, 'click')
    assert.equal(run.steps[1].action.action, 'assert_visible')
    assert.equal(run.steps[1].ok, true)
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent stops with stuck-repeating if a confirmation-requiring goal keeps getting an unverified done, rather than looping forever', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete() {
        // Never asserts, just keeps insisting it's done.
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'trust me' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it becomes visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 20,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 20, 'must stop well before the step cap, not accept the unverified claim either')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent stops with stuck-repeating instead of burning the full step budget on a looping agent', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        // Always assert the same thing is visible when it demonstrably
        // isn't — a real, plausible "stuck" agent, not a contrived input.
        return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'Show secret message'), reason: 'stuck' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'anything',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 20,
      headless: true,
      artifactDir,
    })

    // The button IS visible, so assert_visible on it should actually
    // succeed every time — this exercises the repeat detector on a
    // succeeding-but-identical action, proving it's keyed on the action
    // itself, not on failure.
    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 20, 'must stop well before the step cap once repetition is detected')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent allows a goal that legitimately requires the same successful click several times in a row, without tripping stuck-repeating', async (t) => {
  // Regression test for a real bug found via a live run against
  // the-internet.herokuapp.com/add_remove_elements/: a goal asking to
  // click the same "Add Element" button three times in a row got aborted
  // as stuck-repeating after only two clicks, even though each click
  // genuinely succeeded and changed real page state (adding another
  // element) — the repeat detector couldn't tell "confused agent
  // repeating a no-op" apart from "goal legitimately needs this action
  // several times," a very ordinary real-world pattern (add N items to a
  // cart, paginate N times, delete every row). Fixed: a repeated click/fill
  // that keeps succeeding no longer counts toward the stuck-repeating
  // threshold at all — bounded only by the normal step cap — while a
  // repeated *failing* click/fill, or a repeated assertion/`done` (see the
  // two tests above), still trips it exactly as before.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn <= 3) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Increment counter'), reason: `click ${turn}` })
        if (turn === 4) return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'Count:'), expectedText: 'Count: 3', reason: 'confirm' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'click the Increment counter button three times, then confirm the count shows Count: 3',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 10,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached')
    const clickSteps = run.steps.filter((s) => s.action.action === 'click')
    assert.equal(clickSteps.length, 3, `expected all 3 identical clicks to succeed, got: ${JSON.stringify(run.steps.map((s) => [s.action.action, s.ok]))}`)
    assert.ok(clickSteps.every((s) => s.ok))
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent still stops with stuck-repeating if a click/fill repeats and keeps failing, not just succeeding', async (t) => {
  // The other half of the fix above: only a repeated click/fill that keeps
  // *succeeding* is exempted from the stuck-repeating guard. A repeated
  // failure must still trip it — otherwise a genuinely broken selector
  // that never resolves would burn the entire step budget for no reason.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      // Visible but permanently disabled — Playwright's own actionability
      // check for .click() requires the element be enabled, so every
      // attempt genuinely times out and fails, a real repeated failure.
      async complete(prompt) {
        return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Disabled button'), reason: 'keep trying' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'anything',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 20,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 20, 'must stop well before the step cap once repeated failures are detected')
    assert.ok(run.steps.every((s) => !s.ok), 'every attempt on the disabled button must genuinely fail, not silently succeed')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent completes a real login through credential placeholders, never sending the real value to the LLM, and calls onGoalReached with a real changed session', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startLoginFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const promptsSeen: string[] = []
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        promptsSeen.push(prompt)
        turn++
        if (turn === 1) return JSON.stringify({ action: 'fill', ref: refFor(prompt, 'sername'), value: USERNAME_PLACEHOLDER, reason: 'fill username' })
        if (turn === 2) return JSON.stringify({ action: 'fill', ref: refFor(prompt, 'assword'), value: PASSWORD_PLACEHOLDER, reason: 'fill password' })
        if (turn === 3) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Log in'), reason: 'submit' })
        if (turn === 4) return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'Welcome back'), expectedText: 'Welcome back', reason: 'confirm logged in' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'logged in' })
      },
    }

    let onGoalReachedCalled = false
    let seenBaseline: StorageState | undefined
    let seenFinal: StorageState | undefined
    const run = await runAgent({
      url: server.url + '/login',
      goal: 'log in and confirm the dashboard shows a welcome message',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      credentials: { username: LOGIN_FIXTURE_USERNAME, password: LOGIN_FIXTURE_PASSWORD },
      forceConfirmation: true,
      onGoalReached: async (context, baseline) => {
        onGoalReachedCalled = true
        seenBaseline = baseline
        seenFinal = await context.storageState()
      },
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.ok(onGoalReachedCalled)
    assert.notDeepEqual(seenBaseline, seenFinal, 'a real session cookie was set, so baseline and final state must differ')
    assert.ok(seenFinal!.cookies.length > 0, 'expected the real session cookie to have been captured')

    // The real secret must never appear in any prompt sent to the "LLM" —
    // only the placeholder tokens.
    const allPrompts = promptsSeen.join('\n')
    assert.ok(!allPrompts.includes(LOGIN_FIXTURE_PASSWORD), 'the real password must never appear in any prompt')
    assert.ok(allPrompts.includes(PASSWORD_PLACEHOLDER), 'the placeholder token should appear once it is used in history')

    // The recorded action objects themselves must still show the
    // placeholder, never the real value — the direct regression test for
    // the mutation bug described in browser.ts's substitutePlaceholders.
    const fillSteps = run.steps.filter((s) => s.action.action === 'fill')
    assert.ok(fillSteps.length >= 2)
    for (const step of fillSteps) {
      const action = step.action as Extract<typeof step.action, { action: 'fill' }>
      assert.ok(
        action.value === USERNAME_PLACEHOLDER || action.value === PASSWORD_PLACEHOLDER,
        `expected a placeholder token, got a possibly-real value: ${JSON.stringify(action.value)}`
      )
    }
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent keeps the original placeholder token in an assert_text failure detail, never the real substituted value', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startLoginFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        // Assert the username field's own name contains the *password*
        // placeholder — deliberately wrong, so this genuinely fails, and
        // the failure detail must reference the placeholder token, not the
        // real configured password.
        if (turn === 1) return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'sername'), expectedText: PASSWORD_PLACEHOLDER, reason: 'deliberately wrong' })
        return JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'gave up' })
      },
    }

    const run = await runAgent({
      url: server.url + '/login',
      goal: 'anything',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      credentials: { username: LOGIN_FIXTURE_USERNAME, password: LOGIN_FIXTURE_PASSWORD },
    })

    const failedStep = run.steps.find((s) => !s.ok)
    assert.ok(failedStep)
    assert.ok(failedStep!.failureDetail!.includes(PASSWORD_PLACEHOLDER), 'the failure detail must reference the placeholder token')
    assert.ok(!failedStep!.failureDetail!.includes(LOGIN_FIXTURE_PASSWORD), 'the real password must never appear in the failure detail')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent reports matching baseline/final storageState to onGoalReached when the confirming assertion was real but unrelated to any actual session change', async (t) => {
  // The independent structural check this enables: if a model satisfies
  // the confirmation gate with an assertion that's genuinely true but
  // doesn't reflect any real server-side change (e.g. asserting a static
  // element on the login page itself, without ever submitting the form),
  // baseline and final storageState end up identical — strong evidence
  // nothing really happened, regardless of what the model self-reported.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startLoginFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'sername'), reason: 'trivially true, no real login happened' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    let seenBaseline: StorageState | undefined
    let seenFinal: StorageState | undefined
    const run = await runAgent({
      url: server.url + '/login',
      goal: 'confirm the username field is present',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      forceConfirmation: true,
      onGoalReached: async (context, baseline) => {
        seenBaseline = baseline
        seenFinal = await context.storageState()
      },
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.deepEqual(seenBaseline, seenFinal, 'no real session change happened, so baseline and final state should be identical')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent blocks a real click on a destructive-looking button by default, never actually clicking it', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      // A real, live model retrying a blocked action is exactly the
      // scenario this needs to survive honestly — never a false
      // goal-reached, and never an uncaught crash.
      async complete(prompt) {
        return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Delete Account'), reason: 'delete the account' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'delete my account and confirm it is gone',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 3,
      headless: true,
      artifactDir,
    })

    assert.notEqual(run.outcome, 'goal-reached')
    assert.ok(run.steps.length > 0)
    assert.ok(run.steps.every((s) => !s.ok), 'the blocked click must never be recorded as a successful step')
    assert.ok(run.steps.every((s) => s.failureDetail?.includes('allow-deletes')))
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent performs a real destructive click when allowDeletes is true, and fires onDestructiveClick exactly once', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Delete Account'), reason: 'delete the account' })
        if (turn === 2) return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'deleted'), expectedText: 'Account deleted', reason: 'confirm deleted' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const destructiveClicks: { name: string; reason: string }[] = []
    const run = await runAgent({
      url: server.url,
      goal: 'delete my account and confirm it is gone',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      allowDeletes: true,
      onDestructiveClick: (name, reason) => destructiveClicks.push({ name, reason }),
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(destructiveClicks.length, 1)
    assert.equal(destructiveClicks[0].name, 'Delete Account')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

function tryRefFor(prompt: string, nameSubstring: string): string | undefined {
  return prompt.match(new RegExp(`\\[(e\\d+)\\][^\\n]*${nameSubstring}`))?.[1]
}

test('runAgent allows a goal that legitimately requires several consecutive scroll-down actions, without tripping stuck-repeating', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startScrollFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    // Forces 3 consecutive scroll-down actions before ever clicking —
    // `isVisible` doesn't filter by viewport (an off-screen element is
    // already in the outline, and Playwright's own click() would auto-
    // scroll to it regardless), so this deliberately doesn't make scrolling
    // it a *precondition* for the click to succeed; it directly tests the
    // thing that actually matters here: 3 identical `scroll:down` actions
    // that each genuinely move the page must not trip stuck-repeating,
    // mirroring the existing "same successful click 3x" precedent test.
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn <= 3) return JSON.stringify({ action: 'scroll', direction: 'down', reason: 'scroll toward the target' })
        if (turn === 4) {
          const ref = tryRefFor(prompt, 'Bottom button')
          if (!ref) throw new Error(`test setup: "Bottom button" not found in prompt:\n${prompt}`)
          return JSON.stringify({ action: 'click', ref, reason: 'click it' })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'scroll down and click the bottom button',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 15,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached', `expected the goal to be reached; run ended with ${run.outcome} after ${run.steps.length} step(s)`)
    const scrollSteps = run.steps.filter((s) => s.action.action === 'scroll')
    assert.ok(scrollSteps.length >= 2, `expected at least 2 scroll steps to reach the target, got ${scrollSteps.length}`)
    assert.ok(scrollSteps.every((s) => s.ok))
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent trips stuck-repeating when scrolling never reveals the target (already at the bottom), never claiming false success', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startScrollFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    // Always scrolls down, never finding (or looking for) any target —
    // once the page bottoms out, repeated no-op scrolls must eventually
    // trip stuck-repeating rather than burning the whole step budget.
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete() {
        return JSON.stringify({ action: 'scroll', direction: 'down', reason: 'keep scrolling' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'scroll down forever',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 30,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 30, 'must trip the guard well before exhausting the full step budget')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent trips stuck-repeating when an indecisive model alternates assertion types on the same still-unchanged ref, instead of ever declaring done', async (t) => {
  // Regression test for a real, live finding: Llama 3.3 70B (via Groq)
  // repeatedly alternated assert_visible/assert_text on the same ref after
  // already successfully confirming it, never declaring done. Two
  // *identical* consecutive signatures never occurred (assert_visible and
  // assert_text are different signatures), so the existing repeat-guard
  // never caught it.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        const ref = refFor(prompt, 'agentic testing works')
        // Alternates forever between the two assertion types on the same
        // ref — never done.
        return turn % 2 === 0
          ? JSON.stringify({ action: 'assert_visible', ref, reason: 'check visible' })
          : JSON.stringify({ action: 'assert_text', ref, expectedText: 'agentic testing works', reason: 'check text' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 15,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 15, 'must trip well before exhausting the step budget')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent allows exactly two different assertion types on the same ref in a row (a normal verify-visible-then-verify-text pattern), without tripping', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'check visible' })
        if (turn === 3) {
          return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'agentic testing works'), expectedText: 'agentic testing works', reason: 'check text' })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 10,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'goal-reached')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent trips stuck-repeating on a repeatedly-clicked checkbox, unlike a repeatedly-clicked additive control', async (t) => {
  // Regression test for a real, live finding: an indecisive model clicked
  // the same checkbox 8 times in a row on a real page
  // (the-internet.herokuapp.com/checkboxes) before ever exhausting the
  // step budget — since a checkbox click *toggles* state, an even number
  // of clicks nets out to no change at all (the opposite of most goals
  // asking to check one), unlike a repeated click on an additive control
  // like "Add Element"/increment-btn, which genuinely keeps changing
  // state each time and legitimately must not trip this guard (see the
  // test above).
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        const ref = refFor(prompt, 'Subscribe to updates')
        return JSON.stringify({ action: 'click', ref, reason: 'toggle it' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'check the subscribe checkbox',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 10,
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 10, 'must trip well before exhausting the step budget, unlike an additive control')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with useStructuredPlan fast-paths a click plan step, skipping the LLM call for that step', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          // The one upfront planning call.
          return JSON.stringify({
            steps: [
              { action: 'click', target: { role: 'button', nameContains: 'Show secret message' }, reason: 'reveal it' },
              { action: 'assert_visible', target: { role: 'status', nameContains: 'agentic testing works' }, reason: 'confirm revealed' },
              { action: 'done', outcome: 'goal-reached', reason: 'done' },
            ],
          })
        }
        // assert_visible never fast-paths, by design — this is the live
        // decision for the plan's 2nd step, with the real, current outline.
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      useStructuredPlan: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.steps.length, 2)
    assert.ok(run.steps[0].ok, 'the fast-pathed click must have actually executed for real, not just been assumed')
    assert.equal(run.planStats?.plannedSteps, 3)
    // click and done both fast-path (fully deterministic: a click resolved
    // unambiguously by structural match, a done with no target at all); the
    // assertion is the one action type that always decides live, matching
    // self-healing's own permanent assertion exclusion.
    assert.equal(run.planStats?.fastPathedSteps, 2)
    assert.equal(turn, 2, 'plan + live assert only — neither the click nor the final done made its own LLM call')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with useStructuredPlan still blocks a fast-pathed click on a destructive-looking target by default', async (t) => {
  // The single most important regression test in this whole feature: the
  // fast path deliberately skips parseAgentAction entirely (that's the
  // efficiency win), which is exactly the function that normally enforces
  // isDestructiveClickTarget/allowDeletes gating — without an explicit,
  // independent copy of that same check at the fast-path's own execution
  // site, a plan step that happened to resolve to a destructive-looking
  // button would execute for real with zero gating, even at default
  // safety settings.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete() {
        return JSON.stringify({
          steps: [{ action: 'click', target: { role: 'button', nameContains: 'Delete Account' }, reason: 'delete the account' }],
        })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'delete my account and confirm it is gone',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 2,
      headless: true,
      artifactDir,
      useStructuredPlan: true,
    })

    assert.notEqual(run.outcome, 'goal-reached')
    assert.ok(run.steps.length > 0)
    assert.ok(run.steps.every((s) => !s.ok), 'a fast-pathed destructive click must never be recorded as a successful step')
    assert.ok(
      run.steps.every((s) => s.failureDetail?.includes('allow-deletes')),
      'must be blocked by the same gate parseAgentAction uses, not silently executed'
    )
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with useStructuredPlan allows a fast-pathed destructive click when allowDeletes is true, and still fires onDestructiveClick', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          return JSON.stringify({
            steps: [
              { action: 'click', target: { role: 'button', nameContains: 'Delete Account' }, reason: 'delete the account' },
              { action: 'assert_text', target: { role: 'status', nameContains: 'deleted' }, expectedText: 'Account deleted', reason: 'confirm deleted' },
              { action: 'done', outcome: 'goal-reached', reason: 'done' },
            ],
          })
        }
        if (turn === 2) return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'deleted'), expectedText: 'Account deleted', reason: 'confirm deleted' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const destructiveClicks: { name: string; reason: string }[] = []
    const run = await runAgent({
      url: server.url,
      goal: 'delete my account and confirm it is gone',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      useStructuredPlan: true,
      allowDeletes: true,
      onDestructiveClick: (name, reason) => destructiveClicks.push({ name, reason }),
    })

    assert.equal(run.outcome, 'goal-reached')
    // click and done both fast-path; only the assert_text decides live.
    assert.equal(run.planStats?.fastPathedSteps, 2)
    assert.equal(destructiveClicks.length, 1)
    assert.equal(destructiveClicks[0].name, 'Delete Account')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with useStructuredPlan falls back to a live decision when a planned target resolves ambiguously', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          // "button" + "e" matches multiple real buttons on the fixture
          // page (e.g. "Show secret message", "Greet me") — deliberately
          // ambiguous, so this must fall back to a live decision rather
          // than guessing which one.
          return JSON.stringify({
            steps: [
              { action: 'click', target: { role: 'button', nameContains: 'e' }, reason: 'ambiguous on purpose' },
              { action: 'done', outcome: 'goal-reached', reason: 'done' },
            ],
          })
        }
        if (turn === 2) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      useStructuredPlan: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    // The ambiguous click must not fast-path — but the plan's final `done`
    // step still does, since it's fully deterministic regardless of what
    // happened to the step before it.
    assert.equal(run.planStats?.fastPathedSteps, 1)
    assert.equal(turn, 2, 'plan + live click (ambiguous fallback) only — done still fast-pathed')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with useStructuredPlan degrades to the ordinary adaptive loop once the plan is exhausted, still reaching a real outcome', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          // A plan with only one step — click — deliberately shorter than
          // what the goal actually needs, so the run must keep going past
          // plan exhaustion instead of stopping early.
          return JSON.stringify({ steps: [{ action: 'click', target: { role: 'button', nameContains: 'Show secret message' }, reason: 'reveal it' }] })
        }
        // Every call after plan exhaustion is an ordinary live decision.
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      useStructuredPlan: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.planStats?.plannedSteps, 1)
    assert.equal(run.planStats?.fastPathedSteps, 1)
    assert.equal(run.steps.length, 2, 'the assertion after plan exhaustion must still have run, via the ordinary adaptive loop')
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent with useStructuredPlan degrades silently to the full adaptive loop when the plan response itself is malformed', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        // Turn 1's malformed response is deliberately never a run-ending
        // unparseable-response — it's the plan call specifically, which
        // must degrade to the full adaptive loop instead, exactly as if
        // useStructuredPlan had never been passed.
        if (turn === 1) return 'this is not valid JSON at all'
        if (turn === 2) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        if (turn === 3) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
      useStructuredPlan: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.planStats, undefined, 'no plan was ever actually adopted, so there is nothing to disclose')
    assert.equal(run.steps.length, 2)
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent returns a real, honest outcome with prior steps preserved when the LLM provider itself throws mid-run, instead of the run silently vanishing', async (t) => {
  // Real, live-found gap: a sustained Gemini 503 patch made a live per-step
  // provider.complete() call throw after llm/retry.ts's own retry budget
  // was exhausted. Before this fix, that error propagated straight out of
  // runAgent uncaught, discarding every step already completed. A caller
  // opting into more steps must never end up worse off for having tried.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        throw new Error('Gemini API request failed: 503 Service Unavailable')
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      headless: true,
      artifactDir,
    })

    assert.equal(run.outcome, 'provider-unavailable')
    assert.equal(run.providerError, 'Gemini API request failed: 503 Service Unavailable')
    assert.equal(run.steps.length, 1, 'the one real step completed before the throw must be preserved, not discarded')
    assert.equal(run.steps[0].ok, true)
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('runAgent rejects an indecisive model trying to "verify" its own click by re-asserting the same element is visible', async (t) => {
  // Regression test for a real, live-observed gap (demoblaze.com): the
  // model clicked a button, then "confirmed" success by asserting that
  // same button was still visible — trivially true regardless of outcome,
  // since it had to already be visible to be clickable. Scripted to keep
  // attempting exactly that so it never earns a real, informative
  // assertion — this must never accept the tautological one as
  // verification, and must never crash trying.
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-agent-test-'))
  try {
    let clicked = false
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (!clicked) {
          clicked = true
          return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        }
        // Keeps trying to "verify" by re-asserting the button it just
        // clicked is visible — must be rejected every time, never accepted.
        return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'Show secret message'), reason: 'confirm it worked' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'reveal the secret message and confirm it is visible',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 5,
      headless: true,
      artifactDir,
    })

    assert.notEqual(run.outcome, 'goal-reached', 'must never accept a tautological self-assertion as real verification')
    assert.ok(
      run.steps.every((s) => !s.ok || s.action.action !== 'assert_visible'),
      'the tautological assert_visible must never be recorded as a successful step'
    )
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})
