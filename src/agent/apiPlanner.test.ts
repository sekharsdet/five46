import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApiActionPrompt, parseApiAction } from './apiPlanner'
import type { SafetyMode } from './apiTypes'

const READ_ONLY: SafetyMode = { allowWrites: false, allowDeletes: false, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }
const WRITES_AND_DELETES: SafetyMode = { allowWrites: true, allowDeletes: true, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }

test('buildApiActionPrompt discloses the allowed methods/hosts up front, not just after a rejection', () => {
  // "POST" legitimately appears elsewhere in every prompt regardless of
  // safety mode (the schema example illustrates the JSON shape, not what's
  // currently allowed) — check the actual disclosure line specifically,
  // not the whole prompt text.
  const readOnlyPrompt = buildApiActionPrompt('goal', [], new Set(), READ_ONLY)
  const readOnlyLine = readOnlyPrompt.split('\n').find((l) => l.startsWith('Allowed methods this run:'))
  assert.equal(readOnlyLine, 'Allowed methods this run: GET, HEAD, OPTIONS. Allowed host(s): http://localhost:1. Any other method or host will be rejected — don\'t attempt one.')

  const fullPrompt = buildApiActionPrompt('goal', [], new Set(), WRITES_AND_DELETES)
  const fullLine = fullPrompt.split('\n').find((l) => l.startsWith('Allowed methods this run:'))
  assert.ok(fullLine?.includes('POST, PUT, PATCH'))
  assert.ok(fullLine?.includes('DELETE'))
})

test('buildApiActionPrompt tells the model to declare goal-unreachable honestly instead of guessing a plausible field name', () => {
  // Regression test: found via real live testing that the model asserted a
  // plausible-but-nonexistent JSON field ($.realname) instead of admitting
  // the real target field wasn't present — unconditional instruction, so it
  // must appear regardless of safety mode or saved variables.
  const prompt = buildApiActionPrompt('goal', [], new Set(), READ_ONLY)
  assert.ok(prompt.includes('goal-unreachable" honestly'))
  assert.ok(prompt.includes('never guess a field/path name'))
})

test('buildApiActionPrompt lists currently-saved variable names, only when there are any', () => {
  const withVars = buildApiActionPrompt('goal', [], new Set(['userId', 'token']), READ_ONLY)
  assert.ok(withVars.includes('userId'))
  assert.ok(withVars.includes('token'))

  const noVars = buildApiActionPrompt('goal', [], new Set(), READ_ONLY)
  assert.ok(!noVars.includes('Values saved so far'))
})

test('parseApiAction parses a real request action with saveAs', () => {
  const raw = JSON.stringify({
    action: 'request',
    method: 'get',
    url: 'http://localhost:1/items',
    saveAs: { name: 'firstId', path: 'items[0].id' },
    reason: 'list items',
  })
  const result = parseApiAction(raw, new Set(), READ_ONLY)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.action.action, 'request')
    if (result.action.action === 'request') {
      assert.equal(result.action.method, 'GET', 'method should be normalized to uppercase')
      assert.deepEqual(result.action.saveAs, { name: 'firstId', path: 'items[0].id' })
    }
  }
})

test('parseApiAction rejects a disallowed method at parse time, the same way an invalid ref is rejected elsewhere', () => {
  const raw = JSON.stringify({ action: 'request', method: 'POST', url: 'http://localhost:1/items', reason: 'try to write' })
  const result = parseApiAction(raw, new Set(), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not allowed this run/)
})

test('parseApiAction rejects DELETE when allowWrites is set but allowDeletes is not', () => {
  const writesOnly: SafetyMode = { ...READ_ONLY, allowWrites: true }
  const raw = JSON.stringify({ action: 'request', method: 'DELETE', url: 'http://localhost:1/items/1', reason: 'try to delete' })
  const result = parseApiAction(raw, new Set(), writesOnly)
  assert.equal(result.ok, false)
})

test('parseApiAction rejects a request to a host that is not the target origin or allowlisted', () => {
  const raw = JSON.stringify({ action: 'request', method: 'GET', url: 'http://evil.example.com/steal', reason: 'wander off' })
  const result = parseApiAction(raw, new Set(), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not the target origin/)
})

test('parseApiAction rejects a request referencing an unsaved {{var}}, the same way a hallucinated ref is rejected', () => {
  const raw = JSON.stringify({ action: 'request', method: 'GET', url: 'http://localhost:1/items/{{typo}}', reason: 'use a var' })
  const result = parseApiAction(raw, new Set(['realVar']), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /typo.*hasn't been saved/)
})

test('parseApiAction accepts a request referencing a var that actually was saved', () => {
  const raw = JSON.stringify({ action: 'request', method: 'GET', url: 'http://localhost:1/items/{{itemId}}', reason: 'use a var' })
  const result = parseApiAction(raw, new Set(['itemId']), READ_ONLY)
  assert.ok(result.ok)
})

test('parseApiAction parses assert_status/assert_json_path_exists/assert_json_path_equals/done', () => {
  const status = parseApiAction(JSON.stringify({ action: 'assert_status', expected: 200, reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(status.ok)

  const exists = parseApiAction(JSON.stringify({ action: 'assert_json_path_exists', path: 'id', reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(exists.ok)

  const equals = parseApiAction(JSON.stringify({ action: 'assert_json_path_equals', path: 'name', expected: 'Ada', reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(equals.ok)

  const done = parseApiAction(JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(done.ok)
})

test('parseApiAction fails honestly on invalid JSON, never guessing an action', () => {
  const result = parseApiAction('not json', new Set(), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not valid JSON/)
})

test('parseApiAction rejects an unrecognized method string outright', () => {
  const raw = JSON.stringify({ action: 'request', method: 'TRACE', url: 'http://localhost:1/x', reason: 'x' })
  const result = parseApiAction(raw, new Set(), WRITES_AND_DELETES)
  assert.equal(result.ok, false)
})
