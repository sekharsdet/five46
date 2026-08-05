import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { domShapeSignature, actionCacheKey, buildCachedPlanFromSteps, recordCacheEntry } from './actionCache'
import type { ActionCacheFile, ActionCacheEntry } from '../config/actionCache'
import { HARD_MAX_CACHE_ENTRIES } from './runLoop'
import { resolvePlannedTarget } from './planner'
import { runAgent } from './runner'
import { launchAgentBrowser, snapshot } from './browser'
import { startFixtureServer } from './testServer'
import type { LlmProvider } from '../llm/types'
import type { PageOutline } from './types'

async function playwrightAvailable(): Promise<boolean> {
  try {
    const browser = await launchAgentBrowser({ headless: true })
    await browser.close()
    return true
  } catch {
    return false
  }
}

function refFor(prompt: string, nameSubstring: string): string {
  const match = prompt.match(new RegExp(`\\[(e\\d+)\\][^\\n]*${nameSubstring}`))
  if (!match) throw new Error(`test setup: no outline element matching "${nameSubstring}" in prompt:\n${prompt}`)
  return match[1]
}

const OUTLINE_A: PageOutline = {
  elements: [
    { ref: 'e1', tag: 'button', role: 'button', name: 'Show secret message', selector: '#reveal-btn' },
    { ref: 'e2', tag: 'input', role: 'textbox', name: 'Enter your name', selector: '#name-input' },
  ],
  truncated: false,
  totalFound: 2,
}

// Same two elements, reversed document order — a real page re-rendering
// the same controls in a different order.
const OUTLINE_A_REORDERED: PageOutline = {
  elements: [
    { ref: 'e1', tag: 'input', role: 'textbox', name: 'Enter your name', selector: '#name-input' },
    { ref: 'e2', tag: 'button', role: 'button', name: 'Show secret message', selector: '#reveal-btn' },
  ],
  truncated: false,
  totalFound: 2,
}

const OUTLINE_B: PageOutline = {
  elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'Totally different page', selector: '#other-btn' }],
  truncated: false,
  totalFound: 1,
}

test('domShapeSignature is stable across pure element reordering (sorted, not document order)', () => {
  assert.equal(domShapeSignature(OUTLINE_A), domShapeSignature(OUTLINE_A_REORDERED))
})

test('domShapeSignature differs for a genuinely different set of elements', () => {
  assert.notEqual(domShapeSignature(OUTLINE_A), domShapeSignature(OUTLINE_B))
})

test('domShapeSignature differs for an empty outline vs. a non-empty one', () => {
  const empty: PageOutline = { elements: [], truncated: false, totalFound: 0 }
  assert.notEqual(domShapeSignature(empty), domShapeSignature(OUTLINE_A))
})

test('actionCacheKey scopes by (scope, goal, url) — any single difference produces a different key', () => {
  const base = actionCacheKey('/repo/a', 'log in and confirm dashboard', 'http://localhost:3000')
  assert.notEqual(base, actionCacheKey('/repo/b', 'log in and confirm dashboard', 'http://localhost:3000'), 'different scope must produce a different key')
  assert.notEqual(base, actionCacheKey('/repo/a', 'a different goal entirely', 'http://localhost:3000'), 'different goal must produce a different key')
  assert.notEqual(base, actionCacheKey('/repo/a', 'log in and confirm dashboard', 'http://localhost:4000'), 'different url must produce a different key')
  assert.equal(base, actionCacheKey('/repo/a', 'log in and confirm dashboard', 'http://localhost:3000'), 'identical inputs must produce the identical key')
})

test('actionCacheKey guards against a naive (goal, url) collision across two different projects sharing a common dev-server URL', () => {
  const projectOne = actionCacheKey('/repo/checkout-app', 'log in and confirm dashboard', 'http://localhost:3000')
  const projectTwo = actionCacheKey('/repo/admin-app', 'log in and confirm dashboard', 'http://localhost:3000')
  assert.notEqual(projectOne, projectTwo)
})

