import { describe, expect, it } from 'vitest'

import { projectsDueForBackup } from '../src/lib/backup-scheduler'

const HOUR = 60 * 60 * 1000
const now = 1_000 * HOUR
const day = 24 * HOUR
const p = (id: string) => ({ id, slug: id })

describe('projectsDueForBackup', () => {
  it('backs up a project that has never been backed up', () => {
    const due = projectsDueForBackup({
      projects: [p('a')], lastCompleted: new Map(), lastFailed: new Map(), now, intervalMs: day,
    })
    expect(due.map((x) => x.id)).toEqual(['a'])
  })

  it('leaves a project alone while its newest backup is inside the interval', () => {
    const due = projectsDueForBackup({
      projects: [p('a')], lastCompleted: new Map([['a', now - 2 * HOUR]]), lastFailed: new Map(), now, intervalMs: day,
    })
    expect(due).toEqual([])
  })

  it('catches up a project whose newest backup is older than the interval', () => {
    const due = projectsDueForBackup({
      projects: [p('a')], lastCompleted: new Map([['a', now - 25 * HOUR]]), lastFailed: new Map(), now, intervalMs: day,
    })
    expect(due.map((x) => x.id)).toEqual(['a'])
  })

  it('does not hammer a project that just failed, then retries it', () => {
    const base = { projects: [p('a')], lastCompleted: new Map<string, number>(), now, intervalMs: day }
    expect(projectsDueForBackup({ ...base, lastFailed: new Map([['a', now - 10 * 60 * 1000]]) })).toEqual([])
    expect(projectsDueForBackup({ ...base, lastFailed: new Map([['a', now - 2 * HOUR]]) }).map((x) => x.id)).toEqual(['a'])
  })

  it('does the most exposed project first', () => {
    const due = projectsDueForBackup({
      projects: [p('recent'), p('never'), p('stale')],
      lastCompleted: new Map([['recent', now - 25 * HOUR], ['stale', now - 90 * HOUR]]),
      lastFailed: new Map(), now, intervalMs: day,
    })
    expect(due.map((x) => x.id)).toEqual(['never', 'stale', 'recent'])
  })
})
