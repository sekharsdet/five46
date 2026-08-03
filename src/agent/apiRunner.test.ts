import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runApiTest } from './apiRunner'
import { startApiTestServer } from './apiTestServer'
import type { SafetyMode } from './apiTypes'
import type { LlmProvider } from '../llm/types'
import { API_ACTION_MAX_OUTPUT_TOKENS, PLAN_MAX_OUTPUT_TOKENS } from './runLoop'

function safetyMode(baseUrl: string, overrides: Partial<SafetyMode> = {}): SafetyMode {
  return { allowWrites: false, allowDeletes: false, targetOrigin: new URL(baseUrl).origin, allowedHosts: new Set(), ...overrides }
}

/** Repeats the final scripted response forever once the script runs out —
 * matches the "always returns the same thing" shape a real stuck agent
 * looks like, rather than treating running out of a fixed-length script as
 * a test-setup error. */
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

test('runApiTest bounds each live per-turn call with API_ACTION_MAX_OUTPUT_TOKENS', async () => {
  const server = await startApiTestServer()
  try {
    const capturedOptions: ({ maxOutputTokens?: number } | undefined)[] = []
    const responses = [
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm ok' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed' }),
    ]
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete(_prompt, _apiKey, options) {
        capturedOptions.push(options)
        return responses[Math.min(turn++, responses.length - 1)]
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items and confirm the request succeeded',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.ok(capturedOptions.length > 0)
    assert.ok(
      capturedOptions.every((options) => options?.maxOutputTokens === API_ACTION_MAX_OUTPUT_TOKENS),
      'every live per-turn call must be bounded by API_ACTION_MAX_OUTPUT_TOKENS'
    )
  } finally {
    await server.close()
  }
})

test('runApiTest with useFastSteps sends fastPath:true on every live per-turn call', async () => {
  const server = await startApiTestServer()
  try {
    const capturedOptions: ({ fastPath?: boolean } | undefined)[] = []
    const responses = [
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm ok' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed' }),
    ]
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete(_prompt, _apiKey, options) {
        capturedOptions.push(options)
        return responses[Math.min(turn++, responses.length - 1)]
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items and confirm the request succeeded',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
      useFastSteps: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.ok(capturedOptions.length > 0)
    assert.ok(
      capturedOptions.every((options) => options?.fastPath === true),
      'every live per-turn call must set fastPath:true when useFastSteps is on'
    )
  } finally {
    await server.close()
  }
})

test('runApiTest drives a full create -> saveAs -> read -> delete chain against a real server', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({
        action: 'request',
        method: 'POST',
        url: server.url + '/items',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'widget' }),
        saveAs: { name: 'itemId', path: 'id' },
        reason: 'create an item',
      }),
      JSON.stringify({ action: 'assert_status', expected: 201, reason: 'confirm created' }),
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items/{{itemId}}', reason: 'read it back' }),
      JSON.stringify({ action: 'assert_json_path_equals', path: 'name', expected: 'widget', reason: 'confirm it is the same item' }),
      JSON.stringify({ action: 'request', method: 'DELETE', url: server.url + '/items/{{itemId}}', reason: 'clean up' }),
      // A real assertion after the delete, not just the delete itself —
      // the delete is a write that happens after the last succeeded
      // assertion (the read-back one above), so it must be freshly
      // verified before a "confirm..." goal is allowed to declare done.
      // See runner.ts/apiRunner.ts's hasSucceededAssertion reset.
      JSON.stringify({ action: 'assert_status', expected: 204, reason: 'confirm the delete actually succeeded' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'confirmed create/read/delete works' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'create an item, confirm it can be read back, then delete it',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true, allowDeletes: true }),
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.steps.length, 6)
    assert.equal(run.steps[0].responseStatus, 201)
    assert.equal(run.steps[2].responseStatus, 200)
    assert.equal(run.steps[4].responseStatus, 204)
    assert.ok(run.steps.every((s) => s.ok))
  } finally {
    await server.close()
  }
})

