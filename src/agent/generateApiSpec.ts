import type { ApiAction, ApiTestRun, ExecutedApiStep } from './apiTypes'
import { parseJsonPath } from './jsonPath'
import { extractPlaceholderNames } from './apiExecutor'

function escapeTemplateLiteralSegment(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

function toJsIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, '_')
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

/** Renders a JSON-path-lite string (`"items[0].id"`) as a real, optional-
 * chained JS property accessor (`["items"]?.[0]?.["id"]`) — bracket
 * notation throughout, never `.name` dot access, so a field name that
 * isn't a valid JS identifier still round-trips correctly without a
 * separate validity check. Optional chaining between segments mirrors
 * `evaluateJsonPath`'s own "missing along the way is just not found, never
 * a throw" semantics in the generated code. */
function accessorFor(path: string): string {
  return parseJsonPath(path)
    .map((segment) => (segment.kind === 'field' ? `?.[${JSON.stringify(segment.name)}]` : `?.[${segment.index}]`))
    .join('')
}

/** Renders a `url`/header-value/`body` string as a real JS expression. A
 * string with no `{{var}}` reference becomes an ordinary `JSON.stringify`'d
 * literal. A string referencing one or more saved vars becomes a template
 * literal interpolating the real JS variable each `{{name}}` was bound to
 * by `renderRequestStep`'s own `const <jsVar> = ...json()...` — never the
 * value this particular run resolved it to. This is the same non-negotiable
 * principle `generateSpec.ts` already applies to login credentials (always
 * the symbolic reference, never the resolved secret), applied here to a
 * different kind of value that would otherwise go stale: a generated spec
 * hardcoding this run's actual `itemId` would break the moment it's re-run
 * against a server with different data. */
function renderVarAwareExpression(value: string, jsVarNameFor: Map<string, string>): string {
  if (extractPlaceholderNames(value).length === 0) return JSON.stringify(value)
  const parts = value.split(/(\{\{\w+\}\})/g)
  let template = '`'
  for (const part of parts) {
    const match = part.match(/^\{\{(\w+)\}\}$/)
    if (match) {
      const jsVar = jsVarNameFor.get(match[1])
      // parseApiAction already rejects an action referencing a var that
      // isn't in validVarNames before this run's history is even recorded
      // — so an executed, successful step can only ever reference a name
      // this map already has an entry for.
      template += `\${${jsVar}}`
    } else {
      template += escapeTemplateLiteralSegment(part)
    }
  }
  return template + '`'
}

function renderHeadersExpression(headers: Record<string, string> | undefined, jsVarNameFor: Map<string, string>): string | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined
  const entries = Object.entries(headers).map(([key, value]) => `${JSON.stringify(key)}: ${renderVarAwareExpression(value, jsVarNameFor)}`)
  return `{ ${entries.join(', ')} }`
}

interface RenderState {
  /** Maps a saved `{{name}}` to the real JS variable it was bound to. */
  jsVarNameFor: Map<string, string>
  /** Number of `request` steps rendered so far — names `res1`, `res2`, ... */
  requestCount: number
  /** The response variable name (`resN`) the most recently rendered
   * successful `request` step bound — what an `assert_*` step checks
   * against, mirroring `apiExecutor.ts`'s own `lastResponse` tracking:
   * only a successful request updates it, so a blocked/failed request
   * (never rendered at all) correctly leaves it pointing at whichever
   * earlier request last succeeded. */
  currentResVar?: string
  /** True once the generated file's `jsonValueToString` helper has been
   * emitted — only needed if the run actually used
   * `assert_json_path_equals`, so it's added lazily rather than always
   * present as unused code. */
  needsJsonValueToStringHelper: boolean
}

function renderRequestStep(action: Extract<ApiAction, { action: 'request' }>, state: RenderState): string[] {
  state.requestCount++
  const resVar = `res${state.requestCount}`
  state.currentResVar = resVar

  const urlExpr = renderVarAwareExpression(action.url, state.jsVarNameFor)
  const headersExpr = renderHeadersExpression(action.headers, state.jsVarNameFor)
  const bodyExpr = action.body !== undefined ? renderVarAwareExpression(action.body, state.jsVarNameFor) : undefined

  const initParts = [`method: ${JSON.stringify(action.method)}`]
  if (headersExpr) initParts.push(`headers: ${headersExpr}`)
  if (bodyExpr) initParts.push(`body: ${bodyExpr}`)

  const lines = [
    `  const ${resVar} = await fetch(${urlExpr}, { ${initParts.join(', ')} })`,
    `  const ${resVar}Body = await ${resVar}.text()`,
    `  let ${resVar}Json; try { ${resVar}Json = JSON.parse(${resVar}Body) } catch {}`,
  ]

  if (action.saveAs) {
    const jsVar = toJsIdentifier(action.saveAs.name)
    state.jsVarNameFor.set(action.saveAs.name, jsVar)
    lines.push(`  const ${jsVar} = ${resVar}Json${accessorFor(action.saveAs.path)}`)
  }

  return lines
}

