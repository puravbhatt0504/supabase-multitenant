import { describe, expect, it } from 'vitest'

import { TenantDbAuthError, alterPostgresPasswordStatement } from '../src/lib/tenant-db-auth'

describe('reconciling the postgres role password', () => {
  it('builds the statement the superuser runs', () => {
    expect(alterPostgresPasswordStatement('abc123')).toBe("alter role postgres with password 'abc123'")
  })

  it('escapes quotes instead of breaking out of the literal', () => {
    // A password containing a quote is legitimate, and the result must still be one statement.
    expect(alterPostgresPasswordStatement("pa'ss")).toBe("alter role postgres with password 'pa''ss'")
    const hostile = "x'; drop table users; --"
    const statement = alterPostgresPasswordStatement(hostile)
    expect(statement.startsWith("alter role postgres with password '")).toBe(true)
    // Doubling all quotes means the injected statement stays inside the string.
    expect(statement).toBe("alter role postgres with password 'x''; drop table users; --'")
  })

  it('refuses an empty password rather than locking the role out', () => {
    expect(() => alterPostgresPasswordStatement('')).toThrow(TenantDbAuthError)
  })
})
