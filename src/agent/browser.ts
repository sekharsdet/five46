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
  /** `0` for the original tab, `1` for the first tab opened after it (a
   * `target="_blank"` link, `window.open()`), `2` for the next, and so
   * on — always in lockstep with `page` itself, since both flip together
   * the moment a new tab's own navigation settles (see the `context.on
   * ('page', ...)` handler below). `ExecutedStep.pageIndex`'s own doc
   * comment explains why `generateSpec.ts` needs this. */
  pageIndex: number
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
  /** Present only when `verifyRoleLocator()` confirmed, live, that
   * `page.getByRole(role, { name })` resolves uniquely to the exact same
   * element the (guaranteed-correct) `selector`/`healedSelector` above
   * targeted — never used for the live action itself (which always uses
   * `selector`/`healedSelector`, completely unchanged by this field's
   * presence), only as `generateSpec.ts`'s preferred choice for what to
   * emit in the *exported* spec, since `getByRole` is far more resilient
   * to future DOM restructuring than a positional CSS path. See
   * `verifyRoleLocator`'s own doc comment for why this needs a real,
   * live check rather than a static assumption. */
  verifiedRoleLocator?: { role: string; name: string }
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
    // Auto-accepts every native JS dialog (alert/confirm/prompt/
    // beforeunload) on every page in this context, present and future (see
    // the `context.on('page', ...)` handler below, which attaches this to
    // every subsequently-opened tab too). Playwright's own default with no
    // handler at all is to auto-*dismiss* a dialog — found via a real, live
    // gap (the-internet.herokuapp.com's own JS-confirm demo): a goal asking
    // to accept a confirm() and see its "Ok" result instead saw "Cancel,"
    // regardless of what the goal actually asked for, since nothing in this
    // codebase ever called `dialog.accept()`/`dialog.dismiss()` at all.
    // Accept-by-default matches the overwhelmingly common real intent (the
    // agent is trying to make progress through the page, not test a cancel
    // path) — a goal that specifically needs to *dismiss* a dialog instead
    // is a known, accepted gap, not silently pretended to be covered.
    const autoAcceptDialogs = (p: import('playwright').Page) => {
      p.on('dialog', (dialog) => {
        dialog.accept().catch(() => {
          // Best-effort — a dialog that's already been handled, or a page
          // that's mid-navigation/closing, must never throw out of an
          // event handler and crash the run over a dialog it was already
          // done with.
        })
      })
    }
    autoAcceptDialogs(page)
    // Tracks "whichever page the agent should currently be driving" — a
    // click on a `target="_blank"` link or a `window.open()` call creates a
    // brand-new `Page` in this same context that the original `page`
    // reference never sees again. Found via a real, live gap
    // (the-internet.herokuapp.com's own new-window demo): every subsequent
    // snapshot/action kept silently operating on the now-stale original
    // tab, so a goal needing the new tab's content could never succeed.
    // `activePage` only flips once the new page's own navigation has
    // actually settled (`waitForLoadState`) — not the instant the `Page`
    // object exists — so the very next snapshot doesn't race a still-blank
    // document; falls back to flipping anyway on a `waitForLoadState`
    // failure (a page that never truly settles) rather than leaving the
    // agent stuck driving a tab it can no longer usefully act on.
    let activePage = page
    let activePageIndex = 0
    let nextPageIndex = 1
    context.on('page', (newPage) => {
      autoAcceptDialogs(newPage)
      const assignedIndex = nextPageIndex++
      newPage
        .waitForLoadState('load', { timeout: 10000 })
        .catch(() => {})
        .finally(() => {
          activePage = newPage
          activePageIndex = assignedIndex
        })
    })
    return {
      get page() {
        return activePage
      },
      get pageIndex() {
        return activePageIndex
      },
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

/** Computes a real, working selector for a single element already resolved
 * as an `ElementHandle` — the standalone-element counterpart of
 * `computeSelector()`'s own testId → id → positional preference order.
 * Used for the one iframe/frame *host* element itself (see
 * `frameChainSelectors()` below), and — since `collectAriaOutline()`
 * resolves every `ariaSnapshot()` candidate to a real `ElementHandle`
 * individually rather than batching a single in-page script the way
 * discovery used to — for every ordinary candidate's own selector too.
 *
 * A real, `el: any`-typed function passed directly to `ElementHandle.
 * evaluate()` — deliberately NOT a string, unlike the other in-page
 * script in this file (`ICON_FALLBACK_SCRIPT`, the scroll script). Confirmed via
 * a real, live repro against Playwright 1.62.0 that a *string* pageFunction
 * given to `ElementHandle.evaluate()` never actually invokes with the
 * target element bound as its first argument at all (the function body
 * itself never ran; every property read against `el` silently resolved to
 * `undefined`) — this is a real, load-bearing constraint of this exact
 * Playwright version's `ElementHandle.evaluate(string)` behavior, not a
 * hypothetical concern. `el: any` (rather than a typed DOM parameter)
 * sidesteps this project's deliberate lack of a "dom" lib in `tsconfig`
 * the same way the string form did for `page.evaluate()` calls elsewhere:
 * every property here is reached through `el`/its ancestors (`el.id`,
 * `el.ownerDocument.body`, `node.parentElement`, ...), never a bare global
 * (`document`, `window`, `CSS`) that would actually require dom lib types.
 * Escaping the returned raw `id`/testId string happens back in Node via
 * the existing `escapeAttrValue()` (see below), the same split this file's
 * `computeSelector()` already uses between in-page traversal and Node-side
 * string escaping. */
async function frameElementSelector(handle: import('playwright').ElementHandle): Promise<string> {
  const raw = (await handle.evaluate((el: any) => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-test')
    if (testId) return { testId }
    if (el.id) return { id: el.id }
    const body = el.ownerDocument.body
    const segments: string[] = []
    let node = el
    let ancestorId: string | undefined
    while (node && node.nodeType === 1 && node !== body) {
      if (node.id) {
        ancestorId = node.id
        break
      }
      let index = 1
      let sibling = node.previousElementSibling
      while (sibling) {
        if (sibling.tagName === node.tagName) index++
        sibling = sibling.previousElementSibling
      }
      segments.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')')
      node = node.parentElement
    }
    return { ancestorId, segments }
  })) as { testId?: string; id?: string; ancestorId?: string; segments?: string[] }

  if (raw.testId) {
    const v = escapeAttrValue(raw.testId)
    return `[data-testid="${v}"], [data-cy="${v}"], [data-test="${v}"]`
  }
  if (raw.id) return `[id="${escapeAttrValue(raw.id)}"]`
  const prefix = raw.ancestorId ? `[id="${escapeAttrValue(raw.ancestorId)}"]` : 'body'
  return [prefix, ...(raw.segments ?? [])].join(' > ')
}

