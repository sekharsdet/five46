import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadActionCache, saveActionCache, actionCacheFilePath } from './actionCache'
import type { ActionCacheFile } from './actionCache'

// Always uses a temp directory (never the real ~/.five46) — mirrors
// store.test.ts's identical convention exactly.

test('saveActionCache then loadActionCache round-trips correctly and sets user-only file permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cache-test-'))
  try {
    const cache: ActionCacheFile = {
      entries: {
        'proj|goal|http://localhost:3000': {
          domSignature: 'abc123',
          steps: [{ action: 'click', target: { role: 'button', nameContains: 'Login' }, reason: 'log in' }],
          cachedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    saveActionCache(cache, dir)

    assert.ok(existsSync(actionCacheFilePath(dir)))
    const loaded = loadActionCache(dir)
    assert.deepEqual(loaded, cache)

    // 0o600 = owner read/write only, no group/other access.
    const mode = statSync(actionCacheFilePath(dir)).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadActionCache returns an empty cache when nothing has been saved yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cache-test-'))
  try {
    assert.deepEqual(loadActionCache(dir), { entries: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadActionCache returns an empty cache (not a crash) for a corrupted/hand-edited cache file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cache-test-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(actionCacheFilePath(dir), '{ not valid json', 'utf8')
    assert.deepEqual(loadActionCache(dir), { entries: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadActionCache returns an empty cache for a well-formed JSON file missing the expected "entries" shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'five46-cache-test-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(actionCacheFilePath(dir), JSON.stringify({ notEntries: 'oops' }), 'utf8')
    assert.deepEqual(loadActionCache(dir), { entries: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
