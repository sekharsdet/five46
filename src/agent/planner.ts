import type { AgentAction, CredentialAvailability, HistoryEntry, PageOutline } from './types'
import { USERNAME_PLACEHOLDER, PASSWORD_PLACEHOLDER } from './browser'

const MAX_HISTORY = 10

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
    case 'scroll':
      return `scroll ${action.direction}`
    case 'done':
      return `done (${action.outcome})`
  }
}

const ACTION_SCHEMA_EXAMPLE = `{"action":"click","ref":"e2","reason":"the goal requires opening the menu first"}`

const CONFIRMATION_PATTERN = /\b(confirm|verify|ensure|make sure|check that)\b/i

/** Naming-heuristic detection of "this goal asks for verification," not
 * real NLP — a goal phrased with confirm/verify/ensure/etc. language is
 * asking to be *checked*, not just *done*. Found via a real, live run
 * (a Shopify demo store, goal: "...then confirm the cart shows an item"):
 * the model added a real item to the cart, then declared `goal-reached`
 * without ever calling `assert_visible`/`assert_text` — the outcome
 * happened to be correct, but nothing in the run actually verified it, and
 * the goal explicitly asked for verification. `runner.ts` uses this to
 * require at least one successful assertion before accepting a
 * `goal-reached` claim for a goal shaped this way — same "don't accept an
 * unverified confident claim" posture as everywhere else in this project. */
export function requiresConfirmation(goal: string): boolean {
  return CONFIRMATION_PATTERN.test(goal)
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
 * of heuristic as `requiresConfirmation`, not real NLP. */
export function isDestructiveClickTarget(name: string): boolean {
  const lower = name.toLowerCase()
  return DESTRUCTIVE_CLICK_PHRASES.some((phrase) => lower.includes(phrase))
}

/** Builds the "what's the next single action" prompt — the only shape the
 * agentic loop can take given `LlmProvider.complete()` is single string
 * in/out with no tool-calling or JSON-mode hook (see the plan's reasoning).
 * Deliberately never asks the model to author a selector: it only ever
 * picks a `ref` from *this turn's* outline, which the runner resolves back
 * to a real, already-computed Playwright selector — the model can't
 * fabricate a locator that was never actually on the page. */
export function buildActionPrompt(
  goal: string,
  history: HistoryEntry[],
  outline: PageOutline,
  credentialsAvailable?: CredentialAvailability,
  allowDeletes?: boolean
): string {
  const confirmationNote = requiresConfirmation(goal)
    ? [
        ``,
        `This goal asks you to confirm/verify something — you must perform at least one`,
        `successful assert_visible or assert_text action before you're allowed to declare`,
        `"done" with outcome "goal-reached". Declaring done without one will be rejected.`,
      ]
    : []
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
  return [
    `You are a web testing agent driving a real browser toward one goal, one action at a time.`,
    ``,
    `Goal: ${goal}`,
    ...confirmationNote,
    ...deleteNote,
    ...credentialNote,
    ``,
    `Steps taken so far:`,
    serializeHistory(history),
    ``,
    `Elements currently visible on the page (pick a ref from this list only — you cannot act on anything not listed here):`,
    serializeOutline(outline),
    ``,
    `Respond with exactly one JSON object describing the next single action to take, one of:`,
    `- {"action":"click","ref":"<ref>","reason":"<why>"}`,
    `- {"action":"fill","ref":"<ref>","value":"<text>","submit":<true|false>,"reason":"<why>"}`,
    `- {"action":"assert_visible","ref":"<ref>","reason":"<why>"}`,
    `- {"action":"assert_text","ref":"<ref>","expectedText":"<text>","reason":"<why>"}`,
    `- {"action":"scroll","direction":"up"|"down","reason":"<why>"} (scrolls the whole page by one viewport height — use this if what you need isn't in the list above)`,
    `- {"action":"done","outcome":"goal-reached"|"goal-unreachable","reason":"<why>"} (choose "goal-unreachable" honestly when the goal's target genuinely is not in the elements list above, scrolling will not reveal it, and no unopened menu/dropdown/tab/accordion visible on the page is likely to reveal it either — try clicking one such element first if one plausibly exists; never guess by acting on or asserting against the closest-looking element instead)`,
    ``,
    `Example: ${ACTION_SCHEMA_EXAMPLE}`,
    ``,
    `Respond with ONLY the JSON object — no markdown fence, no prose before or after it.`,
  ].join('\n')
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
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
 * silently accepted or silently executed. */
export function parseAgentAction(raw: string, outline: PageOutline, allowDeletes: boolean): ParseAgentActionResult {
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
      return { ok: true, action: { action: 'assert_visible', ref, reason } }
    }
    case 'assert_text': {
      const ref = checkRef()
      if (!ref) return { ok: false, error: `"ref" is missing or not one of this turn's valid refs`, raw }
      if (!isNonEmptyString(obj.expectedText)) {
        return { ok: false, error: '"expectedText" is missing for an assert_text action', raw }
      }
      return { ok: true, action: { action: 'assert_text', ref, expectedText: obj.expectedText, reason } }
    }
    case 'scroll': {
      const direction = obj.direction === 'up' || obj.direction === 'down' ? obj.direction : undefined
      if (!direction) return { ok: false, error: '"direction" must be "up" or "down"', raw }
      return { ok: true, action: { action: 'scroll', direction, reason } }
    }
    case 'done': {
      const outcome = obj.outcome === 'goal-reached' || obj.outcome === 'goal-unreachable' ? obj.outcome : undefined
      if (!outcome) return { ok: false, error: '"outcome" must be "goal-reached" or "goal-unreachable"', raw }
      return { ok: true, action: { action: 'done', outcome, reason } }
    }
    default:
      return { ok: false, error: `unrecognized "action" value: ${JSON.stringify(action)}`, raw }
  }
}
