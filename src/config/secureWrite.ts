import { mkdirSync, writeFileSync, chmodSync } from 'fs'
import { dirname } from 'path'

/** Writes a file with 0o600 (user-only read/write) permissions, for any file
 * that holds a secret — the LLM config, and (see `agent/browser.ts`) a
 * captured login session, which is itself a live bearer credential, not
 * just a reference to one. The mode is passed directly to `writeFileSync`
 * so the file is created with the right permissions from its very first
 * syscall, not written-then-chmodded — a real gap an earlier version of
 * `config/store.ts` had: writing first and `chmodSync`-ing afterward left a
 * brief window where the file existed with default, often world-readable
 * (0o644) permissions before being tightened, which matters on any
 * shared/multi-user system. The follow-up `chmodSync` stays as a backstop,
 * since the process umask can still reduce the mode requested at creation
 * time — best-effort, since `chmodSync` can fail/no-op on some Windows
 * setups, which isn't worth failing the whole write over.
 *
 * Deliberately not Playwright's own `context.storageState({ path })`
 * convenience for the login-session case — that writes with default `fs`
 * permissions, silently undermining exactly the security posture this
 * function exists to guarantee. */
export function writeSecureFile(path: string, contents: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort — see doc comment above.
  }
}
