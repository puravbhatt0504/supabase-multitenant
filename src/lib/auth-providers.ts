/**
 * Social sign-in providers for a project's Auth service (GoTrue).
 *
 * GoTrue reads each provider from its environment: `GOTRUE_EXTERNAL_<NAME>_ENABLED`, `_CLIENT_ID`,
 * `_SECRET` and `_REDIRECT_URI`. Self-hosted Studio has no screen that writes them, so the panel owns
 * this: it stores the four values in the project's `.env`, makes sure the project's compose passes
 * them to the `auth` container, and recreates only that container.
 *
 * Everything here is pure so the rules are testable without a platform.
 */

export interface AuthProviderInfo {
  id: string
  label: string
  /** Where the account owner registers the OAuth app. */
  consoleUrl: string
}

/**
 * Providers whose GoTrue configuration is exactly client id + secret. Apple (a signed-JWT secret),
 * Azure (a tenant URL) and the OIDC family need more than that and are deliberately not offered
 * here until the screen can ask for the extra field.
 */
export const AUTH_PROVIDERS: AuthProviderInfo[] = [
  { id: 'google', label: 'Google', consoleUrl: 'https://console.cloud.google.com/apis/credentials' },
  { id: 'github', label: 'GitHub', consoleUrl: 'https://github.com/settings/developers' },
  { id: 'gitlab', label: 'GitLab', consoleUrl: 'https://gitlab.com/-/user_settings/applications' },
  { id: 'discord', label: 'Discord', consoleUrl: 'https://discord.com/developers/applications' },
  { id: 'bitbucket', label: 'Bitbucket', consoleUrl: 'https://bitbucket.org/account/settings/app-passwords/' },
]

export const AUTH_PROVIDER_IDS = AUTH_PROVIDERS.map((p) => p.id)

export function providerKeys(id: string) {
  const name = id.toUpperCase()
  return {
    enabled: `GOTRUE_EXTERNAL_${name}_ENABLED`,
    clientId: `GOTRUE_EXTERNAL_${name}_CLIENT_ID`,
    secret: `GOTRUE_EXTERNAL_${name}_SECRET`,
    redirect: `GOTRUE_EXTERNAL_${name}_REDIRECT_URI`,
  }
}

/** The URL the account owner must register with the provider as the authorised redirect. */
export function callbackUrl(apiExternalUrl: string): string {
  return `${apiExternalUrl.replace(/\/+$/, '')}/auth/v1/callback`
}

export interface ProviderInput {
  provider: string
  enabled: boolean
  clientId?: string
  /** Omitted when the secret already on file should be kept. */
  secret?: string
}

/** Returns an error message, or null when the input can be applied. */
export function validateProviderInput(
  input: ProviderInput,
  state: { hasSecret: boolean; hasClientId: boolean }
): string | null {
  if (!AUTH_PROVIDER_IDS.includes(input.provider)) return `Unknown provider "${input.provider}"`
  if (!input.enabled) return null

  const clientId = input.clientId?.trim() ?? ''
  if (!clientId && !state.hasClientId) return 'A client ID is required to enable a provider'
  if (!input.secret && !state.hasSecret) return 'A client secret is required to enable a provider'
  // These end up in a file read by `docker compose`; a newline would start a new variable.
  if (/[\r\n]/.test(clientId) || /[\r\n]/.test(input.secret ?? '')) {
    return 'Values must be a single line'
  }
  return null
}

/**
 * The `.env` entries for one provider. `null` removes a line (see `mergeEnvFile`).
 *
 * Disabling keeps the client ID and secret: switching a provider off for a moment should not mean
 * pasting the credentials again.
 */
export function providerEnvEntries(
  input: ProviderInput,
  apiExternalUrl: string
): Record<string, string | null> {
  const keys = providerKeys(input.provider)
  const entries: Record<string, string | null> = {
    [keys.enabled]: input.enabled ? 'true' : 'false',
    [keys.redirect]: callbackUrl(apiExternalUrl),
  }
  if (input.clientId !== undefined && input.clientId.trim()) entries[keys.clientId] = input.clientId.trim()
  if (input.secret) entries[keys.secret] = input.secret
  return entries
}

export interface ProviderView {
  id: string
  label: string
  consoleUrl: string
  enabled: boolean
  clientId: string
  /** Whether a secret is on file. The secret itself is never returned. */
  hasSecret: boolean
  callbackUrl: string
}

export function providerViews(env: Record<string, string>, apiExternalUrl: string): ProviderView[] {
  return AUTH_PROVIDERS.map((p) => {
    const keys = providerKeys(p.id)
    return {
      id: p.id,
      label: p.label,
      consoleUrl: p.consoleUrl,
      enabled: env[keys.enabled] === 'true',
      clientId: env[keys.clientId] ?? '',
      hasSecret: Boolean(env[keys.secret]),
      callbackUrl: callbackUrl(apiExternalUrl),
    }
  })
}

/**
 * Make the `auth` service of an existing project's compose pass every provider variable through.
 * Idempotent, and only adds lines that are missing, so a hand-edited value is never overwritten.
 *
 * Projects created before this feature have an `auth` block with the provider lines commented out;
 * without this the values would land in `.env` and never reach the container.
 */
export function ensureAuthProviderEnv(composeContent: string): string {
  const serviceMatch = composeContent.match(/^([ \t]*)auth:[ \t]*$/m)
  if (!serviceMatch) return composeContent

  const serviceIndent = serviceMatch[1]
  const blockStart = (serviceMatch.index ?? 0) + serviceMatch[0].length
  const rest = composeContent.slice(blockStart)
  const endMatch = rest.match(new RegExp(`\\n${serviceIndent}\\S|\\n\\S`))
  const blockEnd = endMatch?.index !== undefined ? blockStart + endMatch.index : composeContent.length
  const block = composeContent.slice(blockStart, blockEnd)

  const environmentMatch = block.match(/^([ \t]*)environment:[ \t]*$/m)
  if (!environmentMatch) return composeContent // not a GoTrue block we understand; leave it alone

  const additions: string[] = []
  for (const p of AUTH_PROVIDERS) {
    const keys = providerKeys(p.id)
    const lines: Array<[string, string]> = [
      [keys.enabled, '${' + keys.enabled + ':-false}'],
      [keys.clientId, '${' + keys.clientId + ':-}'],
      [keys.secret, '${' + keys.secret + ':-}'],
      [keys.redirect, '${' + keys.redirect + ':-}'],
    ]
    for (const [key, value] of lines) {
      if (!new RegExp(`^[ \\t]*${key}:`, 'm').test(block)) additions.push(`${key}: ${value}`)
    }
  }
  if (additions.length === 0) return composeContent

  const keyIndent = `${environmentMatch[1]}  `
  const inserted = additions.map((line) => `\n${keyIndent}${line}`).join('')
  const at = blockStart + (environmentMatch.index ?? 0) + environmentMatch[0].length
  return `${composeContent.slice(0, at)}${inserted}${composeContent.slice(at)}`
}
