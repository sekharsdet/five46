import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeOutline, buildActionPrompt, parseAgentAction, countConfirmationClauses, isDestructiveClickTarget, isImplausibleFillTarget, clauseLikelyMatches, buildPlanPrompt, parsePlan, resolvePlannedTarget, describePlannedStep } from './planner'
import { USERNAME_PLACEHOLDER } from './browser'
import type { PageOutline } from './types'
import { PLAN_MAX_OUTPUT_TOKENS, HARD_MAX_STEPS } from './runLoop'

const OUTLINE: PageOutline = {
  elements: [
    { ref: 'e1', tag: 'button', role: 'button', name: 'Show secret message', selector: '#reveal-btn' },
    { ref: 'e2', tag: 'input', role: 'textbox', name: 'Enter your name', selector: '#name-input' },
  ],
  truncated: false,
  totalFound: 2,
}

const EMPTY_OUTLINE: PageOutline = { elements: [], truncated: false, totalFound: 0 }

const DELETE_OUTLINE: PageOutline = {
  elements: [
    { ref: 'e1', tag: 'button', role: 'button', name: 'Delete Account', selector: '#delete-account-btn' },
    { ref: 'e2', tag: 'button', role: 'button', name: 'Remove from cart', selector: '#remove-cart-btn' },
  ],
  truncated: false,
  totalFound: 2,
}

test('serializeOutline lists each element with its ref, and discloses truncation rather than hiding it', () => {
  const text = serializeOutline(OUTLINE)
  assert.ok(text.includes('[e1] button "Show secret message"'))
  assert.ok(text.includes('[e2] textbox "Enter your name"'))

  const truncated: PageOutline = { ...OUTLINE, truncated: true, totalFound: 5 }
  const truncatedText = serializeOutline(truncated)
  assert.ok(truncatedText.includes('3 more visible interactive element(s) not shown'))
})

test('serializeOutline flags a file input so the model knows to use "upload", not "fill"', () => {
  const withFileInput: PageOutline = {
    elements: [...OUTLINE.elements, { ref: 'e3', tag: 'input', role: 'textbox', name: 'Attach resume', selector: '#resume', isFileInput: true }],
    truncated: false,
    totalFound: 3,
  }
  const text = serializeOutline(withFileInput)
  assert.ok(text.includes('[e3] textbox "Attach resume" (file input — use the "upload" action, never "fill")'))
  // An ordinary element (no isFileInput) must render exactly as before this
  // feature — no stray suffix on a field that was never flagged.
  assert.ok(text.includes('[e1] button "Show secret message"\n') || text.includes('[e1] button "Show secret message"'))
})

test('buildActionPrompt includes the goal, the outline, and the exact JSON schema', () => {
  const prompt = buildActionPrompt('reveal the secret message', [], OUTLINE)
  assert.ok(prompt.includes('reveal the secret message'))
  assert.ok(prompt.includes('[e1] button "Show secret message"'))
  assert.ok(prompt.includes('"action":"click"'))
  assert.ok(prompt.includes('"action":"scroll"'))
  assert.ok(prompt.includes('ONLY the JSON object'))
})

// Regression guard for the actual property this ordering exists for: the
// static, byte-identical-across-every-turn content (goal + schema
// instructions) must sit entirely BEFORE the per-turn-dynamic content
// (history + outline), so a provider's prefix-based prompt caching
// (OpenAI/Gemini automatic, Groq where supported) can actually treat that
// leading portion as a repeated prefix. See DEVELOPMENT.md's "Reordering
// prompts for provider-native caching" section.
test('buildActionPrompt places the static schema/instructions block before the dynamic history and outline, for prefix-cache friendliness', () => {
  const history = [{ action: { action: 'click' as const, ref: 'e1', reason: 'r' }, result: 'ok' as const, detail: '' }]
  const prompt = buildActionPrompt('reveal the secret message', history, OUTLINE)

  const schemaIndex = prompt.indexOf('Respond with exactly one JSON object describing the next single action')
  const historyIndex = prompt.indexOf('Steps taken so far:')
  const outlineIndex = prompt.indexOf('Elements currently visible on the page')

  assert.ok(schemaIndex >= 0 && historyIndex >= 0 && outlineIndex >= 0)
  assert.ok(schemaIndex < historyIndex, 'the static schema block must come before the dynamic history')
  assert.ok(historyIndex < outlineIndex, 'history must come before the outline, both after the static prefix')
  // The short closing reminder repeats the format instruction right before
  // generation (recovering the "recency effect" the reordering trades
  // away) — it must come after the outline, at the very end.
  const closingReminderIndex = prompt.lastIndexOf('Respond with ONLY the JSON object')
  assert.ok(closingReminderIndex > outlineIndex, 'the closing format reminder must be the last thing in the prompt')
})

test('buildActionPrompt tells the model to declare goal-unreachable honestly instead of guessing at the closest element', () => {
  // Regression test: found via real live testing that the model would pick
  // the nearest plausible element (e.g. an unrelated footer link) and
  // assert against it instead of admitting the real target wasn't present
  // — this instruction is unconditional (like confirmationNote, unlike
  // deleteNote), so it must appear regardless of goal phrasing.
  const withConfirmation = buildActionPrompt('reveal the secret and confirm it is visible', [], OUTLINE)
  const withoutConfirmation = buildActionPrompt('reveal the secret message', [], OUTLINE)
  for (const prompt of [withConfirmation, withoutConfirmation]) {
    assert.ok(prompt.includes('goal-unreachable" honestly'))
    assert.ok(prompt.includes('never guess'))
    assert.ok(prompt.includes('unopened menu/dropdown/tab/accordion'))
  }
})

