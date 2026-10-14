/**
 * Where a project's API answers, derived from its configuration.
 *
 * `SUPABASE_PUBLIC_URL` is the value the stack itself uses (edge functions build URLs from it), but
 * projects created before the shared gateway carry a legacy `http://localhost:<port>` there, while
 * the host they actually answer on is `GW_API_HOST`. The gateway-derived host is therefore preferred:
 * it is what a caller can reach, and the legacy value is only a fallback for very old projects.
 */
export function apiUrlFor(env: Record<string, string | undefined>): string | null {
  const explicit = (env.SUPABASE_PUBLIC_URL ?? '').trim()
  const gatewayHost = (env.GW_API_HOST ?? '').trim()

  if (gatewayHost) return `https://${gatewayHost}`
  if (!explicit) return null
  // A localhost URL is never reachable by a caller outside the container.
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(explicit)) return null
  return explicit.replace(/\/$/, '')
}
