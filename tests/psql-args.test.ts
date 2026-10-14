import { describe, expect, it } from 'vitest'

import { psqlArgs } from '../src/app/api/projects/[id]/sql/route'

describe('psql arguments for the SQL endpoint', () => {
  it('asks for the readable table by default', () => {
    const args = psqlArgs('supabase_multitenant')
    expect(args).toContain('-f')
    expect(args).not.toContain('-tA')
  })

  it('asks for one value per line when a script is the caller', () => {
    // Parsing psql's aligned table means regexing around headers and separators, which is how a
    // caller ends up reading the header row as the value — the failure this option removes.
    expect(psqlArgs('supabase_multitenant', 'unaligned')).toContain('-tA')
  })

  it('carries the database and stops on the first error', () => {
    const args = psqlArgs('tenant_db', 'unaligned')
    expect(args[args.indexOf('-d') + 1]).toBe('tenant_db')
    expect(args).toContain('-v')
    expect(args).toContain('ON_ERROR_STOP=1')
  })
})
