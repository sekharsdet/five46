import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyApiAssertion, classifyAgentAssertion, summarizeApiAssertionQuality, summarizeAgentAssertionQuality, formatAssertionQualityWarning } from './assertionQuality'
import type { ExecutedApiStep } from './apiTypes'
import type { ExecutedStep, PageOutline } from './types'

const outline: PageOutline = { elements: [], truncated: false, totalFound: 0 }

test('classifyApiAssertion: assert_json_path_exists is weak, assert_status/assert_json_path_equals are strong', () => {
  assert.equal(classifyApiAssertion({ action: 'assert_json_path_exists', path: 'id', reason: 'x' }), 'weak')
  assert.equal(classifyApiAssertion({ action: 'assert_status', expected: 200, reason: 'x' }), 'strong')
  assert.equal(classifyApiAssertion({ action: 'assert_json_path_equals', path: 'name', expected: 'widget', reason: 'x' }), 'strong')
})

test('classifyAgentAssertion: assert_visible is weak, value-specific assertions are strong', () => {
  assert.equal(classifyAgentAssertion({ action: 'assert_visible', ref: '1', reason: 'x' }), 'weak')
  assert.equal(classifyAgentAssertion({ action: 'assert_text', ref: '1', expectedText: 'hi', reason: 'x' }), 'strong')
  assert.equal(classifyAgentAssertion({ action: 'assert_value', ref: '1', expectedValue: 'hi', reason: 'x' }), 'strong')
  assert.equal(classifyAgentAssertion({ action: 'assert_page_text', expectedText: 'hi', reason: 'x' }), 'strong')
  assert.equal(classifyAgentAssertion({ action: 'assert_page_text_absent', expectedText: 'hi', reason: 'x' }), 'strong')
})

test('summarizeApiAssertionQuality only counts ok:true assertion steps', () => {
  const steps: ExecutedApiStep[] = [
    { step: 1, action: { action: 'request', method: 'GET', url: 'http://x/1', reason: 'r' }, ok: true, responseStatus: 200 },
    { step: 2, action: { action: 'assert_status', expected: 200, reason: 'r' }, ok: true },
    { step: 3, action: { action: 'assert_json_path_exists', path: 'id', reason: 'r' }, ok: true },
    { step: 4, action: { action: 'assert_json_path_exists', path: 'nope', reason: 'r' }, ok: false, failureDetail: 'missing' },
  ]
  assert.deepEqual(summarizeApiAssertionQuality(steps), { weak: 1, strong: 1 })
})

test('summarizeAgentAssertionQuality only counts ok:true assertion steps', () => {
  const steps: ExecutedStep[] = [
    { step: 1, action: { action: 'assert_visible', ref: '1', reason: 'r' }, outline, ok: true },
    { step: 2, action: { action: 'assert_visible', ref: '2', reason: 'r' }, outline, ok: true },
    { step: 3, action: { action: 'assert_text', ref: '3', expectedText: 'hi', reason: 'r' }, outline, ok: true },
    { step: 4, action: { action: 'click', ref: '4', reason: 'r' }, outline, ok: true },
  ]
  assert.deepEqual(summarizeAgentAssertionQuality(steps), { weak: 2, strong: 1 })
})

test('formatAssertionQualityWarning fires only when weak assertions are at least as common as strong ones', () => {
  assert.equal(formatAssertionQualityWarning({ weak: 0, strong: 2 }, 'api'), undefined)
  assert.equal(formatAssertionQualityWarning({ weak: 1, strong: 2 }, 'api'), undefined)
  assert.ok(formatAssertionQualityWarning({ weak: 2, strong: 1 }, 'api')?.includes('assert_json_path_exists'))
  assert.ok(formatAssertionQualityWarning({ weak: 1, strong: 0 }, 'browser')?.includes('assert_visible'))
})
