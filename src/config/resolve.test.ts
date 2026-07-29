import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveConfigFile } from './store'
import { resolveCredentials } from './resolve'

test('resolveCredentials falls back to the saved config file when no env vars are set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-config-test-'))
  try {
    saveConfigFile({ llm: { provider: 'anthropic', apiKey: 'file-key' } }, dir)
    const resolved = resolveCredentials({}, dir)
    assert.equal(resolved.llmProvider, 'anthropic')
    assert.equal(resolved.llmApiKey, 'file-key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveCredentials prefers environment variables over a saved config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-config-test-'))
  try {
    saveConfigFile({ llm: { provider: 'anthropic', apiKey: 'file-key' } }, dir)
    const resolved = resolveCredentials(
      { FIVE46_LLM_PROVIDER: 'openai', FIVE46_LLM_API_KEY: 'env-key' },
      dir
    )
    assert.equal(resolved.llmProvider, 'openai')
    assert.equal(resolved.llmApiKey, 'env-key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveCredentials returns undefined fields when neither env vars nor a config file exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-config-test-'))
  try {
    const resolved = resolveCredentials({}, dir)
    assert.equal(resolved.llmProvider, undefined)
    assert.equal(resolved.llmApiKey, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
