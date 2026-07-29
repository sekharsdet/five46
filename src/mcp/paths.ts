import { resolve, isAbsolute, relative, sep } from 'path'

export type ResolveMcpPathResult = { ok: true; path: string } | { ok: false; error: string }

/** Resolves a path parameter from an MCP tool call (`storageStatePath`/
 * `out`) against a human-configured project root — never lets a
 * less-trusted caller (the outer IDE assistant deciding tool arguments on
 * its own, not the human) name an arbitrary absolute path. An
 * unconstrained path parameter is a weak file-existence/readability oracle
 * (`loadStorageStateFile`'s three-way "couldn't read"/"not JSON"/"not a
 * storage-state file" error already tells a caller something about paths
 * it names) and, for a write target, an arbitrary-overwrite risk — bounding
 * it to "files under this project" closes that down to something with no
 * real information value beyond what the caller could already see in the
 * project itself.
 *
 * Rejects an absolute path outright, and separately re-derives the
 * relative position of the *resolved* path back to `projectRoot` — never
 * just string-checks for a literal `..` substring, since a naive substring
 * check both over-rejects a harmless name like `..foo` and under-rejects a
 * path that only escapes after normalization (e.g. mixed separators). A
 * genuinely escaping candidate is rejected, not silently clamped back
 * inside the root — a silent clamp changes what path was actually meant
 * without saying so, the same "never guess" posture used everywhere else
 * in this codebase. */
export function resolveMcpPath(projectRoot: string, candidate: string): ResolveMcpPathResult {
  if (isAbsolute(candidate)) {
    return { ok: false, error: `"${candidate}" must be a relative path, not absolute` }
  }
  const resolved = resolve(projectRoot, candidate)
  const rel = relative(projectRoot, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: `"${candidate}" escapes the project root` }
  }
  return { ok: true, path: resolved }
}
