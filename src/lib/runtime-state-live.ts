import { exec } from 'child_process'
import { promisify } from 'util'

import { runtimeStates, type RuntimeSummary } from './runtime-state'

const execAsync = promisify(exec)

/** One `docker ps -a` for the whole page; null when Docker cannot be asked (say nothing, don't guess). */
export async function liveRuntimeStates(slugs: string[]): Promise<Record<string, RuntimeSummary> | null> {
  try {
    const { stdout } = await execAsync("docker ps -a --format '{{.Names}}|{{.Status}}'", { timeout: 10_000 })
    return runtimeStates(slugs, stdout.split('\n'))
  } catch {
    return null
  }
}
