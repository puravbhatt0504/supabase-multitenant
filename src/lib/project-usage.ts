import { spawn } from 'child_process'
import * as path from 'path'

import { getProjectVolumesPath } from './paths'
import { databaseFromContainerEnv } from './backup'

/**
 * What a project is using right now: database size and connections, end users (and the ones who
 * signed in during the last 30 days - Supabase's "MAU"), storage on disk, and what its containers
 * cost in memory and CPU. Measured, not estimated; any figure that cannot be read is null.
 */

export interface ProjectUsage {
  databaseBytes: number | null
  connections: number | null
  endUsers: number | null
  activeUsers30d: number | null
  storageBytes: number | null
  containers: { name: string; memoryBytes: number; cpuPercent: number }[]
  memoryBytes: number
}

const UNITS: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1e3, mb: 1e6, gb: 1e9 }

/** `docker stats` prints sizes like `37.5MiB` or `1.2GiB`. */
export function parseSize(text: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim())
  if (!m) return 0
  return Math.round(parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] ?? 0))
}

/** Lines of `docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}'` for one project. */
export function parseStats(lines: string[], slug: string, otherSlugs: string[] = []): ProjectUsage['containers'] {
  const longer = otherSlugs.filter((s) => s !== slug && s.startsWith(`${slug}-`))
  return lines
    .map((l) => l.trim().split('|'))
    .filter(([name]) => name?.startsWith(`${slug}-`) && !longer.some((s) => name.startsWith(`${s}-`)))
    .map(([name, mem, cpu]) => ({
      name,
      memoryBytes: parseSize((mem ?? '').split('/')[0]),
      cpuPercent: parseFloat((cpu ?? '0').replace('%', '')) || 0,
    }))
}

function run(command: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args)
    let stdout = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (c) => (stdout += c.toString()))
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout }) })
  })
}

const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)

export async function measureProjectUsage(slug: string, otherSlugs: string[]): Promise<ProjectUsage> {
  const db = `${slug}-db`
  const env = await run('docker', ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', db])
  const database = env.code === 0 ? databaseFromContainerEnv(env.stdout.split('\n')) : 'postgres'

  const sql =
    "select pg_database_size(current_database()), " +
    "(select count(*) from pg_stat_activity where datname = current_database()), " +
    "(select count(*) from auth.users), " +
    "(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days')"
  const [q, stats, du] = await Promise.all([
    run('docker', ['exec', db, 'psql', '-U', 'supabase_admin', '-d', database, '-tA', '-F', '|', '-c', sql]),
    run('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}']),
    run('du', ['-sb', path.join(getProjectVolumesPath(slug), 'storage')]),
  ])

  const [size, conns, users, active] = q.code === 0 ? q.stdout.trim().split('|') : []
  const containers = parseStats(stats.stdout.split('\n'), slug, otherSlugs)
  return {
    databaseBytes: num(size),
    connections: num(conns),
    endUsers: num(users),
    activeUsers30d: num(active),
    storageBytes: du.code === 0 ? num(du.stdout.split(/\s/)[0]) : null,
    containers,
    memoryBytes: containers.reduce((sum, c) => sum + c.memoryBytes, 0),
  }
}
