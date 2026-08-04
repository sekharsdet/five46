import type { AgentAction, AgentPlan, CredentialAvailability, HistoryEntry, OutlineElement, PageOutline, PlannedStep, PlannedStepTarget } from './types'
import { USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './browser'

const MAX_HISTORY = 10

/** Resolves a planned step's *prediction* against a fresh, real outline —
 * exact role match plus a case-insensitive `name` substring match.
 * Deliberately requires both, not name-only: a `target` was decided before
 * the page it applies to had even loaded, so it's inherently less certain
 * than self-healing's own re-match (which re-verifies something already
 * observed) — `role` is a genuinely strong discriminator (see `browser.ts`'s
 * `roleOf()`), and settling for less would make the fast path this exists
 * to support too weak to trust. Returns every candidate rather than
 * deciding anything itself — the caller (`runner.ts`) is responsible for
 * "exactly one or refuse," matching self-healing's own "never guess on
 * ambiguity" rule exactly. */
export function resolvePlannedTarget(outline: PageOutline, target: PlannedStepTarget): OutlineElement[] {
  const nameContainsLower = target.nameContains.toLowerCase()
  return outline.elements.filter((el) => el.role === target.role && el.name.toLowerCase().includes(nameContainsLower))
}

/** One line per element: `[ref] role "name"`. Kept deliberately terse — this
 * text goes into every single prompt of the run, so its size directly
 * drives BYOK cost per step. */
export function serializeOutline(outline: PageOutline): string {
  if (outline.elements.length === 0) return '(no visible interactive elements found on this page)'
  const lines = outline.elements.map((el) => `[${el.ref}] ${el.role} "${el.name}"`)
  if (outline.truncated) {
    lines.push(`(${outline.totalFound - outline.elements.length} more visible interactive element(s) not shown)`)
  }
  return lines.join('\n')
}

/** Resending the *entire* history every turn (since each step is a fresh,
 * self-contained prompt — see DEVELOPMENT.md's "single-shot JSON per step"
 * reasoning) means unbounded history is unbounded, linearly growing token
 * cost per step. Capped and disclosed via the "N earlier step(s) omitted"
 * marker below, same shape as `PageOutline.truncated` — capping silently
 * would also make the agent "forget" early steps without ever being told
 * that happened. */
export function serializeHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return '(no steps taken yet)'
  const recent = history.slice(-MAX_HISTORY)
  const omitted = history.length - recent.length
  const lines = recent.map((h, i) => {
    const stepNum = history.length - recent.length + i + 1
    const summary = describeAction(h.action)
    return `${stepNum}. ${summary} -> ${h.result}${h.detail ? `: ${h.detail}` : ''}`
  })
  if (omitted > 0) lines.unshift(`(${omitted} earlier step(s) omitted)`)
  return lines.join('\n')
}

function describeAction(action: AgentAction): string {
  switch (action.action) {
    case 'click':
      return `click ${action.ref}`
    case 'fill':
      return `fill ${action.ref} with "${action.value}"${action.submit ? ' then press Enter' : ''}`
    case 'assert_visible':
      return `assert ${action.ref} is visible`
    case 'assert_text':
      return `assert ${action.ref} contains "${action.expectedText}"`
    case 'assert_page_text':
      return `assert the page contains "${action.expectedText}"`
    case 'scroll':
      return `scroll ${action.direction}`
    case 'wait':
      return `wait`
    case 'done':
      return `done (${action.outcome})`
  }
}

const ACTION_SCHEMA_EXAMPLE = `{"action":"click","ref":"e2","reason":"the goal requires opening the menu first"}`

const CONFIRMATION_PATTERN = /\b(confirm|verify|ensure|make sure|check that)\b/i
const CONFIRMATION_PATTERN_GLOBAL = new RegExp(CONFIRMATION_PATTERN.source, 'gi')

/** How many confirm/verify/ensure/etc. occurrences the goal's own text
 * contains — a naming-heuristic, not real NLP. Originally only used to
 * detect "this goal asks for verification" (via a `requiresConfirmation()`
 * boolean wrapper, since removed) and gate the assertion requirement on
 * that; `runner.ts`/`apiRunner.ts` now use `Math.max(1, ...)` of this count
 * as an *unconditional* floor instead — found via a real, live run (a
 * Shopify demo store, goal: "...then confirm the cart shows an item") that
 * a goal explicitly asking for verification could still have its
 * `goal-reached` claim accepted with zero assertions ever performed, and
 * later, via live testing against real production sites (Flipkart,
 * Amazon.in), that a goal with *no* confirm-language at all got the exact
 * same false-success failure mode, since the count was simply 0 for it —
 * see DEVELOPMENT.md's "Known limitations" section for the full evidence.
 * Also used as a *multi*-clause floor: found via a real, live run
 * (automationintesting.online: "...confirm the price is shown, then click
 * Next, confirm the calendar changed") that `hasSucceededAssertion`'s own
 * "reset when stale" fix (see runner.ts) did not catch a model jumping
 * straight to one, perfectly *fresh* assertion for only the *second*
 * clause, skipping the first entirely — a single required-count-of-1 has
 * no way to know the goal asked for two checks, not one. */
