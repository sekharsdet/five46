import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApiActionPrompt, parseApiAction, buildApiPlanPrompt, parseApiPlan, checkVarReferences } from './apiPlanner'
import type { SafetyMode } from './apiTypes'

const READ_ONLY: SafetyMode = { allowWrites: false, allowDeletes: false, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }
const WRITES_AND_DELETES: SafetyMode = { allowWrites: true, allowDeletes: true, targetOrigin: 'http://localhost:1', allowedHosts: new Set() }

test('buildApiActionPrompt discloses the allowed methods/hosts up front, not just after a rejection', () => {
  // "POST" legitimately appears elsewhere in every prompt regardless of
  // safety mode (the schema example illustrates the JSON shape, not what's
  // currently allowed) — check the actual disclosure line specifically,
  // not the whole prompt text.
  const readOnlyPrompt = buildApiActionPrompt('goal', [], new Set(), READ_ONLY)
  const readOnlyLine = readOnlyPrompt.split('\n').find((l) => l.startsWith('Allowed methods this run:'))
  assert.equal(readOnlyLine, 'Allowed methods this run: GET, HEAD, OPTIONS. Allowed host(s): http://localhost:1. Any other method or host will be rejected — don\'t attempt one.')

  const fullPrompt = buildApiActionPrompt('goal', [], new Set(), WRITES_AND_DELETES)
  const fullLine = fullPrompt.split('\n').find((l) => l.startsWith('Allowed methods this run:'))
  assert.ok(fullLine?.includes('POST, PUT, PATCH'))
  assert.ok(fullLine?.includes('DELETE'))
})

// Regression guard for the actual property this ordering exists for — same
// reasoning as planner.ts's identical test: the static, byte-identical
// content (goal + safety disclosure + schema instructions) must sit before
// the per-turn-dynamic content (varsNote + history), so provider-native
// prefix-based prompt caching can treat that leading portion as a repeated
// prefix. See DEVELOPMENT.md's "Reordering prompts for provider-native
// caching" section.
test('buildApiActionPrompt places the static schema/instructions block before the dynamic varsNote and history, for prefix-cache friendliness', () => {
  const history = [{ action: { action: 'request' as const, method: 'GET' as const, url: '/x', reason: 'r' }, result: 'ok' as const, detail: '' }]
  const prompt = buildApiActionPrompt('goal', history, new Set(['userId']), READ_ONLY)

  const schemaIndex = prompt.indexOf('Respond with exactly one JSON object describing the next single action')
  const varsIndex = prompt.indexOf('Values saved so far')
  const historyIndex = prompt.indexOf('Steps taken so far:')

  assert.ok(schemaIndex >= 0 && varsIndex >= 0 && historyIndex >= 0)
  assert.ok(schemaIndex < varsIndex, 'the static schema block must come before the dynamic varsNote')
  assert.ok(varsIndex < historyIndex, 'varsNote must come before history, both after the static prefix')
  const closingReminderIndex = prompt.lastIndexOf('Respond with ONLY the JSON object')
  assert.ok(closingReminderIndex > historyIndex, 'the closing format reminder must be the last thing in the prompt')
})

test('buildApiActionPrompt tells the model to declare goal-unreachable honestly instead of guessing a plausible field name', () => {
  // Regression test: found via real live testing that the model asserted a
  // plausible-but-nonexistent JSON field ($.realname) instead of admitting
  // the real target field wasn't present — unconditional instruction, so it
  // must appear regardless of safety mode or saved variables.
  const prompt = buildApiActionPrompt('goal', [], new Set(), READ_ONLY)
  assert.ok(prompt.includes('goal-unreachable" honestly'))
  assert.ok(prompt.includes('never guess a field/path name'))
})

test('buildApiActionPrompt lists currently-saved variable names, only when there are any', () => {
  const withVars = buildApiActionPrompt('goal', [], new Set(['userId', 'token']), READ_ONLY)
  assert.ok(withVars.includes('userId'))
  assert.ok(withVars.includes('token'))

  const noVars = buildApiActionPrompt('goal', [], new Set(), READ_ONLY)
  assert.ok(!noVars.includes('Values saved so far'))
})

