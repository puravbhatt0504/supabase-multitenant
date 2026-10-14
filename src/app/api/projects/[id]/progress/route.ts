import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'
import { projectProgress } from '@/lib/project-progress'

/**
 * Where this project is: stages, percent, and why an action that needs it running is blocked.
 *
 * The project page polls this while a project is not ready, so the person sees progress instead of
 * pressing a button that will fail.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAccess(request, 'read')
    const { id } = await ctx.params

    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })

    return NextResponse.json(await projectProgress(project.slug))
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
