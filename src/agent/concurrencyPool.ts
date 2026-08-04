/** Runs `tasks` (each a thunk producing a promise) with at most
 * `concurrency` in flight at once, starting the next queued task as soon as
 * a slot frees up. Results are returned in the same order as `tasks`
 * (matching `Promise.all`'s own contract) regardless of which finishes
 * first. No new npm dependency — matches this project's "zero new deps for
 * any CLI feature so far" record; a plain worker-pool over a shared index
 * counter is all bounded concurrency actually requires here. Used by
 * story mode (`--story`/`--concurrency`, cli.ts) to run several independent,
 * split-out goals faster than `--repeat`'s deliberate strict sequencing,
 * without letting every goal's live LLM calls/browser instances fire at
 * once (a real rate-limit/resource-exhaustion risk `--repeat` avoids by
 * being sequential and this needs a middle ground for instead). */
export async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      results[i] = await tasks[i]()
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
