import { createHash } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import { Readable } from 'stream'

/**
 * Receiving a backup artifact from outside: stream it to disk, hash it on the way, and refuse
 * anything that is not a pg_dump custom-format file or does not match the checksum the sender gave.
 * An unverified dump restored into a live project is the expensive mistake (#127).
 */

export class UploadRejected extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'UploadRejected'
    this.status = status
  }
}

/** `pg_dump -Fc` files start with the ASCII magic "PGDMP". */
export function isCustomFormatDump(head: Buffer): boolean {
  return head.length >= 5 && head.subarray(0, 5).toString('latin1') === 'PGDMP'
}

/** A sha256 given as 64 hex characters, case-insensitive; anything else is a caller error. */
export function parseSha256(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null
  const v = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(v)) throw new UploadRejected('sha256 must be 64 hex characters')
  return v
}

/**
 * Write `body` to `destPath`. On any failure nothing is left behind. Returns the size and the
 * sha256 of what was actually written (so a mismatch is the sender's, not ours).
 */
export async function receiveDump(
  body: ReadableStream<Uint8Array> | null,
  destPath: string,
  options: { maxBytes: number; expectedSha256?: string | null }
): Promise<{ sizeBytes: number; sha256: string }> {
  if (!body) throw new UploadRejected('The request has no body: send the dump file as the request body')

  const part = `${destPath}.part`
  const hash = createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)

  try {
    const out = createWriteStream(part, { flags: 'wx', mode: 0o600 })
    const source = Readable.fromWeb(body as never)
    await new Promise<void>((resolve, reject) => {
      source.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > options.maxBytes) {
          source.destroy(new UploadRejected(`The upload is larger than the ${options.maxBytes} byte limit`, 413))
          return
        }
        if (head.length < 5) head = Buffer.concat([head, chunk]).subarray(0, 5)
        hash.update(chunk)
        if (!out.write(chunk)) {
          source.pause()
          out.once('drain', () => source.resume())
        }
      })
      source.on('error', reject)
      out.on('error', reject)
      source.on('end', () => out.end(() => resolve()))
    })

    if (size === 0) throw new UploadRejected('The upload is empty')
    if (!isCustomFormatDump(head)) {
      throw new UploadRejected('Not a pg_dump custom-format file (create it with `pg_dump -Fc`)')
    }
    const sha256 = hash.digest('hex')
    if (options.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new UploadRejected(`sha256 mismatch: the file received hashes to ${sha256}`, 422)
    }
    await fs.rename(part, destPath)
    return { sizeBytes: size, sha256 }
  } catch (error) {
    await fs.rm(part, { force: true })
    throw error
  }
}
