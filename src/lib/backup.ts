import { promises as fs, createWriteStream } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { prisma } from './db'
import { getBackupsBasePath } from './paths'
import { receiveDump, parseSha256 } from './backup-upload'
import { filterRestoreList, listingHasEndUsers } from './backup-restore-list'

/**
 * Per-project backup and restore.
 *
 * This is the durability story for self-hosted stacks *and* the engine the
 * cloud -> self-hosted migration rides on: "restore a dump into a project" is
 * the same operation whether the dump came from a previous backup of this
 * project or from Supabase Cloud (#99).
 *
 * Backups are written outside `projects/` so they survive a project being
 * deleted or re-provisioned (see getBackupsBasePath).
 */

export const BACKUP_KINDS = ['database', 'storage'] as const
export type BackupKind = (typeof BACKUP_KINDS)[number]

/**
 * Schemas dumped by default: the application's own, plus `auth` so the people who signed up come
 * back with the data. A restore replays only the `auth.users` / `auth.identities` rows of it
 * (see backup-restore-list.ts); the rest of the schema is never touched.
 */
export const DEFAULT_SCHEMAS = ['public', 'auth']

const execAsync = promisify(exec)

/**
 * Platform-managed schemas. Dumping these into a *fresh* project would clash
 * with the roles/objects its own init scripts create, so they are opt-in.
 */
export const PLATFORM_SCHEMAS = ['auth', 'storage', 'realtime', 'supabase_migrations', 'vault']

export interface RetentionPolicy {
  /** How many backups of a kind to keep regardless of age. */
  keep: number
  /** Optionally also drop anything older than this many days. */
  maxAgeDays?: number
}

export const DEFAULT_RETENTION: RetentionPolicy = { keep: 7 }

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** `2026-09-10T16:20:30.123Z` -> `20260910T162030Z` (filesystem + sort safe). */
export function backupStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export function backupExtension(kind: BackupKind): string {
  return kind === 'database' ? 'dump' : 'tar.gz'
}

/** `<slug>_<kind>_<stamp>.<ext>` — slug first so `ls` groups by project. */
export function backupFileName(slug: string, kind: BackupKind, at: Date): string {
  return `${slug}_${kind}_${backupStamp(at)}.${backupExtension(kind)}`
}

export interface ParsedBackupName {
  slug: string
  kind: BackupKind
  stamp: string
}

export function parseBackupFileName(fileName: string): ParsedBackupName | null {
  const match = fileName.match(/^(.+)_(database|storage)_(\d{8}T\d{6}Z)\.(?:dump|tar\.gz)$/)
  if (!match) return null
  return { slug: match[1], kind: match[2] as BackupKind, stamp: match[3] }
}

/** Absolute directory holding one project's backup artifacts. */
export function backupDirectory(slug: string, base = getBackupsBasePath()): string {
  return path.join(base, slug)
}

/**
 * Which backups a retention policy says to delete.
 *
 * Two independent rules, either of which prunes a backup:
 *  - `keep`: the N most recent per kind are always retained;
 *  - `maxAgeDays` (optional): nothing older than this survives.
 *
 * Input order is not assumed — ordering happens here so callers can pass
 * whatever the database returned.
 */
export function selectBackupsToPrune<
  T extends { id: string; kind: string; createdAt: Date },
>(backups: T[], policy: RetentionPolicy, now: Date = new Date()): T[] {
  const doomed: T[] = []
  const cutoff =
    policy.maxAgeDays === undefined
      ? null
      : new Date(now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000)

  const byKind = new Map<string, T[]>()
  for (const backup of backups) {
    const list = byKind.get(backup.kind) ?? []
    list.push(backup)
    byKind.set(backup.kind, list)
  }

  for (const list of byKind.values()) {
    const sorted = [...list].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )
    sorted.forEach((backup, index) => {
      const beyondKeep = index >= policy.keep
      const beyondAge = cutoff !== null && backup.createdAt < cutoff
      if (beyondKeep || beyondAge) {
        doomed.push(backup)
      }
    })
  }

  return doomed
}

export interface BackupJson {
  id: string
  projectId: string
  kind: string
  status: string
  fileName: string
  sizeBytes: number | string | null
  sha256: string | null
  error: string | null
  restoreCount: number
  lastRestoredAt: string | null
  createdAt: string
  completedAt: string | null
}

