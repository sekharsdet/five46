/** Persisted, on-disk form of the same BYOK credentials the CLI already
 * accepts via environment variables — see `resolve.ts` for how the two are
 * merged. Stored as plain JSON at `~/.five46/config.json` with
 * user-only file permissions (0o600); not encrypted at rest. That's a
 * deliberate, common tradeoff for CLI tools (the same one `~/.aws/credentials`
 * and `~/.netrc` make) — documented, not hidden, in `store.ts`. */
export interface Five46Config {
  llm?: {
    provider: string
    apiKey: string
  }
}
