import { describe, it, expect } from 'vitest'
import { filterLogLines, parseLogLines, serviceNames, severityOf } from '../src/lib/project-logs'

describe('severityOf', () => {
  it('reads JSON levels', () => {
    expect(severityOf('{"level":"error","msg":"x"}')).toBe('error')
    expect(severityOf('{"level":"warning"}')).toBe('warn')
    expect(severityOf('{"level":"info"}')).toBe('info')
    expect(severityOf('{"level":"debug"}')).toBe('debug')
  })
  it('reads postgres/nginx style markers', () => {
    expect(severityOf('2026-01-01 FATAL:  password authentication failed')).toBe('error')
    expect(severityOf('LOG:  checkpoint starting')).toBe('info')
    expect(severityOf('WARNING:  something')).toBe('warn')
    expect(severityOf('2026/10/18 [error] 12#12: *1 boom')).toBe('error')
  })
  it('defaults to info', () => expect(severityOf('hello')).toBe('info'))
})

describe('parseLogLines + filterLogLines', () => {
  const lines = parseLogLines(
    '2026-10-18T00:00:01.5Z {"level":"info","msg":"up"}\n2026-10-18T00:00:02.0Z \x1b[31mFATAL: boom\x1b[0m\n\nplain line\n'
  )
  it('splits timestamp from text and strips colours', () => {
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatchObject({ at: '2026-10-18T00:00:02.0Z', text: 'FATAL: boom', severity: 'error' })
    expect(lines[2].at).toBe('')
  })
  it('filters by minimum severity and search', () => {
    expect(filterLogLines(lines, { minSeverity: 'error' })).toHaveLength(1)
    expect(filterLogLines(lines, { search: 'PLAIN' })).toHaveLength(1)
    expect(filterLogLines(lines, {})).toHaveLength(3)
  })
})

describe('serviceNames', () => {
  const names = ['a-1-db', 'a-1-rest', 'a-1-extra-db', 'b-2-db', 'coolify-db']
  it('lists only this project, not a longer-slug neighbour', () => {
    expect(serviceNames('a-1', names, ['a-1', 'a-1-extra', 'b-2'])).toEqual(['db', 'rest'])
    expect(serviceNames('a-1-extra', names, ['a-1', 'a-1-extra'])).toEqual(['db'])
  })
})