/** Prisma returns BigInt for sizeBytes, which JSON.stringify refuses. */
export function serializeBackup(row: {
  id: string
  projectId: string
  kind: string
  status: string
  fileName: string
  sizeBytes: bigint | null
  sha256: string | null
  error: string | null
  restoreCount: number
  lastRestoredAt: Date | null
  createdAt: Date
  completedAt: Date | null
}): BackupJson {
  let size: number | string | null = null
  if (row.sizeBytes !== null) {
    size =
      row.sizeBytes <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(row.sizeBytes)
        : row.sizeBytes.toString()
  }
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    fileName: row.fileName,
    sizeBytes: size,
    sha256: row.sha256,
    error: row.error,
    restoreCount: row.restoreCount,
    lastRestoredAt: row.lastRestoredAt ? row.lastRestoredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  }
}

/**
 * Guard for restoring a backup into a target project.
 *
 * Restoring over live data is destructive, so it must be asked for explicitly;
 * the common migration path is a *fresh, empty* project.
 */
export function validateRestoreTarget(opts: {
  backupKind: string
  targetStatus: string
  targetPublicTableCount: number
  overwrite: boolean
}): void {
  const { backupKind, targetStatus, targetPublicTableCount, overwrite } = opts

  if (backupKind !== 'database') {
    throw new Error(
      `Only database backups can be restored into a project (got kind "${backupKind}").`
    )
  }
  if (targetStatus !== 'active') {
    throw new Error(
      `Target project must be "active" to restore into it (status is "${targetStatus}").`
    )
  }
  if (targetPublicTableCount > 0 && !overwrite) {
    throw new Error(
      `Target project already has ${targetPublicTableCount} table(s) in the public schema. ` +
        `Pass overwrite=true to replace its contents deliberately.`
    )
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
  code: number
  stderr: string
}

/** Run a command, streaming stdout into a file (binary-safe). */
function pipeToFile(command: string, args: string[], filePath: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath)
    let stderr = ''
    const child = spawn(command, args)

    child.stdout.pipe(out)
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      out.destroy()
      reject(error)
    })
    out.on('error', (error) => {
      child.kill()
      reject(error)
    })
    child.on('close', (code) => {
      out.end(() => resolve({ code: code ?? 0, stderr }))
    })
  })
}

/** Run a command and collect its stdout. */
function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c.toString()))
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

export function dbContainerName(slug: string): string {
  return `${slug}-db`
}

/**
 * Which database holds a project's data. Projects born before the POSTGRES_DB fix keep it in
 * `postgres`; every project born since keeps it in `supabase_multitenant`. Guessing one of them
 * backs up an empty database and reports success - the dump is valid, it just contains nothing.
 *
 * The running db container is the source of truth (it is what auth and rest actually connect to).
 * The value stored in the panel's own database has been seen to disagree with it.
 */
export function databaseFromContainerEnv(envLines: string[]): string {
  for (const line of envLines) {
    const match = /^POSTGRES_DB=(.+)$/.exec(line.trim())
    if (match && /^[A-Za-z0-9_]+$/.test(match[1])) return match[1]
  }
  return 'postgres'
}

export async function tenantDatabaseName(slug: string): Promise<string> {
  const { code, stdout } = await run('docker', [
    'inspect',
    '--format',
    '{{range .Config.Env}}{{println .}}{{end}}',
    dbContainerName(slug),
  ])
  if (code !== 0) throw new Error(`Could not read the database name of ${slug} (docker inspect exit ${code})`)
  return databaseFromContainerEnv(stdout.split('\n'))
}

