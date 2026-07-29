import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from './redact'

test('redactSecrets replaces every occurrence of a real secret value with a placeholder', () => {
  const text = 'logging in as admin, admin was rejected, retrying as admin'
  assert.equal(redactSecrets(text, ['admin']), 'logging in as ***REDACTED***, ***REDACTED*** was rejected, retrying as ***REDACTED***')
})

test('redactSecrets handles multiple distinct secrets in the same text', () => {
  const text = 'user=ada pass=hunter2'
  assert.equal(redactSecrets(text, ['ada', 'hunter2']), 'user=***REDACTED*** pass=***REDACTED***')
})

test('redactSecrets ignores undefined/empty secrets rather than replacing empty strings everywhere', () => {
  const text = 'nothing to redact here'
  assert.equal(redactSecrets(text, [undefined, '']), text)
})

test('redactSecrets leaves text with no matching secret completely unchanged', () => {
  assert.equal(redactSecrets('plain text', ['something-else']), 'plain text')
})
