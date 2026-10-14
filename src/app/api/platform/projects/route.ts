import { NextRequest, NextResponse } from 'next/server'

import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'
import { prisma } from '@/lib/db'
import { createProject } from '@/lib/project'

/** Every project on the platform, and creation of one — for a token, not a browser. */
export async function GET(request: NextRequest) {
  try {
    await requirePlatformAccess(request, 'read')
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, slug: true, status: true, organizationId: true,
        createdAt: true, organization: { select: { name: true, slug: true } },
      },
    })
    return NextResponse.json({ projects })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const body = (await request.json().catch(() => ({}))) as {
      name?: string
      description?: string
      organizationId?: string
      organization?: string
      region?: string
      databasePassword?: string
    }

    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    // Accept the organization by id or by slug: a script usually knows the name it created.
    let organizationId = body.organizationId ?? null
    if (!organizationId && body.organization) {
      const org = await prisma.organization.findFirst({
        where: { OR: [{ id: body.organization }, { slug: body.organization }] },
      })
      if (!org) return NextResponse.json({ error: 'No such organization' }, { status: 404 })
      organizationId = org.id
    }

    // createProject reports success rather than throwing, so an unusable result is surfaced here
    // instead of half-written rows.
    const created = await createProject(name, actor.userId, body.description, {
      organizationId,
      region: body.region,
      databasePassword: body.databasePassword,
    })
    if (!created?.success || !created.project) {
      return NextResponse.json(
        { error: 'Project creation failed', detail: created?.error ?? null },
        { status: 500 }
      )
    }
    const project = created.project

    await prisma.auditLog
      .create({
        data: {
          action: 'platform.project.created',
          targetType: 'project',
          targetId: project.id,
          actorId: actor.userId,
          actorEmail: actor.email,
          metadata: { name, slug: project.slug, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return NextResponse.json({ project }, { status: 201 })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
