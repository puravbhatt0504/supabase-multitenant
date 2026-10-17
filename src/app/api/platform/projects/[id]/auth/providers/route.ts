import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { readProviders, saveProvider } from '@/lib/auth-provider-settings'
import { prisma } from '@/lib/db'

/**
 * Social sign-in providers of a project, for a platform token. The same operation as the panel's
 * `/api/projects/<id>/auth/providers`; the path segment is a slug or an id. The secret is
 * write-only here too.
 */
async function resolve(idOrSlug: string) {
  return prisma.project.findFirst({ where: { OR: [{ slug: idOrSlug }, { id: idOrSlug }] }, select: { id: true, slug: true } })
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAccess(request, 'read')
    const project = await resolve((await ctx.params).id)
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    return NextResponse.json({ providers: await readProviders(project.id) })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const project = await resolve((await ctx.params).id)
    if (!project) return NextResponse.json({ error: 'No such project' }, { status: 404 })

    const body = (await request.json().catch(() => null)) as {
      provider?: string
      enabled?: boolean
      clientId?: string
      secret?: string
    } | null
    if (!body || typeof body.provider !== 'string' || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Send {"provider": "...", "enabled": true|false}' }, { status: 400 })
    }

    const result = await saveProvider(project.id, {
      provider: body.provider,
      enabled: body.enabled,
      clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
      secret: typeof body.secret === 'string' && body.secret ? body.secret : undefined,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    await prisma.auditLog
      .create({
        data: {
          action: 'project.auth_provider_write',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          metadata: { slug: project.slug, provider: body.provider, enabled: body.enabled, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ providers: result.providers, recreated: result.recreated })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
