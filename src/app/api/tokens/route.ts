import { prisma } from '@/lib/db'
import {
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  apiTokenErrorResponse,
  mintApiToken,
  requirePlatformAccess,
} from '@/lib/api-tokens'

/**
 * Manage your own API tokens.
 *
 * `POST` returns the secret exactly once — it is not stored anywhere in readable form, so a lost
 * token is replaced rather than recovered.
 */
export async function GET(request: Request) {
  try {
    const actor = await requirePlatformAccess(request, 'read')
    const tokens = await prisma.apiToken.findMany({
      where: { createdById: actor.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, scope: true,
        createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true,
      },
    })
    return Response.json({ tokens })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')

    const body = (await request.json().catch(() => ({}))) as {
      name?: string
      scope?: string
      expiresInDays?: number
    }
    const name = (body.name ?? '').trim() || 'API token'
    const scope = (body.scope ?? 'admin') as ApiTokenScope
    if (!API_TOKEN_SCOPES.includes(scope)) {
      return Response.json(
        { error: `scope must be one of ${API_TOKEN_SCOPES.join(', ')}` },
        { status: 400 }
      )
    }

    const { token, tokenHash, prefix } = mintApiToken()
    const record = await prisma.apiToken.create({
      data: {
        name,
        tokenHash,
        prefix,
        scope,
        createdById: actor.userId,
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
      },
      select: { id: true, name: true, prefix: true, scope: true, createdAt: true, expiresAt: true },
    })

    await prisma.auditLog
      .create({
        data: {
          action: 'api_token.created',
          targetType: 'api_token',
          targetId: record.id,
          actorId: actor.userId,
          metadata: { name, scope, via: actor.kind },
        },
      })
      .catch(() => undefined)

    return Response.json(
      {
        token,
        warning: 'This secret is shown once and cannot be retrieved again. Store it now.',
        ...record,
      },
      { status: 201 }
    )
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
