# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## 0.3.0

### Added
- `five46_test`/`five46_api`'s MCP tools now accept an optional `steps`
  field alongside `goal` — an ordered checklist of what the calling coding
  agent already knows must happen (e.g. from having just read or written
  the flow being tested), grounding five46's upfront plan call instead of
  forcing it to invent a decomposition from `goal` alone. Every step still
  resolves against the real, live page/response exactly as before — this
  only changes what the model is told to plan for, never skips discovery,
  the destructive-click/fill-plausibility gates, or clause tracking.
  Requires `goal`; mutually exclusive with `story`. Forces structured-plan
  mode on for that call (MCP calls otherwise stay fully-adaptive).
- A deterministic guardrail against a real, live-found reasoning-quality
  miss (react-select.com): `fill`/`assert_value` now reject a target whose
  role is a known-never-text-entry one (button, checkbox, link, heading,
  status, ...) — both in the live per-step decision path and independently
  in the structured-plan fast path, which never calls that same parser at
  all. A rejection is recoverable (fed back into history, same as the
  destructive-click gate), not a hard stop — the model gets a real chance
  to pick the actual textbox/combobox/searchbox next turn. Also disclosed
  upfront in both prompts, so the mistake is less likely in the first
  place, not just caught after the fact.
- A persistent eval corpus (`src/eval/`, run via `npm run eval`) — a
  standing, checked-in regression suite for real interaction patterns,
  replacing one-off live-testing sessions that started from zero each
  time. Seeding it with deliberate probes for previously-unvalidated
  patterns directly found and fixed three real gaps: no `dblclick` action,
  no `drag` action (plus a deeper discovery bug it surfaced — a bare
  `<li>` list item had ZERO outline candidates at all, not just a missing
  action), and no way to assert a form field's current *value* (as
  opposed to visible text — `body.innerText()` never includes an input's
  value). New `dblclick`, `drag` (`ref`/`targetRef`, real
  `locator.dragTo()`), and `assert_value` (`inputValue()`, substring
  match) actions close all three, live and in the exported spec. See
  DEVELOPMENT.md's "A persistent eval corpus..." section for the full
  investigation.
- `five46 test`'s browser engine gained three new action types found
  missing via live testing: `hover` (triggers real `:hover`-gated
  content), `press_key` (dispatches a real keyboard key press, distinct
  from `fill`), and `upload` (sets a file input's file via
  `setInputFiles` — `fill` silently no-ops on `<input type="file">`).
- The browser engine now finds and interacts with elements inside
  `<iframe>`/`<frame>` elements — previously invisible to both the page
  snapshot and every action. Reflected in both the live run and the
  exported `.spec.ts` (a chained `page.frameLocator(...)` call).
- The browser engine now auto-accepts native JS dialogs
  (`alert`/`confirm`/`prompt`) by default, live and in the exported spec —
  previously left at Playwright's own default (auto-dismiss/Cancel).
- The browser engine now follows a newly opened tab/window
  (`target="_blank"`, `window.open()`) automatically, live and in the
  exported spec (via `context.waitForEvent('page')`) — previously kept
  silently operating on the original, now-stale tab.
- The page snapshot now finds a `contenteditable` region (a rich-text
  editor's actual editable surface — TinyMCE/CKEditor/Quill/Slate/
  ProseMirror-style widgets) and gives it an implicit `textbox` role, so
  `fill` has something to target — previously invisible to the outline
  entirely, since it's neither an `<input>`/`<textarea>` nor role-tagged.
- The page snapshot now finds a plain `<img>` with a non-empty `alt` as a
  hover candidate — found via a real, live gap:
  the-internet.herokuapp.com's own hover demo reveals a caption on
  `:hover`, but the avatar image triggering it has no role, no title, and
  no pointer cursor, so it was invisible to every existing candidate
  signal even though `hover` (added above) had nothing wrong with it.
- New `assert_page_text_absent` action — the inverse of `assert_page_text`,
  confirming a substring is genuinely gone from the whole rendered page
  (main document + iframes), live and in the exported spec (`.not.
  toContainText(...)`). Every prior assertion only ever proved presence —
  found via a real, live gap on TodoMVC (a completed item is removed from
  the DOM entirely under an "Active" filter, not merely hidden): a goal
  asking to confirm something no longer appears had no honest action to
  express at all, so the model looped instead (re-adding the item,
  re-toggling filters) rather than failing cleanly. Guarded by the same
  tautology check `assert_page_text` already has, inverted: text that was
  already absent before any action ran doesn't count as confirmation of
  anything.

### Changed
- The browser engine's page snapshot now discovers elements via
  Playwright's own `ariaSnapshot({ mode: 'ai' })` — a first-party
  accessibility-tree-based API purpose-built for AI browser agents —
  instead of a hand-rolled `querySelectorAll` + reimplemented accessible-
  name/role computation. This is a root-cause fix, not another one-off
  patch: across three separate live-testing sessions, nearly every "gap
  found on a new site" traced back to that reimplementation missing a
  pattern Chromium's own accessibility engine already handles correctly.
  Now automatically covers a `contenteditable` rich-text region, a plain
  heading/message with no ARIA role, an `<img alt>` with no other
  affordance signal, and (as a genuine bonus) elements inside an *open*
  shadow root — all previously invisible without a bespoke fix each. See
  DEVELOPMENT.md's "Migrating element discovery to Playwright's own
  accessibility snapshot" for the full investigation. No behavior change
  to the exported `.spec.ts` codegen strategy or the LLM-facing action
  vocabulary — this is purely an internal discovery-mechanism swap.

### Fixed
- `assert_page_text` now also searches iframe content, not just the main
  page — both live and in the exported spec.
- Raised the per-step decision token caps (`ACTION_MAX_OUTPUT_TOKENS`
  1024 → 3072, `API_ACTION_MAX_OUTPUT_TOKENS` 800 → 2048) — a real, live,
  reproduced truncation bug: Gemini's `thinkingBudget: 1` hint is not a
  hard ceiling, and the model `gemini-flash-latest` currently resolves to
  (`gemini-3.6-flash`) now spends measurably more tokens on invisible
  "thinking" against the same realistic prompt shape than when the old
  cap was tuned (250-980 observed vs. the 33-60 range measured
  previously) — confirmed directly by reproducing a real
  `finishReason: "MAX_TOKENS"` response that failed to parse at the old
  cap.
- A classic `<frameset>`-based page (no `<body>` element in its document
  at all) no longer crashes `five46 test` outright — found live against
  the-internet.herokuapp.com's own `nested_frames` demo.

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