test('buildActionPrompt bounds history and discloses omitted earlier steps rather than growing unboundedly', () => {
  const longHistory = Array.from({ length: 15 }, (_, i) => ({
    action: { action: 'click' as const, ref: 'e1', reason: `step ${i}` },
    result: 'ok' as const,
    detail: '',
  }))
  const prompt = buildActionPrompt('goal', longHistory, OUTLINE)
  assert.ok(prompt.includes('5 earlier step(s) omitted'))
})

test('parseAgentAction parses a real click response and validates the ref against this turn\'s outline', () => {
  const raw = JSON.stringify({ action: 'click', ref: 'e1', reason: 'open it' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.action, { action: 'click', ref: 'e1', reason: 'open it' })
  }
})

test('parseAgentAction parses a real hover response and validates the ref against this turn\'s outline', () => {
  const raw = JSON.stringify({ action: 'hover', ref: 'e1', reason: 'reveal the tooltip' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'hover', ref: 'e1', reason: 'reveal the tooltip' })
})

test('parseAgentAction fails honestly on a hover with no valid ref', () => {
  const raw = JSON.stringify({ action: 'hover', ref: 'e99', reason: 'nonexistent' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /valid refs/)
})

test('parseAgentAction parses a real dblclick response and validates the ref against this turn\'s outline', () => {
  const raw = JSON.stringify({ action: 'dblclick', ref: 'e1', reason: 'enter edit mode' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'dblclick', ref: 'e1', reason: 'enter edit mode' })
})

test('parseAgentAction parses a real drag response, validating both ref and targetRef against this turn\'s outline', () => {
  const raw = JSON.stringify({ action: 'drag', ref: 'e1', targetRef: 'e2', reason: 'reorder' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'drag', ref: 'e1', targetRef: 'e2', reason: 'reorder' })
})

test('parseAgentAction fails honestly on a drag whose targetRef is not one of this turn\'s valid refs, even when ref itself is valid', () => {
  const raw = JSON.stringify({ action: 'drag', ref: 'e1', targetRef: 'e99', reason: 'reorder' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /targetRef/)
})

test('parseAgentAction parses a real press_key response, validating both the ref and the required key field', () => {
  const raw = JSON.stringify({ action: 'press_key', ref: 'e2', key: 'Escape', reason: 'dismiss it' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'press_key', ref: 'e2', key: 'Escape', reason: 'dismiss it' })
})

test('parseAgentAction fails honestly on a press_key with no "key" field', () => {
  const raw = JSON.stringify({ action: 'press_key', ref: 'e2', reason: 'missing key' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /"key" is missing/)
})

test('parseAgentAction parses a real upload response, validating both the ref and the required filePath field', () => {
  const raw = JSON.stringify({ action: 'upload', ref: 'e2', filePath: '/tmp/fixture.txt', reason: 'attach the file' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'upload', ref: 'e2', filePath: '/tmp/fixture.txt', reason: 'attach the file' })
})

test('parseAgentAction fails honestly on an upload with no "filePath" field', () => {
  const raw = JSON.stringify({ action: 'upload', ref: 'e2', reason: 'missing path' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /"filePath" is missing/)
})

test('parseAgentAction strips a markdown json fence some models add, without guessing at malformed content', () => {
  const raw = '```json\n' + JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'done' }) + '\n```'
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.ok(result.ok)
})

test('parseAgentAction fails honestly, never guessing, on invalid JSON', () => {
  const result = parseAgentAction('not json at all', EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not valid JSON/)
})

test('parseAgentAction fails honestly on a hallucinated ref not present in this turn\'s outline', () => {
  // Regression coverage for the core anti-fabrication design decision: the
  // LLM never authors a selector, only picks a ref from the turn it was
  // given — an unrecognized ref must be a parse-level failure, never
  // silently accepted or guessed at.
  const raw = JSON.stringify({ action: 'click', ref: 'e99', reason: 'nonexistent' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /valid refs/)
})

test('parseAgentAction requires a recognized outcome for done, not just any string', () => {
  const raw = JSON.stringify({ action: 'done', outcome: 'i-think-so', reason: 'maybe' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
})

test('parseAgentAction accepts a valid scroll action, needing no ref', () => {
  const raw = JSON.stringify({ action: 'scroll', direction: 'down', reason: 'look for more content' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'scroll', direction: 'down', reason: 'look for more content' })
})

test('parseAgentAction rejects a scroll direction that is not "up" or "down"', () => {
  const raw = JSON.stringify({ action: 'scroll', direction: 'sideways', reason: 'r' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /"up" or "down"/)
})

test('parseAgentAction accepts a valid wait action, needing no ref', () => {
  const raw = JSON.stringify({ action: 'wait', reason: 'the page looks like it is still loading' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'wait', reason: 'the page looks like it is still loading' })
})

test('parseAgentAction accepts a valid assert_page_text action, needing no ref', () => {
  const raw = JSON.stringify({ action: 'assert_page_text', expectedText: 'Hello World!', reason: 'confirm it appeared' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'assert_page_text', expectedText: 'Hello World!', reason: 'confirm it appeared' })
})

test('parseAgentAction fails honestly when assert_page_text is missing expectedText', () => {
  const raw = JSON.stringify({ action: 'assert_page_text', reason: 'r' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /expectedText/)
})

test('parseAgentAction accepts a valid assert_page_text_absent action, needing no ref', () => {
  const raw = JSON.stringify({ action: 'assert_page_text_absent', expectedText: 'Deleted item', reason: 'confirm it is gone' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.ok(result.ok)
  if (result.ok) assert.deepEqual(result.action, { action: 'assert_page_text_absent', expectedText: 'Deleted item', reason: 'confirm it is gone' })
})

test('parseAgentAction fails honestly when assert_page_text_absent is missing expectedText', () => {
  const raw = JSON.stringify({ action: 'assert_page_text_absent', reason: 'r' })
  const result = parseAgentAction(raw, EMPTY_OUTLINE, false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /expectedText/)
})

test('isDestructiveClickTarget matches account/data-destruction phrases, not generic delete/remove verbs', () => {
  assert.equal(isDestructiveClickTarget('Delete Account'), true)
  assert.equal(isDestructiveClickTarget('Deactivate my account'), true)
  assert.equal(isDestructiveClickTarget('Permanently delete everything'), true)
  assert.equal(isDestructiveClickTarget('Cancel Subscription'), true)
  assert.equal(isDestructiveClickTarget('Remove from cart'), false)
  assert.equal(isDestructiveClickTarget('Delete search'), false)
  assert.equal(isDestructiveClickTarget('Submit'), false)
})

test('parseAgentAction blocks a destructive-looking click by default, and allows it with allowDeletes', () => {
  const raw = JSON.stringify({ action: 'click', ref: 'e1', reason: 'delete the account' })

  const blocked = parseAgentAction(raw, DELETE_OUTLINE, false)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.recoverable, true)
    if (blocked.recoverable) assert.deepEqual(blocked.attemptedAction, { action: 'click', ref: 'e1', reason: 'delete the account' })
    assert.match(blocked.error, /allow-deletes/)
  }

  const allowed = parseAgentAction(raw, DELETE_OUTLINE, true)
  assert.ok(allowed.ok)
})

test('parseAgentAction never blocks a click on a non-destructive-looking target, regardless of allowDeletes', () => {
  const raw = JSON.stringify({ action: 'click', ref: 'e2', reason: 'remove the item' })
  const result = parseAgentAction(raw, DELETE_OUTLINE, false)
  assert.ok(result.ok)
})

test('isImplausibleFillTarget flags known-never-fillable roles, never a real text-entry role', () => {
  assert.equal(isImplausibleFillTarget('button'), true)
  assert.equal(isImplausibleFillTarget('checkbox'), true)
  assert.equal(isImplausibleFillTarget('link'), true)
  assert.equal(isImplausibleFillTarget('heading'), true)
  assert.equal(isImplausibleFillTarget('generic'), true)
  assert.equal(isImplausibleFillTarget('textbox'), false)
  assert.equal(isImplausibleFillTarget('combobox'), false)
  assert.equal(isImplausibleFillTarget('searchbox'), false)
})

test('parseAgentAction rejects a fill on a real, live-found implausible target (a checkbox, matching react-select.com\'s own reasoning-quality miss) as a recoverable error the model can act on next turn', () => {
  const outline: PageOutline = {
    elements: [{ ref: 'e1', tag: 'input', role: 'checkbox', name: 'Searchable', selector: '#searchable-toggle' }],
    truncated: false,
    totalFound: 1,
  }
  const raw = JSON.stringify({ action: 'fill', ref: 'e1', value: 'Vanilla', reason: 'search for the option' })
  const result = parseAgentAction(raw, outline, false)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.recoverable, true)
    if (result.recoverable) assert.deepEqual(result.attemptedAction, { action: 'fill', ref: 'e1', value: 'Vanilla', submit: false, reason: 'search for the option' })
    assert.match(result.error, /checkbox/)
  }
})

test('parseAgentAction never blocks a fill on a genuine text-entry role', () => {
  const raw = JSON.stringify({ action: 'fill', ref: 'e2', value: 'Ada', reason: 'enter the name' })
  const result = parseAgentAction(raw, OUTLINE, false)
  assert.ok(result.ok)
})

test('parseAgentAction rejects an assert_value on an implausible (non-form-field) target the same way fill is rejected', () => {
  const outline: PageOutline = {
    elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'Submit', selector: '#submit-btn' }],
    truncated: false,
    totalFound: 1,
  }
  const raw = JSON.stringify({ action: 'assert_value', ref: 'e1', expectedValue: 'Vanilla', reason: 'confirm the value' })
  const result = parseAgentAction(raw, outline, false)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.recoverable, true)
    assert.match(result.error, /button/)
  }
})

test('parseAgentAction blocks asserting visibility of the exact element just clicked/filled — it proves nothing changed', () => {
  // Regression test: found via real live testing (demoblaze.com) — asked
  // to confirm a validation error was shown, the model clicked "Purchase"
  // twice then "verified" its own claim by asserting the Purchase button
  // itself was still visible, trivially true regardless of outcome.
  const raw = JSON.stringify({ action: 'assert_visible', ref: 'e1', reason: 'confirm it worked' })
  const recentlyInteracted = { role: 'button', name: 'Show secret message' }

  const blocked = parseAgentAction(raw, OUTLINE, false, recentlyInteracted)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.recoverable, true)
    if (blocked.recoverable) assert.deepEqual(blocked.attemptedAction, { action: 'assert_visible', ref: 'e1', reason: 'confirm it worked' })
    assert.match(blocked.error, /proves nothing changed/)
  }
})

