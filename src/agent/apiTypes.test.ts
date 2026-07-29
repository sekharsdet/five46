import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMethodAllowed, isHostAllowed } from './apiTypes'
import type { SafetyMode } from './apiTypes'

const READ_ONLY: SafetyMode = { allowWrites: false, allowDeletes: false, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }
const WRITES_ONLY: SafetyMode = { allowWrites: true, allowDeletes: false, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }
const WRITES_AND_DELETES: SafetyMode = { allowWrites: true, allowDeletes: true, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }

test('isMethodAllowed always allows GET/HEAD/OPTIONS regardless of safety mode', () => {
  for (const mode of [READ_ONLY, WRITES_ONLY, WRITES_AND_DELETES]) {
    assert.equal(isMethodAllowed('GET', mode), true)
    assert.equal(isMethodAllowed('HEAD', mode), true)
    assert.equal(isMethodAllowed('OPTIONS', mode), true)
  }
})

test('isMethodAllowed blocks POST/PUT/PATCH unless allowWrites is set, independent of allowDeletes', () => {
  assert.equal(isMethodAllowed('POST', READ_ONLY), false)
  assert.equal(isMethodAllowed('PUT', READ_ONLY), false)
  assert.equal(isMethodAllowed('PATCH', READ_ONLY), false)
  assert.equal(isMethodAllowed('POST', WRITES_ONLY), true)
  assert.equal(isMethodAllowed('PUT', WRITES_ONLY), true)
  assert.equal(isMethodAllowed('PATCH', WRITES_ONLY), true)
})

test('isMethodAllowed blocks DELETE unless allowDeletes is set, independent of allowWrites', () => {
  // The core safety design invariant: allowWrites alone must NOT unlock
  // DELETE — the two flags are deliberately independent, not one coarse
  // switch, since DELETE is often unrecoverable in a way POST/PUT/PATCH
  // usually aren't.
  assert.equal(isMethodAllowed('DELETE', READ_ONLY), false)
  assert.equal(isMethodAllowed('DELETE', WRITES_ONLY), false, 'allowWrites alone must not unlock DELETE')
  assert.equal(isMethodAllowed('DELETE', WRITES_AND_DELETES), true)
})

test('isHostAllowed allows the target origin itself', () => {
  assert.equal(isHostAllowed('http://localhost:1/anything', READ_ONLY), true)
})

test('isHostAllowed blocks a different origin by default', () => {
  assert.equal(isHostAllowed('http://evil.example.com/', READ_ONLY), false)
})

test('isHostAllowed allows an explicitly allowlisted host, still blocks everything else', () => {
  const mode: SafetyMode = { ...READ_ONLY, allowedHosts: new Set(['auth.example.com']) }
  assert.equal(isHostAllowed('https://auth.example.com/token', mode), true)
  assert.equal(isHostAllowed('https://not-allowlisted.example.com/', mode), false)
})

test('isHostAllowed fails closed (not allowed) on a malformed URL rather than throwing', () => {
  assert.equal(isHostAllowed('not a url', READ_ONLY), false)
})