interface RawSnapshotElement {
  tag: string
  role: string
  name: string
  id?: string
  testId?: string
  /** A real, unique CSS path already computed in the browser context (see
   * `frameElementSelector`/`ICON_FALLBACK_SCRIPT`'s own `positionalSelector`)
   * — used only when neither `testId` nor `id` is available. Must be
   * computed there, not in Node: a correct `:nth-of-type()` index is scoped
   * to each element's actual parent, which requires real DOM access
   * `computeSelector` (Node-side) doesn't have. */
  positionalSelector: string
  /** Whether this element had any vertical overlap with the viewport at
   * snapshot time — used by `snapshot()`'s `prioritizeViewport` option,
   * never by anything inside the page context itself. */
  inViewport: boolean
  /** True only for a real `<input type="file">` — see `collectAriaOutline()`'s
   * own `isFileInput` check. */
  isFileInput: boolean
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

/** Live-caught (during a real story-mode run against a real production
 * site): an ordinary Playwright timing race, not a real run failure — a
 * `page.evaluate()` that happens to be in flight exactly when a navigation
 * commits throws `"Execution context was destroyed, most likely because of
 * a navigation"`, because the frame it was querying no longer exists. This
 * has nothing to do with the app being tested; retrying once, after giving
 * the new page a moment to settle, is the correct response — not treating
 * it as a genuine tooling/run failure. Scoped to this *exact* error message
 * only (never a blanket retry-on-any-evaluate-failure): a real failure
 * (a page that genuinely never loads, a real script error) must still
 * surface honestly on the first attempt, matching this codebase's "never
 * paper over a real problem" posture everywhere else. Exactly one retry —
 * if the second attempt also throws (even the same error, e.g. a page stuck
 * in a genuine navigation loop), that failure propagates normally. `op`/
 * `settle` are injected (rather than calling `page.evaluate`/
 * `waitForLoadState` directly) so this retry policy itself is directly,
 * deterministically unit-testable without needing to force a real,
 * inherently timing-dependent race in a live browser. */
export async function evaluateWithNavigationRaceRetry<T>(op: () => Promise<T>, settle: () => Promise<void>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('Execution context was destroyed')) throw err
    await settle().catch(() => {
      // Best-effort — if the page never settles, the retry below will
      // simply fail honestly on its own, same as any other real failure.
    })
    return await op()
  }
}

/** Bounds how many extra (non-main) frames a single `snapshot()` call will
 * walk into — a real page can have a large, mostly-irrelevant iframe count
 * (ads, trackers, chat widgets, third-party embeds), and this project's own
 * live testing against production sites (Flipkart, Amazon.in) already
 * established that unbounded per-page work is a real cost/noise risk, not
 * a hypothetical one. 8 comfortably covers every real, live-found case that
 * motivated this feature (one WYSIWYG editor iframe, a handful of frameset
 * panes) while keeping a worst-case pathological page's snapshot cost
 * bounded. */
const MAX_EXTRA_FRAMES = 8

/** Walks from `frame` up to (but not including) the main frame, building an
 * ordered list of CSS selectors — one per frame boundary crossed, outermost
 * first — via `Frame.frameElement()` (the `ElementHandle` for the
 * `<iframe>`/`<frame>` tag that owns this frame in its *parent* frame's own
 * document; works regardless of the child frame's origin, since Playwright
 * resolves this through the browser itself, not through same-origin
 * in-page JS). This exact chain is what `executeAction()` replays via
 * chained `page.frameLocator(...)` calls to resolve the real element later,
 * and what `generateSpec.ts` renders into the exported spec — computed once
 * here so both stay in lockstep by construction rather than by two
 * independently-written traversals agreeing by luck.
 *
 * Best-effort: returns `undefined` (never throws) on any failure — a
 * detached frame, a frame that navigated away mid-walk, a sandboxed frame
 * that refuses script injection. The caller skips that frame's elements
 * entirely rather than risk a broken chain. */
async function frameChainSelectors(frame: import('playwright').Frame): Promise<string[] | undefined> {
  const chain: string[] = []
  try {
    let current: import('playwright').Frame | null = frame
    while (current && current.parentFrame()) {
      const handle = await current.frameElement()
      const selector = await frameElementSelector(handle)
      chain.unshift(selector)
      current = current.parentFrame()
    }
    return chain
  } catch {
    return undefined
  }
}

