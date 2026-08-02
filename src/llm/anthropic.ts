import type { LlmProvider } from './types'
import { describeApiError, LlmHttpError } from './httpError'
import { fetchWithTimeout } from './fetchWithTimeout'

/** Anthropic's Messages API — https://docs.anthropic.com/en/api/messages.
 * Shape verified against public API docs, not a live call (no test key
 * available in this environment). */
export const anthropicProvider: LlmProvider = {
  id: 'anthropic',
  async complete(prompt, apiKey) {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      throw new LlmHttpError(await describeApiError('Anthropic', response), response.status)
    }

    const body = (await response.json()) as { content?: { type: string; text?: string }[] }
    return body.content?.find((block) => block.type === 'text')?.text ?? ''
  },
}