/** Names of tables the application itself owns in a project's public schema. */
export async function publicTableCount(slug: string): Promise<number> {
  const database = await tenantDatabaseName(slug)
  const { code, stdout } = await run('docker', [
    'exec',
    dbContainerName(slug),
    'psql',
    '-U',
    'postgres',
    '-d',
    database,
    '-tAc',
    "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
  ])
  if (code !== 0) throw new Error(`Could not inspect ${slug}: psql exit ${code}`)
  return Number(stdout.trim() || '0')
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const data = await fs.readFile(filePath)
  hash.update(data)
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * `pg_dump` a project's database into `backups/<slug>/`.
 *
 * Defaults to the application schema only. Pass `schemas` explicitly (e.g. to
 * include `auth` for a full platform migration) when you know the target
 * expects those objects.
 */
/**
 * A backup that cannot start because of how the project *is*, not because something failed.
 *
 * Distinct from a failed dump so a caller can answer 409 with an instruction ("deploy it first")
 * instead of 500 with a Docker error. The case that produced this: pressing "Back up now" while the
 * project's containers were still being created, which surfaced as
 * `No such container: <slug>-db` — true, and useless to the person reading it.
 */
export class BackupNotReadyError extends Error {
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'BackupNotReadyError'
  }
}

/** Is a container of that exact name running? */
async function containerIsRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker ps -q --filter name=^${name}$`, { timeout: 15_000 })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export async function createDatabaseBackup(
  project: { id: string; slug: string },
  options: { schemas?: string[] } = {}
): Promise<{ id: string; fileName: string; sizeBytes: number; sha256: string }> {
  const schemas = options.schemas ?? DEFAULT_SCHEMAS
  const at = new Date()
  const fileName = backupFileName(project.slug, 'database', at)
  const dir = backupDirectory(project.slug)
  const filePath = path.join(dir, fileName)

  await fs.mkdir(dir, { recursive: true })

  // A project that has never been deployed, or is still starting, has no database container to dump
  // from. Say so before creating a backup row: the person can then deploy and retry, instead of
  // reading a Docker error about a container they never asked for.
  const container = dbContainerName(project.slug)
  if (!(await containerIsRunning(container))) {
    throw new BackupNotReadyError(
      `The database of ${project.slug} is not running (no ${container} container). ` +
        'Deploy the project — or wait for the deployment that is in progress — and take the backup again.'
    )
  }

  const row = await prisma.projectBackup.create({
    data: {
      projectId: project.id,
      kind: 'database',
      status: 'running',
      fileName,
      filePath,
    },
  })

  const database = await tenantDatabaseName(project.slug)
  const args = [
    'exec',
    '-i',
    dbContainerName(project.slug),
    'pg_dump',
    '-Fc',
    '--no-owner',
    '--no-acl',
    '-U',
    'postgres',
    '-d',
    database,
  ]
  for (const schema of schemas) {
    args.push(`--schema=${schema}`)
  }

  const { code, stderr } = await pipeToFile('docker', args, filePath)

  if (code !== 0) {
    await fs.rm(filePath, { force: true })
    await prisma.projectBackup.update({
      where: { id: row.id },
      data: { status: 'failed', error: stderr.slice(-2000) || `pg_dump exit ${code}` },
    })
    // The container can still vanish between the check and the dump (a deploy in progress
    // recreating it); report that as "not ready" rather than as a dump failure.
    if (/No such container/i.test(stderr)) {
      throw new BackupNotReadyError(
        `The database of ${project.slug} stopped while the backup ran (a deployment may be in ` +
          'progress). Try again once it is running.'
      )
    }
    throw new Error(`pg_dump failed for ${project.slug}: ${stderr.slice(-400)}`)
  }

  const stat = await fs.stat(filePath)
  if (stat.size === 0) {
    await fs.rm(filePath, { force: true })
    await prisma.projectBackup.update({
      where: { id: row.id },
      data: { status: 'failed', error: 'pg_dump produced an empty file' },
    })
    throw new Error(`pg_dump produced an empty dump for ${project.slug}`)
  }

  const sha256 = await sha256File(filePath)
  await prisma.projectBackup.update({
    where: { id: row.id },
    data: { status: 'completed', sizeBytes: BigInt(stat.size), sha256, completedAt: new Date() },
  })

  return { id: row.id, fileName, sizeBytes: stat.size, sha256 }
}

/**
 * Archive a project's storage volume (bucket objects) into `backups/<slug>/`.
 *
 * The storage volume is a host path bind-mounted into the storage container, so
 * it is archived directly — no exec into a container and no named volume needed.
 */
export async function createStorageBackup(project: {
  id: string
  slug: string
}): Promise<{ id: string; fileName: string; sizeBytes: number; sha256: string }> {
  const at = new Date()
  const fileName = backupFileName(project.slug, 'storage', at)
  const dir = backupDirectory(project.slug)
  const filePath = path.join(dir, fileName)
  const volumePath = path.join(
    getBackupsBasePath(),
    '..',
    'projects',
    project.slug,
    'docker',
    'volumes',
    'storage'
  )

  await fs.mkdir(dir, { recursive: true })

  const row = await prisma.projectBackup.create({
    data: {
      projectId: project.id,
      kind: 'storage',
      status: 'running',
      fileName,
      filePath,
    },
  })

  if (!(await fs.stat(volumePath).catch(() => null))) {
    await prisma.projectBackup.update({
      where: { id: row.id },
      data: { status: 'failed', error: `storage volume not found at ${volumePath}` },
    })
    throw new Error(`Storage volume not found for ${project.slug}: ${volumePath}`)
  }

  const { code, stderr } = await run('tar', ['czf', filePath, '-C', volumePath, '.'])

  if (code !== 0) {
    await fs.rm(filePath, { force: true })
    await prisma.projectBackup.update({
      where: { id: row.id },
      data: { status: 'failed', error: stderr.slice(-2000) || `tar exit ${code}` },
    })
    throw new Error(`tar failed for ${project.slug}: ${stderr.slice(-400)}`)
  }

  const stat = await fs.stat(filePath)
  const sha256 = await sha256File(filePath)
  await prisma.projectBackup.update({
    where: { id: row.id },
    data: { status: 'completed', sizeBytes: BigInt(stat.size), sha256, completedAt: new Date() },
  })

  return { id: row.id, fileName, sizeBytes: stat.size, sha256 }
}

// ---------------------------------------------------------------------------
// Import (a dump made elsewhere, registered like any other backup)
// ---------------------------------------------------------------------------

export const DEFAULT_IMPORT_MAX_BYTES = 4 * 1024 * 1024 * 1024

/**
 * Register an uploaded `pg_dump -Fc` file as a backup of `project`, so the normal restore path
 * applies unchanged. The file is verified (format, optional sha256) before a row exists.
 */
export async function importDatabaseBackup(
  project: { id: string; slug: string },
  body: ReadableStream<Uint8Array> | null,
  options: { sha256?: string | null; maxBytes?: number } = {}
): Promise<{ id: string; fileName: string; sizeBytes: number; sha256: string }> {
  const expected = parseSha256(options.sha256)
  const dir = backupDirectory(project.slug)
  await fs.mkdir(dir, { recursive: true })
  const fileName = backupFileName(project.slug, 'database', new Date())
  const filePath = path.join(dir, fileName)

  const { sizeBytes, sha256 } = await receiveDump(body, filePath, {
    maxBytes: options.maxBytes ?? DEFAULT_IMPORT_MAX_BYTES,
    expectedSha256: expected,
  })
  const row = await prisma.projectBackup.create({
    data: {
      projectId: project.id,
      kind: 'database',
      status: 'completed',
      fileName,
      filePath,
      sizeBytes: BigInt(sizeBytes),
      sha256,
      completedAt: new Date(),
    },
  })
  return { id: row.id, fileName, sizeBytes, sha256 }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a database backup into a project.
 *
 * This is the migration primitive: the same call restores a freshly taken
 * backup or a dump exported from Supabase Cloud.
 */
export async function restoreDatabaseBackup(
  backupId: string,
  target: { id: string; slug: string; status: string },
  options: { overwrite?: boolean } = {}
): Promise<{ restoredFrom: string; target: string; tables: number }> {
  const backup = await prisma.projectBackup.findUnique({ where: { id: backupId } })
  if (!backup) throw new Error(`Backup ${backupId} not found`)

  const tableCount = await publicTableCount(target.slug)
  validateRestoreTarget({
    backupKind: backup.kind,
    targetStatus: target.status,
    targetPublicTableCount: tableCount,
    overwrite: options.overwrite ?? false,
  })

  const database = await tenantDatabaseName(target.slug)
  const container = dbContainerName(target.slug)
  const inContainer = '/tmp/smbt-restore.dump'
  const listInContainer = '/tmp/smbt-restore.list'
  const hostList = `${backup.filePath}.restore.list`

  const cp = await run('docker', ['cp', backup.filePath, `${container}:${inContainer}`])
  if (cp.code !== 0) throw new Error(`Could not hand the backup to ${target.slug}: ${cp.stderr.slice(-300)}`)

  try {
    // Replay the project's own schema and the end users, never the auth schema's DDL.
    const listing = await run('docker', ['exec', container, 'pg_restore', '-l', inContainer])
    if (listing.code !== 0) throw new Error(`Not a readable backup: ${listing.stderr.slice(-300)}`)
    await fs.writeFile(hostList, filterRestoreList(listing.stdout))
    const cpList = await run('docker', ['cp', hostList, `${container}:${listInContainer}`])
    if (cpList.code !== 0) throw new Error(`Could not hand the restore plan to ${target.slug}: ${cpList.stderr.slice(-300)}`)

    if (listingHasEndUsers(listing.stdout)) {
      // The backup's end users replace whoever is there now; loading them next to existing rows
      // would collide on id. CASCADE also clears sessions/tokens, which belonged to those users.
      const wipe = await run('docker', [
        'exec', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c',
        'TRUNCATE auth.users, auth.identities CASCADE',
      ])
      if (wipe.code !== 0) throw new Error(`Could not clear the end users of ${target.slug}: ${wipe.stderr.slice(-300)}`)
    }

    // supabase_admin, not postgres: tables made through the SQL editor are owned by it, and
    // --clean cannot ALTER a table its role does not own. The dump carries no owners (--no-owner),
    // and default privileges in public re-grant anon/authenticated/service_role on what it creates.
    const restore = await run('docker', [
      'exec', container, 'pg_restore', '-U', 'supabase_admin', '-d', database,
      '--no-owner', '--no-acl', '--clean', '--if-exists', '--single-transaction',
      '-L', listInContainer, inContainer,
    ])
    if (restore.code !== 0) {
      throw new Error(`pg_restore failed for ${target.slug}: ${restore.stderr.slice(-600)}`)
    }
  } finally {
    await fs.rm(hostList, { force: true })
    await run('docker', ['exec', container, 'rm', '-f', inContainer, listInContainer]).catch(() => undefined)
  }

  await prisma.projectBackup.update({
    where: { id: backup.id },
    data: { restoreCount: { increment: 1 }, lastRestoredAt: new Date() },
  })

  return {
    restoredFrom: backup.fileName,
    target: target.slug,
    tables: await publicTableCount(target.slug),
  }
}

// ---------------------------------------------------------------------------
// Listing + retention
// ---------------------------------------------------------------------------

export async function listBackups(projectId: string): Promise<BackupJson[]> {
  const rows = await prisma.projectBackup.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map(serializeBackup)
}

/** Delete artifacts beyond the retention policy. Returns what was removed. */
export async function pruneBackups(
  projectId: string,
  policy: RetentionPolicy = DEFAULT_RETENTION
): Promise<string[]> {
  const rows = await prisma.projectBackup.findMany({
    where: { projectId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
  })

  const filePaths = new Map(rows.map((r) => [r.id, r.filePath]))
  const doomed = selectBackupsToPrune(
    rows.map((r) => ({ id: r.id, kind: r.kind, createdAt: r.createdAt })),
    policy
  )

  for (const backup of doomed) {
    const filePath = filePaths.get(backup.id)
    if (filePath) await fs.rm(filePath, { force: true })
    await prisma.projectBackup.delete({ where: { id: backup.id } })
  }

  return doomed.map((b) => b.id)
}

/** Best-effort size of everything stored for a project, in bytes. */
export async function backupFootprint(projectId: string): Promise<number> {
  const rows = await prisma.projectBackup.findMany({
    where: { projectId },
    select: { sizeBytes: true },
  })
  return rows.reduce((total, row) => total + Number(row.sizeBytes ?? 0), 0)
}

/** Load a single backup, scoped to the project it belongs to. */
export async function getBackup(backupId: string, projectId: string) {
  return prisma.projectBackup.findFirst({ where: { id: backupId, projectId } })
}

/** Remove a backup artifact and its record. Returns false if it wasn't there. */
export async function deleteBackup(backupId: string, projectId: string): Promise<boolean> {
  const row = await prisma.projectBackup.findFirst({
    where: { id: backupId, projectId },
  })
  if (!row) return false

  await fs.rm(row.filePath, { force: true })
  await prisma.projectBackup.delete({ where: { id: row.id } })
  return true
}
