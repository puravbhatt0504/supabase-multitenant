import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Comments may explain the flag; only the commands that actually run count.
const script = readFileSync('scripts/docker-entrypoint.sh', 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

describe('docker entrypoint', () => {
  it('never lets a deploy silently destroy control-plane data', () => {
    expect(script).not.toContain('--accept-data-loss')
  })

  it('keeps the panel up when the schema sync is refused', () => {
    // `set -e` plus a bare `prisma db push` would exit the container and crash-loop it.
    expect(script).toMatch(/if ! npx prisma db push/)
  })
})
