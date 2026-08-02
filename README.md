# five46

**BYOK, fully local, agentic E2E and API testing.**

Point five46 at a real running page (or API) and a goal. An LLM — using
your own API key — drives a real local Playwright browser or real HTTP
requests toward that goal, one action at a time, and writes a real,
standalone, re-runnable test spec on success.

> **Status:** early proof of concept, verified end-to-end against a real
> live LLM.

## Features

- **Bring your own key (BYOK)** — OpenAI, Anthropic, Gemini, Groq, or AWS
  Bedrock. Your key, your usage, your cost.
- **Fully local** — no cloud sandbox, no tunneling for local dev servers.
  Nothing but the LLM calls ever leaves your machine.
- **Real, standalone output** — every successful run writes a plain
  Playwright `.spec.ts` (or `node:test` script for API tests) you can
  re-run any time, with no five46 or LLM involved.
- **Browser and API testing** — drive a real Chromium browser, or drive
  real HTTP requests directly, from the same agentic engine.
- **Session reuse** — log in once, capture the session, reuse it across
  runs without paying the LLM cost of logging in every time.
- **Self-healing selectors** — a stale selector gets one bounded, disclosed
  recovery attempt instead of just failing the step.
- **Root-cause hypotheses** — a failed assertion gets an LLM-generated
  hypothesis for what likely went wrong and what to check next.
- **MCP server** — expose `five46_test`/`five46_api` as tools an
  IDE-embedded AI assistant (Claude Code, Cursor, etc.) can call directly.
- **Safe by default** — API testing is read-only unless you explicitly
  unlock writes/deletes; destructive-looking browser clicks are blocked by
  default too.
- **Flaky-test detection** — `--repeat N` runs the same goal N times and
  reports whether the outcome/behavior actually stayed the same.
- **Diffing** — `five46 diff` compares two generated run files directly.
- **Project management** — `five46.config.json` + `--project` for
  reusable, named target defaults (url, session, safety flags).
- **Video replay** — `--record-video` records the whole session as a
  `.webm`.

## Installation

```bash
git clone https://github.com/sekharsdet/five46.git
cd five46
npm install
npm run build

npm install --save-dev playwright @playwright/test   # one-time
npx playwright install chromium                       # one-time, downloads the browser
```

## Configuration

One-time setup (same shape as `gh auth login`/`aws configure`):

```bash
node dist/cli.js config
```

This prompts for an LLM provider + key, masking secret input, and saves it
to `~/.five46/config.json` (user-only file permissions). Or set
environment variables instead — these always take priority over the saved
config, which is useful for CI:

```bash
export FIVE46_LLM_PROVIDER=openai   # or: anthropic, gemini, groq, bedrock
export FIVE46_LLM_API_KEY=sk-...    # for bedrock, use your AWS region instead
```

## Quick start

```bash
node dist/cli.js test http://localhost:3000 --goal "log in and confirm the dashboard loads"
```

`--goal` is required. Useful flags: `--max-steps` (default 15),
`--headed` (watch it drive a real visible browser instead of headless),
`--out` (spec path), `--allow-deletes` (allow clicking destructive-looking
elements, e.g. "Delete Account"), `--no-root-cause` (skip the extra LLM
call that analyzes a failed assertion), `--repeat N` (run the goal N times
and report whether it's flaky — see below), `--record-video` (save a
`.webm` of the whole session), `--project name` (pull defaults from
`five46.config.json` — see below).

A successful run writes a real, human-readable Playwright `.spec.ts` file
containing every confirmed-working step — re-runnable any time via
`npx playwright test`. The run itself is **not deterministic** (the same
goal against the same page can take a different path next time); the
generated spec is the frozen, repeatable artifact.

A failed assertion is reported as a real finding about the app (with a
screenshot, DOM snapshot, and a root-cause hypothesis), clearly separated
from a tooling hiccup (an unparseable LLM response, a stuck/repeating
agent) — the two are never conflated.

**Exit codes are CI-friendly**: `five46 test`/`five46 api` exit 0 only
when the goal was actually reached, and non-zero for anything else
(a failed assertion, a stuck/looping run, a missing API key, ...) —
so `five46 test <url> --goal "..." || exit 1` in a CI script works as
expected.