test('runApiTest rejects a done claim once a further write has happened since the last succeeded assertion, then accepts it once freshly re-verified', async () => {
  // Mirrors runner.ts's identical test — see its own doc comment for the
  // real, live-found bug this closes.
  const server = await startApiTestServer()
  try {
    const create = await fetch(server.url + '/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget' }),
    })
    const { id } = (await create.json()) as { id: number }

    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: `${server.url}/items/${id}`, reason: 'read it' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm it exists' }),
      // A further write after the assertion above — the reset must fire
      // here, before the next turn's done attempt.
      JSON.stringify({ action: 'request', method: 'PUT', url: `${server.url}/items/${id}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'renamed' }), reason: 'update it' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'trust me, it existed earlier' }),
      // Only reached if the done attempt above was correctly rejected.
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 're-confirm after the update' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'freshly re-verified' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'read the item, confirm it exists, then rename it',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true }),
      maxSteps: 10,
    })

    assert.equal(run.outcome, 'goal-reached')
    // done itself is never pushed to `steps` (accepted or rejected) — only
    // real request/assertion actions are. If the first done attempt had
    // been wrongly accepted, the run would have ended after only 3 steps
    // (GET, assert, PUT); reaching 4 proves the rejection forced a real
    // extra re-assertion before a second done was accepted.
    assert.equal(run.steps.length, 4)
  } finally {
    await server.close()
  }
})

test('runApiTest requires a fresh assertion for EACH confirm-clause in a compound goal, not just one for the whole run', async () => {
  // Mirrors runner.ts's identical test — see countConfirmationClauses' own
  // doc comment for the real, live-found bug this closes (a compound goal
  // skipping an earlier confirm-clause entirely, satisfied by one fresh
  // assertion covering only the last clause).
  const server = await startApiTestServer()
  try {
    const create = await fetch(server.url + '/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget' }),
    })
    const { id } = (await create.json()) as { id: number }

    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: `${server.url}/items/${id}`, reason: 'read it' }),
      // Only ONE fresh assertion before the first done attempt — the goal
      // below asks for two.
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm it exists' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'trust me, one check is enough' }),
      // Only reached if the done attempt above was correctly rejected.
      JSON.stringify({ action: 'request', method: 'PUT', url: `${server.url}/items/${id}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'renamed' }), reason: 'update it' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm the update succeeded' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'both things confirmed now' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'confirm the item exists, then update it, and confirm the update succeeded',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true }),
      maxSteps: 10,
    })

    assert.equal(run.outcome, 'goal-reached')
    // Real steps only (done is never pushed): GET, assert, PUT, assert = 4.
    // If the first done attempt (only 1 of 2 required confirmations) had
    // been wrongly accepted, the run would have ended after only 2 steps.
    assert.equal(run.steps.length, 4)
  } finally {
    await server.close()
  }
})

test('runApiTest blocks a write by default without ending the run, recording it as a failed non-fatal step', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'POST', url: server.url + '/items', body: '{}', reason: 'try to write' }),
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'fall back to reading' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'try to create an item',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.steps[0].ok, false)
    assert.match(run.steps[0].failureDetail ?? '', /not allowed this run/)
    assert.equal(run.steps[1].ok, true)
  } finally {
    await server.close()
  }
})

test('runApiTest with --allow-writes still blocks DELETE without --allow-deletes', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'DELETE', url: server.url + '/items/1', reason: 'try to delete' }),
      JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'delete not allowed' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'delete item 1',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true }),
    })

    assert.equal(run.steps[0].ok, false)
    assert.match(run.steps[0].failureDetail ?? '', /not allowed this run/)
    assert.equal(run.outcome, 'goal-unreachable')
  } finally {
    await server.close()
  }
})

