import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { performOneE2eRun } from './cli'
import { launchAgentBrowser } from './agent/browser'
import { startFixtureServer } from './agent/testServer'
import type { LlmProvider } from './llm/types'

// Regression coverage for a real bug found in review: --verify-clean-session
// and --verify were both structurally broken for the browser engine — the
// generated/mutated spec was written outside a Playwright project's
// resolvable directory tree, so `@playwright/test`'s CLI either couldn't
// discover the file at all or couldn't resolve its own `import ... from
// '@playwright/test'`, and (on Windows) even a corrected --config still
// silently misfired because an absolute Windows path passed as a positional
// argument gets misinterpreted as a broken regex. All of this reported a
// plausible-looking but WRONG pass/fail every time, with nothing in the
// existing test suite ever actually exercising the browser engine's
// specExecutor path end-to-end. These tests call the real `performOneE2eRun`
// against a real local browser and real fixture server (only the LLM is
// scripted), the same integration-test convention `cli.repeat.test.ts`
// already established.

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

function makeRevealProvider(): LlmProvider {
  let turn = 0
  return {
    id: 'fake',
    async complete(prompt) {
      turn++
      if (turn === 1) return JSON.stringify({ action: 'click', ref: refFor(prompt, 'Show secret message'), reason: 'reveal it' })
      // assert_text (not assert_visible) so the run has a mutable, strong
      // assertion for the --verify test below — assert_visible has no
      // expected value to flip.
      if (turn === 2) return JSON.stringify({ action: 'assert_text', ref: refFor(prompt, 'The secret message'), expectedText: 'agentic testing works', reason: 'confirm revealed' })
      return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
    },
  }
}

test('--verify-clean-session: a genuinely correct generated spec is verified to actually pass when re-run standalone', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const dir = mkdtempSync(join(tmpdir(), 'five46-verify-test-'))
  try {
    const result = await performOneE2eRun(
      server.url,
      "reveal the secret message and confirm it says 'agentic testing works'",
      undefined,
      undefined,
      join(dir, 'run.spec.ts'),
      join(dir, 'artifacts'),
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      makeRevealProvider(),
      'fake-key',
      {},
      [],
      undefined,
      undefined,
      undefined,
      true, // verifyCleanSession
      undefined // verify
    )
    assert.notEqual(result, 'errored')
    if (result === 'errored') throw new Error('unreachable')
    assert.equal(result.outcome, 'goal-reached')
    assert.equal(result.cleanSessionVerified, true, 'a genuinely correct spec must be verified as passing, not falsely reported as failing')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--verify: a run whose assertion is genuinely load-bearing has its mutated copy correctly fail', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const dir = mkdtempSync(join(tmpdir(), 'five46-verify-test-'))
  try {
    const result = await performOneE2eRun(
      server.url,
      "reveal the secret message and confirm it says 'agentic testing works'",
      undefined,
      undefined,
      join(dir, 'run.spec.ts'),
      join(dir, 'artifacts'),
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      makeRevealProvider(),
      'fake-key',
      {},
      [],
      undefined,
      undefined,
      undefined,
      undefined, // verifyCleanSession
      true // verify
    )
    assert.notEqual(result, 'errored')
    if (result === 'errored') throw new Error('unreachable')
    assert.equal(result.outcome, 'goal-reached')
    assert.equal(result.mutationVerified, true, 'the mutated (deliberately wrong) assertion must actually be re-executed and fail, not falsely reported as passing (which would mean it never really ran)')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
