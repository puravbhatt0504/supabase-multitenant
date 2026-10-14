import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import {
  BACKUP_KINDS,
  DEFAULT_RETENTION,
  type BackupKind,
  BackupNotReadyError,
  createDatabaseBackup,
  createStorageBackup,
  listBackups,
  pruneBackups,
} from '@/lib/backup'
import { prisma } from '@/lib/db'

/** Backups of a project: list them, or take one now. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAccess(request, 'read')
    const { id } = await ctx.params
    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    return NextResponse.json({ backups: await listBackups(project.id) })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params
    const body = (await request.json().catch(() => ({}))) as { kind?: string; schemas?: string[] }

    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })

    const kind = (body.kind ?? 'database') as BackupKind
    if (!BACKUP_KINDS.includes(kind)) {
      return NextResponse.json({ error: `kind must be one of ${BACKUP_KINDS.join(', ')}` }, { status: 400 })
    }

    const target = { id: project.id, slug: project.slug }
    let created
    try {
      created =
        kind === 'database'
          ? await createDatabaseBackup(target, { schemas: body.schemas })
          : await createStorageBackup(target)
    } catch (error) {
      if (error instanceof BackupNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: error.status })
      }
      throw error
    }

    const pruned = await pruneBackups(project.id, DEFAULT_RETENTION)

    await prisma.auditLog
      .create({
        data: {
          action: 'platform.project.backup.created',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { slug: project.slug, kind, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ backup: created, pruned: pruned.length }, { status: 201 })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