test('runApiTest blocks a request to a host outside the target origin and allowlist', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: 'http://evil.example.com/steal', reason: 'wander off' }),
      JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'blocked' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'fetch something off-target',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.steps[0].ok, false)
    assert.match(run.steps[0].failureDetail ?? '', /not the target origin/)
  } finally {
    await server.close()
  }
})

test('runApiTest rejects an unresolved {{var}} reference at parse time, recorded as a failed step, not sent literally', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items/{{typo}}', reason: 'reference an unsaved var' }),
      JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'gave up' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'read an item by a saved id',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.steps[0].ok, false)
    assert.match(run.steps[0].failureDetail ?? '', /typo.*hasn't been saved/)
  } finally {
    await server.close()
  }
})

test('runApiTest ends the run with assertion-failed on a real failing assertion', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_status', expected: 999, reason: 'deliberately wrong expectation' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'confirm the items endpoint returns 999',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'assertion-failed')
  } finally {
    await server.close()
  }
})

test('runApiTest detects a stuck-repeating agent issuing the same action twice in a row', async () => {
  const server = await startApiTestServer()
  try {
    const repeated = JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/does-not-exist', reason: 'keep trying' })
    const provider = scriptedProvider([repeated, repeated])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'find a page that does not exist',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'stuck-repeating')
  } finally {
    await server.close()
  }
})

test('runApiTest allows a goal that legitimately requires the same successful write several times in a row, without tripping stuck-repeating', async () => {
  // Regression test mirroring runner.ts's identical fix, found via the
  // same live-testing pattern: a goal like "create 3 widgets" needs three
  // *identical* POST requests (same method/url/body — apiTestServer.ts's
  // real POST /items handler assigns a new auto-incrementing id to each
  // one regardless), which must not trip the repeat guard just because the
  // request text is identical each time — each one is real, distinct
  // forward progress (a genuinely new resource created).
  const server = await startApiTestServer()
  try {
    const create = JSON.stringify({
      action: 'request',
      method: 'POST',
      url: server.url + '/items',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"widget"}',
      reason: 'create a widget',
    })
    const provider = scriptedProvider([
      create,
      create,
      create,
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list them' }),
      JSON.stringify({ action: 'assert_json_path_exists', path: 'items[2]', reason: 'confirm all 3 exist' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'create 3 widgets, then confirm all 3 exist',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true }),
    })

    assert.equal(run.outcome, 'goal-reached')
    const createSteps = run.steps.filter((s) => s.action.action === 'request' && s.action.method === 'POST')
    assert.equal(createSteps.length, 3, `expected all 3 identical creates to succeed, got: ${JSON.stringify(run.steps.map((s) => [s.action.action, s.ok, s.responseStatus]))}`)
    assert.ok(createSteps.every((s) => s.ok && s.responseStatus === 201))
  } finally {
    await server.close()
  }
})

test('runApiTest still stops with stuck-repeating if a write repeats and keeps genuinely failing, not just succeeding', async () => {
  // The other half of the fix: only a repeated write that keeps
  // *succeeding* is exempted. A repeated write that keeps failing must
  // still trip the guard, same as before this fix. Deliberately a real
  // execution-level failure (a closed local port — a genuine connection
  // failure), not a safety-mode block: a blocked write is rejected at
  // parse time (`parseApiAction`'s `recoverable` path) before ever
  // reaching this repeat-detection logic at all, so it wouldn't actually
  // exercise this specific guard.
  const unreachable = safetyMode('http://localhost:1', { allowWrites: true })
  const write = JSON.stringify({ action: 'request', method: 'POST', url: 'http://localhost:1/items', body: '{}', reason: 'try to write' })
  const provider = scriptedProvider([write, write, write])

  const run = await runApiTest({
    baseUrl: 'http://localhost:1',
    goal: 'create a widget',
    provider,
    apiKey: 'fake-key',
    safety: unreachable,
  })

  assert.equal(run.outcome, 'stuck-repeating')
  assert.ok(run.steps.every((s) => !s.ok))
})

