import { describe, it, expect } from 'vitest'
import { filterRestoreList, keepRestoreEntry, listingHasEndUsers } from '../src/lib/backup-restore-list'

const LISTING = `;
; Archive created
13; 2615 16458 SCHEMA - auth supabase_admin
16; 2615 2200 SCHEMA - public pg_database_owner
3969; 0 0 COMMENT - SCHEMA public pg_database_owner
3970; 0 0 COMMENT - SCHEMA auth supabase_admin
251; 1259 16759 TABLE auth identities supabase_auth_admin
252; 1259 16760 TABLE auth users supabase_auth_admin
300; 1259 1 TABLE public e2e_items postgres
301; 1259 2 TABLE public auth postgres
4000; 0 16759 TABLE DATA auth identities supabase_auth_admin
4001; 0 16760 TABLE DATA auth users supabase_auth_admin
4002; 0 16761 TABLE DATA auth sessions supabase_auth_admin
4003; 0 16762 TABLE DATA auth refresh_tokens supabase_auth_admin
4004; 0 1 TABLE DATA public e2e_items postgres
4005; 0 1 TABLE DATA public auth postgres
5000; 2606 1 FK CONSTRAINT public e2e_items e2e_items_user_fk postgres
5001; 2606 2 FK CONSTRAINT auth sessions sessions_user_id_fkey supabase_auth_admin
`

describe('filterRestoreList', () => {
  const out = filterRestoreList(LISTING).split('\n')

  it('keeps every public entry, including a public table that is literally called auth', () => {
    for (const needle of ['SCHEMA - public', 'TABLE public e2e_items', 'TABLE public auth', 'TABLE DATA public auth', 'FK CONSTRAINT public e2e_items']) {
      expect(out.some((l) => l.includes(needle)), needle).toBe(true)
    }
  })

  it('keeps only the data of auth.users and auth.identities', () => {
    expect(out.some((l) => l.includes('TABLE DATA auth users'))).toBe(true)
    expect(out.some((l) => l.includes('TABLE DATA auth identities'))).toBe(true)
    expect(out.some((l) => l.includes('TABLE DATA auth sessions'))).toBe(false)
    expect(out.some((l) => l.includes('TABLE DATA auth refresh_tokens'))).toBe(false)
  })

  it('drops all auth DDL: schema, tables, comments, constraints', () => {
    expect(out.some((l) => /SCHEMA - auth/.test(l))).toBe(false)
    expect(out.some((l) => /COMMENT - SCHEMA auth/.test(l))).toBe(false)
    expect(out.some((l) => /^\d+; \d+ \d+ TABLE auth /.test(l))).toBe(false)
    expect(out.some((l) => /FK CONSTRAINT auth/.test(l))).toBe(false)
  })

  it('leaves a dump with no auth entries untouched', () => {
    const old = '1; 2615 2200 SCHEMA - public x\n2; 1259 1 TABLE public t x\n'
    expect(filterRestoreList(old)).toBe(old)
  })

  it('treats comments and blanks as keepable', () => {
    expect(keepRestoreEntry('; Archive created')).toBe(true)
    expect(keepRestoreEntry('')).toBe(true)
  })
})

describe('listingHasEndUsers', () => {
  it('is true only when auth.users data is in the dump', () => {
    expect(listingHasEndUsers(LISTING)).toBe(true)
    expect(listingHasEndUsers('4004; 0 1 TABLE DATA public e2e_items postgres\n')).toBe(false)
  })
})
