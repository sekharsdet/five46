export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface FieldSegment {
  kind: 'field'
  name: string
}
interface IndexSegment {
  kind: 'index'
  index: number
}
type PathSegment = FieldSegment | IndexSegment

/** Parses a small, deliberately limited subset of JSONPath-like syntax:
 * dot-separated field names and `[n]` array indices, e.g.
 * `"user.addresses[0].city"` (a leading dot is optional). Not full
 * JSONPath — no wildcards, filters, slices, or expressions — enough for
 * the common "read one field, possibly nested/indexed" case this feature
 * needs, without the complexity (or security surface — this is a plain
 * regex scan, never `eval`/`new Function` on the path text) of a general
 * expression language. Never throws on malformed input; a path that
 * doesn't resolve to anything is `evaluateJsonPath`'s/the caller's problem
 * to treat as an honest failure, not this function's job to guess at. */
export function parseJsonPath(path: string): PathSegment[] {
  const segments: PathSegment[] = []
  const pattern = /([^.[\]]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(path)) !== null) {
    if (match[1] !== undefined) segments.push({ kind: 'field', name: match[1] })
    else if (match[2] !== undefined) segments.push({ kind: 'index', index: Number(match[2]) })
  }
  return segments
}

/** Walks a parsed JSON value along `path`'s segments, returning `undefined`
 * (never throwing) the moment the path doesn't resolve — a missing field, an
 * out-of-range index, or indexing into something that isn't the expected
 * shape (e.g. `[0]` on a plain object) are all just "not found," the same
 * honest-failure posture as an unresolved `ref`/`{{var}}` elsewhere in this
 * codebase. */
export function evaluateJsonPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const segment of parseJsonPath(path)) {
    if (current === null || current === undefined) return undefined
    if (segment.kind === 'field') {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as { [key: string]: JsonValue })[segment.name]
    } else {
      if (!Array.isArray(current)) return undefined
      current = current[segment.index]
    }
  }
  return current
}

/** For interpolating an extracted value into a URL/header/body string
 * (`saveAs`) or comparing it as text (`assert_json_path_equals`). A string
 * value passes through unquoted (the common case — an id, a name); any
 * other JSON value (number, boolean, null, object, array) is rendered via
 * `JSON.stringify` so it's still a real, meaningful representation rather
 * than JS's default `[object Object]`/`String(value)` coercion. */
export function jsonValueToString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
