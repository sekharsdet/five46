import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApiRootCausePrompt, generateApiRootCauseHypothesis } from './apiRootCause'
import type { ApiTestRun } from './apiTypes'
import type { LlmProvider } from '../llm/types'

function assertJsonPathFailureRun(overrides: Partial<ApiTestRun> = {}): ApiTestRun {
  return {
    runId: 'r1',
    baseUrl: 'http://x',
    goal: 'create a widget and confirm its status is active',
    outcome: 'assertion-failed',
    steps: [
      {
        step: 1,
        action: { action: 'request', method: 'POST', url: '/widgets', body: '{}', reason: 'create it' },
        ok: true,
        responseStatus: 201,
        responseBodyExcerpt: '{"id":1,"status":"pending"}',
      },
      {
        step: 2,
        action: { action: 'assert_json_path_equals', path: 'status', expected: 'active', reason: 'confirm active' },
        ok: false,
        failureDetail: 'expected "status" to equal "active", got "user-token-abc123-secret"',
      },
    ],
    ...overrides,
  }
}

test('buildApiRootCausePrompt includes the goal, prior history, and the expected value', () => {
  const prompt = buildApiRootCausePrompt(assertJsonPathFailureRun())!
  assert.ok(prompt.includes('create a widget and confirm its status is active'))
  assert.ok(prompt.includes('active'))
  assert.ok(prompt.includes('POST /widgets'), 'prior step history should be included')
})

test('buildApiRootCausePrompt never includes the raw mismatched live value from an assert_json_path_equals failure', () => {
  const prompt = buildApiRootCausePrompt(assertJsonPathFailureRun())!
  assert.ok(!prompt.includes('user-token-abc123-secret'))
})

test('buildApiRootCausePrompt returns undefined when the run has no failed step', () => {
  const run: ApiTestRun = { runId: 'r2', baseUrl: 'http://x', goal: 'g', outcome: 'goal-reached', steps: [] }
  assert.equal(buildApiRootCausePrompt(run), undefined)
})

test('generateApiRootCauseHypothesis returns the provider\'s response as-is', async () => {
  const provider: LlmProvider = { id: 'fake', async complete() { return '  Likely a race condition in status propagation.  ' } }
  const result = await generateApiRootCauseHypothesis(assertJsonPathFailureRun(), provider, 'fake-key')
  assert.equal(result, 'Likely a race condition in status propagation.')
})

test('generateApiRootCauseHypothesis never rejects, even when the provider throws', async () => {
  const provider: LlmProvider = {
    id: 'fake',
    async complete() {
      throw new Error('network error')
    },
  }
  const result = await generateApiRootCauseHypothesis(assertJsonPathFailureRun(), provider, 'fake-key')
  assert.match(result, /couldn't generate a root-cause hypothesis/)
  assert.match(result, /network error/)
})
