import { runWithStdin } from './exec-stdin'
import { tenantContainerName } from './gateway'

/**
 * The Supabase grants on schema `public`, for projects that were created without them.
 *
 * Studio's meta service connects as `postgres`, so an ordinary "create table" through the table
 * editor is that role writing to `public`. On a project whose `public` schema never received the
 * standard grants, `postgres` has USAGE but not CREATE, and the editor answers
 * `permission denied for schema public` — a permission the customer cannot fix from where they are
 * standing (they have no psql). A project created by the panel should never be in that state, so the
 * grants are reconciled on deploy the same way the database password is.
 */
export const PUBLIC_SCHEMA_GRANTS = `grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres, supabase_admin;
grant all on all tables in schema public to postgres, anon, authenticated, service_role;
grant all on all sequences in schema public to postgres, anon, authenticated, service_role;
grant all on all functions in schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
`

/** The one question worth asking before running the grants: can `postgres` create in `public`? */
export const GRANTS_PROBE = "select has_schema_privilege('postgres','public','create')"

export interface GrantsResult {
  repaired: boolean
  detail: string
}

/** Give a project the standard `public` grants if it is missing them. Never throws at the caller. */
export async function ensurePublicSchemaGrants(slug: string): Promise<GrantsResult> {
  const container = tenantContainerName(slug, 'db')
  const probe = ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'supabase_multitenant', '-tAc', GRANTS_PROBE]

  try {
    // The probe carries its SQL in argv (`-tAc`), so stdin is empty on purpose: only statements
    // and secrets travel on stdin, never a password or a statement in the process list.
    const check = await runWithStdin('docker', probe, '', { timeoutMs: 30_000 })
    if (check.stdout.trim() === 't') return { repaired: false, detail: 'postgres can already create in public' }
    if (check.code !== 0) return { repaired: false, detail: `could not probe grants: ${check.stderr.trim().slice(0, 160)}` }

    const fix = await runWithStdin(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'supabase_multitenant', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      PUBLIC_SCHEMA_GRANTS,
      { timeoutMs: 60_000 }
    )
    if (fix.code !== 0) return { repaired: false, detail: `grants failed: ${fix.stderr.trim().slice(0, 160)}` }
    return { repaired: true, detail: 'public schema grants applied' }
  } catch (error) {
    return { repaired: false, detail: error instanceof Error ? error.message : 'grants error' }
  }
}
