/**
 * Decides which projects are due for a scheduled backup. Pure: no clock, database or docker here.
 *
 * Due-ness is derived from the newest *completed* backup on record, not from a timer started at
 * boot. The panel restarts on every deploy; a "once every 24h since start" timer would never fire
 * on a platform that is redeployed more often than that. Reading the last backup from the database
 * makes the schedule survive restarts and means a missed run is caught up on the next pass.
 */

export const DEFAULT_BACKUP_INTERVAL_HOURS = 24
/** After a failed attempt, wait this long before trying the same project again. */
export const DEFAULT_RETRY_AFTER_MS = 60 * 60 * 1000

export interface BackupCandidate {
  id: string
  slug: string
}

export interface DueInput {
  projects: BackupCandidate[]
  /** projectId -> time of the newest completed database backup (ms since epoch). */
  lastCompleted: Map<string, number>
  /** projectId -> time of the last attempt that failed (ms since epoch), kept in memory. */
  lastFailed: Map<string, number>
  now: number
  intervalMs: number
  retryAfterMs?: number
}

export function projectsDueForBackup(input: DueInput): BackupCandidate[] {
  const retryAfterMs = input.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
  const due = input.projects.filter((project) => {
    const failedAt = input.lastFailed.get(project.id)
    if (failedAt !== undefined && input.now - failedAt < retryAfterMs) return false
    const last = input.lastCompleted.get(project.id)
    return last === undefined || input.now - last >= input.intervalMs
  })
  // Never-backed-up projects first, then the stalest: if a pass is cut short, the most exposed
  // project has already been done.
  return due.sort(
    (a, b) => (input.lastCompleted.get(a.id) ?? 0) - (input.lastCompleted.get(b.id) ?? 0)
  )
}
