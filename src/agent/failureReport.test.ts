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

test('formatFailureReport labels provider-unavailable as a tooling issue, not a finding about the app, and prints the captured error', () => {
  const run: TestRun = {
    runId: 'r1d',
    url: 'http://x',
    goal: 'g',
    outcome: 'provider-unavailable',
    steps: [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'r' }, outline: OUTLINE, ok: true }],
    providerError: 'Gemini API request failed: 503 Service Unavailable',
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('not a finding about the app'))
  assert.ok(report.includes('Gemini API request failed: 503 Service Unavailable'))
  assert.ok(report.includes('1 step(s) succeeded'), 'the one real step completed before the throw must still be counted')
})

test('formatFailureReport prints the visible-text artifact path when present, for a human to open directly', () => {
  const run: TestRun = {
    runId: 'r1c',
    url: 'http://x',
    goal: 'g',
    outcome: 'assertion-failed',
    steps: [
      {
        step: 1,
        action: { action: 'assert_page_text', expectedText: 'Hello World!', reason: 'r' },
        outline: OUTLINE,
        ok: false,
        failureDetail: 'expected the page to contain text "Hello World!", but it never appeared',
        visibleTextPath: '/tmp/step-1-failure-visible-text.txt',
      },
    ],
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('/tmp/step-1-failure-visible-text.txt'))
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

test('formatFailureReport discloses a recorded video path on a goal-reached run — not failure-gated', () => {
  const run: TestRun = {
    runId: 'r6',
    url: 'http://x',
    goal: 'g',
    outcome: 'goal-reached',
    steps: [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'r' }, outline: OUTLINE, ok: true }],
    videoPath: '/tmp/five46-agent-r6/video.webm',
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('Video: /tmp/five46-agent-r6/video.webm'))
})

test('formatFailureReport discloses a recorded video path on an assertion-failed run too', () => {
  const run: TestRun = {
    runId: 'r7',
    url: 'http://x',
    goal: 'g',
    outcome: 'assertion-failed',
    steps: [{ step: 1, action: { action: 'assert_text', ref: 'e2', expectedText: 'X', reason: 'r' }, outline: OUTLINE, ok: false, failureDetail: 'expected X' }],
    videoPath: '/tmp/five46-agent-r7/video.webm',
  }
  const report = formatFailureReport(run)
  assert.ok(report.includes('Video: /tmp/five46-agent-r7/video.webm'))
})

test('formatFailureReport discloses structured-plan stats when a plan was used, and omits the line entirely when it was not', () => {
  const withPlan: TestRun = {
    runId: 'r9',
    url: 'http://x',
    goal: 'g',
    outcome: 'goal-reached',
    steps: [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'r' }, outline: OUTLINE, ok: true }],
    planStats: { plannedSteps: 3, fastPathedSteps: 2 },
  }
  assert.ok(formatFailureReport(withPlan).includes('Structured plan: 3 step(s) planned upfront, 2 executed without a live LLM decision.'))

  const withoutPlan: TestRun = { ...withPlan, runId: 'r10', planStats: undefined }
  assert.ok(!formatFailureReport(withoutPlan).includes('Structured plan:'))
})

test('formatFailureReport omits the video line entirely when no video was recorded', () => {
  const run: TestRun = {
    runId: 'r8',
    url: 'http://x',
    goal: 'g',
    outcome: 'goal-reached',
    steps: [{ step: 1, action: { action: 'click', ref: 'e1', reason: 'r' }, outline: OUTLINE, ok: true }],
  }
  assert.ok(!formatFailureReport(run).includes('Video:'))
})
