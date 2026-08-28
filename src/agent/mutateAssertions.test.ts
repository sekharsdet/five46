import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMutatedApiSteps, buildMutatedAgentSteps } from './mutateAssertions'
import type { ExecutedApiStep } from './apiTypes'
import type { ExecutedStep, PageOutline } from './types'

const outline: PageOutline = { elements: [], truncated: false, totalFound: 0 }

test('buildMutatedApiSteps flips assert_status/assert_json_path_equals but leaves presence-only and failed steps untouched', () => {
  const steps: ExecutedApiStep[] = [
    { step: 1, action: { action: 'request', method: 'GET', url: 'http://x/1', reason: 'r' }, ok: true, responseStatus: 200 },
    { step: 2, action: { action: 'assert_status', expected: 200, reason: 'r' }, ok: true },
    { step: 3, action: { action: 'assert_json_path_equals', path: 'name', expected: 'widget', reason: 'r' }, ok: true },
    { step: 4, action: { action: 'assert_json_path_exists', path: 'id', reason: 'r' }, ok: true },
    { step: 5, action: { action: 'assert_status', expected: 999, reason: 'r' }, ok: false, failureDetail: 'nope' },
  ]
  const mutated = buildMutatedApiSteps(steps)
  assert.ok(mutated)
  assert.equal((mutated![1].action as { expected: number }).expected, 599)
  assert.equal((mutated![2].action as { expected: string }).expected, 'widget__five46_mutation_probe__')
  assert.deepEqual(mutated![3], steps[3])
  assert.deepEqual(mutated![4], steps[4])
})

test('buildMutatedApiSteps returns undefined when nothing is mutable', () => {
  const steps: ExecutedApiStep[] = [{ step: 1, action: { action: 'assert_json_path_exists', path: 'id', reason: 'r' }, ok: true }]
  assert.equal(buildMutatedApiSteps(steps), undefined)
})

test('buildMutatedAgentSteps flips assert_text/assert_value/assert_page_text but leaves assert_visible/assert_page_text_absent untouched', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'assert_visible', ref: '1', reason: 'r' }, outline, ok: true },
    { step: 2, action: { action: 'assert_text', ref: '2', expectedText: 'hi', reason: 'r' }, outline, ok: true },
    { step: 3, action: { action: 'assert_value', ref: '3', expectedValue: 'val', reason: 'r' }, outline, ok: true },
    { step: 4, action: { action: 'assert_page_text', expectedText: 'page', reason: 'r' }, outline, ok: true },
    { step: 5, action: { action: 'assert_page_text_absent', expectedText: 'gone', reason: 'r' }, outline, ok: true },
  ]
  const mutated = buildMutatedAgentSteps(steps)
  assert.ok(mutated)
  assert.deepEqual(mutated![0], steps[0])
  assert.equal((mutated![1].action as { expectedText: string }).expectedText, 'hi__five46_mutation_probe__')
  assert.equal((mutated![2].action as { expectedValue: string }).expectedValue, 'val__five46_mutation_probe__')
  assert.equal((mutated![3].action as { expectedText: string }).expectedText, 'page__five46_mutation_probe__')
  assert.deepEqual(mutated![4], steps[4])
})

test('buildMutatedAgentSteps returns undefined when nothing is mutable', () => {
  const steps: ExecutedStep[] = [{ step: 1, action: { action: 'assert_visible', ref: '1', reason: 'r' }, outline, ok: true }]
  assert.equal(buildMutatedAgentSteps(steps), undefined)
})