test('parseAgentAction allows asserting visibility of a DIFFERENT element than the one just clicked/filled', () => {
  const raw = JSON.stringify({ action: 'assert_visible', ref: 'e2', reason: 'confirm the name field appeared' })
  const recentlyInteracted = { role: 'button', name: 'Show secret message' }
  const result = parseAgentAction(raw, OUTLINE, false, recentlyInteracted)
  assert.ok(result.ok)
})

test('parseAgentAction allows asserting visibility of the same-ref element when nothing was recently interacted with', () => {
  const raw = JSON.stringify({ action: 'assert_visible', ref: 'e1', reason: 'first check of the run' })
  const result = parseAgentAction(raw, OUTLINE, false, undefined)
  assert.ok(result.ok)
})

test('parseAgentAction never blocks assert_text on the exact element just clicked/filled — re-checking its own text can be genuinely informative', () => {
  // Deliberately narrower than assert_visible: a counter button whose own
  // label changes ("Count: 0" -> "Count: 1") is a real, legitimate reason
  // to assert_text the same element right after clicking it.
  const raw = JSON.stringify({ action: 'assert_text', ref: 'e1', expectedText: 'Count: 1', reason: 'confirm the counter incremented' })
  const recentlyInteracted = { role: 'button', name: 'Show secret message' }
  const result = parseAgentAction(raw, OUTLINE, false, recentlyInteracted)
  assert.ok(result.ok)
})

