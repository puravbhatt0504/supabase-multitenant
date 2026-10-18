/**
 * What is actually running for each project, as opposed to what its row claims.
 *
 * A project's `status` is a control-plane fact ("active", "paused"). It says nothing about the
 * containers, and rows have outlived theirs (#161): the dashboard showed "active" for projects
 * with no database at all. This turns one `docker ps -a` listing into an honest state per project.
 */

export type RuntimeState = 'running' | 'degraded' | 'down'

export interface RuntimeSummary {
  state: RuntimeState
  /** Core containers that are down, and any container that is up but unhealthy. */
  problems: string[]
}

const isUp = (status: string) => /^Up\b/i.test(status)
const CORE = ['db', 'rest', 'auth']

/** A stopped optional service (studio, meta, functions) is a choice; a core one, or a sick one, is not. */
const isProblem = (slug: string, name: string, status: string) =>
  isUp(status) ? /unhealthy|starting/i.test(status) : CORE.some((c) => name === `${slug}-${c}`)

/**
 * `lines` are `docker ps -a --format '{{.Names}}|{{.Status}}'`. A container belongs to the project
 * with the longest slug that prefixes its name, so `acme-1` never claims `acme-1-extra-db`.
 */
export function runtimeStates(slugs: string[], lines: string[]): Record<string, RuntimeSummary> {
  const bySlugLength = [...slugs].sort((a, b) => b.length - a.length)
  const owned: Record<string, { name: string; status: string }[]> = Object.fromEntries(slugs.map((s) => [s, []]))

  for (const line of lines) {
    const [rawName, ...rest] = line.trim().split('|')
    const name = rawName?.trim()
    if (!name) continue
    const slug = bySlugLength.find((s) => name.startsWith(`${s}-`))
    if (slug) owned[slug].push({ name, status: rest.join('|').trim() })
  }

  const result: Record<string, RuntimeSummary> = {}
  for (const slug of slugs) {
    const containers = owned[slug]
    const db = containers.find((c) => c.name === `${slug}-db`)
    const rest = containers.find((c) => c.name === `${slug}-rest`)
    const problems = containers.filter((c) => isProblem(slug, c.name, c.status)).map((c) => c.name)
    if (!db || !isUp(db.status)) {
      result[slug] = { state: 'down', problems }
    } else if (!rest || problems.length > 0) {
      result[slug] = { state: 'degraded', problems: rest ? problems : [...problems, `${slug}-rest`] }
    } else {
      result[slug] = { state: 'running', problems: [] }
    }
  }
  return result
}
