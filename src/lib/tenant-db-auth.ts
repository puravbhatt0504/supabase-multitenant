import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { runWithStdin } from './exec-stdin'
import { tenantContainerName } from './gateway'

const execAsync = promisify(exec)

/**
 * Keep the tenant cluster's `postgres` password equal to the one the project is configured with.
 *
 * `postgres` is the role Studio's `meta` service authenticates as (and the pooler, and dumps), and
 * its password comes from `POSTGRES_PASSWORD` — the same value in the project's `.env`. The two can
 * drift: the cluster keeps the password it was *initialised* with, while the `.env` gets rewritten
 * later. Then every Studio page that reads the database answers `password authentication failed for
 * user "postgres"` — tables, Integrations, Query Performance, Advisors, Triggers, the auth user list
 * — while Auth and REST keep working, because they authenticate with their own roles. The platform
 * looks broken in a way that points at nothing.
 *
 * Two details make the difference between a check that works and one that lies:
 *
 * 1. Check over the **network path**, never a local socket. `pg_hba.conf` in these images trusts
 *    `127.0.0.1`, so `psql` on localhost succeeds even when the password is wrong.
 * 2. Fix it as **`supabase_admin`**. `postgres` is not a superuser in these images, so it cannot
 *    alter its own (privileged) role — the attempt fails with `permission denied to alter role`.
 */

export class TenantDbAuthError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = []
  ) {
    super(message)
    this.name = 'TenantDbAuthError'
  }
}

/** A password as a SQL literal (single quotes doubled); the statement never goes through argv. */
export function alterPostgresPasswordStatement(password: string): string {
  if (password.length === 0) throw new TenantDbAuthError('Refusing to set an empty password')
  return `alter role postgres with password '${password.replace(/'/g, "''")}'`
}

async function docker(args: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return await execAsync(`docker ${args}`, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
}

export interface TenantDbAuthResult {
  status: 'ok' | 'repaired' | 'skipped'
  detail: string
}

/**
 * Verify, and if needed repair, the password `postgres` authenticates with over the network.
 *
 * Idempotent: on a healthy project it runs one query and changes nothing.
 */
export async function ensureTenantPostgresPassword(
  slug: string,
  password: string,
  options: { timeoutMs?: number } = {}
): Promise<TenantDbAuthResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const db = tenantContainerName(slug, 'db')

  const running = await docker(
    `ps -q --filter name=^${db}$`,
    timeoutMs
  ).then((r) => r.stdout.trim().length > 0)
  if (!running) return { status: 'skipped', detail: `${db} is not running` }

  const port = (
    await docker(`exec ${db} psql -U supabase_admin -d postgres -tAc "show port"`, timeoutMs)
  ).stdout.trim()
  // The container's own address on its network: connecting there goes through the scram rule,
  // while 127.0.0.1 would be trusted and prove nothing.
  const address = (
    await docker(
      `inspect ${db} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
      timeoutMs
    )
  ).stdout.trim()
  if (!port || !address) {
    throw new TenantDbAuthError(`Cannot determine the database address of ${db}`, [port, address])
  }

  const probe = (pw: string) =>
    docker(
      `exec -e PGPASSWORD=${JSON.stringify(pw)} ${db} psql -h ${address} -p ${port} -U postgres ` +
        `-d postgres -tAc "select 1"`,
      timeoutMs
    )
      .then(() => true)
      .catch(() => false)

  if (await probe(password)) return { status: 'ok', detail: 'the cluster accepts the configured password' }

  // Repair as the superuser, with the statement on stdin so the password never reaches argv.
  const repair = await runWithStdin(
    'docker',
    ['exec', '-i', db, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    alterPostgresPasswordStatement(password),
    { timeoutMs }
  )
  if (repair.code !== 0 || !/ALTER ROLE/i.test(repair.stdout + repair.stderr)) {
    throw new TenantDbAuthError(
      `Could not align the postgres role password for ${slug} with its configuration`,
      [repair.stderr.trim() || repair.stdout.trim()]
    )
  }

  if (!(await probe(password))) {
    throw new TenantDbAuthError(
      `The postgres role for ${slug} still rejects the configured password after the repair`
    )
  }

  return {
    status: 'repaired',
    detail: 'the cluster stored a different password than the project config: realigned it',
  }
}
