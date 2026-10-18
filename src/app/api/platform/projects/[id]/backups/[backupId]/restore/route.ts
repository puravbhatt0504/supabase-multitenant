import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { getBackup, restoreDatabaseBackup } from '@/lib/backup'
import { prisma } from '@/lib/db'

/**
 * Restore a backup into a project (token twin of the session route). `id` is the project the backup
 * belongs to; `targetProjectId` in the body picks another project, `overwrite: true` is required to
 * restore over a project that already has tables.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; backupId: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id, backupId } = await ctx.params
    const body = (await request.json().catch(() => ({}))) as { targetProjectId?: string; overwrite?: boolean }

    const source = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!source) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    const targetKey = body.targetProjectId ?? source.id
    const target = await prisma.project.findFirst({ where: { OR: [{ slug: targetKey }, { id: targetKey }] } })
    if (!target) return NextResponse.json({ error: 'No such target project' }, { status: 404 })

    const backup = await getBackup(backupId, source.id)
    if (!backup) return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
    if (backup.status !== 'completed') {
      return NextResponse.json({ error: `Backup is "${backup.status}" and cannot be restored.` }, { status: 409 })
    }

    let result
    try {
      result = await restoreDatabaseBackup(
        backupId,
        { id: target.id, slug: target.slug, status: target.status },
        { overwrite: body.overwrite === true }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Restore failed'
      const status = /must be "active"|already has|Only database backups/.test(message) ? 409 : 500
      return NextResponse.json({ error: message }, { status })
    }

    await prisma.auditLog
      .create({
        data: {
          action: 'platform.project.backup.restored',
          targetType: 'project',
          targetId: target.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { backupId, source: source.slug, target: target.slug, overwrite: body.overwrite === true, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ success: true, restore: result })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
