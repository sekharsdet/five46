import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGeneratedApiSpec, runGeneratedBrowserSpec } from './specExecutor'

function playwrightTestAvailable(): boolean {
  try {
    require.resolve('@playwright/test/package.json')
    return true
  } catch {
    return false
  }
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body, 'utf8')
  return path
}

test('runGeneratedApiSpec resolves passed:true for a script whose assertions all succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-specexec-test-'))
  try {
    const specPath = writeScript(
      dir,
      'good.test.mjs',
      `
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('ok', () => { assert.equal(1, 1) })
`
    )
    const result = await runGeneratedApiSpec(specPath)
    assert.equal(result.passed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGeneratedApiSpec resolves passed:false (never throws) for a script whose assertions fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-specexec-test-'))
  try {
    const specPath = writeScript(
      dir,
      'bad.test.mjs',
      `
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('bad', () => { assert.equal(1, 2) })
`
    )
    const result = await runGeneratedApiSpec(specPath)
    assert.equal(result.passed, false)
    assert.ok(result.output.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Regression coverage for a real bug found in review: `@playwright/test`'s
// CLI reports a bare "No tests found" (never an error a caller could tell
// apart from a genuine failure) for a spec file placed anywhere outside a
// project's own directory tree — confirmed directly against the installed
// CLI — and separately fails to resolve the spec's own
// `import ... from '@playwright/test'` for the same reason. Both are
// exercised here by deliberately placing specPath under os.tmpdir(), the
// same way a scratch/mutated spec is written in practice.
test('runGeneratedBrowserSpec resolves passed:true for a spec outside the project tree whose assertions all succeed', async (t) => {
  if (!playwrightTestAvailable()) {
    t.skip('@playwright/test unavailable in this environment')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'five46-specexec-browser-test-'))
  try {
    const specPath = writeScript(
      dir,
      'good.spec.ts',
      `
import { test, expect } from '@playwright/test'
test('ok', async () => { expect(1).toBe(1) })
`
    )
    const result = await runGeneratedBrowserSpec(specPath)
    assert.equal(result.passed, true, result.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGeneratedBrowserSpec resolves passed:false (never throws) for a spec outside the project tree whose assertions fail', async (t) => {
  if (!playwrightTestAvailable()) {
    t.skip('@playwright/test unavailable in this environment')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'five46-specexec-browser-test-'))
  try {
    const specPath = writeScript(
      dir,
      'bad.spec.ts',
      `
import { test, expect } from '@playwright/test'
test('bad', async () => { expect(1).toBe(2) })
`
    )
    const result = await runGeneratedBrowserSpec(specPath)
    assert.equal(result.passed, false)
    assert.ok(result.output.length > 0)
    assert.ok(!/No tests found/.test(result.output), `must actually execute the mutated assertion, not silently fail discovery:\n${result.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
