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
  provider?: LlmProvider
  apiKey?: string
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  // Matches the MCP SDK's own CallToolResult shape, which allows arbitrary
  // extra fields per the JSON-RPC spec's extensibility — required for this
  // type to satisfy registerTool's handler return type structurally.
  [key: string]: unknown
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export interface TestToolParams {
  url: string
  goal: string
  maxSteps?: number
  headed?: boolean
  storageStatePath?: string
}

/** Loads and minimally validates a `statecheck login`-produced session
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

/** `five46_test`'s MCP handler — mirrors `cli.ts`'s `runE2eTest` in what it
 * does, but never calls `console.log`: a stdio MCP server's stdout is the
 * literal JSON-RPC transport, so every disclosure/progress line that would
 * print live on the CLI is instead collected into the single returned
 * `content` block once the run completes. No `out` parameter — the
 * generated spec's path is always auto-derived under `context.projectRoot`,
 * never caller-chosen, so there's no write-path parameter to validate at
 * all for the output artifact (only `storageStatePath`, a read, goes
 * through `resolveMcpPath`). */
export async function runTestTool(params: TestToolParams, context: McpToolContext): Promise<McpToolResult> {
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

    const runId = Date.now().toString(36)
    const artifactDir = join(context.projectRoot, `five46-mcp-agent-${runId}`)

    // Same source as `five46_api`'s own delete-gating (FIVE46_MCP_ALLOW_DELETES,
    // read once at server startup) — no new env var, no new tool-schema
    // field, matching the existing "never a per-call argument" posture.
    const destructiveClicks: string[] = []
    let run
    try {
      run = await runAgent({
        url: params.url,
        goal: params.goal,
        provider,
        apiKey: llmApiKey,
        maxSteps: params.maxSteps,
        headless: !params.headed,
        artifactDir,
        storageState,
        allowDeletes: context.allowDeletes,
        onDestructiveClick: (name, reason) => destructiveClicks.push(`clicked "${name}" (${reason})`),
      })
    } catch (err) {
      if (err instanceof AgentBrowserUnavailableError) return errorResult(err.message)
      throw err
    }

    const destructiveSection =
      destructiveClicks.length > 0 ? `\n\nDestructive click(s) performed during this run:\n${destructiveClicks.map((w) => `  -> ${w}`).join('\n')}` : ''
    // Always on for MCP (no per-call flag — see `--no-root-cause`'s CLI-only
    // scope in cli.ts) — one bounded extra call against a run that may
    // already be up to 50 steps, and this tool's parameter surface
    // deliberately carries no cost/safety toggles for the calling AI.
    const rootCauseHypothesis = run.outcome === 'assertion-failed' ? await generateRootCauseHypothesis(run, provider, llmApiKey) : undefined
    const reportText = redactSecrets(formatFailureReport(run, rootCauseHypothesis) + destructiveSection, [llmApiKey])
    const outPath = join(context.projectRoot, `five46-agent-${run.runId}.spec.ts`)
    writeFileSync(outPath, redactSecrets(generateAgentSpec(run), [llmApiKey]), 'utf8')

    return textResult(`${reportText}\n\nWrote ${run.steps.filter((s) => s.ok).length} confirmed-working step(s) to ${outPath}`)
  } catch (err) {
    return errorResult(redactSecrets(err instanceof Error ? err.message : String(err), [llmApiKey]))
  }
}

export interface ApiToolParams {
  baseUrl: string
  goal: string
  maxSteps?: number
}

/** `five46_api`'s MCP handler — mirrors `cli.ts`'s `runApiTestCommand`, with
 * the same "collect, don't print live" adaptation for stdio as
 * `runTestTool`. `allowWrites`/`allowDeletes` come only from `context`
 * (server-startup env vars) — the tool's own input schema has no such
 * fields, so there is no argument path that could set them. `allowedHosts`
 * is always empty: no host-allowlist parameter in v1, closing an
 * SSRF-shaped gap an exposed `allowHosts` parameter would otherwise open
 * (an outer, less-trusted caller directing requests at arbitrary internal
 * hosts even with writes fully closed off). Real-time write visibility
 * (`onWrite`, a live console banner on the CLI) is collected into an
 * ordered list and folded into the final report instead — MCP progress
 * notifications are a named, deferred enhancement, not built here. */
export async function runApiTool(params: ApiToolParams, context: McpToolContext): Promise<McpToolResult> {
  // Same reasoning as runTestTool: hoisted above the try so the outer catch
  // can redact with them. Previously `secrets` never included the LLM key
  // at all (only authHeaders values), and the outer catch didn't redact
  // with anything.
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

    const authHeaders = resolveApiAuthHeaders()
    secrets = [...(authHeaders ? Object.values(authHeaders) : []), llmApiKey]

    let targetOrigin: string
    try {
      targetOrigin = new URL(params.baseUrl).origin
    } catch {
      return errorResult(`"${params.baseUrl}" isn't a valid URL — needs a live http(s) URL.`)
    }
    const safety: SafetyMode = { allowWrites: context.allowWrites, allowDeletes: context.allowDeletes, targetOrigin, allowedHosts: new Set() }

    const writes: string[] = []
    const run = await runApiTest({
      baseUrl: params.baseUrl,
      goal: params.goal,
      provider,
      apiKey: llmApiKey,
      maxSteps: params.maxSteps,
      safety,
      authHeaders,
      onWrite: (method, url, reason) => writes.push(`${method} ${url} (${reason})`),
    })

    const writesSection = writes.length > 0 ? `\n\nWrites performed during this run:\n${writes.map((w) => `  -> ${w}`).join('\n')}` : ''
    const rootCauseHypothesis = run.outcome === 'assertion-failed' ? await generateApiRootCauseHypothesis(run, provider, llmApiKey) : undefined
    const reportText = redactSecrets(formatApiFailureReport(run, rootCauseHypothesis) + writesSection, secrets)

    const outPath = join(context.projectRoot, `five46-api-${run.runId}.test.mjs`)
    writeFileSync(outPath, redactSecrets(generateApiSpec(run), secrets), 'utf8')

    return textResult(`${reportText}\n\nWrote ${run.steps.filter((s) => s.ok).length} confirmed-working step(s) to ${outPath}`)
  } catch (err) {
    return errorResult(redactSecrets(err instanceof Error ? err.message : String(err), secrets))
  }
}
