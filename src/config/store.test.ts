import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfigFile, saveConfigFile, configFilePath } from './store'

// Always uses a temp directory (never the real ~/.five46) — this is
// what makes `configDir` an argument on every function in store.ts rather
// than a hardcoded path.

test('saveConfigFile then loadConfigFile round-trips correctly and sets user-only file permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-config-test-'))
  try {
    const config = { llm: { provider: 'openai', apiKey: 'sk-x' } }
    saveConfigFile(config, dir)

    assert.ok(existsSync(configFilePath(dir)))
    const loaded = loadConfigFile(dir)
    assert.deepEqual(loaded, config)

    // 0o600 = owner read/write only, no group/other access — this file holds secrets.
    const mode = statSync(configFilePath(dir)).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfigFile returns undefined when no config has been saved yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-config-test-'))
  try {
    assert.equal(loadConfigFile(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfigFile returns undefined (not a crash) for a corrupted/hand-edited config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-config-test-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(configFilePath(dir), '{ not valid json', 'utf8')
    assert.equal(loadConfigFile(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
