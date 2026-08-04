import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout, DEFAULT_LLM_TIMEOUT_MS } from './fetchWithTimeout'
import { openAiProvider } from './openai'
import { anthropicProvider } from './anthropic'
import { geminiProvider } from './gemini'
import { groqProvider } from './groq'

// Real, live testing (see DEVELOPMENT.md's performance section) found every
// fetch-based provider hanging on a single slow upstream response for 2+
// minutes with zero recourse, since bare `fetch()` has no timeout of its
// own. These prove the fix is actually wired: a real AbortSignal reaches
// fetch, and every provider goes through it rather than a bare call.

test('fetchWithTimeout attaches a real AbortSignal to the request', async () => {
  const originalFetch = global.fetch
  let capturedSignal: AbortSignal | undefined
  global.fetch = (async (_url: string, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined
    return { ok: true, json: async () => ({}) } as Response
  }) as typeof fetch

  try {
    await fetchWithTimeout('https://example.com', { method: 'GET' }, 5000)
    assert.ok(capturedSignal instanceof AbortSignal)
    assert.equal(capturedSignal!.aborted, false)
  } finally {
    global.fetch = originalFetch
  }
})

test('fetchWithTimeout aborts and rejects with a retryable TimeoutError once the timeout elapses', async () => {
  const originalFetch = global.fetch
  global.fetch = ((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      // `AbortSignal.timeout()`'s own internal timer is deliberately unref'd
      // (so a real, in-production pending timeout never keeps a process
      // alive on its own) — with nothing else ref'd in this test process,
      // that's a known Node test-runner false positive on Node 20.12+
      // through at least 22.x (nodejs/node#49952, #52304): the runner can
      // decide the event loop is idle and report "Promise resolution is
      // still pending" before the unref'd timer ever gets to fire, even
      // though it reliably would have. A trivial ref'd keepalive, cleared
      // the moment abort actually fires, sidesteps it without touching the
      // real 10ms timeout behavior under test.
      const keepAlive = setInterval(() => {}, 1000)
      init?.signal?.addEventListener('abort', () => {
        clearInterval(keepAlive)
        reject((init.signal as AbortSignal).reason)
      })
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      fetchWithTimeout('https://example.com', { method: 'GET' }, 10),
      (err: unknown) => (err as { name?: string }).name === 'TimeoutError'
    )
  } finally {
    global.fetch = originalFetch
  }
})

test('DEFAULT_LLM_TIMEOUT_MS is comfortably above real observed per-step latency but still bounds a stuck request', () => {
  assert.equal(DEFAULT_LLM_TIMEOUT_MS, 30000)
})

for (const [name, provider] of [
  ['openAiProvider', openAiProvider],
  ['anthropicProvider', anthropicProvider],
  ['geminiProvider', geminiProvider],
  ['groqProvider', groqProvider],
] as const) {
  test(`${name} sends its request through fetchWithTimeout, not a bare unbounded fetch`, async () => {
    const originalFetch = global.fetch
    let capturedSignal: AbortSignal | undefined
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          content: [{ type: 'text', text: 'ok' }],
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }),
      } as Response
    }) as typeof fetch

    try {
      await provider.complete('hi', 'test-key')
      assert.ok(capturedSignal instanceof AbortSignal, `${name} did not attach a timeout signal`)
    } finally {
      global.fetch = originalFetch
    }
  })
}
