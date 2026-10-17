import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { writeSecretFile } from '../src/lib/secret-file'

describe('writeSecretFile', () => {
  it('creates the file owner-only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-'))
    const file = path.join(dir, '.env')
    await writeSecretFile(file, 'A=1\n')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(file, 'utf8')).toBe('A=1\n')
  })

  it('tightens a file that was already world-readable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-'))
    const file = path.join(dir, '.env')
    await fs.writeFile(file, 'OLD=1\n', { mode: 0o644 })
    await fs.chmod(file, 0o644)
    await writeSecretFile(file, 'NEW=1\n')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })
})
