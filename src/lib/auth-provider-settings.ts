import fs from 'node:fs/promises'
import path from 'node:path'

import {
  type ProviderInput,
  type ProviderView,
  ensureAuthProviderEnv,
  providerEnvEntries,
  providerKeys,
  providerViews,
  validateProviderInput,
} from '@/lib/auth-providers'
import { prisma } from '@/lib/db'
import { mergeEnvFile } from '@/lib/env-file'
import { getProjectsBasePath } from '@/lib/paths'
import { recreateServices } from '@/lib/service-groups'

/**
 * A project's social sign-in providers: read from, and applied to, the project's own environment.
 *
 * Unlike the AI key (which Studio never needs to hold), GoTrue reads its provider secret from its own
 * environment, so the secret has to live in the project's `.env`. It is never returned to a client.
 */

async function projectEnv(projectId: string): Promise<{ slug: string; env: Record<string, string> } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { slug: true, envVars: { select: { key: true, value: true } } },
  })
  if (!project) return null
  return { slug: project.slug, env: Object.fromEntries(project.envVars.map((e) => [e.key, e.value])) }
}

export async function readProviders(projectId: string): Promise<ProviderView[] | null> {
  const found = await projectEnv(projectId)
  if (!found) return null
  return providerViews(found.env, found.env.API_EXTERNAL_URL ?? '')
}

export type SaveProviderResult =
  | { ok: true; providers: ProviderView[]; recreated: string[] }
  | { ok: false; error: string; status: number }

export async function saveProvider(projectId: string, input: ProviderInput): Promise<SaveProviderResult> {
  const found = await projectEnv(projectId)
  if (!found) return { ok: false, error: 'No such project', status: 404 }

  const keys = providerKeys(input.provider)
  const invalid = validateProviderInput(input, {
    hasSecret: Boolean(found.env[keys.secret]),
    hasClientId: Boolean(found.env[keys.clientId]),
  })
  if (invalid) return { ok: false, error: invalid, status: 400 }

  const apiUrl = found.env.API_EXTERNAL_URL
  if (!apiUrl) {
    return { ok: false, error: 'This project has no public API URL yet; deploy it first.', status: 409 }
  }

  const entries = providerEnvEntries(input, apiUrl)

  // The database is the panel's record; the file is what Docker reads. Both, so they cannot drift.
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) continue
    await prisma.projectEnvVar.upsert({
      where: { projectId_key: { projectId, key } },
      update: { value },
      create: { projectId, key, value },
    })
  }

  const dockerDir = path.join(getProjectsBasePath(), found.slug, 'docker')
  await mergeEnvFile(path.join(dockerDir, '.env'), entries)

  // A project made before this feature has an auth service that would drop these variables.
  const composePath = path.join(dockerDir, 'docker-compose.yml')
  try {
    const compose = await fs.readFile(composePath, 'utf8')
    const ensured = ensureAuthProviderEnv(compose)
    if (ensured !== compose) await fs.writeFile(composePath, ensured)
  } catch {
    // No compose on disk: the recreate below finds no auth service and reports that.
  }

  // Only the auth container is recreated; the database and the API stay up.
  const recreated = await recreateServices(dockerDir, ['auth'])

  const providers = providerViews(
    { ...found.env, ...Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== null) as [string, string][]) },
    apiUrl
  )
  return { ok: true, providers, recreated }
}
