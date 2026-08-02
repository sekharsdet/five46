import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import type { OutlineElement, PageOutline, AgentAction } from './types'

/** Thrown when the agent's browser can't be launched at all — missing
 * optional dependency, missing browser binary, or any other real launch
 * failure. Callers should catch this, print its (already actionable)
 * message, and stop before spending any BYOK budget on LLM calls that would
 * have nothing to drive. */
export class AgentBrowserUnavailableError extends Error {}

/** Playwright doesn't export a named type for `context.storageState()`'s
 * return shape (an inline anonymous object type on both the return value
 * and `newContext()`'s accepted options) — mirrors the real shape read
 * directly from `node_modules/playwright-core/types/types.d.ts` rather than
 * assumed, so this round-trips through `newContext({ storageState })`
 * without a type-escape-hatch cast. */
export interface StorageStateCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface StorageState {
  cookies: StorageStateCookie[]
  origins: { origin: string; localStorage: { name: string; value: string }[] }[]
}

export interface AgentBrowser {
  page: import('playwright').Page
  context: import('playwright').BrowserContext
  /** Returns the recorded video's path when `recordVideoDir` was set at
   * launch and the video was actually finalized (best-effort — a video
   * capture failure here must never itself fail the close). */
  close(): Promise<{ videoPath?: string }>
}

export interface LoginCredentials {
  username?: string
  password?: string
}

/** Literal tokens the LLM is told (see `planner.ts`'s `buildActionPrompt`)
 * it may use in a `fill` value or an `assert_text` expectedText to mean
 * "the configured username/password" — the model never sees or writes a
 * real credential itself. Exported so `planner.ts` (prompt instructions)
 * and `generateSpec.ts` (translating to a `process.env.*` reference) use
 * the exact same strings, never a second, driftable copy. */
export const USERNAME_PLACEHOLDER = '%%USERNAME%%'
export const PASSWORD_PLACEHOLDER = '%%PASSWORD%%'

/** Substitutes credential placeholder tokens for their real values in a
 * plain string, returning a new string — never mutates anything. This is
 * the single point where a real secret and a piece of LLM-originated text
 * ever combine, and it must stay that way: the caller is responsible for
 * only using the *return value* for the real Playwright call/comparison,
 * and never for anything that gets recorded into `history`, `steps`, or a
 * printed report — those must keep referencing the original, unsubstituted
 * string (still just the placeholder token), or the real secret leaks into
 * the next LLM prompt, the generated spec, and the console. Handles a
 * placeholder mixed with literal text (e.g. `"prefix-%%USERNAME%%"`), not
 * just an exact match. */
export function substitutePlaceholders(value: string, credentials?: LoginCredentials): string {
  let result = value
  if (credentials?.username !== undefined) {
    result = result.split(USERNAME_PLACEHOLDER).join(credentials.username)
  }
  if (credentials?.password !== undefined) {
    result = result.split(PASSWORD_PLACEHOLDER).join(credentials.password)
  }
  return result
}

export interface StepExecutionResult {
  ok: boolean
  failureDetail?: string
  screenshotPath?: string
  domSnapshotPath?: string
  /** Present only on failure — a local `.txt` file (best-effort) holding
   * the page's real rendered text (`body`'s `innerText`, bounded to
   * `MAX_VISIBLE_TEXT_CHARS`) at the moment of failure. See `fail()`'s own
   * doc comment for why this exists and why it's a file for a human to
   * open, never text embedded in any LLM prompt. */
  visibleTextPath?: string
  /** Present only when the original selector had gone stale and healing
   * found exactly one unambiguous replacement — see `executeAction`'s
   * healing logic. */
  healed?: boolean
  healedSelector?: string
  /** Present only for a `scroll` action — whether the page's scroll
   * position actually changed. `runner.ts` uses this (not just `ok`) to
   * decide whether a scroll counts as progress for stuck-repeating
   * purposes: a scroll already at a page boundary still succeeds (`ok:
   * true`) but didn't move anything, the same way a click that hits an
   * already-open dropdown still "succeeds" without changing anything. */
  scrolled?: boolean
}

/** Bound on the `visibleTextPath` file's content — not an LLM-prompt-size
 * concern (this file is never sent to any LLM), just a sane cap on how
 * much a human has to scroll through when opening it. */
const MAX_VISIBLE_TEXT_CHARS = 3000

