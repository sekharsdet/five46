import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonPath, evaluateJsonPath, jsonValueToString } from './jsonPath'

test('parseJsonPath handles plain field, nested field, and array index, with or without a leading dot', () => {
  assert.deepEqual(parseJsonPath('id'), [{ kind: 'field', name: 'id' }])
  assert.deepEqual(parseJsonPath('.id'), [{ kind: 'field', name: 'id' }])
  assert.deepEqual(parseJsonPath('user.name'), [
    { kind: 'field', name: 'user' },
    { kind: 'field', name: 'name' },
  ])
  assert.deepEqual(parseJsonPath('items[0].id'), [
    { kind: 'field', name: 'items' },
    { kind: 'index', index: 0 },
    { kind: 'field', name: 'id' },
  ])
})

test('parseJsonPath strips a conventional leading "$" or "$." root marker, rather than treating it as a literal field name', () => {
  // Regression test: a real model (Llama 3.3 70B via Groq) wrote standard
  // JSONPath ("$.userId") by default. Without this, "$" parses as a
  // literal field, so the path silently never resolves.
  assert.deepEqual(parseJsonPath('$.userId'), [{ kind: 'field', name: 'userId' }])
  assert.deepEqual(parseJsonPath('$userId'), [{ kind: 'field', name: 'userId' }])
  assert.deepEqual(parseJsonPath('$[0].name'), [
    { kind: 'index', index: 0 },
    { kind: 'field', name: 'name' },
  ])
  assert.deepEqual(parseJsonPath('$'), [], 'bare "$" (the whole document) has no segments to walk')
})

test('evaluateJsonPath resolves a real value via a "$."-prefixed path exactly like the equivalent unprefixed one', () => {
  const value = { userId: 1, items: [{ id: 'a' }] }
  assert.equal(evaluateJsonPath(value, '$.userId'), 1)
  assert.equal(evaluateJsonPath(value, '$.items[0].id'), 'a')
})

test('evaluateJsonPath resolves a real nested/indexed value from a real object', () => {
  const value = { user: { name: 'Ada', addresses: [{ city: 'London' }, { city: 'Paris' }] } }
  assert.equal(evaluateJsonPath(value, 'user.name'), 'Ada')
  assert.equal(evaluateJsonPath(value, 'user.addresses[1].city'), 'Paris')
})

test('evaluateJsonPath returns undefined (never throws) for a path that does not resolve', () => {
  const value = { id: 1 }
  assert.equal(evaluateJsonPath(value, 'nonexistent'), undefined)
  assert.equal(evaluateJsonPath(value, 'id.nested'), undefined, 'indexing into a number must fail honestly, not throw')
  assert.equal(evaluateJsonPath(value, 'id[0]'), undefined, 'array-indexing a non-array must fail honestly')
  assert.equal(evaluateJsonPath({ items: [] }, 'items[5]'), undefined, 'out-of-range index must fail honestly')
  assert.equal(evaluateJsonPath(undefined, 'anything'), undefined)
  assert.equal(evaluateJsonPath(null, 'anything'), undefined)
})

test('jsonValueToString passes a string through unquoted but stringifies everything else', () => {
  assert.equal(jsonValueToString('hello'), 'hello')
  assert.equal(jsonValueToString(42), '42')
  assert.equal(jsonValueToString(true), 'true')
  assert.equal(jsonValueToString(null), 'null')
  assert.equal(jsonValueToString({ a: 1 }), '{"a":1}')
  assert.equal(jsonValueToString(undefined), undefined)
})