test('runApiTest rejects a goal-reached claim on a confirmation-requiring goal until a real assertion has succeeded', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'premature claim' }),
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'actually check' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'confirm it worked' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'now verified' }),
    ])

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'confirm the items endpoint is reachable',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'goal-reached')
    // The premature "done" was rejected and not counted as an executed step.
    assert.equal(run.steps.length, 2)
  } finally {
    await server.close()
  }
})

test('runApiTest calls onWrite in real time for an allowed non-safe-method request, and never for a safe one', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'read first' }),
      JSON.stringify({ action: 'request', method: 'POST', url: server.url + '/items', body: '{"name":"gadget"}', reason: 'create it' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])

    const writes: { method: string; url: string; reason: string }[] = []
    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'create a gadget',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true }),
      onWrite: (method, url, reason) => writes.push({ method, url, reason }),
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.equal(writes[0].reason, 'create it')
  } finally {
    await server.close()
  }
})

test('runApiTest trips stuck-repeating when an indecisive model alternates assertion types on the same still-unchecked path, instead of ever declaring done', async () => {
  // The API-engine analog of a real, live-found browser-engine gap: an
  // indecisive model alternating assert_json_path_exists/assert_json_path_equals
  // on the *same* path never produces two identical consecutive
  // actionSignatures, so it evades the ordinary signature-repeat guard.
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_json_path_exists', path: 'items', reason: 'check items exists' }),
      JSON.stringify({ action: 'assert_json_path_equals', path: 'items', expected: '[]', reason: 'check items value' }),
      JSON.stringify({ action: 'assert_json_path_exists', path: 'items', reason: 'check items exists again' }),
    ])
    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items',
      provider,
      apiKey: 'fake-key',
      maxSteps: 10,
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'stuck-repeating')
    assert.ok(run.steps.length < 10, 'must trip well before exhausting the step budget')
  } finally {
    await server.close()
  }
})

test('runApiTest allows checking two different things (status, then a path) in a row without tripping — a normal multi-property verification', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_status', expected: 200, reason: 'check status' }),
      JSON.stringify({ action: 'assert_json_path_exists', path: 'items', reason: 'check items exists' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])
    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'goal-reached')
  } finally {
    await server.close()
  }
})

