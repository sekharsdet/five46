import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeOutline, buildActionPrompt, parseAgentAction, requiresConfirmation, isDestructiveClickTarget } from './planner'
import { USERNAME_PLACEHOLDER } from './browser'
import type { PageOutline } from './types'

const OUTLINE: PageOutline = {
  elements: [
    { ref: 'e1', tag: 'button', role: 'button', name: 'Show secret message', selector: '#reveal-btn' },
    { ref: 'e2', tag: 'input', role: 'textbox', name: 'Enter your name', selector: '#name-input' },
  ],
  truncated: false,
  totalFound: 2,
}

const EMPTY_OUTLINE: PageOutline = { elements: [], truncated: false, totalFound: 0 }

const DELETE_OUTLINE: PageOutline = {
  elements: [
    { ref: 'e1', tag: 'button', role: 'button', name: 'Delete Account', selector: '#delete-account-btn' },
    { ref: 'e2', tag: 'button', role: 'button', name: 'Remove from cart', selector: '#remove-cart-btn' },
  ],
  truncated: false,
  totalFound: 2,
}

test('serializeOutline lists each element with its ref, and discloses truncation rather than hiding it', () => {
  const text = serializeOutline(OUTLINE)
  assert.ok(text.includes('[e1] button "Show secret message"'))
  assert.ok(text.includes('[e2] textbox "Enter your name"'))

  const truncated: PageOutline = { ...OUTLINE, truncated: true, totalFound: 5 }
  const truncatedText = serializeOutline(truncated)
  assert.ok(truncatedText.includes('3 more visible interactive element(s) not shown'))
})

test('buildActionPrompt includes the goal, the outline, and the exact JSON schema', () => {
  const prompt = buildActionPrompt('reveal the secret message', [], OUTLINE)
  assert.ok(prompt.includes('reveal the secret message'))
  assert.ok(prompt.includes('[e1] button "Show secret message"'))
  assert.ok(prompt.includes('"action":"click"'))
  assert.ok(prompt.includes('ONLY the JSON object'))
})

test('buildActionPrompt bounds history and discloses omitted earlier steps rather than growing unboundedly', () => {
  const longHistory = Array.from({ length: 15 }, (_, i) => ({
    action: { action: 'click' as const, ref: 'e1', reason: `step ${i}` },
    result: 'ok' as const,
    detail: '',
  }))
  const prompt = buildActionPrompt('goal', longHistory, OUTLINE)
  assert.ok(prompt.includes('5 earlier step(s) omitted'))
})

test('parseAgentAction parses a real click response and validates the ref against this turn\'s outline', () => {
  const raw = JSON.stringify({ action: 'click', ref: 'e1', reason: 'open it' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.action, { action: 'click', ref: 'e1', reason: 'open it' })
  }
})

test('parseAgentAction strips a markdown json fence some models add, without guessing at malformed content', () => {
  const raw = '```json\n' + JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }) + '\n```'
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.ok(result.ok)
})

test('parseAgentAction fails honestly, never guessing, on invalid JSON', () => {
  const result = parseAgentAction('not json at all', EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not valid JSON/)
})

