import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isCustomFormatDump, parseSha256, receiveDump, UploadRejected } from '../src/lib/backup-upload'

const streamOf = (data: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(data))
      c.close()
    },
  })

const good = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(100, 1)])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('backup upload', () => {
  let dir: string
  afterEach(async () => dir && (await fs.rm(dir, { recursive: true, force: true })))
  const dest = async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upl-'))
    return path.join(dir, 'x.dump')
  }

  it('recognises the custom-format magic', () => {
    expect(isCustomFormatDump(Buffer.from('PGDMP\u0001'))).toBe(true)
    expect(isCustomFormatDump(Buffer.from('-- plain sql'))).toBe(false)
    expect(isCustomFormatDump(Buffer.alloc(0))).toBe(false)
  })

  it('parses sha256 or rejects it', () => {
    expect(parseSha256(undefined)).toBeNull()
    expect(parseSha256('A'.repeat(64))).toBe('a'.repeat(64))
    expect(() => parseSha256('nope')).toThrow(UploadRejected)
  })

  it('stores a valid dump and reports its real size and hash', async () => {
    const d = await dest()
    const r = await receiveDump(streamOf(good), d, { maxBytes: 1000, expectedSha256: sha(good) })
    expect(r).toEqual({ sizeBytes: good.length, sha256: sha(good) })
    expect((await fs.readFile(d)).equals(good)).toBe(true)
  })

  it('rejects a corrupted upload on checksum mismatch and leaves nothing behind', async () => {
    const d = await dest()
    const bad = Buffer.from(good); bad[50] = 99
    await expect(receiveDump(streamOf(bad), d, { maxBytes: 1000, expectedSha256: sha(good) })).rejects.toMatchObject({ status: 422 })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('rejects plain SQL, empty bodies and oversize uploads', async () => {
    const d = await dest()
    await expect(receiveDump(streamOf(Buffer.from('select 1;')), d, { maxBytes: 1000 })).rejects.toThrow(/custom-format/)
    await expect(receiveDump(streamOf(Buffer.alloc(0)), d, { maxBytes: 1000 })).rejects.toThrow(/empty/)
    await expect(receiveDump(streamOf(good), d, { maxBytes: 50 })).rejects.toMatchObject({ status: 413 })
    expect(await fs.readdir(dir)).toEqual([])
  })
})