test('runApiTest allows exactly two checks of the same path (exists, then equals) — a normal verify pattern — without tripping', async () => {
  const server = await startApiTestServer()
  try {
    const provider = scriptedProvider([
      JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' }),
      JSON.stringify({ action: 'assert_json_path_exists', path: 'items', reason: 'check items exists' }),
      JSON.stringify({ action: 'assert_json_path_equals', path: 'items', expected: '[]', reason: 'check items value' }),
      JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }),
    ])
    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'goal-reached')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan fast-paths a whole well-formed plan, making zero live per-step calls', async () => {
  const server = await startApiTestServer()
  try {
    let calls = 0
    let capturedOptions: { maxOutputTokens?: number; fastPath?: boolean } | undefined
    const provider: LlmProvider = {
      id: 'fake',
      async complete(_prompt, _apiKey, options) {
        calls++
        capturedOptions = options
        // The one upfront planning call — a request whose method/host are
        // both allowed, followed by an assert_status that only fast-paths
        // because it immediately follows a real successful request, then a
        // deterministic done. None of these three should need a live call.
        return JSON.stringify({
          steps: [
            { action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' },
            { action: 'assert_status', expected: 200, reason: 'confirm ok' },
            { action: 'done', outcome: 'goal-reached', reason: 'confirmed' },
          ],
        })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items and confirm the request succeeded',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
      useStructuredPlan: true,
      useFastSteps: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.steps.length, 2)
    assert.equal(run.planStats?.plannedSteps, 3)
    assert.equal(run.planStats?.fastPathedSteps, 3, 'request, assertion (after a successful request), and done should all fast-path')
    assert.equal(calls, 1, 'only the upfront planning call — zero live per-step decisions')
    assert.equal(capturedOptions?.maxOutputTokens, PLAN_MAX_OUTPUT_TOKENS, 'the upfront plan call must be bounded by PLAN_MAX_OUTPUT_TOKENS')
    assert.notEqual(capturedOptions?.fastPath, true, 'the upfront plan call must never set fastPath, even with useFastSteps on')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan still blocks a fast-pathed DELETE by default, never executing it for real', async () => {
  // The single most important regression test in this whole feature's
  // API-engine half: the fast path deliberately skips parseApiAction
  // entirely (that's the efficiency win), which is exactly the function
  // that normally enforces isMethodAllowed/isHostAllowed (SafetyMode)
  // gating — without an explicit, independent copy of that same check at
  // the fast path's own execution site, a planned DELETE could fire for
  // real with zero gating even at default (read-only) safety settings.
  const server = await startApiTestServer()
  try {
    const create = await fetch(server.url + '/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget' }),
    })
    const { id } = (await create.json()) as { id: string }

    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        return JSON.stringify({ steps: [{ action: 'request', method: 'DELETE', url: `${server.url}/items/${id}`, reason: 'delete it' }] })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'delete the item',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url), // default: no writes, no deletes
      useStructuredPlan: true,
      maxSteps: 2,
    })

    assert.notEqual(run.outcome, 'goal-reached')
    assert.ok(run.steps.length > 0)
    assert.ok(run.steps.every((s) => !s.ok), 'a fast-pathed disallowed DELETE must never be recorded as a successful step')
    assert.ok(run.steps.every((s) => s.failureDetail?.includes('not allowed this run')))

    // Prove it was never actually sent — the item must still exist.
    const check = await fetch(`${server.url}/items/${id}`)
    assert.equal(check.status, 200, 'the item must still exist — the blocked DELETE must never have reached the real server')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan blocks a fast-pathed POST carrying an X-HTTP-Method-Override: DELETE header, even with allowWrites (but not allowDeletes) set', async () => {
  // Real, live-found gap: a model blocked from DELETE tried exactly this
  // technique against a real live target this session — see apiTypes.ts's
  // effectiveMethod doc comment. Proves the fast path's own re-check
  // (apiRunner.ts) catches it too, not just parseApiAction's live-decision
  // path — the same "no single point of failure" posture the DELETE test
  // above already established for the literal-method case.
  const server = await startApiTestServer()
  try {
    const create = await fetch(server.url + '/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget' }),
    })
    const { id } = (await create.json()) as { id: string }

    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        return JSON.stringify({
          steps: [{ action: 'request', method: 'POST', url: `${server.url}/items/${id}`, headers: { 'X-HTTP-Method-Override': 'DELETE' }, reason: 'delete it via a method override' }],
        })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'delete the item',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url, { allowWrites: true }), // writes allowed, deletes NOT allowed
      useStructuredPlan: true,
      maxSteps: 2,
    })

    assert.notEqual(run.outcome, 'goal-reached')
    assert.ok(run.steps.every((s) => !s.ok), 'a fast-pathed method-override DELETE must never be recorded as a successful step')
    assert.ok(run.steps.every((s) => s.failureDetail?.includes('effectively DELETE via a method-override')))

    // Prove it was never actually sent — the item must still exist.
    const check = await fetch(`${server.url}/items/${id}`)
    assert.equal(check.status, 200, 'the item must still exist — the blocked override must never have reached the real server')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan does not fast-path an assertion immediately after a failed planned request', async () => {
  const server = await startApiTestServer()
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) {
          // A write blocked by default safety, immediately followed by a
          // planned assertion — the assertion must NOT fast-path against
          // whatever lastResponse happened to hold before: it must go live.
          return JSON.stringify({
            steps: [
              { action: 'request', method: 'POST', url: server.url + '/items', body: '{}', reason: 'blocked write' },
              { action: 'assert_status', expected: 201, reason: 'would be wrong to fast-path this' },
              { action: 'done', outcome: 'goal-unreachable', reason: 'could not write' },
            ],
          })
        }
        // The live decision for the assertion step.
        return JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'could not write' })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'create an item',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
      useStructuredPlan: true,
    })

    assert.equal(run.planStats?.fastPathedSteps, 0, 'the blocked request is not a fast-path execution, and the assertion after it must not fast-path either')
    assert.equal(turn, 2, 'plan + one live decision for the step after the blocked request')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan falls back to a live decision when a planned request references an unresolved {{var}}', async () => {
  const server = await startApiTestServer()
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) {
          return JSON.stringify({
            steps: [{ action: 'request', method: 'GET', url: server.url + '/items/{{neverSaved}}', reason: 'references a var nothing saved' }],
          })
        }
        return JSON.stringify({ action: 'done', outcome: 'goal-unreachable', reason: 'gave up' })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'fetch a nonexistent saved item',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
      useStructuredPlan: true,
    })

    assert.equal(run.planStats?.fastPathedSteps, 0)
    assert.equal(turn, 2, 'plan + live fallback for the unresolvable step')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan degrades silently to the full adaptive loop when the plan response itself is malformed', async () => {
  const server = await startApiTestServer()
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) return 'not valid json at all'
        if (turn === 2) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
      useStructuredPlan: true,
    })

    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.planStats, undefined, 'no plan was ever actually adopted, so there is nothing to disclose')
  } finally {
    await server.close()
  }
})