test('buildActionPrompt discloses the tautological-assertion rule unconditionally in the assert_visible schema line', () => {
  const prompt = buildActionPrompt('goal', [], OUTLINE)
  assert.ok(prompt.includes('never assert visibility of the exact element you just clicked or filled'))
})

test('buildActionPrompt discloses the delete-gating up front when allowDeletes is falsy, and omits it when true', () => {
  const gated = buildActionPrompt('delete my account', [], OUTLINE, undefined, false)
  assert.ok(gated.includes('--allow-deletes'))

  const unlocked = buildActionPrompt('delete my account', [], OUTLINE, undefined, true)
  assert.ok(!unlocked.includes('--allow-deletes'))

  const defaulted = buildActionPrompt('delete my account', [], OUTLINE)
  assert.ok(defaulted.includes('--allow-deletes'))
})

test('countConfirmationClauses counts occurrences, not just presence, of confirm/verify/etc. language', () => {
  // Real, live-found gap this enables the fix for: a compound goal with
  // two confirm-clauses ("...confirm the price is shown, then click Next,
  // confirm the calendar changed") let the model skip the first one
  // entirely — a plain boolean has no way to know two checks were asked
  // for, not one.
  assert.equal(countConfirmationClauses('add a product to the cart'), 0)
  assert.equal(countConfirmationClauses('reveal the secret message and confirm it becomes visible'), 1)
  assert.equal(
    countConfirmationClauses('confirm the price is shown, then click Next on the calendar, and confirm the calendar now shows a different month'),
    2
  )
  assert.equal(countConfirmationClauses('confirm X, verify Y, and ensure Z'), 3)
})

test('buildActionPrompt always discloses the assertion requirement upfront, not just after rejecting a done claim — unconditionally, regardless of the goal\'s own wording', () => {
  // Found via live testing against real production sites (Flipkart,
  // Amazon.in): a goal with zero confirm/verify language used to get zero
  // forced verification at all, since this note (and the enforcement in
  // runner.ts/apiRunner.ts) only used to fire when requiresConfirmation()
  // matched. Now unconditional — see countConfirmationClauses' own doc
  // comment and DEVELOPMENT.md's "Known limitations" section.
  const withConfirmWording = buildActionPrompt('reveal the secret and confirm it is visible', [], OUTLINE)
  assert.ok(withConfirmWording.includes('at least 1 successful'))
  assert.ok(withConfirmWording.includes('assert_visible, assert_text, assert_value, assert_page_text, or assert_page_text_absent'))

  const plainGoal = buildActionPrompt('reveal the secret', [], OUTLINE)
  assert.ok(plainGoal.includes('at least 1 successful'), 'the note must still appear even when the goal has no confirm/verify wording at all')

  const twoConfirmClauses = buildActionPrompt('confirm the price is shown, then click Next, and confirm the calendar changed', [], OUTLINE)
  assert.ok(twoConfirmClauses.includes('at least 2 successful'), 'a compound goal with two confirm-clauses must require 2, not just 1')
})

test('buildActionPrompt warns against asserting a persistent/ambient element that would be true regardless of whether the actions worked', () => {
  // Found via live testing against a real production site (Flipkart): the
  // model satisfied the confirmation requirement above by asserting a
  // site-wide header link ("Login") that's visible on every page
  // regardless of state, proving nothing, then never completed the rest
  // of the goal. Guidance only — nothing mechanically rejects this the way
  // the confirmation-count check does, since "was this meaningful" is a
  // real semantic judgment.
  const prompt = buildActionPrompt('reveal the secret message', [], OUTLINE)
  assert.ok(prompt.includes('persistent/ambient element'))
  assert.ok(prompt.includes('specifically changed, newly appeared, or only exists because of the actions you just took'))
})

