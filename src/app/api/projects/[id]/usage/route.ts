import { NextRequest, NextResponse } from 'next/server'
import { requireProjectPermission } from '@/lib/access'
import { projectUsageResponse } from '@/lib/project-usage-response'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const access = await requireProjectPermission(request, id, 'analytics:read')
    if (access.response) return access.response
    return await projectUsageResponse(access.project.slug)
  } catch (error) {
    console.error('Project usage error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
