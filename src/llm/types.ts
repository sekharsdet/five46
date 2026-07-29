/**
 * BYOK: `apiKey` is always supplied by the caller (their own OpenAI/
 * Anthropic/etc. account) at the point of use, never stored or read from
 * anywhere this project controls. This is the whole architectural point of
 * BYOK — the customer's key absorbs their own usage cost directly; this
 * project never fronts an LLM API budget or holds a credential at rest.
 */
export interface LlmProvider {
  id: string
  complete(prompt: string, apiKey: string): Promise<string>
}
