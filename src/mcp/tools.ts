import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getLlmProvider } from '../llm/registry'
import { resolveCredentials } from '../config/resolve'
import { resolveApiAuthHeaders } from '../agent/credentials'
import { redactSecrets } from '../agent/redact'
import { runAgent } from '../agent/runner'
import { AgentBrowserUnavailableError } from '../agent/browser'
import type { StorageState } from '../agent/browser'
import { generateAgentSpec } from '../agent/generateSpec'
import { formatFailureReport } from '../agent/failureReport'
import { runApiTest } from '../agent/apiRunner'
import { generateApiSpec } from '../agent/generateApiSpec'
import { formatApiFailureReport } from '../agent/apiFailureReport'
import type { SafetyMode } from '../agent/apiTypes'
import type { LlmProvider } from '../llm/types'
import { resolveMcpPath } from './paths'
import { generateRootCauseHypothesis } from '../agent/rootCause'
import { generateApiRootCauseHypothesis } from '../agent/apiRootCause'
import { splitUserStory } from '../agent/storySplitter'
import { runWithConcurrency } from '../agent/concurrencyPool'
import { HARD_MAX_SCENARIOS } from '../agent/runLoop'

/** Read once at server construction (see `server.ts`) — never re-derived
 * from a tool call's own arguments. `allowWrites`/`allowDeletes` are only
 * ever unlockable by the human setting an env var when configuring the MCP
 * server itself; no tool input schema exposes them at all, so there is no
 * code path by which a tool call's own arguments could influence them.
 * `projectRoot` bounds every path a tool call can name (see `paths.ts`) —
 * an MCP tool's caller is the IDE's own AI assistant, not the human at the
 * moment of the call, so nothing here is allowed to trust a caller-chosen
 * absolute path the way the CLI trusts a human-typed one.
 *
 * `provider`/`apiKey` are an injectable override, present only in tests —
 * production (`server.ts`, given no override) always falls through to the
 * same real `resolveCredentials()`/`getLlmProvider()` path the CLI uses.
 * This is the same "mock only the true external boundary" seam every other
 * engine test in this codebase already uses (a fake `LlmProvider`), just
 * threaded through the MCP context instead of a direct function argument. */
export interface McpToolContext {
  projectRoot: string
  allowWrites: boolean
  allowDeletes: boolean
  /** Bounded-concurrency cap for `story` mode — see `DEFAULT_CONCURRENCY`/
   * `HARD_MAX_CONCURRENCY` (runLoop.ts). Sourced only from
   * `FIVE46_MCP_CONCURRENCY` at server construction (`server.ts`), never a
   * per-call tool argument — same "cost/rate-limit-affecting parameter stays
   * off the calling AI's side" precedent as `allowWrites`/`allowDeletes`.
   * Always a resolved number by the time a tool handler sees it (`server.ts`
   * applies the default before constructing this context), unlike those two
   * only in that there's no meaningful "unset" state to preserve here. */
  concurrency: number
  provider?: LlmProvider
  apiKey?: string
}

/** Mirrors `schemas.ts`'s `toolOutputSchema` exactly — the MCP SDK
 * (`@modelcontextprotocol/sdk@^1.30.0`) strictly validates a non-error
 * result's `structuredContent` against that Zod shape, so this TS type and
 * that schema must never drift apart. */
export interface StructuredToolOutput {
  passed: boolean
  outcome?: string
  specPath?: string
  acceptanceCriteria?: { index: number; goal: string; outcome: string; passed: boolean; specPath?: string }[]
  // Matches the MCP SDK's own expected shape for `structuredContent`
  // (a plain JSON object, index-signature-compatible) — same reasoning as
  // `McpToolResult`'s identical escape hatch just above.
  [key: string]: unknown
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  /** Additive, machine-parseable parallel channel alongside `content`'s
   * free text — see `StructuredToolOutput`'s own doc comment. Omitted
   * entirely on an early validation error (a missing goal/story, a bad
   * baseUrl, ...) — nothing ever ran, so there's honestly nothing
   * structural to report; the MCP SDK only requires it on a non-error
   * result anyway. */
  structuredContent?: StructuredToolOutput
  // Matches the MCP SDK's own CallToolResult shape, which allows arbitrary
  // extra fields per the JSON-RPC spec's extensibility — required for this
  // type to satisfy registerTool's handler return type structurally.
  [key: string]: unknown
}

function textResult(text: string, structuredContent?: StructuredToolOutput): McpToolResult {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) }
}

