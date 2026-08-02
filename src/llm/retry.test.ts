import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry, isRetryableLlmError } from './retry'
import { LlmHttpError } from './httpError'
import type { LlmProvider } from './types'

function fakeSleep(recorded: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    recorded.push(ms)
  }
}

test('isRetryableLlmError recognizes LlmHttpError with a 429 or 5xx status as retryable', () => {
  assert.equal(isRetryableLlmError(new LlmHttpError('rate limited', 429)), true)
  assert.equal(isRetryableLlmError(new LlmHttpError('server error', 500)), true)
  assert.equal(isRetryableLlmError(new LlmHttpError('unavailable', 503)), true)
})

test('isRetryableLlmError does not retry a non-transient LlmHttpError (4xx other than 429)', () => {
  assert.equal(isRetryableLlmError(new LlmHttpError('bad request', 400)), false)
  assert.equal(isRetryableLlmError(new LlmHttpError('unauthorized', 401)), false)
  assert.equal(isRetryableLlmError(new LlmHttpError('forbidden', 403)), false)
  assert.equal(isRetryableLlmError(new LlmHttpError('not found', 404)), false)
})

test('isRetryableLlmError recognizes an AWS-SDK-shaped error via $metadata.httpStatusCode', () => {
  assert.equal(isRetryableLlmError({ $metadata: { httpStatusCode: 429 } }), true)
  assert.equal(isRetryableLlmError({ $metadata: { httpStatusCode: 503 } }), true)
  assert.equal(isRetryableLlmError({ $metadata: { httpStatusCode: 400 } }), false)
})

test('isRetryableLlmError recognizes a known AWS throttling/service exception by name', () => {
  assert.equal(isRetryableLlmError({ name: 'ThrottlingException' }), true)
  assert.equal(isRetryableLlmError({ name: 'ServiceUnavailableException' }), true)
  assert.equal(isRetryableLlmError({ name: 'ModelTimeoutException' }), true)
  assert.equal(isRetryableLlmError({ name: 'ValidationException' }), false)
})

test('isRetryableLlmError recognizes a real network-level failure (connection reset/timeout/DNS) and an aborted request', () => {
  assert.equal(isRetryableLlmError({ name: 'AbortError' }), true)
  assert.equal(isRetryableLlmError({ cause: { code: 'ECONNRESET' } }), true)
  assert.equal(isRetryableLlmError({ cause: { code: 'ETIMEDOUT' } }), true)
  assert.equal(isRetryableLlmError({ cause: { code: 'ECONNREFUSED' } }), true)
  assert.equal(isRetryableLlmError({ cause: { code: 'ENOTFOUND' } }), true)
  assert.equal(isRetryableLlmError({ cause: { code: 'EPIPE' } }), false)
})

test('isRetryableLlmError never retries a plain, unrecognized Error — safe default', () => {
  assert.equal(isRetryableLlmError(new Error('something went wrong')), false)
  assert.equal(isRetryableLlmError('a plain string, not even an object'), false)
  assert.equal(isRetryableLlmError(undefined), false)
})

test('withRetry retries a transient failure and eventually returns the real result', async () => {
  let calls = 0
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      calls++
      if (calls < 3) throw new LlmHttpError('rate limited', 429)
      return 'real response'
    },
  }
  const delays: number[] = []
  const provider = withRetry(fakeProvider, { sleep: fakeSleep(delays) })

  const result = await provider.complete('prompt', 'key')
  assert.equal(result, 'real response')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [1000, 2000], 'expected exponential backoff: 1s then 2s')
})

test('withRetry gives up after maxAttempts and rethrows the last error', async () => {
  let calls = 0
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      calls++
      throw new LlmHttpError(`failure #${calls}`, 500)
    },
  }
  const delays: number[] = []
  const provider = withRetry(fakeProvider, { maxAttempts: 3, sleep: fakeSleep(delays) })

  await assert.rejects(() => provider.complete('prompt', 'key'), /failure #3/, 'expected the LAST error, not the first')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [1000, 2000])
})

test('withRetry does not retry a non-retryable error — fails on the first attempt', async () => {
  let calls = 0
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      calls++
      throw new LlmHttpError('unauthorized', 401)
    },
  }
  const provider = withRetry(fakeProvider, { sleep: fakeSleep([]) })

  await assert.rejects(() => provider.complete('prompt', 'key'), /unauthorized/)
  assert.equal(calls, 1, 'a non-transient error must not be retried at all')
})

test('withRetry invokes onRetry once per retry, with escalating delayMs, but never on the final failure', async () => {
  let calls = 0
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      calls++
      throw new LlmHttpError('rate limited', 429)
    },
  }
  const onRetryCalls: { attempt: number; maxAttempts: number; delayMs: number }[] = []
  const provider = withRetry(fakeProvider, {
    maxAttempts: 3,
    sleep: fakeSleep([]),
    onRetry: (info) => onRetryCalls.push({ attempt: info.attempt, maxAttempts: info.maxAttempts, delayMs: info.delayMs }),
  })

  await assert.rejects(() => provider.complete('prompt', 'key'))
  assert.equal(calls, 3)
  // 2 retries happen (before attempt 2 and before attempt 3) — never a third
  // onRetry call for the final, non-retried failure on attempt 3.
  assert.deepEqual(onRetryCalls, [
    { attempt: 1, maxAttempts: 3, delayMs: 1000 },
    { attempt: 2, maxAttempts: 3, delayMs: 2000 },
  ])
})

test('withRetry preserves the provider id unchanged', () => {
  const fakeProvider: LlmProvider = { id: 'fake-provider-id', async complete() { return '' } }
  assert.equal(withRetry(fakeProvider).id, 'fake-provider-id')
})

test('withRetry caps backoff delay at maxDelayMs', async () => {
  let calls = 0
  const fakeProvider: LlmProvider = {
    id: 'fake',
    async complete() {
      calls++
      throw new LlmHttpError('rate limited', 429)
    },
  }
  const delays: number[] = []
  const provider = withRetry(fakeProvider, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, sleep: fakeSleep(delays) })

  await assert.rejects(() => provider.complete('prompt', 'key'))
  // Uncapped would be 1000, 2000, 4000, 8000 — capped at 3000.
  assert.deepEqual(delays, [1000, 2000, 3000, 3000])
})
