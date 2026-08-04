import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithConcurrency } from './concurrencyPool'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('runWithConcurrency runs every task and returns results in input order, regardless of finish order', async () => {
  const tasks = [
    async () => {
      await delay(30)
      return 'a'
    },
    async () => {
      await delay(5)
      return 'b'
    },
    async () => {
      await delay(15)
      return 'c'
    },
  ]
  const results = await runWithConcurrency(tasks, 3)
  assert.deepEqual(results, ['a', 'b', 'c'])
})

test('runWithConcurrency never exceeds the configured concurrency limit', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const tasks = Array.from({ length: 8 }, (_, i) => async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await delay(10)
    inFlight--
    return i
  })
  const results = await runWithConcurrency(tasks, 3)
  assert.ok(maxInFlight <= 3, `expected at most 3 in flight, saw ${maxInFlight}`)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7])
})

test('runWithConcurrency handles an empty task list', async () => {
  const results = await runWithConcurrency([], 3)
  assert.deepEqual(results, [])
})

test('runWithConcurrency handles concurrency greater than the number of tasks', async () => {
  const results = await runWithConcurrency([async () => 1, async () => 2], 5)
  assert.deepEqual(results, [1, 2])
})

test('runWithConcurrency propagates a task rejection', async () => {
  const tasks = [async () => 1, async () => { throw new Error('boom') }, async () => 3]
  await assert.rejects(() => runWithConcurrency(tasks, 2), /boom/)
})
