import { app } from 'electron'
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * One-time adoption of the pre-rebrand user data folder.
 *
 * `app.getPath('userData')` is derived from the product name, so renaming the
 * app from JARVIS to Akansha moves it from `%APPDATA%\JARVIS` to
 * `%APPDATA%\Akansha` -- and an existing install's `settings.json`, DPAPI
 * `secrets.bin`, memory key and SQLite database would all be left behind,
 * looking to the user like the app had forgotten every API key and memory.
 *
 * So the old folder is copied forward once, before anything opens a file in the
 * new one. The copy is deliberately a copy and not a move: if this build turns
 * out to be a mistake, the old install still has its data. Nothing is deleted
 * here, ever.
 *
 * This runs before the logger exists (the logger writes into userData), so it
 * cannot log; it returns what it did and `start()` records that afterwards.
 * `currentOverride` exists for the tests, which must not touch a real
 * `%APPDATA%`.
 */

/** Folder names earlier builds used, most recent first. */
const LEGACY = ['JARVIS', 'jarvis']

const countFiles = (dir: string): number => {
  let n = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      n += statSync(full).isDirectory() ? countFiles(full) : 1
    } catch {
      // A file that vanished or cannot be stat'ed is not worth failing over.
    }
  }
  return n
}

/** True when this folder already holds data, i.e. Akansha has run before. */
const hasData = (dir: string): boolean =>
  existsSync(join(dir, 'settings.json')) ||
  existsSync(join(dir, 'secrets.bin')) ||
  existsSync(join(dir, 'database', 'akansha.db')) ||
  // The database file itself was renamed too; a folder holding only the old
  // name is still a real install and must be adopted, not ignored.
  existsSync(join(dir, 'database', 'jarvis.db'))

export interface AdoptedUserData {
  from: string
  to: string
  files: number
}

export function adoptLegacyUserData(currentOverride?: string): AdoptedUserData | null {
  let current: string
  try {
    current = currentOverride ?? app.getPath('userData')
  } catch {
    return null
  }
  // Already ours: never overwrite live data with an older copy.
  if (hasData(current)) return null

  const parent = dirname(current)
  const lower = current.toLowerCase()
  for (const name of LEGACY) {
    const legacy = join(parent, name)
    // Windows paths are case-insensitive, so the new folder can *be* a legacy
    // candidate under a different spelling. Copying it onto itself is pointless.
    if (legacy.toLowerCase() === lower) continue
    if (!existsSync(legacy) || !hasData(legacy)) continue
    try {
      cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false })
      return { from: legacy, to: current, files: countFiles(current) }
    } catch {
      // A partial copy is still better than none, and the app must start either
      // way; the caller reports that the adoption failed.
      return null
    }
  }
  return null
}
