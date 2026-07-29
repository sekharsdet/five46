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
