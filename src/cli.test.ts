import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'child_process'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { parseAgentArgs, parseApiArgs, parseDiffArgs, parseListArgs, withProjectHeaderLine, resolveStructuredPlan, resolveActionCache, performOneApiRun } from './cli'
import { startApiTestServer } from './agent/apiTestServer'
import type { SafetyMode } from './agent/apiTypes'
import type { LlmProvider } from './llm/types'

// cli.ts guards its own `main()` invocation behind `require.main === module`
// specifically so this import doesn't trigger a full CLI run as a side
// effect (an earlier version had no such guard — importing this module for
// this exact test would have run `main()` against the test runner's own
// argv). Confirmed the guard is exactly what makes this test file possible.

test('parseAgentArgs separates url, --goal, --max-steps, --headed, and --out', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'log in', '--max-steps', '20', '--headed', '--out', 'x.spec.ts'])
  assert.equal(result.url, 'http://localhost:3000')
  assert.equal(result.goal, 'log in')
  assert.equal(result.maxSteps, 20)
  assert.equal(result.headed, true)
  assert.equal(result.out, 'x.spec.ts')
})

test('parseAgentArgs leaves headed/maxSteps/out undefined when not passed, not defaulted here', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'log in'])
  assert.equal(result.headed, undefined)
  assert.equal(result.maxSteps, undefined)
  assert.equal(result.out, undefined)
  assert.equal(result.allowDeletes, undefined)
})

test('parseAgentArgs recognizes --allow-deletes', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'delete my account', '--allow-deletes'])
  assert.equal(result.allowDeletes, true)
})

test('parseAgentArgs recognizes --no-root-cause', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--no-root-cause'])
  assert.equal(result.noRootCause, true)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).noRootCause, undefined)
})

test('parseAgentArgs recognizes --repeat, leaving it undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--repeat', '3'])
  assert.equal(result.repeat, 3)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).repeat, undefined)
})

test('parseAgentArgs recognizes --project, leaving it undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--project', 'checkout'])
  assert.equal(result.project, 'checkout')
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).project, undefined)
})

test('parseAgentArgs recognizes --record-video, leaving it undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--record-video'])
  assert.equal(result.recordVideo, true)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).recordVideo, undefined)
})

test('parseAgentArgs recognizes --structured-plan, leaving it undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--structured-plan'])
  assert.equal(result.structuredPlan, true)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).structuredPlan, undefined)
})

test('parseAgentArgs recognizes --no-structured-plan, leaving it undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--no-structured-plan'])
  assert.equal(result.noStructuredPlan, true)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).noStructuredPlan, undefined)
})

test('parseAgentArgs recognizes --fast-steps, leaving it undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--fast-steps'])
  assert.equal(result.fastSteps, true)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).fastSteps, undefined)
})

test('parseAgentArgs recognizes --story and --concurrency, leaving them undefined when not passed', () => {
  const result = parseAgentArgs(['http://localhost:3000', '--story', 'story.txt', '--concurrency', '4'])
  assert.equal(result.story, 'story.txt')
  assert.equal(result.concurrency, 4)
  const withoutEither = parseAgentArgs(['http://localhost:3000', '--goal', 'g'])
  assert.equal(withoutEither.story, undefined)
  assert.equal(withoutEither.concurrency, undefined)
})

test('parseAgentArgs recognizes --action-cache, leaving it undefined when not passed', () => {
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g', '--action-cache']).actionCache, true)
  assert.equal(parseAgentArgs(['http://localhost:3000', '--goal', 'g']).actionCache, undefined)
})

test('parseListArgs takes a positional dir and a --project filter, in either order', () => {
  assert.deepEqual(parseListArgs(['./tests', '--project', 'checkout']), { dir: './tests', project: 'checkout' })
  assert.deepEqual(parseListArgs(['--project', 'checkout', './tests']), { dir: './tests', project: 'checkout' })
  assert.deepEqual(parseListArgs([]), {})
})

