import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../core/logger'

/**
 * API keys live in a file encrypted with Electron `safeStorage`, which is backed
 * by Windows DPAPI and scoped to the current user account. Keys never reach the
 * renderer: the UI only ever learns whether a key is present.
 */
let file = ''
let cache: Record<string, string> = {}

export function initSecrets(userDataDir: string) {
  mkdirSync(userDataDir, { recursive: true })
  file = join(userDataDir, 'secrets.bin')
  if (!existsSync(file)) return
  try {
    const raw = readFileSync(file)
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    cache = JSON.parse(json)
  } catch (e) {
    logger.warn('secrets.unreadable', { message: String(e) })
    cache = {}
  }
}

function persist() {
  const json = JSON.stringify(cache)
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  writeFileSync(file, buf)
  if (!safeStorage.isEncryptionAvailable()) {
    logger.warn('secrets.plaintext', { reason: 'OS encryption unavailable' })
  }
}

export const secrets = {
  /** Falls back to an environment variable so CI and power users can inject keys. */
  get(name: string): string | undefined {
    return cache[name] || process.env[`AKANSHA_${name.toUpperCase()}_API_KEY`] || undefined
  },

  has(name: string) {
    return Boolean(secrets.get(name))
  },

  set(name: string, value: string) {
    if (!value.trim()) return secrets.clear(name)
    cache[name] = value.trim()
    persist()
    logger.info('secrets.set', { name })
  },

  clear(name: string) {
    delete cache[name]
    persist()
    logger.info('secrets.cleared', { name })
  },

  encryptionAvailable: () => safeStorage.isEncryptionAvailable()
}
