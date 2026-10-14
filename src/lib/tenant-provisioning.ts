/**
 * Being born on the shared plane.
 *
 * Until now a project was created as a *copy of the upstream stack* and then made
 * sane by hand: someone slimmed the compose, someone assigned it a gateway port,
 * someone wrote a router file. That is why a project created through the panel was
 * fat and unreachable — the three steps existed only as a script nobody ran.
 *
 * This module is those three steps, in the order that matters:
 *
 *   1. **A slot** — the tenant's listener on the shared gateway. Allocated lowest-free
 *      and persisted in the project's own env (`GATEWAY_SLOT`), so the gateway config
 *      can be rebuilt from the database instead of from somebody's memory.
 *   2. **A slim stack** — `slimProjectCompose()` with the shared-plane services that
 *      are not hoisted yet named explicitly (`keepExtra`).
 *   3. **A router file** — `<slug>-studio.<domain>` to the panel and `<api-host>` to
 *      the tenant's listener, written into the directory the proxy actually reads.
 *
 * Registration on the gateway itself (network join + config rewrite + reload) happens
 * after the containers exist, and de-registration before they disappear.
 */
import { promises as fs } from 'fs'
import * as path from 'path'

import { prisma } from './db'
import { getTraefikDynamicPath } from './paths'
import {
  allocateTenantSlot,
  apiHostFor,
  buildTenantRouterConfig,
  platformBaseDomain,
  slotFromEnv,
  studioHostFor,
  tenantRouterFileName,
  type TenantSlot,
} from './tenant-gateway'
import {
  connectTenantNetwork,
  disconnectTenantNetwork,
  syncSharedGateway,
} from './tenant-gateway-apply'

/** Env keys the tenant's services and the panel read back. */
export const TENANT_ENV_KEYS = {
  slot: 'GATEWAY_SLOT',
  listenerPort: 'GATEWAY_LISTENER_PORT',
  publishedPort: 'GATEWAY_PUBLISHED_PORT',
  apiHost: 'GW_API_HOST',
  studioHost: 'GW_STUDIO_HOST',
} as const

/**
 * Shared-plane services that still live inside a project.
 *
 * `studio`, `meta` and `imgproxy` belong on the shared plane (ADR-0003); until that
 * lands a project must keep them or it has no dashboard. Kept as one named list so
 * hoisting them later is a deletion here, not a hunt through the creation path.
 */
export const RETAINED_SHARED_SERVICES = ['studio', 'meta', 'imgproxy'] as const

/** The domain every tenant host hangs off, or a clear error instead of a bad hostname. */
export function platformBaseDomainOrThrow(
  authUrl: string | undefined = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL
): string {
  const base = platformBaseDomain(authUrl)
  if (!base) {
    throw new Error(
      'Cannot build tenant hostnames: AUTH_URL (or NEXTAUTH_URL) is not set to the panel URL'
    )
  }
  return base
}

/** The hosts a project answers on. Pure, so the panel and the writer cannot disagree. */
export function tenantHosts(slug: string, baseDomain: string): { apiHost: string; studioHost: string } {
  return { apiHost: apiHostFor(slug, baseDomain), studioHost: studioHostFor(slug, baseDomain) }
}