test('withProjectHeaderLine splices a Project line right after the Run/outcome header line', () => {
  const specBody = ['// Goal: g', '// Run abc123 — outcome: goal-reached', 'body'].join('\n')
  assert.equal(withProjectHeaderLine(specBody, 'checkout'), ['// Goal: g', '// Run abc123 — outcome: goal-reached', '// Project: checkout', 'body'].join('\n'))
})

test('withProjectHeaderLine is a graceful no-op when the expected header line is not found', () => {
  const specBody = 'not a five46 header at all'
  assert.equal(withProjectHeaderLine(specBody, 'checkout'), specBody)
})

test('parseApiArgs separates base URL, --goal, --max-steps, --out, --storage-state, and repeatable --allow-host', () => {
  const result = parseApiArgs([
    'http://localhost:3000',
    '--goal',
    'create a user',
    '--max-steps',
    '20',
    '--out',
    'x.test.mjs',
    '--storage-state',
    'session.json',
    '--allow-host',
    'auth.example.com',
    '--allow-host',
    'billing.example.com',
  ])
  assert.equal(result.baseUrl, 'http://localhost:3000')
  assert.equal(result.goal, 'create a user')
  assert.equal(result.maxSteps, 20)
  assert.equal(result.out, 'x.test.mjs')
  assert.equal(result.storageState, 'session.json')
  assert.deepEqual(result.allowHosts, ['auth.example.com', 'billing.example.com'])
})

test('parseApiArgs defaults allowWrites/allowDeletes to false and allowHosts to empty when not passed', () => {
  const result = parseApiArgs(['http://localhost:3000', '--goal', 'read something'])
  assert.equal(result.allowWrites, false)
  assert.equal(result.allowDeletes, false)
  assert.deepEqual(result.allowHosts, [])
  assert.equal(result.noRootCause, undefined)
})

test('parseApiArgs recognizes --no-root-cause', () => {
  const result = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--no-root-cause'])
  assert.equal(result.noRootCause, true)
})

test('parseApiArgs recognizes --repeat, leaving it undefined when not passed', () => {
  const result = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--repeat', '3'])
  assert.equal(result.repeat, 3)
  assert.equal(parseApiArgs(['http://localhost:3000', '--goal', 'g']).repeat, undefined)
})

test('parseApiArgs recognizes --structured-plan, leaving it undefined when not passed', () => {
  const result = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--structured-plan'])
  assert.equal(result.structuredPlan, true)
  assert.equal(parseApiArgs(['http://localhost:3000', '--goal', 'g']).structuredPlan, undefined)
})

test('parseApiArgs recognizes --no-structured-plan, leaving it undefined when not passed', () => {
  const result = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--no-structured-plan'])
  assert.equal(result.noStructuredPlan, true)
  assert.equal(parseApiArgs(['http://localhost:3000', '--goal', 'g']).noStructuredPlan, undefined)
})

test('parseApiArgs recognizes --fast-steps, leaving it undefined when not passed', () => {
  const result = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--fast-steps'])
  assert.equal(result.fastSteps, true)
  assert.equal(parseApiArgs(['http://localhost:3000', '--goal', 'g']).fastSteps, undefined)
})

test('parseApiArgs recognizes --story and --concurrency, leaving them undefined when not passed', () => {
  const result = parseApiArgs(['http://localhost:3000', '--story', 'story.txt', '--concurrency', '4'])
  assert.equal(result.story, 'story.txt')
  assert.equal(result.concurrency, 4)
  const withoutEither = parseApiArgs(['http://localhost:3000', '--goal', 'g'])
  assert.equal(withoutEither.story, undefined)
  assert.equal(withoutEither.concurrency, undefined)
})

test('resolveStructuredPlan defaults to true when --no-structured-plan was not passed', () => {
  assert.equal(resolveStructuredPlan({}), true)
  assert.equal(resolveStructuredPlan({ noStructuredPlan: undefined }), true)
})

test('resolveStructuredPlan resolves to false when --no-structured-plan was passed', () => {
  assert.equal(resolveStructuredPlan({ noStructuredPlan: true }), false)
})

