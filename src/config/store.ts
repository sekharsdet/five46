import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Five46Config } from './types'
import { writeSecureFile } from './secureWrite'

/** Overridable via `configDir` purely so tests can point at a temp
 * directory instead of touching the real `~/.five46` — production code
 * always calls these with no argument. */
function resolveConfigPath(configDir?: string): string {
  return join(configDir ?? join(homedir(), '.five46'), 'config.json')
}

export function configFilePath(configDir?: string): string {
  return resolveConfigPath(configDir)
}

export function loadConfigFile(configDir?: string): Five46Config | undefined {
  const path = resolveConfigPath(configDir)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A corrupted/hand-edited config file shouldn't crash the CLI — treat it
    // the same as "no saved config," same as a missing file.
    return undefined
  }
}

/** Secrets-file write — see `secureWrite.ts`'s `writeSecureFile` for the
 * 0600-from-first-syscall reasoning, shared with the login-session writer
 * in `agent/browser.ts`. */
export function saveConfigFile(config: Five46Config, configDir?: string): void {
  const path = resolveConfigPath(configDir)
  writeSecureFile(path, JSON.stringify(config, null, 2))
}
