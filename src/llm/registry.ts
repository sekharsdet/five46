import { openAiProvider } from './openai'
import { anthropicProvider } from './anthropic'
import { bedrockProvider } from './bedrock'
import { geminiProvider } from './gemini'
import type { LlmProvider } from './types'

const PROVIDERS: Record<string, LlmProvider> = {
  [openAiProvider.id]: openAiProvider,
  [anthropicProvider.id]: anthropicProvider,
  [bedrockProvider.id]: bedrockProvider,
  [geminiProvider.id]: geminiProvider,
}

export function getLlmProvider(id: string): LlmProvider {
  const provider = PROVIDERS[id]
  if (!provider) {
    throw new Error(`Unknown LLM provider "${id}" — supported: ${Object.keys(PROVIDERS).join(', ')}`)
  }
  return provider
}

export function supportedLlmProviderIds(): string[] {
  return Object.keys(PROVIDERS)
}
