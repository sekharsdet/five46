import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getLlmProvider } from '../llm/registry'
import { resolveCredentials } from '../config/resolve'
import { runAgent } from '../agent/runner'
import { generateAgentSpec } from '../agent/generateSpec'
import { runGeneratedBrowserSpec } from '../agent/specExecutor'
import { AgentBrowserUnavailableError } from '../agent/browser'
import type { LoginCredentials } from '../agent/browser'
import { EVAL_CASES } from './cases'
import type { EvalCase } from './cases'

/** Maps a case's fixture credentials onto the env vars a generated spec's
 * credential placeholders read from (`generateSpec.ts`'s
 * `renderCredentialAwareExpression`) — the only thing `runGeneratedBrowserSpec`
 * needs beyond the spec file itself to run a login-flow case standalone. */
export function credentialEnvFor(credentials: LoginCredentials | undefined): Record<string, string> | undefined {
  if (!credentials) return undefined
  const env: Record<string, string> = {}
  if (credentials.username) env.FIVE46_LOGIN_USERNAME = credentials.username
  if (credentials.password) env.FIVE46_LOGIN_PASSWORD = credentials.password
  return env
}

/** The standing answer to "we keep discovering the same category of gap on
 * every new site, one live-testing session at a time" — a persistent,
 * checked-in, re-runnable corpus of real interaction patterns (see
 * `cases.ts`'s own doc comment), driven through the exact same `runAgent()`
 * every live `five46 test` invocation uses, never a separate/parallel
 * implementation. Every real gap found from here forward gets added to
 * `EVAL_CASES` as a new case — once added, it can never quietly regress
 * again and never needs re-discovering by hand.
 *
 * Deliberately NOT part of `npm test` — these cases hit real public sites
 * and spend real BYOK budget on every run, the same reason `browser.test.ts`
 * only ever talks to local fixtures. Run explicitly via `npm run eval`. */
async function main(): Promise<void> {
  const { llmProvider, llmApiKey } = resolveCredentials()
  if (!llmApiKey) {
    console.error('five46 eval requires an LLM API key — run `five46 config` or set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY.')
    process.exitCode = 1
    return
  }
  const provider = getLlmProvider(llmProvider || 'openai', (info) =>
    console.log(`  (transient error, retrying attempt ${info.attempt + 1}/${info.maxAttempts} in ${info.delayMs}ms)`)
  )

  const results: { name: string; ok: boolean; outcome: string; detail?: string; specSurvived?: boolean }[] = []

  for (const evalCase of EVAL_CASES) {
    process.stdout.write(`${evalCase.name} ... `)
    const artifactDir = mkdtempSync(join(tmpdir(), 'five46-eval-'))
    let target: { url: string; close?: () => Promise<void> }
    try {
      target = evalCase.target.kind === 'url' ? { url: evalCase.target.url } : await evalCase.target.start()
    } catch (err) {
      console.log('SKIP (fixture failed to start)')
      results.push({ name: evalCase.name, ok: false, outcome: 'fixture-start-failed', detail: err instanceof Error ? err.message : String(err) })
      rmSync(artifactDir, { recursive: true, force: true })
      continue
    }
    try {
      const run = await runAgent({
        url: target.url,
        goal: evalCase.goal,
        provider,
        apiKey: llmApiKey,
        maxSteps: evalCase.maxSteps,
        headless: true,
        artifactDir,
        credentials: evalCase.credentials,
      })
      const expected = evalCase.expectedOutcome ?? 'goal-reached'
      const ok = run.outcome === expected
      console.log(ok ? 'PASS' : `FAIL (${run.outcome}, expected ${expected})`)

      // Only meaningful when the goal was actually supposed to (and did)
      // succeed — nothing to "survive a clean rerun" for a case whose whole
      // point is proving goal-unreachable is the honest outcome.
      let specSurvived: boolean | undefined
      if (ok && expected === 'goal-reached') {
        try {
          // runGeneratedBrowserSpec makes its own project-rooted scratch
          // copy internally, so writing this into artifactDir (an OS temp
          // dir) is fine — see its own doc comment.
          const specPath = join(artifactDir, 'generated.spec.ts')
          writeFileSync(specPath, generateAgentSpec(run), 'utf8')
          process.stdout.write('  verifying the generated spec survives a clean rerun ... ')
          const verifyResult = await runGeneratedBrowserSpec(specPath, { extraEnv: credentialEnvFor(evalCase.credentials) })
          specSurvived = verifyResult.passed
          console.log(specSurvived ? 'PASS' : 'FAIL')
        } catch (err) {
          if (!(err instanceof AgentBrowserUnavailableError)) throw err
          console.log(`SKIP (${err.message})`)
        }
      }

      results.push({ name: evalCase.name, ok, outcome: run.outcome, specSurvived })
    } catch (err) {
      console.log('ERROR')
      results.push({ name: evalCase.name, ok: false, outcome: 'threw', detail: err instanceof Error ? err.message : String(err) })
    } finally {
      await target.close?.().catch(() => {})
      rmSync(artifactDir, { recursive: true, force: true })
    }
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} passed`)

  const eligibleForSurvival = results.filter((r) => r.specSurvived !== undefined)
  const survived = eligibleForSurvival.filter((r) => r.specSurvived).length
  if (eligibleForSurvival.length > 0) {
    console.log(`${survived}/${eligibleForSurvival.length} generated specs verified to actually pass when re-run standalone`)
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.log('\nFailures:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.outcome}${f.detail ? ` (${f.detail})` : ''}`)
    process.exitCode = 1
  }

  const nonSurviving = eligibleForSurvival.filter((r) => !r.specSurvived)
  if (nonSurviving.length > 0) {
    console.log('\nGenerated specs that did NOT survive a clean rerun:')
    for (const f of nonSurviving) console.log(`  - ${f.name}`)
    process.exitCode = 1
  }
}

function isRunningDirectly(): boolean {
  return require.main === module
}

if (isRunningDirectly()) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}

export { main as runEval }
export type { EvalCase }
