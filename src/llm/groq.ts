import type { LlmProvider } from './types'
import { describeApiError, LlmHttpError } from './httpError'

/** Groq's Chat Completions API — OpenAI-compatible request/response shape
 * (https://console.groq.com/docs/openai), just a different base URL and
 * model lineup. Worth having as its own provider (not just "point the
 * openai provider at a different URL") since Groq's free tier has
 * meaningfully more generous rate limits than OpenAI's, making it a real
 * option for running this tool's per-step agentic loop cheaply.
 * `llama-3.3-70b-versatile` is a stable, broadly capable default — Groq's
 * exact model lineup does shift over time, so this may need revisiting
 * later, the same as any hardcoded provider default here. `temperature: 0`
 * for the same reason `openai.ts` uses it: a consistency check, not
 * creative generation. */
export const groqProvider: LlmProvider = {
  id: 'groq',
  async complete(prompt, apiKey) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      throw new LlmHttpError(await describeApiError('Groq', response), response.status)
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    return body.choices?.[0]?.message?.content ?? ''
  },
}
