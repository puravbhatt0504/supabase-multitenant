/**
 * Which entries of a database dump a restore should replay.
 *
 * A dump holds the project's `public` schema and the `auth` schema. Replaying the auth schema's
 * DDL is unsafe (see #160: wrong ownership makes GoTrue answer 500), but the people who signed up
 * live in two of its tables, and losing them on restore is the worse failure. So the restore
 * replays everything except the `auth` schema, plus the DATA of `auth.users` and `auth.identities`.
 *
 * `pg_restore -l` prints one entry per line (`12; 2615 16458 SCHEMA - auth owner`); feeding a
 * filtered copy back with `-L` replays only those entries. Older dumps hold no auth entries, so the
 * filter leaves them untouched.
 */

const AUTH_DATA_TABLES = new Set(['users', 'identities'])

// `<id>; <catalog oid> <object oid> <TYPE WORDS> <schema|-> <rest>`
const ENTRY = /^\d+; \d+ \d+ ([A-Z][A-Z ]*[A-Z]) (\S+) ?(.*)$/

export function keepRestoreEntry(line: string): boolean {
  if (line.startsWith(';') || line.trim() === '') return true
  const match = ENTRY.exec(line)
  if (!match) return true
  const [, type, schema, rest] = match
  if (schema === 'auth') {
    return type === 'TABLE DATA' && AUTH_DATA_TABLES.has(rest.split(' ')[0])
  }
  if (schema === '-' && /^(SCHEMA )?auth(\s|$)/.test(rest)) return false
  return true
}

export function filterRestoreList(listing: string): string {
  const kept = listing.split('\n').filter(keepRestoreEntry)
  // The auth foreign keys are not replayed, so pg_restore has no dependency to order the two data
  // entries by, and identities (which reference users) can land first and fail. Users go first.
  const isData = (table: string) => (l: string) => {
    const m = ENTRY.exec(l)
    return !!m && m[1] === 'TABLE DATA' && m[2] === 'auth' && m[3].split(' ')[0] === table
  }
  const users = kept.findIndex(isData('users'))
  const identities = kept.findIndex(isData('identities'))
  if (users > identities && identities >= 0) {
    const [line] = kept.splice(users, 1)
    kept.splice(identities, 0, line)
  }
  return kept.join('\n').replace(/\n*$/, '') + '\n'
}

/** Does this listing carry the end users? Used to tell the person what a restore will bring back. */
export function listingHasEndUsers(listing: string): boolean {
  return listing.split('\n').some((l) => {
    const m = ENTRY.exec(l)
    return !!m && m[1] === 'TABLE DATA' && m[2] === 'auth' && m[3].split(' ')[0] === 'users'
  })
}
