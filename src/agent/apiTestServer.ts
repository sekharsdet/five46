import http from 'http'

/** A real, stateful, in-memory Node `http` CRUD API — needed to honestly
 * exercise value-chaining (`saveAs` a real created id, use it in a real
 * subsequent read/delete) and write-gating (a blocked write must be a real
 * blocked write against a real server, not an assumption). Mirrors
 * `loginTestServer.ts`'s "real server-side behavior, not a client-side
 * stand-in" norm. */
export const API_FIXTURE_USERNAME = 'apiuser'
export const API_FIXTURE_PASSWORD = 'apipass123'
const SESSION_COOKIE_NAME = 'five46_api_session'
const VALID_SESSION_VALUE = 'valid-api-session-xyz'

interface Item {
  id: number
  name: string
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key) result[key] = rest.join('=')
  }
  return result
}

export function startApiTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const items = new Map<number, Item>()
  let nextId = 1

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    if (method === 'POST' && url.pathname === '/login') {
      const body = await readBody(req)
      const parsed = body ? JSON.parse(body) : {}
      if (parsed.username === API_FIXTURE_USERNAME && parsed.password === API_FIXTURE_PASSWORD) {
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE_NAME}=${VALID_SESSION_VALUE}; Path=/; HttpOnly` })
      } else {
        sendJson(res, 401, { error: 'invalid credentials' })
      }
      return
    }

    if (method === 'GET' && url.pathname === '/whoami') {
      const cookies = parseCookies(req.headers.cookie)
      sendJson(res, 200, { authenticated: cookies[SESSION_COOKIE_NAME] === VALID_SESSION_VALUE })
      return
    }

    if (method === 'GET' && url.pathname === '/echo-headers') {
      sendJson(res, 200, { headers: req.headers })
      return
    }

    if (method === 'GET' && url.pathname === '/slow') {
      // Never responds — exists solely to exercise apiExecutor.ts's
      // AbortController-based request timeout for real, rather than
      // assuming it works. The response is intentionally never sent; the
      // client's own abort is what ends this connection.
      return
    }

    if (method === 'GET' && url.pathname === '/redirect-same-origin') {
      res.writeHead(302, { Location: '/items' })
      res.end()
      return
    }

    if (method === 'GET' && url.pathname === '/redirect-cross-origin') {
      // A deliberately unreachable host — the redirect must be blocked
      // before ever actually being followed, so it never needs to resolve.
      res.writeHead(302, { Location: 'http://cross-origin-target.invalid/somewhere' })
      res.end()
      return
    }

    if (method === 'POST' && url.pathname === '/items') {
      const body = await readBody(req)
      const parsed = body ? JSON.parse(body) : {}
      const item: Item = { id: nextId++, name: String(parsed.name ?? '') }
      items.set(item.id, item)
      sendJson(res, 201, item)
      return
    }

    if (url.pathname === '/items' && method === 'GET') {
      sendJson(res, 200, { items: [...items.values()] })
      return
    }

    const itemMatch = url.pathname.match(/^\/items\/(\d+)$/)
    if (itemMatch) {
      const id = Number(itemMatch[1])
      if (method === 'GET') {
        const item = items.get(id)
        if (!item) return sendJson(res, 404, { error: 'not found' })
        return sendJson(res, 200, item)
      }
      if (method === 'PUT') {
        if (!items.has(id)) return sendJson(res, 404, { error: 'not found' })
        const body = await readBody(req)
        const parsed = body ? JSON.parse(body) : {}
        const updated: Item = { id, name: String(parsed.name ?? items.get(id)!.name) }
        items.set(id, updated)
        return sendJson(res, 200, updated)
      }
      if (method === 'DELETE') {
        if (!items.has(id)) return sendJson(res, 404, { error: 'not found' })
        items.delete(id)
        return sendJson(res, 204, undefined)
      }
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