test('parseAgentAction fails honestly on a hallucinated ref not present in this turn\'s outline', () => {
  // Regression coverage for the core anti-fabrication design decision: the
  // LLM never authors a selector, only picks a ref from the turn it was
  // given — an unrecognized ref must be a parse-level failure, never
  // silently accepted or guessed at.
  const raw = JSON.stringify({ action: 'click', ref: 'e99', reason: 'nonexistent' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /valid refs/)
})

test('parseAgentAction requires a recognized outcome for done, not just any string', () => {
  const raw = JSON.stringify({ action: 'done', outcome: 'i-think-so', reason: 'maybe' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
})

test('isDestructiveClickTarget matches account/data-destruction phrases, not generic delete/remove verbs', () => {
  assert.equal(isDestructiveClickTarget('Delete Account'), true)
  assert.equal(isDestructiveClickTarget('Deactivate my account'), true)
  assert.equal(isDestructiveClickTarget('Permanently delete everything'), true)
  assert.equal(isDestructiveClickTarget('Cancel Subscription'), true)
  assert.equal(isDestructiveClickTarget('Remove from cart'), false)
  assert.equal(isDestructiveClickTarget('Delete search'), false)
  assert.equal(isDestructiveClickTarget('Submit'), false)
})

test('parseAgentAction blocks a destructive-looking click by default, and allows it with allowDeletes', () => {
  const raw = JSON.stringify({ action: 'click', ref: 'e1', reason: 'delete the account' })

  const blocked = parseAgentAction(raw, DELETE_OUTLINE, false)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.recoverable, true)
    if (blocked.recoverable) assert.deepEqual(blocked.attemptedAction, { action: 'click', ref: 'e1', reason: 'delete the account' })
    assert.match(blocked.error, /allow-deletes/)
  }

  const allowed = parseAgentAction(raw, DELETE_OUTLINE, true)
  assert.ok(allowed.ok)
})

test('parseAgentAction never blocks a click on a non-destructive-looking target, regardless of allowDeletes', () => {
  const raw = JSON.stringify({ action: 'click', ref: 'e2', reason: 'remove the item' })
  const result = parseAgentAction(raw, DELETE_OUTLINE, false)
  assert.ok(result.ok)
})

test('buildActionPrompt discloses the delete-gating up front when allowDeletes is falsy, and omits it when true', () => {
  const gated = buildActionPrompt('delete my account', [], OUTLINE, undefined, false)
  assert.ok(gated.includes('--allow-deletes'))

  const unlocked = buildActionPrompt('delete my account', [], OUTLINE, undefined, true)
  assert.ok(!unlocked.includes('--allow-deletes'))

  const defaulted = buildActionPrompt('delete my account', [], OUTLINE)
  assert.ok(defaulted.includes('--allow-deletes'))
})

test('requiresConfirmation recognizes confirm/verify/ensure/check-that/make-sure language', () => {
  // Regression test for a real, live finding: a goal phrased "...then
  // confirm the cart shows an item" let the model declare goal-reached
  // without ever asserting anything.
  assert.equal(requiresConfirmation('reveal the secret message and confirm it becomes visible'), true)
  assert.equal(requiresConfirmation('add an item and verify the cart total updates'), true)
  assert.equal(requiresConfirmation('log in and ensure the dashboard loads'), true)
  assert.equal(requiresConfirmation('check that the error message appears'), true)
  assert.equal(requiresConfirmation('submit the form and make sure it succeeds'), true)
})

test('requiresConfirmation does not flag a goal with no verification language', () => {
  assert.equal(requiresConfirmation('add a product to the cart'), false)
  assert.equal(requiresConfirmation('log in as a test user'), false)
})

test('buildActionPrompt tells the model upfront when a goal requires verification, not just after rejecting it', () => {
  const prompt = buildActionPrompt('reveal the secret and confirm it is visible', [], OUTLINE)
  assert.ok(prompt.includes('must perform at least one'))
  assert.ok(prompt.includes('assert_visible or assert_text'))

  const plainPrompt = buildActionPrompt('reveal the secret', [], OUTLINE)
  assert.ok(!plainPrompt.includes('must perform at least one'))
})

test('buildActionPrompt tells the model about the placeholder tokens only when credentials are actually configured', () => {
  const withCreds = buildActionPrompt('log in', [], OUTLINE, { username: true, password: true })
  assert.ok(withCreds.includes('%%USERNAME%%'))
  assert.ok(withCreds.includes('%%PASSWORD%%'))
  assert.ok(withCreds.includes('never write a real-looking username or password yourself'))

  const withoutCreds = buildActionPrompt('log in', [], OUTLINE, { username: false, password: false })
  assert.ok(!withoutCreds.includes('%%USERNAME%%'))

  const noArg = buildActionPrompt('log in', [], OUTLINE)
  assert.ok(!noArg.includes('%%USERNAME%%'))
})

test('buildActionPrompt structurally cannot leak an actual credential, since its signature only accepts presence booleans', () => {
  // A real secret string literally cannot be passed to `credentialsAvailable`
  // — its type is `{ username: boolean; password: boolean }` — so it
  // cannot appear in the returned prompt regardless of what else this
  // function does. Not much to assert at runtime beyond "it still returns
  // the placeholder instructions, not something else" — the actual
  // guarantee here is enforced by the TypeScript signature itself.
  const prompt = buildActionPrompt('log in', [], OUTLINE, { username: true, password: true })
  assert.ok(prompt.includes(USERNAME_PLACEHOLDER))
})
