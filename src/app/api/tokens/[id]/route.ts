import { prisma } from '@/lib/db'
import { apiTokenErrorResponse, requirePlatformAccess } from '@/lib/api-tokens'

/** Revoke a token. Deleted is not the same as revoked — the row stays, so the audit trail is intact. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePlatformAccess(request, 'admin')
    const { id } = await ctx.params

    const token = await prisma.apiToken.findUnique({ where: { id } })
    if (!token) return Response.json({ error: 'No such token' }, { status: 404 })
    if (token.createdById !== actor.userId) {
      // A token may not revoke another account's tokens, even a system administrator's own: the
      // panel is the place for that, where the action is visible.
      return Response.json({ error: 'This token belongs to another account' }, { status: 403 })
    }

    await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } })
    await prisma.auditLog
      .create({
        data: {
          action: 'api_token.revoked', targetType: 'api_token', targetId: id,
          actorId: actor.userId, metadata: { via: actor.kind },
        },
      })
      .catch(() => undefined)

    return Response.json({ revoked: true, id })
  } catch (error) {
    return apiTokenErrorResponse(error)
  }
}
