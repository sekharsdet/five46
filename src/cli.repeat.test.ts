import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { performOneE2eRun, insertIterationSuffix } from './cli'
import { launchAgentBrowser } from './agent/browser'
import { startFixtureServer } from './agent/testServer'
import { classifyRepeatResults } from './agent/flaky'
import type { RepeatIterationResult } from './agent/flaky'
import type { LlmProvider } from './llm/types'

// Deep --repeat/flaky-detection behavior needs a scripted fake LlmProvider,
// which a subprocess spawn (cli.test.ts's own black-box approach) can't
// inject — so, mirroring runner.test.ts's own convention, these tests call
// the exported `performOneE2eRun` directly (real browser, real fixture
// server, only the LLM faked) rather than going through cli.ts's
// env-based provider/credential resolution, which only ever resolves one
// of the real, fixed provider ids.

function refFor(prompt: string, nameSubstring: string): string {
  const match = prompt.match(new RegExp(`\\[(e\\d+)\\][^\\n]*${nameSubstring}`))
  if (!match) throw new Error(`test setup: no outline element matching "${nameSubstring}" in prompt:\n${prompt}`)
  return match[1]
}

async function playwrightAvailable(): Promise<boolean> {
  try {
    const browser = await launchAgentBrowser({ headless: true })
    await browser.close()
    return true
  } catch {
    return false
  }
}

test('insertIterationSuffix splices a repeat marker before the extension, or appends one when there is none', () => {
  assert.equal(insertIterationSuffix('foo.spec.ts', 2), 'foo.spec.repeat2.ts')
  assert.equal(insertIterationSuffix('nested/dir/foo.test.mjs', 3), 'nested/dir/foo.test.repeat3.mjs')
  assert.equal(insertIterationSuffix('no-extension', 1), 'no-extension.repeat1')
})

test('--repeat: two identical scripted runs against a real fixture produce non-colliding files and classify as non-flaky', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const dir = mkdtempSync(join(tmpdir(), 'five46-repeat-test-'))
  try {
    const makeProvider = (): LlmProvider => {
      let turn = 0
      return {
        id: 'fake',
        async complete(prompt) {
          turn++
          if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
          if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
          return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
        },
      }
    }

    const results: RepeatIterationResult[] = []
    const outPaths: string[] = []
    for (let i = 1; i <= 2; i++) {
      const outPath = join(dir, `run${i}.spec.ts`)
      outPaths.push(outPath)
      const result = await performOneE2eRun(
        server.url,
        'reveal the secret message and confirm it is visible',
        undefined,
        undefined,
        outPath,
        join(dir, `artifacts-${i}`),
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        makeProvider(),
        'fake-key',
        {},
        [],
        undefined,
        undefined,
        undefined
      )
      assert.notEqual(result, 'errored')
      if (result === 'errored') throw new Error('unreachable')
      results.push({ iteration: i, outcome: result.outcome, specBody: result.specBody })
    }

    assert.notEqual(outPaths[0], outPaths[1])
    for (const p of outPaths) assert.ok(readFileSync(p, 'utf8').length > 0)

    const classification = classifyRepeatResults(results)
    assert.equal(classification.allGoalReached, true)
    assert.equal(classification.identicalBodies, true)
    assert.equal(classification.flaky, false)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--repeat: a scripted run that behaves differently on the second iteration classifies as flaky, naming that iteration', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const dir = mkdtempSync(join(tmpdir(), 'five46-repeat-test-'))
  try {
    // Iteration 1 clicks the reveal button then asserts; iteration 2
    // declares the goal unreachable instead — a real divergence in agent
    // behavior, not just a different run-id.
    const providerFor = (iteration: number): LlmProvider => {
      let turn = 0
      return {
        id: 'fake',
        async complete(prompt) {
          turn++
          if (iteration === 1) {
            if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
            if (turn === 2) return JSON.stringify({ action: 'assert_visible', ref: refFor(prompt, 'agentic testing works'), reason: 'confirm revealed' })
            return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
          }
          return JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'giving up' })
        },
      }
    }

    const results: RepeatIterationResult[] = []
    for (let i = 1; i <= 2; i++) {
      const result = await performOneE2eRun(
        server.url,
        'reveal the secret message and confirm it is visible',
        undefined,
        undefined,
        join(dir, `run${i}.spec.ts`),
        join(dir, `artifacts-${i}`),
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        providerFor(i),
        'fake-key',
        {},
        [],
        undefined,
        undefined,
        undefined
      )
      assert.notEqual(result, 'errored')
      if (result === 'errored') throw new Error('unreachable')
      results.push({ iteration: i, outcome: result.outcome, specBody: result.specBody })
    }

    const classification = classifyRepeatResults(results)
    assert.equal(classification.allGoalReached, false)
    assert.equal(classification.flaky, true)
    assert.deepEqual(classification.differingIterations, [2])
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