test('buildApiActionPrompt always discloses the assertion requirement upfront, unconditionally, regardless of the goal\'s own wording', () => {
  // Mirrors planner.ts's identical buildActionPrompt test — added at the
  // same time, for the same live-found reason (a goal with zero confirm/
  // verify language used to get zero forced verification at all, since
  // apiRunner.ts's requiredConfirmationCount used to be plain
  // countConfirmationClauses(goal), which is 0 for such a goal). This
  // function previously had no confirmationNote at all, despite an old doc
  // comment incorrectly claiming it did.
  const plainGoal = buildApiActionPrompt('create a widget', [], new Set(), READ_ONLY)
  assert.ok(plainGoal.includes('at least 1 successful'), 'the note must appear even when the goal has no confirm/verify wording at all')
  assert.ok(plainGoal.includes('assert_status, assert_json_path_exists, or assert_json_path_equals'))

  const twoConfirmClauses = buildApiActionPrompt('confirm the item exists, create it, then confirm it is retrievable', [], new Set(), READ_ONLY)
  assert.ok(twoConfirmClauses.includes('at least 2 successful'), 'a compound goal with two confirm-clauses must require 2, not just 1')
})

test('buildApiActionPrompt warns against asserting an unrelated/incidental response that would look the same regardless of whether the real action succeeded', () => {
  // API-engine mirror of planner.ts's identical guard — see its own test's
  // doc comment for the live-found browser-engine analog of this exact gap.
  const prompt = buildApiActionPrompt('create a widget', [], new Set(), READ_ONLY)
  assert.ok(prompt.includes('health-check-style endpoint'))
  assert.ok(prompt.includes('the request that actually reflects the goal\'s own outcome'))
})

test('parseApiAction parses a real request action with saveAs', () => {
  const raw = JSON.stringify({
    action: 'request',
    method: 'get',
    url: 'http://localhost:1/items',
    saveAs: { name: 'firstId', path: 'items[0].id' },
    reason: 'list items',
  })
  const result = parseApiAction(raw, new Set(), READ_ONLY)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.action.action, 'request')
    if (result.action.action === 'request') {
      assert.equal(result.action.method, 'GET', 'method should be normalized to uppercase')
      assert.deepEqual(result.action.saveAs, { name: 'firstId', path: 'items[0].id' })
    }
  }
})

test('parseApiAction rejects a disallowed method at parse time, the same way an invalid ref is rejected elsewhere', () => {
  const raw = JSON.stringify({ action: 'request', method: 'POST', url: 'http://localhost:1/items', reason: 'try to write' })
  const result = parseApiAction(raw, new Set(), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not allowed this run/)
})

test('parseApiAction rejects DELETE when allowWrites is set but allowDeletes is not', () => {
  const writesOnly: SafetyMode = { ...READ_ONLY, allowWrites: true }
  const raw = JSON.stringify({ action: 'request', method: 'DELETE', url: 'http://localhost:1/items/1', reason: 'try to delete' })
  const result = parseApiAction(raw, new Set(), writesOnly)
  assert.equal(result.ok, false)
})

test('parseApiAction rejects a POST carrying an X-HTTP-Method-Override: DELETE header when allowDeletes is not set, even though POST alone would be allowed', () => {
  // Real, live-found gap: a model blocked from DELETE tried exactly this
  // technique against a real target — see apiTypes.ts's effectiveMethod
  // doc comment for the full reasoning and the confirmed-real-world
  // frameworks that honor this convention server-side.
  const writesOnly: SafetyMode = { ...READ_ONLY, allowWrites: true }
  const raw = JSON.stringify({
    action: 'request',
    method: 'POST',
    url: 'http://localhost:1/items/1',
    headers: { 'X-HTTP-Method-Override': 'DELETE' },
    reason: 'try to delete via a POST override',
  })
  const result = parseApiAction(raw, new Set(), writesOnly)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /effectively DELETE via a method-override/)
})

test('parseApiAction rejects a POST carrying a _method=DELETE query parameter under the same rule', () => {
  const writesOnly: SafetyMode = { ...READ_ONLY, allowWrites: true }
  const raw = JSON.stringify({ action: 'request', method: 'POST', url: 'http://localhost:1/items/1?_method=DELETE', reason: 'try to delete via a query param override' })
  const result = parseApiAction(raw, new Set(), writesOnly)
  assert.equal(result.ok, false)
})

test('parseApiAction still allows an ordinary POST that merely happens to carry an unrelated header, unaffected by the override check', () => {
  const writesOnly: SafetyMode = { ...READ_ONLY, allowWrites: true }
  const raw = JSON.stringify({ action: 'request', method: 'POST', url: 'http://localhost:1/items', headers: { 'Content-Type': 'application/json' }, reason: 'ordinary create' })
  const result = parseApiAction(raw, new Set(), writesOnly)
  assert.equal(result.ok, true)
})

