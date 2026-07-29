# five46

BYOK, fully local agentic E2E testing. Point five46 at a real, running
page and a goal; an LLM (your own key — OpenAI, Anthropic, Gemini, or AWS
Bedrock) drives a real local Playwright browser toward it, one action at a
time, and writes a real, standalone, re-runnable Playwright spec.

Runs entirely on your own machine — no cloud sandbox, no tunneling for
local dev servers, nothing but the LLM calls (your own key) ever leaving
your machine.

> **Status:** early proof of concept, verified end-to-end against a real
> live LLM.

## Installation

```bash
git clone <this-repo>
cd five46
npm install
npm run build

npm install --save-dev playwright @playwright/test   # one-time
npx playwright install chromium                       # one-time, downloads the browser
```

## Quick start

**One-time setup** (same shape as `gh auth login`/`aws configure`):

```bash
node dist/cli.js config
```

This prompts for an LLM provider + key, masking secret input, and saves it
to `~/.five46/config.json` (user-only file permissions). Or set
environment variables instead (these always take priority over the saved
config — useful for CI):

```bash
export FIVE46_LLM_PROVIDER=openai   # or: anthropic, gemini, bedrock
export FIVE46_LLM_API_KEY=sk-...    # for bedrock, use your AWS region instead
```

Then:

```bash
node dist/cli.js test http://localhost:3000 --goal "log in and confirm the dashboard loads"
```

`--goal` is required (a vague default would burn real API cost on an
unfocused run). `--max-steps` (default 15), `--headed` (watch it drive a
real visible browser instead of headless), and `--out` (spec path) are
optional.

## What you get

A real, human-readable Playwright `.spec.ts` file, written next to your
current directory, containing every step the agent executed and confirmed
working — re-runnable any time via `npx playwright test`, with no
five46 or LLM involved in re-running it.

This command itself is **not deterministic** — the same goal against the
same page can take a different path on a different run. The generated spec
is the frozen, deterministic artifact; `five46 test` is an authoring
tool, not a repeatable check.

A failed assertion is reported as a real finding about the app (with a
screenshot + DOM snapshot), distinct from a tooling hiccup (an unparseable
LLM response, a stuck/repeating agent) which is reported as exactly that —
never confusing the two.

## Testing behind a login

Most real apps aren't fully public. Capture a session once, reuse it across
runs — no need to pay the LLM cost of logging in every time:

```bash
export FIVE46_LOGIN_USERNAME=...
export FIVE46_LOGIN_PASSWORD=...

node dist/cli.js login https://your-app.example.com/login --goal "log in" --out session.json
node dist/cli.js test https://your-app.example.com/dashboard --goal "..." --storage-state session.json
```

Your username/password are never sent to the LLM — the model only ever
sees placeholder tokens; the real values are substituted locally at the
point Playwright actually types them. `session.json` is itself a live
bearer credential (whoever has it is logged in, no password needed) —
treat it like one: don't commit it, and it's written with user-only file
permissions.

## API/backend testing

No browser involved — the same agentic loop drives real HTTP requests
toward a goal instead, and writes a real, standalone `node:test` script
(plain `node:test` + `node:assert` + native `fetch`, no Playwright needed):

```bash
node dist/cli.js api https://api.your-app.example.com --goal "create a user, then fetch it back and confirm the name matches"
```

Read-only (`GET`/`HEAD`/`OPTIONS`) by default — add `--allow-writes` to
unlock `POST`/`PUT`/`PATCH` and `--allow-deletes` to separately unlock
`DELETE` (independent flags, since a delete is often unrecoverable in a way
the others aren't). Requests are restricted to the target's own origin
unless you name another one via repeatable `--allow-host <host>`.

## MCP server (IDE-embedded use)

```bash
npm install --save-dev @modelcontextprotocol/sdk zod   # one-time
node dist/cli.js mcp
```

Exposes `five46_test`/`five46_api` as MCP tools an IDE-embedded AI
assistant (Claude Code, Cursor, etc.) can call directly. Read-only by
default, with no per-call way to unlock writes — set
`FIVE46_MCP_ALLOW_WRITES=1`/`FIVE46_MCP_ALLOW_DELETES=1` in the server's
own environment if you want to unlock them yourself; the tool arguments
themselves can never do it. `five46 login` is deliberately not exposed —
the caller here is the IDE's own AI, not a human at the moment of each
call, which changes the safety posture from the plain CLI in some real
ways.

## Not yet built

A multi-file/dependency-graph backend-test model like some cloud-hosted
competitors offer (`five46 api` takes a deliberately different approach),
auto-refresh login (session expiry mid-run), MCP exposure for `five46
login`, scrolling to off-screen elements.

## Credentials

BYOK end-to-end: read from your own environment/config at the point of
use, never stored or sent anywhere but the one LLM request that needs
them. The live page's visible text/labels/values are sent to your
configured LLM provider on every step of a run — a real, disclosed
data-exposure surface, printed as a banner on every run, not just here.

## Development

```bash
npm run build      # tsc
npm test           # build + run the test suite (node's built-in test runner)
node dist/cli.js test <url> --goal "..."
```

## License

Private/unlicensed — not currently distributed publicly.