export function countConfirmationClauses(goal: string): number {
  return (goal.match(CONFIRMATION_PATTERN_GLOBAL) || []).length
}

/** Phrases tied specifically to irreversible account/data destruction, not
 * bare generic verbs — a bare "delete"/"remove" match would constantly
 * false-positive on ubiquitous, low-stakes, reversible UI ("Remove from
 * cart", "Delete search", "Remove filter"). This deliberately trades recall
 * for precision: catch the concrete case of an agent clicking a real
 * "delete my account" button with zero gating (unlike the API engine's
 * `--allow-deletes`) with high confidence, while accepting
 * that lower-stakes "delete this list item" clicks stay unblocked by
 * design. See DEVELOPMENT.md's "browser-engine destructive-action gating"
 * section for the full reasoning, including why this has no `allowWrites`
 * analog at all (unlike the API engine, most real browser goals are
 * "writes" under a strict taxonomy — gating all of them by default would
 * make the tool unusable out of the box). */
const DESTRUCTIVE_CLICK_PHRASES = [
  'delete account',
  'delete my account',
  'close account',
  'close my account',
  'deactivate account',
  'deactivate my account',
  'delete permanently',
  'permanently delete',
  'delete all data',
  'erase all data',
  'cancel subscription',
  'cancel my subscription',
  'terminate account',
]

/** True if `name` (an `OutlineElement.name` — the clicked element's
 * accessible name) matches one of `DESTRUCTIVE_CLICK_PHRASES`. Substring
 * match, case-insensitive — same "documented, honest, imperfect proxy" class
 * of heuristic as `countConfirmationClauses`, not real NLP. */
export function isDestructiveClickTarget(name: string): boolean {
  const lower = name.toLowerCase()
  return DESTRUCTIVE_CLICK_PHRASES.some((phrase) => lower.includes(phrase))
}

const CLAUSE_MATCH_STOPWORDS = new Set([
  'confirm',
  'verify',
  'ensure',
  'check',
  'that',
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'shown',
  'visible',
  'displayed',
  'appears',
  'and',
  'with',
  'for',
  'this',
  'has',
  'have',
  'least',
])

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3 && !CLAUSE_MATCH_STOPWORDS.has(token))
  )
}

/** A mechanical, imperfect backstop against a clearly mismatched self-
 * declared `clauseIndex` (see `AgentAction`'s own doc comment) — same
 * "documented, honest, imperfect proxy" class as `countConfirmationClauses`/
 * `isDestructiveClickTarget`, keyword-overlap only, never real NLP. Exists
 * because this codebase has already twice found that trusting the model's
 * own wording/self-restraint alone doesn't reliably work for an adjacent
 * problem (the `assertionQualityNote` prompt-only attempt above, and
 * `parsePlan`'s immediate-`done` rejection both needed a code-level fix
 * after a prompt-only attempt was live-tested and failed) — the same
 * lesson applies here: an assertion claiming to satisfy a clause it has no
 * real textual relationship to should not get silent credit for it.
 * Deliberately permissive, not strict: this is a backstop against a CLEAR
 * mismatch, not a similarity requirement — too little text to compare on
 * either side (e.g. both boil down to zero significant tokens after
 * stripping) is treated as inconclusive and passes, since a false
 * rejection here would incorrectly block a genuinely correct assertion
 * from ever satisfying its clause, which is worse than the rare case this
 * backstop misses a genuine mismatch. */
export function clauseLikelyMatches(clauseText: string, assertionText: string): boolean {
  const clauseTokens = significantTokens(clauseText)
  const assertionTokens = significantTokens(assertionText)
  if (clauseTokens.size === 0 || assertionTokens.size === 0) return true
  for (const token of clauseTokens) {
    if (assertionTokens.has(token)) return true
  }
  return false
}

/** Builds the "what's the next single action" prompt — the only shape the
 * agentic loop can take given `LlmProvider.complete()` is single string
 * in/out with no tool-calling or JSON-mode hook (see the plan's reasoning).
 * Deliberately never asks the model to author a selector: it only ever
 * picks a `ref` from *this turn's* outline, which the runner resolves back
 * to a real, already-computed Playwright selector — the model can't
 * fabricate a locator that was never actually on the page. */
