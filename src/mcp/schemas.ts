import * as z from 'zod/v4'

/** Deliberately does NOT include `allowWrites`/`allowDeletes`/`allowHosts`
 * or any credential field — see DEVELOPMENT.md's "MCP server integration"
 * section for why. Unlike the CLI (one human, one deliberate flag per
 * invocation), an MCP tool's arguments are chosen by the calling IDE
 * assistant's own reasoning, not a human at the moment of the call — write
 * access is only ever unlockable via an env var the human sets once, when
 * configuring the MCP server itself, never through a tool parameter. */
// `goal`/`story` are each optional but exactly one is required — enforced
// in `tools.ts` (`runTestTool`/`runApiTool`), not expressible in the Zod
// shape itself without a discriminated union, which would complicate every
// existing single-goal caller for a rarely-combined pair of fields.
const storyDescribe = 'A raw, possibly multi-scenario user story/acceptance-criteria text to split into independent goals and run with bounded concurrency (see `concurrency` context, set via FIVE46_MCP_CONCURRENCY on the server, never a per-call argument). Mutually exclusive with `goal` — provide exactly one.'

// `steps` is an optional refinement of `goal`, not a substitute for it — see
// `mcp/tools.ts`'s validation (steps requires goal, and is rejected
// alongside story). It forces structured-plan mode on for this call (one
// extra upfront LLM call, same cost `--structured-plan` always has) so the
// caller's steps have somewhere to go: see `runner.ts`'s
// `RunAgentOptions.callerPlanSteps` doc comment.
const stepSchema = z.object({
  type: z.enum(['action', 'assertion']).describe('Advisory only — distinguishes a step that does something from one that checks something. Has no effect on parsing or execution.'),
  description: z.string().min(1).describe('Plain language, e.g. "Click \'Add to cart\'" or "The cart shows exactly 1 item" — not a selector or role.'),
})
const stepsDescribe = 'An optional ordered checklist (1-50 items) of steps you already know must happen — e.g. from having just read/written the flow being tested. When provided, five46 grounds its one upfront plan call in this checklist instead of inventing its own decomposition of `goal`, then resolves each step against the real live page exactly as it always does (never a blind guess — falls back to a live decision on ambiguity). Requires `goal` (the overall objective `steps` refines); mutually exclusive with `story`.'

export const testToolInputSchema = {
  url: z.string().describe('The live http(s) or file:// URL to test'),
  goal: z
    .string()
    .optional()
    .describe('What the agent should accomplish — provide exactly one of `goal`/`story`. A vague goal would burn real BYOK cost on an unfocused run.'),
  story: z.string().optional().describe(storyDescribe),
  steps: z.array(stepSchema).min(1).max(50).optional().describe(stepsDescribe),
  maxSteps: z.number().int().positive().optional().describe('Step budget (default 15, hard-capped at 50 regardless of what is passed)'),
  headed: z.boolean().optional().describe('Watch it drive a real visible browser instead of headless (default false)'),
  storageStatePath: z
    .string()
    .optional()
    .describe('Relative path (under the configured project root) to a session file previously captured by `five46 login` — starts the browser already authenticated'),
}

export const apiToolInputSchema = {
  baseUrl: z.string().describe('The live http(s) base URL to test'),
  goal: z
    .string()
    .optional()
    .describe('What the agent should accomplish — provide exactly one of `goal`/`story`. A vague goal would burn real BYOK cost on an unfocused run.'),
  story: z.string().optional().describe(storyDescribe),
  steps: z.array(stepSchema).min(1).max(50).optional().describe(stepsDescribe),
  maxSteps: z.number().int().positive().optional().describe('Step budget (default 15, hard-capped at 50 regardless of what is passed)'),
}

// Shared by both tools' output schemas — `RunOutcome`/`ApiTestRun`'s own
// outcome union (agent/types.ts, agent/apiTypes.ts), plus a synthetic
// `tooling-error` value used only here, for an MCP-layer failure with no
// real run outcome behind it at all (e.g. Playwright unavailable, or a
// write failure after a run already completed — see `runOneTestScenario`/
// `runOneApiScenario` in tools.ts).
const outcomeEnum = z.enum([
  'goal-reached',
  'goal-unreachable',
  'stuck-repeating',
  'stopped-by-cap',
  'unparseable-response',
  'assertion-failed',
  'provider-unavailable',
  'tooling-error',
])

const acceptanceCriterionOutputSchema = z.object({
  index: z.number().int().positive().describe('1-based position, matching the "ACn" label in the free-text report'),
  goal: z.string().describe('The independent goal this scenario was split into'),
  outcome: outcomeEnum,
  passed: z.boolean(),
  specPath: z.string().optional().describe('Absolute path to this scenario\'s own generated spec file, when one was written'),
})

/** The MCP SDK (`@modelcontextprotocol/sdk@^1.30.0`) strictly validates
 * `structuredContent` against this shape on every non-error result — see
 * its own `validateToolOutput()` — so this must exactly describe what
 * `runTestTool`/`runApiTool` actually return. `outcome`/`specPath` are for
 * a plain `goal` call; `acceptanceCriteria` is for a `story` call — never
 * both at once. `passed` is always present regardless of which shape:
 * the one universal field a calling agent can branch on immediately,
 * mirroring the result's own `isError` exactly (`passed === !isError`).
 * This is a purely additive, machine-parseable *parallel* channel — the
 * existing free-text report in `content` is unchanged, still the right
 * format for a human reading raw MCP output. */
const toolOutputSchema = {
  passed: z
    .boolean()
    .describe('Whether this call fully succeeded — for a plain goal, outcome === "goal-reached"; for a story, every acceptance criterion reached goal-reached.'),
  outcome: outcomeEnum.optional().describe('Present only for a plain `goal` call (never a `story` call — see acceptanceCriteria instead).'),
  specPath: z.string().optional().describe('Absolute path to the generated spec file — present only for a plain `goal` call.'),
  acceptanceCriteria: z
    .array(acceptanceCriterionOutputSchema)
    .optional()
    .describe('Present only for a `story` call — one entry per split acceptance criterion, in the order they were run.'),
}

export const testToolOutputSchema = toolOutputSchema
export const apiToolOutputSchema = toolOutputSchema