/** A project's stored env, keyed by name — what the gateway writer reads its slot from. */
export async function projectEnvMap(slug: string): Promise<Record<string, string>> {
  const rows = await prisma.projectEnvVar.findMany({
    where: { project: { slug } },
    select: { key: true, value: true },
  })
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

/** Slots already handed out, read from the projects' stored env. */
export async function usedSlots(): Promise<number[]> {
  const rows = await prisma.projectEnvVar.findMany({
    where: { key: TENANT_ENV_KEYS.slot },
    select: { value: true },
  })

  const slots: number[] = []
  for (const row of rows) {
    const slot = slotFromEnv({ [TENANT_ENV_KEYS.slot]: row.value })
    if (slot !== null) slots.push(slot)
  }
  return slots
}

/**
 * The lowest free slot, for a project about to be created.
 *
 * Read-then-write, so two concurrent creations can race for the same slot. That is
 * acceptable because the loser's `docker compose up` collides on the gateway port and
 * says so loudly, while a *wrong* slot (two tenants on one listener) would answer one
 * tenant's host with another tenant's data — the failure mode worth engineering out.
 */
export async function allocateSlotForNewProject(): Promise<TenantSlot> {
  return allocateTenantSlot(await usedSlots())
}

/**
 * The env a project needs to be reachable on its own hosts.
 *
 * The public URLs matter as much as the slot: with `localhost` defaults, auth emails
 * and the Studio's own API snippets point clients at a host only the server can see.
 */
export function tenantEnvVars(slug: string, slot: TenantSlot, baseDomain: string): Record<string, string> {
  const { apiHost, studioHost } = tenantHosts(slug, baseDomain)
  const apiUrl = `https://${apiHost}`
  const studioUrl = `https://${studioHost}`

  return {
    [TENANT_ENV_KEYS.slot]: String(slot.slot),
    [TENANT_ENV_KEYS.listenerPort]: String(slot.listenerPort),
    [TENANT_ENV_KEYS.publishedPort]: String(slot.publishedPort),
    [TENANT_ENV_KEYS.apiHost]: apiHost,
    // Aliases the older readers (the Studio proxy before it learned the shared-plane names)
    // expect, so both conventions describe the same tenant.
    GW_HTTP_PORT: String(slot.publishedPort),
    GW_PUBLIC_HOST: apiHost,
    [TENANT_ENV_KEYS.studioHost]: studioHost,

    // Clients of the API, auth redirects and Studio's snippets all read these.
    API_EXTERNAL_URL: apiUrl,
    SUPABASE_PUBLIC_URL: apiUrl,
    SITE_URL: studioUrl,
    ADDITIONAL_REDIRECT_URLS: `${studioUrl},${apiUrl}`,
  }
}

/** The hosts a router file claims, from its `Host(`…`)` rules. */
export function routerFileHosts(content: string): string[] {
  return [...content.matchAll(/Host\(`([^`]+)`\)/g)].map((match) => match[1])
}

/**
 * Delete every router file that claims one of these hosts, except `keep`.
 *
 * One host must be served by one file. Projects cut over by hand left theirs under names this
 * module never writes — `<first label>.yaml`, or a bespoke `drill-shared-gateway.yaml` — and
 * two files claiming the same `Host` is a duplicate-router conflict. Pruning by *host* rather
 * than by filename catches every naming scheme, including ones invented later, and a stale
 * file for a deleted project would otherwise keep its hostname answering.
 */
export async function pruneRouterFilesClaimingHosts(hosts: string[], keep?: string): Promise<string[]> {
  const wanted = hosts.filter(Boolean)
  if (wanted.length === 0) return []

  const dir = getTraefikDynamicPath()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const removed: string[] = []
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue
    const file = path.join(dir, entry)
    if (keep && file === keep) continue
    let content: string
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    if (!routerFileHosts(content).some((host) => wanted.includes(host))) continue
    await fs.unlink(file)
    removed.push(file)
    console.log(`Removed the superseded router file ${file} (same host, older name)`)
  }
  return removed
}

/** Write the tenant's router file: its hosts resolve as soon as the stack answers. */
export async function writeTenantRouterFile(input: {
  slug: string
  slot: TenantSlot
  baseDomain: string
  panelHost?: string
  panelPort?: number
}): Promise<string> {
  const dir = getTraefikDynamicPath()
  await fs.mkdir(dir, { recursive: true })

  const file = path.join(dir, tenantRouterFileName(input.slug))
  await fs.writeFile(
    file,
    buildTenantRouterConfig({
      slug: input.slug,
      baseDomain: input.baseDomain,
      publishedPort: input.slot.publishedPort,
      panelHost: input.panelHost,
      panelPort: input.panelPort,
    })
  )

  const { apiHost, studioHost } = tenantHosts(input.slug, input.baseDomain)
  await pruneRouterFilesClaimingHosts([apiHost, studioHost], file)

  return file
}

/**
 * Remove this tenant's routers: the file this module owns, and any file still claiming one of
 * its hosts. Already-absent is a success.
 */
export async function removeTenantRouterFile(slug: string, hosts: string[] = []): Promise<boolean> {
  let removed = false
  try {
    await fs.unlink(path.join(getTraefikDynamicPath(), tenantRouterFileName(slug)))
    removed = true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }

  const pruned = await pruneRouterFilesClaimingHosts(hosts)
  return removed || pruned.length > 0
}

/**
 * After the stack is up: join the gateway to the tenant's network and rewrite its
 * config from the database.
 *
 * The join has to come *after* `compose up`, because the network the gateway is asked
 * to join is created by that compose run.
 */
export async function registerTenantOnGateway(slug: string): Promise<{
  tenants: number
  ports: Record<string, number>
  skipped: string[]
}> {
  await connectTenantNetwork(slug)
  return syncSharedGateway()
}

/**
 * On delete: unhook the gateway and rewrite, so no cluster is left pointing at a
 * removed project. Call it *after* the project row is gone — the rewrite is derived
 * from the database, so a still-present row would put the tenant straight back.
 */
export async function unregisterTenantFromGateway(slug: string): Promise<{
  tenants: number
  ports: Record<string, number>
  skipped: string[]
}> {
  await disconnectTenantNetwork(slug)
  return syncSharedGateway()
}
