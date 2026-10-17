import fs from 'node:fs/promises'

/**
 * Write a file that holds credentials (a project's `.env`, `.env.functions`).
 *
 * `writeFile`'s `mode` only applies when the file is created, so a file written once with the
 * default umask stays world-readable forever. Setting the mode again after every write is what
 * tightens the files that already exist, the next time the panel touches them.
 */
export const SECRET_FILE_MODE = 0o600

export async function writeSecretFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { mode: SECRET_FILE_MODE })
  await fs.chmod(filePath, SECRET_FILE_MODE)
}
