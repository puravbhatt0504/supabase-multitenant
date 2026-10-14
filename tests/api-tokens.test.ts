import { describe, expect, it } from 'vitest'

import {
  API_TOKEN_PREFIX,
  bearerToken,
  hashApiToken,
  mintApiToken,
  scopeSatisfies,
  tokenHashesMatch,
} from '../src/lib/api-tokens'

describe('API tokens', () => {
  it('stores the hash, never the secret', () => {
    const { token, tokenHash, prefix } = mintApiToken()
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect(tokenHash).toBe(hashApiToken(token))
    expect(tokenHash).not.toContain(token.slice(API_TOKEN_PREFIX.length))
    // The stored prefix is a label for the list, not a usable credential.
    expect(prefix).not.toBe(token)
    expect(token.startsWith(prefix.replace('…', ''))).toBe(true)
  })

  it('mints a different secret every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => mintApiToken().token))
    expect(secrets.size).toBe(50)
  })

  it('compares hashes in constant time, and rejects a different length', () => {
    const { tokenHash } = mintApiToken()
    expect(tokenHashesMatch(tokenHash, tokenHash)).toBe(true)
    expect(tokenHashesMatch(tokenHash, hashApiToken('smbt_other'))).toBe(false)
    expect(tokenHashesMatch(tokenHash, 'short')).toBe(false)
  })

  it('reads only our own bearer tokens', () => {
    const req = (value?: string) =>
      new Request('https://panel.example/api/tokens', {
        headers: value ? { authorization: value } : {},
      })

    expect(bearerToken(req('Bearer smbt_abc'))).toBe('smbt_abc')
    expect(bearerToken(req('bearer smbt_abc'))).toBe('smbt_abc')
    // A session JWT or a Basic header must not be mistaken for a platform token.
    expect(bearerToken(req('Bearer some.jwt.value'))).toBeNull()
    expect(bearerToken(req('Basic abc'))).toBeNull()
    expect(bearerToken(req())).toBeNull()
  })

  it('treats scope as a ladder, so a weaker token cannot do more', () => {
    expect(scopeSatisfies('admin', 'admin')).toBe(true)
    expect(scopeSatisfies('admin', 'read')).toBe(true)
    expect(scopeSatisfies('write', 'admin')).toBe(false)
    expect(scopeSatisfies('read', 'write')).toBe(false)
    expect(scopeSatisfies('nonsense', 'read')).toBe(false)
  })
})
