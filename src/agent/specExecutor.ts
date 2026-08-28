import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, rmSync, copyFileSync } from 'fs'
import { dirname, join, resolve, basename } from 'path'
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
 * Promotes `generateApiSpec.test.ts`'s own execution pattern to production.
 * Unlike `runGeneratedBrowserSpec` below, `specPath` can live anywhere: the
 * generated script only ever imports Node builtins (`node:test`,
 * `node:assert/strict`) plus native `fetch`, so there's no third-party
 * package for Node to fail to resolve regardless of where the file sits. */
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
function resolvePlaywrightTestPackageJson(): string {
  try {
    return require.resolve('@playwright/test/package.json')
  } catch {
    throw new AgentBrowserUnavailableError(
      'Verifying a generated browser spec needs the optional @playwright/test dependency (installed alongside playwright) — install it with: npm install --save-dev @playwright/test'
    )
  }
}

function requirePlaywrightTestCli(): string {
  return join(dirname(resolvePlaywrightTestPackageJson()), 'cli.js')
}

/** The project root whose `node_modules` resolves `@playwright/test` —
 * derived from where that package actually resolved, never from
 * `process.cwd()` (which may not be the right project at all when five46
 * is invoked as an MCP server, or in a test harness). A generated spec's
 * own `import ... from '@playwright/test'` is resolved by Node from the
 * spec file's *own location* upward, so a spec run from anywhere outside
 * this tree can never resolve that import — see `runGeneratedBrowserSpec`'s
 * own doc comment for how this is used to make execution work regardless
 * of where the caller's `specPath` actually lives. */
function resolvePlaywrightProjectRoot(): string {
  return resolve(dirname(resolvePlaywrightTestPackageJson()), '..', '..', '..')
}

/** Runs an already-written generated browser spec under the real Playwright
 * test runner and reports pass/fail — never throws except
 * `AgentBrowserUnavailableError` when `@playwright/test` itself isn't
 * installed (mirrors every other optional-dependency check in this
 * codebase, so callers already know how to catch and print it).
 *
 * Unlike the API counterpart above, `specPath` cannot simply be executed
 * in place: (a) Playwright's own config/testDir discovery walks up from
 * the *invoking process's cwd*, not from `specPath`, so a spec outside
 * whatever that resolves to reports a bare "No tests found" instead of
 * actually running; (b) the spec's own `import ... from '@playwright/test'`
 * is resolved by Node from the spec file's location upward, so a spec
 * outside a project's `node_modules` tree (an OS temp dir, in particular)
 * can never resolve that import at all. Both were confirmed directly
 * against the installed CLI, not assumed. So this always makes its own
 * short-lived copy of `specPath`'s contents inside a scratch directory
 * under `resolvePlaywrightProjectRoot()` (which is guaranteed to resolve
 * `@playwright/test`), points `--config` at that same scratch directory,
 * and cleans it up afterward — callers never need to think about where
 * `specPath` itself lives. Shells out to `@playwright/test/cli.js`
 * directly rather than `npx playwright test` — `npx` resolves to
 * `npx.cmd` on Windows, which needs `shell: true` and an extra
 * registry-resolution step this avoids entirely.
 *
 * Disclosed tradeoff: running from a scratch config bypasses any real
 * `playwright.config.ts` a target project has (browser channel, viewport,
 * custom fixtures) in favor of Playwright's stock defaults for this one
 * verification run — acceptable because generated specs are already fully
 * self-contained (absolute target URLs, no `baseURL`/fixture dependency),
 * so config-driven behavior was never part of what's being verified here.
 * The scratch copy does not change the *running process's* cwd, so a
 * relative `filePath` embedded in an `upload` step (see `types.ts`'s
 * `upload` action) still resolves exactly as it would have from `specPath`'s
 * original location. */
export async function runGeneratedBrowserSpec(specPath: string, opts?: { extraEnv?: Record<string, string>; timeoutMs?: number }): Promise<SpecExecutionResult> {
  const cliPath = requirePlaywrightTestCli()
  const scratchDir = mkdtempSync(join(resolvePlaywrightProjectRoot(), 'five46-spec-exec-'))
  try {
    copyFileSync(specPath, join(scratchDir, basename(specPath)))
    const env = { ...process.env, ...opts?.extraEnv }
    // Deliberately no explicit file argument — passing the scratch copy's
    // own absolute path here reports a bare "No tests found" on Windows:
    // Playwright treats a positional argument as a regex matched against
    // already-discovered files, and an absolute Windows path's backslashes
    // get misinterpreted as regex escapes (confirmed directly). Since
    // `scratchDir` holds exactly the one file this call just copied in,
    // `--config`'s own default testDir discovery finds it unambiguously
    // with no match pattern needed at all.
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, 'test', '--config', scratchDir, '--reporter=line'], {
      env,
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    return { passed: true, output: stdout + stderr }
  } catch (err) {
    return resultFromExecError(err)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}