function renderStep(step: ExecutedApiStep, state: RenderState): string[] | undefined {
  const action = step.action
  switch (action.action) {
    case 'request':
      return renderRequestStep(action, state)
    case 'assert_status':
      if (!state.currentResVar) return undefined
      return [`  assert.equal(${state.currentResVar}.status, ${action.expected})`]
    case 'assert_json_path_exists':
      if (!state.currentResVar) return undefined
      return [`  assert.notEqual(${state.currentResVar}Json${accessorFor(action.path)}, undefined)`]
    case 'assert_json_path_equals':
      if (!state.currentResVar) return undefined
      state.needsJsonValueToStringHelper = true
      return [`  assert.equal(jsonValueToString(${state.currentResVar}Json${accessorFor(action.path)}), ${JSON.stringify(action.expected)})`]
    case 'done':
      return undefined
  }
}

/** Turns one `ApiTestRun` into a real, standalone Node script — plain
 * `node:test` + `node:assert` + native `fetch`, zero new dependencies (see
 * DEVELOPMENT.md for why this project deliberately doesn't reuse
 * `@playwright/test`'s own `request` fixture here). Only successful steps
 * are included, same posture as `generateAgentSpec` — if the run ended in a
 * failure, whatever succeeded before that point is still real, working
 * coverage. Every chained value (`saveAs`/`{{var}}`) is re-derived as real
 * JS from the actual response, never frozen as this run's literal resolved
 * value — see `renderVarAwareExpression`. */
export function generateApiSpec(run: ApiTestRun): string {
  const successfulSteps = run.steps.filter((s) => s.ok)
  const state: RenderState = { jsVarNameFor: new Map(), requestCount: 0, needsJsonValueToStringHelper: false }
  const bodyLines: string[] = []

  for (const step of successfulSteps) {
    const rendered = renderStep(step, state)
    if (rendered) bodyLines.push(...rendered)
  }

  const lines: string[] = []
  lines.push(
    `// Auto-generated by five46 api from a real run against ${run.baseUrl}`,
    `// Goal: ${run.goal}`,
    `// Run ${run.runId} — outcome: ${run.outcome}`,
    ...(run.planStats ? [`// Structured plan: ${run.planStats.plannedSteps} step(s) planned upfront, ${run.planStats.fastPathedSteps} executed without a live LLM decision`] : []),
    `//`,
    `// Like five46 test's generated spec, this is a frozen recording of ONE`,
    `// specific run, not a deterministic re-derivation — re-run it any time with`,
    `// no five46/LLM involved. Requires Node >=18 for global fetch.`,
    `import { test } from 'node:test'`,
    `import assert from 'node:assert/strict'`,
    ``
  )

  if (state.needsJsonValueToStringHelper) {
    lines.push(
      `// Mirrors five46's own string-coerced comparison: a string value`,
      `// passes through unquoted, anything else is JSON.stringify'd.`,
      `function jsonValueToString(value) {`,
      `  if (value === undefined) return undefined`,
      `  if (typeof value === 'string') return value`,
      `  return JSON.stringify(value)`,
      `}`,
      ``
    )
  }

  lines.push(`test(${JSON.stringify(run.goal)}, async () => {`)

  if (bodyLines.length === 0) {
    lines.push(`  // No steps completed successfully in this run — nothing to replay.`)
  } else {
    lines.push(...bodyLines)
  }

  if (run.outcome === 'assertion-failed' || run.outcome === 'unparseable-response' || run.outcome === 'stuck-repeating' || run.outcome === 'stopped-by-cap') {
    lines.push(
      ``,
      `  // This run did not reach "goal-reached" (outcome: ${run.outcome}) — only the`,
      `  // steps above were confirmed working. See the printed failure report for detail.`
    )
  }

  lines.push(`})`, ``)
  return lines.join('\n')
}
