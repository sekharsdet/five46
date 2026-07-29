import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRootCausePrompt, generateRootCauseHypothesis } from './rootCause'
import type { TestRun, PageOutline } from './types'
import type { LlmProvider } from '../llm/types'

const OUTLINE: PageOutline = {
  elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'Submit', selector: '#submit' }],
  truncated: false,
  totalFound: 1,
}

function assertTextFailureRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'r1',
    url: 'http://x',
    goal: 'reveal the secret message',
    outcome: 'assertion-failed',
    steps: [
      { step: 1, action: { action: 'click', ref: 'e1', reason: 'reveal it' }, outline: OUTLINE, ok: true },
      {
        step: 2,
        action: { action: 'assert_text', ref: 'e1', expectedText: 'the secret is out', reason: 'confirm revealed' },
        outline: OUTLINE,
        ok: false,
        failureDetail: 'expected text containing "the secret is out", got "Welcome, alice@example.com"',
      },
    ],
    ...overrides,
  }
}

test('buildRootCausePrompt includes the goal, prior history, the failed step\'s outline, and the expected value', () => {
  const prompt = buildRootCausePrompt(assertTextFailureRun())!
  assert.ok(prompt.includes('reveal the secret message'))
  assert.ok(prompt.includes('the secret is out'))
  assert.ok(prompt.includes('[e1] button "Submit"'))
  assert.ok(prompt.includes('click e1'), 'prior step history should be included')
})

test('buildRootCausePrompt never includes the raw mismatched live value from an assert_text failure', () => {
  // This live value (never disclosed to the LLM during the actual run,
  // since an assertion failure ends the run before a next turn could
  // serialize it) must never appear in the analysis prompt either.
  const prompt = buildRootCausePrompt(assertTextFailureRun())!
  assert.ok(!prompt.includes('alice@example.com'))
})

test('buildRootCausePrompt returns undefined when the run has no failed step', () => {
  const run: TestRun = { runId: 'r2', url: 'http://x', goal: 'g', outcome: 'goal-reached', steps: [] }
  assert.equal(buildRootCausePrompt(run), undefined)
})

test('generateRootCauseHypothesis returns the provider\'s response as-is', async () => {
  const provider: LlmProvider = { id: 'fake', async complete() { return '  A likely cause is a stale cache.  ' } }
  const result = await generateRootCauseHypothesis(assertTextFailureRun(), provider, 'fake-key')
  assert.equal(result, 'A likely cause is a stale cache.')
})

test('generateRootCauseHypothesis never rejects, even when the provider throws', async () => {
  const provider: LlmProvider = {
    id: 'fake',
    async complete() {
      throw new Error('rate limited')
    },
  }
  const result = await generateRootCauseHypothesis(assertTextFailureRun(), provider, 'fake-key')
  assert.match(result, /couldn't generate a root-cause hypothesis/)
  assert.match(result, /rate limited/)
})

test('generateRootCauseHypothesis returns an honest note, never throwing, when there is no failed step to analyze', async () => {
  const provider: LlmProvider = { id: 'fake', async complete() { return 'should never be called' } }
  const run: TestRun = { runId: 'r3', url: 'http://x', goal: 'g', outcome: 'goal-reached', steps: [] }
  const result = await generateRootCauseHypothesis(run, provider, 'fake-key')
  assert.match(result, /no failed step found/)
})
