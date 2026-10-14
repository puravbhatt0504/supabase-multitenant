import { prisma } from '@/lib/db'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { runWithStdin } from '@/lib/exec-stdin'
import { tenantContainerName } from '@/lib/gateway'

/**
 * Create an end user in a project's Auth, as the platform.
 *
 * GoTrue's admin API is called from inside the auth container with the project's own
 * `service_role` key, so the key never has to leave the host and the caller only needs a platform
 * token. `service_role` is the project's master key for Auth — this is the same operation the
 * Supabase dashboard performs, not a privileged back door.
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

    // The key travels in the child's environment (not on the command line, which every process on
    // the host can read) and the request body goes in on stdin.
    const curlScript =
      'curl -sS -X POST http://127.0.0.1:9999/admin/users ' +
      '-H "Content-Type: application/json" -H "Authorization: Bearer $SERVICE_ROLE_KEY" ' +
      '--data-binary @- -w "\\n%{http_code}"'

    try {
      const result = await runWithStdin(
        'docker',
        ['exec', '-i', '-e', 'SERVICE_ROLE_KEY', tenantContainerName(project.slug, 'auth'), 'sh', '-c', curlScript],
        payload,
        { timeoutMs: 60_000, env: { ...process.env, SERVICE_ROLE_KEY: serviceRole } }
      )
      const trimmed = result.stdout.trimEnd()
      if (!trimmed) {
        return Response.json({ error: result.stderr || 'Auth did not respond' }, { status: 502 })
      }
      const split = trimmed.lastIndexOf('\n')
      const status = Number(trimmed.slice(split + 1)) || 502
      const raw = trimmed.slice(0, Math.max(split, 0))
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
            metadata: { slug: project.slug, email, status, via: actor.kind },
          },
        })
        .catch(() => undefined)

      return Response.json(
        { created: status >= 200 && status < 300, status, user },
        { status: status >= 200 && status < 300 ? 201 : 400 }
      )
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string }
      return Response.json({ error: err.stderr ?? err.message }, { status: 502 })
    }
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