test('buildActionPrompt tells the model about the placeholder tokens only when credentials are actually configured', () => {
  const withCreds = buildActionPrompt('log in', [], OUTLINE, { username: true, password: true })
  assert.ok(withCreds.includes('%%USERNAME%%'))
  assert.ok(withCreds.includes('%%PASSWORD%%'))
  assert.ok(withCreds.includes('never write a real-looking username or password yourself'))

  const withoutCreds = buildActionPrompt('log in', [], OUTLINE, { username: false, password: false })
  assert.ok(!withoutCreds.includes('%%USERNAME%%'))

  const noArg = buildActionPrompt('log in', [], OUTLINE)
  assert.ok(!noArg.includes('%%USERNAME%%'))
})

test('buildActionPrompt structurally cannot leak an actual credential, since its signature only accepts presence booleans', () => {
  // A real secret string literally cannot be passed to `credentialsAvailable`
  // — its type is `{ username: boolean; password: boolean }` — so it
  // cannot appear in the returned prompt regardless of what else this
  // function does. Not much to assert at runtime beyond "it still returns
  // the placeholder instructions, not something else" — the actual
  // guarantee here is enforced by the TypeScript signature itself.
  const prompt = buildActionPrompt('log in', [], OUTLINE, { username: true, password: true })
  assert.ok(prompt.includes(USERNAME_PLACEHOLDER))
})

test('buildPlanPrompt includes the goal, the initial outline, and the plan JSON schema', () => {
  const prompt = buildPlanPrompt('reveal the secret message', OUTLINE)
  assert.ok(prompt.includes('reveal the secret message'))
  assert.ok(prompt.includes('[e1] button "Show secret message"'))
  assert.ok(prompt.includes('"steps"'))
  assert.ok(prompt.includes('"nameContains"'))
  assert.ok(prompt.includes('prediction'))
})

test('buildPlanPrompt warns against declaring goal-unreachable from assumption alone, since a plan is made before any real evidence exists', () => {
  // Real, live-found gap: a plan-time "unreachable" has nothing but the
  // model's own assumptions to go on (no request/page has been seen yet),
  // unlike the live per-step prompt's equivalent guidance which is
  // explicitly grounded in "the elements list above" / "responses seen so
  // far." Without this, a model with strong priors about a well-known site
  // could give up before ever trying anything.
  const prompt = buildPlanPrompt('reveal the secret message', OUTLINE)
  assert.ok(prompt.includes('no real evidence yet'))
  assert.ok(prompt.includes('a guess made now'))
})

test('buildPlanPrompt grounds the plan in caller-supplied steps when given, instead of asking the model to invent its own sequence', () => {
  const prompt = buildPlanPrompt('reveal the secret message', OUTLINE, undefined, [
    { type: 'action', description: 'Click the reveal button' },
    { type: 'assertion', description: 'The secret message is now visible' },
  ])
  assert.ok(prompt.includes('caller has already worked out the steps below'))
  assert.ok(prompt.includes('1. [action] Click the reveal button'))
  assert.ok(prompt.includes('2. [assertion] The secret message is now visible'))
  // The JSON response contract is unchanged — still the same schema/fields.
  assert.ok(prompt.includes('"steps"'))
  assert.ok(prompt.includes('"nameContains"'))
})

test('buildPlanPrompt asks the model to invent its own sequence when no caller steps are given, same as before this option existed', () => {
  const prompt = buildPlanPrompt('reveal the secret message', OUTLINE)
  assert.ok(prompt.includes('plan out the whole sequence of steps needed'))
  assert.ok(!prompt.includes('caller has already worked out'))
})

test('parsePlan strictly parses a real, well-formed plan response', () => {
  const raw = JSON.stringify({
    steps: [
      { action: 'click', target: { role: 'link', nameContains: 'Rooms' }, reason: 'open the listing' },
      { action: 'fill', target: { role: 'textbox', nameContains: 'name' }, value: 'Ada', submit: true, reason: 'fill the name' },
      { action: 'hover', target: { role: 'button', nameContains: 'tooltip' }, reason: 'reveal the tooltip' },
      { action: 'dblclick', target: { role: 'gridcell', nameContains: 'cell' }, reason: 'enter edit mode' },
      { action: 'drag', target: { role: 'listitem', nameContains: 'Item C' }, destinationTarget: { role: 'listitem', nameContains: 'Item A' }, reason: 'reorder' },
      { action: 'press_key', target: { role: 'textbox', nameContains: 'search' }, key: 'Escape', reason: 'dismiss it' },
      { action: 'upload', target: { role: 'textbox', nameContains: 'resume' }, filePath: '/tmp/resume.pdf', reason: 'attach the file' },
      { action: 'assert_visible', target: { role: 'status', nameContains: 'price' }, reason: 'confirm price shown' },
      { action: 'assert_text', target: { role: 'status', nameContains: 'price' }, expectedText: '$100', reason: 'confirm exact price' },
      { action: 'assert_page_text', expectedText: 'Hello World!', reason: 'confirm text appears anywhere on the page' },
      { action: 'assert_page_text_absent', expectedText: 'Goodbye World!', reason: 'confirm text is gone from the page' },
      { action: 'scroll', direction: 'down', reason: 'reveal more content' },
      { action: 'wait', reason: 'content may still be loading' },
      { action: 'done', outcome: 'goal-reached', reason: 'all confirmed' },
    ],
  })
  const result = parsePlan(raw)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.plan.steps.length, 14)
  assert.deepEqual(result.plan.steps[0], { action: 'click', target: { role: 'link', nameContains: 'Rooms' }, reason: 'open the listing' })
  assert.deepEqual(result.plan.steps[2], { action: 'hover', target: { role: 'button', nameContains: 'tooltip' }, reason: 'reveal the tooltip' })
  assert.deepEqual(result.plan.steps[3], { action: 'dblclick', target: { role: 'gridcell', nameContains: 'cell' }, reason: 'enter edit mode' })
  assert.deepEqual(result.plan.steps[4], {
    action: 'drag',
    target: { role: 'listitem', nameContains: 'Item C' },
    destinationTarget: { role: 'listitem', nameContains: 'Item A' },
    reason: 'reorder',
  })
  assert.deepEqual(result.plan.steps[5], { action: 'press_key', target: { role: 'textbox', nameContains: 'search' }, key: 'Escape', reason: 'dismiss it' })
  assert.deepEqual(result.plan.steps[6], { action: 'upload', target: { role: 'textbox', nameContains: 'resume' }, filePath: '/tmp/resume.pdf', reason: 'attach the file' })
  assert.deepEqual(result.plan.steps[9], { action: 'assert_page_text', expectedText: 'Hello World!', reason: 'confirm text appears anywhere on the page' })
  assert.deepEqual(result.plan.steps[10], { action: 'assert_page_text_absent', expectedText: 'Goodbye World!', reason: 'confirm text is gone from the page' })
  assert.deepEqual(result.plan.steps[12], { action: 'wait', reason: 'content may still be loading' })
  assert.equal(result.plan.steps[13].action, 'done')
})

