import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { testToolInputSchema, apiToolInputSchema, testToolOutputSchema, apiToolOutputSchema } from './schemas'
import { runTestTool, runApiTool } from './tools'
import type { McpToolContext } from './tools'
import type { LlmProvider } from '../llm/types'
import { HARD_MAX_CONCURRENCY } from '../agent/runLoop'
import packageJson from '../../package.json'

/** Every file under `src/mcp/` uses normal, static top-level imports
 * (including `zod` and `@modelcontextprotocol/sdk` here) — safe only
 * because nothing outside this directory ever imports this subtree except
 * `cli.ts`'s own single, deliberately lazy `require('./mcp/server')` inside
 * its `mcp` branch (mirroring the reasoning behind `browser.ts`'s lazy
 * `require('playwright')`, just with the laziness boundary drawn at the
 * subtree's one entry point instead of inside each file — both packages
 * are `optionalDependencies`; a user who only ever runs `five46 test`/
 * `login`/`api` must never pay a `require()` cost for either). */
export function createFive46McpServer(options?: {
  projectRoot?: string
  /** Test-only injection point — real (`cli.ts`) callers never pass these;
   * production always falls through to `runTestTool`/`runApiTool`'s own
   * real `resolveCredentials()` call. `allowWrites`/`allowDeletes` are
   * deliberately NOT overridable here even for tests — they are meant to
   * have exactly one real path in (the env vars, read below), and a test
   * exercising that behavior sets the real env var rather than a parallel
   * override, so the test verifies the actual production code path. */
  provider?: LlmProvider
  apiKey?: string
}): { server: McpServer; context: McpToolContext } {
  const projectRoot = options?.projectRoot ?? process.env.FIVE46_MCP_PROJECT_ROOT ?? process.cwd()
  const allowWrites = process.env.FIVE46_MCP_ALLOW_WRITES === '1'
  const allowDeletes = process.env.FIVE46_MCP_ALLOW_DELETES === '1'
  // Same "human sets an env var once, at server-launch time" posture as
  // allowWrites/allowDeletes above — story mode's concurrency is a
  // cost/rate-limit-affecting setting, never a per-call tool argument (see
  // McpToolContext.concurrency's own doc comment). Left `undefined` when the
  // env var is unset/invalid (unlike the booleans above, there IS a
  // meaningful "unset" state worth preserving past this point): five46_test
  // and five46_api have different concurrency defaults (see
  // DEFAULT_BROWSER_CONCURRENCY/DEFAULT_CONCURRENCY, runLoop.ts), so each
  // tool handler applies its own default only when this is undefined,
  // matching the CLI's own `--concurrency` flag precedent. An explicit,
  // in-range env var is still clamped to HARD_MAX_CONCURRENCY here, the same
  // silent-but-safe posture `Number.isFinite` checks already use elsewhere
  // for a malformed CLI flag value.
  const parsedConcurrency = Number(process.env.FIVE46_MCP_CONCURRENCY)
  const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? Math.min(parsedConcurrency, HARD_MAX_CONCURRENCY) : undefined
  const context: McpToolContext = { projectRoot, allowWrites, allowDeletes, concurrency, provider: options?.provider, apiKey: options?.apiKey }

  const server = new McpServer({ name: 'five46', version: packageJson.version })

  server.registerTool(
    'five46_test',
    {
      description: [
        "Drive a real local Playwright browser toward a stated goal, one action at a time, using your own configured LLM key (BYOK). Writes a real, standalone, re-runnable Playwright spec on success. Discloses: the page's visible text/labels/values are sent to your configured LLM provider on every step.",
        allowDeletes
          ? 'Clicking an element that looks like it deletes/deactivates/closes an account or permanently erases data IS enabled for this server (FIVE46_MCP_ALLOW_DELETES=1).'
          : 'Clicking an element that looks like it deletes/deactivates/closes an account or permanently erases data (e.g. "Delete Account") is blocked for this server — set FIVE46_MCP_ALLOW_DELETES=1 in the server environment to unlock it. Never settable via a tool call argument. This is a best-effort heuristic on the clicked element\'s visible text, not a guarantee.',
        'On a real assertion failure (a genuine finding about the app, not a tooling issue), one additional LLM call analyzes the failure for a root-cause hypothesis — built only from information already visible to the agent during the run (never a new disclosure), always on for this tool, and included in the returned report as a hypothesis, not a confirmed diagnosis.',
      ].join(' '),
      inputSchema: testToolInputSchema,
      outputSchema: testToolOutputSchema,
    },
    async (params) => runTestTool(params, context)
  )

  server.registerTool(
    'five46_api',
    {
      description: [
        'Drive real HTTP requests toward a stated goal, one request/assertion at a time, using your own configured LLM key (BYOK). Writes a real, standalone node:test script on success.',
        allowWrites
          ? `Writes ARE enabled for this server (FIVE46_MCP_ALLOW_WRITES=1)${allowDeletes ? ', including DELETE (FIVE46_MCP_ALLOW_DELETES=1)' : ', but DELETE is not (set FIVE46_MCP_ALLOW_DELETES=1 to unlock it)'}.`
          : 'Read-only for this server (GET/HEAD/OPTIONS only) — set FIVE46_MCP_ALLOW_WRITES=1 in the server environment to unlock POST/PUT/PATCH, FIVE46_MCP_ALLOW_DELETES=1 to separately unlock DELETE. Neither is ever settable via a tool call argument.',
        'Requests are restricted to the target base URL\'s own origin — no additional host allowlist is available via this tool.',
        'Discloses: request/response data, including response bodies (which may contain a live session token or other secret), is sent to your configured LLM provider on every step.',
        'On a real assertion failure, one additional LLM call analyzes the failure for a root-cause hypothesis — built only from information already visible to the agent during the run, always on for this tool, and included in the returned report as a hypothesis, not a confirmed diagnosis.',
      ].join(' '),
      inputSchema: apiToolInputSchema,
      outputSchema: apiToolOutputSchema,
    },
    async (params) => runApiTool(params, context)
  )

  return { server, context }
}
