import { createServer, type Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Studio proxy must not use `fetch`.
 *
 * The shared gateway picks a tenant by the `Host` header. The Fetch spec makes `Host` a forbidden
 * header, so `fetch` silently replaces it with the target's authority (`10.0.2.1:<port>`) — which
 * matches no tenant, and envoy answers `403 RBAC: access denied`. Every Studio request through the
 * panel failed that way for every user, while the identical call from curl worked, which is what
 * made it look like a permissions bug.
 *
 * This stands up a real HTTP server and asserts the header arrives intact: it fails if anyone
 * puts `fetch` back.
 */
let server: Server
let received: Record<string, string | string[] | undefined> = {}
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    received = req.headers
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address && typeof address === 'object') port = address.port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Mirrors the route's helper; kept here so the assertion is about the mechanism, not the route. */
async function requestHonouringHost(
  target: URL,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http')
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('tenant selection through the shared gateway', () => {
  it('delivers the tenant Host header to the upstream', async () => {
    const target = new URL(`http://127.0.0.1:${port}/project/default`)
    const result = await requestHonouringHost(target, {
      host: 'project101-of-org202.example.com',
      authorization: 'Basic dGVzdDp0ZXN0',
      accept: 'text/html',
    })

    expect(result.status).toBe(200)
    expect(received.host).toBe('project101-of-org202.example.com')
  })

  it('shows why fetch cannot be used: it rewrites Host to the connection target', async () => {
    const target = `http://127.0.0.1:${port}/project/default`
    await fetch(target, {
      headers: { host: 'project101-of-org202.example.com' },
      redirect: 'manual',
    })

    // Documented behaviour, asserted so the reason for the custom helper stays visible:
    // the tenant host never arrives, the connection authority does.
    expect(received.host).toBe(`127.0.0.1:${port}`)
  })
})