test('parsePlan strips a markdown json fence, the same accommodation parseAgentAction already makes', () => {
  const raw = '```json\n' + JSON.stringify({ steps: [{ action: 'scroll', direction: 'down', reason: 'r' }] }) + '\n```'
  const result = parsePlan(raw)
  assert.equal(result.ok, true)
})

test('parsePlan fails honestly, never guessing, on invalid JSON', () => {
  const result = parsePlan('not json at all')
  assert.equal(result.ok, false)
})

test('parsePlan fails honestly when the response is not a {"steps": [...]} object', () => {
  assert.equal(parsePlan(JSON.stringify({ notSteps: [] })).ok, false)
  assert.equal(parsePlan(JSON.stringify([])).ok, false)
})

test('parsePlan fails honestly on an empty steps array — a plan must actually plan something', () => {
  assert.equal(parsePlan(JSON.stringify({ steps: [] })).ok, false)
})

test('parsePlan rejects a plan whose only step is an immediate "done", for either outcome, since no real action was ever attempted', () => {
  // Real, live-repeated failure: a CRUD goal against a well-known fake API
  // produced exactly this shape twice, giving up in under 13s with zero
  // real requests ever attempted — see this function's own doc comment.
  const unreachable = parsePlan(JSON.stringify({ steps: [{ action: 'done', outcome: 'goal-unreachable', reason: 'assumed this API does not support it' }] }))
  assert.equal(unreachable.ok, false)
  if (!unreachable.ok) assert.match(unreachable.error, /no real action ever attempted/)

  // Symmetric case: an immediate goal-reached with zero real actions is the
  // same category of ungrounded claim.
  const reached = parsePlan(JSON.stringify({ steps: [{ action: 'done', outcome: 'goal-reached', reason: 'assumed already satisfied' }] }))
  assert.equal(reached.ok, false)
})

test('parsePlan accepts a plan with a real action before its trailing "done" step — unaffected by the immediate-done rejection', () => {
  const raw = JSON.stringify({
    steps: [
      { action: 'click', target: { role: 'button', nameContains: 'Start' }, reason: 'begin' },
      { action: 'done', outcome: 'goal-reached', reason: 'confirmed' },
    ],
  })
  const result = parsePlan(raw)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.plan.steps.length, 2)
})

test('parsePlan fails honestly when any single step is malformed, rather than silently dropping it', () => {
  const raw = JSON.stringify({
    steps: [
      { action: 'scroll', direction: 'down', reason: 'ok' },
      { action: 'click', reason: 'missing target entirely' },
    ],
  })
  assert.equal(parsePlan(raw).ok, false)
})

test('parsePlan rejects a click/fill/assert step whose target is missing role or nameContains', () => {
  assert.equal(parsePlan(JSON.stringify({ steps: [{ action: 'click', target: { nameContains: 'Rooms' }, reason: 'r' }] })).ok, false)
  assert.equal(parsePlan(JSON.stringify({ steps: [{ action: 'click', target: { role: 'link' }, reason: 'r' }] })).ok, false)
})

test('resolvePlannedTarget matches by exact role and case-insensitive name substring, requiring both', () => {
  const matches = resolvePlannedTarget(OUTLINE, { role: 'button', nameContains: 'secret' })
  assert.equal(matches.length, 1)
  assert.equal(matches[0].ref, 'e1')

  // Wrong role, name would otherwise match — must not match.
  assert.equal(resolvePlannedTarget(OUTLINE, { role: 'link', nameContains: 'secret' }).length, 0)
})

test('resolvePlannedTarget returns every candidate on ambiguity — never picks one, leaves refusal to the caller', () => {
  const ambiguous: PageOutline = {
    elements: [
      { ref: 'e1', tag: 'button', role: 'button', name: 'Delete', selector: '#a' },
      { ref: 'e2', tag: 'button', role: 'button', name: 'Delete', selector: '#b' },
    ],
    truncated: false,
    totalFound: 2,
  }
  assert.equal(resolvePlannedTarget(ambiguous, { role: 'button', nameContains: 'Delete' }).length, 2)
})