function errorResult(text: string, structuredContent?: StructuredToolOutput): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true, ...(structuredContent ? { structuredContent } : {}) }
}

export interface TestToolParams {
  url: string
  /** Exactly one of `goal`/`story` is required — validated in
   * `runTestTool` itself (not expressible directly in the Zod input shape;
   * see `schemas.ts`'s comment on the pair). */
  goal?: string
  story?: string
  maxSteps?: number
  headed?: boolean
  storageStatePath?: string
}

function validateGoalOrStory(params: { goal?: string; story?: string }): { ok: true } | { ok: false; error: string } {
  if (!params.goal && !params.story) return { ok: false, error: 'exactly one of "goal"/"story" is required' }
  if (params.goal && params.story) return { ok: false, error: '"goal" and "story" are mutually exclusive — provide exactly one' }
  return { ok: true }
}

/** Loads and minimally validates a `five46 login`-produced session
 * file, the same shape `cli.ts`'s own `loadStorageStateFile` checks —
 * duplicated rather than imported, since that function reports its failure
 * via `console.error` (a side effect we can't reuse: this needs the reason
 * back as data, to put in the tool's own returned `content`, not as a
 * console print an MCP client would never see). */
function loadStorageStateFile(path: string): { ok: true; state: StorageState } | { ok: false; error: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, error: `couldn't read the storage state file at ${path}: ${err instanceof Error ? err.message : String(err)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: `"${path}" isn't valid JSON — expected a session file written by "five46 login"` }
  }
  const candidate = parsed as { cookies?: unknown; origins?: unknown }
  if (!Array.isArray(candidate.cookies) || !Array.isArray(candidate.origins)) {
    return { ok: false, error: `"${path}" doesn't look like a storage-state file (missing "cookies"/"origins" arrays)` }
  }
  return { ok: true, state: parsed as StorageState }
}

/** One single-goal browser run — the shared core of `runTestTool`'s
 * `goal` path and its `story` path's per-scenario calls. **Never throws,
 * always resolves** — every error, not just `AgentBrowserUnavailableError`,
 * is caught and returned as a `tooling-error` outcome. This matters far
 * more here than it looks: in `story` mode each scenario's call runs as
 * one task inside `runWithConcurrency`'s shared `Promise.all` — a single
 * rejected task aborts the *entire* batch, discarding every other
 * scenario's already-completed result along with it, not just failing the
 * one scenario that hit the error. Found via a deliberate review of this
 * exact risk (an untested edge case, not a live incident): the original
 * version only caught `AgentBrowserUnavailableError` from the `runAgent`
 * call and left the report-generation/write step after it completely
 * unguarded, so either an unexpected exception from `runAgent` or a write
 * failure afterward (a full disk, an unwritable directory) would silently
 * sink an entire multi-scenario batch. */
async function runOneTestScenario(
  url: string,
  goal: string,
  maxSteps: number | undefined,
  headed: boolean | undefined,
  storageState: StorageState | undefined,
  provider: LlmProvider,
  llmApiKey: string,
  allowDeletes: boolean,
  projectRoot: string,
  artifactSuffix: string
): Promise<{ outcome: string; text: string; specPath?: string }> {
  const artifactDir = join(projectRoot, `five46-mcp-agent-${artifactSuffix}`)
  const destructiveClicks: string[] = []
  let run
  try {
    run = await runAgent({
      url,
      goal,
      provider,
      apiKey: llmApiKey,
      maxSteps,
      headless: !headed,
      artifactDir,
      storageState,
      allowDeletes,
      onDestructiveClick: (name, reason) => destructiveClicks.push(`clicked "${name}" (${reason})`),
    })
  } catch (err) {
    if (err instanceof AgentBrowserUnavailableError) return { outcome: 'tooling-error', text: err.message }
    return { outcome: 'tooling-error', text: redactSecrets(err instanceof Error ? err.message : String(err), [llmApiKey]) }
  }

  try {
    const destructiveSection =
      destructiveClicks.length > 0 ? `\n\nDestructive click(s) performed during this run:\n${destructiveClicks.map((w) => `  -> ${w}`).join('\n')}` : ''
    // Always on for MCP (no per-call flag — see `--no-root-cause`'s CLI-only
    // scope in cli.ts) — one bounded extra call against a run that may
    // already be up to 50 steps, and this tool's parameter surface
    // deliberately carries no cost/safety toggles for the calling AI.
    const rootCauseHypothesis = run.outcome === 'assertion-failed' ? await generateRootCauseHypothesis(run, provider, llmApiKey) : undefined
    const reportText = redactSecrets(formatFailureReport(run, rootCauseHypothesis) + destructiveSection, [llmApiKey])
    const outPath = join(projectRoot, `five46-agent-${run.runId}.spec.ts`)
    writeFileSync(outPath, redactSecrets(generateAgentSpec(run), [llmApiKey]), 'utf8')

    return { outcome: run.outcome, text: `${reportText}\n\nWrote ${run.steps.filter((s) => s.ok).length} confirmed-working step(s) to ${outPath}`, specPath: outPath }
  } catch (err) {
    return {
      outcome: 'tooling-error',
      text: `run reached outcome "${run.outcome}" but failed while writing its report/spec: ${redactSecrets(err instanceof Error ? err.message : String(err), [llmApiKey])}`,
    }
  }
}

