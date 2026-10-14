import { NextRequest, NextResponse } from 'next/server'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { validateSession } from '@/lib/auth'
import { SESSION_COOKIE_NAME } from '@/lib/session-cookie'
import { prisma } from '@/lib/db'
import { getProjectsBasePath } from '@/lib/paths'

// App-level Studio gateway. Per-project Studio containers expose no auth of
// their own; this is the single authenticated entry point. It validates the
// panel admin session, then reverse-proxies to the target project's Studio.
//
// Usage (all methods proxied):
//   /gateway/studio/<projectSlug>/<rest...>
//
// The pretty subdomain (e.g. playgroundsb1-studio.<host>) is rewritten here by
// src/middleware.ts, so Studio's absolute asset paths (/_next/..., /project/...)
// resolve at the subdomain root and keep the pretty URL.

const HOST_GATEWAY = process.env.HOST_GATEWAY || '10.0.2.1'

interface RouteContext {
  params: Promise<{ slug: string; rest?: string[] }>
}

// Redirect to the panel login WITHOUT baking in the container's internal URL.
// A relative Location resolves against whatever public host the browser used
// (previously this emitted http://0.0.0.0:3000/... which is unreachable).
function loginRedirect(_request: NextRequest, pathname: string): Response {
  const next = encodeURIComponent(pathname)
  return new Response(null, {
    status: 307,
    headers: { location: `/auth/login?next=${next}` },
  })
}

/**
 * Proxy one request to the tenant's listener on the shared gateway.
 *
 * Deliberately NOT `fetch`. The gateway selects the tenant by the `Host` header, and the Fetch spec
 * makes `Host` a *forbidden* header: `fetch` silently replaces it with the connection target's
 * authority — `10.0.2.1:11130` — which matches no tenant's listener, so envoy answers
 * `403 RBAC: access denied`. That is precisely what this route returned for every Studio request
 * (for every user, including the owner) while the identical call from curl served Studio fine.
 * Node's `http.request` honours the header, so the tenant is selected correctly.
 */
async function gatewayRequest(
  target: URL,
  init: { method: string; headers: Headers; body?: ArrayBuffer }
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers: Object.fromEntries(init.headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue
            // Repeated headers (notably set-cookie) must stay separate, not comma-joined.
            for (const single of Array.isArray(value) ? value : [value]) {
              responseHeaders.append(key, single)
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              statusText: res.statusMessage,
              headers: responseHeaders,
            })
          )
        })
      }
    )
    req.on('error', reject)
    if (init.body && init.body.byteLength > 0) req.write(Buffer.from(init.body))
    req.end()
  })
}