/** Minimal, standalone script for the one real, confirmed gap a browser's
 * own accessibility tree does NOT cover, used only by `collectAriaOutline()`
 * below: a genuinely clickable icon-only control with no semantic role at
 * all, signaled only by a real accessible-name source (`[title]`/
 * `[aria-label]`) AND an actual pointer cursor together — confirmed live
 * against demoqa.com/webtables' own actual rendered markup, a table row's
 * edit control is exactly `<span data-toggle="tooltip" title="Edit">`
 * wrapping an `<svg>`, invisible to every role/tag-based signal no matter
 * how good the prompt is. Two signals, deliberately required TOGETHER, not
 * either alone, to bound false positives: a real accessible-name source
 * (not a guess — it's what the real edit icon actually has), AND an actual
 * pointer cursor (excludes the common false-positive case of a plain,
 * non-interactive tooltip like `<abbr title="...">`, where title alone is
 * common but mostly not clickable). */
const ICON_FALLBACK_SCRIPT = `(() => {
  const candidates = Array.from(document.querySelectorAll('[title], [aria-label]')).filter((el) => {
    return window.getComputedStyle(el).cursor === 'pointer'
  })
  function isVisible(el) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (el.hasAttribute('hidden')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    return true
  }
  function isInViewport(el) {
    const rect = el.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight
  }
  function nthOfTypeIndex(el) {
    let index = 1
    let sibling = el.previousElementSibling
    while (sibling) {
      if (sibling.tagName === el.tagName) index++
      sibling = sibling.previousElementSibling
    }
    return index
  }
  function positionalSelector(el) {
    const segments = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        segments.unshift('[id="' + CSS.escape(node.id) + '"]')
        return segments.join(' > ')
      }
      segments.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + nthOfTypeIndex(node) + ')')
      node = node.parentElement
    }
    segments.unshift('body')
    return segments.join(' > ')
  }
  return candidates.filter(isVisible).map((el) => ({
    tag: el.tagName.toLowerCase(),
    // Honest fallback to the real tag name, never a guessed semantic role
    // it hasn't earned — matches this exact case's own original design
    // principle (see the doc comment above): a real accessible-name source
    // plus a pointer cursor together are strong enough to say "clickable,"
    // but not strong enough to claim it's specifically a "button".
    role: el.tagName.toLowerCase(),
    name: el.getAttribute('aria-label') || el.getAttribute('title') || '',
    id: el.id || undefined,
    testId: el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-test') || undefined,
    positionalSelector: positionalSelector(el),
    inViewport: isInViewport(el),
    isFileInput: false,
  }))
})()`

/** Lazily `require()`'d the same way `launchAgentBrowser` requires
 * `playwright` itself — `yaml` is an `optionalDependencies` entry (see
 * `package.json`), installed alongside `playwright`/`@playwright/test` for
 * `five46 test`/`five46 login`, never needed at all for `five46 api`. A
 * module-level `require()` would force every consumer (including pure API
 * testing) to have it installed; this keeps the same "only pay for it if
 * you actually drive a browser" contract the rest of this file already
 * has. */
function requireYaml(): typeof import('yaml') {
  try {
    return require('yaml')
  } catch {
    throw new AgentBrowserUnavailableError(
      'five46 test needs the optional yaml dependency (installed alongside playwright) — install it with: npm install --save-dev yaml'
    )
  }
}

/** One parsed candidate line from `ariaSnapshot({ mode: 'ai' })`'s YAML
 * output — see `parseAriaKey`'s own doc comment for the exact line grammar
 * this extracts from. `ref` is the *Playwright-assigned* token
 * (`"e2"`/`"f1e3"` for an element inside the first nested frame) — distinct
 * from `OutlineElement.ref`, which `snapshot()` reassigns fresh per call
 * (`"e1"`, `"e2"`, ...), keeping the LLM-facing ref vocabulary unchanged regardless of
 * which discovery mechanism produced it. */
interface AriaCandidate {
  role: string
  name: string
  ref: string
}

/** Parses one YAML *key* string from an `ariaSnapshot({ mode: 'ai' })`
 * result — e.g. `button "Show secret message" [ref=e2]`,
 * `heading "Hello World!" [level=4] [ref=e3]`, or a bare
 * `checkbox [ref=e6]` with no name at all. `yaml.parse()` already handles
 * YAML's own quoting rules (plain/single/double-quoted scalar) transparently
 * — confirmed live, a name containing `:` (which forces Playwright's
 * serializer into a quoted YAML style to stay valid) round-trips through
 * `yaml.parse()` into the exact same flat string shape as a name with no
 * special characters at all. What's left, on top of that, is Playwright's
 * OWN backslash-escaping convention for a literal `"` *inside* the name
 * (`Say \"hi\"`) — that's this function's job to undo, not YAML's; confirmed
 * live that `\\(.)` (any backslash followed by any character, replaced by
 * just that character) correctly reverses it. Returns `undefined` for a key
 * that doesn't match this grammar at all (defensive — never seen in
 * practice, but a parse miss must degrade to "skip this line," never throw
 * and lose the whole snapshot). */
