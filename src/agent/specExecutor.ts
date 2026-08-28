import { execFile } from 'child_process'
import { promisify } from 'util'
import { dirname, join } from 'path'
import { AgentBrowserUnavailableError } from './browser'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 120_000

export interface SpecExecutionResult {
  passed: boolean
  output: string
}

function resultFromExecError(err: unknown): SpecExecutionResult {
  const e = err as { stdout?: string; stderr?: string; message?: string }
  const output = (e.stdout ?? '') + (e.stderr ?? '')
  return { passed: false, output: output || e.message || String(err) }
}

/** Runs an already-written generated API spec (`node:test` + `node:assert/strict`)
 * exactly as a real user's shell would, and reports pass/fail — never throws.
 * Promotes `generateApiSpec.test.ts`'s own execution pattern to production. */
export async function runGeneratedApiSpec(specPath: string, opts?: { timeoutMs?: number }): Promise<SpecExecutionResult> {
  const env = { ...process.env }
  // Inherited from whatever process launched five46 itself; if unset (the
  // normal case for a real user's shell) this is a no-op. Only matters when
  // five46's own test suite calls this function from inside `node --test`,
  // which would otherwise make Node treat the generated script as a nested
  // run and silently skip it.
  delete env.NODE_TEST_CONTEXT
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--test', specPath], { env, timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS })
    return { passed: true, output: stdout + stderr }
  } catch (err) {
    return resultFromExecError(err)
  }
}

/** Lazily resolved the same way `browser.ts`'s `requireYaml()` resolves its
 * own optional dependency — `@playwright/test` (the test-runner CLI) is a
 * distinct optional dep from the plain `playwright` package used to drive
 * the live agent, and pure API testing never needs either. */
function requirePlaywrightTestCli(): string {
  try {
    const pkgPath = require.resolve('@playwright/test/package.json')
    return join(dirname(pkgPath), 'cli.js')
  } catch {
    throw new AgentBrowserUnavailableError(
      'Verifying a generated browser spec needs the optional @playwright/test dependency (installed alongside playwright) — install it with: npm install --save-dev @playwright/test'
    )
  }
}

/** Runs an already-written generated browser spec under the real Playwright
 * test runner and reports pass/fail — never throws except
 * `AgentBrowserUnavailableError` when `@playwright/test` itself isn't
 * installed (mirrors every other optional-dependency check in this
 * codebase, so callers already know how to catch and print it). Shells out
 * to `@playwright/test/cli.js` directly rather than `npx playwright test`
 * — `npx` resolves to `npx.cmd` on Windows, which needs `shell: true` and
 * an extra registry-resolution step this avoids entirely. */
export async function runGeneratedBrowserSpec(specPath: string, opts?: { extraEnv?: Record<string, string>; timeoutMs?: number }): Promise<SpecExecutionResult> {
  const cliPath = requirePlaywrightTestCli()
  const env = { ...process.env, ...opts?.extraEnv }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, 'test', specPath, '--reporter=line'], {
      env,
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    return { passed: true, output: stdout + stderr }
  } catch (err) {
    return resultFromExecError(err)
  }
}
