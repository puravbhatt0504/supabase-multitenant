import { prisma } from '@/lib/db'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { platformBaseDomainOrThrow } from '@/lib/tenant-provisioning'

/**
 * Everything needed to work on a project's database or API from outside the panel.
 *
 * This is the answer to "let an agent control any instance": a `admin`-scoped token calls this with
 * a project slug and gets the connection facts, instead of someone copying values out of a
 * container. The Postgres address is the in-network one (`db:<port>`), reachable by anything running
 * on the same host — including a one-off `psql` container — and `sql` runs statements without
 * needing the port published at all.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params

    // The path segment accepts the project's slug (what the panel shows) or its id.
    const project = await prisma.project.findFirst({
      where: { OR: [{ slug: id }, { id }] },
      include: { envVars: true },
    })
    if (!project) return Response.json({ error: 'No such project' }, { status: 404 })

    const env = Object.fromEntries(project.envVars.map((e) => [e.key, e.value]))
    // Deployment fact, not a constant (TRAEFIK_DYNAMIC_PATH aside, the domain is whatever the
    // install was created with).
    const baseDomain = platformBaseDomainOrThrow()

    return Response.json({
      project: { slug: project.slug, name: project.name },
      api: {
        url: env.SUPABASE_PUBLIC_URL ?? (env.GW_API_HOST ? `https://${env.GW_API_HOST}` : null),
        anonKey: env.ANON_KEY ?? null,
        serviceRoleKey: env.SERVICE_ROLE_KEY ?? null,
      },
      studio: env.GW_STUDIO_HOST ? `https://${env.GW_STUDIO_HOST}` : null,
      database: {
        host: 'db',
        port: env.POSTGRES_PORT ?? null,
        database: env.POSTGRES_DB ?? 'supabase_multitenant',
        user: 'postgres',
        password: env.POSTGRES_PASSWORD ?? null,
        // Reachable from a container on the project network: `docker run --rm --network
        // <slug>_default postgres:16-alpine psql <this url>`. The port is not published on the host.
        url: `postgresql://postgres:${env.POSTGRES_PASSWORD ?? ''}@db:${env.POSTGRES_PORT ?? ''}/${
          env.POSTGRES_DB ?? 'supabase_multitenant'
        }`,
      },
      howTo: {
        sql: `POST /api/projects/${project.slug}/sql {"sql": "select 1"}`,
        createUser: `POST /api/projects/${project.slug}/auth/users {"email": "...", "password": "..."}`,
        network: `docker run --rm --network ${project.slug}_default postgres:16-alpine psql <database.url>`,
      },
      baseDomain,
      requestedBy: { kind: actor.kind, email: actor.email },
    })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
