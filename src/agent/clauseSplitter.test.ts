import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LlmProvider } from '../llm/types'
import { buildClauseSplitPrompt, parseClauseSplit, splitConfirmationClauses } from './clauseSplitter'
import { HARD_MAX_CLAUSES } from './runLoop'

const GOAL = 'add the item to the cart and confirm it was added, then open checkout and confirm a login field is visible'

test('buildClauseSplitPrompt includes the raw goal and the exact JSON schema', () => {
  const prompt = buildClauseSplitPrompt(GOAL)
  assert.ok(prompt.includes(GOAL))
  assert.ok(prompt.includes('"clauses"'))
  assert.ok(prompt.includes('ONLY the JSON object'))
})

test('parseClauseSplit accepts a well-formed clauses array', () => {
  const result = parseClauseSplit(JSON.stringify({ clauses: ['the cart shows at least 1 item', 'a login field is visible'] }))
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.clauses, ['the cart shows at least 1 item', 'a login field is visible'])
})

test('parseClauseSplit strips a markdown fence', () => {
  const result = parseClauseSplit('```json\n' + JSON.stringify({ clauses: ['clause one'] }) + '\n```')
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.clauses, ['clause one'])
})

test('parseClauseSplit rejects invalid JSON', () => {
  const result = parseClauseSplit('not json at all')
  assert.equal(result.ok, false)
})

test('parseClauseSplit rejects a JSON object with no "clauses" array', () => {
  const result = parseClauseSplit(JSON.stringify({ notClauses: ['a'] }))
  assert.equal(result.ok, false)
})

test('parseClauseSplit rejects a clauses array with no non-empty string entries', () => {
  const result = parseClauseSplit(JSON.stringify({ clauses: ['', '   '] }))
  assert.equal(result.ok, false)
})

test('parseClauseSplit filters out blank entries but keeps real ones', () => {
  const result = parseClauseSplit(JSON.stringify({ clauses: ['  real clause  ', '', '   '] }))
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.clauses, ['real clause'])
})

test('splitConfirmationClauses returns the split clauses on a well-formed response', async () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      return JSON.stringify({ clauses: ['the cart shows at least 1 item', 'a login field is visible'] })
    },
  }
  const result = await splitConfirmationClauses(GOAL, fakeProvider, 'fake-key')
  assert.deepEqual(result, { clauses: ['the cart shows at least 1 item', 'a login field is visible'], clamped: false })
})

test('splitConfirmationClauses falls back to the whole goal as one clause on a malformed response, never fatal', async () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      return 'not valid json'
    },
  }
  const result = await splitConfirmationClauses(GOAL, fakeProvider, 'fake-key')
  assert.deepEqual(result, { clauses: [GOAL], clamped: false })
})

test('splitConfirmationClauses falls back to the whole goal as one clause when the provider call rejects, never fatal', async () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      throw new Error('network error')
    },
  }
  const result = await splitConfirmationClauses(GOAL, fakeProvider, 'fake-key')
  assert.deepEqual(result, { clauses: [GOAL], clamped: false })
})

test('splitConfirmationClauses clamps to HARD_MAX_CLAUSES and discloses the clamp, rather than silently dropping clauses or rejecting outright', async () => {
  const manyClauses = Array.from({ length: HARD_MAX_CLAUSES + 5 }, (_, i) => `clause ${i + 1}`)
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      return JSON.stringify({ clauses: manyClauses })
    },
  }
  const result = await splitConfirmationClauses(GOAL, fakeProvider, 'fake-key')
  assert.equal(result.clauses.length, HARD_MAX_CLAUSES)
  assert.equal(result.clamped, true)
  assert.deepEqual(result.clauses, manyClauses.slice(0, HARD_MAX_CLAUSES))
})

test('splitConfirmationClauses treats a blank goal as a single clause without ever calling the provider', async () => {
  let called = false
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      called = true
      return JSON.stringify({ clauses: ['should not reach here'] })
    },
  }
  const result = await splitConfirmationClauses('   ', fakeProvider, 'fake-key')
  assert.equal(called, false)
  assert.deepEqual(result, { clauses: ['   '], clamped: false })
})