test('runApiTest with useStructuredPlan degrades to the full adaptive loop when the plan gives up immediately, letting the model actually try instead of assuming', async () => {
  // Real, live-repeated failure this fixes: a CRUD goal against a
  // well-known fake API produced a plan whose only step was an immediate
  // {"action":"done","outcome":"goal-unreachable"} — zero real requests
  // ever attempted. See parseApiPlan's own doc comment.
  const server = await startApiTestServer()
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) return JSON.stringify({ steps: [{ action: 'done', outcome: 'goal-unreachable', reason: 'assumed this API does not support it' }] })
        if (turn === 2) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        return JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' })
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
      useStructuredPlan: true,
    })

    // The real point of this fix: a real request was actually attempted,
    // rather than the run ending on the plan's own premature claim.
    assert.equal(run.outcome, 'goal-reached')
    assert.equal(run.planStats, undefined, 'the degenerate plan was rejected, so nothing was ever adopted to disclose')
    assert.equal(run.steps.length, 1)
  } finally {
    await server.close()
  }
})

test('runApiTest returns a real, honest outcome with prior steps preserved when the LLM provider itself throws mid-run, instead of the run silently vanishing', async () => {
  // Mirrors runner.ts's identical fix — see its own test's doc comment for
  // the real, live-found gap this closes (a sustained Gemini 503 patch
  // previously propagated uncaught out of runApiTest, discarding every
  // step already completed).
  const server = await startApiTestServer()
  try {
    let turn = 0
    const provider: LlmProvider = {
      id: 'fake',
      async complete() {
        turn++
        if (turn === 1) return JSON.stringify({ action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' })
        throw new Error('Gemini API request failed: 503 Service Unavailable')
      },
    }

    const run = await runApiTest({
      baseUrl: server.url,
      goal: 'list items',
      provider,
      apiKey: 'fake-key',
      safety: safetyMode(server.url),
    })

    assert.equal(run.outcome, 'provider-unavailable')
    assert.equal(run.providerError, 'Gemini API request failed: 503 Service Unavailable')
    assert.equal(run.steps.length, 1, 'the one real step completed before the throw must be preserved, not discarded')
    assert.equal(run.steps[0].ok, true)
  } finally {
    await server.close()
  }
})
