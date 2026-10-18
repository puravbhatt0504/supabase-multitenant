import { NextRequest, NextResponse } from 'next/server'
import { requireProjectPermission } from '@/lib/access'
import { importDatabaseBackup } from '@/lib/backup'
import { UploadRejected } from '@/lib/backup-upload'

/**
 * Bring a `pg_dump -Fc` file into a project as a backup. The request body IS the file
 * (`Content-Type: application/octet-stream`); `?sha256=` or the `X-Content-Sha256` header makes the
 * upload verified. Restore it afterwards through the normal restore route.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const access = await requireProjectPermission(request, id, 'backup:create')
    if (access.response) return access.response
    const sha256 = request.nextUrl.searchParams.get('sha256') ?? request.headers.get('x-content-sha256')
    const backup = await importDatabaseBackup(
      { id: access.project.id, slug: access.project.slug },
      request.body,
      { sha256 }
    )
    return NextResponse.json({ backup }, { status: 201 })
  } catch (error) {
    if (error instanceof UploadRejected) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('Import backup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
