import { spawn } from 'node:child_process'

/**
 * Run a command and write to its stdin.
 *
 * Used wherever a secret or a statement must not appear in the process list: `child_process.exec`
 * has no stdin, and passing a password or SQL through argv means every process on the host can read
 * it (`ps aux`). Spawning explicitly keeps it on the pipe.
 */
export interface StdinResult {
  code: number
  stdout: string
  stderr: string
}

export function runWithStdin(
  command: string,
  args: string[],
  input: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<StdinResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      settled = true
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 60000}ms`))
    }, options.timeoutMs ?? 60_000)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })

    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}
