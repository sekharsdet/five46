import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { resolveMcpPath } from './paths'

const ROOT = '/Users/dev/my-project'

test('resolveMcpPath accepts an ordinary relative path, resolved against the project root', () => {
  const result = resolveMcpPath(ROOT, 'session.json')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.path, join(ROOT, 'session.json'))
})

test('resolveMcpPath accepts a relative path with subdirectories', () => {
  const result = resolveMcpPath(ROOT, 'artifacts/run.spec.ts')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.path, join(ROOT, 'artifacts/run.spec.ts'))
})

test('resolveMcpPath rejects an absolute path outright', () => {
  const result = resolveMcpPath(ROOT, '/etc/passwd')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /must be a relative path/)
})

test('resolveMcpPath rejects a path that escapes the project root via ..', () => {
  const result = resolveMcpPath(ROOT, '../../etc/passwd')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /escapes the project root/)
})

test('resolveMcpPath rejects a path that escapes only after normalization', () => {
  const result = resolveMcpPath(ROOT, 'subdir/../../outside.json')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /escapes the project root/)
})

test('resolveMcpPath does not over-reject a harmless name that merely contains ".."', () => {
  const result = resolveMcpPath(ROOT, '..foo/session.json')
  assert.equal(result.ok, true)
})

test('resolveMcpPath treats a project-root-relative .. that stays inside as fine', () => {
  // subdir/.. cancels out to exactly the root itself, never leaving it.
  const result = resolveMcpPath(ROOT, 'subdir/../session.json')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.path, join(ROOT, 'session.json'))
})
