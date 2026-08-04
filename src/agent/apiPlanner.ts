import type { ApiAction, ApiHistoryEntry, ApiPlan, HttpMethod, SafetyMode } from './apiTypes'
import { isMethodAllowed, isHostAllowed, effectiveMethod, VALID_METHODS } from './apiTypes'
import { extractPlaceholderNames } from './apiExecutor'
import { countConfirmationClauses } from './planner'

const MAX_HISTORY = 10

/** Shared with `apiFailureReport.ts` — one place describing what an
 * `ApiAction` did, so the prompt's history rendering and the printed
 * failure report can't drift into two slightly different descriptions of
 * the same action. */
export function describeApiAction(action: ApiAction): string {
  switch (action.action) {
    case 'request':
      return `${action.method} ${action.url}${action.saveAs ? ` (save "${action.saveAs.path}" as {{${action.saveAs.name}}})` : ''}`
    case 'assert_status':
      return `assert status === ${action.expected}`
    case 'assert_json_path_exists':
      return `assert "${action.path}" exists in the last response`
    case 'assert_json_path_equals':
      return `assert "${action.path}" === "${action.expected}"`
    case 'done':
      return `done (${action.outcome})`
  }
}

/** Same cap-and-disclose shape as `planner.ts`'s `serializeHistory` — each
 * step's response excerpt already carries its own truncation marker (see
 * `apiExecutor.ts`'s `RESPONSE_EXCERPT_LIMIT`), surfaced here as part of the
 * step's own detail line. */
export function serializeApiHistory(history: ApiHistoryEntry[]): string {
  if (history.length === 0) return '(no steps taken yet)'
  const recent = history.slice(-MAX_HISTORY)
  const omitted = history.length - recent.length
  const lines = recent.map((h, i) => {
    const stepNum = history.length - recent.length + i + 1
    return `${stepNum}. ${describeApiAction(h.action)} -> ${h.result}${h.detail ? `: ${h.detail}` : ''}`
  })
  if (omitted > 0) lines.unshift(`(${omitted} earlier step(s) omitted)`)
  return lines.join('\n')
}

function describeSafetyMode(safety: SafetyMode): string {
  const methods = ['GET', 'HEAD', 'OPTIONS']
  if (safety.allowWrites) methods.push('POST', 'PUT', 'PATCH')
  if (safety.allowDeletes) methods.push('DELETE')
  const hosts = [safety.targetOrigin, ...safety.allowedHosts].join(', ')
  return `Allowed methods this run: ${methods.join(', ')}. Allowed host(s): ${hosts}. Any other method or host will be rejected — don't attempt one.`
}

const ACTION_SCHEMA_EXAMPLE = `{"action":"request","method":"POST","url":"/users","headers":{"Content-Type":"application/json"},"body":"{\\"name\\":\\"Ada\\"}","saveAs":{"name":"userId","path":"id"},"reason":"create a user to test with"}`

/** Builds the "what's the next single action" prompt for API testing —
 * same single-shot-JSON-per-step shape as `planner.ts`'s
 * `buildActionPrompt`, for the identical reason (`LlmProvider.complete()`
 * has no tool-calling/JSON-mode hook). Tells the model the allowed
 * methods/hosts, the currently-available `{{var}}` names, and the
 * assertion-count requirement up front, rather than only rejecting a
 * disallowed/premature attempt after the fact — more turn/token-efficient
 * than only discovering either after a rejection. */
