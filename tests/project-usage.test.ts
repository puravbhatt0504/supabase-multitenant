import { describe, it, expect } from 'vitest'
import { parseSize, parseStats } from '../src/lib/project-usage'

describe('parseSize', () => {
  it('reads docker units', () => {
    expect(parseSize('37.5MiB')).toBe(Math.round(37.5 * 1024 * 1024))
    expect(parseSize('1GiB')).toBe(1024 ** 3)
    expect(parseSize('512B')).toBe(512)
    expect(parseSize('garbage')).toBe(0)
  })
})

describe('parseStats', () => {
  const lines = ['a-1-db|100MiB / 8GiB|1.5%', 'a-1-rest|20MiB / 8GiB|0.0%', 'a-1-x-db|500MiB / 8GiB|9%', 'other-db|1GiB / 8GiB|2%']
  it('sums only this project and ignores a longer-slug neighbour', () => {
    const c = parseStats(lines, 'a-1', ['a-1', 'a-1-x', 'other'])
    expect(c.map((x) => x.name)).toEqual(['a-1-db', 'a-1-rest'])
    expect(c[0]).toMatchObject({ memoryBytes: 100 * 1024 * 1024, cpuPercent: 1.5 })
  })
})