/** Distinguishes the two real, distinct ways a Playwright launch fails —
 * the package itself isn't installed (an `optionalDependency`, per
 * `package.json`), vs. the package is present but its Chromium binary
 * hasn't been downloaded — since each needs a different one-line fix, and
 * neither is fixed by seeing the other's instructions. Found by actually
 * triggering both failure modes, not by reasoning about them in advance. */
function describeUnavailable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/Executable doesn't exist/.test(message)) {
    return "playwright is installed but its Chromium browser binary isn't — run: npx playwright install chromium (one-time download, ~150-300MB)"
  }
  return message.split('\n')[0]
}

/** Launches a real, local Chromium browser. Lazily `require()`'d —
 * `playwright` is an `optionalDependency`, so a user who never runs
 * `five46 test` pays no install cost for it. Deliberately called (and
 * allowed to fail) before any LLM call in `runner.ts`, so a missing-setup
 * environment fails fast and cheap rather than after already spending BYOK
 * budget.
 *
 * Uses the explicit `browser.newContext()` + `context.newPage()` form
 * rather than the `browser.newPage()` shortcut — Playwright's own docs
 * describe `newPage()` as sugar for exactly this (a convenience for
 * single-page scripts; "production code and testing frameworks should
 * explicitly create browser.newContext()"), needed here regardless since
 * `newContext({ storageState })` is the only way to start a context already
 * authenticated. A regression test compares `page.viewportSize()`
 * before/after this change to confirm that claim directly rather than trust
 * the doc wording alone.
 *
 * `recordVideoDir`, when set, records the whole session as a `.webm` into
 * that directory (see `AgentBrowser.close()`'s doc comment for exactly
 * when the file is finalized and how its path is recovered). The
 * directory is created *eagerly* here via `mkdirSync` — unlike
 * `executeAction`'s own *lazy* mkdir-on-failure — because Playwright
 * needs the directory to already exist before `newContext({ recordVideo
 * })`, confirmed directly against a real launch rather than assumed from
 * documentation. */
export async function launchAgentBrowser(options?: {
  headless?: boolean
  storageState?: StorageState
  recordVideoDir?: string
}): Promise<AgentBrowser> {
  let playwright: typeof import('playwright')
  try {
    playwright = require('playwright')
  } catch {
    throw new AgentBrowserUnavailableError(
      'five46 test needs the optional playwright dependency — install it with: npm install --save-dev playwright'
    )
  }

  try {
    if (options?.recordVideoDir) mkdirSync(options.recordVideoDir, { recursive: true })
    const browser = await playwright.chromium.launch({ headless: options?.headless ?? true })
    const context = await browser.newContext({
      ...(options?.storageState ? { storageState: options.storageState } : {}),
      ...(options?.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir } } : {}),
    })
    const page = await context.newPage()
    return {
      page,
      context,
      async close() {
        // Playwright only finalizes/writes a video file to disk on context
        // close, not `browser.close()` alone — `page.video()` must be read
        // *before* teardown, and `context.close()` (previously never called
        // separately here — only `browser.close()` was) must actually run
        // for the file to be flushed, confirmed via a real regression test
        // rather than trusted from documentation alone.
        const video = page.video()
        await context.close()
        await browser.close()
        let videoPath: string | undefined
        if (video) {
          try {
            videoPath = await video.path()
          } catch {
            // Best-effort — a video-capture failure must never fail close().
          }
        }
        return { videoPath }
      },
    }
  } catch (err) {
    throw new AgentBrowserUnavailableError(describeUnavailable(err))
  }
}

/** In-browser element outline, walked in a single `page.evaluate()` round
 * trip rather than one Playwright call per element — the same interactive
 * elements CSS selector this codebase already uses for JSX/template
 * attribute scanning conceptually (native form controls, links, anything
 * with an explicit ARIA role), just evaluated against the real live DOM
 * instead of parsed source. Filters out anything not actually visible
 * (zero-size, `display:none`, `hidden`, `aria-hidden`) before the caller
 * even sees it — an invisible element isn't a real, clickable option. */