async function handle(request: NextRequest, ctx: RouteContext): Promise<Response> {
  const { slug, rest } = await ctx.params

  // App-level auth gate (the panel's own session).
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!token || !(await validateSession(token))) {
    return loginRedirect(request, request.nextUrl.pathname)
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { envVars: true },
  })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const envMap = Object.fromEntries(project.envVars.map((e) => [e.key, e.value]))

  // Note that somebody is here, on every request rather than only on the entry point.
  //
  // The idle reaper stops this project's dashboard group once nobody has looked for a while. If
  // only the first page view counted, a session that stayed open — the normal case, Studio is used
  // for minutes at a time — would look abandoned after the idle window and Studio would be stopped
  // underneath the person using it.
  try {
    const { recordDashboardUse } = await import('@/lib/idle-reaper-runtime')
    recordDashboardUse(project.id)
  } catch (error) {
    // Bookkeeping must never be the reason a request fails.
    console.warn('Could not record Studio use:', error)
  }

  // Studio must be served at a HOST ROOT, not a path prefix.
  //
  // Its asset and route URLs are absolute (`/_next/...`, `/project/...`), so a path-prefixed URL
  // like /gateway/studio/<slug>/ loads the HTML and then fetches its assets from the panel root,
  // where they do not exist — the page renders as a black screen. The supported entry point is the
  // project's Studio subdomain, where Traefik injects `x-studio-gateway` and middleware.ts rewrites
  // internally so the browser stays at the host root.
  //
  // So if someone lands here by path (no injected header), send them to the host that works rather
  // than serving a page that cannot render.
  const viaStudioHost = Boolean(request.headers.get('x-studio-gateway'))
  const studioHost = envMap.GW_STUDIO_HOST
  if (!viaStudioHost && studioHost) {
    const suffix = rest && rest.length ? `/${rest.join('/')}` : '/'
    return NextResponse.redirect(`https://${studioHost}${suffix}`, 308)
  }

  // Studio is reached through the project's SHARED gateway listener (ADR-0003), not a port of its
  // own. Two things the old code got wrong and this fixes:
  //
  //   1. It targeted STUDIO_PORT, which the template writes into .env but nothing ever publishes —
  //      so this route could never connect, for any project, before or after the cutover.
  //   2. It set `host: <slug>-studio`. The per-project envoy accepted `domains: ['*']` so that
  //      worked; the shared gateway matches the tenant by its PUBLIC host, so that Host would
  //      match no listener and be rejected.
  //
  // GW_HTTP_PORT is the host port of this tenant's listener on the shared gateway, and
  // GW_PUBLIC_HOST is the host it answers for. Both are written per project at creation.
  const gatewayPort = envMap.GW_HTTP_PORT || envMap.STUDIO_PORT || '3000'
  const gatewayHost = envMap.GW_PUBLIC_HOST || `${slug}.localhost`

  const upstreamPath = rest && rest.length ? `/${rest.join('/')}` : '/'

  // Studio answers `/` itself with a redirect to `/project/<default>`, but that redirect loses the
  // panel's `/gateway/studio/<slug>` prefix on the return trip, so the browser lands on a 404. Send
  // the browser straight to the project path, keeping it inside this route so every asset URL stays
  // prefix-correct.
  if (!rest || rest.length === 0) {
    // Opening Studio is what makes the dashboard group wanted (ADR-0003 phase 4): studio + meta are
    // the most expensive optional services, so they stay stopped until somebody actually looks at
    // them. Done here rather than on every asset request so it costs one check per Studio open.
    try {
      const { ENABLED_SERVICES_KEY, applyServiceGroups, parseEnabledGroups, waitForServicesRunning } =
        await import('@/lib/service-groups')
      const { tenantContainerName } = await import('@/lib/gateway')
      const enabled = parseEnabledGroups(envMap[ENABLED_SERVICES_KEY])

      // Ensure the group is up — unconditionally, and NOT only when `dashboard` is missing from the
      // enabled set. The reaper stops an idle dashboard group, so "enabled" can no longer be read as
      // "running": with that condition, a project that deliberately enabled the dashboard would have
      // its Studio stopped after 30 idle minutes and could never start it again. Applying the group
      // is idempotent, and compose treats an already-running service as a no-op.
      await applyServiceGroups({
        projectDir: path.join(getProjectsBasePath(), project.slug, 'docker'),
        groups: [...enabled, 'dashboard'],
      })
      // Wait for Studio to answer, otherwise the browser follows the redirect below into a 503 and
      // the user has to reload. Best-effort: a timeout still redirects.
      await waitForServicesRunning([
        tenantContainerName(slug, 'studio'),
        tenantContainerName(slug, 'meta'),
      ])
    } catch (error) {
      // Starting Studio must not block reaching Studio; if it fails the proxy below reports it.
      console.warn('Could not start the dashboard service group:', error)
    }

    return new Response(null, {
      status: 307,
      // Host-aware target.
      //
      // On the Studio host the browser must stay at the HOST ROOT — that is the entire point of
      // routing Studio through a subdomain, because Studio's asset and route URLs are absolute.
      // Redirecting to the path form here put the browser on
      // `https://<slug>-studio.<domain>/gateway/studio/<slug>/project/default`, where Studio's own
      // client-side routing and absolute paths no longer line up: the page loads but never paints,
      // i.e. the black screen.
      //
      // Reached by path instead (no injected header), the host root is the correct destination, and
      // the top-of-handler redirect already sent that case away.
      headers: { location: viaStudioHost ? '/project/default' : `/gateway/studio/${slug}/project/default` },
    })
  }

  const target = new URL(upstreamPath, `http://${HOST_GATEWAY}:${gatewayPort}`)
  const query = request.nextUrl.searchParams.toString()
  if (query) target.search = `?${query}`

  // Forward a deliberate allowlist, not "everything except host".
  //
  // The old code copied every browser header through. The gateway template matches SOME routes on
  // headers, so an unrelated browser header could select a different route than the path implies —
  // which is how this endpoint returned `403 RBAC: access denied` for a request a plain curl served
  // fine. A fixed list removes that whole class of surprise, and stops leaking the panel's own
  // cookies and auth headers to a tenant's container.
  const FORWARDED = [
    'accept',
    'accept-language',
    'content-type',
    'range',
    'if-match',
    'if-none-match',
    'if-modified-since',
  ]
  const headers = new Headers()
  for (const name of FORWARDED) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('host', gatewayHost)

  // Studio sits behind the gateway's basic-auth filter. The panel session is the single
  // authenticated entry point (see the file header), so supply that credential here rather than
  // making the user log in twice. Unset -> Studio prompts for itself.
  const gatewayBasicAuth = process.env.SHARED_GATEWAY_BASIC_AUTH
  if (gatewayBasicAuth) headers.set('authorization', `Basic ${gatewayBasicAuth}`)

  const body =
    !['GET', 'HEAD'].includes(request.method) ? await request.arrayBuffer().catch(() => undefined) : undefined

  let upstream: Response
  try {
    upstream = await gatewayRequest(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: 'Studio gateway unreachable', detail: msg },
      { status: 502 },
    )
  }

  // Self-healing cold start.
  //
  // Studio's services are on demand, so a deep link (`/project/default`) opened while they are
  // stopped reaches a gateway with no healthy upstream and returns 503. Starting the group only on
  // the root path would leave that case broken; starting it on every request would run docker on
  // every asset. So: react to the gateway's own verdict, start the group, wait, and retry once.
  if (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) {
    try {
      const { ENABLED_SERVICES_KEY, applyServiceGroups, parseEnabledGroups, waitForServicesRunning } =
        await import('@/lib/service-groups')
      const { tenantContainerName } = await import('@/lib/gateway')
      const enabled = parseEnabledGroups(envMap[ENABLED_SERVICES_KEY])
      if (!enabled.includes('dashboard')) {
        await applyServiceGroups({
          projectDir: path.join(getProjectsBasePath(), project.slug, 'docker'),
          groups: [...enabled, 'dashboard'],
        })
        await waitForServicesRunning([
          tenantContainerName(slug, 'studio'),
          tenantContainerName(slug, 'meta'),
        ])
        // One retry, with the same request shape.
        upstream = await gatewayRequest(target, {
          method: request.method,
          headers,
          body: body && body.byteLength > 0 ? body : undefined,
        })
      }
    } catch (error) {
      console.warn('Could not cold-start the dashboard service group:', error)
    }
  }

  const out = new NextResponse(upstream.body, { status: upstream.status })
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'content-length' || k === 'connection' || k === 'content-encoding') return
    // Keep redirects relative so the browser stays on the pretty subdomain.
    if (k === 'location' && value.startsWith('http')) {
      try {
        const u = new URL(value)
        out.headers.set('location', u.pathname + u.search)
        return
      } catch {
        /* fall through */
      }
    }
    out.headers.set(key, value)
  })
  return out
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  return handle(request, ctx)
}
export async function POST(request: NextRequest, ctx: RouteContext) {
  return handle(request, ctx)
}
export async function PUT(request: NextRequest, ctx: RouteContext) {
  return handle(request, ctx)
}
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  return handle(request, ctx)
}
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  return handle(request, ctx)
}
