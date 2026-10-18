import { describe, it, expect } from 'vitest'
import { runtimeStates } from '../src/lib/runtime-state'

describe('runtimeStates', () => {
  const lines = [
    'a-1-db|Up 2 hours (healthy)',
    'a-1-rest|Up 2 hours',
    'a-1-auth|Up 2 hours (healthy)',
    'b-2-db|Up 3 days (healthy)',
    'b-2-rest|Up 3 days (unhealthy)',
    'c-3-db|Exited (0) 2 days ago',
    'a-1-extra-db|Up 1 hour (healthy)',
    'coolify-db|Up 9 days (healthy)',
  ]
  const out = runtimeStates(['a-1', 'b-2', 'c-3', 'ghost-4', 'a-1-extra'], lines)

  it('is running when db and rest are up and nothing is unhealthy', () => {
    expect(out['a-1']).toEqual({ state: 'running', problems: [] })
  })
  it('is degraded, naming the culprit, when something is unhealthy', () => {
    expect(out['b-2'].state).toBe('degraded')
    expect(out['b-2'].problems).toEqual(['b-2-rest'])
  })
  it('is down when the database is not up, or there are no containers at all', () => {
    expect(out['c-3'].state).toBe('down')
    expect(out['ghost-4']).toEqual({ state: 'down', problems: [] })
  })
  it('gives a container to the longest matching slug', () => {
    expect(out['a-1-extra'].state).toBe('degraded') // db up, no rest
    expect(out['a-1'].problems).toEqual([])
  })
})
