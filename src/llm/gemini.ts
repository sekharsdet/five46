import type { LlmProvider } from './types'
import { describeApiError, LlmHttpError } from './httpError'
import { fetchWithTimeout } from './fetchWithTimeout'

/** Google's Generative Language API —
 * https://ai.google.dev/api/generate-content. Request shape confirmed
 * against real, live calls. This is the *second* time the hardcoded model
 * name here broke on its own: `gemini-2.0-flash` (the original choice) had
 * a hard 0 free-tier quota as of 2026-07; its replacement,
 * `gemini-2.5-flash`, later started returning a real 404 ("no longer
 * available to new users") for a freshly created key, confirmed via a real
 * call, even though it still appears in that key's own `/v1beta/models`
 * listing — Google's per-account model eligibility apparently isn't fully
 * reflected in that listing. Switched to `gemini-flash-latest`, one of
 * Google's own documented stable aliases (confirmed via a real call — it
 * currently resolves to `gemini-3.6-flash`, per the response's own
 * `modelVersion` field) specifically to stop re-fixing this exact class of
 * bug every time Google retires a dated model name. The tradeoff, stated
 * plainly rather than hidden: an alias can change which underlying model
 * actually runs without any five46-side change, trading version pinning
 * (stability) for not silently breaking again (availability) — the right
 * side of that tradeoff for a fast-moving free tier, but worth knowing if
 * agent behavior ever seems to shift between runs for no code reason.
 * Unlike OpenAI/Anthropic's Bearer/header auth, the API key goes in the
 * query string per Google's documented scheme. */
export const geminiProvider: LlmProvider = {
  id: 'gemini',
  async complete(prompt, apiKey) {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    )

    if (!response.ok) {
      throw new LlmHttpError(await describeApiError('Gemini', response), response.status)
    }

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
      promptFeedback?: { blockReason?: string }
    }
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) return text
    // Found via a real, live run: an empty completion previously became a
    // silent '' — degrading correctly to unparseable-response (no crash,
    // no data loss), but with a blank raw response nobody could diagnose.
    // Gemini's own response already names why when this happens; we were
    // just discarding it. This string still correctly fails JSON.parse (no
    // control-flow change), it just makes the disclosed raw response
    // genuinely informative — most plausibly a safety-filter block, given
    // the goal that first surfaced this sent PII-shaped text (a literal
    // SSN) to the model every turn, per this tool's own disclosure banner.
    const blockReason = body.promptFeedback?.blockReason
    if (blockReason) return `[gemini blocked this prompt — blockReason: ${blockReason}]`
    const finishReason = body.candidates?.[0]?.finishReason
    if (finishReason && finishReason !== 'STOP') return `[gemini returned no content — finishReason: ${finishReason}]`
    return ''
  },
}