const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'button, a, input, select, textarea, [role]'
  const nodes = Array.from(document.querySelectorAll(SELECTOR))
  function isVisible(el) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (el.hasAttribute('hidden')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    return true
  }
  // Any vertical overlap with the current viewport counts — not "fully
  // visible," just "at least partially reachable without scrolling."
  // Reuses the same getBoundingClientRect() call isVisible already makes
  // conceptually (a fresh call here, since isVisible only returns a
  // boolean, not the rect itself).
  function isInViewport(el) {
    const rect = el.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight
  }
  function labelText(el) {
    // Real accessible-name computation, matched at the level this needs
    // (not the full ARIA AccName spec): aria-labelledby, then an explicit
    // <label for="id">, then an implicit wrapping <label>. Found via a
    // real, high-impact gap: an ordinary <label for="username">Username</label>
    // + <input id="username"> with no aria-label/placeholder — an extremely
    // common, unremarkable form pattern — previously produced a completely
    // nameless field, making the agent unable to identify it at all. This
    // isn't a login-specific fix; it's a general snapshot-quality fix that
    // happened to be found while building the login fixture.
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy)
      if (labelEl && labelEl.textContent) return labelEl.textContent.trim()
    }
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
      if (forLabel && forLabel.textContent) return forLabel.textContent.trim()
    }
    const wrappingLabel = el.closest('label')
    if (wrappingLabel && wrappingLabel.textContent) return wrappingLabel.textContent.trim()
    return ''
  }
  function accessibleName(el) {
    return (
      el.getAttribute('aria-label') ||
      labelText(el) ||
      (el.textContent ? el.textContent.trim().slice(0, 80) : '') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('value') ||
      ''
    )
  }
  function roleOf(el) {
    if (el.hasAttribute('role')) return el.getAttribute('role')
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'input') {
      // The implicit ARIA role depends on 'type', not just the tag — found
      // via a real live run: a checkbox reported role "textbox" (the old,
      // tag-only fallback), which could genuinely mislead the model into
      // reaching for 'fill' on something it should 'click'. Matches the
      // standard HTML-AAM implicit-role mapping for the cases that matter
      // for this project's own click-vs-fill action vocabulary; anything
      // else (text, email, password, search, tel, url, date, number, ...)
      // keeps the existing 'textbox' default, unchanged.
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      return 'textbox'
    }
    return tag
  }
  function nthOfTypeIndex(el) {
    // The real, CSS-spec-accurate index: how many *preceding siblings*
    // share this tag name, scoped to this element's actual parent — never
    // a page-wide count. A page-global counter (an earlier version of this
    // function used one) produces a number that isn't what ':nth-of-type()'
    // means at all: that pseudo-class is always scoped to siblings under
    // the same parent, so a global count silently builds a selector that
    // targets a *different* element (or, as found via a real live run
    // against the-internet.herokuapp.com's login flow, no element at all —
    // a genuine login success got reported as an invisible-element failure
    // purely because of this mismatch).
    let index = 1
    let sibling = el.previousElementSibling
    while (sibling) {
      if (sibling.tagName === el.tagName) index++
      sibling = sibling.previousElementSibling
    }
    return index
  }
  function positionalSelector(el) {
    // Walks up from the element to <body>, building a real, unique CSS
    // path — one ':nth-of-type()' segment per level, each correctly scoped
    // to its own parent. Stops early and anchors on an ancestor's real
    // '[id="..."]' the moment one is found (most real pages have *some*
    // identifiable container not far up), so the path stays short instead
    // of always walking all the way to <body>.
    const segments = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        // CSS.escape, not a hand-rolled escaper — this runs inside the real
        // browser context (unlike Node-side computeSelector, where CSS
        // doesn't exist at all), and the same file already trusts it for
        // exactly this shape of value in labelText's 'label[for="..."]'
        // lookup just above.
        segments.unshift('[id="' + CSS.escape(node.id) + '"]')
        return segments.join(' > ')
      }
      segments.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + nthOfTypeIndex(node) + ')')
      node = node.parentElement
    }
    segments.unshift('body')
    return segments.join(' > ')
  }
  return nodes.filter(isVisible).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: accessibleName(el),
    id: el.id || undefined,
    testId: el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-test') || undefined,
    positionalSelector: positionalSelector(el),
    inViewport: isInViewport(el),
  }))
})()`

interface RawSnapshotElement {
  tag: string
  role: string
  name: string
  id?: string
  testId?: string
  /** A real, unique CSS path already computed in the browser context (see
   * `positionalSelector` inside `SNAPSHOT_SCRIPT`) — used only when neither
   * `testId` nor `id` is available. Must be computed there, not in Node:
   * a correct `:nth-of-type()` index is scoped to each element's actual
   * parent, which requires real DOM access `computeSelector` (Node-side)
   * doesn't have. */
  positionalSelector: string
  /** Whether this element had any vertical overlap with the viewport at
   * snapshot time — used by `snapshot()`'s `prioritizeViewport` option,
   * never by anything inside the page context itself. */
  inViewport: boolean
}

/** Preference order for a real, working selector, also reused by
 * `generateSpec.ts` for readable generated code: a test-id attribute (most
 * stable, least likely to break on unrelated markup changes) → `id` → the
 * pre-computed positional CSS path. `getByRole` is deliberately not
 * attempted here — a *computed* role/name pair can't always round-trip
 * back into a valid `getByRole` call (accessible-name computation has real
 * edge cases this codebase doesn't fully reimplement), and a raw CSS
 * selector that's already confirmed to resolve is safer than a second,
 * independent name-matching pass that might not agree with the first. */
/** Escapes a value for embedding in a CSS attribute-selector string
 * (`[attr="..."]`) — only backslash and double-quote need escaping in this
 * position, unlike a bare CSS identifier (`#foo`), which has a much larger
 * set of special characters and needs the browser-only `CSS.escape()` API.
 * `computeSelector` runs in Node (not inside `page.evaluate()`), where
 * `CSS` doesn't exist — found by actually running this against a real page,
 * not by reasoning about it in advance. Using `[id="..."]` instead of
 * `#id` sidesteps needing `CSS.escape` at all. */
