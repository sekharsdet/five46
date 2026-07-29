import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { generateApiSpec } from './generateApiSpec'
import type { ApiTestRun } from './apiTypes'
import { startApiTestServer } from './apiTestServer'

const execFileAsync = promisify(execFile)

function baseRun(overrides: Partial<ApiTestRun> = {}): ApiTestRun {
  return { runId: 'run1', baseUrl: 'http://localhost:1', goal: 'test goal', steps: [], outcome: 'goal-reached', ...overrides }
}

test('generateApiSpec re-derives a chained saveAs value as real JS, never freezing this run\'s resolved literal', () => {
  const run = baseRun({
    steps: [
      {
        step: 1,
        action: {
          action: 'request',
          method: 'POST',
          url: 'http://localhost:1/items',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"widget"}',
          saveAs: { name: 'itemId', path: 'id' },
          reason: 'create',
        },
        ok: true,
        responseStatus: 201,
      },
      {
        step: 2,
        // The unresolved, symbolic {{itemId}} reference — never this run's
        // real resolved value (e.g. "42").
        action: { action: 'request', method: 'GET', url: 'http://localhost:1/items/{{itemId}}', reason: 'read it back' },
        ok: true,
        responseStatus: 200,
      },
    ],
  })

  const spec = generateApiSpec(run)

  // The chained value must be re-derived from the real response at
  // runtime, never hardcoded as a literal id from this specific run.
  assert.ok(spec.includes('const itemId = res1Json?.["id"]'), spec)
  assert.ok(spec.includes('await fetch(`http://localhost:1/items/${itemId}`'), spec)
  assert.ok(!spec.match(/items\/\d+["'`]/), 'must never contain a hardcoded resolved id like items/42')
})

test('generateApiSpec only includes successfully-executed steps', () => {
  const run = baseRun({
    outcome: 'assertion-failed',
    steps: [
      { step: 1, action: { action: 'request', method: 'GET', url: 'http://localhost:1/items', reason: 'list' }, ok: true, responseStatus: 200 },
      { step: 2, action: { action: 'assert_status', expected: 999, reason: 'deliberately wrong' }, ok: false, failureDetail: 'expected 999, got 200' },
    ],
  })

  const spec = generateApiSpec(run)
  assert.ok(spec.includes('fetch("http://localhost:1/items"'), spec)
  assert.ok(!spec.includes('999'))
  assert.ok(spec.includes('outcome: assertion-failed'))
})

test('generateApiSpec renders assert_json_path_equals via the string-coercion helper, only when needed', () => {
  const withEquals = generateApiSpec(
    baseRun({
      steps: [
        { step: 1, action: { action: 'request', method: 'GET', url: 'http://localhost:1/items/1', reason: 'read' }, ok: true, responseStatus: 200 },
        { step: 2, action: { action: 'assert_json_path_equals', path: 'name', expected: 'widget', reason: 'check' }, ok: true },
      ],
    })
  )
  assert.ok(withEquals.includes('function jsonValueToString'))
  assert.ok(withEquals.includes('assert.equal(jsonValueToString(res1Json?.["name"]), "widget")'))

  const withoutEquals = generateApiSpec(baseRun({ steps: [{ step: 1, action: { action: 'request', method: 'GET', url: 'http://localhost:1/items', reason: 'list' }, ok: true, responseStatus: 200 }] }))
  assert.ok(!withoutEquals.includes('function jsonValueToString'))
})

test('generateApiSpec writes a real, standalone script that actually runs and passes against a real server', async (t) => {
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'five46-apispec-test-'))
  try {
    const run = baseRun({
      baseUrl: server.url,
      goal: 'create an item then read it back',
      steps: [
        {
          step: 1,
          action: {
            action: 'request',
            method: 'POST',
            url: server.url + '/items',
            headers: { 'Content-Type': 'application/json' },
            body: '{"name":"widget"}',
            saveAs: { name: 'itemId', path: 'id' },
            reason: 'create',
          },
          ok: true,
          responseStatus: 201,
        },
        { step: 2, action: { action: 'assert_status', expected: 201, reason: 'confirm created' }, ok: true, responseStatus: 201 },
        { step: 3, action: { action: 'request', method: 'GET', url: server.url + '/items/{{itemId}}', reason: 'read it back' }, ok: true, responseStatus: 200 },
        { step: 4, action: { action: 'assert_json_path_equals', path: 'name', expected: 'widget', reason: 'confirm same item' }, ok: true },
      ],
    })

    const spec = generateApiSpec(run)
    const specPath = join(dir, 'generated.test.mjs')
    writeFileSync(specPath, spec, 'utf8')

    // NODE_TEST_CONTEXT is set by the outer `node --test` run driving this
    // very test file — inherited as-is, it makes Node's test runner treat
    // the generated script as a nested/recursive test run and silently skip
    // executing it (a real, standalone `five46 api` user's shell would
    // never have this var set). Stripped so this exercises the generated
    // script exactly as a real user would run it.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const { stdout } = await execFileAsync(process.execPath, ['--test', specPath], { env })
    assert.match(stdout, /pass 1/)
    assert.doesNotMatch(stdout, /fail [1-9]/)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
