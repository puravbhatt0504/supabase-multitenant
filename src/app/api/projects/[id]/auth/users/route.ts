import { prisma } from '@/lib/db'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { apiUrlFor } from '@/lib/project-endpoints'

/**
 * Create an end user in a project's Auth, as the platform.
 *
 * GoTrue's admin API is called through the project's own public API host — the same path a client
 * uses, which the gateway's RBAC already vets for `/auth/v1/` — rather than by exec'ing into the
 * container, whose image ships no HTTP client. The `service_role` key stays on the server: the
 * caller only needs a platform token. This is the same operation the Supabase dashboard performs,
 * not a privileged back door.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params

    // The path segment accepts the project's slug (what the panel shows) or its id.
    const project = await prisma.project.findFirst({
      where: { OR: [{ slug: id }, { id }] },
      include: { envVars: true },
    })
    if (!project) return Response.json({ error: 'No such project' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as {
      email?: string
      password?: string
      emailConfirm?: boolean
      userMetadata?: Record<string, unknown>
      skipConfirmation?: boolean
    }
    const email = (body.email ?? '').trim()
    if (!email) return Response.json({ error: 'Send {"email": "...", "password": "..."}' }, { status: 400 })

    const env = Object.fromEntries(project.envVars.map((e) => [e.key, e.value]))
    const serviceRole = env.SERVICE_ROLE_KEY ?? ''
    if (!serviceRole) {
      return Response.json({ error: 'This project has no service_role key recorded' }, { status: 409 })
    }

    const payload = JSON.stringify({
      email,
      password: body.password,
      email_confirm: body.emailConfirm ?? !body.skipConfirmation,
      user_metadata: body.userMetadata ?? {},
    })

    // GoTrue's admin API is reached through the project's own public API host — the same path a
    // client uses — rather than by exec'ing into the container: the auth image ships no HTTP client,
    // and the public path is what the gateway's RBAC already vets for `/auth/v1/`.
    const apiUrl = apiUrlFor(env)
    if (!apiUrl) {
      return Response.json(
        { error: 'This project has no public API URL recorded yet' },
        { status: 409 }
      )
    }

    let upstream: Response
    try {
      upstream = await fetch(`${apiUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Supabase convention: the service_role key is both the API key and the bearer.
          apikey: serviceRole,
          Authorization: `Bearer ${serviceRole}`,
        },
        body: payload,
        redirect: 'manual',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: `Auth unreachable: ${message}` }, { status: 502 })
    }

    const raw = await upstream.text()
    let user: unknown = raw
    try {
      user = JSON.parse(raw)
    } catch {
      /* keep the raw text */
    }

    await prisma.auditLog
      .create({
        data: {
          action: 'project.auth_user.created',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          metadata: { slug: project.slug, email, status: upstream.status, via: actor.kind },
        },
      })
      .catch(() => undefined)

    const ok = upstream.status >= 200 && upstream.status < 300
    return Response.json({ created: ok, status: upstream.status, user }, { status: ok ? 201 : 400 })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
