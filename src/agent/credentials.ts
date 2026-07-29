import type { LoginCredentials } from './browser'

/** Login credentials are env-var only, no CLI flags — matching this
 * project's own existing precedent exactly: the LLM API key has never
 * accepted a CLI flag either (only an env var or the masked `config`
 * wizard), specifically to avoid shell-history/`ps`-listing exposure.
 * Introducing `--password` as a plain arg for a comparably sensitive
 * secret would be a real, avoidable regression from that standard.
 * Deliberately not persisted anywhere (unlike the LLM key, which `config`
 * saves to disk) — a login credential is per-target-app, not a single
 * reusable secret, so there's no equivalent "save once" convenience to
 * offer here. */
export function resolveLoginCredentials(env: NodeJS.ProcessEnv = process.env): LoginCredentials {
  return {
    username: env.FIVE46_LOGIN_USERNAME || undefined,
    password: env.FIVE46_LOGIN_PASSWORD || undefined,
  }
}

/** API auth is env-var only, matching `resolveLoginCredentials`'s exact
 * precedent and the same reasoning — no CLI flag for a secret value, ever.
 * Simpler than UI login credentials: there's no field for the agent to
 * locate/fill, so a single header name/value pair is attached to every
 * outgoing request silently (see `apiRunner.ts`'s `authHeaders`) — never
 * shown to the LLM or referenced in a prompt at all. `undefined` (not an
 * empty object) when no value is configured, so a caller can tell "no auth
 * configured" apart from "an auth header with an empty value" without an
 * extra check. */
export function resolveApiAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const value = env.FIVE46_API_AUTH_HEADER_VALUE
  if (!value) return undefined
  const name = env.FIVE46_API_AUTH_HEADER_NAME || 'Authorization'
  return { [name]: value }
}
