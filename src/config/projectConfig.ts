import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ParsedAgentArgs, ParsedApiArgs } from '../cli'

/** Reusable default flags for a named target — a project's purpose is
 * environment/safety defaults, never a canned goal (`--goal` stays
 * required on every invocation regardless of `--project`). `allowWrites`/
 * `allowHosts` only ever apply to `five46 api`; `test`/`login` ignore them
 * the same way `parseAgentArgs` already harmlessly ignores flags it
 * doesn't read. */
export interface ProjectDefaults {
  url?: string
  storageState?: string
  allowDeletes?: boolean
  /** An LLM provider *label* only (e.g. "openai") — never a key. Only
   * fills the gap below an explicit env var / `~/.five46/config.json`
   * choice (both stronger, existing sources) and above the current
   * hardcoded `'openai'` fallback; never overrides an explicit choice.
   * The API key itself is never sourced from project config — that would
   * mean a real secret living in a file meant to be checked into source
   * control. */
  provider?: string
  maxSteps?: number
  headed?: boolean
  allowWrites?: boolean
  allowHosts?: string[]
}

export interface Five46ProjectConfig {
  projects: Record<string, ProjectDefaults>
}

export const PROJECT_CONFIG_FILENAME = 'five46.config.json'

export function projectConfigPath(cwd?: string): string {
  return join(cwd ?? process.cwd(), PROJECT_CONFIG_FILENAME)
}

export type LoadProjectConfigResult = { ok: true; config: Five46ProjectConfig } | { ok: false; error: string }

/** Loads `five46.config.json` from the given (or current) directory.
 * Deliberately a separate module from `config/store.ts` (the
 * `~/.five46/config.json` LLM-secret config): this file is per-repo,
 * non-secret, meant to be checked into source control — no 0600/
 * `writeSecureFile` handling applies here, and keeping it in its own
 * module means a reader never has to ask "does this one also hold a
 * secret." Never throws — a three-way error message mirroring
 * `cli.ts`'s `loadStorageStateFile` shape exactly (missing file / invalid
 * JSON / wrong shape), so a caller always gets something printable rather
 * than an exception to catch. */
export function loadProjectConfig(cwd?: string): LoadProjectConfigResult {
  const path = projectConfigPath(cwd)
  if (!existsSync(path)) {
    return { ok: false, error: `${PROJECT_CONFIG_FILENAME} not found in ${cwd ?? 'the current directory'}.` }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, error: `Couldn't read ${path}: ${err instanceof Error ? err.message : String(err)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `${path} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (typeof parsed !== 'object' || parsed === null || !('projects' in parsed) || typeof (parsed as { projects: unknown }).projects !== 'object') {
    return { ok: false, error: `${path} doesn't look like a project config (missing a "projects" object).` }
  }

  return { ok: true, config: parsed as Five46ProjectConfig }
}

export type ResolveProjectResult = { ok: true; defaults: ProjectDefaults } | { ok: false; error: string }

/** Never a silent `undefined` on a miss — the error names the real
 * configured project names (or says none exist), matching this codebase's
 * "never guess" posture everywhere else (an unresolved `{{var}}`, a
 * hallucinated ref, an unknown provider id). */
export function resolveProject(config: Five46ProjectConfig, name: string): ResolveProjectResult {
  const defaults = config.projects[name]
  if (!defaults) {
    const known = Object.keys(config.projects)
    return {
      ok: false,
      error: `No project named "${name}" in ${PROJECT_CONFIG_FILENAME}. Configured project(s): ${known.length > 0 ? known.join(', ') : '(none configured)'}.`,
    }
  }
  return { ok: true, defaults }
}

/** CLI flags always win over a project default; a project default only
 * fills a gap the CLI left unset. Two small merge functions rather than
 * one generic one — `url` vs `baseUrl` differ in field name, and
 * `ParsedApiArgs`'s boolean/array fields default non-optionally, so the
 * merge semantics genuinely differ per engine (the same reasoning this
 * codebase already applies to keeping `actionSignature` duplicated per
 * engine in runner.ts/apiRunner.ts rather than forced through one
 * shape-mismatched shared function). */
export function mergeProjectDefaultsForTest(parsed: ParsedAgentArgs, defaults: ProjectDefaults): ParsedAgentArgs {
  return {
    ...parsed,
    url: parsed.url ?? defaults.url,
    storageState: parsed.storageState ?? defaults.storageState,
    allowDeletes: parsed.allowDeletes ?? defaults.allowDeletes,
    maxSteps: parsed.maxSteps ?? defaults.maxSteps,
    headed: parsed.headed ?? defaults.headed,
  }
}

export function mergeProjectDefaultsForApi(parsed: ParsedApiArgs, defaults: ProjectDefaults): ParsedApiArgs {
  return {
    ...parsed,
    baseUrl: parsed.baseUrl ?? defaults.url,
    storageState: parsed.storageState ?? defaults.storageState,
    allowDeletes: parsed.allowDeletes || (defaults.allowDeletes ?? false),
    allowWrites: parsed.allowWrites || (defaults.allowWrites ?? false),
    allowHosts: parsed.allowHosts.length > 0 ? parsed.allowHosts : (defaults.allowHosts ?? []),
    maxSteps: parsed.maxSteps ?? defaults.maxSteps,
  }
}
