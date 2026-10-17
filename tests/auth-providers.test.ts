import { describe, expect, it } from 'vitest'

import {
  callbackUrl,
  ensureAuthProviderEnv,
  providerEnvEntries,
  providerKeys,
  providerViews,
  validateProviderInput,
} from '../src/lib/auth-providers'

const none = { hasSecret: false, hasClientId: false }

describe('providerKeys / callbackUrl', () => {
  it('uses the names GoTrue reads', () => {
    expect(providerKeys('github').secret).toBe('GOTRUE_EXTERNAL_GITHUB_SECRET')
    expect(providerKeys('google').redirect).toBe('GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI')
  })

  it('is the Supabase-compatible callback, with no doubled slash', () => {
    expect(callbackUrl('https://p.example.com/')).toBe('https://p.example.com/auth/v1/callback')
  })
})

describe('validateProviderInput', () => {
  it('rejects a provider that is not offered', () => {
    expect(validateProviderInput({ provider: 'myspace', enabled: false }, none)).toMatch(/Unknown provider/)
  })

  it('requires an id and a secret to enable', () => {
    expect(validateProviderInput({ provider: 'google', enabled: true }, none)).toMatch(/client ID/)
    expect(validateProviderInput({ provider: 'google', enabled: true, clientId: 'x' }, none)).toMatch(/secret/)
  })

  it('lets an already-stored secret be kept', () => {
    expect(
      validateProviderInput({ provider: 'google', enabled: true }, { hasSecret: true, hasClientId: true })
    ).toBeNull()
  })

  it('refuses a value that would start a new line in the env file', () => {
    expect(
      validateProviderInput({ provider: 'github', enabled: true, clientId: 'a\nB=1', secret: 's' }, none)
    ).toMatch(/single line/)
  })

  it('lets a provider be switched off without credentials', () => {
    expect(validateProviderInput({ provider: 'github', enabled: false }, none)).toBeNull()
  })
})

describe('providerEnvEntries', () => {
  it('writes all four values when enabling', () => {
    expect(
      providerEnvEntries({ provider: 'github', enabled: true, clientId: ' id ', secret: 's' }, 'https://a.com')
    ).toEqual({
      GOTRUE_EXTERNAL_GITHUB_ENABLED: 'true',
      GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: 'https://a.com/auth/v1/callback',
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: 'id',
      GOTRUE_EXTERNAL_GITHUB_SECRET: 's',
    })
  })

  it('disabling keeps the credentials so they need not be pasted again', () => {
    const entries = providerEnvEntries({ provider: 'github', enabled: false }, 'https://a.com')
    expect(entries.GOTRUE_EXTERNAL_GITHUB_ENABLED).toBe('false')
    expect('GOTRUE_EXTERNAL_GITHUB_SECRET' in entries).toBe(false)
  })
})

describe('providerViews', () => {
  it('never exposes the secret, only whether one exists', () => {
    const views = providerViews(
      { GOTRUE_EXTERNAL_GITHUB_ENABLED: 'true', GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: 'id', GOTRUE_EXTERNAL_GITHUB_SECRET: 'topsecret' },
      'https://a.com'
    )
    const github = views.find((v) => v.id === 'github')!
    expect(github).toMatchObject({ enabled: true, clientId: 'id', hasSecret: true })
    expect(JSON.stringify(views)).not.toContain('topsecret')
  })
})

const COMPOSE = `services:
  auth:
    image: supabase/gotrue
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      # GOTRUE_EXTERNAL_GOOGLE_ENABLED: \${GOOGLE_ENABLED}
  rest:
    image: postgrest
    environment:
      PGRST_DB_SCHEMAS: public
`

describe('ensureAuthProviderEnv', () => {
  it('adds the provider variables to the auth service only', () => {
    const out = ensureAuthProviderEnv(COMPOSE)
    const [auth, rest] = out.split('  rest:')
    expect(auth).toContain('GOTRUE_EXTERNAL_GITHUB_SECRET: ${GOTRUE_EXTERNAL_GITHUB_SECRET:-}')
    expect(auth).toContain('GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOTRUE_EXTERNAL_GOOGLE_ENABLED:-false}')
    expect(rest).not.toContain('GOTRUE_EXTERNAL')
  })

  it('is idempotent', () => {
    const once = ensureAuthProviderEnv(COMPOSE)
    expect(ensureAuthProviderEnv(once)).toBe(once)
  })

  it('does not overwrite a line that is already there', () => {
    const edited = COMPOSE.replace(
      '      GOTRUE_API_HOST: 0.0.0.0',
      '      GOTRUE_API_HOST: 0.0.0.0\n      GOTRUE_EXTERNAL_GITHUB_ENABLED: "true"'
    )
    const out = ensureAuthProviderEnv(edited)
    expect(out.match(/GOTRUE_EXTERNAL_GITHUB_ENABLED:/g)).toHaveLength(1)
    expect(out).toContain('GOTRUE_EXTERNAL_GITHUB_ENABLED: "true"')
  })

  it('leaves a compose without an auth service untouched', () => {
    expect(ensureAuthProviderEnv('services:\n  db:\n    image: pg\n')).toBe('services:\n  db:\n    image: pg\n')
  })
})
