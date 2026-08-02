import type { LlmProvider } from './types'
import { describeApiError, LlmHttpError } from './httpError'
import { fetchWithTimeout } from './fetchWithTimeout'

/** OpenAI's Chat Completions API — https://platform.openai.com/docs/api-reference/chat.
 * Shape verified against public API docs, not a live call (no test key
 * available in this environment). `temperature: 0` since this is used for a
 * consistency check, not creative generation — we want the same AC compared
 * against the same code to give the same answer. */
export const openAiProvider: LlmProvider = {
  id: 'openai',
  async complete(prompt, apiKey) {
    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      throw new LlmHttpError(await describeApiError('OpenAI', response), response.status)
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
    const content = body.choices?.[0]?.message?.content
    if (content) return content
    // Same reasoning as gemini.ts's identical check — see its own doc
    // comment. An empty completion already degrades correctly to
    // unparseable-response; this only replaces a blank raw response with
    // one that names why, when OpenAI's own response says so
    // (finish_reason: 'content_filter'/'length'/... instead of 'stop').
    const finishReason = body.choices?.[0]?.finish_reason
    if (finishReason && finishReason !== 'stop') return `[openai returned no content — finish_reason: ${finishReason}]`
    return ''
  },
}
