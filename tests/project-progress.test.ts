import { describe, expect, it } from 'vitest'

import { blockReasonFor, percentFrom, stagesFor, summarizeContainers } from '../src/lib/project-progress'

const SLUG = 'project303-1791995042094'

describe("reading a project's containers", () => {
  it('counts what is running and what is healthy', () => {
    const shape = summarizeContainers(
      [
        `${SLUG}-db|Up 12 seconds (healthy)`,
        `${SLUG}-auth|Up 6 seconds (healthy)`,
        `${SLUG}-rest|Up 6 seconds (health: starting)`,
        `${SLUG}-studio|Exited (0) 2 minutes ago`,
      ],
      ['db', 'auth', 'rest'],
      SLUG
    )
    expect(shape.total).toBe(4)
    expect(shape.running).toBe(3)
    expect(shape.healthy).toBe(2)
    expect(shape.unhealthy).toEqual([`${SLUG}-rest`])
    expect(shape.missing).toEqual([])
  })

  it('names the services that are not there at all', () => {
    const shape = summarizeContainers([`${SLUG}-db|Up 1 second (healthy)`], ['db', 'auth', 'rest'], SLUG)
    expect(shape.missing).toEqual([`${SLUG}-auth`, `${SLUG}-rest`])
  })
})

describe('the stages a project passes through', () => {
  const at = (over: Partial<Parameters<typeof stagesFor>[0]> = {}) =>
    stagesFor({
      shape: { total: 6, running: 6, healthy: 6, unhealthy: [], missing: [] },
      onGateway: true,
      answering: true,
      expectedCount: 6,
      ...over,
    })

  it('is complete when everything answers', () => {
    const stages = at()
    expect(stages.every((s) => s.done)).toBe(true)
    expect(percentFrom(stages)).toBe(100)
    expect(blockReasonFor(stages, 'running')).toBeNull()
  })

  it('reports a project that is still starting, as a number and as an instruction', () => {
    // The exact case that produced "No such container: <slug>-db": a backup pressed while the stack
    // was coming up. The stages have to say so before the action is attempted.
    const stages = at({
      shape: { total: 4, running: 4, healthy: 2, unhealthy: [`${SLUG}-rest`], missing: [] },
      onGateway: false,
      answering: false,
    })
    expect(percentFrom(stages)).toBe(25)
    expect(blockReasonFor(stages, 'running')).toMatch(/still starting/i)
  })

  it('says to deploy when there is nothing there', () => {
    const stages = at({
      shape: { total: 0, running: 0, healthy: 0, unhealthy: [], missing: [] },
      onGateway: false,
      answering: false,
    })
    expect(blockReasonFor(stages, 'creating')).toMatch(/deploy it first/i)
  })

  it('notices a pause before anything else', () => {
    expect(blockReasonFor(at({ answering: false }), 'paused')).toMatch(/paused/i)
  })
})
