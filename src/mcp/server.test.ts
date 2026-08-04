import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createFive46McpServer } from './server'
import { startApiTestServer } from '../agent/apiTestServer'
import { launchAgentBrowser } from '../agent/browser'
import { startFixtureServer } from '../agent/testServer'
import type { LlmProvider } from '../llm/types'
import { HARD_MAX_CONCURRENCY, DEFAULT_BROWSER_CONCURRENCY, DEFAULT_CONCURRENCY } from '../agent/runLoop'
import type { StructuredToolOutput } from './tools'

// The MCP client SDK's own `CallToolResult` type declares `structuredContent`
// generically (it has no way to know this server's specific per-tool output
// shape) — this narrows it back to the real shape `tools.ts` actually
// returns, for test assertions only.
function structured(result: unknown): StructuredToolOutput | undefined {
  return (result as { structuredContent?: StructuredToolOutput }).structuredContent
}

/** Real protocol-level tests: a real `Client` talking to a real
 * `McpServer` over `InMemoryTransport.createLinkedPair()` — real tool
 * listing, real `callTool()` round-trips, real schema validation. Only the
 * `LlmProvider` is faked, matching "mock only the true external boundary"
 * everywhere else in this codebase. This tier deliberately does NOT touch
 * real stdio/subprocess — see `cli.test.ts` for the separate black-box test
 * that actually exercises the stdout-corruption risk this feature's design
 * revolves around; `InMemoryTransport` structurally cannot exercise that
 * risk at all (there is no real stdout file descriptor anywhere in this
 * path), so it is not a substitute for that test. */
async function connectedClient(options: Parameters<typeof createFive46McpServer>[0] = {}) {
  const { server } = createFive46McpServer(options)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, close: async () => client.close() }
}

function scriptedProvider(responses: string[]): LlmProvider {
  let turn = 0
  return {
    id: 'fake',
    async complete() {
      const response = responses[Math.min(turn, responses.length - 1)]
      turn++
      return response
    },
  }
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

test('five46 mcp server exposes exactly five46_test and five46_api — never five46_login', async () => {
  const { client, close } = await connectedClient()
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['five46_api', 'five46_test'])
  } finally {
    await close()
  }
})

test('five46_api tool call returns a real, redacted report and writes a real generated script', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, goal: 'confirm the items endpoint is reachable' } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /succeeded: goal reached/)
      assert.match(text, /Wrote \d+ confirmed-working step\(s\) to/)
      // structuredContent is strictly validated by the MCP SDK itself
      // against the tool's outputSchema on every non-error result — reaching
      // this line at all is already real evidence the shape is valid; these
      // assertions confirm its actual *content* is correct too.
      assert.equal(structured(result)?.passed, true)
      assert.equal(structured(result)?.outcome, 'goal-reached')
      assert.equal(typeof structured(result)?.specPath, 'string')
      assert.equal(structured(result)?.acceptanceCriteria, undefined, 'a plain goal call must never carry acceptanceCriteria')
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool call returns structuredContent reflecting a real failure, on a real assertion-failed outcome', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_status', expected: 999, reason: 'deliberately wrong' }),
    ])
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, goal: 'confirm the items endpoint returns 999' } })
      assert.equal(result.isError, true)
      assert.equal(structured(result)?.passed, false)
      assert.equal(structured(result)?.outcome, 'assertion-failed')
      assert.equal(typeof structured(result)?.specPath, 'string', 'a partial spec is still written and its path still reported, even on failure')
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool call redacts a configured auth header secret from the returned report', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const originalEnv = { name: process.env.FIVE46_API_AUTH_HEADER_NAME, value: process.env.FIVE46_API_AUTH_HEADER_VALUE }
  process.env.FIVE46_API_AUTH_HEADER_NAME = 'Authorization'
  process.env.FIVE46_API_AUTH_HEADER_VALUE = 'Bearer super-secret-token'
  try {
    const provider = scriptedProvider([
      // Echo the header back in the response so it would appear in the
      // excerpt fed into the report if redaction were ever dropped.
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/echo-headers', reason: 'check headers' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, goal: 'check that headers are attached' } })
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.ok(!text.includes('super-secret-token'), `real secret leaked into the MCP tool result:\n${text}`)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    process.env.FIVE46_API_AUTH_HEADER_NAME = originalEnv.name
    process.env.FIVE46_API_AUTH_HEADER_VALUE = originalEnv.value
  }
})

