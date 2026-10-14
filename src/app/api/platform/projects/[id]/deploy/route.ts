import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'
import { deployProject } from '@/lib/project'

/** Bring a project's stack up — the same work the panel's Deploy button does. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params

    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })

    const result = await deployProject(project.id)

    await prisma.auditLog
      .create({
        data: {
          action: 'platform.project.deployed',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { slug: project.slug, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ deployed: true, slug: project.slug, result })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
