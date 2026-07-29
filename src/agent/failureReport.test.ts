import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatFailureReport } from './failureReport'
import type { TestRun, PageOutline } from './types'

const OUTLINE: PageOutline = { elements: [], truncated: false, totalFound: 0 }

test('formatFailureReport labels an assertion failure as a real finding about the app, not a tooling issue', () => {
  const run: TestRun = {
    runId: 'r1',
    url: 'http://x',
    goal: 'g',
    outcome: 'assertion-failed',
    steps: [
      { step: 1, action: { action: 'click', ref: 'e1', reason: 'r' }, outline: OUTLINE, ok: true },
      {
        step: 2,
        action: { action: 'assert_text', ref: 'e2', expectedText: 'X', reason: 'r' },
        outline: OUTLINE,
        ok: false,
        failureDetail: 'expected text containing "X", got "Y"',
        screenshotPath: '/tmp/step-2-failure.png',
      },
    ],
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('a real finding about the app'))
  assert.ok(report.includes('expected text containing "X", got "Y"'))
  assert.ok(report.includes('/tmp/step-2-failure.png'))
  assert.ok(report.includes('No root-cause hypothesis'), 'must disclose the missing capability rather than silently omit it')
})

test('formatFailureReport renders a passed rootCauseHypothesis under a hedged header, instead of the deferred-capability text', () => {
  const run: TestRun = {
    runId: 'r1b',
    url: 'http://x',
    goal: 'g',
    outcome: 'assertion-failed',
    steps: [
      {
        step: 1,
        action: { action: 'assert_text', ref: 'e2', expectedText: 'X', reason: 'r' },
        outline: OUTLINE,
        ok: false,
        failureDetail: 'expected text containing "X", got "Y"',
      },
    ],
  }
  const report = formatFailureReport(run, 'The button click likely failed to submit due to a slow network request.')
  assert.ok(report.includes('an LLM-generated hypothesis, not a confirmed diagnosis'))
  assert.ok(report.includes('The button click likely failed to submit due to a slow network request.'))
  assert.ok(!report.includes('No root-cause hypothesis or suggested fix'))
})

test('formatFailureReport labels an unparseable-response outcome as a tooling issue, not a finding about the app', () => {
  const run: TestRun = {
    runId: 'r2',
    url: 'http://x',
    goal: 'g',
    outcome: 'unparseable-response',
    unparseableResponse: 'I will click the button.',
    steps: [],
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('tooling issue, not a finding about the app'))
  assert.ok(report.includes('I will click the button.'))
})

test('formatFailureReport labels stuck-repeating and stopped-by-cap as tooling issues too', () => {
  const stuck: TestRun = { runId: 'r3', url: 'http://x', goal: 'g', outcome: 'stuck-repeating', steps: [] }
  assert.ok(formatFailureReport(stuck).includes('tooling issue'))

  const capped: TestRun = { runId: 'r4', url: 'http://x', goal: 'g', outcome: 'stopped-by-cap', steps: [] }
  assert.ok(formatFailureReport(capped).includes('tooling issue'))
})

test('formatFailureReport reports a clean success plainly', () => {
  const run: TestRun = {
    runId: 'r5',
    url: 'http://x',
    goal: 'g',
    outcome: 'goal-reached',
    steps: [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'r' }, outline: OUTLINE, ok: true }],
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('succeeded'))
})