test('resolveActionCache is true only when both --action-cache was requested AND structured planning is enabled', () => {
  assert.equal(resolveActionCache({ actionCache: true }, true), true)
  assert.equal(resolveActionCache({ actionCache: true }, false), false, 'the cache is only ever a source for the upfront plan — nothing to do with structured planning off')
  assert.equal(resolveActionCache({ actionCache: undefined }, true), false, 'opt-in only — never true unless explicitly requested')
  assert.equal(resolveActionCache({}, true), false)
})

test('parseApiArgs sets allowWrites/allowDeletes independently', () => {
  const writesOnly = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--allow-writes'])
  assert.equal(writesOnly.allowWrites, true)
  assert.equal(writesOnly.allowDeletes, false)

  const both = parseApiArgs(['http://localhost:3000', '--goal', 'g', '--allow-writes', '--allow-deletes'])
  assert.equal(both.allowWrites, true)
  assert.equal(both.allowDeletes, true)
})

// The tests below spawn the actual compiled CLI as a real subprocess (not an
// in-process import) specifically because `main()`'s error paths call
// `process.exit()`, which would kill the test runner itself if invoked
// in-process — this is real, black-box verification of the actual entry
// point a user runs.

const CLI_PATH = join(__dirname, '../dist/cli.js')

// Explicitly strips any ambient FIVE46_LLM_* AND points HOME at a fresh,
// empty temp directory so these tests are deterministic regardless of what's
// set in the actual shell/machine running them — found by real failure: once
// a real ~/.five46/config.json exists on the developer's own machine
// (from actually running `five46 config`), resolveCredentials() falls
// back to it even with the env vars stripped, silently changing this test's
// outcome. Isolating HOME closes that gap the same way store.test.ts/
// resolve.test.ts already isolate configDir directly.
// spawnSync (not execFileSync) because execFileSync only exposes stderr via
// the thrown error on a non-zero exit — it's silently dropped on success,
// which this file needs to assert on (the missing-API-key path exits 0).
function runCli(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  const { FIVE46_LLM_PROVIDER, FIVE46_LLM_API_KEY, FIVE46_LOGIN_USERNAME, FIVE46_LOGIN_PASSWORD, ...cleanEnv } = process.env
  const fakeHome = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    const result = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env: { ...cleanEnv, HOME: fakeHome, ...extraEnv } })
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

// A fake key is enough for these — every test below fails at a validation
// step that happens *before* any real network call, matching the same
// fail-fast-and-cheap ordering the missing-LLM-key/missing-Playwright
// checks already establish.
const FAKE_LLM_ENV = { FIVE46_LLM_PROVIDER: 'openai', FIVE46_LLM_API_KEY: 'sk-fake-for-testing' }

test('CLI with no arguments prints usage and exits non-zero', () => {
  const { stderr, status } = runCli([])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('Usage: five46 test'))
})

test('CLI "test" subcommand without --goal prints usage and exits non-zero, without ever launching a browser', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('Usage: five46 test'))
})

test('CLI "test" subcommand rejects a non-http(s)/file URL before attempting anything', () => {
  const { stderr, status } = runCli(['test', 'not-a-url-at-all', '--goal', 'g'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes("isn't a valid URL"))
})

test('CLI "test" subcommand with --repeat still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--repeat', '3'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "api" subcommand with --repeat still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--repeat', '3'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand with --record-video still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--record-video'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand with --structured-plan still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--structured-plan'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "api" subcommand with --structured-plan still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--structured-plan'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand with --no-structured-plan still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--no-structured-plan'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "api" subcommand with --no-structured-plan still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--no-structured-plan'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand with --fast-steps still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--fast-steps'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "api" subcommand with --fast-steps still fails at the same missing-API-key preflight check, without launching anything', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--fast-steps'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand without an LLM key configured explains what is missing and exits non-zero, without crashing', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand rejects --goal and --story passed together as mutually exclusive', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--story', 'story.txt'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('mutually exclusive'))
})

test('CLI "api" subcommand rejects --goal and --story passed together as mutually exclusive', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--story', 'story.txt'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('mutually exclusive'))
})

test('CLI "test" subcommand without --goal or --story prints usage and exits non-zero', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('Usage: five46 test'))
})

