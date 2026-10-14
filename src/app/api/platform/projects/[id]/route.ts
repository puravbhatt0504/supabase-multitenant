import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'
import { deleteProject } from '@/lib/project'

/** One project: read it, or remove it and everything it owns. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAccess(request, 'read')
    const { id } = await ctx.params
    const project = await prisma.project.findFirst({
      where: { OR: [{ slug: id }, { id }] },
      include: { organization: { select: { name: true, slug: true } } },
    })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    return NextResponse.json({ project })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params

    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })

    const cleanup = await deleteProject(project.id)

    await prisma.auditLog
      .create({
        data: {
          action: 'platform.project.deleted',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { slug: project.slug, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ deleted: true, slug: project.slug, cleanup })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
