import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRepeatResults } from './flaky'

const spec = (runId: string, outcome: string, body: string) =>
  ['// Goal: g', `// Run ${runId} — outcome: ${outcome}`, body].join('\n')

test('classifyRepeatResults is not flaky when all iterations reach goal-reached with identical bodies', () => {
  const result = classifyRepeatResults([
    { iteration: 1, outcome: 'goal-reached', specBody: spec('a1', 'goal-reached', 'await page.locator("x").click()') },
    { iteration: 2, outcome: 'goal-reached', specBody: spec('a2', 'goal-reached', 'await page.locator("x").click()') },
  ])
  assert.equal(result.allGoalReached, true)
  assert.equal(result.identicalBodies, true)
  assert.equal(result.flaky, false)
  assert.deepEqual(result.differingIterations, [])
})

test('classifyRepeatResults is flaky when outcomes differ across iterations, even with "identical" bodies', () => {
  const result = classifyRepeatResults([
    { iteration: 1, outcome: 'goal-reached', specBody: spec('a1', 'goal-reached', 'body') },
    { iteration: 2, outcome: 'assertion-failed', specBody: spec('a2', 'assertion-failed', 'body') },
  ])
  assert.equal(result.allGoalReached, false)
  assert.equal(result.flaky, true)
  // The outcome line itself differs, so the body-diff correctly picks it up too.
  assert.deepEqual(result.differingIterations, [2])
})

test('classifyRepeatResults is flaky when outcomes all match but the agent took a different real path', () => {
  const result = classifyRepeatResults([
    { iteration: 1, outcome: 'goal-reached', specBody: spec('a1', 'goal-reached', 'await page.locator("x").click()') },
    { iteration: 2, outcome: 'goal-reached', specBody: spec('a2', 'goal-reached', 'await page.locator("y").click()') },
  ])
  assert.equal(result.allGoalReached, true)
  assert.equal(result.identicalBodies, false)
  assert.equal(result.flaky, true)
  assert.deepEqual(result.differingIterations, [2])
})

test('classifyRepeatResults names every differing iteration, not just the first', () => {
  const result = classifyRepeatResults([
    { iteration: 1, outcome: 'goal-reached', specBody: spec('a1', 'goal-reached', 'await page.locator("x").click()') },
    { iteration: 2, outcome: 'goal-reached', specBody: spec('a2', 'goal-reached', 'await page.locator("x").click()') },
    { iteration: 3, outcome: 'goal-reached', specBody: spec('a3', 'goal-reached', 'await page.locator("z").click()') },
  ])
  assert.equal(result.flaky, true)
  assert.deepEqual(result.differingIterations, [3])
})

test('classifyRepeatResults handles a single-result batch as vacuously non-flaky', () => {
  const result = classifyRepeatResults([{ iteration: 1, outcome: 'goal-reached', specBody: spec('a1', 'goal-reached', 'body') }])
  assert.equal(result.allGoalReached, true)
  assert.equal(result.identicalBodies, true)
  assert.equal(result.flaky, false)
})
