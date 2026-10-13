import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { isSystemAdmin } from '@/lib/system-admin'
import { projectsForGateway, syncSharedGateway } from '@/lib/tenant-gateway-apply'
import { slotFromEnv, tenantSlot } from '@/lib/tenant-gateway'
import { platformBaseDomainOrThrow, writeTenantRouterFile } from '@/lib/tenant-provisioning'

export const dynamic = 'force-dynamic'

/**
 * Re-derive the shared gateway from the database.
 *
 * The gateway's clusters and listeners are *generated*, never hand-edited, so this is the
 * single repair action for the whole plane: it re-writes every tenant's router file, joins
 * each tenant network, rewrites the envoy config and reloads it. Run it after a machine
 * restart, after a manual `docker` change, or when a project's host stops answering.
 *
 * Admin-only, and deliberately a 404 for everyone else: whether a host is reachable is not
 * information a tenant should be able to probe.
 *
 * Projects without a `GATEWAY_SLOT` are reported, never guessed at — two tenants on one
 * listener would answer one project's host with another project's data.
 */
export async function POST() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, disabled: true },
  })
  if (!record || record.disabled || !isSystemAdmin(record.role)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const baseDomain = platformBaseDomainOrThrow()
    const projects = await projectsForGateway()

    const routers: Array<{ slug: string; file?: string; error?: string }> = []
    const missingSlots: string[] = []

    for (const project of projects) {
      const slot = slotFromEnv(project.env)
      if (slot === null) {
        missingSlots.push(project.slug)
        continue
      }
      try {
        const file = await writeTenantRouterFile({
          slug: project.slug,
          slot: tenantSlot(slot),
          baseDomain,
        })
        routers.push({ slug: project.slug, file })
      } catch (error) {
        routers.push({
          slug: project.slug,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const synced = await syncSharedGateway()

    return NextResponse.json({
      ok: true,
      tenants: synced.tenants,
      ports: synced.ports,
      skipped: synced.skipped,
      missingSlots,
      routers,
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Gateway sync failed' },
      { status: 500 }
    )
  }
}
