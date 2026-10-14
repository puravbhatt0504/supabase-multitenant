import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { prisma } from './db'
import { tenantContainerName } from './gateway'

const execAsync = promisify(exec)

/**
 * How far a project is from being usable — measured, not guessed.
 *
 * The platform used to be honest only in the negative: it let you start an action and then told you
 * it failed (`No such container: <slug>-db` for a backup taken while the stack was still coming up).
 * That is a state problem disguised as an error: between "created" and "ready" a project goes
 * through stages, and every action that needs the finished thing has to say where it is instead of
 * failing late and cryptically.
 *
 * The stages are the real ones, in order:
 *
 *   1. the stack exists          — its containers are there
 *   2. its services are healthy  — nothing is still starting
 *   3. it is on the gateway      — the shared plane knows this tenant
 *   4. it answers                — its own API host responds through the gateway
 *
 * `percent` is the fraction of those stages that are done, so a progress bar means something.
 */

export interface ProgressStage {
  key: 'containers' | 'healthy' | 'gateway' | 'answering'
  label: string
  done: boolean
  detail: string
}

export interface ProjectProgress {
  slug: string
  status: string
  stages: ProgressStage[]
  percent: number
  ready: boolean
  /** Why an action that needs a ready project cannot run yet; null when it can. */
  blockReason: string | null
  /** What is worth telling the person while it is not ready. */
  hint: string | null
}

/** What the containers of a project look like right now. */
export interface RunningShape {
  total: number
  running: number
  healthy: number
  unhealthy: string[]
  /** The expected always-on service names, so a missing one is visible. */
  missing: string[]
}

/** Parse `docker ps --format '{{.Names}}|{{.Status}}'` output for one project. */
export function summarizeContainers(
  lines: string[],
  expectedServices: string[],
  slug: string
): RunningShape {
  const parsed = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split('|')
      return { name: name.trim(), status: rest.join('|').trim() }
    })

  const running = parsed.filter((c) => /^Up\b/i.test(c.status))
  const healthy = running.filter((c) => /healthy/i.test(c.status))
  const unhealthy = running.filter((c) => !/healthy/i.test(c.status)).map((c) => c.name)

  const present = new Set(parsed.map((c) => c.name))
  const missing = expectedServices.filter((service) => !present.has(`${slug}-${service}`))

  return { total: parsed.length, running: running.length, healthy: healthy.length, unhealthy, missing }
}

/** The stage list, from the facts — pure, so the rules are testable. */
export function stagesFor(input: {
  shape: RunningShape
  onGateway: boolean
  answering: boolean
  expectedCount: number
}): ProgressStage[] {
  const { shape, onGateway, answering, expectedCount } = input
  const allHealthy = expectedCount > 0 && shape.healthy >= expectedCount

  return [
    {
      key: 'containers',
      label: 'Stack created',
      done: shape.total > 0,
      detail: shape.total > 0 ? `${shape.total} containers` : 'no containers yet',
    },
    {
      key: 'healthy',
      label: 'Services healthy',
      done: allHealthy,
      detail:
        shape.total === 0
          ? 'not started'
          : `${shape.healthy}/${expectedCount || shape.total} healthy` +
            (shape.unhealthy.length ? `, ${shape.unhealthy.length} starting` : ''),
    },
    {
      key: 'gateway',
      label: 'On the gateway',
      done: onGateway,
      detail: onGateway ? 'registered' : 'not registered yet',
    },
    {
      key: 'answering',
      label: 'Answers on its host',
      done: answering,
      detail: answering ? 'responding' : 'not responding yet',
    },
  ]
}

/** Percent complete, from the stages, in equal quarters. */
export function percentFrom(stages: ProgressStage[]): number {
  if (stages.length === 0) return 0
  return Math.round((stages.filter((s) => s.done).length / stages.length) * 100)
}

/** The instruction a person needs, given the stages. */
export function blockReasonFor(stages: ProgressStage[], status: string): string | null {
  const first = stages.find((s) => !s.done)
  if (!first) return null
  if (status === 'paused') return 'The project is paused — resume it first.'
  switch (first.key) {
    case 'containers':
      return 'The project has no containers yet — deploy it first.'
    case 'healthy':
      return `The project is still starting (${first.detail}). Wait for it, then try again.`
    case 'gateway':
      return 'The project is not registered on the gateway yet — deploy it, then try again.'
    default:
      return 'The project is not answering on its host yet. Give it a moment, then try again.'
  }
}

/** Collect the live progress of one project. */
export async function projectProgress(slug: string): Promise<ProjectProgress | null> {
  const project = await prisma.project.findUnique({ where: { slug }, include: { envVars: true } })
  if (!project) return null

  const env = Object.fromEntries(project.envVars.map((e) => [e.key, e.value]))
  const enabled = (env.ENABLED_SERVICES ?? 'core').split(',').map((s) => s.trim()).filter(Boolean)
  const expectedServices = ['db', 'auth', 'rest', ...(enabled.includes('dashboard') ? ['studio', 'meta'] : [])]

  let shape: RunningShape = { total: 0, running: 0, healthy: 0, unhealthy: [], missing: expectedServices }
  try {
    const { stdout } = await execAsync(
      `docker ps --format '{{.Names}}|{{.Status}}' | grep '^${slug}-' || true`,
      { timeout: 15_000 }
    )
    shape = summarizeContainers(stdout.split('\n'), expectedServices, slug)
  } catch {
    /* treat as "nothing running" */
  }

  let onGateway = false
  try {
    const { stdout } = await execAsync(
      `docker exec smbt-shared-gateway sh -c "grep -c '${slug}-gw' /etc/envoy/cds.yaml || true"`,
      { timeout: 15_000 }
    )
    onGateway = Number(stdout.trim()) > 0
  } catch {
    /* the gateway may not be reachable from here; that is not the project's problem */
  }

  let answering = false
  const apiHost = env.GW_API_HOST
  if (apiHost) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(`https://${apiHost}/auth/v1/health`, {
        signal: controller.signal,
        redirect: 'manual',
      })
      clearTimeout(timer)
      // 401 is the healthy answer for a tenant without a session: the request reached its auth.
      answering = [200, 401].includes(res.status)
    } catch {
      answering = false
    }
  }

  const stages = stagesFor({ shape, onGateway, answering, expectedCount: expectedServices.length })
  const percent = percentFrom(stages)
  const ready = stages.every((s) => s.done)

  return {
    slug,
    status: project.status,
    stages,
    percent,
    ready,
    blockReason: blockReasonFor(stages, project.status),
    hint: ready ? null : 'Actions that need the running project are disabled until this finishes.',
  }
}

/** The container name a backup or a restore needs, exported so callers check the same thing. */
export function databaseContainer(slug: string): string {
  return tenantContainerName(slug, 'db')
}