test('resolvePlannedTarget returns no candidates when nothing matches, rather than guessing the closest one', () => {
  assert.equal(resolvePlannedTarget(OUTLINE, { role: 'button', nameContains: 'Nonexistent Target' }).length, 0)
})

test('buildActionPrompt injects plan context only when a live fallback actually happens, telling the model it is not required to follow the plan', () => {
  const plannedStep = { action: 'click' as const, target: { role: 'link', nameContains: 'Rooms' }, reason: 'open the listing' }
  const withPlan = buildActionPrompt('goal', [], OUTLINE, undefined, undefined, { index: 1, total: 3, step: plannedStep })
  assert.ok(withPlan.includes('step 2 of 3'))
  assert.ok(withPlan.includes('not required to follow the plan exactly'))

  const withoutPlan = buildActionPrompt('goal', [], OUTLINE)
  assert.ok(!withoutPlan.includes('upfront plan'))
})

test('describePlannedStep renders each planned action type in a short, human-readable phrase', () => {
  assert.equal(describePlannedStep({ action: 'click', target: { role: 'link', nameContains: 'Rooms' }, reason: 'r' }), 'click a link matching "Rooms"')
  assert.equal(describePlannedStep({ action: 'hover', target: { role: 'button', nameContains: 'tip' }, reason: 'r' }), 'hover a button matching "tip"')
  assert.equal(describePlannedStep({ action: 'dblclick', target: { role: 'gridcell', nameContains: 'cell' }, reason: 'r' }), 'double-click a gridcell matching "cell"')
  assert.equal(
    describePlannedStep({
      action: 'drag',
      target: { role: 'listitem', nameContains: 'Item C' },
      destinationTarget: { role: 'listitem', nameContains: 'Item A' },
      reason: 'r',
    }),
    'drag a listitem matching "Item C" onto a listitem matching "Item A"'
  )
  assert.equal(
    describePlannedStep({ action: 'press_key', target: { role: 'textbox', nameContains: 'search' }, key: 'Escape', reason: 'r' }),
    'press "Escape" on a textbox matching "search"'
  )
  assert.equal(
    describePlannedStep({ action: 'upload', target: { role: 'textbox', nameContains: 'resume' }, filePath: '/tmp/r.pdf', reason: 'r' }),
    'upload "/tmp/r.pdf" to a textbox matching "resume"'
  )
  assert.equal(describePlannedStep({ action: 'scroll', direction: 'down', reason: 'r' }), 'scroll down')
  assert.equal(describePlannedStep({ action: 'wait', reason: 'r' }), 'wait')
  assert.equal(describePlannedStep({ action: 'assert_page_text', expectedText: 'Hello World!', reason: 'r' }), 'assert the page contains "Hello World!"')
  assert.equal(describePlannedStep({ action: 'assert_page_text_absent', expectedText: 'Goodbye World!', reason: 'r' }), 'assert the page no longer contains "Goodbye World!"')
  assert.equal(describePlannedStep({ action: 'done', outcome: 'goal-reached', reason: 'r' }), 'done (goal-reached)')
})

// Regression guard for PLAN_MAX_OUTPUT_TOKENS (runLoop.ts): a real plan
// response has to fit comfortably under this cap or the upfront plan call
// gets truncated mid-JSON — a failure mode no provider's empty-completion
// diagnostic catches (see runLoop.ts's own doc comment on the constant).
// This is a static, non-network sanity check: build the largest realistic
// plan (HARD_MAX_STEPS worth of step objects) and confirm it stays well
// under the cap, using a deliberately pessimistic chars-per-token ratio
// (~3.2, vs. the commonly-cited ~4) so this proves real headroom, not "it
// fits exactly."
test('a HARD_MAX_STEPS-sized plan response stays comfortably under PLAN_MAX_OUTPUT_TOKENS', () => {
  const steps = Array.from({ length: HARD_MAX_STEPS }, (_, i) => ({
    action: 'click',
    target: { role: 'link', nameContains: `item ${i}` },
    reason: `select item ${i} of ${HARD_MAX_STEPS}, a realistically-worded reason string`,
  }))
  const raw = JSON.stringify({ steps })
  const estimatedTokens = Math.ceil(raw.length / 3.2)
  assert.ok(
    estimatedTokens < PLAN_MAX_OUTPUT_TOKENS,
    `estimated ${estimatedTokens} tokens for a ${HARD_MAX_STEPS}-step plan must stay under the ${PLAN_MAX_OUTPUT_TOKENS}-token cap`
  )
})

