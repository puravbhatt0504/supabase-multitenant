import { describe, expect, it } from 'vitest'

import { databaseFromContainerEnv } from '../src/lib/backup'

describe('databaseFromContainerEnv', () => {
  it('reads the database the running container was created with', () => {
    expect(databaseFromContainerEnv(['PATH=/bin', 'POSTGRES_DB=supabase_multitenant', 'X=1'])).toBe(
      'supabase_multitenant'
    )
  })

  it('falls back to postgres for a project born before POSTGRES_DB was set', () => {
    expect(databaseFromContainerEnv(['PATH=/bin'])).toBe('postgres')
    expect(databaseFromContainerEnv([])).toBe('postgres')
  })

  it('refuses a name that is not a plain identifier (it ends up in a command line)', () => {
    expect(databaseFromContainerEnv(['POSTGRES_DB=a; drop database x'])).toBe('postgres')
  })
})
