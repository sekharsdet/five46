import * as z from 'zod/v4'

/** Deliberately does NOT include `allowWrites`/`allowDeletes`/`allowHosts`
 * or any credential field — see DEVELOPMENT.md's "MCP server integration"
 * section for why. Unlike the CLI (one human, one deliberate flag per
 * invocation), an MCP tool's arguments are chosen by the calling IDE
 * assistant's own reasoning, not a human at the moment of the call — write
 * access is only ever unlockable via an env var the human sets once, when
 * configuring the MCP server itself, never through a tool parameter. */
export const testToolInputSchema = {
  url: z.string().describe('The live http(s) or file:// URL to test'),
  goal: z.string().describe('What the agent should accomplish — required, since a vague default would burn real BYOK cost on an unfocused run'),
  maxSteps: z.number().int().positive().optional().describe('Step budget (default 15, hard-capped at 50 regardless of what is passed)'),
  headed: z.boolean().optional().describe('Watch it drive a real visible browser instead of headless (default false)'),
  storageStatePath: z
    .string()
    .optional()
    .describe('Relative path (under the configured project root) to a session file previously captured by `five46 login` — starts the browser already authenticated'),
}

export const apiToolInputSchema = {
  baseUrl: z.string().describe('The live http(s) base URL to test'),
  goal: z.string().describe('What the agent should accomplish — required, since a vague default would burn real BYOK cost on an unfocused run'),
  maxSteps: z.number().int().positive().optional().describe('Step budget (default 15, hard-capped at 50 regardless of what is passed)'),
}