test('parseAgentAction captures a valid clauseIndex on an assertion', () => {
  const visible = parseAgentAction(JSON.stringify({ action: 'assert_visible', ref: 'e1', reason: 'r', clauseIndex: 1 }), OUTLINE, false)
  assert.ok(visible.ok)
  if (visible.ok) assert.deepEqual(visible.action, { action: 'assert_visible', ref: 'e1', reason: 'r', clauseIndex: 1 })

  const text = parseAgentAction(JSON.stringify({ action: 'assert_text', ref: 'e2', expectedText: 'hi', reason: 'r', clauseIndex: 0 }), OUTLINE, false)
  assert.ok(text.ok)
  if (text.ok) assert.deepEqual(text.action, { action: 'assert_text', ref: 'e2', expectedText: 'hi', reason: 'r', clauseIndex: 0 })

  const pageText = parseAgentAction(JSON.stringify({ action: 'assert_page_text', expectedText: 'hi', reason: 'r', clauseIndex: 2 }), EMPTY_OUTLINE, false)
  assert.ok(pageText.ok)
  if (pageText.ok) assert.deepEqual(pageText.action, { action: 'assert_page_text', expectedText: 'hi', reason: 'r', clauseIndex: 2 })

  const pageTextAbsent = parseAgentAction(JSON.stringify({ action: 'assert_page_text_absent', expectedText: 'gone', reason: 'r', clauseIndex: 3 }), EMPTY_OUTLINE, false)
  assert.ok(pageTextAbsent.ok)
  if (pageTextAbsent.ok) assert.deepEqual(pageTextAbsent.action, { action: 'assert_page_text_absent', expectedText: 'gone', reason: 'r', clauseIndex: 3 })
})

test('parseAgentAction omits clauseIndex entirely (not clauseIndex: undefined) when absent or invalid, keeping every pre-existing exact-shape test unaffected', () => {
  const missing = parseAgentAction(JSON.stringify({ action: 'assert_visible', ref: 'e1', reason: 'r' }), OUTLINE, false)
  assert.ok(missing.ok)
  if (missing.ok) {
    assert.deepEqual(missing.action, { action: 'assert_visible', ref: 'e1', reason: 'r' })
    assert.ok(!('clauseIndex' in missing.action), 'expected no own clauseIndex key at all when absent from the response')
  }

  for (const badValue of [-1, 1.5, 'zero', null, true]) {
    const result = parseAgentAction(JSON.stringify({ action: 'assert_visible', ref: 'e1', reason: 'r', clauseIndex: badValue }), OUTLINE, false)
    assert.ok(result.ok)
    if (result.ok) assert.ok(!('clauseIndex' in result.action), `expected clauseIndex ${JSON.stringify(badValue)} to be dropped, not coerced`)
  }
})

test('clauseLikelyMatches finds a shared significant token between a clause and an assertion\'s text', () => {
  assert.equal(clauseLikelyMatches('the cart shows at least 1 item', 'Cart'), true)
  assert.equal(clauseLikelyMatches('a login field is visible', 'Username'), false)
})

test('clauseLikelyMatches ignores confirm/verify/stopword language on both sides', () => {
  assert.equal(clauseLikelyMatches('confirm the cart shows an item', 'the cart now has 1 item in it'), true)
})

test('clauseLikelyMatches treats too-little-text-to-compare as inconclusive and passes, never falsely blocking a genuine match', () => {
  assert.equal(clauseLikelyMatches('confirm that is shown', 'the'), true)
  assert.equal(clauseLikelyMatches('', 'anything at all here'), true)
})

test('clauseLikelyMatches rejects a clearly unrelated pairing', () => {
  assert.equal(clauseLikelyMatches('the shipping address is saved', 'password reset email sent'), false)
})

test('buildActionPrompt renders per-clause coverage instructions and a clauseIndex schema hint only when 2+ clauses are passed', () => {
  const clauses = ['the cart shows at least 1 item', 'a login field is visible']
  const withClauses = buildActionPrompt('goal', [], EMPTY_OUTLINE, undefined, true, undefined, clauses)
  assert.ok(withClauses.includes('This goal has 2 distinct things to confirm'))
  assert.ok(withClauses.includes('0. the cart shows at least 1 item'))
  assert.ok(withClauses.includes('1. a login field is visible'))
  assert.ok(withClauses.includes('"clauseIndex"'))
  // The old total-count wording must not also appear — the two notes are
  // mutually exclusive, never both rendered.
  assert.ok(!withClauses.includes('successful assert_visible, assert_text, assert_value, assert_page_text, or assert_page_text_absent action(s) before'))

  const withoutClauses = buildActionPrompt('goal', [], EMPTY_OUTLINE, undefined, true)
  assert.ok(!withoutClauses.includes('distinct things to confirm'))
  assert.ok(!withoutClauses.includes('"clauseIndex"'))
})

test('buildActionPrompt treats a single-element clauses array as no compound structure worth tracking — same as passing none at all', () => {
  const prompt = buildActionPrompt('goal', [], EMPTY_OUTLINE, undefined, true, undefined, ['only one clause'])
  assert.ok(!prompt.includes('distinct things to confirm'))
  assert.ok(!prompt.includes('"clauseIndex"'))
  assert.ok(prompt.includes('successful assert_visible, assert_text, assert_value, assert_page_text, or assert_page_text_absent action(s) before'))
})

test('buildPlanPrompt renders per-clause coverage instructions and a clauseIndex schema hint only when 2+ clauses are passed', () => {
  const clauses = ['the cart shows at least 1 item', 'a login field is visible']
  const withClauses = buildPlanPrompt('goal', EMPTY_OUTLINE, clauses)
  assert.ok(withClauses.includes('This goal has 2 distinct things to confirm'))
  assert.ok(withClauses.includes('0. the cart shows at least 1 item'))
  assert.ok(withClauses.includes('1. a login field is visible'))
  assert.ok(withClauses.includes('"clauseIndex"'))

  const withoutClauses = buildPlanPrompt('goal', EMPTY_OUTLINE)
  assert.ok(!withoutClauses.includes('distinct things to confirm'))
  assert.ok(!withoutClauses.includes('"clauseIndex"'))
})
