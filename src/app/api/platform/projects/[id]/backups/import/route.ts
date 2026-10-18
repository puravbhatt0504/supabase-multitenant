import { NextRequest, NextResponse } from 'next/server'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { importDatabaseBackup } from '@/lib/backup'
import { UploadRejected } from '@/lib/backup-upload'
import { prisma } from '@/lib/db'

/** Token twin of the session import: the request body is the dump file; `?sha256=` verifies it. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params
    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    const sha256 = request.nextUrl.searchParams.get('sha256') ?? request.headers.get('x-content-sha256')
    let backup
    try {
      backup = await importDatabaseBackup({ id: project.id, slug: project.slug }, request.body, { sha256 })
    } catch (error) {
      if (error instanceof UploadRejected) return NextResponse.json({ error: error.message }, { status: error.status })
      throw error
    }
    await prisma.auditLog
      .create({
        data: {
          action: 'platform.project.backup.imported',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { slug: project.slug, fileName: backup.fileName, sizeBytes: backup.sizeBytes, via: actor.kind },
        },
      })
      .catch(() => undefined)
    return NextResponse.json({ backup }, { status: 201 })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
