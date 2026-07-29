import http from 'http'

/** Fixture credentials for `loginFixtureServer` — deliberately not secret,
 * this is a throwaway local test server, never a real account. */
export const LOGIN_FIXTURE_USERNAME = 'testuser'
export const LOGIN_FIXTURE_PASSWORD = 'testpass123'
const SESSION_COOKIE_NAME = 'five46_test_session'
const VALID_SESSION_VALUE = 'valid-session-abc123'

function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Login</title></head>
<body>
  <h1>Log in</h1>
  ${error ? `<p role="alert">${error}</p>` : ''}
  <form method="POST" action="/login">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" />
    <button id="submit-btn" type="submit">Log in</button>
  </form>
</body>
</html>`
}

const dashboardPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Dashboard</title></head>
<body>
  <h1>Dashboard</h1>
  <p role="status" id="welcome">Welcome back, logged-in user!</p>
</body>
</html>`

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key) result[key] = rest.join('=')
  }
  return result
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** A real, dynamic Node `http` server exercising an actual login flow —
 * real form POST, real `Set-Cookie`/session-gating, real redirect — since
 * `storageState()` round-trips need genuine server-side session behavior to
 * test honestly; a static fixture page with client-side-only JS (like
 * `reveal.html`) can't exercise this. `GET /login` (form, or the form +
 * error on a failed attempt), `POST /login` (checks the fixture credentials
 * above, sets a real session cookie + redirects on success), `GET
 * /dashboard` (gated on that cookie — redirects back to `/login` without
 * it, so an unauthenticated `five46 test` run against `/dashboard`
 * directly can't accidentally "succeed"). */
export function startLoginFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(loginPage())
      return
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const body = await readBody(req)
      const params = new URLSearchParams(body)
      const username = params.get('username')
      const password = params.get('password')
      if (username === LOGIN_FIXTURE_USERNAME && password === LOGIN_FIXTURE_PASSWORD) {
        res.writeHead(302, {
          'Set-Cookie': `${SESSION_COOKIE_NAME}=${VALID_SESSION_VALUE}; Path=/; HttpOnly`,
          Location: '/dashboard',
        })
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(loginPage('Invalid username or password.'))
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/dashboard') {
      const cookies = parseCookies(req.headers.cookie)
      if (cookies[SESSION_COOKIE_NAME] === VALID_SESSION_VALUE) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(dashboardPage)
      } else {
        res.writeHead(302, { Location: '/login' })
        res.end()
      }
      return
    }

    res.writeHead(404)
    res.end('Not found')
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
