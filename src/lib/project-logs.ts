import { spawn } from 'child_process'

/**
 * Per-service logs of a project, read from its containers (`docker logs`).
 *
 * The pure parts - which service names are allowed, what severity a line has, what a filter keeps -
 * are separate from the Docker call so they can be tested without a daemon.
 */

export const SEVERITIES = ['error', 'warn', 'info', 'debug'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface LogLine {
  /** ISO timestamp from Docker, or '' when a line had none. */
  at: string
  severity: Severity
  text: string
}

const RANK: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Guess a line's severity from the conventions of the stack's services (JSON `level`, `ERROR:` ...). */
export function severityOf(text: string): Severity {
  const json = /"(?:level|lvl|severity)"\s*:\s*"?([A-Za-z]+)/i.exec(text)
  const word = (json?.[1] ?? '').toLowerCase()
  if (word) {
    if (/^(fatal|panic|crit|critical|error|err)$/.test(word)) return 'error'
    if (/^warn(ing)?$/.test(word)) return 'warn'
    if (/^debug|trace$/.test(word)) return 'debug'
    if (/^info|notice|log$/.test(word)) return 'info'
  }
  if (/\b(FATAL|PANIC|ERROR|CRITICAL)\b|\[(?:error|crit|emerg|alert)\]/.test(text)) return 'error'
  if (/\b(WARNING|WARN)\b|\[warn\]/.test(text)) return 'warn'
  if (/\b(DEBUG|TRACE)\b|\[debug\]/.test(text)) return 'debug'
  return 'info'
}

/** `docker logs --timestamps` prefixes each line with an RFC3339 time. */
export function parseLogLines(raw: string): LogLine[] {
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?(.*)$/.exec(line)
      const text = (m ? m[2] : line).replace(/\x1b\[[0-9;]*m/g, '')
      return { at: m ? m[1] : '', severity: severityOf(text), text }
    })
}

/** Keep lines at or above `minSeverity` that contain `search` (case-insensitive). */
export function filterLogLines(lines: LogLine[], opts: { minSeverity?: Severity; search?: string }): LogLine[] {
  const min = RANK[opts.minSeverity ?? 'debug']
  const needle = opts.search?.trim().toLowerCase()
  return lines.filter((l) => RANK[l.severity] >= min && (!needle || l.text.toLowerCase().includes(needle)))
}

/** Services of a project, from container names `<slug>-<service>`; never another project's. */
export function serviceNames(slug: string, allContainerNames: string[], otherSlugs: string[] = []): string[] {
  const longer = otherSlugs.filter((s) => s !== slug && s.startsWith(`${slug}-`))
  return allContainerNames
    .filter((n) => n.startsWith(`${slug}-`) && !longer.some((s) => n.startsWith(`${s}-`)))
    .map((n) => n.slice(slug.length + 1))
    .filter((n) => /^[a-z0-9][a-z0-9_-]*$/.test(n))
    .sort()
}

function run(args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (c) => (stdout += c.toString()))
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
  })
}

export async function listProjectServices(slug: string, otherSlugs: string[]): Promise<string[]> {
  const { code, stdout } = await run(['ps', '-a', '--format', '{{.Names}}'])
  if (code !== 0) return []
  return serviceNames(slug, stdout.split('\n').map((n) => n.trim()).filter(Boolean), otherSlugs)
}

export const MAX_TAIL = 2000

export async function readServiceLogs(
  slug: string,
  service: string,
  opts: { tail?: number; since?: string; minSeverity?: Severity; search?: string }
): Promise<LogLine[]> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(service)) throw new Error('Invalid service name')
  const tail = Math.min(Math.max(Math.floor(opts.tail ?? 200), 1), MAX_TAIL)
  const args = ['logs', '--timestamps', '--tail', String(tail)]
  if (opts.since && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(opts.since)) args.push('--since', opts.since)
  args.push(`${slug}-${service}`)
  const { code, stdout, stderr } = await run(args)
  if (code !== 0) throw new Error(stderr.trim().slice(-300) || `docker logs exit ${code}`)
  // docker writes a container's stderr to our stderr; the stream split carries no meaning for a viewer.
  return filterLogLines(parseLogLines(`${stdout}\n${stderr}`), opts).sort((a, b) => a.at.localeCompare(b.at))
}
