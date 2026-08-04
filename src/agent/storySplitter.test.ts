import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LlmProvider } from '../llm/types'
import { buildStorySplitPrompt, parseStorySplit, splitUserStory } from './storySplitter'
import { HARD_MAX_SCENARIOS } from './runLoop'

const STORY = 'checkout succeeds with valid info. checkout fails with an invalid coupon code.'

test('buildStorySplitPrompt includes the raw story and the exact JSON schema', () => {
  const prompt = buildStorySplitPrompt(STORY)
  assert.ok(prompt.includes(STORY))
  assert.ok(prompt.includes('"goals"'))
  assert.ok(prompt.includes('ONLY the JSON object'))
})

test('parseStorySplit accepts a well-formed goals array', () => {
  const result = parseStorySplit(JSON.stringify({ goals: ['goal one', 'goal two'] }))
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.goals, ['goal one', 'goal two'])
})

test('parseStorySplit strips a markdown fence', () => {
  const result = parseStorySplit('```json\n' + JSON.stringify({ goals: ['goal one'] }) + '\n```')
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.goals, ['goal one'])
})

test('parseStorySplit rejects invalid JSON', () => {
  const result = parseStorySplit('not json at all')
  assert.equal(result.ok, false)
})

test('parseStorySplit rejects a JSON object with no "goals" array', () => {
  const result = parseStorySplit(JSON.stringify({ notGoals: ['a'] }))
  assert.equal(result.ok, false)
})

test('parseStorySplit rejects a goals array with no non-empty string entries', () => {
  const result = parseStorySplit(JSON.stringify({ goals: ['', '   '] }))
  assert.equal(result.ok, false)
})

test('parseStorySplit filters out blank entries but keeps real ones', () => {
  const result = parseStorySplit(JSON.stringify({ goals: ['  real goal  ', '', '   '] }))
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.goals, ['real goal'])
})

test('splitUserStory returns the split goals on a well-formed response', async () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      return JSON.stringify({ goals: ['checkout succeeds with valid info', 'checkout fails with an invalid coupon code'] })
    },
  }
  const result = await splitUserStory(STORY, fakeProvider, 'fake-key')
  assert.deepEqual(result, { goals: ['checkout succeeds with valid info', 'checkout fails with an invalid coupon code'], clamped: false })
})

test('splitUserStory falls back to the whole story as one goal on a malformed response, never fatal', async () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      return 'not valid json'
    },
  }
  const result = await splitUserStory(STORY, fakeProvider, 'fake-key')
  assert.deepEqual(result, { goals: [STORY], clamped: false })
})

test('splitUserStory falls back to the whole story as one goal when the provider call rejects, never fatal', async () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      throw new Error('network error')
    },
  }
  const result = await splitUserStory(STORY, fakeProvider, 'fake-key')
  assert.deepEqual(result, { goals: [STORY], clamped: false })
})

test('splitUserStory clamps to HARD_MAX_SCENARIOS and discloses the clamp, rather than silently dropping goals or rejecting outright', async () => {
  const manyGoals = Array.from({ length: HARD_MAX_SCENARIOS + 5 }, (_, i) => `scenario ${i + 1}`)
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      return JSON.stringify({ goals: manyGoals })
    },
  }
  const result = await splitUserStory(STORY, fakeProvider, 'fake-key')
  assert.equal(result.goals.length, HARD_MAX_SCENARIOS)
  assert.equal(result.clamped, true)
  assert.deepEqual(result.goals, manyGoals.slice(0, HARD_MAX_SCENARIOS))
})

test('splitUserStory treats a blank story as a single goal without ever calling the provider', async () => {
  let called = false
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      called = true
      return JSON.stringify({ goals: ['should not reach here'] })
    },
  }
  const result = await splitUserStory('   ', fakeProvider, 'fake-key')
  assert.equal(called, false)
  assert.deepEqual(result, { goals: ['   '], clamped: false })
})
