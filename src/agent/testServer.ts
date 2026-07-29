import http from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'

/** Real local static HTTP server (Node's built-in `http`, zero new deps)
 * serving `fixtures/reveal.html` — used by `browser.test.ts`/`runner.test.ts`
 * to drive a real Playwright browser against a real page, matching this
 * project's "mock only the true external boundary" testing norm. */
export function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  // `.html` isn't compiled by tsc, so it stays at its source location even
  // when this file runs from `dist/` (tsconfig's rootDir:src/outDir:dist
  // mirror each other 1:1, so `../../src/agent/fixtures` from `dist/agent`
  // lands back on the real source file) — same reason `examples/*.tsx`
  // fixtures get referenced with `../../` from every test file's `dist/`
  // location rather than expecting a copy inside `dist/`.
  const html = readFileSync(join(__dirname, '..', '..', 'src', 'agent', 'fixtures', 'reveal.html'), 'utf8')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}