/** Describes one planned step in the same terse voice `describeAction`
 * already uses for an executed one — reused both for the live-fallback
 * prompt note below and for disclosure in the printed report. */
export function describePlannedStep(step: PlannedStep): string {
  switch (step.action) {
    case 'click':
      return `click a ${step.target.role} matching "${step.target.nameContains}"`
    case 'fill':
      return `fill a ${step.target.role} matching "${step.target.nameContains}" with "${step.value}"${step.submit ? ' then press Enter' : ''}`
    case 'assert_visible':
      return `assert a ${step.target.role} matching "${step.target.nameContains}" is visible`
    case 'assert_text':
      return `assert a ${step.target.role} matching "${step.target.nameContains}" contains "${step.expectedText}"`
    case 'assert_page_text':
      return `assert the page contains "${step.expectedText}"`
    case 'scroll':
      return `scroll ${step.direction}`
    case 'wait':
      return `wait`
    case 'done':
      return `done (${step.outcome})`
  }
}

export function buildActionPrompt(
  goal: string,
  history: HistoryEntry[],
  outline: PageOutline,
  credentialsAvailable?: CredentialAvailability,
  allowDeletes?: boolean,
  /** Non-empty only when `runner.ts`'s structured-plan fast path fell back
   * to a live decision for this step — describes where the plan expected
   * to be, so the model has that context without being forced to follow
   * it: the plan is a scaffold, not a rigid contract (see `runner.ts`'s
   * "plan exhaustion degrades to the ordinary loop" reasoning). */
  planStepNote?: { index: number; total: number; step: PlannedStep },
  /** Only ever passed non-empty when `runner.ts`/`apiRunner.ts` already
   * split the goal into 2+ genuinely distinct confirm-worthy milestones
   * (`clauseSplitter.ts`, gated behind `countConfirmationClauses(goal) >= 2`
   * — see its own doc comment for why this stays a zero-extra-call no-op
   * for the overwhelming majority of goals). When present, switches the
   * confirmation requirement from a total *count* to per-clause coverage —
   * see `confirmationNote` below. */
  clauses?: string[]
): string {
  const planNote = planStepNote
    ? [
        ``,
        `You are following an upfront plan (step ${planStepNote.index + 1} of ${planStepNote.total}): ${describePlannedStep(planStepNote.step)} — reason: ${planStepNote.step.reason}.`,
        `The plan's prediction for this step didn't resolve cleanly against the real page, so decide the actual next action yourself from the real elements below — you are not required to follow the plan exactly.`,
      ]
    : []
  const clauseTrackingActive = !!clauses && clauses.length > 1
  // Unconditional — not gated on the goal's own wording containing
  // confirm/verify/etc. language. Disclosed up front for the same reason
  // as deleteNote below: telling the model before it wastes a turn is
  // more efficient than only rejecting a blind attempt after the fact. See
  // countConfirmationClauses' own doc comment for the live evidence this
  // floor-of-1 default closes (a goal with zero confirm-language used to
  // get zero forced verification at all).
  //
  // When `clauseTrackingActive`, this note switches from a total *count*
  // to per-clause *coverage* — closes issue #3 in DEVELOPMENT.md's
  // documented gap list: a scalar count of 2 couldn't tell "confirm A,
  // confirm A again" apart from "confirm A, confirm B," so a compound goal
  // could reach goal-reached having verified only one of its named
  // milestones. Each clause is listed with its 0-based index so the model
  // can self-declare which one a given assertion is meant to satisfy —
  // never trusted blindly (see `clauseLikelyMatches`'s own doc comment for
  // the mechanical backstop `runner.ts`/`apiRunner.ts` apply against a
  // clearly mismatched claim).
  const requiredAssertionCount = Math.max(1, countConfirmationClauses(goal))
  const confirmationNote = clauseTrackingActive
    ? [
        ``,
        `This goal has ${clauses!.length} distinct things to confirm, listed below with their 0-based index. You must get a successful assert_visible, assert_text, or assert_page_text for EACH one before you're allowed to declare "done" with outcome "goal-reached" — one clause's assertion does not count toward another; each needs its own real, matching check. When performing an assertion meant to satisfy one of these, include "clauseIndex": <its index> in that action's JSON. Declaring done with any clause unverified, or asserting something unrelated to the clause index you claim, will be rejected.`,
        ...clauses!.map((c, i) => `  ${i}. ${c}`),
      ]
    : [
        ``,
        `You must perform at least ${requiredAssertionCount} successful assert_visible, assert_text, or assert_page_text action(s) before you're allowed to declare "done" with outcome "goal-reached" — this applies even if the goal above doesn't explicitly say "confirm"/"verify": a claimed success must always be backed by a real check, never just your own belief that you're finished. Declaring done without enough successful assertions will be rejected.`,
      ]
  // Generalizes the existing tautology guard (never re-assert the exact
  // element you just clicked/filled, in the assert_visible schema line
  // below) to the broader case a real live run against a production site
  // (Flipkart) exposed: the model satisfied the confirmation requirement
  // above by asserting a completely unrelated, always-present element (a
  // site-wide header link reading "Login," true on every single page
  // regardless of whether any of its prior actions actually worked), then
  // never completed the rest of the goal. Nothing rejects this
  // mechanically (unlike the confirmationNote count above) — this is
  // guidance only, since "was this assertion meaningful" is a real
  // semantic judgment, not something a simple rule can verify.
  const assertionQualityNote = [
    ``,
    `When choosing what to assert, avoid a persistent/ambient element that would already be visible or true regardless of whether your actions actually worked — a site-wide header/nav/footer label, a page title, a generic link that's present on every page. That kind of assertion can pass even when nothing you did actually mattered. Prefer something that specifically changed, newly appeared, or only exists because of the actions you just took.`,
  ]
  // Disclosed up front, same reasoning as apiPlanner.ts's describeSafetyMode:
  // telling the model before it wastes a turn is more efficient than only
  // rejecting a blind attempt after the fact.
  const deleteNote = allowDeletes
    ? []
    : [
        ``,
        `Clicking an element that looks like it deletes/deactivates/closes an account or`,
        `permanently erases data (e.g. "Delete Account", "Cancel Subscription") will be`,
        `blocked this run — that requires --allow-deletes.`,
      ]
  const credentialNote =
    credentialsAvailable?.username || credentialsAvailable?.password
      ? [
          ``,
          `A login username and/or password is configured but never shown to you. If the goal`,
          `requires entering it, use the literal token ${USERNAME_PLACEHOLDER} as a fill action's`,
          `"value" for the username field, and ${PASSWORD_PLACEHOLDER} for the password field —`,
          `never write a real-looking username or password yourself, only these exact tokens.`,
        ]
      : []
  // Ordered so a maximal, byte-identical prefix (the opening sentence, goal,
  // per-run-static notes, and the full schema/instructions block) comes
  // BEFORE anything that changes every turn (history, outline, planNote) —
  // this is deliberate, not incidental. Every provider-native prompt/context
  // caching mechanism (OpenAI/Gemini automatic, Groq automatic where
  // supported, Anthropic's explicit cache_control) works by matching a
  // request's leading prefix against a recently-processed one; putting
  // per-turn-dynamic content in the middle (as an earlier version of this
  // function did) meant the "prefix" never stayed identical past turn one,
  // so none of that ~600-token static block below was ever actually
  // cacheable, despite being identical on every single turn of every run.
  // See DEVELOPMENT.md's "Reordering prompts for provider-native caching"
  // section for the full reasoning, including why this isn't a free lunch
  // for instruction-following (see the closing reminder line below).
  // Deliberately conditional, not always present — an assertion schema
  // line with a clauseIndex placeholder would be actively misleading noise
  // on the overwhelming majority of runs where clause tracking never
  // activates (see clauseTrackingActive above).
  const clauseIndexHint = clauseTrackingActive ? `,"clauseIndex":<0-based index of the clause above this satisfies>` : ''
  return [
    `You are a web testing agent driving a real browser toward one goal, one action at a time.`,
    ``,
    `Goal: ${goal}`,
    ...confirmationNote,
    ...assertionQualityNote,
    ...deleteNote,
    ...credentialNote,
    ``,
    `Respond with exactly one JSON object describing the next single action to take, one of:`,
    `- {"action":"click","ref":"<ref>","reason":"<why>"}`,
    `- {"action":"fill","ref":"<ref>","value":"<text>","submit":<true|false>,"reason":"<why>"}`,
    `- {"action":"assert_visible","ref":"<ref>","reason":"<why>"${clauseIndexHint}} (never assert visibility of the exact element you just clicked or filled — it was already visible in order to be interactable, so this proves nothing changed; assert something that actually reflects the outcome instead)`,
    `- {"action":"assert_text","ref":"<ref>","expectedText":"<text>","reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_page_text","expectedText":"<text>","reason":"<why>"${clauseIndexHint}} (checks the WHOLE page's visible text, not just one ref — use this when the text you need to confirm isn't in the elements list above at all, e.g. a plain heading or message with no interactive role; this is the only assertion that doesn't need a ref)`,
    `- {"action":"scroll","direction":"up"|"down","reason":"<why>"} (scrolls the whole page by one viewport height — use this if what you need isn't in the list above)`,
    `- {"action":"wait","reason":"<why>"} (pauses briefly, then re-reads the page — use this if the page looks like it's still loading: a spinner, a skeleton, a "loading..." message, or right after an action that plausibly triggers something async. Do not use it more than twice in a row without trying something else in between; if the content still hasn't appeared after that, it's more likely genuinely not there)`,
    `- {"action":"done","outcome":"goal-reached"|"goal-unreachable","reason":"<why>"} (choose "goal-unreachable" honestly when the goal's target genuinely is not in the elements list above, an assert_page_text check for it hasn't found it anywhere on the page either, scrolling will not reveal it, waiting for it to load hasn't revealed it either, and no unopened menu/dropdown/tab/accordion visible on the page is likely to reveal it either — try clicking one such element first if one plausibly exists; never guess by acting on or asserting against the closest-looking element instead)`,
    ``,
    `Example: ${ACTION_SCHEMA_EXAMPLE}`,
    ...planNote,
    ``,
    `Steps taken so far:`,
    serializeHistory(history),
    ``,
    `Elements currently visible on the page (pick a ref from this list only — you cannot act on anything not listed here):`,
    serializeOutline(outline),
    ``,
    // A short, cheap repeat of the format instruction, deliberately kept
    // right before generation — moving the full instructions block earlier
    // trades away the "recency effect" (an instruction immediately
    // preceding generation is followed more reliably), so this recovers
    // that reliability for the one instruction most worth repeating,
    // without undoing the reordering above (the bulk of the static block
    // still sits in the cacheable prefix).
    `Respond with ONLY the JSON object matching one of the schemas above — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Captures an assertion's optional self-declared `clauseIndex` as a
 * spreadable `{ clauseIndex: number }` (or `{}` when absent/invalid) —
 * never an explicit `{ clauseIndex: undefined }`, which would give the
 * resulting object an own `clauseIndex` key even when unset, breaking every
 * exact-shape `assert.deepStrictEqual` test elsewhere in this codebase that
 * predates this field. A plain non-negative integer only; anything else
 * (missing, fractional, negative, wrong type) is dropped. Deliberately
 * permissive at this parse layer: an out-of-range index (e.g.
 * `>= clauses.length`) is a loop-level concern the caller checks once it
 * actually knows how many clauses exist (`runner.ts`/`apiRunner.ts`), not a
 * parse-time rejection — the assertion itself is still a fully valid,
 * executable step either way. */
function clauseIndexField(v: unknown): { clauseIndex: number } | Record<string, never> {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { clauseIndex: v } : {}
}

const PLAN_SCHEMA_EXAMPLE = `{"steps":[{"action":"click","target":{"role":"link","nameContains":"Rooms"},"reason":"open the room listing"},{"action":"assert_visible","target":{"role":"status","nameContains":"price"},"reason":"confirm the price is shown"},{"action":"done","outcome":"goal-reached","reason":"price confirmed"}]}`

/** Builds the upfront "plan the whole goal" prompt — a separate, one-time
 * call before the main per-step loop, only made when `RunAgentOptions.
 * useStructuredPlan` is set (see `runner.ts`). Unlike `buildActionPrompt`,
 * this only ever sees the *first* page's outline — later steps will very
 * likely land on pages that don't exist yet, so a step's `target` is
 * explicitly framed as a prediction to verify at execution time, never a
 * `ref` (which only exists within the single snapshot it came from — see
 * `PageOutline`'s own doc comment). This is still just a second,
 * independent `LlmProvider.complete()` call, the same pattern
 * `rootCause.ts` already uses for a different reason — the interface
 * itself doesn't need to grow for this.
 *
 * `clauses`, when passed (only ever 2+ entries — see `buildActionPrompt`'s
 * identical `clauseTrackingActive` gate), asks the plan itself to predict
 * each assertion step's `clauseIndex` upfront — necessary so `runner.ts`'s
 * fast path (which never calls this file's per-step schema at all) still
 * has a clauseIndex to check before fast-pathing a planned assertion; see
 * `runner.ts`'s "refuse to fast-path a clause-tracked assertion with no
 * clauseIndex" rule. */
export function buildPlanPrompt(goal: string, initialOutline: PageOutline, clauses?: string[]): string {
  const clauseNote =
    clauses && clauses.length > 1
      ? [
          ``,
          `This goal has ${clauses.length} distinct things to confirm, listed below with their 0-based index. Every assert_visible/assert_text/assert_page_text step in your plan must include "clauseIndex": <the index of the clause it's meant to satisfy>, and the plan must cover all of them before its final "done" step.`,
          ...clauses.map((c, i) => `  ${i}. ${c}`),
        ]
      : []
  const clauseIndexHint = clauses && clauses.length > 1 ? `,"clauseIndex":<0-based index of the clause above this satisfies>` : ''
  return [
    `You are a web testing agent. Before taking any actions, plan out the whole sequence of steps needed to accomplish this goal on a real browser.`,
    ``,
    `Goal: ${goal}`,
    ...clauseNote,
    ``,
    `Elements currently visible on the page (the very first page only — later steps will likely land on pages you cannot see yet, so predict each one's likely role/name rather than requiring it to be in this list):`,
    serializeOutline(initialOutline),
    ``,
    `Respond with exactly one JSON object: {"steps": [...]}, where each step is one of:`,
    `- {"action":"click","target":{"role":"<expected ARIA role, e.g. link/button/checkbox>","nameContains":"<expected substring of its accessible name>"},"reason":"<why>"}`,
    `- {"action":"fill","target":{...},"value":"<text>","submit":<true|false>,"reason":"<why>"}`,
    `- {"action":"assert_visible","target":{...},"reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_text","target":{...},"expectedText":"<text>","reason":"<why>"${clauseIndexHint}}`,
    `- {"action":"assert_page_text","expectedText":"<text>","reason":"<why>"${clauseIndexHint}} (checks the whole page's visible text, no target needed — use for plain text/headings with no interactive role)`,
    `- {"action":"scroll","direction":"up"|"down","reason":"<why>"}`,
    `- {"action":"wait","reason":"<why>"} (pauses briefly for content that loads asynchronously — a spinner, a skeleton, a delayed page)`,
    `- {"action":"done","outcome":"goal-reached"|"goal-unreachable","reason":"<why>"} (a plan is made BEFORE most of the page has even been seen — you have no real evidence yet to judge "unreachable" against, only your own assumptions about how this site probably works. Only plan a "goal-unreachable" done step here if the goal itself is genuinely impossible to express as a sequence of steps at all. If you are just unsure whether a later page will actually contain what the goal needs, plan the steps anyway; a live decision later, made against the real rendered page, is what should determine reachability, not a guess made now)`,
    ``,
    `"target" is your best prediction, not something you've already verified exists — a later step resolves it against the real page, or falls back and asks you again if nothing matches clearly. Keep the plan as short as the goal genuinely requires, and end it with a "done" step.`,
    ``,
    `Example: ${PLAN_SCHEMA_EXAMPLE}`,
    ``,
    `Respond with ONLY the JSON object — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

function isValidTarget(v: unknown): v is PlannedStepTarget {
  return typeof v === 'object' && v !== null && isNonEmptyString((v as Record<string, unknown>).role) && isNonEmptyString((v as Record<string, unknown>).nameContains)
}

function parsePlannedStep(raw: unknown): PlannedStep | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const reason = isNonEmptyString(obj.reason) ? obj.reason : '(no reason given)'

  switch (obj.action) {
    case 'click':
      return isValidTarget(obj.target) ? { action: 'click', target: obj.target, reason } : undefined
    case 'fill':
      if (!isValidTarget(obj.target) || typeof obj.value !== 'string') return undefined
      return { action: 'fill', target: obj.target, value: obj.value, submit: obj.submit === true, reason }
    case 'assert_visible':
      return isValidTarget(obj.target) ? { action: 'assert_visible', target: obj.target, reason, ...clauseIndexField(obj.clauseIndex) } : undefined
    case 'assert_text':
      if (!isValidTarget(obj.target) || !isNonEmptyString(obj.expectedText)) return undefined
      return { action: 'assert_text', target: obj.target, expectedText: obj.expectedText, reason, ...clauseIndexField(obj.clauseIndex) }
    case 'assert_page_text':
      return isNonEmptyString(obj.expectedText) ? { action: 'assert_page_text', expectedText: obj.expectedText, reason, ...clauseIndexField(obj.clauseIndex) } : undefined
    case 'scroll': {
      const direction = obj.direction === 'up' || obj.direction === 'down' ? obj.direction : undefined
      return direction ? { action: 'scroll', direction, reason } : undefined
    }
    case 'wait':
      return { action: 'wait', reason }
    case 'done': {
      const outcome = obj.outcome === 'goal-reached' || obj.outcome === 'goal-unreachable' ? obj.outcome : undefined
      return outcome ? { action: 'done', outcome, reason } : undefined
    }
    default:
      return undefined
  }
}

export type ParsePlanResult = { ok: true; plan: AgentPlan } | { ok: false; error: string; raw: string }

/** Strictly parses a plan response, or an honest failure — mirroring
 * `parseAgentAction`'s "never guess a fallback" posture exactly. Unlike a
 * malformed single-action response (a fatal, run-ending
 * `unparseable-response`), a malformed *plan* response is deliberately
 * **not** fatal: `runner.ts` treats it as "skip structured planning for
 * this run" and falls through to the ordinary, fully-adaptive loop for the
 * entire step budget — a caller who opted into `useStructuredPlan` for
 * efficiency must never end up with a strictly worse worst case (a run
 * that would have succeeded via the ordinary path failing outright) just
 * because the one extra planning call happened to get truncated or
 * malformed. A plan's expected response size scales with step count,
 * unlike every other prompt in this codebase — the one place output-length
 * truncation is a real, live concern. */
export function parsePlan(raw: string): ParsePlanResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, error: 'plan response was not valid JSON', raw }
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).steps)) {
    return { ok: false, error: 'plan response was not a JSON object with a "steps" array', raw }
  }

  const steps: PlannedStep[] = []
  for (const rawStep of (parsed as { steps: unknown[] }).steps) {
    const step = parsePlannedStep(rawStep)
    if (!step) return { ok: false, error: 'plan contained a malformed or unrecognized step', raw }
    steps.push(step)
  }
  if (steps.length === 0) return { ok: false, error: 'plan contained no steps', raw }
  // Found via a real, live-repeated failure: a CRUD goal against a
  // well-known fake API (jsonplaceholder.typicode.com) produced a 1-step
  // plan — an immediate {"action":"done","outcome":"goal-unreachable"} —
  // twice, with zero real requests ever attempted. Explicit prompt
  // guidance against declaring "unreachable" from assumption alone
  // (buildPlanPrompt) was live-retested and did NOT change this: the model
  // applies what it believes is verified training-data knowledge, not
  // something it perceives as guessing, so wording alone can't reliably
  // stop it. Rejecting the plan itself forces the exact same fallback an
  // empty steps array already takes — the full, live, per-step adaptive
  // loop for the whole run — which this session's own live testing already
  // proved handles this correctly (the adaptive loop, framed as "take one
  // concrete action now" rather than "judge the whole flow upfront," made
  // real progress on the identical goal before reaching its own honest
  // conclusion). Applies to both outcomes, not just goal-unreachable: an
  // immediate goal-reached with zero real actions is the same category of
  // ungrounded claim the live loop's own countConfirmationClauses/
  // hasSucceededAssertion check already refuses to accept.
  if (steps.every((s) => s.action === 'done')) {
    return { ok: false, error: 'plan consists only of an immediate "done" step, with no real action ever attempted — falling back to a live decision so the model has to gather real evidence first', raw }
  }
  return { ok: true, plan: { steps } }
}

/** The result of parsing one raw LLM response — mirrors
 * `apiPlanner.ts`'s `ParseApiActionResult` exactly, for the same reason: a
 * malformed/unrecognized response (`recoverable` absent) is nothing usable
 * at all and ends the run as `unparseable-response`, while a structurally
 * valid `click` this turn's `SafetyMode`-equivalent check disallowed
 * (`recoverable: true`) is the browser equivalent of a failed click/fill —
 * a real, well-formed attempt that just didn't succeed, recorded and the
 * run continues. */
export type ParseAgentActionResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string; raw: string; recoverable?: false }
  | { ok: false; error: string; raw: string; recoverable: true; attemptedAction: AgentAction }

/** Strictly parses one raw LLM response into an `AgentAction`, or an honest
 * failure — never a guessed fallback action. A malformed or unrecognized
 * response stops the run cleanly rather than risking an action the model
 * never actually intended. The one accommodation made is stripping a single
 * ```json fence, since models add it constantly and doing so is lossless
 * (not a guess about content, just whitespace/formatting around it).
 *
 * Takes the full `outline` (not just a ref set) so a `click` target's
 * accessible name is available for the `isDestructiveClickTarget` check
 * below — the browser engine's only analog to `apiPlanner.ts`'s
 * `isMethodAllowed` check, done at this same parse layer for the same
 * reason: a hallucinated/disallowed action is a parse-level concern, never
 * silently accepted or silently executed.
 *
 * `recentlyInteracted`, when given, is the (role, name) of whatever the
 * *immediately preceding* successful `click`/`fill` targeted — used to
 * block an `assert_visible` on that exact same element. Found via real
 * live testing (demoblaze.com): asked to confirm a validation error was
 * shown after an empty checkout submission, the model clicked "Purchase"
 * twice, then "verified" its own claim by asserting the Purchase button
 * itself was still visible — trivially true regardless of whether
 * anything actually happened, since the button had to already be visible
 * to have been clickable in the first place. The run reported
 * `goal-reached` having proven nothing. Deliberately scoped to
 * `assert_visible` only, never `assert_text` — re-asserting an element's
 * *text* after interacting with it can be genuinely informative (a
 * counter button whose own label changes), so only the visibility check,
 * which can't distinguish "nothing happened" from "the goal was actually
 * verified," is blocked. */
export function parseAgentAction(
  raw: string,
  outline: PageOutline,
  allowDeletes: boolean,
  recentlyInteracted?: { role: string; name: string }
): ParseAgentActionResult {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, error: 'response was not valid JSON', raw }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'response was not a JSON object', raw }
  }
  const obj = parsed as Record<string, unknown>
  const action = obj.action
  const reason = isNonEmptyString(obj.reason) ? obj.reason : '(no reason given)'

  const validRefs = new Set(outline.elements.map((el) => el.ref))
  const checkRef = (): string | undefined => {
    if (!isNonEmptyString(obj.ref)) return undefined
    return validRefs.has(obj.ref) ? obj.ref : undefined
  }

  switch (action) {
    case 'click': {
      const ref = checkRef()
      if (!ref) return { ok: false, error: `"ref" is missing or not one of this turn's valid refs`, raw }
      const attempted: AgentAction = { action: 'click', ref, reason }
      const name = outline.elements.find((el) => el.ref === ref)?.name ?? ''
      if (!allowDeletes && isDestructiveClickTarget(name)) {
        return {
          ok: false,
          error: `clicking "${name}" looks like it deletes/deactivates/closes an account or permanently erases data — blocked this run (see --allow-deletes)`,
          raw,
          recoverable: true,
          attemptedAction: attempted,
        }
      }
      return { ok: true, action: attempted }
    }
    case 'fill': {
      const ref = checkRef()
      if (!ref) return { ok: false, error: `"ref" is missing or not one of this turn's valid refs`, raw }
      if (!isNonEmptyString(obj.value) && typeof obj.value !== 'string') {
        return { ok: false, error: '"value" is missing for a fill action', raw }
      }
      return {
        ok: true,
        action: { action: 'fill', ref, value: obj.value as string, submit: obj.submit === true, reason },
      }
    }
    case 'assert_visible': {
      const ref = checkRef()
      if (!ref) return { ok: false, error: `"ref" is missing or not one of this turn's valid refs`, raw }
      const target = outline.elements.find((el) => el.ref === ref)
      if (recentlyInteracted && target && target.role === recentlyInteracted.role && target.name === recentlyInteracted.name) {
        const attempted: AgentAction = { action: 'assert_visible', ref, reason }
        return {
          ok: false,
          error: `asserting "${target.name}" is visible right after clicking/filling it proves nothing changed — it was already known to be there to be interactable. Assert something that actually reflects the outcome instead (a message, a new/removed element, changed text).`,
          raw,
          recoverable: true,
          attemptedAction: attempted,
        }
      }
      return { ok: true, action: { action: 'assert_visible', ref, reason, ...clauseIndexField(obj.clauseIndex) } }
    }
    case 'assert_text': {
      const ref = checkRef()
      if (!ref) return { ok: false, error: `"ref" is missing or not one of this turn's valid refs`, raw }
      if (!isNonEmptyString(obj.expectedText)) {
        return { ok: false, error: '"expectedText" is missing for an assert_text action', raw }
      }
      return { ok: true, action: { action: 'assert_text', ref, expectedText: obj.expectedText, reason, ...clauseIndexField(obj.clauseIndex) } }
    }
    case 'assert_page_text': {
      if (!isNonEmptyString(obj.expectedText)) {
        return { ok: false, error: '"expectedText" is missing for an assert_page_text action', raw }
      }
      return { ok: true, action: { action: 'assert_page_text', expectedText: obj.expectedText, reason, ...clauseIndexField(obj.clauseIndex) } }
    }
    case 'scroll': {
      const direction = obj.direction === 'up' || obj.direction === 'down' ? obj.direction : undefined
      if (!direction) return { ok: false, error: '"direction" must be "up" or "down"', raw }
      return { ok: true, action: { action: 'scroll', direction, reason } }
    }
    case 'wait':
      return { ok: true, action: { action: 'wait', reason } }
    case 'done': {
      const outcome = obj.outcome === 'goal-reached' || obj.outcome === 'goal-unreachable' ? obj.outcome : undefined
      if (!outcome) return { ok: false, error: '"outcome" must be "goal-reached" or "goal-unreachable"', raw }
      return { ok: true, action: { action: 'done', outcome, reason } }
    }
    default:
      return { ok: false, error: `unrecognized "action" value: ${JSON.stringify(action)}`, raw }
  }
}
