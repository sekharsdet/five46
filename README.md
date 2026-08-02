# five46

[![npm version](https://img.shields.io/npm/v/five46.svg)](https://www.npmjs.com/package/five46)
[![npm downloads](https://img.shields.io/npm/dm/five46.svg)](https://www.npmjs.com/package/five46)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/five46.svg)](https://www.npmjs.com/package/five46)

**AI-powered, BYOK, fully local agentic E2E and API testing for Playwright — no cloud sandbox, no data leaving your machine except the LLM call itself.**

Point five46 at a real running page (or API) and a plain-English goal — "log in and confirm the dashboard loads," "create a user via POST, then confirm it via GET." An LLM — using your own OpenAI, Anthropic, Gemini, Groq, or AWS Bedrock key — drives a real local Playwright browser or real HTTP requests toward that goal, one action at a time, and writes a real, standalone, re-runnable Playwright (or `node:test`) spec on success. No five46, no LLM, and no network call back to us involved in re-running the generated test — it's just ordinary Playwright code you own outright.

> **Status:** early proof of concept, verified end-to-end against real live LLM keys across dozens of real-world sites and APIs.

If five46 is useful to you, a ⭐ on [GitHub](https://github.com/sekharsdet/five46) helps other people find it — much appreciated!

## Why five46, and how it's different

Most AI-driven test-generation tools run in a cloud sandbox: your app's traffic, screenshots, and DOM leave your machine and go through a third-party service you don't control. five46 is the opposite bet — **everything runs on your laptop**, using a key you already pay for, and the *only* thing that ever leaves your machine is the text sent to your chosen LLM provider on each step (always disclosed, never hidden). If your organization can't adopt a cloud-hosted AI testing platform for compliance or trust reasons, this is built for exactly that constraint.

It's also not a black box: every run ends with a real `.spec.ts`/`.test.mjs` file you can read, diff, commit to your repo, and run in CI with plain `npx playwright test` — no vendor lock-in, no proprietary runner.

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
- **Structured planning** — `--structured-plan` plans the whole goal
  upfront with one extra LLM call, then executes most steps directly
  against the real page/response with no further live decision needed.

## five46 vs. cloud AI testing platforms

| | five46 | Typical cloud AI testing platform |
|---|---|---|
| Where it runs | Your machine, fully local | Their cloud sandbox |
| What leaves your machine | Only the text sent to your LLM provider per step (disclosed) | Your app's traffic, screenshots, DOM, credentials |
| Pricing model | BYOK — you pay your LLM provider directly, at cost | Usage-based platform subscription on top of their own LLM cost |
| Output | A real, standalone `.spec.ts`/`.test.mjs` file you own, re-runnable with plain Playwright/`node:test` | Usually tied to their own runner/dashboard |
| Best fit | Teams that can't send app data to a third party, or want to run tests entirely offline/on-prem | Teams that want a managed, zero-setup service and don't mind the tradeoff |

Not a knock on cloud platforms — it's a genuinely different tradeoff (their infra vs. your own key and your own machine), and the right choice depends on what your organization is allowed to send off-machine.

## Installation

```bash
npm install -g five46

npm install --save-dev playwright @playwright/test   # one-time, if your project doesn't already have it
npx playwright install chromium                       # one-time, downloads the browser
```

Or run it without installing globally:

```bash
npx five46 test http://localhost:3000 --goal "log in and confirm the dashboard loads"
```

<details>
<summary>Building from source instead (for contributing to five46 itself)</summary>

```bash
git clone https://github.com/sekharsdet/five46.git
cd five46
npm install
npm run build
node dist/cli.js test http://localhost:3000 --goal "..."
```

</details>

## Configuration

One-time setup (same shape as `gh auth login`/`aws configure`):

```bash
five46 config
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
five46 test http://localhost:3000 --goal "log in and confirm the dashboard loads"
```

`--goal` is required. Useful flags: `--max-steps` (default 15),
`--headed` (watch it drive a real visible browser instead of headless),
`--out` (spec path), `--allow-deletes` (allow clicking destructive-looking
elements, e.g. "Delete Account"), `--no-root-cause` (skip the extra LLM
call that analyzes a failed assertion), `--repeat N` (run the goal N times
and report whether it's flaky — see below), `--record-video` (save a
`.webm` of the whole session), `--project name` (pull defaults from
`five46.config.json` — see below), `--structured-plan` (plan the whole
goal upfront, executing most steps with no further live LLM decision —
see below).

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

five46 login https://your-app.example.com/login --goal "log in" --out session.json
five46 test https://your-app.example.com/dashboard --goal "..." --storage-state session.json
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
five46 api https://api.your-app.example.com --goal "create a user, then fetch it back and confirm the name matches"
```

Read-only (`GET`/`HEAD`/`OPTIONS`) by default. Add `--allow-writes` to
unlock `POST`/`PUT`/`PATCH`, and `--allow-deletes` to separately unlock
`DELETE`. Requests are restricted to the target's own origin unless you
name another one via repeatable `--allow-host <host>`.

## Listing past runs

```bash
five46 list          # current directory
five46 list ./tests  # or any other directory
five46 list --project checkout   # only runs tagged with this project
```

Lists previously generated `five46-agent-*.spec.ts`/`five46-api-*.test.mjs`
files with their goal and outcome, most recent first. No separate "rerun"
command — every generated file already is a real, standalone Playwright/
`node:test` file: `npx playwright test <file>` / `node --test <file>`.

## Diffing two runs

```bash
five46 diff five46-agent-abc123.spec.ts five46-agent-def456.spec.ts
```

A plain line diff between any two generated (or other text) files, with
the header's run-id token ignored (the outcome half of that same line is
still compared). Exits 0 if identical, 1 if they differ.

## Flaky-test detection

```bash
five46 test http://localhost:3000 --goal "..." --repeat 5
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
five46 test --goal "..." --project checkout
```

A CLI flag always wins over a project default; a project only fills in
what you didn't pass. `--goal` is never project-configurable. The LLM API
key is never sourced from this file — only a provider label can be.

## Video replay

```bash
five46 test http://localhost:3000 --goal "..." --record-video
```

Records the whole session as a real `.webm` (also available on
`five46 login`). No special "replay" command — open the file in any video
player.

## Structured planning

```bash
five46 test http://localhost:3000 --goal "..." --structured-plan
```

One extra LLM call plans the whole goal upfront; most steps then execute
directly against the real page/response with no further live decision —
falling back to a normal live decision only when a step's prediction
doesn't resolve cleanly. Same safety guarantees as an ordinary run
(destructive-click gating, method/host allowlisting) are enforced
independently at the fast path too, not skipped. Off by default; works on
`five46 api` too.

## MCP server (IDE-embedded use)

```bash
npm install --save-dev @modelcontextprotocol/sdk zod   # one-time
five46 mcp
```

Exposes `five46_test`/`five46_api` as MCP tools an IDE-embedded AI
assistant can call directly. Read-only by default, with no per-call way
to unlock writes — set `FIVE46_MCP_ALLOW_WRITES=1`/
`FIVE46_MCP_ALLOW_DELETES=1` in the server's own environment to unlock
them; tool arguments can never do it. `five46 login` is deliberately not
exposed via MCP.

## Development

```bash
npm run build      # tsc
npm test           # build + run the test suite (node's built-in test runner)
node dist/cli.js test <url> --goal "..."
```

## License

[MIT](./LICENSE)
