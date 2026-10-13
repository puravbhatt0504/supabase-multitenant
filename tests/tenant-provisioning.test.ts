import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SHARED_PLANE_SERVICES, slimProjectCompose } from '../src/lib/slim-compose'
import { tenantSlot } from '../src/lib/tenant-gateway'
import {
  RETAINED_SHARED_SERVICES,
  pruneRouterFilesClaimingHosts,
  routerFileHosts,
  TENANT_ENV_KEYS,
  platformBaseDomainOrThrow,
  tenantEnvVars,
  tenantHosts,
} from '../src/lib/tenant-provisioning'

const BASE = '213.47.80.26.sslip.io'
const SLUG = 'project101-of-org202-1790168723120'

describe('tenant hosts', () => {
  it('drops the creation timestamp from the API host but keeps it in the Studio host', () => {
    // The live deployment answers on exactly these two shapes; a change here silently
    // moves every project's URLs, so they are pinned rather than derived twice.
    expect(tenantHosts(SLUG, BASE)).toEqual({
      apiHost: `project101-of-org202.${BASE}`,
      studioHost: `project101-of-org202-1790168723120-studio.${BASE}`,
    })
  })

  it('keeps a slug that has no timestamp intact', () => {
    expect(tenantHosts('myproject', BASE).apiHost).toBe(`myproject.${BASE}`)
  })
})

describe('tenant env vars', () => {
  const slot = tenantSlot(3)
  const env = tenantEnvVars(SLUG, slot, BASE)

  it('records the slot and both of its ports', () => {
    expect(env[TENANT_ENV_KEYS.slot]).toBe('3')
    expect(env[TENANT_ENV_KEYS.listenerPort]).toBe('8103')
    expect(env[TENANT_ENV_KEYS.publishedPort]).toBe('11133')
  })

  it('records the hosts the panel links to', () => {
    expect(env[TENANT_ENV_KEYS.apiHost]).toBe(`project101-of-org202.${BASE}`)
    expect(env[TENANT_ENV_KEYS.studioHost]).toBe(
      `project101-of-org202-1790168723120-studio.${BASE}`
    )
  })

  it('points public URLs at the tenant host, never at localhost', () => {
    // This is what a project's users receive in confirmation emails and what Studio
    // prints as the API endpoint: a localhost default makes both useless off-box.
    expect(env.API_EXTERNAL_URL).toBe(`https://project101-of-org202.${BASE}`)
    expect(env.SUPABASE_PUBLIC_URL).toBe(`https://project101-of-org202.${BASE}`)
    expect(env.SITE_URL).toBe(
      `https://project101-of-org202-1790168723120-studio.${BASE}`
    )
    expect(env.ADDITIONAL_REDIRECT_URLS).toContain(`https://project101-of-org202.${BASE}`)
    expect(Object.values(env).every((value) => !value.includes('localhost'))).toBe(true)
  })
})

describe('platform base domain', () => {
  it('derives the tenant domain from the panel URL', () => {
    expect(platformBaseDomainOrThrow(`https://panel-abc.${BASE}/auth/login`)).toBe(BASE)
  })

  it('throws with an actionable message instead of inventing a hostname', () => {
    expect(() => platformBaseDomainOrThrow(undefined)).toThrow(/AUTH_URL/)
  })
})

describe('retained shared services', () => {
  it('names only real shared-plane services', () => {
    // A typo here would be a service that is neither hoisted nor kept — the project
    // would come up missing it, and nothing else would complain.
    for (const service of RETAINED_SHARED_SERVICES) {
      expect(SHARED_PLANE_SERVICES).toContain(service)
    }
  })
})