test('CLI "test" subcommand with --story still fails at the same missing-API-key preflight check, without ever reading the story file', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--story', '/nonexistent/story.txt'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
  assert.ok(!stderr.includes("Couldn't read the story file"), 'should fail at the API-key preflight before ever touching the story file')
})

test('CLI "api" subcommand with --story still fails at the same missing-API-key preflight check, without ever reading the story file', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--story', '/nonexistent/story.txt'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
  assert.ok(!stderr.includes("Couldn't read the story file"))
})

test('CLI "test" subcommand with --story rejects an unreadable story file, after the API-key preflight passes', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--story', '/nonexistent/story.txt'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes("Couldn't read the story file"))
})

test('CLI "test" subcommand discloses the --action-cache/--no-structured-plan conflict before the API-key preflight, never silently overriding either flag', () => {
  const { stdout, stderr } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--action-cache', '--no-structured-plan'])
  assert.ok(stdout.includes('--action-cache has no effect together with --no-structured-plan'))
  // Still reaches (and fails) the ordinary missing-API-key preflight
  // afterward — the disclosure is additive, not a substitute for it.
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand does not disclose the --action-cache conflict when structured planning is left at its default-on state', () => {
  const { stdout } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--action-cache'])
  assert.ok(!stdout.includes('--action-cache has no effect'))
})

test('CLI "api" subcommand with --story rejects an unreadable story file, after the API-key preflight passes', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--story', '/nonexistent/story.txt'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes("Couldn't read the story file"))
})

test('CLI "test" subcommand rejects an unreadable --storage-state file before attempting anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--storage-state', '/nonexistent/path.json'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes("Couldn't read the storage state file"))
})

test('CLI "test" subcommand rejects a --storage-state file that is valid JSON but not a real storage-state shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  const badPath = join(dir, 'not-a-session.json')
  writeFileSync(badPath, JSON.stringify({ hello: 'world' }))
  try {
    const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--storage-state', badPath], FAKE_LLM_ENV)
    assert.notEqual(status, 0)
    assert.ok(stderr.includes("doesn't look like a storage-state file"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "login" subcommand requires --out, same as it requires --goal', () => {
  const { stderr, status } = runCli(['login', 'http://localhost:1', '--goal', 'g'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('Usage: five46'))
})

test('CLI "login" subcommand without login credentials configured explains what is missing, without attempting a login', () => {
  const { stderr, status } = runCli(['login', 'http://localhost:1', '--goal', 'g', '--out', '/tmp/wont-be-written.json'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires login credentials'))
})

test('CLI "login" subcommand refuses to proceed if --goal contains the real configured credential in plaintext', () => {
  const { stderr, status } = runCli(
    ['login', 'http://localhost:1', '--goal', 'log in with password hunter2', '--out', '/tmp/wont-be-written.json'],
    { ...FAKE_LLM_ENV, FIVE46_LOGIN_USERNAME: 'ada', FIVE46_LOGIN_PASSWORD: 'hunter2' }
  )
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('appears to contain the configured username/password in plaintext'))
})

test('CLI "api" subcommand without --goal prints usage and exits non-zero, without ever making a network call', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('Usage: five46'))
})

test('CLI "api" subcommand rejects a non-http(s) base URL before attempting anything, including file:', () => {
  const notAUrl = runCli(['api', 'not-a-url-at-all', '--goal', 'g'])
  assert.notEqual(notAUrl.status, 0)
  assert.ok(notAUrl.stderr.includes("isn't a valid URL"))

  const fileUrl = runCli(['api', 'file:///etc/hosts', '--goal', 'g'])
  assert.notEqual(fileUrl.status, 0)
  assert.ok(fileUrl.stderr.includes('Needs an http(s) URL'))
})

test('CLI "api" subcommand without an LLM key configured explains what is missing and exits non-zero, without crashing', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "api" subcommand rejects an unreadable --storage-state file before attempting anything', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--storage-state', '/nonexistent/path.json'], FAKE_LLM_ENV)
  assert.notEqual(status, 0)
  assert.ok(stderr.includes("Couldn't read the storage state file"))
})

