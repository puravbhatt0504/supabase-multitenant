import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'stream'
import { NextResponse } from 'next/server'

/** Stream a backup artifact as a download. The path never leaves the server. */
export async function backupDownloadResponse(backup: { filePath: string; fileName: string; sha256: string | null }) {
  const stat = await fs.stat(backup.filePath).catch(() => null)
  if (!stat) return NextResponse.json({ error: 'The backup file is no longer on disk' }, { status: 410 })
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Content-Disposition': `attachment; filename="${backup.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'Cache-Control': 'no-store',
  }
  if (backup.sha256) headers['X-Content-Sha256'] = backup.sha256
  return new NextResponse(Readable.toWeb(createReadStream(backup.filePath)) as unknown as ReadableStream, { headers })
}
