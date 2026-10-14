import { prisma } from '@/lib/db'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { runWithStdin } from '@/lib/exec-stdin'
import { tenantContainerName } from '@/lib/gateway'

/**
 * psql arguments for a statement.
 *
 * `aligned` is psql's table — what a person wants to read. `unaligned` (`-tA`) is one value per
 * line, which is what a script wants: parsing an aligned table means regexing around headers and
 * separators, and that is where a caller silently reads the header instead of the value.
 */
export function psqlArgs(database: string, format: 'aligned' | 'unaligned' = 'aligned'): string[] {
  const args = ['exec', '-i', '', 'psql', '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1']
  if (format === 'unaligned') args.push('-tA')
  args.push('-f', '-')
  return args
}

/**
 * Run SQL against a project's database as the platform.
 *
 * This is the part of "superadmin" that is not a browser: a coding agent that needs to inspect a
 * schema, run a migration or fix a row uses a token and this endpoint, with no database port
 * published and no password copied around. `admin` scope only, and every statement is recorded in
 * the audit log — an unreviewable path to arbitrary SQL is not a feature.
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
      sql?: string
      database?: string
      format?: 'aligned' | 'unaligned'
    }
    const sql = (body.sql ?? '').trim()
    if (!sql) return Response.json({ error: 'Send {"sql": "..."}' }, { status: 400 })

    const env = Object.fromEntries(project.envVars.map((e) => [e.key, e.value]))
    const database = body.database ?? env.POSTGRES_DB ?? 'supabase_multitenant'
    const container = tenantContainerName(project.slug, 'db')

    // The statement goes in on stdin: it never appears in the process list, and quoting stops being
    // a question. `-v ON_ERROR_STOP=1` makes psql exit non-zero on a bad statement.
    const safeDatabase = database.replace(/[^a-zA-Z0-9_]/g, '')
    try {
      const args = psqlArgs(safeDatabase, body.format ?? 'aligned')
      args[2] = container
      const result = await runWithStdin('docker', args, sql, { timeoutMs: 120_000 })
      if (result.code !== 0) {
        await prisma.auditLog
          .create({
            data: {
              action: 'project.sql.failed', targetType: 'project', targetId: project.id,
              actorId: actor.userId,
              metadata: { slug: project.slug, database: safeDatabase, via: actor.kind },
            },
          })
          .catch(() => undefined)
        return Response.json(
          { ok: false, database: safeDatabase, stdout: result.stdout, error: result.stderr || null },
          { status: 400 }
        )
      }
      await prisma.auditLog
        .create({
          data: {
            action: 'project.sql', targetType: 'project', targetId: project.id, actorId: actor.userId,
            metadata: { slug: project.slug, database, bytes: sql.length, via: actor.kind },
          },
        })
        .catch(() => undefined)
      return Response.json({
        ok: true,
        database: safeDatabase,
        format: body.format ?? 'aligned',
        stdout: result.stdout,
        stderr: result.stderr || null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ ok: false, database: safeDatabase, error: message }, { status: 502 })
    }
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