describe('slimming at creation', () => {
  const template = [
    'name: supabase',
    'services:',
    '  api-gw:',
    '    container_name: supabase-envoy',
    '    image: envoyproxy/envoy:v1.39.1',
    '  auth:',
    '    container_name: supabase-auth',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    environment:',
    '      SUPABASE_URL: http://api-gw:8000',
    '  rest:',
    '    container_name: supabase-rest',
    '  realtime:',
    '    container_name: supabase-realtime',
    '  storage:',
    '    container_name: supabase-storage',
    '    environment:',
    '      IMGPROXY_URL: http://imgproxy:5001',
    '  functions:',
    '    container_name: supabase-edge-functions',
    '  imgproxy:',
    '    container_name: supabase-imgproxy',
    '  meta:',
    '    container_name: supabase-meta',
    '  studio:',
    '    container_name: supabase-studio',
    '    depends_on:',
    '      meta:',
    '        condition: service_started',
    '  db:',
    '    container_name: supabase-db',
    '  supavisor:',
    '    container_name: supabase-pooler',
    'volumes:',
    '  db-config:',
    'networks:',
    '  default:',
  ].join('\n')

  const slim = (extra: string[] = []) =>
    slimProjectCompose(template, {
      slug: SLUG,
      gatewayPort: tenantSlot(0).listenerPort,
      keepExtra: extra,
    })

  it('keeps the database, its API and the dashboard, and drops the rest', () => {
    const result = slim([...RETAINED_SHARED_SERVICES])
    expect(result.kept).toEqual(['auth', 'db', 'imgproxy', 'meta', 'rest', 'studio'])
    expect(result.removed).toEqual(['api-gw', 'functions', 'realtime', 'storage', 'supavisor'])
  })

  it('repoints internal calls at the tenant listener on the shared gateway', () => {
    const result = slim([...RETAINED_SHARED_SERVICES])
    expect(result.compose).toContain(`http://${SLUG}-gw:8100`)
    expect(result.compose).not.toContain('http://api-gw:8000')
    expect(result.rewires.some((r) => r.startsWith('http://api-gw:8000'))).toBe(true)
  })

  it('drops the dependency entry of a removed service, not just its block', () => {
    const result = slim([...RETAINED_SHARED_SERVICES])
    expect(result.compose).not.toMatch(/^\s+supavisor:/m)
    expect(result.compose).not.toMatch(/^\s+realtime:/m)
    // auth depended on db (kept), studio on meta (kept): both must survive.
    expect(result.compose).toMatch(/^\s+db:\s*$/m)
  })

  it('refuses a kept service that the compose does not define', () => {
    expect(() => slim(['not-a-service'])).toThrow(/does not define/)
  })

  it('refuses an opt-in service passed as a shared-plane extra', () => {
    // realtime/storage/functions are per-project opt-ins: keeping one is legitimate,
    // but it belongs in `optional`, and saying so beats a silent misconfiguration.
    expect(() => slim(['realtime'])).toThrow(/opt-in/)
  })
})

describe('one host, one router file', () => {
  const HOST = `project101-of-org202.${BASE}`
  const STUDIO = `project101-of-org202-1790168723120-studio.${BASE}`

  it('reads the hosts a router file claims', () => {
    const content = [
      'routers:',
      '  a:',
      `    rule: Host(\`${HOST}\`)`,
      `  b:`,
      `    rule: Host(\`${STUDIO}\`)`,
    ].join('\n')
    expect(routerFileHosts(content)).toEqual([HOST, STUDIO])
  })

  it('prunes an older file serving the same host, whatever it is called', async () => {
    // Hand cut-overs named their file after the API host's first label, or invented a name
    // entirely; pruning by host catches both, and a file left behind for a deleted project
    // would keep its hostname answering.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-'))
    const previous = process.env.TRAEFIK_DYNAMIC_PATH
    process.env.TRAEFIK_DYNAMIC_PATH = dir
    try {
      const ours = path.join(dir, `${SLUG}.yml`)
      const legacy = path.join(dir, 'project101-of-org202.yaml')
      const bespoke = path.join(dir, 'drill-shared-gateway.yaml')
      const other = path.join(dir, 'someone-else.yaml')
      await fs.writeFile(ours, `rule: Host(\`${HOST}\`)`)
      await fs.writeFile(legacy, `rule: Host(\`${HOST}\`)`)
      await fs.writeFile(bespoke, `rule: Host(\`${STUDIO}\`)`)
      await fs.writeFile(other, `rule: Host(\`unrelated.example.com\`)`)

      const removed = await pruneRouterFilesClaimingHosts([HOST, STUDIO], ours)

      expect(removed.sort()).toEqual([bespoke, legacy].sort())
      expect(await fs.readdir(dir)).toEqual(expect.arrayContaining([path.basename(ours), 'someone-else.yaml']))
      expect((await fs.readdir(dir)).length).toBe(2)
    } finally {
      if (previous === undefined) delete process.env.TRAEFIK_DYNAMIC_PATH
      else process.env.TRAEFIK_DYNAMIC_PATH = previous
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