/** `five46_test`'s MCP handler — mirrors `cli.ts`'s `runE2eTest`/
 * `runStoryScenarios` in what it does, but never calls `console.log`: a
 * stdio MCP server's stdout is the literal JSON-RPC transport, so every
 * disclosure/progress line that would print live on the CLI is instead
 * collected into the single returned `content` block once the run(s)
 * complete. No `out` parameter — the generated spec's path is always
 * auto-derived under `context.projectRoot`, never caller-chosen, so
 * there's no write-path parameter to validate at all for the output
 * artifact (only `storageStatePath`, a read, goes through
 * `resolveMcpPath`).
 *
 * `story` mode (params.story set): splits the raw story into independent
 * goals (`splitUserStory`, storySplitter.ts), then runs each one through
 * `runOneTestScenario` with up to `context.concurrency` in flight at once
 * (`runWithConcurrency`, concurrencyPool.ts) — the exact same engine call
 * per scenario as the ordinary `goal` path, so every existing safety/speed
 * mechanism applies automatically. Returns one aggregated per-AC report;
 * `isError` unless every scenario reached `goal-reached`, mirroring the
 * single-goal path's own isError-mirrors-CI-gating rule. */
export async function runTestTool(params: TestToolParams, context: McpToolContext): Promise<McpToolResult> {
  const validation = validateGoalOrStory(params)
  if (!validation.ok) return errorResult(validation.error)

  // Declared here (not inside the inner try) so the outer catch can still
  // redact using whatever was actually resolved by the time an error hit —
  // this function's secrets list must never be empty, and the outer catch
  // must always redact, since any thrown error — including a provider
  // exception, the likeliest place a raw secret could appear — would
  // otherwise reach the MCP client as plain text.
  let llmApiKey: string | undefined
  try {
    let provider: LlmProvider
    if (context.provider && context.apiKey) {
      provider = context.provider
      llmApiKey = context.apiKey
    } else {
      const resolved = resolveCredentials()
      if (!resolved.llmApiKey) {
        return errorResult(
          'five46 requires an LLM API key. Set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY in the environment the MCP server runs under, or run `five46 config` once beforehand.'
        )
      }
      provider = getLlmProvider(resolved.llmProvider || 'openai')
      llmApiKey = resolved.llmApiKey
    }

    let storageState: StorageState | undefined
    if (params.storageStatePath) {
      const resolvedPath = resolveMcpPath(context.projectRoot, params.storageStatePath)
      if (!resolvedPath.ok) return errorResult(resolvedPath.error)
      const loaded = loadStorageStateFile(resolvedPath.path)
      if (!loaded.ok) return errorResult(loaded.error)
      storageState = loaded.state
    }

    if (params.story) {
      const { goals, clamped } = await splitUserStory(params.story, provider, llmApiKey)
      const clampNote = clamped ? `Note: the story split into more scenarios than the cap of ${HARD_MAX_SCENARIOS} — running the first ${HARD_MAX_SCENARIOS} only.\n\n` : ''

      const batchId = Date.now().toString(36)
      const tasks = goals.map((goal, i) => async () => {
        const result = await runOneTestScenario(params.url, goal, params.maxSteps, params.headed, storageState, provider, llmApiKey!, context.allowDeletes, context.projectRoot, `${batchId}-ac${i + 1}`)
        return { goal, result }
      })
      const outcomes = await runWithConcurrency(tasks, Math.max(1, context.concurrency))

      let allPassed = true
      let passedCount = 0
      const acceptanceCriteria: StructuredToolOutput['acceptanceCriteria'] = []
      const lines = outcomes.map(({ goal, result }, i) => {
        const passed = result.outcome === 'goal-reached'
        if (passed) passedCount++
        else allPassed = false
        acceptanceCriteria!.push({ index: i + 1, goal, outcome: result.outcome, passed, specPath: result.specPath })
        const header = `AC${i + 1}: ${passed ? 'PASS' : `FAIL (${result.outcome})`} — ${goal}`
        return passed ? header : `${header}\n${result.text}`
      })
      const finalText = `${clampNote}Split into ${goals.length} scenario(s). ${passedCount}/${goals.length} acceptance criteria reached goal-reached.\n\n${lines.join('\n\n')}`
      const structuredContent: StructuredToolOutput = { passed: allPassed, acceptanceCriteria }
      return allPassed ? textResult(finalText, structuredContent) : errorResult(finalText, structuredContent)
    }

    const runId = Date.now().toString(36)
    const { outcome, text, specPath } = await runOneTestScenario(
      params.url,
      params.goal!,
      params.maxSteps,
      params.headed,
      storageState,
      provider,
      llmApiKey,
      context.allowDeletes,
      context.projectRoot,
      runId
    )
    // isError mirrors the CLI's CI-gating exit-code rule exactly (see
    // DEVELOPMENT.md's "CI gating: exit codes" section): the calling IDE
    // AI is exactly the kind of automated consumer that feature was built
    // for, and needs the same one clear signal a human reading exit codes
    // gets — not just report text it has to parse to learn the run failed.
    const passed = outcome === 'goal-reached'
    const structuredContent: StructuredToolOutput = { passed, outcome, specPath }
    return passed ? textResult(text, structuredContent) : errorResult(text, structuredContent)
  } catch (err) {
    return errorResult(redactSecrets(err instanceof Error ? err.message : String(err), [llmApiKey]))
  }
}