function parseAriaKey(key: string): { role: string; name: string; ref?: string } | undefined {
  const match = key.match(/^([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*$/)
  if (!match) return undefined
  const [, role, rawName, attrsBlob] = match
  const name = rawName ? rawName.replace(/\\(.)/g, '$1') : ''
  let ref: string | undefined
  for (const attrMatch of attrsBlob.matchAll(/\[([^\]]*)\]/g)) {
    const [attrKey, attrValue] = attrMatch[1].split('=')
    if (attrKey === 'ref') ref = attrValue
  }
  return { role, name, ref }
}

/** Roles that are ALWAYS structural/layout-only noise, regardless of
 * whether they happen to carry a name — a real goal is never going to
 * click, fill, hover, or assert against the *collection* itself: `list`
 * (the `<ul>`/`<ol>` wrapper — the individual items inside are the real
 * candidates, see `NAME_GATED_NOISE_ROLES` below for exactly how those earn
 * inclusion), the `<iframe>` host element itself (its content is already
 * flattened into this same list, frame-prefixed, by `ariaSnapshot` — the
 * host tag itself was never a real five46 candidate even under the old
 * `SNAPSHOT_SCRIPT`), and `document` (the whole-page wrapper node
 * `ariaSnapshot`'s `'html'`-scoped root always adds — see
 * `collectAriaOutline`'s own doc comment for why `'html'`, not `'body'`, is
 * the actual scope). Kept intentionally small and named-by-direct-
 * observation rather than an attempted exhaustive list of every non-
 * interactive ARIA role — expand only when a real, live case proves another
 * role is pure noise too, the same "confirmed via a real case" discipline
 * every other heuristic in this file already follows. */
const STRUCTURAL_NOISE_ROLES = new Set(['iframe', 'list', 'document'])

/** Roles that are noise ONLY when unnamed — contrast with
 * `STRUCTURAL_NOISE_ROLES` above, which excludes unconditionally. `generic`
 * is the original case (a plain wrapper `<div>`, or `<html>`/`<body>` itself
 * — contrast with a *named* `generic`, e.g. a `contenteditable` with an
 * `aria-label`, which earns inclusion via the name check at the call site
 * below). `listitem` is a second, real, live-found case of the same shape:
 * a `<li>` wrapping its own real candidate (a button, a link) has no name
 * of its own and is correctly noise — but a *plain* `<li>Item A</li>` with
 * no other markup inside is itself the only representable unit for that
 * item, and blanket-excluding `listitem` the way `list` is (see above) left
 * it with literally no ref at all — confirmed live via `src/eval/`'s own
 * drag-and-drop regression probe: a bare, unlabeled `<li>` list of sortable
 * items produced ZERO outline candidates, not just a missing `drag` action.
 * A named `listitem` (via `aria-label`, or the content-value fallback the
 * call site already applies to any non-`generic` role) is a real, useful
 * candidate; an unnamed one wrapping its own already-listed child is
 * correctly still noise. */
const NAME_GATED_NOISE_ROLES = new Set(['generic', 'listitem'])

/** Recursively walks the plain-JS shape `yaml.parse()` produces for an
 * `ariaSnapshot({ mode: 'ai' })` result — an array of nodes, each either a
 * bare string (a leaf with no children, e.g. `button "Go" [ref=e2]`) or a
 * single-key object whose key is that same kind of string and whose value
 * is either child nodes (an array, recursed into) or a plain string (literal
 * text *content*, e.g. a contenteditable's current value — never itself
 * parsed as another node, since that string doesn't follow the
 * role/name/attrs grammar `parseAriaKey` expects at all). Confirmed live
 * against every shape actually observed: a leaf value bearing a "text" key,
 * a nested `/url` metadata child, multi-level frame nesting — pushes a
 * candidate for any node whose key carries a `ref`, silently skips
 * everything else (never throws on an unrecognized shape, matching this
 * file's established "a malformed one node degrades gracefully" posture). */
/** Pushes one parsed key as a candidate, unless it's structural noise (see
 * `STRUCTURAL_NOISE_ROLES`'s own doc comment) — shared between both shapes
 * `collectAriaCandidates` walks (a bare string leaf, or an object key paired
 * with a value). `contentValue` is the node's own value when it's a plain
 * string (e.g. `status [ref=e4]: "The secret message is: ..."` — real, live-
 * found gap: an element whose accessible name is computed from its own text
 * *content*, not an explicit `aria-label`, gets an EMPTY name in the role
 * line itself; `ariaSnapshot` puts that text in the value position instead.
 * Confirmed live: this is exactly how a `role="status"` element with no
 * `aria-label` — this project's own `reveal.html` fixture — is rendered.
 * Only used as a fallback when the key itself had no name at all — an
 * explicit `aria-label`-derived name (already correctly in the key, e.g. the
 * `contenteditable`/`aria-label="Message body"` case) always wins, matching
 * real accessible-name-computation precedence. Truncated to 80 chars, same
 * bound the old `SNAPSHOT_SCRIPT`'s `accessibleName()` already applied to a
 * content-derived name, to keep prompt size bounded regardless of which
 * mechanism produced it. */
function pushAriaCandidate(key: string, contentValue: string | undefined, out: AriaCandidate[]): void {
  const parsed = parseAriaKey(key)
  if (!parsed?.ref) return
  if (STRUCTURAL_NOISE_ROLES.has(parsed.role)) return
  // The content-value fallback is deliberately withheld for a bare
  // `generic` node — confirmed live this was too broad otherwise: an
  // ordinary, non-interactive `<div>Some plain text</div>` with no explicit
  // `aria-label` (and so no name in the key itself) would otherwise turn
  // into a candidate purely because it happens to contain text, exactly the
  // "an unnamed generic wrapper is noise" rule this file already
  // establishes — a `generic` only ever earns a real name via an explicit
  // label (already in `parsed.name`), never merely by containing text.
  // Every other role (`status`, `heading`, `paragraph`, ...) is a real,
  // semantically-meaningful node Chromium chose to expose on its own — its
  // content-derived name is trustworthy the same way `SNAPSHOT_SCRIPT`'s
  // own `accessibleName()` always trusted `textContent` as a real fallback.
  const rawName = parsed.name || (parsed.role !== 'generic' && contentValue ? contentValue.trim() : '')
  if (NAME_GATED_NOISE_ROLES.has(parsed.role) && !rawName) return
  // Truncated to 80 chars, matching the old `SNAPSHOT_SCRIPT`'s own
  // `accessibleName()` bound — `verifyRoleLocator`'s substring (not exact)
  // getByRole matching in browser.ts depends on this staying truncated, the
  // same reason it was bounded there in the first place: an exact-match
  // getByRole against a long product-title link's *truncated* name would
  // never resolve against the real, untruncated element on the live page.
  out.push({ role: parsed.role, name: rawName.slice(0, 80), ref: parsed.ref })
}

function collectAriaCandidates(node: unknown, out: AriaCandidate[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectAriaCandidates(child, out)
    return
  }
  if (typeof node === 'string') {
    pushAriaCandidate(node, undefined, out)
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      pushAriaCandidate(key, typeof value === 'string' ? value : undefined, out)
      if (Array.isArray(value)) collectAriaCandidates(value, out)
    }
  }
}