test('parseApiAction rejects a request to a host that is not the target origin or allowlisted', () => {
  const raw = JSON.stringify({ action: 'request', method: 'GET', url: 'http://evil.example.com/steal', reason: 'wander off' })
  const result = parseApiAction(raw, new Set(), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not the target origin/)
})

test('parseApiAction rejects a request referencing an unsaved {{var}}, the same way a hallucinated ref is rejected', () => {
  const raw = JSON.stringify({ action: 'request', method: 'GET', url: 'http://localhost:1/items/{{typo}}', reason: 'use a var' })
  const result = parseApiAction(raw, new Set(['realVar']), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /typo.*hasn't been saved/)
})

test('parseApiAction accepts a request referencing a var that actually was saved', () => {
  const raw = JSON.stringify({ action: 'request', method: 'GET', url: 'http://localhost:1/items/{{itemId}}', reason: 'use a var' })
  const result = parseApiAction(raw, new Set(['itemId']), READ_ONLY)
  assert.ok(result.ok)
})

test('parseApiAction parses assert_status/assert_json_path_exists/assert_json_path_equals/done', () => {
  const status = parseApiAction(JSON.stringify({ action: 'assert_status', expected: 200, reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(status.ok)

  const exists = parseApiAction(JSON.stringify({ action: 'assert_json_path_exists', path: 'id', reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(exists.ok)

  const equals = parseApiAction(JSON.stringify({ action: 'assert_json_path_equals', path: 'name', expected: 'Ada', reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(equals.ok)

  const done = parseApiAction(JSON.stringify({ action: 'done', outcome: 'goal-reached', reason: 'x' }), new Set(), READ_ONLY)
  assert.ok(done.ok)
})

test('parseApiAction fails honestly on invalid JSON, never guessing an action', () => {
  const result = parseApiAction('not json', new Set(), READ_ONLY)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not valid JSON/)
})

test('parseApiAction rejects an unrecognized method string outright', () => {
  const raw = JSON.stringify({ action: 'request', method: 'TRACE', url: 'http://localhost:1/x', reason: 'x' })
  const result = parseApiAction(raw, new Set(), WRITES_AND_DELETES)
  assert.equal(result.ok, false)
})

test('buildApiPlanPrompt includes the goal, the safety disclosure, and the plan JSON schema', () => {
  const prompt = buildApiPlanPrompt('goal', READ_ONLY)
  assert.ok(prompt.includes('goal'))
  assert.ok(prompt.includes('Allowed methods this run:'))
  assert.ok(prompt.includes('"steps"'))
  assert.ok(prompt.includes('saveAs'))
})

test('buildApiPlanPrompt warns against declaring goal-unreachable from assumption alone, since a plan is made before any real request has been sent', () => {
  // Real, live-found gap: rerunning the same CRUD goal against
  // jsonplaceholder produced a 1-step plan (an immediate "goal-unreachable"
  // done, never a single real request attempted) in 8.8s, while the live
  // per-step adaptive loop for the identical goal made real progress (a
  // real POST + GET) before reaching the same eventual conclusion. The
  // model had strong training-data priors about this well-known fake API
  // and short-circuited on them instead of trying — this guidance is the
  // fix, grounding "unreachable" in "no response exists yet," not opinion.
  const prompt = buildApiPlanPrompt('goal', READ_ONLY)
  assert.ok(prompt.includes('no real response yet'))
  assert.ok(prompt.includes('a guess made now'))
})

test('buildApiPlanPrompt grounds the plan in caller-supplied steps when given, instead of asking the model to invent its own sequence', () => {
  const prompt = buildApiPlanPrompt('goal', READ_ONLY, undefined, [
    { type: 'action', description: 'POST /users with a valid body' },
    { type: 'assertion', description: 'The response status is 201' },
  ])
  assert.ok(prompt.includes('caller has already worked out the steps below'))
  assert.ok(prompt.includes('1. [action] POST /users with a valid body'))
  assert.ok(prompt.includes('2. [assertion] The response status is 201'))
  assert.ok(prompt.includes('"steps"'))
})

test('buildApiPlanPrompt asks the model to invent its own sequence when no caller steps are given, same as before this option existed', () => {
  const prompt = buildApiPlanPrompt('goal', READ_ONLY)
  assert.ok(prompt.includes('plan out the whole sequence of steps needed'))
  assert.ok(!prompt.includes('caller has already worked out'))
})

test('parseApiPlan strictly parses a real, well-formed plan response, including a forward {{var}} reference', () => {
  // A later step referencing a value an EARLIER step in the same plan will
  // save is legitimate at plan-parse time — only unresolved at the point a
  // step actually executes (see apiRunner.ts's fast path), never here.
  const raw = JSON.stringify({
    steps: [
      { action: 'request', method: 'post', url: '/users', body: '{}', saveAs: { name: 'userId', path: 'id' }, reason: 'create' },
      { action: 'request', method: 'GET', url: '/users/{{userId}}', reason: 'fetch it back' },
      { action: 'assert_status', expected: 200, reason: 'ok' },
      { action: 'assert_json_path_exists', path: 'name', reason: 'has a name' },
      { action: 'assert_json_path_equals', path: 'name', expected: 'Ada', reason: 'name matches' },
      { action: 'done', outcome: 'goal-reached', reason: 'confirmed' },
    ],
  })
  const result = parseApiPlan(raw)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.plan.steps.length, 6)
  assert.equal(result.plan.steps[0].action, 'request')
  if (result.plan.steps[0].action === 'request') {
    assert.equal(result.plan.steps[0].method, 'POST', 'method should be normalized to uppercase, same as parseApiAction')
  }
  assert.equal(result.plan.steps[5].action, 'done')
})

test('parseApiPlan strips a markdown json fence, the same accommodation parseApiAction already makes', () => {
  const raw =
    '```json\n' +
    JSON.stringify({ steps: [{ action: 'request', method: 'GET', url: 'https://example.com/items', reason: 'list' }, { action: 'done', outcome: 'goal-reached', reason: 'r' }] }) +
    '\n```'
  assert.equal(parseApiPlan(raw).ok, true)
})

test('parseApiPlan fails honestly, never guessing, on invalid JSON', () => {
  assert.equal(parseApiPlan('not json').ok, false)
})

test('parseApiPlan fails honestly when the response is not a {"steps": [...]} object', () => {
  assert.equal(parseApiPlan(JSON.stringify({ notSteps: [] })).ok, false)
})

test('parseApiPlan fails honestly on an empty steps array', () => {
  assert.equal(parseApiPlan(JSON.stringify({ steps: [] })).ok, false)
})

test('parseApiPlan rejects a plan whose only step is an immediate "done", for either outcome, since no real request was ever attempted', () => {
  // Real, live-repeated failure this fixes — see this function's own doc
  // comment and planner.ts's parsePlan (mirrored exactly).
  const unreachable = parseApiPlan(JSON.stringify({ steps: [{ action: 'done', outcome: 'goal-unreachable', reason: 'assumed this API does not persist writes' }] }))
  assert.equal(unreachable.ok, false)
  if (!unreachable.ok) assert.match(unreachable.error, /no real action ever attempted/)

  const reached = parseApiPlan(JSON.stringify({ steps: [{ action: 'done', outcome: 'goal-reached', reason: 'assumed already satisfied' }] }))
  assert.equal(reached.ok, false)
})

test('parseApiPlan accepts a plan with a real request before its trailing "done" step — unaffected by the immediate-done rejection', () => {
  const raw = JSON.stringify({
    steps: [
      { action: 'request', method: 'GET', url: 'https://example.com/items', reason: 'list items' },
      { action: 'done', outcome: 'goal-reached', reason: 'confirmed' },
    ],
  })
  const result = parseApiPlan(raw)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.plan.steps.length, 2)
})

test('parseApiPlan fails honestly when any single step is malformed', () => {
  const raw = JSON.stringify({ steps: [{ action: 'done', outcome: 'goal-reached', reason: 'r' }, { action: 'request', reason: 'missing method/url' }] })
  assert.equal(parseApiPlan(raw).ok, false)
})

test('parseApiPlan does NOT reject a disallowed method or an unresolved {{var}} — those are execution-time concerns, not parse-time ones', () => {
  // Deliberately different from parseApiAction: a plan step's safety/var
  // validity can only be judged once it's actually about to execute (see
  // apiRunner.ts's fast path), not at plan-parse time.
  const raw = JSON.stringify({
    steps: [{ action: 'request', method: 'DELETE', url: '/items/{{neverSaved}}', reason: 'r' }],
  })
  const result = parseApiPlan(raw)
  assert.equal(result.ok, true)
})

test('checkVarReferences is exported and usable independently, for apiRunner.ts\'s fast path to reuse', () => {
  assert.equal(checkVarReferences(['/items/{{itemId}}'], new Set(['itemId'])), undefined)
  assert.match(checkVarReferences(['/items/{{missing}}'], new Set())!, /missing.*hasn't been saved/)
})