## Testing behind a login

Capture a session once, reuse it across runs:

```bash
export FIVE46_LOGIN_USERNAME=...
export FIVE46_LOGIN_PASSWORD=...

node dist/cli.js login https://your-app.example.com/login --goal "log in" --out session.json
node dist/cli.js test https://your-app.example.com/dashboard --goal "..." --storage-state session.json
```

Your username/password are never sent to the LLM — the model only ever
sees placeholder tokens; the real values are substituted locally at the
point Playwright actually types them. `session.json` is itself a live
bearer credential — treat it like one: don't commit it (it's written with
user-only file permissions).

## API/backend testing

No browser involved — the same agentic engine drives real HTTP requests
toward a goal instead, and writes a real, standalone `node:test` script
(plain `node:test` + `node:assert` + native `fetch`, no Playwright
needed):

```bash
node dist/cli.js api https://api.your-app.example.com --goal "create a user, then fetch it back and confirm the name matches"
```

Read-only (`GET`/`HEAD`/`OPTIONS`) by default. Add `--allow-writes` to
unlock `POST`/`PUT`/`PATCH`, and `--allow-deletes` to separately unlock
`DELETE`. Requests are restricted to the target's own origin unless you
name another one via repeatable `--allow-host <host>`.

## Listing past runs

```bash
node dist/cli.js list          # current directory
node dist/cli.js list ./tests  # or any other directory
node dist/cli.js list --project checkout   # only runs tagged with this project
```

Lists previously generated `five46-agent-*.spec.ts`/`five46-api-*.test.mjs`
files with their goal and outcome, most recent first. No separate "rerun"
command — every generated file already is a real, standalone Playwright/
`node:test` file: `npx playwright test <file>` / `node --test <file>`.

## Diffing two runs

```bash
node dist/cli.js diff five46-agent-abc123.spec.ts five46-agent-def456.spec.ts
```

A plain line diff between any two generated (or other text) files, with
the header's run-id token ignored (the outcome half of that same line is
still compared). Exits 0 if identical, 1 if they differ.

## Flaky-test detection

```bash
node dist/cli.js test http://localhost:3000 --goal "..." --repeat 5
```

Runs the same goal N times (sequentially — capped at 10) and reports
whether it's flaky: either the outcome differed across runs, or every run
reached the goal but took a genuinely different path. Exits 0 only if
every repeat succeeded with byte-identical generated output. Works the
same way on `five46 api`.

## Project management

```json
// five46.config.json
{
  "projects": {
    "checkout": { "url": "http://localhost:3000/checkout", "storageState": "session.json" }
  }
}
```

```bash
node dist/cli.js test --goal "..." --project checkout
```

A CLI flag always wins over a project default; a project only fills in
what you didn't pass. `--goal` is never project-configurable. The LLM API
key is never sourced from this file — only a provider label can be.

## Video replay

```bash
node dist/cli.js test http://localhost:3000 --goal "..." --record-video
```

Records the whole session as a real `.webm` (also available on
`five46 login`). No special "replay" command — open the file in any video
player.

## MCP server (IDE-embedded use)

```bash
npm install --save-dev @modelcontextprotocol/sdk zod   # one-time
node dist/cli.js mcp
```

Exposes `five46_test`/`five46_api` as MCP tools an IDE-embedded AI
assistant can call directly. Read-only by default, with no per-call way
to unlock writes — set `FIVE46_MCP_ALLOW_WRITES=1`/
`FIVE46_MCP_ALLOW_DELETES=1` in the server's own environment to unlock
them; tool arguments can never do it. `five46 login` is deliberately not
exposed via MCP.

## Roadmap

Not yet built: a multi-file/dependency-graph backend-test model, auto-
refresh login (session expiry mid-run), MCP exposure for `five46 login`,
scrolling to off-screen elements.

## Development

```bash
npm run build      # tsc
npm test           # build + run the test suite (node's built-in test runner)
node dist/cli.js test <url> --goal "..."
```

## License

[MIT](./LICENSE)
