/**
 * The live half of scheduled backups. Started once from `src/instrumentation.ts`, in-process like
 * the idle reaper: no cron on the host, no second scheduler to keep alive.
 *
 * Configuration (read once at start):
 *   BACKUP_SCHEDULER_DISABLED=1        turn it off
 *   BACKUP_INTERVAL_HOURS=24           how old the newest backup may get before another is taken
 *   BACKUP_CHECK_MINUTES=15            how often to look
 */

import { prisma } from '@/lib/db'
import {
  BackupNotReadyError,
  DEFAULT_RETENTION,
  createDatabaseBackup,
  pruneBackups,
} from '@/lib/backup'
import {
  DEFAULT_BACKUP_INTERVAL_HOURS,
  projectsDueForBackup,
} from '@/lib/backup-scheduler'

let started = false
let running = false
const lastFailed = new Map<string, number>()

export async function backupPass(intervalMs: number): Promise<void> {
  if (running) return
  running = true
  try {
    const projects = await prisma.project.findMany({
      where: { status: 'active' },
      select: { id: true, slug: true },
    })
    const latest = await prisma.projectBackup.groupBy({
      by: ['projectId'],
      where: { kind: 'database', status: 'completed' },
      _max: { createdAt: true },
    })
    const lastCompleted = new Map<string, number>()
    for (const row of latest) {
      if (row._max.createdAt) lastCompleted.set(row.projectId, row._max.createdAt.getTime())
    }

    const due = projectsDueForBackup({
      projects,
      lastCompleted,
      lastFailed,
      now: Date.now(),
      intervalMs,
    })

    for (const project of due) {
      try {
        const backup = await createDatabaseBackup(project)
        lastFailed.delete(project.id)
        const pruned = await pruneBackups(project.id, DEFAULT_RETENTION)
        console.log(
          `[backup-scheduler] ${project.slug}: ${backup.fileName} (${backup.sizeBytes} bytes), pruned ${pruned.length}`
        )
      } catch (error) {
        // One project failing (not running, disk full) must not stop the others.
        lastFailed.set(project.id, Date.now())
        if (error instanceof BackupNotReadyError) {
          // Not a failure of the backup: the project has no running database (stopped, or a row
          // whose containers are gone). Say so once per retry window, at info level.
          console.log(`[backup-scheduler] ${project.slug} skipped: its database is not running`)
          continue
        }
        console.error(
          `[backup-scheduler] ${project.slug} failed: ${error instanceof Error ? error.message : error}`
        )
      }
    }
  } finally {
    running = false
  }
}

export function startBackupSchedulerOnce(): (() => void) | null {
  if (process.env.BACKUP_SCHEDULER_DISABLED === '1') {
    console.log('[backup-scheduler] disabled by BACKUP_SCHEDULER_DISABLED')
    return null
  }
  if (started) return null
  started = true

  const hours = Number(process.env.BACKUP_INTERVAL_HOURS ?? '') || DEFAULT_BACKUP_INTERVAL_HOURS
  const checkMinutes = Number(process.env.BACKUP_CHECK_MINUTES ?? '') || 15
  const intervalMs = hours * 60 * 60 * 1000

  console.log(`[backup-scheduler] every ${hours}h per project, checking every ${checkMinutes} min`)

  const tick = () =>
    void backupPass(intervalMs).catch((error) =>
      console.error(`[backup-scheduler] pass failed: ${error instanceof Error ? error.message : error}`)
    )
  // First look shortly after boot (not immediately: let the stack settle), then on the interval.
  const first = setTimeout(tick, 2 * 60 * 1000)
  const timer = setInterval(tick, checkMinutes * 60 * 1000)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
