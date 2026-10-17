import { NextRequest, NextResponse } from 'next/server'

import { recordAudit, requireProjectPermission } from '@/lib/access'
import { readProviders, saveProvider } from '@/lib/auth-provider-settings'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * Social sign-in providers for one project (Google, GitHub, ...).
 *
 * Reading is `env:read`, writing `env:write`. The client secret is write-only: the response says
 * whether one is on file, never what it is. The audit entry records the provider and the new
 * state, never the credentials.
 */

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  try {
    const auth = await requireProjectPermission(request, id, 'env:read')
    if (auth.response) return auth.response

    const providers = await readProviders(id)
    if (!providers) return NextResponse.json({ error: 'No such project' }, { status: 404 })
    return NextResponse.json({ providers })
  } catch (error) {
    console.error('Get auth providers error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  try {
    const auth = await requireProjectPermission(request, id, 'env:write')
    if (auth.response) return auth.response

    const body = (await request.json().catch(() => null)) as {
      provider?: string
      enabled?: boolean
      clientId?: string
      secret?: string
    } | null
    if (!body || typeof body.provider !== 'string' || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Send {"provider": "...", "enabled": true|false}' }, { status: 400 })
    }

    const result = await saveProvider(id, {
      provider: body.provider,
      enabled: body.enabled,
      clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
      secret: typeof body.secret === 'string' && body.secret ? body.secret : undefined,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    await recordAudit({
      action: 'project.auth_provider_write',
      organizationId: auth.project.organizationId,
      actorId: auth.session.user.id,
      actorEmail: auth.session.user.email,
      targetType: 'project',
      targetId: id,
      metadata: { provider: body.provider, enabled: body.enabled, recreated: result.recreated },
    })

    return NextResponse.json({ providers: result.providers, recreated: result.recreated })
  } catch (error) {
    console.error('Save auth provider error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