test('buildCachedPlanFromSteps reconstructs steps that re-resolve cleanly via resolvePlannedTarget against a fresh snapshot of the real page', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-cache-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'click the reveal button and confirm the secret message appears',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 10,
      headless: true,
      artifactDir,
    })
    assert.equal(run.outcome, 'goal-reached')

    const cachedSteps = buildCachedPlanFromSteps(run.steps)
    // Two real, successful ref-based steps (click + assert_visible) — the
    // implicit "done" is never reconstructed (see buildCachedPlanFromSteps'
    // own doc comment).
    assert.equal(cachedSteps.length, 2)
    assert.equal(cachedSteps[0].action, 'click')
    assert.equal(cachedSteps[1].action, 'assert_visible')

    // The real proof: replay each reconstructed step's {role, nameContains}
    // prediction *in sequence* against a genuinely fresh browser/navigation
    // (never the same run's own outline objects), resolving each one
    // against a snapshot taken right before it — exactly the fast path's
    // own "fresh snapshot every turn" discipline — and actually clicking
    // through, so a later step's target (the revealed text, hidden until
    // the click actually happens) is genuinely present by the time it's
    // checked, not asserted against a single stale initial snapshot.
    const browser = await launchAgentBrowser({ headless: true })
    try {
      await browser.page.goto(server.url)
      for (const step of cachedSteps) {
        if (step.action !== 'click' && step.action !== 'fill' && step.action !== 'assert_visible' && step.action !== 'assert_text') continue
        const freshOutline = await snapshot(browser.page)
        const candidates = resolvePlannedTarget(freshOutline, step.target)
        assert.equal(candidates.length, 1, `expected exactly one fresh candidate for ${JSON.stringify(step.target)}, got ${candidates.length}`)
        if (step.action === 'click') await browser.page.locator(candidates[0].selector).first().click()
      }
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

test('buildCachedPlanFromSteps skips a failed step entirely, never caching something that did not actually work', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const artifactDir = mkdtempSync(join(tmpdir(), 'five46-cache-test-'))
  try {
    let turn = 0
    const fakeProvider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
        // A tautological assert_visible on the just-clicked element is
        // blocked at parse time (recoverable, recorded as a failed step) —
        // real, live-found bug precedent this test reuses on purpose.
        if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'Show secret message'), reason: 'trying to verify my own click' })
        if (turn === 3) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed' })
      },
    }

    const run = await runAgent({
      url: server.url,
      goal: 'click the reveal button and confirm the secret message appears',
      provider: fakeProvider,
      apiKey: 'fake-key',
      maxSteps: 10,
      headless: true,
      artifactDir,
    })
    assert.equal(run.outcome, 'goal-reached')
    assert.ok(
      run.steps.some((s) => !s.ok),
      'test setup: expected at least one real failed step in this run'
    )

    const cachedSteps = buildCachedPlanFromSteps(run.steps)
    // Only the two genuinely successful steps (click, then the real
    // assert_visible on the revealed text) — the blocked tautological
    // assertion attempt must never appear in the cached plan.
    assert.equal(cachedSteps.length, 2)
    assert.equal(cachedSteps[0].action, 'click')
    assert.equal(cachedSteps[1].action, 'assert_visible')
    if (cachedSteps[1].action === 'assert_visible') {
      assert.ok(cachedSteps[1].target.nameContains.includes('agentic testing works'))
    }
  } finally {
    await server.close()
    rmSync(artifactDir, { recursive: true, force: true })
  }
})

function fakeEntry(cachedAt: string): ActionCacheEntry {
  return { domSignature: 'sig', steps: [], cachedAt }
}

test('recordCacheEntry adds a new entry without touching existing ones, when under the cap', () => {
  const file: ActionCacheFile = { entries: { existing: fakeEntry('2026-01-01T00:00:00.000Z') } }
  const updated = recordCacheEntry(file, 'new-key', fakeEntry('2026-01-02T00:00:00.000Z'))
  assert.deepEqual(Object.keys(updated.entries).sort(), ['existing', 'new-key'])
  assert.deepEqual(updated.entries.existing, file.entries.existing)
})

test('recordCacheEntry overwrites an existing entry under the same key', () => {
  const file: ActionCacheFile = { entries: { k: fakeEntry('2026-01-01T00:00:00.000Z') } }
  const updated = recordCacheEntry(file, 'k', fakeEntry('2026-01-02T00:00:00.000Z'))
  assert.equal(Object.keys(updated.entries).length, 1)
  assert.equal(updated.entries.k.cachedAt, '2026-01-02T00:00:00.000Z')
})

test('recordCacheEntry never mutates the ActionCacheFile it was given', () => {
  const file: ActionCacheFile = { entries: { existing: fakeEntry('2026-01-01T00:00:00.000Z') } }
  const before = JSON.stringify(file)
  recordCacheEntry(file, 'new-key', fakeEntry('2026-01-02T00:00:00.000Z'))
  assert.equal(JSON.stringify(file), before)
})

test('recordCacheEntry evicts the oldest entries once HARD_MAX_CACHE_ENTRIES is exceeded', () => {
  // Milliseconds-since-epoch based timestamps, not manually zero-padded
  // strings — HARD_MAX_CACHE_ENTRIES (200) exceeds what a naive 2-digit
  // pad scheme can represent without breaking lexical ordering.
  const baseTime = Date.parse('2026-01-01T00:00:00.000Z')
  let file: ActionCacheFile = { entries: {} }
  for (let i = 0; i < HARD_MAX_CACHE_ENTRIES; i++) {
    file = recordCacheEntry(file, `key-${i}`, fakeEntry(new Date(baseTime + i * 1000).toISOString()))
  }
  assert.equal(Object.keys(file.entries).length, HARD_MAX_CACHE_ENTRIES)

  // One more, newer entry — must stay under the cap, and the very oldest
  // entry (key-0) specifically must be the one evicted, not an arbitrary one.
  file = recordCacheEntry(file, 'key-newest', fakeEntry(new Date(baseTime + HARD_MAX_CACHE_ENTRIES * 1000).toISOString()))
  assert.equal(Object.keys(file.entries).length, HARD_MAX_CACHE_ENTRIES)
  assert.ok(!('key-0' in file.entries), 'expected the oldest entry to be evicted')
  assert.ok('key-newest' in file.entries)
  assert.ok('key-1' in file.entries, 'expected the second-oldest entry to survive — only exactly one eviction for exactly one overflow')
})
