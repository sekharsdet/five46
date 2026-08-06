import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePlaceholders, extractPlaceholderNames, executeApiAction, CookieJar } from './apiExecutor'
import type { SafetyMode } from './apiTypes'
import { startApiTestServer, API_FIXTURE_USERNAME, API_FIXTURE_PASSWORD } from './apiTestServer'

test('resolvePlaceholders substitutes a known var and leaves an unknown one as literal text, never throwing', () => {
  const vars = new Map([['userId', '42']])
  assert.equal(resolvePlaceholders('/users/{{userId}}', vars), '/users/42')
  assert.equal(resolvePlaceholders('/users/{{unknown}}', vars), '/users/{{unknown}}')
  assert.equal(resolvePlaceholders('no vars here', vars), 'no vars here')
})

test('resolvePlaceholders handles multiple distinct vars in one string', () => {
  const vars = new Map([
    ['a', '1'],
    ['b', '2'],
  ])
  assert.equal(resolvePlaceholders('{{a}}-{{b}}-{{a}}', vars), '1-2-1')
})

test('extractPlaceholderNames finds every distinct reference in a string', () => {
  assert.deepEqual(extractPlaceholderNames('/users/{{userId}}/posts/{{postId}}'), ['userId', 'postId'])
  assert.deepEqual(extractPlaceholderNames('no vars'), [])
})

test('CookieJar round-trips a real Set-Cookie response and scopes it per origin', async (t) => {
  const server = await startApiTestServer()
  try {
    const jar = new CookieJar()
    const origin = new URL(server.url).origin

    const loginRes = await fetch(server.url + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: API_FIXTURE_USERNAME, password: API_FIXTURE_PASSWORD }),
    })
    jar.applyResponse(origin, loginRes)

    const cookieHeader = jar.cookieHeaderFor(origin)
    assert.ok(cookieHeader && cookieHeader.includes('five46_api_session='))
    assert.equal(jar.cookieHeaderFor('http://a-different-origin.example.com'), undefined, 'must not leak to a different origin')

    // Confirm the captured cookie actually authenticates a follow-up request.
    const whoami = await fetch(server.url + '/whoami', { headers: { Cookie: cookieHeader! } })
    assert.deepEqual(await whoami.json(), { authenticated: true })
  } finally {
    await server.close()
  }
})

function safetyMode(overrides: Partial<SafetyMode> = {}): SafetyMode {
  return { allowWrites: false, allowDeletes: false, targetOrigin: 'http://localhost:1', allowedHosts: new Set(), baseUrl: 'http://localhost:1', ...overrides }
}

test('executeApiAction performs a real request and returns the real response', async () => {
  const server = await startApiTestServer()
  try {
    const context = { cookieJar: new CookieJar(), safety: safetyMode({ targetOrigin: new URL(server.url).origin }), vars: new Map<string, string>() }
    const result = await executeApiAction(
      { action: 'request', method: 'GET', url: server.url + '/items', reason: 'list items' },
      context,
      undefined
    )
    assert.equal(result.ok, true)
    assert.equal(result.responseStatus, 200)
    assert.ok(result.response)
  } finally {
    await server.close()
  }
})

test('executeApiAction extracts and saves a real value from a response via saveAs, for a later request to reference', async () => {
  const server = await startApiTestServer()
  try {
    const context = { cookieJar: new CookieJar(), safety: safetyMode({ targetOrigin: new URL(server.url).origin }), vars: new Map<string, string>() }
    const created = await executeApiAction(
      {
        action: 'request',
        method: 'POST',
        url: server.url + '/items',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'widget' }),
        saveAs: { name: 'itemId', path: 'id' },
        reason: 'create an item',
      },
      context,
      undefined
    )
    assert.equal(created.ok, true)
    assert.equal(created.responseStatus, 201)
    assert.ok(created.savedVar)
    assert.equal(created.savedVar!.name, 'itemId')

    const vars = new Map([[created.savedVar!.name, created.savedVar!.value]])
    const read = await executeApiAction(
      { action: 'request', method: 'GET', url: server.url + '/items/{{itemId}}', reason: 'read it back' },
      { ...context, vars },
      undefined
    )
    assert.equal(read.ok, true)
    assert.equal(read.responseStatus, 200)
    assert.equal(read.response!.parsedJson && (read.response!.parsedJson as { name: string }).name, 'widget')
  } finally {
    await server.close()
  }
})

