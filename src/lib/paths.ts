import * as path from 'path'

/**
 * Centralized product identity for the rebrand.
 *
 * `supabase-multitenant` is the canonical, machine-safe slug used across
 * filesystem paths, Docker container/network names, the Docker image name,
 * and the docker-compose project name. `Supabase Multitenant` is the
 * human-readable product name.
 *
 * Keeping these in one place means a future rename only needs to happen here.
 */
export const PRODUCT_SLUG = 'supabase-multitenant'
export const PRODUCT_NAME = 'Supabase Multitenant'

/**
 * Docker container names. These must match the values referenced in
 * install.sh, docker-compose.dev.yml, docs/TESTING.md and the generated
 * Traefik service URLs.
 */
export const PANEL_CONTAINER_NAME = 'supabase-multitenant-panel'
export const POSTGRES_CONTAINER_NAME = 'supabase-multitenant-postgres'
export const TRAEFIK_CONTAINER_NAME = 'supabase-multitenant-traefik'
export const NETWORK_NAME = 'supabase-multitenant-network'

/**
 * PostgreSQL identifiers (user / database). Kept as a single underscore-word
 * (no hyphens) so it is a valid unquoted Postgres identifier and safe inside
 * connection strings.
 */
export const DB_IDENTIFIER = 'supabase_multitenant'

/** Docker image for the panel (registry/repository). */
export const DOCKER_IMAGE = 'webboxes/supabase-multitenant'

/** Default production data directory (mounted by docker-compose). */
export const DEFAULT_DATA_DIR = '/etc/supabase-multitenant'

/** Environment variable names (renamed as part of the rebrand). */
export const ENV_MODE = 'SUPABASE_MULTITENANT_MODE'
export const ENV_DATA_PATH = 'DATA_PATH'

/**
 * Overrides the directory the proxy reads its dynamic config from. Deployment
 * setting rather than a constant: the panel and the proxy are separate containers,
 * so only the deployment knows the shared path (see getTraefikDynamicPath).
 */
export const ENV_TRAEFIK_DYNAMIC_PATH = 'TRAEFIK_DYNAMIC_PATH'

/**
 * Resolve the running mode.
 * - "production" when deployed via Docker/install.sh
 * - "development" for local dev (default)
 */
export function getMode(): string {
  return process.env[ENV_MODE] || 'development'
}

/**
 * Directory where Traefik dynamic configs are written.
 *
 * The proxy that *reads* these files is its own container, so "where to write" is
 * a deployment fact, not a code constant: point `TRAEFIK_DYNAMIC_PATH` at the
 * directory the proxy has mounted (in this deployment `/data/coolify/proxy/dynamic`,
 * which the panel can reach because both containers bind the same `/data`).
 *
 * The fallbacks only matter for a bare install that never set it. A router file
 * written anywhere else is invisible to the proxy — which looks exactly like a
 * project whose host does not resolve.
 */
export function getTraefikDynamicPath(): string {
  const override = process.env[ENV_TRAEFIK_DYNAMIC_PATH]
  if (override) return override
  const mode = getMode()
  if (mode === 'production') {
    return path.join('/etc/supabase-multitenant', 'traefik', 'dynamic')
  }
  return path.join(process.cwd(), 'traefik', 'dynamic')
}

/**
 * Base directory that holds one folder per Supabase project.
 */
export function getProjectsBasePath(): string {
  const mode = getMode()
  if (mode === 'production') {
    const dataPath = process.env[ENV_DATA_PATH] || DEFAULT_DATA_DIR
    return path.join(dataPath, 'projects')
  }
  return path.join(process.cwd(), 'supabase-projects')
}

/**
 * Base directory that holds the cloned Supabase core repo.
 */
export function getCoreBasePath(): string {
  const mode = getMode()
  if (mode === 'production') {
    const dataPath = process.env[ENV_DATA_PATH] || DEFAULT_DATA_DIR
    return path.join(dataPath, 'core')
  }
  return path.join(process.cwd(), 'supabase-core')
}

/**
 * Base directory for project backups (`<slug>/` per project).
 *
 * Deliberately outside `projects/`: backups must survive a project being deleted
 * or re-provisioned, and they are the restore source for a *new* project.
 */
export function getBackupsBasePath(): string {
  const mode = getMode()
  if (mode === 'production') {
    const dataPath = process.env[ENV_DATA_PATH] || DEFAULT_DATA_DIR
    return path.join(dataPath, 'backups')
  }
  return path.join(process.cwd(), 'backups')
}

/**
 * Directory holding the on-disk volume data for a project, as mounted by its
 * compose file. Used for file-level backups (e.g. the storage bucket volume)
 * without needing to exec into a container.
 */
export function getProjectVolumesPath(slug: string): string {
  return path.join(getProjectsBasePath(), slug, 'docker', 'volumes')
}
