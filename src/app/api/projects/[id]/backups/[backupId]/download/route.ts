import { NextRequest, NextResponse } from 'next/server'
import { requireProjectPermission } from '@/lib/access'
import { getBackup } from '@/lib/backup'
import { backupDownloadResponse } from '@/lib/backup-download'

/** Take a backup out of the platform. It holds the whole database, so it needs the restore permission. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string; backupId: string }> }) {
  const { id, backupId } = await ctx.params
  try {
    const access = await requireProjectPermission(request, id, 'backup:restore')
    if (access.response) return access.response
    const backup = await getBackup(backupId, id)
    if (!backup || backup.status !== 'completed') return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
    return await backupDownloadResponse(backup)
  } catch (error) {
    console.error('Download backup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