test('five46_api tool never accepts allowWrites/allowHosts as call arguments — a POST attempt is blocked regardless', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'POST', url: server.url + '/items', body: '{}', reason: 'try to write' }),
      JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'blocked' }),
    ])
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      // Passing allowWrites/allowHosts even though the schema never
      // declares them — proves there is no code path by which a call
      // argument could reach `context.allowWrites`, not just that the
      // happy-path test never tried.
      const result = await client.callTool({
        name: 'five46_api',
        arguments: { baseUrl: server.url, goal: 'try to create an item', allowWrites: true, allowHosts: ['evil.example.com'] },
      })
      const text = (result.content as { type: string; text: string }[])[0].text
      // formatApiFailureReport's goal-unreachable branch only prints the
      // step description + "(failed)", not the underlying failureDetail
      // text — this confirms the POST was genuinely rejected as a step,
      // not that a specific message string appears.
      assert.match(text, /POST .* \(failed\)/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool includes a root-cause hypothesis in the report on a real assertion failure', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 999, reason: 'confirm an impossible status' })
        // The third call is the post-run root-cause analysis.
        return 'The status assertion likely failed because 999 is not a real HTTP status the server would ever return.'
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, goal: 'confirm the items endpoint returns an impossible status' } })
      assert.equal(result.isError, true, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /a real finding about the API/)
      assert.match(text, /an LLM-generated hypothesis, not a confirmed diagnosis/)
      assert.match(text, /999 is not a real HTTP status/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool unlocks writes only via the real FIVE46_MCP_ALLOW_WRITES env var, never a call argument', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const original = process.env.FIVE46_MCP_ALLOW_WRITES
  process.env.FIVE46_MCP_ALLOW_WRITES = '1'
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'POST', url: server.url + '/items', headers: { 'Content-Type': 'application/json' }, body: '{"name":"widget"}', reason: 'create it' }),
      JSON.stringify({ action: 'assert_status', expected: 201, reason: 'confirm created' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, goal: 'create a widget' } })
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /succeeded: goal reached/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    process.env.FIVE46_MCP_ALLOW_WRITES = original
  }
})

