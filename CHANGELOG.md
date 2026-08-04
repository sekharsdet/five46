# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## 0.2.3

### Added
- `mcpName` field in `package.json`, required for publishing to the
  official [MCP Registry](https://registry.modelcontextprotocol.io) —
  no functional change to the CLI/MCP server itself.

## 0.2.2

### Fixed
- `engines.node` corrected from `>=18` to `>=20` — `playwright`/
  `@playwright/test` (needed for `five46 test`'s browser engine) have
  always required Node >=20 themselves; the old, looser claim let
  `npm install` on Node 18/19 silently skip installing them as an
  optional dependency, and broke building five46 from source on Node 18
  entirely (a real CI failure this correction was found from).
- `npm test`'s file discovery no longer depends on `node --test`'s
  native glob-pattern support, which only exists on Node 22+ — replaced
  with an explicit file list, portable across every Node version this
  project supports.
- A mocked `AbortSignal.timeout()` test relied solely on that API's own
  (deliberately unref'd) internal timer to keep the test process alive —
  a known Node test-runner false positive on Node 20.12+ through at
  least 22.x (nodejs/node#49952, #52304). Fixed with a trivial ref'd
  keepalive.

## 0.2.1

### Added
- CI (GitHub Actions): build + full test suite on every push/PR.

### Fixed
- The transient Playwright `"Execution context was destroyed, most likely
  because of a navigation"` error — an ordinary timing race, not a real
  app failure — is now retried once instead of failing the step.
- Resolved two transitive-dependency advisories (`fast-uri`, `hono`, both
  pulled in via the optional MCP SDK dependency) via `npm audit fix`.

### Changed
- Story mode's default concurrency is now lower for browser runs than API
  runs (2 vs 3) — several concurrent full browser sessions against one
  origin carry a heavier, more bot-like footprint than concurrent plain
  HTTP requests. Both remain overridable via `--concurrency`/
  `FIVE46_MCP_CONCURRENCY`, hard-capped at 5.

### Docs
- Added `CHANGELOG.md`.

## 0.2.0

### Added
- **Story mode** (`--story`) — split a raw, multi-AC user story into
  independent goals and run them with bounded concurrency, reporting a
  clear pass/fail per acceptance criterion. Available on `five46 test`,
  `five46 api`, and both MCP tools.
- **Resilient generated specs** — when a live check confirms Playwright's
  own `getByRole()` resolves uniquely to the exact element a step acted
  on, the generated spec prefers it over a positional CSS selector.
  Never changes what the live run itself does.
- **Structured MCP output** — `five46_test`/`five46_api` now return a
  `structuredContent` field (`{ passed, outcome, specPath }` or
  `{ passed, acceptanceCriteria }` for a story call) alongside the
  existing free-text report, so a calling coding agent can branch on a
  real field instead of parsing prose.
- **`--fast-steps`** (opt-in) — on Groq/Gemini, swaps in a faster model
  tier for the high-frequency per-step decision call only.

### Fixed
- A goal is no longer reported as reached without at least one real
  assertion having actually run.
- A browser-teardown failure in `runAgent`'s cleanup path could
  previously mask an already-computed, genuinely correct run result;
  teardown failures are now isolated and can never overwrite the real
  outcome.

### Changed
- Prompts reordered so static content leads, unlocking provider prompt
  caching and cutting per-step LLM cost/latency.

### Docs
- Disclosed known limitations (no iframe/shadow-DOM traversal,
  Chromium-only) in the public README — previously noted only in
  internal dev notes.

## 0.1.1

No functional changes — version bump only.

## 0.1.0

Initial public release.

- BYOK agentic testing engine (OpenAI, Anthropic, Gemini, Groq, AWS
  Bedrock) driving a real Chromium browser or real HTTP requests toward
  a plain-English goal.
- Every successful run writes a real, standalone Playwright `.spec.ts`
  (or `node:test` script for API tests).
- Session reuse (`five46 login` + `--storage-state`), self-healing
  selectors, root-cause hypotheses on failed assertions.
- Safe by default: read-only API testing unless writes/deletes are
  explicitly unlocked; destructive-looking browser clicks blocked by
  default.
- `five46 diff`, `--repeat` flaky-test detection, `five46.config.json`
  project management, CI-friendly exit codes.
- MCP server (`five46 mcp`) exposing `five46_test`/`five46_api`.
