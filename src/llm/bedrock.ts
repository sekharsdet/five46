import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import type { LlmProvider } from './types'
import { DEFAULT_LLM_TIMEOUT_MS } from './fetchWithTimeout'

/**
 * AWS Bedrock — many enterprises specifically mandate Bedrock rather than
 * calling OpenAI/Anthropic directly, for compliance/procurement reasons —
 * exactly the kind of "restrictions" that blocked this project's own origin
 * team from adopting a cloud-hosted AI testing tool in the first place, so
 * this is a directly relevant BYOK path, not just coverage for its own sake.
 *
 * Unlike OpenAI/Anthropic's simple Bearer-token auth, Bedrock authenticates
 * requests via AWS SigV4 signing — implemented here through the official
 * `@aws-sdk/client-bedrock-runtime` package rather than hand-rolled, since
 * reimplementing SigV4 correctly is a real security-sensitive undertaking,
 * not something to DIY for a feature like this.
 *
 * Because of that, this provider's `apiKey` parameter (kept for interface
 * consistency with the other providers) is repurposed as the **AWS region**
 * (e.g. "us-east-1"), not a secret — actual credentials come from the
 * environment via the AWS SDK's standard default credential provider chain
 * (env vars, `~/.aws/credentials`, or an IAM role), which is how Bedrock
 * access is normally already gated inside a company's AWS account rather
 * than a separately copy-pasted key. Uses the Converse API, Bedrock's
 * unified request/response shape across model providers (Anthropic, Meta,
 * Amazon, ...), so switching the underlying model doesn't change this code.
 *
 * `options.fastPath` is deliberately ignored — the configured Haiku model
 * is already the fastest tier this codebase trusts for the strict
 * JSON-only action schema; a no-op, not an oversight.
 */
export const bedrockProvider: LlmProvider = {
  id: 'bedrock',
  async complete(prompt, region, options) {
    // maxAttempts: 1 — the AWS SDK's own default StandardRetryStrategy would
    // otherwise already retry throttling/5xx internally before send()
    // rejects at all, compounding with the outer retry layer llm/retry.ts
    // adds on top of every provider (registry.ts's getLlmProvider). Pinning
    // this to 1 makes that outer layer the single source of retry truth
    // across all 5 providers uniformly, instead of Bedrock silently getting
    // up to 3x the retries (with two independent backoff schedules) that
    // every other provider gets.
    // requestHandler: a plain options object here (not a NodeHttpHandler
    // instance) — the SDK resolves it into one internally, avoiding a direct
    // dependency on @smithy/node-http-handler, which this package only pulls
    // in transitively through @aws-sdk/client-bedrock-runtime.
    const client = new BedrockRuntimeClient({ region, maxAttempts: 1, requestHandler: { requestTimeout: DEFAULT_LLM_TIMEOUT_MS } })
    const command = new ConverseCommand({
      modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: options?.maxOutputTokens ?? 1024 },
    })
    const response = await client.send(command)
    const content = response.output?.message?.content ?? []
    const textBlock = content.find((block) => typeof block.text === 'string')
    return textBlock?.text ?? ''
  },
}
