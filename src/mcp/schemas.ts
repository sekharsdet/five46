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

export const testToolInputSchema = {
  url: z.string().describe('The live http(s) or file:// URL to test'),
  goal: z
    .string()
    .optional()
    .describe('What the agent should accomplish — provide exactly one of `goal`/`story`. A vague goal would burn real BYOK cost on an unfocused run.'),
  story: z.string().optional().describe(storyDescribe),
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
  maxSteps: z.number().int().positive().optional().describe('Step budget (default 15, hard-capped at 50 regardless of what is passed)'),
}
