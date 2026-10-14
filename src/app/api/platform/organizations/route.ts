import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'

/**
 * Organizations, for a token rather than a browser.
 *
 * The panel's own routes are session-scoped: they act as the signed-in person, with what their
 * membership allows. A platform token is not that — it acts as the platform, which is what an
 * integration test or an operator's script needs.
 */
function slugFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAccess(request, 'read')
    const organizations = await prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { projects: true, members: true } } },
    })
    return NextResponse.json({ organizations })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const body = (await request.json().catch(() => ({}))) as {
      name?: string
      type?: string
      plan?: string
    }

    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    const type = String(body.type ?? 'Personal')
    const plan = String(body.plan ?? 'Free')
    if (!['Free', 'Pro', 'Team'].includes(plan)) {
      return NextResponse.json({ error: 'plan must be Free, Pro or Team' }, { status: 400 })
    }

    // A unique slug even when several organizations share a name.
    const base = slugFor(name) || 'org'
    let slug = base
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clash = await prisma.organization.findUnique({ where: { slug } })
      if (!clash) break
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
    }

    const organization = await prisma.organization.create({
      data: {
        name,
        slug,
        plan,
        type,
        ownerId: actor.userId,
        members: { create: [{ userId: actor.userId, role: 'owner' }] },
      },
    })

    await prisma.auditLog
      .create({
        data: {
          action: 'platform.organization.created',
          targetType: 'organization',
          targetId: organization.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { name, slug, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ organization }, { status: 201 })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
