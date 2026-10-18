import { NextRequest, NextResponse } from 'next/server'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { getBackup } from '@/lib/backup'
import { backupDownloadResponse } from '@/lib/backup-download'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string; backupId: string }> }) {
  try {
    await requirePlatformAccess(request, 'admin')
    const { id, backupId } = await ctx.params
    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    const backup = await getBackup(backupId, project.id)
    if (!backup || backup.status !== 'completed') return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
    return await backupDownloadResponse(backup)
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
