import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { prisma } from './db'
import { isSystemAdmin } from './system-admin'

/**
 * Programmatic access to the platform (#160).
 *
 * A person uses the panel through a browser session; an agent or a script has no browser, so it
 * needs a credential of its own. A token is that credential: it acts as the platform, with the
 * rights of whoever minted it, without carrying a password or a cookie.
 *
 * Design rules, each of which is here for a reason:
 *
 *  - The secret is shown **once**, at creation. Only its SHA-256 is stored, so a dump of the table
 *    is not a set of working credentials. A short prefix is stored in the clear so a token can be
 *    recognised in a list and revoked without revealing it.
 *  - A token is **not** a frozen permission. Its creator's current role is re-read on every use, so
 *    demoting someone immediately disables the tokens they minted — a JWT would have kept working
 *    until it expired, which is the failure mode this avoids.
 *  - Scope is explicit and narrow: `read` may look, `write` may also act, `admin` is required for
 *    anything that reaches into a project's data (SQL, user creation, credentials).
 */

export const API_TOKEN_PREFIX = 'smbt_'

/** What a token may do. Ordered, so a comparison is "at least". */
export const API_TOKEN_SCOPES = ['read', 'write', 'admin'] as const
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number]

export class ApiTokenError extends Error {
  constructor(
    message: string,
    readonly status: number = 401
  ) {
    super(message)
    this.name = 'ApiTokenError'
  }
}

/** Scope ranks, so `write` satisfies a `read` requirement but not the other way round. */
export function scopeSatisfies(granted: string, required: ApiTokenScope): boolean {
  const rank = (scope: string) => API_TOKEN_SCOPES.indexOf(scope as ApiTokenScope)
  const grantedRank = rank(granted)
  const requiredRank = rank(required)
  if (grantedRank === -1) return false
  return grantedRank >= requiredRank
}

/** A fresh token: the secret to hand out, and the three values we store. */
export function mintApiToken(): { token: string; tokenHash: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url')
  const token = `${API_TOKEN_PREFIX}${secret}`
  return { token, tokenHash: hashApiToken(token), prefix: `${token.slice(0, 12)}…` }
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison, so a wrong token cannot be discovered byte by byte. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** The token in an Authorization header, if it looks like ours. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match) return null
  return match[1].startsWith(API_TOKEN_PREFIX) ? match[1] : null
}

export interface PlatformActor {
  kind: 'session' | 'token'
  userId: string
  email: string
  scope: ApiTokenScope
  tokenId?: string
  tokenName?: string
}

/**
 * Who is calling: a browser session, or a token acting for its creator.
 *
 * Returns null when neither is present or valid — callers turn that into a 401. Throws
 * `ApiTokenError` when a token is present but unusable (revoked, expired, creator no longer a
 * system administrator), because that is a different problem from "not signed in".
 */
export async function resolvePlatformActor(request: Request): Promise<PlatformActor | null> {
  const presented = bearerToken(request)

  if (presented) {
    const record = await prisma.apiToken.findUnique({ where: { tokenHash: hashApiToken(presented) } })
    if (!record) throw new ApiTokenError('Unknown API token')
    if (record.revokedAt) throw new ApiTokenError('This API token has been revoked', 403)
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      throw new ApiTokenError('This API token has expired', 403)
    }

    const creator = record.createdById
      ? await prisma.user.findUnique({ where: { id: record.createdById } })
      : null
    if (!creator) throw new ApiTokenError('The account that minted this token no longer exists', 403)
    // Re-read the role every time: a token must not outlive the authority that justified it.
    if (!isSystemAdmin(creator.role)) {
      throw new ApiTokenError('The account that minted this token is no longer a system administrator', 403)
    }

    await prisma.apiToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined)

    return {
      kind: 'token',
      userId: creator.id,
      email: creator.email ?? '',
      scope: (record.scope as ApiTokenScope) ?? 'admin',
      tokenId: record.id,
      tokenName: record.name,
    }
  }

  const { getSessionUser } = await import('./auth')
  const user = await getSessionUser()
  if (!user) return null
  if (!isSystemAdmin(user.role)) return null
  return { kind: 'session', userId: user.id, email: user.email, scope: 'admin' }
}

/** The actor, or a 401/403 explaining why not — the shape every protected route wants. */
export async function requirePlatformAccess(
  request: Request,
  required: ApiTokenScope = 'read'
): Promise<PlatformActor> {
  const actor = await resolvePlatformActor(request)
  if (!actor) {
    throw new ApiTokenError('Sign in, or send an API token as `Authorization: Bearer <token>`', 401)
  }
  if (!scopeSatisfies(actor.scope, required)) {
    throw new ApiTokenError(`This token has scope "${actor.scope}"; "${required}" is required`, 403)
  }
  return actor
}

/** Turn a thrown `ApiTokenError` into the response the caller deserves. */
export function apiTokenErrorResponse(error: unknown): Response {
  if (error instanceof ApiTokenError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: message }, { status: 500 })
}