test('five46_api tool rejects an invalid baseUrl honestly, as isError, never an uncaught rejection', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['{}']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: 'not-a-url', goal: 'g' } })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /isn't a valid URL/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool rejects a storageStatePath that escapes the project root, as isError', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['{}']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({
        name: 'five46_test',
        arguments: { url: 'http://localhost:1', goal: 'g', storageStatePath: '../../etc/passwd' },
      })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /escapes the project root/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool rejects an absolute storageStatePath, as isError', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['{}']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({
        name: 'five46_test',
        arguments: { url: 'http://localhost:1', goal: 'g', storageStatePath: '/etc/passwd' },
      })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /must be a relative path/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool call drives a real browser through a real fixture page and writes a real generated spec', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          const match = prompt.match(/\[(e\d+)\][^\n]*Show secret message/)
          return JSON.stringify({ action: 'click', ref: match![1], reason: 'reveal it' })
        }
        if (turn === 2) {
          const match = prompt.match(/\[(e\d+)\][^\n]*agentic testing works/)
          return JSON.stringify({ action: 'assert_visible', ref: match![1], reason: 'confirm revealed' })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, goal: 'reveal the secret message', maxSteps: 5 } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /succeeded: goal reached/)
      assert.match(text, /Wrote \d+ confirmed-working step\(s\) to/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool includes a root-cause hypothesis in the report on a real assertion failure', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          const match = prompt.match(/\[(e\d+)\][^\n]*Show secret message/)
          return JSON.stringify({ action: 'click', ref: match![1], reason: 'reveal it' })
        }
        if (turn === 2) {
          const match = prompt.match(/\[(e\d+)\][^\n]*secret message is/)
          return JSON.stringify({ action: 'assert_text', ref: match![1], expectedText: 'this text will never match', reason: 'confirm revealed' })
        }
        // The third call is the post-run root-cause analysis, not another
        // agentic-loop turn — a real, distinct request/response.
        return 'The assertion likely failed because the expected text does not match what the page actually reveals.'
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, goal: 'reveal the secret message and confirm the text', maxSteps: 5 } })
      assert.equal(result.isError, true, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /a real finding about the app/)
      assert.match(text, /an LLM-generated hypothesis, not a confirmed diagnosis/)
      assert.match(text, /The assertion likely failed because the expected text does not match/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool blocks a destructive-looking click by default, without a FIVE46_MCP_ALLOW_DELETES env var', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        const match = prompt.match(/\[(e\d+)\][^\n]*Delete Account/)
        return JSON.stringify({ action: 'click', ref: match![1], reason: 'delete the account' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, goal: 'delete my account and confirm it is gone', maxSteps: 3 } })
      assert.equal(result.isError, true, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.ok(!text.includes('succeeded: goal reached'), 'the blocked click must never let the run reach a false goal-reached')
      assert.match(text, /0 step\(s\) succeeded/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool never accepts allowDeletes as a call argument — a destructive click stays blocked regardless', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        const match = prompt.match(/\[(e\d+)\][^\n]*Delete Account/)
        return JSON.stringify({ action: 'click', ref: match![1], reason: 'delete the account' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      // Passing allowDeletes even though the schema never declares it —
      // proves there is no code path by which a call argument could reach
      // `context.allowDeletes`, not just that the happy-path test never
      // tried (mirrors the identical five46_api coverage above).
      const result = await client.callTool({
        name: 'five46_test',
        arguments: { url: server.url, goal: 'delete my account and confirm it is gone', maxSteps: 3, allowDeletes: true },
      })
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.ok(!text.includes('succeeded: goal reached'))
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool unlocks a destructive click only via the real FIVE46_MCP_ALLOW_DELETES env var, never a call argument', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const original = process.env.FIVE46_MCP_ALLOW_DELETES
  process.env.FIVE46_MCP_ALLOW_DELETES = '1'
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        turn++
        if (turn === 1) {
          const match = prompt.match(/\[(e\d+)\][^\n]*Delete Account/)
          return JSON.stringify({ action: 'click', ref: match![1], reason: 'delete the account' })
        }
        if (turn === 2) {
          const match = prompt.match(/\[(e\d+)\][^\n]*deleted/)
          return JSON.stringify({ action: 'assert_text', ref: match![1], expectedText: 'Account deleted', reason: 'confirm deleted' })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, goal: 'delete my account and confirm it is gone', maxSteps: 5 } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /succeeded: goal reached/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    process.env.FIVE46_MCP_ALLOW_DELETES = original
  }
})

test('five46_test tool surfaces an unparseable-response run outcome as isError, never an uncaught rejection', async () => {
  // isError mirrors the CLI's CI-gating exit-code rule: any outcome other
  // than goal-reached (including a tooling outcome like this one, not just
  // an app-level assertion failure) is isError:true, giving the calling
  // IDE AI the same one clear failure signal a human reading an exit code
  // gets, rather than something it has to parse the report text to learn.
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    // No goal at all isn't possible (schema requires it), so exercise a
    // different real failure path instead: an unparseable LLM response.
    const provider = scriptedProvider(['not json at all'])
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      if (!(await playwrightAvailable())) return
      const server = await startFixtureServer()
      try {
        const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, goal: 'g', maxSteps: 2 } })
        assert.equal(result.isError, true)
        const text = (result.content as { type: string; text: string }[])[0].text
        assert.match(text, /couldn't be safely parsed/)
      } finally {
        await server.close()
      }
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool rejects a call with neither goal nor story, as isError', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['unused']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: 'http://localhost:1' } })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /exactly one of "goal"\/"story" is required/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool rejects a call with both goal and story, as isError', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['unused']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: 'http://localhost:1', goal: 'g', story: 's' } })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /mutually exclusive/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool rejects a call with neither goal nor story, as isError', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['unused']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: 'http://localhost:1' } })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /exactly one of "goal"\/"story" is required/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool rejects a call with both goal and story, as isError', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const { client, close } = await connectedClient({ projectRoot, provider: scriptedProvider(['unused']), apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: 'http://localhost:1', goal: 'g', story: 's' } })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /mutually exclusive/)
    } finally {
      await close()
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool with story splits a raw story into independent goals and aggregates a per-AC report, all passing', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    // Distinguishes the one-time split call from every per-scenario action
    // call by prompt content (buildStorySplitPrompt's own "Story:" label,
    // never present in buildApiActionPrompt) — safe under real concurrent
    // execution, unlike a single shared turn counter, since per-scenario
    // progress is tracked in a map keyed by each scenario's own goal text
    // (unique per AC).
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['the items endpoint is reachable (AC1)', 'the items endpoint is reachable (AC2)'] })
        }
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, story: 'AC1: reachable. AC2: reachable.' } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /Split into 2 scenario\(s\)/)
      assert.match(text, /2\/2 acceptance criteria reached goal-reached/)
      assert.match(text, /AC1: PASS/)
      assert.match(text, /AC2: PASS/)
      // structuredContent — same strict-SDK-validation reasoning as the
      // plain-goal test above, for the story shape specifically.
      assert.equal(structured(result)?.passed, true)
      assert.equal(structured(result)?.outcome, undefined, 'a story call must never carry a single top-level outcome')
      const acs = structured(result)?.acceptanceCriteria as { index: number; goal: string; outcome: string; passed: boolean; specPath?: string }[]
      assert.equal(acs.length, 2)
      assert.deepEqual(
        acs.map((ac) => [ac.index, ac.passed, ac.outcome]),
        [
          [1, true, 'goal-reached'],
          [2, true, 'goal-reached'],
        ]
      )
      assert.ok(acs.every((ac) => typeof ac.specPath === 'string'))
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool with story reports a mixed pass/fail per-AC breakdown, isError unless every AC passed', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['the reachable scenario', 'the unreachable scenario'] })
        }
        if (prompt.includes('Goal: the unreachable scenario')) {
          return JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'this scenario cannot be verified' })
        }
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, story: 'AC1: reachable. AC2: unreachable.' } })
      assert.equal(result.isError, true)
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /1\/2 acceptance criteria reached goal-reached/)
      assert.match(text, /AC1: PASS/)
      assert.match(text, /AC2: FAIL \(goal-unreachable\)/)
      // The SDK does not require/validate structuredContent on an isError
      // result, but this tool still returns it voluntarily — confirm the
      // aggregate and per-AC detail are both correct even on a mixed batch.
      assert.equal(structured(result)?.passed, false)
      const acs = structured(result)?.acceptanceCriteria as { index: number; goal: string; outcome: string; passed: boolean }[]
      assert.deepEqual(
        acs.map((ac) => [ac.index, ac.passed, ac.outcome]),
        [
          [1, true, 'goal-reached'],
          [2, false, 'goal-unreachable'],
        ]
      )
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_api tool with story: a write failure in ONE scenario does not sink the whole batch — every scenario still resolves and reports', async () => {
  // Regression test for a real gap found via a deliberate code review (not
  // a live incident): `runOneApiScenario` used to have no error handling
  // at all around its report-generation/write step. In `story` mode, each
  // scenario runs as one task inside a shared `Promise.all`
  // (`runWithConcurrency`) — an uncaught throw from just one scenario used
  // to reject the *entire* batch, discarding every other scenario's
  // already-completed result along with it. `projectRoot` here is a real
  // *file*, not a directory, so every scenario's own `writeFileSync` call
  // genuinely fails with a real ENOTDIR — proving the call still resolves
  // gracefully (never an uncaught rejection) with a per-AC breakdown,
  // rather than the tool call itself throwing.
  const server = await startApiTestServer()
  const projectRootParent = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const projectRoot = join(projectRootParent, 'this-is-a-file-not-a-directory')
  writeFileSync(projectRoot, 'not a directory')
  try {
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['scenario one', 'scenario two'] })
        }
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, story: 'two scenarios, both should run to completion' } })
      // The real point of this test: reaching this line at all proves the
      // call resolved instead of the transport-level round trip throwing.
      assert.equal(result.isError, true, 'a write failure on every scenario means the batch as a whole did not pass')
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /Split into 2 scenario\(s\)/)
      assert.match(text, /0\/2 acceptance criteria reached goal-reached/)
      assert.match(text, /AC1: FAIL \(tooling-error\)/)
      assert.match(text, /AC2: FAIL \(tooling-error\)/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRootParent, { recursive: true, force: true })
  }
})

