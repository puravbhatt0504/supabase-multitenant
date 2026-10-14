import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'

/**
 * Remove an organization.
 *
 * Refused while it still holds projects: deleting a project is a deliberate act with its own
 * endpoint, and cascading it from here would let one call destroy several databases by accident.
 */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params

    const organization = await prisma.organization.findFirst({
      where: { OR: [{ slug: id }, { id }] },
      include: { _count: { select: { projects: true } } },
    })
    if (!organization) return NextResponse.json({ error: 'No such organization' }, { status: 404 })

    if (organization._count.projects > 0) {
      return NextResponse.json(
        {
          error: `This organization still holds ${organization._count.projects} project(s); delete them first`,
        },
        { status: 409 }
      )
    }

    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.auditLog
      .create({
        data: {
          action: 'platform.organization.deleted',
          targetType: 'organization',
          targetId: organization.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { slug: organization.slug, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ deleted: true, slug: organization.slug })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