test('executeApiAction assert_status/assert_json_path_exists/assert_json_path_equals check the real last response', async () => {
  const server = await startApiTestServer()
  try {
    const context = { cookieJar: new CookieJar(), safety: safetyMode({ targetOrigin: new URL(server.url).origin }), vars: new Map<string, string>() }
    const created = await executeApiAction(
      { action: 'request', method: 'POST', url: server.url + '/items', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'widget' }), reason: 'create' },
      context,
      undefined
    )
    const lastResponse = created.response!

    const statusOk = await executeApiAction({ action: 'assert_status', expected: 201, reason: 'check' }, context, lastResponse)
    assert.equal(statusOk.ok, true)
    const statusFail = await executeApiAction({ action: 'assert_status', expected: 200, reason: 'check' }, context, lastResponse)
    assert.equal(statusFail.ok, false)

    const existsOk = await executeApiAction({ action: 'assert_json_path_exists', path: 'id', reason: 'check' }, context, lastResponse)
    assert.equal(existsOk.ok, true)
    const existsFail = await executeApiAction({ action: 'assert_json_path_exists', path: 'nonexistent', reason: 'check' }, context, lastResponse)
    assert.equal(existsFail.ok, false)

    const equalsOk = await executeApiAction({ action: 'assert_json_path_equals', path: 'name', expected: 'widget', reason: 'check' }, context, lastResponse)
    assert.equal(equalsOk.ok, true)
    const equalsFail = await executeApiAction({ action: 'assert_json_path_equals', path: 'name', expected: 'wrong', reason: 'check' }, context, lastResponse)
    assert.equal(equalsFail.ok, false)
  } finally {
    await server.close()
  }
})

test('executeApiAction blocks a request that redirects to a disallowed cross-origin host, never actually following it', async () => {
  // Regression test: fetch's default redirect:'follow' would silently
  // defeat a same-origin-only check if it only inspected the *request*
  // URL, since a same-origin request can 302 to a different host.
  const server = await startApiTestServer()
  try {
    const context = { cookieJar: new CookieJar(), safety: safetyMode({ targetOrigin: new URL(server.url).origin }), vars: new Map<string, string>() }
    const result = await executeApiAction(
      { action: 'request', method: 'GET', url: server.url + '/redirect-cross-origin', reason: 'try to escape' },
      context,
      undefined
    )
    assert.equal(result.ok, false)
    assert.ok(result.failureDetail?.includes('not the target origin'))
  } finally {
    await server.close()
  }
})

test('executeApiAction follows a same-origin redirect successfully', async () => {
  const server = await startApiTestServer()
  try {
    const context = { cookieJar: new CookieJar(), safety: safetyMode({ targetOrigin: new URL(server.url).origin }), vars: new Map<string, string>() }
    const result = await executeApiAction(
      { action: 'request', method: 'GET', url: server.url + '/redirect-same-origin', reason: 'follow it' },
      context,
      undefined
    )
    assert.equal(result.ok, true)
    assert.equal(result.responseStatus, 200)
  } finally {
    await server.close()
  }
})

test('executeApiAction silently attaches a configured auth header, without the action itself ever referencing it', async () => {
  const server = await startApiTestServer()
  try {
    const context = {
      cookieJar: new CookieJar(),
      authHeaders: { Authorization: 'Bearer real-secret-token' },
      safety: safetyMode({ targetOrigin: new URL(server.url).origin }),
      vars: new Map<string, string>(),
    }
    const result = await executeApiAction({ action: 'request', method: 'GET', url: server.url + '/echo-headers', reason: 'check headers' }, context, undefined)
    assert.equal(result.ok, true)
    const echoed = result.response!.parsedJson as { headers: Record<string, string> }
    assert.equal(echoed.headers.authorization, 'Bearer real-secret-token')
  } finally {
    await server.close()
  }
})

test('executeApiAction never attaches a configured auth header to an allowlisted host that is not the target origin', async () => {
  const server = await startApiTestServer()
  try {
    const targetHostname = new URL(server.url).hostname
    const context = {
      cookieJar: new CookieJar(),
      authHeaders: { Authorization: 'Bearer real-secret-token' },
      // targetOrigin deliberately points elsewhere; the real server is
      // reachable only via the --allow-host mechanism (allowedHosts), the
      // same shape as a secondary host a run was allowed to reach.
      safety: safetyMode({ targetOrigin: 'http://localhost:1', allowedHosts: new Set([targetHostname]) }),
      vars: new Map<string, string>(),
    }
    const result = await executeApiAction({ action: 'request', method: 'GET', url: server.url + '/echo-headers', reason: 'check headers' }, context, undefined)
    assert.equal(result.ok, true)
    const echoed = result.response!.parsedJson as { headers: Record<string, string> }
    assert.equal(echoed.headers.authorization, undefined, 'must not leak the target-origin auth header to an allowlisted secondary host')
  } finally {
    await server.close()
  }
})

test('executeApiAction times out and fails honestly against a server that never responds, rather than hanging forever', async () => {
  const server = await startApiTestServer()
  try {
    const context = { cookieJar: new CookieJar(), safety: safetyMode({ targetOrigin: new URL(server.url).origin }), vars: new Map<string, string>() }
    const started = Date.now()
    const result = await executeApiAction({ action: 'request', method: 'GET', url: server.url + '/slow', reason: 'this will never respond' }, context, undefined)
    const elapsedMs = Date.now() - started
    assert.equal(result.ok, false)
    assert.ok(result.failureDetail, 'must fail with an honest detail, not a silent hang')
    // REQUEST_TIMEOUT_MS is 5000 — asserting a generous window either side
    // rather than the exact constant, which apiExecutor.ts doesn't export.
    assert.ok(elapsedMs < 9000, `expected to fail well before 9s, took ${elapsedMs}ms`)
  } finally {
    await server.close()
  }
})