function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function computeSelector(el: RawSnapshotElement): string {
  if (el.testId) {
    const v = escapeAttrValue(el.testId)
    return `[data-testid="${v}"], [data-cy="${v}"], [data-test="${v}"]`
  }
  if (el.id) return `[id="${escapeAttrValue(el.id)}"]`
  return el.positionalSelector
}

/** One `page.evaluate()` round trip to find every visible interactive
 * element, then ref-assignment/selector-computation happens here in Node —
 * never inside the page, and never authored by an LLM. Caps at
 * `maxElements` and discloses truncation explicitly via
 * `PageOutline.truncated` — capping silently would let the agent decide on
 * an incomplete picture of the page without ever knowing that happened.
 *
 * `prioritizeViewport` (default off) sorts in-viewport elements ahead of
 * off-screen ones before capping — a **stable** sort, so document order is
 * preserved within each group. Off by default so the cap is otherwise a
 * plain document-order slice (the same page always caps the same way
 * regardless of scroll position) — deliberately **not** used by
 * `executeAction`'s self-healing re-match (see its call site below): if
 * healing's ambiguity check searched a viewport-reordered list, whether a
 * duplicate-named element falls inside the cap would depend on current
 * scroll position instead of page structure, making an already-refused
 * "ambiguous, won't guess" case silently flip to "one match, heal it"
 * purely because the second match scrolled off-screen — the caller driving
 * the agentic loop (`runner.ts`) opts in; healing never does. */
export async function snapshot(page: import('playwright').Page, maxElements = 40, prioritizeViewport = false): Promise<PageOutline> {
  const raw = (await page.evaluate(SNAPSHOT_SCRIPT)) as RawSnapshotElement[]

  const withSelectors = raw.map((el) => ({ ...el, selector: computeSelector(el) }))
  const ordered = prioritizeViewport
    ? [...withSelectors].sort((a, b) => (a.inViewport === b.inViewport ? 0 : a.inViewport ? -1 : 1))
    : withSelectors

  const capped = ordered.slice(0, maxElements)
  const elements: OutlineElement[] = capped.map((el, i) => ({
    ref: `e${i + 1}`,
    tag: el.tag,
    role: el.role,
    name: el.name,
    selector: el.selector,
  }))

  return {
    elements,
    truncated: withSelectors.length > maxElements,
    totalFound: withSelectors.length,
  }
}

function resolve(outline: PageOutline, ref: string): OutlineElement | undefined {
  return outline.elements.find((el) => el.ref === ref)
}