/** The replacement for `SNAPSHOT_SCRIPT`-based discovery — see
 * DEVELOPMENT.md's "Migrating element discovery to Playwright's own
 * accessibility snapshot" section for the full investigation this is based
 * on. Root cause this closes: `SNAPSHOT_SCRIPT` is a from-scratch, hand-
 * rolled reimplementation of accessible-name/role computation
 * (`accessibleName()`/`roleOf()`/`labelText()`), and *every* "gap found on a
 * new site" across three separate live-testing sessions traced back to that
 * reimplementation missing a pattern Chromium's own accessibility engine
 * already handles correctly (a `contenteditable` region, a plain heading
 * with no ARIA role, an `<img alt>` with no other affordance signal). This
 * function uses `ariaSnapshot({ mode: 'ai' })` — a first-party Playwright
 * API purpose-built for AI browser agents — instead, confirmed live to
 * auto-cover every one of those cases for free, resolve refs back to real,
 * actionable elements (including transparently through iframe boundaries,
 * no hand-rolled frame-chain walk needed for THIS part), and cost about the
 * same as the old approach (a few ms, negligible next to LLM round-trip
 * latency).
 *
 * Returns the exact same raw shape `snapshotFrames()`'s per-element results
 * already have (`RawSnapshotElement & { selector, frameChain }`) — deliberate,
 * so `snapshot()`'s own ref-assignment/capping/truncation-disclosure logic
 * needs no changes at all regardless of which discovery mechanism fed it. */
