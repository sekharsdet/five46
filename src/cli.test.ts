import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'child_process'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { parseAgentArgs, parseApiArgs } from './cli'

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

test('CLI "test" subcommand without an LLM key configured explains what is missing, without crashing', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g'])
  assert.equal(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "test" subcommand rejects an unreadable --storage-state file before attempting anything', () => {
  const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--storage-state', '/nonexistent/path.json'], FAKE_LLM_ENV)
  assert.equal(status, 0)
  assert.ok(stderr.includes("Couldn't read the storage state file"))
})

test('CLI "test" subcommand rejects a --storage-state file that is valid JSON but not a real storage-state shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  const badPath = join(dir, 'not-a-session.json')
  writeFileSync(badPath, JSON.stringify({ hello: 'world' }))
  try {
    const { stderr, status } = runCli(['test', 'http://localhost:1', '--goal', 'g', '--storage-state', badPath], FAKE_LLM_ENV)
    assert.equal(status, 0)
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
  assert.equal(status, 0)
  assert.ok(stderr.includes('requires login credentials'))
})

test('CLI "login" subcommand refuses to proceed if --goal contains the real configured credential in plaintext', () => {
  const { stderr, status } = runCli(
    ['login', 'http://localhost:1', '--goal', 'log in with password hunter2', '--out', '/tmp/wont-be-written.json'],
    { ...FAKE_LLM_ENV, FIVE46_LOGIN_USERNAME: 'ada', FIVE46_LOGIN_PASSWORD: 'hunter2' }
  )
  assert.equal(status, 0)
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

test('CLI "api" subcommand without an LLM key configured explains what is missing, without crashing', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g'])
  assert.equal(status, 0)
  assert.ok(stderr.includes('requires an LLM API key'))
})

test('CLI "api" subcommand rejects an unreadable --storage-state file before attempting anything', () => {
  const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--storage-state', '/nonexistent/path.json'], FAKE_LLM_ENV)
  assert.equal(status, 0)
  assert.ok(stderr.includes("Couldn't read the storage state file"))
})

test('CLI "api" subcommand rejects a --storage-state file that is valid JSON but not a real storage-state shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cli-test-'))
  const badPath = join(dir, 'not-a-session.json')
  writeFileSync(badPath, JSON.stringify({ hello: 'world' }))
  try {
    const { stderr, status } = runCli(['api', 'http://localhost:1', '--goal', 'g', '--storage-state', badPath], FAKE_LLM_ENV)
    assert.equal(status, 0)
    assert.ok(stderr.includes("doesn't look like a storage-state file"))
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
