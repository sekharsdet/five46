import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialEnvFor } from './run'

test('credentialEnvFor maps LoginCredentials onto the env vars a generated spec\'s credential placeholders read from', () => {
  assert.deepEqual(credentialEnvFor({ username: 'alice', password: 'secret' }), {
    FIVE46_LOGIN_USERNAME: 'alice',
    FIVE46_LOGIN_PASSWORD: 'secret',
  })
  assert.deepEqual(credentialEnvFor({ username: 'alice' }), { FIVE46_LOGIN_USERNAME: 'alice' })
  assert.equal(credentialEnvFor(undefined), undefined)
})