export interface ApiToolParams {
  baseUrl: string
  /** Exactly one of `goal`/`story` is required — same rule as
   * `TestToolParams`, validated via the same `validateGoalOrStory`. */
  goal?: string
  story?: string
  maxSteps?: number
}

/** One single-goal API run — the shared core of `runApiTool`'s `goal` path
 * and its `story` path's per-scenario calls. Mirrors `runOneTestScenario`'s
 * shape/reasoning for the API engine — **never throws, always resolves**,
 * for the identical "one rejected task aborts the whole `story`-mode batch"
 * reason (see its own doc comment). Previously had no error handling at
 * all here (no browser dependency, so no `AgentBrowserUnavailableError`
 * equivalent was ever added) — an unexpected `runApiTest` exception or a
 * write failure afterward would have propagated straight up uncaught. */
async function runOneApiScenario(
  baseUrl: string,
  goal: string,
  maxSteps: number | undefined,
  safety: SafetyMode,
  authHeaders: Record<string, string> | undefined,
  provider: LlmProvider,
  llmApiKey: string,
  projectRoot: string,
  secrets: (string | undefined)[]
): Promise<{ outcome: string; text: string; specPath?: string }> {
  try {
    const writes: string[] = []
    const run = await runApiTest({
      baseUrl,
      goal,
      provider,
      apiKey: llmApiKey,
      maxSteps,
      safety,
      authHeaders,
      onWrite: (method, url, reason) => writes.push(`${method} ${url} (${reason})`),
    })

    const writesSection = writes.length > 0 ? `\n\nWrites performed during this run:\n${writes.map((w) => `  -> ${w}`).join('\n')}` : ''
    const rootCauseHypothesis = run.outcome === 'assertion-failed' ? await generateApiRootCauseHypothesis(run, provider, llmApiKey) : undefined
    const reportText = redactSecrets(formatApiFailureReport(run, rootCauseHypothesis) + writesSection, secrets)

    const outPath = join(projectRoot, `five46-api-${run.runId}.test.mjs`)
    writeFileSync(outPath, redactSecrets(generateApiSpec(run), secrets), 'utf8')

    return { outcome: run.outcome, text: `${reportText}\n\nWrote ${run.steps.filter((s) => s.ok).length} confirmed-working step(s) to ${outPath}`, specPath: outPath }
  } catch (err) {
    return { outcome: 'tooling-error', text: redactSecrets(err instanceof Error ? err.message : String(err), secrets) }
  }
}

/** `five46_api`'s MCP handler — mirrors `cli.ts`'s `runApiTestCommand`/
 * `runApiStoryScenarios`, with the same "collect, don't print live"
 * adaptation for stdio as `runTestTool`. `allowWrites`/`allowDeletes` come
 * only from `context` (server-startup env vars) — the tool's own input
 * schema has no such fields, so there is no argument path that could set
 * them. `allowedHosts` is always empty: no host-allowlist parameter in v1,
 * closing an SSRF-shaped gap an exposed `allowHosts` parameter would
 * otherwise open (an outer, less-trusted caller directing requests at
 * arbitrary internal hosts even with writes fully closed off). Real-time
 * write visibility (`onWrite`, a live console banner on the CLI) is
 * collected into an ordered list and folded into the final report instead —
 * MCP progress notifications are a named, deferred enhancement, not built
 * here.
 *
 * `story` mode: same design as `runTestTool`'s — see its doc comment. */