test('CLI "api" subcommand rejects a --storage-state file that is valid JSON but not a real storage-state shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  const badPath = join(dir, 'not-a-session.json')
  writeFileSync(badPath, JSON.stringify({ hello: 'world' }))
  try {
    const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--storage-state', badPath], FAKE_LLM_ENV)
    assert.notEqual(status, 0)
    assert.ok(stderr.includes("doesn't look like a storage-state file"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "list" subcommand reports no runs found in an empty directory, exits zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    const { stdout, status } = runCli(['list', dir])
    assert.equal(status, 0, 'an empty result is a normal state, not a CI failure')
    assert.ok(stdout.includes('No generated five46 runs found'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "list" subcommand parses real generated files\' own header comments — no separate metadata format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    writeFileSync(
      join(dir, 'five46-agent-abc123.spec.ts'),
      [
        '// Auto-generated by five46 test from a real agent run against http://localhost:1',
        '// Goal: reveal the secret message',
        '// Run abc123 — outcome: goal-reached',
        '',
        "import { test, expect } from '@playwright/test'",
      ].join('\n')
    )
    writeFileSync(
      join(dir, 'five46-api-def456.test.mjs'),
      ['// Auto-generated by five46 api from a real run against http://localhost:2', '// Goal: create a user', '// Run def456 — outcome: assertion-failed'].join('\n')
    )
    // Must never treat an unrelated file as a generated run.
    writeFileSync(join(dir, 'not-a-five46-file.txt'), 'hello')

    const { stdout, status } = runCli(['list', dir])
    assert.equal(status, 0)
    assert.ok(stdout.includes('2 generated run(s)'))
    assert.ok(stdout.includes('five46-agent-abc123.spec.ts'))
    assert.ok(stdout.includes('succeeded'), 'goal-reached should render as "succeeded"')
    assert.ok(stdout.includes('reveal the secret message'))
    assert.ok(stdout.includes('five46-api-def456.test.mjs'))
    assert.ok(stdout.includes('assertion-failed'))
    assert.ok(!stdout.includes('not-a-five46-file.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "list" subcommand defaults to the current directory when none is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    writeFileSync(join(dir, 'five46-agent-xyz789.spec.ts'), ['// Goal: g', '// Run xyz789 — outcome: goal-reached'].join('\n'))
    const result = spawnSync('node', [CLI_PATH, 'list'], { encoding: 'utf8', cwd: dir, env: { ...process.env } })
    assert.equal(result.status, 0)
    assert.ok((result.stdout ?? '').includes('five46-agent-xyz789.spec.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "list" subcommand fails honestly, exits non-zero, for a directory that does not exist', () => {
  const { stderr, status } = runCli(['list', '/definitely/does/not/exist/five46'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes("Couldn't read directory"))
})

test('parseDiffArgs takes the first two positionals as fileA/fileB', () => {
  const result = parseDiffArgs(['a.spec.ts', 'b.spec.ts'])
  assert.equal(result.fileA, 'a.spec.ts')
  assert.equal(result.fileB, 'b.spec.ts')
})

test('CLI "diff" subcommand reports identical files as identical and exits zero, ignoring only the run-id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    const fileA = join(dir, 'a.spec.ts')
    const fileB = join(dir, 'b.spec.ts')
    writeFileSync(fileA, ['// Goal: g', '// Run aaa111 — outcome: goal-reached', 'body'].join('\n'))
    writeFileSync(fileB, ['// Goal: g', '// Run bbb222 — outcome: goal-reached', 'body'].join('\n'))

    const { stdout, status } = runCli(['diff', fileA, fileB])
    assert.equal(status, 0)
    assert.ok(stdout.includes('identical'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "diff" subcommand shows a real difference and exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    const fileA = join(dir, 'a.spec.ts')
    const fileB = join(dir, 'b.spec.ts')
    writeFileSync(fileA, ['// Goal: g', '// Run aaa111 — outcome: goal-reached', 'await page.locator("x").click()'].join('\n'))
    writeFileSync(fileB, ['// Goal: g', '// Run bbb222 — outcome: goal-reached', 'await page.locator("y").click()'].join('\n'))

    const { stdout, status } = runCli(['diff', fileA, fileB])
    assert.notEqual(status, 0)
    assert.ok(stdout.includes('- await page.locator("x").click()'))
    assert.ok(stdout.includes('+ await page.locator("y").click()'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "diff" subcommand fails honestly, exits non-zero, when a file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    const fileA = join(dir, 'a.spec.ts')
    writeFileSync(fileA, 'content')
    const { stderr, status } = runCli(['diff', fileA, join(dir, 'missing.spec.ts')])
    assert.notEqual(status, 0)
    assert.ok(stderr.includes("Couldn't read"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "diff" subcommand with a missing second argument prints usage and exits non-zero', () => {
  const { stderr, status } = runCli(['diff', 'onlyone.spec.ts'])
  assert.notEqual(status, 0)
  assert.ok(stderr.includes('Usage: five46 test'))
})

test('CLI "test" subcommand with --project fails honestly, exits non-zero, when five46.config.json does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    const result = spawnSync('node', [CLI_PATH, 'test', 'http://localhost:1', '--goal', 'g', '--project', 'checkout'], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ...FAKE_LLM_ENV },
    })
    assert.notEqual(result.status, 0)
    assert.ok((result.stderr ?? '').includes('five46.config.json'))
    assert.ok((result.stderr ?? '').includes('not found'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "test" subcommand with --project fails honestly, exits non-zero, and lists real project names, when the named project is not configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    writeFileSync(join(dir, 'five46.config.json'), JSON.stringify({ projects: { checkout: { url: 'http://localhost:3000' } } }))
    const result = spawnSync('node', [CLI_PATH, 'test', 'http://localhost:1', '--goal', 'g', '--project', 'nope'], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ...FAKE_LLM_ENV },
    })
    assert.notEqual(result.status, 0)
    assert.ok((result.stderr ?? '').includes('No project named "nope"'))
    assert.ok((result.stderr ?? '').includes('checkout'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "test" subcommand with --project fills in the URL from five46.config.json when none is given on the command line', () => {
  // Confirms the merge actually ran (reaching the URL-validation step using
  // the project's configured URL) rather than --project being silently
  // ignored — a bad scheme in the *project's* url is enough to prove it
  // was really substituted in, since an omitted bare url would instead hit
  // the earlier "missing url/goal" usage error, not URL validation.
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    writeFileSync(join(dir, 'five46.config.json'), JSON.stringify({ projects: { checkout: { url: 'ftp://not-http' } } }))
    const result = spawnSync('node', [CLI_PATH, 'test', '--goal', 'g', '--project', 'checkout'], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ...FAKE_LLM_ENV },
    })
    assert.notEqual(result.status, 0)
    assert.ok(!(result.stderr ?? '').includes('Usage: five46 test'), 'should have gotten past "missing url", proving the project default was used')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI "list" subcommand --project filters to only the matching tagged run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  try {
    writeFileSync(
      join(dir, 'five46-agent-tagged.spec.ts'),
      ['// Goal: g1', '// Run tagged — outcome: goal-reached', '// Project: checkout', ''].join('\n')
    )
    writeFileSync(join(dir, 'five46-agent-untagged.spec.ts'), ['// Goal: g2', '// Run untagged — outcome: goal-reached', ''].join('\n'))

    const { stdout, status } = runCli(['list', dir, '--project', 'checkout'])
    assert.equal(status, 0)
    assert.ok(stdout.includes('1 generated run(s)'))
    assert.ok(stdout.includes('five46-agent-tagged.spec.ts'))
    assert.ok(!stdout.includes('five46-agent-untagged.spec.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Real, black-box stdio tests — the ones this whole feature's design
// actually revolves around. `src/mcp/server.test.ts`'s InMemoryTransport
// tests are real protocol/behavior tests, but structurally cannot exercise
// the risk named in DEVELOPMENT.md's "MCP server integration" section: a
// stray byte written to the real process.stdout file descriptor corrupting
// the real newline-delimited JSON-RPC stream a real StdioServerTransport
// reads on the other end of a real subprocess pipe. Only spawning the
// actual compiled binary as a real child process and inspecting its real
// stdout/stderr bytes can prove that never happens.

function spawnMcpServer(extraEnv: Record<string, string> = {}) {
  const { STATECHECK_LLM_PROVIDER, STATECHECK_LLM_API_KEY, ...cleanEnv } = process.env
  return spawn('node', [CLI_PATH, 'mcp'], { env: { ...cleanEnv, ...FAKE_LLM_ENV, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
}

test('five46 mcp: an idle server writes nothing at all to stdout, and exactly the startup line to stderr', async () => {
  const child = spawnMcpServer()
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))

  // Give the process real time to start up and print its one startup line
  // (or, if this feature were broken, any stray console.log banner) before
  // inspecting what actually landed on each stream.
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (stderr.length > 0) {
        clearInterval(check)
        resolve(undefined)
      }
    }, 20)
    setTimeout(() => {
      clearInterval(check)
      resolve(undefined)
    }, 3000)
  })

  child.kill()
  await new Promise((resolve) => child.once('exit', resolve))

  assert.equal(stdout, '', `stdout must be completely empty from an idle server — got: ${JSON.stringify(stdout)}`)
  assert.match(stderr, /five46 mcp: server running on stdio/)
})

test('five46 mcp: a real tool call over real stdio produces only valid JSON-RPC on stdout, nothing else, ever', async (t) => {
  let StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
  let Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client
  try {
    ;({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'))
    ;({ Client } = require('@modelcontextprotocol/sdk/client/index.js'))
  } catch {
    t.skip('@modelcontextprotocol/sdk not installed in this environment')
    return
  }

  const { STATECHECK_LLM_PROVIDER, STATECHECK_LLM_API_KEY, ...cleanEnv } = process.env
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, 'mcp'],
    env: { ...cleanEnv, ...FAKE_LLM_ENV },
    stderr: 'pipe',
  })

  // Independent of the SDK client's own (correctly strict) JSON-RPC
  // parsing succeeding at all — which already proves no stray byte broke
  // its newline-delimited framing — also capture raw stderr directly to
  // confirm the startup diagnostic landed there, not on stdout.
  let stderrText = ''

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  try {
    await client.connect(transport)
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => (stderrText += chunk.toString('utf8')))
    }

    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['five46_api', 'five46_test']
    )

    const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: 'http://localhost:1', goal: 'g', maxSteps: 1 } })
    // A malformed/malparsed request would surface as a client-side error
    // or a hang, not a normal CallToolResult — reaching this line at all
    // is itself real evidence the stdio channel stayed uncorrupted for a
    // full real round trip, not just at startup.
    assert.ok(Array.isArray((result as { content: unknown[] }).content))
  } finally {
    await client.close()
  }

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.match(stderrText, /five46 mcp: server running on stdio/)
})

test('performOneApiRun returns the "errored" sentinel (never throws) when writing the generated spec fails', async () => {
  // Regression test for a real gap found via a deliberate code review (not
  // a live incident): the report-generation/write step used to run
  // completely outside any try/catch, so a genuine I/O failure there (a
  // full disk, an unwritable directory) would propagate as an uncaught
  // exception. This matters far more than it looks for `--story`: each
  // scenario's call runs as one task inside `runWithConcurrency`'s shared
  // `Promise.all` (see `runStoryScenarios`/`runApiStoryScenarios`) — one
  // uncaught throw would abort the *entire* batch, discarding every other
  // scenario's already-completed result along with it, not just failing
  // the one scenario that hit the error. `outArg` here points *through* a
  // real file (not a directory), so the write genuinely fails with a real
  // ENOTDIR, not a simulated error.
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  const notADir = join(dir, 'this-is-a-file-not-a-directory')
  writeFileSync(notADir, 'not a directory')
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const safety: SafetyMode = { allowWrites: false, allowDeletes: false, targetOrigin: new URL(server.url).origin, allowedHosts: new Set(), baseUrl: server.url }

    const result = await performOneApiRun(
      server.url,
      'list items',
      undefined,
      join(notADir, 'out.test.mjs'),
      undefined,
      safety,
      undefined,
      true,
      false,
      provider,
      'fake-key',
      [],
      undefined,
      false
    )

    assert.equal(result, 'errored', 'a write failure after a completed run must resolve to the errored sentinel, never throw')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
