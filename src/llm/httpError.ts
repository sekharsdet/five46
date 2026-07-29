/** Turns a non-ok `fetch` response into an error message that includes the
 * API's own real reason, not just the bare HTTP status. Found via a real,
 * live call: a Gemini 429 reported as just "429 Too Many Requests" when the
 * actual response body said `RESOURCE_EXHAUSTED — Quota exceeded... limit:
 * 0... Please retry in 52s` — a completely different, far more actionable
 * situation (a zero-quota free-tier project, not a transient rate limit)
 * that the bare status code alone couldn't distinguish. OpenAI/Anthropic/
 * Gemini all shape their error bodies as `{ error: { message: "..." } }`;
 * falls back to the raw response text (truncated) if that shape isn't
 * there, and to just the status if the body can't be read at all — never
 * throws while trying to build a better error message. */
export async function describeApiError(providerName: string, response: Response): Promise<string> {
  const prefix = `${providerName} API request failed: ${response.status} ${response.statusText}`
  let bodyText: string
  try {
    bodyText = await response.text()
  } catch {
    return prefix
  }
  if (!bodyText) return prefix

  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } }
    if (parsed.error?.message) return `${prefix} — ${parsed.error.message}`
  } catch {
    // Not JSON, or not the expected shape — fall through to the raw text.
  }
  return `${prefix} — ${bodyText.slice(0, 500)}`
}
