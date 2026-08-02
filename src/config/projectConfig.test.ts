import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadProjectConfig,
  resolveProject,
  mergeProjectDefaultsForTest,
  mergeProjectDefaultsForApi,
  PROJECT_CONFIG_FILENAME,
  type Five46ProjectConfig,
} from './projectConfig'

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'five46-project-config-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('loadProjectConfig fails honestly when the file does not exist', () => {
  withTempDir((dir) => {
    const result = loadProjectConfig(dir)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.ok(result.error.includes(PROJECT_CONFIG_FILENAME))
    assert.ok(result.error.includes('not found'))
  })
})

test('loadProjectConfig fails honestly on invalid JSON', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), '{ not valid json')
    const result = loadProjectConfig(dir)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.ok(result.error.includes("isn't valid JSON"))
  })
})

test('loadProjectConfig fails honestly on valid JSON with the wrong shape', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ notProjects: {} }))
    const result = loadProjectConfig(dir)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.ok(result.error.includes('doesn\'t look like a project config'))
  })
})

test('loadProjectConfig succeeds on a real, well-shaped config', () => {
  withTempDir((dir) => {
    const config: Five46ProjectConfig = { projects: { checkout: { url: 'http://localhost:3000/checkout' } } }
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify(config))
    const result = loadProjectConfig(dir)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('unreachable')
    assert.deepEqual(result.config, config)
  })
})

test('resolveProject finds a configured project by name', () => {
  const config: Five46ProjectConfig = { projects: { checkout: { url: 'http://localhost:3000/checkout' } } }
  const result = resolveProject(config, 'checkout')
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.defaults.url, 'http://localhost:3000/checkout')
})

test('resolveProject fails honestly and lists real configured names on a miss', () => {
  const config: Five46ProjectConfig = { projects: { checkout: {}, billing: {} } }
  const result = resolveProject(config, 'nope')
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.ok(result.error.includes('checkout'))
  assert.ok(result.error.includes('billing'))
})

test('resolveProject says "(none configured)" when there are no projects at all', () => {
  const result = resolveProject({ projects: {} }, 'nope')
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.ok(result.error.includes('(none configured)'))
})

test('mergeProjectDefaultsForTest: an explicit CLI flag always wins over a project default', () => {
  const merged = mergeProjectDefaultsForTest({ url: 'http://explicit', allowDeletes: true }, { url: 'http://from-project', allowDeletes: false })
  assert.equal(merged.url, 'http://explicit')
  assert.equal(merged.allowDeletes, true)
})

test('mergeProjectDefaultsForTest: a project default fills a gap the CLI left unset', () => {
  const merged = mergeProjectDefaultsForTest({}, { url: 'http://from-project', storageState: 'session.json', maxSteps: 20, headed: true })
  assert.equal(merged.url, 'http://from-project')
  assert.equal(merged.storageState, 'session.json')
  assert.equal(merged.maxSteps, 20)
  assert.equal(merged.headed, true)
})

test('mergeProjectDefaultsForTest: neither set stays unset', () => {
  const merged = mergeProjectDefaultsForTest({}, {})
  assert.equal(merged.url, undefined)
  assert.equal(merged.allowDeletes, undefined)
})

test('mergeProjectDefaultsForApi: an explicit CLI flag wins, including the non-optional boolean/array fields', () => {
  const merged = mergeProjectDefaultsForApi(
    { baseUrl: 'http://explicit', allowWrites: true, allowDeletes: false, allowHosts: ['explicit.example.com'] },
    { url: 'http://from-project', allowWrites: false, allowDeletes: true, allowHosts: ['project.example.com'] }
  )
  assert.equal(merged.baseUrl, 'http://explicit')
  assert.equal(merged.allowWrites, true)
  assert.deepEqual(merged.allowHosts, ['explicit.example.com'])
})

test('mergeProjectDefaultsForApi: a project default fills the gap for unset/false/empty CLI fields', () => {
  const merged = mergeProjectDefaultsForApi(
    { allowWrites: false, allowDeletes: false, allowHosts: [] },
    { url: 'http://from-project', allowWrites: true, allowDeletes: true, allowHosts: ['project.example.com'], maxSteps: 12 }
  )
  assert.equal(merged.baseUrl, 'http://from-project')
  assert.equal(merged.allowWrites, true)
  assert.equal(merged.allowDeletes, true)
  assert.deepEqual(merged.allowHosts, ['project.example.com'])
  assert.equal(merged.maxSteps, 12)
})
