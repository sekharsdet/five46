import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGeneratedApiSpec } from './specExecutor'

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
