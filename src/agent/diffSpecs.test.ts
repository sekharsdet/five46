import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLineDiff, normalizeRunHeader, diffSpecFiles, formatDiff } from './diffSpecs'

test('computeLineDiff returns all-context lines for identical input', () => {
  const lines = ['a', 'b', 'c']
  const diff = computeLineDiff(lines, lines)
  assert.deepEqual(
    diff,
    lines.map((text) => ({ type: 'context', text }))
  )
})

test('computeLineDiff reports a single changed line as a remove+add pair', () => {
  const diff = computeLineDiff(['a', 'b', 'c'], ['a', 'x', 'c'])
  assert.deepEqual(diff, [
    { type: 'context', text: 'a' },
    { type: 'remove', text: 'b' },
    { type: 'add', text: 'x' },
    { type: 'context', text: 'c' },
  ])
})

test('computeLineDiff reports an added line with no corresponding removal', () => {
  const diff = computeLineDiff(['a', 'b'], ['a', 'new', 'b'])
  assert.deepEqual(diff, [
    { type: 'context', text: 'a' },
    { type: 'add', text: 'new' },
    { type: 'context', text: 'b' },
  ])
})

test('computeLineDiff reports a removed line with nothing added in its place', () => {
  const diff = computeLineDiff(['a', 'gone', 'b'], ['a', 'b'])
  assert.deepEqual(diff, [
    { type: 'context', text: 'a' },
    { type: 'remove', text: 'gone' },
    { type: 'context', text: 'b' },
  ])
})

test('normalizeRunHeader replaces only the run-id token, leaving the outcome visible', () => {
  const content = '// Run abc123 — outcome: goal-reached'
  assert.equal(normalizeRunHeader(content), '// Run <run-id> — outcome: goal-reached')
})

test('normalizeRunHeader is a no-op on text that does not match the header shape', () => {
  const content = 'some ordinary line\nanother line'
  assert.equal(normalizeRunHeader(content), content)
})

test('diffSpecFiles treats two runs differing only by run-id as identical', () => {
  const a = ['// Goal: log in', '// Run abc111 — outcome: goal-reached', 'test body'].join('\n')
  const b = ['// Goal: log in', '// Run zzz999 — outcome: goal-reached', 'test body'].join('\n')
  const diff = diffSpecFiles(a, b)
  assert.ok(
    diff.every((line) => line.type === 'context'),
    'run-id-only difference must not surface as a real diff'
  )
})

test('diffSpecFiles still surfaces a real difference in outcome, not just the run-id token', () => {
  // Regression test for the "normalize the token, don't drop the whole
  // line" decision — --repeat's flaky detection depends on an outcome
  // change being a visible diff even though the run-id always differs too.
  const a = ['// Goal: log in', '// Run abc111 — outcome: goal-reached', 'test body'].join('\n')
  const b = ['// Goal: log in', '// Run zzz999 — outcome: assertion-failed', 'test body'].join('\n')
  const diff = diffSpecFiles(a, b)
  assert.ok(
    diff.some((line) => line.type === 'remove' && line.text.includes('goal-reached')),
    'expected the goal-reached outcome line to show as removed'
  )
  assert.ok(
    diff.some((line) => line.type === 'add' && line.text.includes('assertion-failed')),
    'expected the assertion-failed outcome line to show as added'
  )
})

test('formatDiff prefixes context/add/remove lines with space/+/-', () => {
  const formatted = formatDiff([
    { type: 'context', text: 'same' },
    { type: 'remove', text: 'old' },
    { type: 'add', text: 'new' },
  ])
  assert.equal(formatted, '  same\n- old\n+ new')
})