test('five46_api tool with story never exceeds FIVE46_MCP_CONCURRENCY real in-flight scenarios at once', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const original = process.env.FIVE46_MCP_CONCURRENCY
  process.env.FIVE46_MCP_CONCURRENCY = '2'
  try {
    let inFlight = 0
    let maxInFlight = 0
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['scenario one', 'scenario two', 'scenario three', 'scenario four'] })
        }
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 30))
        inFlight--
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, story: 'a four-scenario story' } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      assert.ok(maxInFlight <= 2, `expected at most 2 real scenarios in flight, saw ${maxInFlight}`)
      assert.ok(maxInFlight >= 2, `expected concurrency to actually overlap (not fall back to sequential), saw only ${maxInFlight}`)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    process.env.FIVE46_MCP_CONCURRENCY = original
  }
})

test('five46_api tool with story falls back to DEFAULT_CONCURRENCY when FIVE46_MCP_CONCURRENCY is unset, and clamps an out-of-range value to HARD_MAX_CONCURRENCY', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const original = process.env.FIVE46_MCP_CONCURRENCY
  process.env.FIVE46_MCP_CONCURRENCY = String(HARD_MAX_CONCURRENCY + 50)
  try {
    let inFlight = 0
    let maxInFlight = 0
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: Array.from({ length: HARD_MAX_CONCURRENCY + 3 }, (_, i) => `scenario ${i + 1}`) })
        }
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlight--
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, story: 'a many-scenario story' } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      assert.ok(maxInFlight <= HARD_MAX_CONCURRENCY, `an out-of-range FIVE46_MCP_CONCURRENCY should clamp to HARD_MAX_CONCURRENCY (${HARD_MAX_CONCURRENCY}), saw ${maxInFlight}`)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    process.env.FIVE46_MCP_CONCURRENCY = original
  }
})

