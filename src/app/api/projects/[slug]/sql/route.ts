import { prisma } from '@/lib/db'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { runWithStdin } from '@/lib/exec-stdin'
import { tenantContainerName } from '@/lib/gateway'

/**
 * Run SQL against a project's database as the platform.
 *
 * This is the part of "superadmin" that is not a browser: a coding agent that needs to inspect a
 * schema, run a migration or fix a row uses a token and this endpoint, with no database port
 * published and no password copied around. `admin` scope only, and every statement is recorded in
 * the audit log — an unreviewable path to arbitrary SQL is not a feature.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { slug } = await ctx.params

    const project = await prisma.project.findUnique({ where: { slug }, include: { envVars: true } })
    if (!project) return Response.json({ error: 'No such project' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as { sql?: string; database?: string }
    const sql = (body.sql ?? '').trim()
    if (!sql) return Response.json({ error: 'Send {"sql": "..."}' }, { status: 400 })

    const env = Object.fromEntries(project.envVars.map((e) => [e.key, e.value]))
    const database = body.database ?? env.POSTGRES_DB ?? 'supabase_multitenant'
    const container = tenantContainerName(slug, 'db')

    // The statement goes in on stdin: it never appears in the process list, and quoting stops being
    // a question. `-v ON_ERROR_STOP=1` makes psql exit non-zero on a bad statement.
    const safeDatabase = database.replace(/[^a-zA-Z0-9_]/g, '')
    try {
      const result = await runWithStdin(
        'docker',
        ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', safeDatabase,
         '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        sql,
        { timeoutMs: 120_000 }
      )
      if (result.code !== 0) {
        await prisma.auditLog
          .create({
            data: {
              action: 'project.sql.failed', targetType: 'project', targetId: project.id,
              actorId: actor.userId,
              metadata: { slug, database: safeDatabase, via: actor.kind },
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
            metadata: { slug, database, bytes: sql.length, via: actor.kind },
          },
        })
        .catch(() => undefined)
      return Response.json({ ok: true, database: safeDatabase, stdout: result.stdout, stderr: result.stderr || null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ ok: false, database: safeDatabase, error: message }, { status: 502 })
    }
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