/** Fixed, not model-controlled — see `AgentAction`'s `wait` case doc comment
 * for why. `page.waitForTimeout()` is normally a Playwright anti-pattern
 * (condition-based waits are almost always better), but it's the right tool
 * here specifically because there IS no better condition to wait on: the
 * real page that motivated this (`the-internet.herokuapp.com`'s dynamic-
 * loading demo) delays via a client-side `setTimeout`, not a network
 * request, so `page.waitForLoadState('networkidle')` would resolve
 * immediately without helping at all. 3s: two consecutive `wait` actions
 * (allowed — see `runner.ts`'s repeat-guard, a third identical one trips
 * `stuck-repeating`) cover a good real-world 5-6s spinner without the model
 * needing to guess a duration itself. Exported so `generateSpec.ts` can
 * render the identical duration into the generated `.spec.ts`'s
 * `page.waitForTimeout()` call, rather than a second, independently-drifting
 * hardcoded number. */
export const WAIT_ACTION_MS = 3000

/** How long `assert_visible`/`assert_text` poll before giving up — matches
 * Playwright's own `expect().toBeVisible()` default timeout, which is
 * exactly what the generated `.spec.ts` for a successful assertion calls
 * (see `generateSpec.ts`). Before this, a live-run assertion was a single
 * instantaneous check with no retry at all — strictly weaker than the
 * generated spec's own semantics for the identical assertion, so a real
 * assertion racing content that was about to appear a moment later would
 * spuriously fail during the live run even though the spec it produces
 * would have passed. */
const ASSERT_WAIT_MS = 5000

/** Executes one already-parsed, already-ref-validated action against the
 * real page. Any Playwright-level failure (element detached, navigation
 * mid-action, timeout) is caught here and turned into an honest `ok: false`
 * result with a screenshot + DOM snapshot, never an uncaught exception that
 * would abort the whole run — same "one failure degrades one step, not the
 * whole file" posture as `tryObserveDynamically`'s per-combination
 * try/catch.
 *
 * `click`/`fill` get one bounded, disclosed self-healing attempt if their
 * selector goes stale (0 matches) between snapshot time and now — see the
 * dedicated block below and DEVELOPMENT.md's "Self-healing selectors"
 * section for the full design (why only these two action types, why only a
 * definitive 0-match failure, why credential fills are excluded).
 * `assert_visible`/`assert_text` are the run's actual verdict and are
 * completely untouched — nothing below ever runs for them. */
