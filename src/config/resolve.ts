import { loadConfigFile } from './store'

export interface ResolvedCredentials {
  llmProvider?: string
  llmApiKey?: string
}

/** Environment variables always win over the saved config file — this
 * matters for CI (set env vars, no file involved, nothing persisted on a
 * shared runner) and for one-off overrides without touching the saved
 * config. `configDir` is test-only, same as in `store.ts`. */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env, configDir?: string): ResolvedCredentials {
  const fileConfig = loadConfigFile(configDir)
  const { FIVE46_LLM_PROVIDER, FIVE46_LLM_API_KEY } = env

  return {
    llmProvider: FIVE46_LLM_PROVIDER || fileConfig?.llm?.provider,
    llmApiKey: FIVE46_LLM_API_KEY || fileConfig?.llm?.apiKey,
  }
}