export function buildApiActionPrompt(goal: string, history: ApiHistoryEntry[], validVarNames: ReadonlySet<string>, safety: SafetyMode, clauses?: string[]): string {
  const clauseTrackingActive = !!clauses && clauses.length > 1
  // Unconditional — not gated on the goal's own wording containing
  // confirm/verify/etc. language. Mirrors planner.ts's buildActionPrompt
  // exactly (added at the same time, for the same live-found reason — see
  // countConfirmationClauses' own doc comment): apiRunner.ts requires this
  // many successful assert_status/assert_json_path_exists/
  // assert_json_path_equals actions before accepting goal-reached,
  // regardless of whether the goal text says "confirm"/"verify" at all.
  //
  // When `clauseTrackingActive` (mirrors planner.ts's buildActionPrompt's
  // identical switch exactly), this switches from a total count to
  // per-clause coverage — see DEVELOPMENT.md's gap #3.
  const requiredAssertionCount = Math.max(1, countConfirmationClauses(goal))
  const confirmationNote = clauseTrackingActive
    ? [
        ``,
        `This goal has ${clauses!.length} distinct things to confirm, listed below with their 0-based index. You must get a successful assert_status, assert_json_path_exists, or assert_json_path_equals for EACH one before you're allowed to declare "done" with outcome "goal-reached" — one clause's assertion does not count toward another; each needs its own real, matching check. When performing an assertion meant to satisfy one of these, include "clauseIndex": <its index> in that action's JSON. Declaring done with any clause unverified, or asserting something unrelated to the clause index you claim, will be rejected.`,
        ...clauses!.map((c, i) => `  ${i}. ${c}`),
      ]
    : [
        ``,
        `You must perform at least ${requiredAssertionCount} successful assert_status, assert_json_path_exists, or assert_json_path_equals action(s) before you're allowed to declare "done" with outcome "goal-reached" — this applies even if the goal above doesn't explicitly say "confirm"/"verify": a claimed success must always be backed by a real check, never just your own belief that you're finished. Declaring done without enough successful assertions will be rejected.`,
      ]
  // API-engine mirror of planner.ts's identical guard — see its own doc
  // comment for the live-found reasoning (the browser-engine version of
  // this exact gap: a persistent, always-true page element satisfying the
  // confirmation requirement above without proving anything). The API
  // analog is asserting against the wrong *response* — e.g. a generic
  // health-check-style endpoint, or a read that happened before the
  // request the goal is actually about — rather than the one response
  // that would only look this way if the goal's real action succeeded.
  // Guidance only, same as planner.ts's version: nothing here rejects a
  // technically-valid-but-unhelpful assertion mechanically.
  const assertionQualityNote = [
    ``,
    `When choosing what to assert, check the response from the request that actually reflects the goal's own outcome — not an unrelated or incidental response (e.g. a generic health-check-style endpoint, or an earlier read that happened before the action you're trying to verify) that would look the same regardless of whether your real action succeeded.`,
  ]
  const varsNote =
    validVarNames.size > 0
      ? [``, `Values saved so far, referenceable as {{name}} in a request's url/headers/body: ${[...validVarNames].join(', ')}`]
      : []
  // Same cache-friendly ordering as planner.ts's buildActionPrompt (see its
  // own doc comment for the full reasoning): static-across-every-turn
  // content (opener, goal, describeSafetyMode, confirmationNote) first,
  // per-turn-dynamic content (varsNote, history) last, with a short closing
  // reminder to recover the "recency effect" the reordering trades away.
  const clauseIndexHint = clauseTrackingActive ? `,"clauseIndex":<0-based index of the clause above this satisfies>` : ''
  return [
    `You are an API testing agent driving real HTTP requests toward one goal, one request/check at a time.`,
    ``,
    `Goal: ${goal}`,
    ...confirmationNote,
    ...assertionQualityNote,
    ``,
    describeSafetyMode(safety),
    ``,
    `Respond with exactly one JSON object describing the next single action to take, one of:`,
    `- {"action":"request","method":"<GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE>","url":"<url>","headers":{...},"body":"<text>","saveAs":{"name":"<var>","path":"<json.path>"},"reason":"<why>"} ("headers"/"body"/"saveAs" are all optional)`,
    `- {"action":"assert_status","expected":<number>,"reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_json_path_exists","path":"<json.path>","reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_json_path_equals","path":"<json.path>","expected":"<text>","reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"done","outcome":"goal-reached"|"goal-unreachable","reason":"<why>"} (choose "goal-unreachable" honestly when the goal's target genuinely does not exist in any response seen so far, and no further request implied by the goal is likely to surface it — never guess a field/path name that looks plausible instead of checking what is actually there)`,
    ``,
    `Example: ${ACTION_SCHEMA_EXAMPLE}`,
    ...varsNote,
    ``,
    `Steps taken so far:`,
    serializeApiHistory(history),
    ``,
    `Respond with ONLY the JSON object matching one of the schemas above — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Mirrors `planner.ts`'s identical `clauseIndexField` exactly (see its own
 * doc comment) — duplicated rather than imported, matching this file's
 * existing "each engine's parse layer is fully independent" convention
 * (this file already duplicates `isNonEmptyString` itself rather than
 * importing planner.ts's copy). Never an explicit `clauseIndex: undefined`,
 * which would break an exact-shape `assert.deepStrictEqual` test. */
function clauseIndexField(v: unknown): { clauseIndex: number } | Record<string, never> {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { clauseIndex: v } : {}
}

const API_PLAN_SCHEMA_EXAMPLE = `{"steps":[{"action":"request","method":"POST","url":"/users","body":"{\\"name\\":\\"Ada\\"}","saveAs":{"name":"userId","path":"id"},"reason":"create a user"},{"action":"request","method":"GET","url":"/users/{{userId}}","reason":"fetch it back"},{"action":"assert_json_path_equals","path":"name","expected":"Ada","reason":"confirm the name matches"},{"action":"done","outcome":"goal-reached","reason":"confirmed"}]}`

/** Builds the upfront "plan the whole goal" prompt for the API engine —
 * the same second-`complete()`-call pattern `planner.ts`'s `buildPlanPrompt`
 * uses for the browser engine, made once before the main loop, only when
 * `RunApiTestOptions.useStructuredPlan` is set (see `apiRunner.ts`). No
 * `PageOutline`-equivalent input is needed: unlike a DOM element, a planned
 * request's `url`/`method` has no structural ambiguity to predict around.
 *
 * `clauses`, when passed (only ever 2+ entries — mirrors
 * `buildApiActionPrompt`'s identical gate), asks the plan itself to predict
 * each assertion step's `clauseIndex` upfront — necessary since the fast
 * path never calls this file's per-step schema at all; see `apiRunner.ts`'s
 * fast-path clauseIndex refusal rule. */
export function buildApiPlanPrompt(goal: string, safety: SafetyMode, clauses?: string[]): string {
  const clauseNote =
    clauses && clauses.length > 1
      ? [
          ``,
          `This goal has ${clauses.length} distinct things to confirm, listed below with their 0-based index. Every assert_status/assert_json_path_exists/assert_json_path_equals step in your plan must include "clauseIndex": <the index of the clause it's meant to satisfy>, and the plan must cover all of them before its final "done" step.`,
          ...clauses.map((c, i) => `  ${i}. ${c}`),
        ]
      : []
  const clauseIndexHint = clauses && clauses.length > 1 ? `,"clauseIndex":<0-based index of the clause above this satisfies>` : ''
  return [
    `You are an API testing agent. Before making any requests, plan out the whole sequence of steps needed to accomplish this goal.`,
    ``,
    `Goal: ${goal}`,
    ...clauseNote,
    ``,
    describeSafetyMode(safety),
    ``,
    `Respond with exactly one JSON object: {"steps": [...]}, where each step is one of:`,
    `- {"action":"request","method":"<GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE>","url":"<url>","headers":{...},"body":"<text>","saveAs":{"name":"<var>","path":"<json.path>"},"reason":"<why>"}`,
    `- {"action":"assert_status","expected":<number>,"reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_json_path_exists","path":"<json.path>","reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_json_path_equals","path":"<json.path>","expected":"<text>","reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"done","outcome":"goal-reached"|"goal-unreachable","reason":"<why>"} (a plan is made BEFORE any request has actually been sent — you have no real response yet to judge "unreachable" against, only your own assumptions about how this API probably behaves. Only plan a "goal-unreachable" done step here if the goal itself is genuinely impossible to express as a sequence of requests (e.g. it asks for an operation no reasonable API of this kind would expose at all). If you are just unsure whether the API will actually behave as expected — including a well-known public API you assume you already know — plan the real requests anyway; a live decision later, made against real responses, is what should determine reachability, not a guess made now)`,
    ``,
    `A later step can reference a value an earlier step saved via "saveAs" as {{name}} in its own url/headers/body — plan the chain in order. Keep the plan as short as the goal genuinely requires, and end it with a "done" step.`,
    ``,
    `Example: ${API_PLAN_SCHEMA_EXAMPLE}`,
    ``,
    `Respond with ONLY the JSON object — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

/** Structural-only parsing for one planned step — deliberately narrower
 * than `parseApiAction`'s `case 'request'` branch: no `isMethodAllowed`/
 * `isHostAllowed`/`checkVarReferences` check here. Those are execution-time
 * concerns (see `apiRunner.ts`'s fast path, which re-runs them explicitly
 * right before a fast-pathed request executes — the fix for this whole
 * feature's top risk, same as the browser engine's destructive-click gate).
 * Validating them at *plan*-parse time would also be actively wrong: a
 * step may legitimately reference a `{{var}}` a *later* step in the same
 * plan hasn't saved yet, which is only unresolved at parse time, not at
 * the time this step will actually execute. */
function parsePlannedApiStep(raw: unknown): ApiAction | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const reason = isNonEmptyString(obj.reason) ? obj.reason : '(no reason given)'

  switch (obj.action) {
    case 'request': {
      const method = typeof obj.method === 'string' ? (obj.method.toUpperCase() as HttpMethod) : undefined
      if (!method || !VALID_METHODS.has(method) || !isNonEmptyString(obj.url)) return undefined
      const headers = obj.headers && typeof obj.headers === 'object' ? (obj.headers as Record<string, string>) : undefined
      const body = typeof obj.body === 'string' ? obj.body : undefined
      let saveAs: { name: string; path: string } | undefined
      if (obj.saveAs && typeof obj.saveAs === 'object') {
        const s = obj.saveAs as Record<string, unknown>
        if (!isNonEmptyString(s.name) || !isNonEmptyString(s.path)) return undefined
        saveAs = { name: s.name, path: s.path }
      }
      return { action: 'request', method, url: obj.url, headers, body, saveAs, reason }
    }
    case 'assert_status':
      return typeof obj.expected === 'number' ? { action: 'assert_status', expected: obj.expected, reason, ...clauseIndexField(obj.clauseIndex) } : undefined
    case 'assert_json_path_exists':
      return isNonEmptyString(obj.path) ? { action: 'assert_json_path_exists', path: obj.path, reason, ...clauseIndexField(obj.clauseIndex) } : undefined
    case 'assert_json_path_equals':
      return isNonEmptyString(obj.path) && isNonEmptyString(obj.expected)
        ? { action: 'assert_json_path_equals', path: obj.path, expected: obj.expected, reason, ...clauseIndexField(obj.clauseIndex) }
        : undefined
    case 'done': {
      const outcome = obj.outcome === 'goal-reached' || obj.outcome === 'goal-unreachable' ? obj.outcome : undefined
      return outcome ? { action: 'done', outcome, reason } : undefined
    }
    default:
      return undefined
  }
}

export type ParseApiPlanResult = { ok: true; plan: ApiPlan } | { ok: false; error: string; raw: string }

/** Strictly parses a plan response, or an honest failure — mirroring
 * `planner.ts`'s `parsePlan` exactly, including its "never fatal" posture:
 * `apiRunner.ts` treats a malformed plan response as "skip structured
 * planning for this run," not as a run-ending `unparseable-response`. See
 * `parsePlan`'s own doc comment for the full reasoning. */
export function parseApiPlan(raw: string): ParseApiPlanResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, error: 'plan response was not valid JSON', raw }
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).steps)) {
    return { ok: false, error: 'plan response was not a JSON object with a "steps" array', raw }
  }

  const steps: ApiAction[] = []
  for (const rawStep of (parsed as { steps: unknown[] }).steps) {
    const step = parsePlannedApiStep(rawStep)
    if (!step) return { ok: false, error: 'plan contained a malformed or unrecognized step', raw }
    steps.push(step)
  }
  if (steps.length === 0) return { ok: false, error: 'plan contained no steps', raw }
  // Mirrors `planner.ts`'s `parsePlan` exactly — see its own doc comment
  // for the full reasoning (a real, live-repeated failure: a CRUD goal
  // against jsonplaceholder.typicode.com produced a 1-step immediate-done
  // plan twice, with zero real requests attempted, and prompt-only
  // guidance against this was live-retested and did not fix it).
  if (steps.every((s) => s.action === 'done')) {
    return { ok: false, error: 'plan consists only of an immediate "done" step, with no real action ever attempted — falling back to a live decision so the model has to gather real evidence first', raw }
  }
  return { ok: true, plan: { steps } }
}

/** Exported so `apiRunner.ts`'s fast path can run the identical check right
 * before executing a fast-pathed `request` step — the same "one source of
 * truth, called from both the parser and the fast path" pattern already
 * used for `isMethodAllowed`/`isHostAllowed`. */
export function checkVarReferences(fields: (string | undefined)[], validVarNames: ReadonlySet<string>): string | undefined {
  for (const field of fields) {
    if (!field) continue
    for (const name of extractPlaceholderNames(field)) {
      if (!validVarNames.has(name)) return `references "{{${name}}}", which hasn't been saved yet this run`
    }
  }
  return undefined
}

