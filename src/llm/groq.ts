import type { LlmProvider } from './types'
import { describeApiError, LlmHttpError } from './httpError'
import { fetchWithTimeout } from './fetchWithTimeout'

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
 * creative generation.
 *
 * `options.fastPath` swaps in `llama-3.1-8b-instant` — a real, meaningfully
 * faster tier on Groq's own LPU hardware (externally documented at roughly
 * 2-8x the token/sec throughput of the 70B default), used only for the
 * high-frequency per-step decision call, never the one-time upfront plan
 * call. Opt-in via `--fast-steps` — a smaller model is a real,
 * unquantified risk to per-step decision quality, not something to default
 * on without live validation first. */
export const groqProvider: LlmProvider = {
  id: 'groq',
  async complete(prompt, apiKey, options) {
    const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options?.fastPath ? 'llama-3.1-8b-instant' : 'llama-3.3-70b-versatile',
        temperature: 0,
        max_tokens: options?.maxOutputTokens ?? 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      throw new LlmHttpError(await describeApiError('Groq', response), response.status)
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
    const content = body.choices?.[0]?.message?.content
    if (content) return content
    // Same reasoning as gemini.ts's identical check — see its own doc
    // comment. An empty completion already degrades correctly to
    // unparseable-response; this only replaces a blank raw response with
    // one that names why, when Groq's own (OpenAI-compatible) response
    // says so (finish_reason: 'content_filter'/'length'/... instead of
    // 'stop').
    const finishReason = body.choices?.[0]?.finish_reason
    if (finishReason && finishReason !== 'stop') return `[groq returned no content — finish_reason: ${finishReason}]`
    return ''
  },
}
