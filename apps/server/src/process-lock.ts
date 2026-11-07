import { randomUUID } from 'node:crypto'
import { open, readFile, stat, unlink } from 'node:fs/promises'

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
export async function acquireProcessLock(path: string, timeoutMs = 15000): Promise<() => Promise<void>> {
  const token = randomUUID(), deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync() } finally { await file.close() }
      return async () => {
        try { if (JSON.parse(await readFile(path, 'utf8')).token === token) await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const before = await stat(path)
        let owner: { pid?: number } = {}
        try { owner = JSON.parse(await readFile(path, 'utf8')) } catch { /* An owner may still be writing. */ }
        if ((owner.pid && !processAlive(owner.pid)) || (!owner.pid && Date.now() - before.mtimeMs > 30000)) {
          const after = await stat(path)
          if (after.ino === before.ino && after.mtimeMs === before.mtimeMs) await unlink(path)
          continue
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (Date.now() >= deadline) throw new Error('This data folder is in use. Close the running app or maintenance command and try again.')
      await new Promise((resolve) => setTimeout(resolve, 75))
    }
  }
}
