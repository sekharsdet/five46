/**
 * BYOK: `apiKey` is always supplied by the caller (their own OpenAI/
 * Anthropic/etc. account) at the point of use, never stored or read from
 * anywhere this project controls. This is the whole architectural point of
 * BYOK — the customer's key absorbs their own usage cost directly; this
 * project never fronts an LLM API budget or holds a credential at rest.
 */
/** Bounds a single completion's output length — every provider maps this
 * onto its own request shape (see each provider file). Omitted entirely by
 * a caller (including every existing test call site using the 2-argument
 * `complete(prompt, apiKey)` form) falls back to each provider's own
 * conservative default, so nothing existing needs to change to keep
 * working. Anthropic already required *some* value here (`max_tokens` is a
 * mandatory field on its Messages API) — this generalizes that
 * provider-specific requirement into an optional, uniform knob every
 * provider now honors, the same "one shared knob, all providers read it"
 * precedent `DEFAULT_LLM_TIMEOUT_MS` already established for request
 * timeouts. Exists to bound tail latency: every prompt in this codebase
 * asks for a small, tightly-scoped JSON object or a short paragraph, so an
 * unbounded model that free-associates past what's needed adds pure wasted
 * generation time. */
export interface LlmCompleteOptions {
  maxOutputTokens?: number
}

export interface LlmProvider {
  id: string
  complete(prompt: string, apiKey: string, options?: LlmCompleteOptions): Promise<string>
}
