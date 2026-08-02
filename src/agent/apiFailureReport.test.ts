import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatApiFailureReport } from './apiFailureReport'
import type { ApiTestRun } from './apiTypes'

function assertionFailedRun(): ApiTestRun {
  return {
    runId: 'r1',
    baseUrl: 'http://x',
    goal: 'g',
    outcome: 'assertion-failed',
    steps: [
      {
        step: 1,
        action: { action: 'assert_json_path_equals', path: 'status', expected: 'ok', reason: 'r' },
        ok: false,
        failureDetail: 'expected "status" to equal "ok", got "error"',
      },
    ],
  }
}

test('formatApiFailureReport labels an assertion failure as a real finding, and discloses the missing hypothesis by default', () => {
  const report = formatApiFailureReport(assertionFailedRun())
  assert.ok(report.includes('a real finding about the API'))
  assert.ok(report.includes('No root-cause hypothesis'))
})

test('formatApiFailureReport renders a passed rootCauseHypothesis under a hedged header, instead of the deferred-capability text', () => {
  const report = formatApiFailureReport(assertionFailedRun(), 'The error status likely means the upstream dependency is down.')
  assert.ok(report.includes('an LLM-generated hypothesis, not a confirmed diagnosis'))
  assert.ok(report.includes('The error status likely means the upstream dependency is down.'))
  assert.ok(!report.includes('No root-cause hypothesis or suggested fix'))
})

test('formatApiFailureReport labels a tooling outcome as such, not a finding about the API', () => {
  const run: ApiTestRun = { runId: 'r2', baseUrl: 'http://x', goal: 'g', outcome: 'stopped-by-cap', steps: [] }
  assert.ok(formatApiFailureReport(run).includes('tooling issue'))
})

test('formatApiFailureReport discloses structured-plan stats when a plan was used, and omits the line entirely when it was not', () => {
  const withPlan: ApiTestRun = { runId: 'r3', baseUrl: 'http://x', goal: 'g', outcome: 'goal-reached', steps: [], planStats: { plannedSteps: 4, fastPathedSteps: 3 } }
  assert.ok(formatApiFailureReport(withPlan).includes('Structured plan: 4 step(s) planned upfront, 3 executed without a live LLM decision.'))

  const withoutPlan: ApiTestRun = { ...withPlan, runId: 'r4', planStats: undefined }
  assert.ok(!formatApiFailureReport(withoutPlan).includes('Structured plan:'))
})
