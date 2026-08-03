import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRootCausePrompt, generateRootCauseHypothesis } from './rootCause'
import type { TestRun, PageOutline } from './types'
import type { LlmProvider } from '../llm/types'
import { ROOT_CAUSE_MAX_OUTPUT_TOKENS } from './runLoop'

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

test('buildRootCausePrompt tells the model the outline is interactive-elements-only, so it does not infer "blank page" from a sparse list', () => {
  // Real, live-found bug: a fully-rendered page (a room description, a
  // price — confirmed via its own screenshot) whose content had no
  // button/a/input/[role] markup at all produced a near-empty outline, and
  // the root-cause LLM wrongly concluded the page had "failed to load" /
  // was "blank." This note is the fix: it removes the false premise
  // ("short outline" == "little content") without disclosing any new live
  // page data to the LLM.
  const prompt = buildRootCausePrompt(assertTextFailureRun())!
  assert.ok(prompt.toLowerCase().includes('interactive elements'))
  assert.ok(/does not mean|not mean/i.test(prompt), 'must explicitly warn against inferring "blank"/"failed to load" from a short list')
})

test('buildRootCausePrompt never includes the real page\'s full visible text — that would violate its own "only what the LLM already saw" rule', () => {
  // The real fix for the "blank page" hallucination is a clarifying NOTE,
  // deliberately not the page's actual rendered text (captured separately
  // as a local file only — see browser.ts's visibleTextPath — never fed
  // into any LLM prompt), since the latter would be exactly the kind of
  // previously-undisclosed live value this function's own doc comment
  // already establishes as off-limits (the same rule that scrubs
  // assert_text's mismatched value).
  const run = assertTextFailureRun()
  run.steps[1] = { ...run.steps[1], visibleTextPath: '/tmp/step-2-failure-visible-text.txt' } as (typeof run.steps)[number]
  const prompt = buildRootCausePrompt(run)!
  assert.ok(!prompt.includes('/tmp/step-2-failure-visible-text.txt'), 'the file path itself is a local artifact, not something the analysis LLM needs')
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

test('generateRootCauseHypothesis bounds the call with ROOT_CAUSE_MAX_OUTPUT_TOKENS', async () => {
  let capturedOptions: { maxOutputTokens?: number } | undefined
  const provider: LlmProvider = {
    id: 'fake',
    async complete(_prompt, _apiKey, options) {
      capturedOptions = options
      return 'a hypothesis'
    },
  }
  await generateRootCauseHypothesis(assertTextFailureRun(), provider, 'fake-key')
  assert.equal(capturedOptions?.maxOutputTokens, ROOT_CAUSE_MAX_OUTPUT_TOKENS)
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
