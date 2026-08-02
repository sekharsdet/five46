import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openAiProvider } from './openai'
import { anthropicProvider } from './anthropic'
import { geminiProvider } from './gemini'
import { groqProvider } from './groq'
import { LlmHttpError } from './httpError'

// No live API keys are available in this environment, so these verify each
// provider's own request-building/response-parsing logic against a mocked
// `fetch` — a real round-trip against OpenAI/Anthropic/Gemini/Groq is still unverified.

test('openAiProvider sends the documented Chat Completions shape and parses the response', async () => {
  const originalFetch = global.fetch
  let capturedUrl: string | undefined
  let capturedBody: unknown

  global.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url
    capturedBody = JSON.parse(init!.body as string)
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Looks consistent with the AC.' } }] }),
    } as Response
  }) as typeof fetch

  try {
    const result = await openAiProvider.complete('compare this', 'sk-test')
    assert.equal(result, 'Looks consistent with the AC.')
    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions')
    assert.equal((capturedBody as { messages: { content: string }[] }).messages[0].content, 'compare this')
  } finally {
    global.fetch = originalFetch
  }
})

test('anthropicProvider sends the documented Messages API shape and parses the response', async () => {
  const originalFetch = global.fetch
  let capturedHeaders: Record<string, string> | undefined

  global.fetch = (async (_url: string, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string> | undefined
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Looks consistent with the AC.' }] }),
    } as Response
  }) as typeof fetch

  try {
    const result = await anthropicProvider.complete('compare this', 'anthropic-test-key')
    assert.equal(result, 'Looks consistent with the AC.')
    assert.equal((capturedHeaders as Record<string, string>)['x-api-key'], 'anthropic-test-key')
  } finally {
    global.fetch = originalFetch
  }
})

test('geminiProvider sends the documented generateContent shape, with the key in the query string, and parses the response', async () => {
  const originalFetch = global.fetch
  let capturedUrl: string | undefined
  let capturedBody: unknown

  global.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url
    capturedBody = JSON.parse(init!.body as string)
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Looks consistent with the AC.' }] } }] }),
    } as Response
  }) as typeof fetch

  try {
    const result = await geminiProvider.complete('compare this', 'gemini-test-key')
    assert.equal(result, 'Looks consistent with the AC.')
    assert.ok(capturedUrl?.includes('generativelanguage.googleapis.com'))
    assert.ok(capturedUrl?.includes('key=gemini-test-key'))
    assert.equal((capturedBody as { contents: { parts: { text: string }[] }[] }).contents[0].parts[0].text, 'compare this')
  } finally {
    global.fetch = originalFetch
  }
})

test('groqProvider sends the OpenAI-compatible Chat Completions shape against Groq\'s own endpoint, and parses the response', async () => {
  const originalFetch = global.fetch
  let capturedUrl: string | undefined
  let capturedBody: unknown
  let capturedHeaders: Record<string, string> | undefined

  global.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url
    capturedBody = JSON.parse(init!.body as string)
    capturedHeaders = init?.headers as Record<string, string> | undefined
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Looks consistent with the AC.' } }] }),
    } as Response
  }) as typeof fetch

  try {
    const result = await groqProvider.complete('compare this', 'groq-test-key')
    assert.equal(result, 'Looks consistent with the AC.')
    assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions')
    assert.equal((capturedHeaders as Record<string, string>).Authorization, 'Bearer groq-test-key')
    assert.equal((capturedBody as { messages: { content: string }[] }).messages[0].content, 'compare this')
  } finally {
    global.fetch = originalFetch
  }
})

// The tests above only ever exercised the happy path — a real, disclosed
// gap until now (only httpError.test.ts tested describeApiError in
// isolation). These close it: a mocked 429 must surface as an
// `LlmHttpError` carrying the real status, which llm/retry.ts's
// `isRetryableLlmError` depends on to decide whether to retry.

function fakeErrorResponse(status: number): Response {
  return { ok: false, status, statusText: 'rate limited', text: async () => '' } as Response
}

test('openAiProvider throws LlmHttpError with the real status on a non-ok response', async () => {
  const originalFetch = global.fetch
  global.fetch = (async () => fakeErrorResponse(429)) as typeof fetch
  try {
    await assert.rejects(() => openAiProvider.complete('x', 'sk-test'), (err: unknown) => err instanceof LlmHttpError && err.status === 429)
  } finally {
    global.fetch = originalFetch
  }
})

test('anthropicProvider throws LlmHttpError with the real status on a non-ok response', async () => {
  const originalFetch = global.fetch
  global.fetch = (async () => fakeErrorResponse(500)) as typeof fetch
  try {
    await assert.rejects(() => anthropicProvider.complete('x', 'anthropic-test-key'), (err: unknown) => err instanceof LlmHttpError && err.status === 500)
  } finally {
    global.fetch = originalFetch
  }
})

test('geminiProvider throws LlmHttpError with the real status on a non-ok response', async () => {
  const originalFetch = global.fetch
  global.fetch = (async () => fakeErrorResponse(429)) as typeof fetch
  try {
    await assert.rejects(() => geminiProvider.complete('x', 'gemini-test-key'), (err: unknown) => err instanceof LlmHttpError && err.status === 429)
  } finally {
    global.fetch = originalFetch
  }
})

test('groqProvider throws LlmHttpError with the real status on a non-ok response', async () => {
  const originalFetch = global.fetch
  global.fetch = (async () => fakeErrorResponse(503)) as typeof fetch
  try {
    await assert.rejects(() => groqProvider.complete('x', 'groq-test-key'), (err: unknown) => err instanceof LlmHttpError && err.status === 503)
  } finally {
    global.fetch = originalFetch
  }
})
