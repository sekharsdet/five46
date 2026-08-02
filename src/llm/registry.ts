import { openAiProvider } from './openai'
import { anthropicProvider } from './anthropic'
import { bedrockProvider } from './bedrock'
import { geminiProvider } from './gemini'
import { groqProvider } from './groq'
import type { LlmProvider } from './types'
import { withRetry } from './retry'
import type { RetryOptions } from './retry'

const PROVIDERS: Record<string, LlmProvider> = {
  [openAiProvider.id]: openAiProvider,
  [anthropicProvider.id]: anthropicProvider,
  [bedrockProvider.id]: bedrockProvider,
  [geminiProvider.id]: geminiProvider,
  [groqProvider.id]: groqProvider,
}

/** Every provider returned here is wrapped in `withRetry` — the single
 * point every one of this codebase's real `provider.complete()` call
 * sites (`runner.ts`, `apiRunner.ts`, `rootCause.ts`, `apiRootCause.ts`)
 * flows through, so all of them get bounded retry-with-backoff on a
 * transient error transparently, with no changes needed to any of those 4
 * files. `onRetry` is optional and left `undefined` by MCP's own call
 * sites (retries still happen there, just silently — see `retry.ts`'s own
 * doc comment on why); `cli.ts` passes one that prints. */
export function getLlmProvider(id: string, onRetry?: RetryOptions['onRetry']): LlmProvider {
  const provider = PROVIDERS[id]
  if (!provider) {
    throw new Error(`Unknown LLM provider "${id}" — supported: ${Object.keys(PROVIDERS).join(', ')}`)
  }
  return withRetry(provider, { onRetry })
}

export function supportedLlmProviderIds(): string[] {
  return Object.keys(PROVIDERS)
}