/** The result of parsing one raw LLM response. A failure is split into two
 * kinds, mirroring the distinction the plan draws between "the model said
 * something incoherent" and "the model asked for something real but
 * disallowed":
 * - `recoverable: false` — malformed JSON, an unrecognized action, or a
 *   missing required field. Nothing usable was even said; the caller ends
 *   the run as `unparseable-response`, same as `parseAgentAction`'s only
 *   failure mode.
 * - `recoverable: true` (with `attemptedAction` populated) — a
 *   *structurally valid* `request` naming a disallowed method/host, or
 *   referencing an unsaved `{{var}}`. This is the API equivalent of a
 *   failed `click`/`fill`: a real, well-formed attempt that just didn't
 *   succeed. The caller records it as a failed step and keeps going —
 *   ending the whole run the first time the model tries a write in
 *   read-only mode would make read-only mode nearly unusable. */
export type ParseApiActionResult =
  | { ok: true; action: ApiAction }
  | { ok: false; error: string; raw: string; recoverable: false }
  | { ok: false; error: string; raw: string; recoverable: true; attemptedAction: ApiAction }

/** Strictly parses one raw LLM response into an `ApiAction`, or an honest
 * failure — never a guessed fallback, mirroring `parseAgentAction` exactly.
 * Also checks, at this same layer, whether a `request` names a disallowed
 * method/host (`SafetyMode`) or references an unsaved `{{var}}` — the same
 * "a hallucinated reference is a parse-level failure, never silently
 * accepted" posture `parseAgentAction` already applies to an unrecognized
 * `ref`, but marked `recoverable` (see `ParseApiActionResult`) so the caller
 * can tell it apart from genuinely malformed output. */
