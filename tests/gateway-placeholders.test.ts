import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { htpasswdFromBasicAuth, resolvePlatformPlaceholders } from '../src/lib/gateway'

const BASIC = Buffer.from('supabase:smbt-shared-dashboard').toString('base64')

describe('htpasswd from a Basic credential', () => {
  it('translates the deployment’s Basic header value into the form envoy accepts', () => {
    // The deployment stores base64(`user:password`) because the panel sends it as an
    // `authorization` header; envoy's basic_auth wants `user:hash`. Handing envoy the base64
    // string makes it reject the config, and since the filter is in the listener chain it
    // creates no listeners at all — every tenant on the gateway goes dark.
    const value = htpasswdFromBasicAuth(BASIC)
    const expected = createHash('sha1').update('smbt-shared-dashboard').digest('base64')
    expect(value).toBe(`supabase:{SHA}${expected}`)
  })

  it('accepts a value that is already htpasswd', () => {
    expect(htpasswdFromBasicAuth('alice:$2y$05$abcdefghijklmnop')).toBe(
      'alice:$2y$05$abcdefghijklmnop'
    )
  })

  it('returns null for nothing usable, rather than emitting a broken config', () => {
    expect(htpasswdFromBasicAuth(undefined)).toBeNull()
    expect(htpasswdFromBasicAuth('   ')).toBeNull()
    expect(htpasswdFromBasicAuth(Buffer.from('no-colon-here').toString('base64'))).toBeNull()
  })
})

describe('platform placeholders', () => {
  const token = '${DASHBOARD_BASIC_AUTH}'

  it('fills the shared dashboard credential', () => {
    const env = { SHARED_GATEWAY_BASIC_AUTH: BASIC }
    const out = resolvePlatformPlaceholders(`inline_string: '${token}'`, env)
    expect(out).not.toContain('DASHBOARD_BASIC_AUTH')
    expect(out).toMatch(/inline_string: 'supabase:\{SHA\}[A-Za-z0-9+/=]+'/)
  })

  it('leaves a fragment with no platform placeholders untouched', () => {
    const fragment = 'inline_string: "just a log format"'
    expect(resolvePlatformPlaceholders(fragment, {})).toBe(fragment)
  })

  it('refuses to write a config it cannot authenticate, instead of shipping the placeholder', () => {
    // Shipping it looks successful and takes the gateway down: envoy rejects the whole
    // listener chain. Better to fail here, loudly, with the variable to set.
    expect(() => resolvePlatformPlaceholders(`users: '${token}'`, {})).toThrow(
      /SHARED_GATEWAY_BASIC_AUTH/
    )
  })

  it('prefers the shared-gateway variable and falls back to the dashboard one', () => {
    const fromFallback = resolvePlatformPlaceholders(token, { DASHBOARD_BASIC_AUTH: BASIC })
    expect(fromFallback).toContain('supabase:{SHA}')
  })
})