test('five46_api tool with story defaults to DEFAULT_CONCURRENCY when FIVE46_MCP_CONCURRENCY is truly unset (not just out-of-range)', async () => {
  const server = await startApiTestServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const original = process.env.FIVE46_MCP_CONCURRENCY
  delete process.env.FIVE46_MCP_CONCURRENCY
  try {
    let inFlight = 0
    let maxInFlight = 0
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['scenario one', 'scenario two', 'scenario three', 'scenario four', 'scenario five'] })
        }
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 30))
        inFlight--
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        if (turn === 2) return JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm reachable' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_api', arguments: { baseUrl: server.url, story: 'a five-scenario story' } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      assert.equal(maxInFlight, DEFAULT_CONCURRENCY, `five46_api's true unset default should be DEFAULT_CONCURRENCY (${DEFAULT_CONCURRENCY}), saw ${maxInFlight}`)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    if (original === undefined) delete process.env.FIVE46_MCP_CONCURRENCY
    else process.env.FIVE46_MCP_CONCURRENCY = original
  }
})

test('five46_test tool with story splits a raw story into independent goals, driving a real browser per scenario', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  try {
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['reveal the secret message', 'reveal the secret message once more'] })
        }
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) {
          const match = prompt.match(/\[(e\d+)\][^\n]*Show secret message/)
          return JSON.stringify({ action: 'click', ref: match![1], reason: 'reveal it' })
        }
        if (turn === 2) {
          const match = prompt.match(/\[(e\d+)\][^\n]*agentic testing works/)
          return JSON.stringify({ action: 'assert_visible', ref: match![1], reason: 'confirm revealed' })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, story: 'AC1: reveal message. AC2: reveal message once more.', maxSteps: 5 } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      const text = (result.content as { type: string; text: string }[])[0].text
      assert.match(text, /Split into 2 scenario\(s\)/)
      assert.match(text, /2\/2 acceptance criteria reached goal-reached/)
      assert.match(text, /AC1: PASS/)
      assert.match(text, /AC2: PASS/)
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('five46_test tool with story defaults to the lower DEFAULT_BROWSER_CONCURRENCY (not DEFAULT_CONCURRENCY) when FIVE46_MCP_CONCURRENCY is unset', async (t) => {
  if (!(await playwrightAvailable())) {
    t.skip('playwright unavailable in this environment')
    return
  }
  const server = await startFixtureServer()
  const projectRoot = mkdtempSync(join(tmpdir(), 'five46-mcp-test-'))
  const original = process.env.FIVE46_MCP_CONCURRENCY
  delete process.env.FIVE46_MCP_CONCURRENCY
  try {
    let inFlight = 0
    let maxInFlight = 0
    const turnsByGoal = new Map<string, number>()
    const provider: LlmProvider = {
      id: 'fake',
      async complete(prompt) {
        if (prompt.includes('Story:')) {
          return JSON.stringify({ goals: ['reveal message A', 'reveal message B', 'reveal message C', 'reveal message D'] })
        }
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 50))
        inFlight--
        const goal = prompt.match(/^Goal: (.*)$/m)?.[1] ?? 'unknown'
        const turn = (turnsByGoal.get(goal) ?? 0) + 1
        turnsByGoal.set(goal, turn)
        if (turn === 1) {
          const match = prompt.match(/\[(e\d+)\][^\n]*Show secret message/)
          return JSON.stringify({ action: 'click', ref: match![1], reason: 'reveal it' })
        }
        if (turn === 2) {
          const match = prompt.match(/\[(e\d+)\][^\n]*agentic testing works/)
          return JSON.stringify({ action: 'assert_visible', ref: match![1], reason: 'confirm revealed' })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }
    const { client, close } = await connectedClient({ projectRoot, provider, apiKey: 'fake-key' })
    try {
      const result = await client.callTool({ name: 'five46_test', arguments: { url: server.url, story: 'four reveal-message scenarios', maxSteps: 5 } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      assert.equal(
        maxInFlight,
        DEFAULT_BROWSER_CONCURRENCY,
        `five46_test's true unset default should be DEFAULT_BROWSER_CONCURRENCY (${DEFAULT_BROWSER_CONCURRENCY}), not DEFAULT_CONCURRENCY (${DEFAULT_CONCURRENCY}) — saw ${maxInFlight}`
      )
    } finally {
      await close()
    }
  } finally {
    await server.close()
    rmSync(projectRoot, { recursive: true, force: true })
    if (original === undefined) delete process.env.FIVE46_MCP_CONCURRENCY
    else process.env.FIVE46_MCP_CONCURRENCY = original
  }
})