async function collectAriaOutline(page: import('playwright').Page): Promise<(RawSnapshotElement & { selector: string; frameChain: string[] })[]> {
  const yamlLib = requireYaml()
  // `'html'`, not `'body'` — real, live-found gap: a classic `<frameset>`
  // page (confirmed against the-internet.herokuapp.com's own nested_frames
  // demo) has no `<body>` element in its main document at all
  // (`<html><frameset>...`), which made `page.locator('body').ariaSnapshot()`
  // throw outright — a hard crash, not a graceful degradation, since this is
  // a one-shot call (unlike `assert_page_text`'s own per-iteration-poll use
  // of `'body'` elsewhere in this file, which already tolerates exactly this
  // failure). `'html'` is present on every real page, frameset or not,
  // confirmed live to still correctly walk into nested frame content either
  // way (an extra top-level `document` node wraps the result, transparently
  // handled the same as any other non-candidate node `collectAriaCandidates`
  // already skips over).
  const snapshotText = await evaluateWithNavigationRaceRetry(
    () => page.locator('html').ariaSnapshot({ mode: 'ai' }),
    () => page.waitForLoadState('load', { timeout: 5000 })
  )
  const candidates: AriaCandidate[] = []
  collectAriaCandidates(yamlLib.parse(snapshotText), candidates)

  const resolved = await Promise.all(
    candidates.map(async (candidate): Promise<(RawSnapshotElement & { selector: string; frameChain: string[] }) | undefined> => {
      try {
        const locator = page.locator(`aria-ref=${candidate.ref}`)
        const handle = await locator.elementHandle({ timeout: 1000 })
        if (!handle) return undefined
        const [selector, ownerFrame, meta] = await Promise.all([
          frameElementSelector(handle),
          handle.ownerFrame(),
          handle.evaluate((el: any) => ({
            tag: (el.tagName || '').toLowerCase(),
            isFileInput: el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file',
            // `el.isContentEditable` (not just the attribute) — reflects
            // real inherited contenteditable state (a child of a
            // contenteditable ancestor counts too), matching what actually
            // determines whether Playwright's own `fill()` accepts it.
            isContentEditable: el.isContentEditable === true,
            hasPointerCursor: el.ownerDocument.defaultView.getComputedStyle(el).cursor === 'pointer',
            inViewport: (() => {
              const rect = el.getBoundingClientRect()
              return rect.bottom > 0 && rect.top < el.ownerDocument.defaultView.innerHeight
            })(),
          })),
        ])
        const frameChain = ownerFrame && ownerFrame.parentFrame() ? await frameChainSelectors(ownerFrame) : []
        // A `contenteditable` region with no more specific ARIA role than
        // `generic` (no explicit `role="textbox"` of its own — most real
        // rich-text widgets don't bother) gets promoted to `textbox` here —
        // real, live-found gap: `generic` gives the model no signal at all
        // that `fill` is the right tool for this ref, the same reason the
        // original `SNAPSHOT_SCRIPT`-based mechanism assigned this role
        // explicitly rather than trusting a computed fallback. An icon-only
        // element (a real accessible-name source — title/aria-label,
        // already how it earned a ref and a name at all — combined with an
        // actual pointer cursor) is a second, real, live-found case of the
        // same shape: confirmed live that the accessibility tree DOES
        // surface this one (unlike the plain-CSS-cursor case
        // `ICON_FALLBACK_SCRIPT` below still exists for), just with a bare
        // `generic` role — promoted here to the real tag name, never a
        // guessed semantic role it hasn't earned, matching this exact
        // element's own original design principle.
        const role =
          candidate.role !== 'generic'
            ? candidate.role
            : meta.isContentEditable
              ? 'textbox'
              : candidate.name && meta.hasPointerCursor
                ? meta.tag
                : candidate.role
        return {
          tag: meta.tag,
          role,
          name: candidate.name,
          positionalSelector: selector,
          selector,
          inViewport: meta.inViewport,
          isFileInput: meta.isFileInput,
          frameChain: frameChain ?? [],
        }
      } catch {
        // Best-effort — a candidate that vanished between the snapshot and
        // this resolution (a real, if rare, timing race) is simply dropped,
        // never allowed to fail the whole snapshot over one stale ref.
        return undefined
      }
    })
  )

  const iconRaw = await page.evaluate(ICON_FALLBACK_SCRIPT).catch(() => []) as RawSnapshotElement[]
  const resolvedSelectors = new Set(resolved.filter((r): r is NonNullable<typeof r> => r !== undefined).map((r) => r.selector))
  const iconCandidates = iconRaw.filter((el) => !resolvedSelectors.has(computeSelector(el))).map((el) => ({ ...el, selector: computeSelector(el), frameChain: [] as string[] }))

  return [...resolved.filter((r): r is NonNullable<typeof r> => r !== undefined), ...iconCandidates]
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
  const withSelectors = await collectAriaOutline(page)

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
    frameChain: el.frameChain.length > 0 ? el.frameChain : undefined,
    isFileInput: el.isFileInput || undefined,
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

/** Live verification, not a static assumption, that `page.getByRole(role,
 * { name })` resolves — uniquely — to the *exact same* element already
 * resolved via `computeSelector()`'s guaranteed-correct preference order
 * (testId → id → positional CSS path, completely unchanged by this
 * function). Only ever changes what `generateSpec.ts` *prefers to emit*
 * in the exported spec — never the live run's own action, which always
 * continues to use the already-resolved selector regardless of this
 * function's result.
 *
 * Exists because a *computed* role/name pair can't always round-trip back
 * into a valid `getByRole` call (`accessibleName()`'s computation has real
 * edge cases this codebase doesn't fully reimplement — see its own doc
 * comment) — rather than assume it round-trips, this checks it for real,
 * against the real page, at the exact moment it matters, closing that
 * exact gap instead of guessing around it.
 *
 * `includeHidden: true` is deliberately broader than a plain `getByRole`
 * call (which excludes elements outside the accessibility tree) — this
 * makes the uniqueness check *stricter* than what a later replay will
 * actually see (a hidden sibling with the same role/name that a real
 * replay, without `includeHidden: true`, would never even consider), so
 * this can only ever under-use the feature (fall back to the existing
 * selector) on an edge case, never produce a false positive. It also means
 * this can run
 * once, uniformly, right after the target element is resolved — before
 * any assert_visible poll or click/fill mutation — without needing to
 * wait for a not-yet-visible element to become visible first.
 *
 * Substring match (`exact: false`), not exact — `accessibleName()` (above)
 * truncates `textContent` to 80 chars, so an exact match would silently
 * fail on exactly the long product-title links this feature exists for.
 * Uniqueness is still enforced via `count() === 1`. Identity is confirmed
 * via Playwright's own documented handle-equality pattern
 * (`page.evaluate(([a, b]) => a === b, [...])`), not a DOM-mutation marker
 * — writing a temporary attribute to verify identity risks tripping a
 * real site's own analytics/MutationObserver, an unacceptable side effect
 * for a verification-only check that must never alter the page.
 *
 * Never throws, and never more than ~1s of real cost — any failure here
 * (an unrecognized role string, a detached handle, a timeout) must never
 * be mistaken for a failure of the actual action; always resolves to
 * `undefined` on anything but a clean, unique, confirmed match. */
async function verifyRoleLocator(
  root: import('playwright').Page | import('playwright').FrameLocator,
  role: string,
  name: string,
  targetHandle: import('playwright').ElementHandle
): Promise<{ role: string; name: string } | undefined> {
  if (!name) return undefined
  try {
    const candidate = root.getByRole(role as Parameters<import('playwright').Page['getByRole']>[0], { name, exact: false, includeHidden: true })
    if ((await candidate.count()) !== 1) return undefined
    const candidateHandle = await candidate.elementHandle({ timeout: 1000 })
    if (!candidateHandle) return undefined
    // ElementHandle.evaluate(), not page.evaluate() — the latter always
    // executes in the main frame, which breaks identity comparison for a
    // handle that belongs to a nested iframe's own execution context (see
    // OutlineElement.frameChain's doc comment). Evaluating on
    // `candidateHandle` itself runs in whichever frame it actually belongs
    // to, uniformly, whether that's the main frame (unchanged behavior) or
    // a nested one — `targetHandle` is passed through as Playwright's own
    // documented handle-equality pattern already relied on before this.
    const same = await candidateHandle.evaluate((a, b) => a === b, targetHandle)
    return same ? { role, name } : undefined
  } catch {
    return undefined
  }
}

/** Resolves the real Playwright root an element's `selector` must be
 * queried against — `page` itself for a main-page element (no
 * `frameChain`, or an empty one), or a chained `page.frameLocator(...)`
 * built from `frameChain` for one living inside one or more nested
 * iframes/frames. `FrameLocator.frameLocator()` composes the same way
 * `Page.frameLocator()` does, so an arbitrary nesting depth is just as many
 * chained calls — this is also exactly what `generateSpec.ts` renders into
 * the exported spec, so the live run and the file it produces stay in
 * lockstep by construction. */
function resolveRoot(
  page: import('playwright').Page,
  frameChain?: string[]
): import('playwright').Page | import('playwright').FrameLocator {
  let root: import('playwright').Page | import('playwright').FrameLocator = page
  for (const selector of frameChain ?? []) root = root.frameLocator(selector)
  return root
}

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
    // "The whole rendered page" (this action's own point, per its doc
    // comment in types.ts) must include iframe content too, for the same
    // real, live reason ref-based actions needed `frameChain` at all — a
    // plain-text/no-role success message can live inside an iframe just as
    // easily as a button can (found via a real, live gap: a payment-iframe
    // fixture's own "Payment submitted for ..." confirmation text was
    // completely invisible to this assertion even after the fill/click
    // that produced it correctly targeted the iframe). Computed once
    // up front, not re-queried every poll iteration — the frame list
    // itself doesn't change mid-assertion the way its *content* does.
    // Short per-frame timeout (unlike `body`'s own remaining-budget
    // timeout) so a page with several irrelevant iframes (ads, trackers)
    // can't eat the whole `ASSERT_WAIT_MS` budget on frames that were
    // never going to match — bounded by the same `MAX_EXTRA_FRAMES` cap
    // `snapshotFrames` uses, for the same cost-control reasoning.
    const otherFrames = page.frames().filter((f) => f !== page.mainFrame() && !f.isDetached()).slice(0, MAX_EXTRA_FRAMES)
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
      for (const frame of otherFrames) {
        try {
          const frameText = (await frame.locator('body').innerText({ timeout: 300 })) ?? ''
          if (frameText.includes(expected)) return { ok: true }
        } catch {
          // Cross-origin/sandboxed/navigated-away frame, or this frame's
          // own short timeout elapsed — contributes nothing this
          // iteration, same best-effort posture as `snapshotFrames`.
        }
      }
      if (Date.now() >= deadline) break
      await page.waitForTimeout(150)
    }
    return await fail(`expected the page to contain text "${action.expectedText}", but it never appeared`)
  }

  if (action.action === 'assert_page_text_absent') {
    // Inverted pass condition from assert_page_text above, same polling
    // shape and same frame-inclusion reasoning (see that block's own doc
    // comment) — checked every iteration since the text could still be
    // present on the first check (mid fade-out, say) and only genuinely
    // gone a moment later.
    const expected = substitutePlaceholders(action.expectedText, credentials)
    const deadline = Date.now() + ASSERT_WAIT_MS
    const body = page.locator('body')
    const otherFrames = page.frames().filter((f) => f !== page.mainFrame() && !f.isDetached()).slice(0, MAX_EXTRA_FRAMES)
    let lastSeenWhere = ''
    while (true) {
      const remaining = deadline - Date.now()
      // Three-way outcome per iteration, deliberately NOT a single boolean:
      // a read that fails/times out (body not settled, or this iteration's
      // own short timeout elapsed near the end of the budget — `Math.max(
      // remaining, 1)` can be as low as 1ms on the last iteration) must
      // count as "couldn't confirm either way" and keep polling, never
      // silently default to "confirmed absent." An earlier version of this
      // used a single `stillPresent` flag initialized to `false`, which
      // made exactly that mistake — a live regression test caught it: the
      // "genuinely still present" case took the full poll budget hitting
      // ever-shrinking timeouts, each one throwing, each one silently
      // counted as "absent," producing a false pass instead of the correct
      // failure.
      let confirmedAbsentThisIteration = false
      try {
        const bodyText = (await body.innerText({ timeout: Math.max(remaining, 1) })) ?? ''
        if (bodyText.includes(expected)) {
          lastSeenWhere = 'the main page'
        } else {
          confirmedAbsentThisIteration = true
        }
      } catch {
        // Inconclusive this iteration — neither confirmed present nor
        // absent. Falls through to the deadline check below, same as every
        // other best-effort poll in this codebase.
      }
      if (confirmedAbsentThisIteration) {
        for (const frame of otherFrames) {
          try {
            const frameText = (await frame.locator('body').innerText({ timeout: 300 })) ?? ''
            if (frameText.includes(expected)) {
              confirmedAbsentThisIteration = false
              lastSeenWhere = 'an iframe'
              break
            }
          } catch {
            // Cross-origin/sandboxed/navigated-away frame, or this frame's
            // own short timeout elapsed — same best-effort posture as
            // assert_page_text. An inconclusive frame read must not flip an
            // already-confirmed-absent main-body result back to unknown —
            // only a frame that positively DOES contain the text should.
          }
        }
      }
      if (confirmedAbsentThisIteration) return { ok: true }
      if (Date.now() >= deadline) break
      await page.waitForTimeout(150)
    }
    return await fail(`expected the page to no longer contain text "${action.expectedText}", but it was still present in ${lastSeenWhere || 'the main page'} after ${ASSERT_WAIT_MS}ms`)
  }

  if (action.action === 'scroll') {
    try {
      // String-evaluated (like ICON_FALLBACK_SCRIPT above), not an inline TS
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
  const root = resolveRoot(page, el.frameChain)
  const locator = root.locator(el.selector).first()
  // Computed once, here, before any type-specific logic below (including
  // click/fill's own mutation) — see `verifyRoleLocator`'s own doc comment
  // for why `includeHidden: true` makes this safe to do uniformly for
  // every action type, regardless of whether the target is visible yet.
  // Best-effort: an element that isn't attached at all yet (a legitimate,
  // common state for assert_visible/assert_text, whose own polling below
  // is what's responsible for waiting it out) just resolves to `undefined`
  // here, same as any other "can't verify" case.
  const verifiedRoleLocator = await locator
    .elementHandle({ timeout: 2000 })
    .then((handle) => (handle ? verifyRoleLocator(root, el.role, el.name, handle) : undefined))
    .catch(() => undefined)

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
      return { ok: true, verifiedRoleLocator }
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
        if (lastText.includes(expected)) return { ok: true, verifiedRoleLocator }
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

  if (action.action === 'assert_value') {
    // Same bounded-poll shape as assert_text above, `inputValue()` instead
    // of `textContent()` — the whole point (see this action's own doc
    // comment in types.ts): a form field's current value is a real DOM
    // property, never part of rendered text content, no matter what it's
    // set to.
    const expected = substitutePlaceholders(action.expectedValue, credentials)
    const deadline = Date.now() + ASSERT_WAIT_MS
    let lastValue = ''
    while (true) {
      const remaining = deadline - Date.now()
      try {
        lastValue = (await locator.inputValue({ timeout: Math.max(remaining, 1) })) ?? ''
        if (lastValue.includes(expected)) return { ok: true, verifiedRoleLocator }
      } catch {
        // Not attached yet, this iteration's own timeout elapsed, or the
        // resolved element genuinely isn't a real form control at all
        // (`inputValue()` throws on anything without one) — keep polling
        // until the outer deadline rather than failing on one miss; a
        // genuinely wrong target still fails honestly once the deadline
        // passes, same as assert_text.
      }
      if (Date.now() >= deadline) break
      await page.waitForTimeout(150)
    }
    // Same rule as fill/assert_text: `fail()`'s message always references
    // the original `action.expectedValue` (the placeholder token, if that's
    // what it was) — never the substituted one.
    return await fail(`expected value containing "${action.expectedValue}", got "${lastValue.trim()}"`)
  }

  // hover / dblclick / drag / press_key / upload — deliberately NOT
  // eligible for the click/fill self-healing below (see that block's own
  // doc comment: healing is scoped to exactly two action types by design).
  // A stale selector for one of these five simply fails honestly, same as
  // assert_visible/assert_text above.
  if (action.action === 'hover') {
    try {
      await locator.hover({ timeout: 5000 })
      return { ok: true, verifiedRoleLocator }
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  if (action.action === 'dblclick') {
    try {
      await locator.dblclick({ timeout: 5000 })
      return { ok: true, verifiedRoleLocator }
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  if (action.action === 'drag') {
    const targetEl = resolve(outline, action.targetRef)
    if (!targetEl) return fail(`targetRef "${action.targetRef}" not found in this turn's outline`)
    // A drag's destination can, in principle, live in a different frame
    // than its source (resolved independently via its own frameChain) —
    // never assumed to share `root`, even though the overwhelming real
    // case (a sortable list, a kanban board) is same-frame.
    const targetRoot = resolveRoot(page, targetEl.frameChain)
    const targetLocator = targetRoot.locator(targetEl.selector).first()
    try {
      await locator.dragTo(targetLocator, { timeout: 5000 })
      return { ok: true, verifiedRoleLocator }
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  if (action.action === 'press_key') {
    try {
      await locator.press(action.key, { timeout: 5000 })
      return { ok: true, verifiedRoleLocator }
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  if (action.action === 'upload') {
    try {
      await locator.setInputFiles(action.filePath, { timeout: 5000 })
      return { ok: true, verifiedRoleLocator }
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0] : String(err))
    }
  }

  // click / fill from here on — the only two action types eligible for
  // selector healing. `attempt` performs the whole logical action against
  // a given selector, so a heal-and-retry re-runs fill *and* the optional
  // submit press together, not just the first Playwright call.
  const attempt = async (selector: string): Promise<void> => {
    const target = root.locator(selector).first()
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
    return { ok: true, verifiedRoleLocator }
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
    const staleCount = await root.locator(el.selector).count()
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
    // Same frame required too, not just tag/role/name — otherwise a
    // same-named element in a *different* frame (or the main page) could
    // silently heal to the wrong one. `JSON.stringify` comparison, not
    // `===`, since these are freshly-built arrays every snapshot; empty/
    // absent frameChain on both sides (the overwhelming majority case: a
    // main-page element) compares `'[]' === '[]'`, unaffected.
    const candidates = freshOutline.elements.filter(
      (fe) => fe.tag === el.tag && fe.role === el.role && fe.name === el.name && JSON.stringify(fe.frameChain ?? []) === JSON.stringify(el.frameChain ?? [])
    )

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
      // Re-verified against the healed candidate specifically — the
      // original `verifiedRoleLocator` above was computed against the now-
      // stale element (0 matches), so it says nothing about this different,
      // freshly re-matched DOM node. `candidates[0]`'s role/name are
      // identical to `el`'s by construction (the healing filter above only
      // accepts a candidate with the exact same tag/role/name), but the
      // *element* itself is different, so the identity check must be redone
      // against a real handle for it.
      const healedVerifiedRoleLocator = await root
        .locator(healedSelector)
        .first()
        .elementHandle({ timeout: 2000 })
        .then((handle) => (handle ? verifyRoleLocator(root, candidates[0].role, candidates[0].name, handle) : undefined))
        .catch(() => undefined)
      return { ok: true, healed: true, healedSelector, verifiedRoleLocator: healedVerifiedRoleLocator }
    } catch (healErr) {
      return fail(
        `selector went stale (0 matches): ${originalDetail} — healed to a re-matched element, but the retry also failed: ${
          healErr instanceof Error ? healErr.message.split('\n')[0] : String(healErr)
        }`
      )
    }
  }
}
