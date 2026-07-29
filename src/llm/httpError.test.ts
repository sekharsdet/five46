import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeApiError } from './httpError'

function fakeResponse(status: number, statusText: string, bodyText: string): Response {
  return { status, statusText, text: async () => bodyText } as Response
}

test('describeApiError surfaces the real API error message, not just the bare HTTP status', async () => {
  // Regression test for a real, live-observed bug: a Gemini 429 reported as
  // just "429 Too Many Requests" hid the actual reason (RESOURCE_EXHAUSTED,
  // limit: 0 for this project/model — a permanent zero-quota situation, not
  // a transient rate limit) inside the response body, which was previously
  // discarded entirely.
  const body = JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric X, limit: 0. Please retry in 52s.' } })
  const msg = await describeApiError('Gemini', fakeResponse(429, 'Too Many Requests', body))
  assert.ok(msg.includes('429 Too Many Requests'))
  assert.ok(msg.includes('Quota exceeded for metric X, limit: 0'))
})

test('describeApiError falls back to the raw body text when the error shape is not { error: { message } }', async () => {
  const msg = await describeApiError('OpenAI', fakeResponse(500, 'Internal Server Error', 'upstream is down'))
  assert.ok(msg.includes('500 Internal Server Error'))
  assert.ok(msg.includes('upstream is down'))
})

test('describeApiError falls back to just the status when there is no body at all', async () => {
  const msg = await describeApiError('Anthropic', fakeResponse(401, 'Unauthorized', ''))
  assert.equal(msg, 'Anthropic API request failed: 401 Unauthorized')
})

test('describeApiError never throws, even if reading the body itself fails', async () => {
  const response = {
    status: 500,
    statusText: 'Internal Server Error',
    text: async () => {
      throw new Error('stream already consumed')
    },
  } as unknown as Response
  const msg = await describeApiError('Bedrock', response)
  assert.equal(msg, 'Bedrock API request failed: 500 Internal Server Error')
})
