import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLoginCredentials, resolveApiAuthHeaders } from './credentials'

test('resolveLoginCredentials reads FIVE46_LOGIN_USERNAME/PASSWORD, undefined when unset', () => {
  assert.deepEqual(resolveLoginCredentials({}), { username: undefined, password: undefined })
  assert.deepEqual(resolveLoginCredentials({ FIVE46_LOGIN_USERNAME: 'alice', FIVE46_LOGIN_PASSWORD: 'hunter2' }), {
    username: 'alice',
    password: 'hunter2',
  })
})

test('resolveApiAuthHeaders returns undefined (not an empty object) when no value is configured', () => {
  assert.equal(resolveApiAuthHeaders({}), undefined)
  assert.equal(resolveApiAuthHeaders({ FIVE46_API_AUTH_HEADER_NAME: 'X-Api-Key' }), undefined)
})

test('resolveApiAuthHeaders defaults the header name to Authorization when only a value is set', () => {
  assert.deepEqual(resolveApiAuthHeaders({ FIVE46_API_AUTH_HEADER_VALUE: 'Bearer abc123' }), { Authorization: 'Bearer abc123' })
})

test('resolveApiAuthHeaders honors an explicit header name', () => {
  assert.deepEqual(resolveApiAuthHeaders({ FIVE46_API_AUTH_HEADER_NAME: 'X-Api-Key', FIVE46_API_AUTH_HEADER_VALUE: 'secret-key' }), {
    'X-Api-Key': 'secret-key',
  })
})
