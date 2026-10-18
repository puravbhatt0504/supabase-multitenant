import { NextRequest, NextResponse } from 'next/server'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'
import { projectLogsResponse } from '@/lib/project-logs-response'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params
    const project = await prisma.project.findFirst({ where: { OR: [{ slug: id }, { id }] } })
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    return await projectLogsResponse(project.slug, request.nextUrl.searchParams)
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