export async function executeAction(
  page: import('playwright').Page,
  action: AgentAction,
  outline: PageOutline,
  artifactDir: string,
  stepNumber: number,
  credentials?: LoginCredentials
): Promise<StepExecutionResult> {
  const fail = async (detail: string): Promise<StepExecutionResult> => {
    mkdirSync(artifactDir, { recursive: true })
    const screenshotPath = join(artifactDir, `step-${stepNumber}-failure.png`)
    const domSnapshotPath = join(artifactDir, `step-${stepNumber}-failure.html`)
    try {
      await page.screenshot({ path: screenshotPath })
      writeFileSync(domSnapshotPath, await page.content())
    } catch {
      // Best-effort artifact capture — a failure to capture evidence of a
      // failure shouldn't itself throw and mask the real failureDetail.
      return { ok: false, failureDetail: detail }
    }
    // Found via a real, live failure: a fully-rendered real page (confirmed
    // via its own screenshot) got a root-cause hypothesis claiming it was
    // "blank"/"failed to load," because that page's actual content (a room
    // description, a price) had no button/a/input/[role] markup at all, so
    // almost nothing showed up in the interactive-elements outline —
    // rootCause.ts's LLM prompt has no way to tell "few interactive
    // elements" apart from "little content" on outline alone. This is a
    // *local file* only, deliberately never fed into any LLM prompt —
    // rootCause.ts's own doc comment establishes "only what the LLM already
    // saw during the run, never a live, previously-undisclosed value" as a
    // real, deliberate privacy rule (the same one that scrubs assert_text's
    // mismatched value), and the page's full rendered text is exactly the
    // kind of previously-undisclosed live value that rule exists to keep
    // out of a third-party LLM call — this is for a human reviewing the
    // failure report to open directly, same as the screenshot/DOM snapshot.
    let visibleTextPath: string | undefined
    try {
      const rawText = await page.locator('body').innerText({ timeout: 2000 })
      const bounded = rawText.length > MAX_VISIBLE_TEXT_CHARS ? rawText.slice(0, MAX_VISIBLE_TEXT_CHARS) + '... (truncated)' : rawText
      const candidatePath = join(artifactDir, `step-${stepNumber}-failure-visible-text.txt`)
      writeFileSync(candidatePath, bounded)
      visibleTextPath = candidatePath
    } catch {
      // Same best-effort posture as the screenshot/DOM capture above — an
      // empty/unreadable body shouldn't mask the real failureDetail.
    }
    return { ok: false, failureDetail: detail, screenshotPath, domSnapshotPath, visibleTextPath }
  }

  if (action.action === 'done') return { ok: true }

  if (action.action === 'wait') {
    await page.waitForTimeout(WAIT_ACTION_MS)
    return { ok: true }
  }

  if (action.action === 'assert_page_text') {
    // Same bounded-poll shape as assert_text below, against `body` instead
    // of a specific outline-derived selector — this is the whole point:
    // no `ref`, no outline element required at all.
    const expected = substitutePlaceholders(action.expectedText, credentials)
    const deadline = Date.now() + ASSERT_WAIT_MS
    const body = page.locator('body')
    let lastText = ''
    while (true) {
      const remaining = deadline - Date.now()
      try {
        lastText = (await body.innerText({ timeout: Math.max(remaining, 1) })) ?? ''
        if (lastText.includes(expected)) return { ok: true }
      } catch {
        // Body not settled yet, or this iteration's own timeout elapsed —
        // keep polling until the outer deadline.
      }
      if (Date.now() >= deadline) break
      await page.waitForTimeout(150)
    }
    return await fail(`expected the page to contain text "${action.expectedText}", but it never appeared`)
  }

  if (action.action === 'scroll') {
    try {
      // String-evaluated (like SNAPSHOT_SCRIPT above), not an inline TS
      // function — this project's tsconfig deliberately has no "dom" lib
      // (Node-only types; adding it risks colliding with Node's own
      // global fetch/Headers/Response types this codebase already uses
      // directly), so browser-context code can't reference `window`
      // inside an ordinary typed function passed to page.evaluate().
      //
      // The object form with an explicit behavior:'instant' bypasses a
      // page's CSS scroll-behavior:'smooth' entirely — the 2-arg
      // scrollBy(x, y) form defaults to behavior:'auto', which respects
      // that CSS, and reading scrollY synchronously right after would see
      // the animation not yet having run, producing a false "didn't move"
      // signal on a page that scrolls just fine.
      const delta = action.direction === 'down' ? 'window.innerHeight' : '-window.innerHeight'
      const scrolled = (await page.evaluate(`(() => {
        const before = window.scrollY
        window.scrollBy({ top: ${delta}, left: 0, behavior: 'instant' })
        return window.scrollY !== before
      })()`)) as boolean
      return { ok: true, scrolled }
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  const el = resolve(outline, action.ref)
  if (!el) return fail(`ref "${action.ref}" not found in this turn's outline`)
  const locator = page.locator(el.selector).first()

  if (action.action === 'assert_visible') {
    // Polls, rather than a single instantaneous check — matches
    // `expect(locator).toBeVisible()`'s own default auto-retry behavior,
    // which is exactly what the generated spec calls for this same
    // assertion (see `generateSpec.ts`). Without this, a live-run assertion
    // was strictly weaker than the spec it produces: content that was a
    // moment away from appearing would spuriously fail the live run even
    // though the recorded spec, re-run later, would pass.
    try {
      await locator.waitFor({ state: 'visible', timeout: ASSERT_WAIT_MS })
      return { ok: true }
    } catch {
      return await fail(`element "${el.name}" (ref ${el.ref}) is not visible`)
    }
  }

  if (action.action === 'assert_text') {
    // Same reasoning as assert_visible above — Playwright has no locator-
    // level "wait for text" outside test-runner `expect()`, so this polls
    // by hand at the same cadence/timeout instead of a single instant read.
    // Each individual `.textContent()` call is given its own short timeout
    // (not left to Playwright's own 30s default) — otherwise a single
    // stalled/never-attached call could block well past `ASSERT_WAIT_MS`
    // before this loop ever got a chance to retry, defeating the whole
    // point of a bounded poll.
    const expected = substitutePlaceholders(action.expectedText, credentials)
    const deadline = Date.now() + ASSERT_WAIT_MS
    let lastText = ''
    while (true) {
      const remaining = deadline - Date.now()
      try {
        lastText = (await locator.textContent({ timeout: Math.max(remaining, 1) })) ?? ''
        if (lastText.includes(expected)) return { ok: true }
      } catch {
        // Not attached yet, or this iteration's own timeout elapsed — keep
        // polling until the outer deadline rather than failing on one miss.
      }
      if (Date.now() >= deadline) break
      await page.waitForTimeout(150)
    }
    // Same rule as `fill`: `fail()`'s message always references the
    // original `action.expectedText` (the placeholder token, if that's
    // what it was) — never the substituted one, or a real credential would
    // leak into the failure detail, which flows into `history` (the next
    // prompt) and the printed report.
    return await fail(`expected text containing "${action.expectedText}", got "${lastText.trim()}"`)
  }

  // click / fill from here on — the only two action types eligible for
  // selector healing. `attempt` performs the whole logical action against
  // a given selector, so a heal-and-retry re-runs fill *and* the optional
  // submit press together, not just the first Playwright call.
  const attempt = async (selector: string): Promise<void> => {
    const target = page.locator(selector).first()
    if (action.action === 'click') {
      await target.click({ timeout: 5000 })
      return
    }
    if (action.action === 'fill') {
      // Substituted into a LOCAL variable only, used solely for the real
      // Playwright call. `action.value` itself is never written to — it's
      // the same object reference `runner.ts` pushes into `steps`/`history`
      // right after this returns, so mutating it here would leak the real
      // secret into the next LLM prompt and the generated spec. See
      // `substitutePlaceholders`'s doc comment.
      const fillValue = substitutePlaceholders(action.value, credentials)
      await target.fill(fillValue, { timeout: 5000 })
      if (action.submit) await target.press('Enter')
    }
  }

  const isCredentialFill =
    action.action === 'fill' && (action.value.includes(USERNAME_PLACEHOLDER) || action.value.includes(PASSWORD_PLACEHOLDER))

  try {
    await attempt(el.selector)
    return { ok: true }
  } catch (err) {
    const originalDetail = err instanceof Error ? err.message.split('\n')[0] : String(err)

    // Never heal a credential fill — a heuristic (tag, role, name) match
    // could land the real secret into the wrong element. A missed step is
    // strictly safer than a misdirected credential.
    if (isCredentialFill) return fail(originalDetail)

    // Checked here, AFTER the real Playwright call already ran its full
    // 5s timeout — not before. Checking before would misdiagnose "hasn't
    // rendered yet" (a normal, transient state Playwright's own auto-wait
    // already handles correctly) as "definitely stale," discarding that
    // existing timing resilience. By the time we're here, the page has
    // already had the full 5s to settle, so an immediate count is a fair,
    // honest signal — not a guess.
    const staleCount = await page.locator(el.selector).count()
    if (staleCount !== 0) {
      // The element still exists — a real interaction problem (covered by
      // an overlay, disabled, mid-animation) that a different selector for
      // the same element wouldn't fix anyway. Not a staleness case, so no
      // healing attempt — just an honest failure.
      return fail(originalDetail)
    }

    // 0 matches: the selector is definitively stale. Re-snapshot and
    // re-match the same element by (tag, role, name) — the same
    // accessible-name computation already trusted everywhere else in this
    // codebase, never a fuzzier heuristic. Only an exactly-one match is
    // ever accepted; ambiguity is refused, not guessed at, matching this
    // codebase's "never guess" posture everywhere else (a hallucinated
    // ref/{{var}} reference, an unresolved JSON path, ...).
    const freshOutline = await snapshot(page)
    const candidates = freshOutline.elements.filter((fe) => fe.tag === el.tag && fe.role === el.role && fe.name === el.name)

    if (candidates.length === 0) {
      return fail(`selector went stale (0 matches): ${originalDetail} — re-matching by name found no candidate, giving up`)
    }
    if (candidates.length > 1) {
      return fail(
        `selector went stale (0 matches): ${originalDetail} — re-matching by name found ${candidates.length} ambiguous candidates, refusing to guess which one`
      )
    }

    const healedSelector = candidates[0].selector
    try {
      await attempt(healedSelector)
      return { ok: true, healed: true, healedSelector }
    } catch (healErr) {
      return fail(
        `selector went stale (0 matches): ${originalDetail} — healed to a re-matched element, but the retry also failed: ${
          healErr instanceof Error ? healErr.message.split('\n')[0] : String(healErr)
        }`
      )
    }
  }
}
