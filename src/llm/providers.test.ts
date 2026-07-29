import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openAiProvider } from './openai'
import { anthropicProvider } from './anthropic'
import { geminiProvider } from './gemini'

// No live API keys are available in this environment, so these verify each
// provider's own request-building/response-parsing logic against a mocked
// `fetch` — a real round-trip against OpenAI/Anthropic/Gemini is still unverified.

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
