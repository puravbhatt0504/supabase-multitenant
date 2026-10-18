import { NextRequest, NextResponse } from 'next/server'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'
import { projectUsageResponse } from '@/lib/project-usage-response'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAccess(request, 'read')
    const { id } = await ctx.params
    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    return await projectUsageResponse(project.slug)
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