export function parseApiAction(raw: string, validVarNames: ReadonlySet<string>, safety: SafetyMode): ParseApiActionResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, error: 'response was not valid JSON', raw, recoverable: false }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'response was not a JSON object', raw, recoverable: false }
  }
  const obj = parsed as Record<string, unknown>
  const action = obj.action
  const reason = isNonEmptyString(obj.reason) ? obj.reason : '(no reason given)'

  switch (action) {
    case 'request': {
      const method = typeof obj.method === 'string' ? (obj.method.toUpperCase() as HttpMethod) : undefined
      if (!method || !VALID_METHODS.has(method)) {
        return { ok: false, error: `"method" must be one of ${[...VALID_METHODS].join(', ')}`, raw, recoverable: false }
      }
      if (!isNonEmptyString(obj.url)) return { ok: false, error: '"url" is missing', raw, recoverable: false }
      const headers = obj.headers && typeof obj.headers === 'object' ? (obj.headers as Record<string, string>) : undefined
      const body = typeof obj.body === 'string' ? obj.body : undefined
      let saveAs: { name: string; path: string } | undefined
      if (obj.saveAs && typeof obj.saveAs === 'object') {
        const s = obj.saveAs as Record<string, unknown>
        if (!isNonEmptyString(s.name) || !isNonEmptyString(s.path)) {
          return { ok: false, error: '"saveAs" must have non-empty "name" and "path"', raw, recoverable: false }
        }
        saveAs = { name: s.name, path: s.path }
      }
      const attempted: ApiAction = { action: 'request', method, url: obj.url, headers, body, saveAs, reason }

      // Checked against the *effective* method, not just the literally
      // declared one — a request carrying a method-override header/param
      // could otherwise execute as something isMethodAllowed never actually
      // gated. See effectiveMethod's own doc comment for the real, live
      // finding that motivated this.
      const effective = effectiveMethod(method, obj.url, headers)
      if (!isMethodAllowed(effective, safety)) {
        const overrideNote = effective !== method ? ` (effectively ${effective} via a method-override header/param)` : ''
        return {
          ok: false,
          error: `method "${method}"${overrideNote} is not allowed this run (see --allow-writes/--allow-deletes)`,
          raw,
          recoverable: true,
          attemptedAction: attempted,
        }
      }
      if (!isHostAllowed(obj.url, safety)) {
        return {
          ok: false,
          error: `"${obj.url}" is not the target origin or an allowlisted host (see --allow-host)`,
          raw,
          recoverable: true,
          attemptedAction: attempted,
        }
      }
      const varError = checkVarReferences([obj.url, body, ...(headers ? Object.values(headers) : [])], validVarNames)
      if (varError) return { ok: false, error: varError, raw, recoverable: true, attemptedAction: attempted }

      return { ok: true, action: attempted }
    }
    case 'assert_status': {
      if (typeof obj.expected !== 'number') return { ok: false, error: '"expected" must be a number for assert_status', raw, recoverable: false }
      return { ok: true, action: { action: 'assert_status', expected: obj.expected, reason, ...clauseIndexField(obj.clauseIndex) } }
    }
    case 'assert_json_path_exists': {
      if (!isNonEmptyString(obj.path)) return { ok: false, error: '"path" is missing for assert_json_path_exists', raw, recoverable: false }
      return { ok: true, action: { action: 'assert_json_path_exists', path: obj.path, reason, ...clauseIndexField(obj.clauseIndex) } }
    }
    case 'assert_json_path_equals': {
      if (!isNonEmptyString(obj.path)) return { ok: false, error: '"path" is missing for assert_json_path_equals', raw, recoverable: false }
      if (!isNonEmptyString(obj.expected)) return { ok: false, error: '"expected" is missing for assert_json_path_equals', raw, recoverable: false }
      return { ok: true, action: { action: 'assert_json_path_equals', path: obj.path, expected: obj.expected, reason, ...clauseIndexField(obj.clauseIndex) } }
    }
    case 'done': {
      const outcome = obj.outcome === 'goal-reached' || obj.outcome === 'goal-unreachable' ? obj.outcome : undefined
      if (!outcome) return { ok: false, error: '"outcome" must be "goal-reached" or "goal-unreachable"', raw, recoverable: false }
      return { ok: true, action: { action: 'done', outcome, reason } }
    }
    default:
      return { ok: false, error: `unrecognized "action" value: ${JSON.stringify(action)}`, raw, recoverable: false }
  }
}