export async function runApiTool(params: ApiToolParams, context: McpToolContext): Promise<McpToolResult> {
  const validation = validateGoalOrStory(params)
  if (!validation.ok) return errorResult(validation.error)

  // Same reasoning as runTestTool: hoisted above the try so the outer catch
  // can redact with them, and kept in sync with llmApiKey as soon as it's
  // resolved (see below) so no window exists where a thrown error would
  // redact against an incomplete list.
  let llmApiKey: string | undefined
  let secrets: (string | undefined)[] = []
  try {
    let provider: LlmProvider
    if (context.provider && context.apiKey) {
      provider = context.provider
      llmApiKey = context.apiKey
    } else {
      const resolved = resolveCredentials()
      if (!resolved.llmApiKey) {
        return errorResult(
          'five46 requires an LLM API key. Set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY in the environment the MCP server runs under, or run `five46 config` once beforehand.'
        )
      }
      provider = getLlmProvider(resolved.llmProvider || 'openai')
      llmApiKey = resolved.llmApiKey
    }
    // Set as soon as llmApiKey itself is — anything thrown between here and
    // the authHeaders resolution below (e.g. resolveApiAuthHeaders itself
    // throwing) must still redact against a real key, not an empty array.
    secrets = [llmApiKey]

    const authHeaders = resolveApiAuthHeaders()
    secrets = [...secrets, ...(authHeaders ? Object.values(authHeaders) : [])]

    let targetOrigin: string
    try {
      targetOrigin = new URL(params.baseUrl).origin
    } catch {
      return errorResult(`"${params.baseUrl}" isn't a valid URL — needs a live http(s) URL.`)
    }
    const safety: SafetyMode = { allowWrites: context.allowWrites, allowDeletes: context.allowDeletes, targetOrigin, allowedHosts: new Set() }

    if (params.story) {
      const { goals, clamped } = await splitUserStory(params.story, provider, llmApiKey)
      const clampNote = clamped ? `Note: the story split into more scenarios than the cap of ${HARD_MAX_SCENARIOS} — running the first ${HARD_MAX_SCENARIOS} only.\n\n` : ''

      const tasks = goals.map((goal) => async () => {
        const result = await runOneApiScenario(params.baseUrl, goal, params.maxSteps, safety, authHeaders, provider, llmApiKey!, context.projectRoot, secrets)
        return { goal, result }
      })
      const outcomes = await runWithConcurrency(tasks, Math.max(1, context.concurrency))

      let allPassed = true
      let passedCount = 0
      const acceptanceCriteria: StructuredToolOutput['acceptanceCriteria'] = []
      const lines = outcomes.map(({ goal, result }, i) => {
        const passed = result.outcome === 'goal-reached'
        if (passed) passedCount++
        else allPassed = false
        acceptanceCriteria!.push({ index: i + 1, goal, outcome: result.outcome, passed, specPath: result.specPath })
        const header = `AC${i + 1}: ${passed ? 'PASS' : `FAIL (${result.outcome})`} — ${goal}`
        return passed ? header : `${header}\n${result.text}`
      })
      const finalText = `${clampNote}Split into ${goals.length} scenario(s). ${passedCount}/${goals.length} acceptance criteria reached goal-reached.\n\n${lines.join('\n\n')}`
      const structuredContent: StructuredToolOutput = { passed: allPassed, acceptanceCriteria }
      return allPassed ? textResult(finalText, structuredContent) : errorResult(finalText, structuredContent)
    }

    const { outcome, text, specPath } = await runOneApiScenario(params.baseUrl, params.goal!, params.maxSteps, safety, authHeaders, provider, llmApiKey, context.projectRoot, secrets)
    // Same isError-mirrors-CI-gating rule as runTestTool — see its comment.
    const passed = outcome === 'goal-reached'
    const structuredContent: StructuredToolOutput = { passed, outcome, specPath }
    return passed ? textResult(text, structuredContent) : errorResult(text, structuredContent)
  } catch (err) {
    return errorResult(redactSecrets(err instanceof Error ? err.message : String(err), secrets))
  }
}
