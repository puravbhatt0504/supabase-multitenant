import { NextRequest, NextResponse } from 'next/server'
import { requireProjectPermission } from '@/lib/access'
import { projectLogsResponse } from '@/lib/project-logs-response'

/** Logs of one service of a project. Operational data, so it needs the deploy permission. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const access = await requireProjectPermission(request, id, 'project:deploy')
    if (access.response) return access.response
    return await projectLogsResponse(access.project.slug, request.nextUrl.searchParams)
  } catch (error) {
    console.error('Project logs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
