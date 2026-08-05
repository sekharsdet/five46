import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { writeSecureFile } from './secureWrite'
import type { PlannedStep } from '../agent/types'

/** One cached, previously-successful resolution of a goal's whole upfront
 * plan against a specific target — see `agent/actionCache.ts` for how an
 * entry is built and consulted. `steps` deliberately reuses `PlannedStep`
 * (a `{role, nameContains}` *prediction*, never a raw selector) — the same
 * "never trust a stale positional fact, always re-verify by content
 * against fresh state" reasoning `resolvePlannedTarget`/self-healing
 * already apply everywhere else in this codebase. `domSignature` is a
 * cheap pre-filter for whether this entry is even worth *attempting* to
 * reuse — never the authority that a specific step is still correct; that
 * is always `resolvePlannedTarget`'s live, per-step job. */
export interface ActionCacheEntry {
  domSignature: string
  steps: PlannedStep[]
  cachedAt: string
}

export interface ActionCacheFile {
  entries: Record<string, ActionCacheEntry>
}

/** Overridable via `configDir` purely so tests can point at a temp
 * directory instead of touching the real `~/.five46` — mirrors
 * `config/store.ts`'s identical `resolveConfigPath` exactly, production
 * code always calls these with no argument. A sibling file to
 * `config.json` (not a subdirectory) — same directory, same "one dotfolder
 * for all of five46's local state" convention, just a different file since
 * a cache is not secret-bearing the way the LLM API key config is (see
 * `saveActionCache`'s own doc comment for why it's still written via
 * `writeSecureFile` anyway). */
function resolveActionCachePath(configDir?: string): string {
  return join(configDir ?? join(homedir(), '.five46'), 'cache.json')
}

export function actionCacheFilePath(configDir?: string): string {
  return resolveActionCachePath(configDir)
}

/** Never throws — a missing or corrupted/hand-edited cache file degrades
 * to an empty cache, the exact same "never worse off than not having
 * opted in" posture `config/store.ts`'s `loadConfigFile` already applies
 * to a corrupted LLM config, and `parsePlan`'s malformed-response handling
 * applies to a bad upfront plan. A corrupt cache must never crash a run
 * that would otherwise have succeeded via a live decision. */
export function loadActionCache(configDir?: string): ActionCacheFile {
  const path = resolveActionCachePath(configDir)
  if (!existsSync(path)) return { entries: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { entries: {} }
    }
    return parsed as ActionCacheFile
  } catch {
    return { entries: {} }
  }
}

/** A cached `fill` step's `value` is real, goal-driven test data a user
 * typed (an email, a name) — not a *secret* the way the LLM API key
 * config is, but still real content, so this reuses `writeSecureFile`'s
 * 0600 handling as cheap insurance rather than inventing a second,
 * lower-permission write path for what's otherwise a very similar file.
 * (A resolved credential never appears here in the first place — see
 * `AgentAction.value`'s own doc comment on why a placeholder token, never
 * the real value, is what a `fill` action always carries — so this isn't
 * the only thing protecting that, just a second layer.) */
export function saveActionCache(cache: ActionCacheFile, configDir?: string): void {
  const path = resolveActionCachePath(configDir)
  writeSecureFile(path, JSON.stringify(cache, null, 2))
}
