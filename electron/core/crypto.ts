import { safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'

/**
 * Field-level encryption for the one table worth protecting in a copied
 * `%APPDATA%` folder: memories. A random 32-byte data key lives in
 * `memkey.bin`, wrapped with Electron `safeStorage` (Windows DPAPI, scoped to
 * the signed-in account), exactly like `secrets.bin`. Content is sealed with
 * AES-256-GCM, so a tampered row fails to open rather than decoding to garbage.
 *
 * ponytail: this is not whole-database encryption. `node:sqlite` has no
 * SQLCipher binding, and adding a native one would reintroduce the rebuild step
 * the database was chosen to avoid. Conversations, activity and knowledge chunks
 * remain readable in the file -- SECURITY.md says so plainly rather than
 * implying the whole database is protected.
 */

const HEADER_WRAPPED = 'JKW1'
const HEADER_PLAIN = 'JKP1'
const PREFIX = 'v1:'

let key: Buffer | null = null
let wrapped = false
let warned = false

/** Reads or creates the data key. Called once at startup, before initDatabase. */
export function initCryptoStore(userDataDir: string): { available: boolean; wrapped: boolean } {
  const file = join(userDataDir, 'memkey.bin')
  try {
    if (existsSync(file)) {
      const buf = readFileSync(file)
      const header = buf.subarray(0, 4).toString('ascii')
      const body = buf.subarray(4)
      if (header === HEADER_WRAPPED) {
        key = Buffer.from(safeStorage.decryptString(body), 'base64')
        wrapped = true
      } else if (header === HEADER_PLAIN) {
        key = Buffer.from(body)
        wrapped = false
      } else {
        throw new Error('unrecognised key file header')
      }
      if (key.length !== 32) throw new Error(`key is ${key.length} bytes, expected 32`)
    } else {
      key = randomBytes(32)
      const canWrap = safeStorage.isEncryptionAvailable()
      const payload = canWrap
        ? Buffer.concat([Buffer.from(HEADER_WRAPPED, 'ascii'), safeStorage.encryptString(key.toString('base64'))])
        : Buffer.concat([Buffer.from(HEADER_PLAIN, 'ascii'), key])
      writeFileSync(file, payload, { mode: 0o600 })
      wrapped = canWrap
      if (!canWrap) {
        logger.warn('crypto.keyPlaintext', {
          reason: 'OS encryption is unavailable, so the memory key is stored unwrapped next to the database'
        })
      }
    }
    logger.info('crypto.ready', { wrapped })
  } catch (e) {
    // A key we cannot read is worse than no key: refusing to start would strand
    // the user, so encryption is disabled and said out loud instead.
    key = null
    logger.error('crypto.unavailable', { message: String(e) })
  }
  return { available: !!key, wrapped }
}

export const cryptoStore = {
  available: () => !!key,
  keyWrapped: () => wrapped
}

/** Seals text. Returns it unchanged (once, with a warning) when no key exists. */
export function encryptText(plain: string): string {
  if (!key) {
    if (!warned) {
      warned = true
      logger.warn('crypto.disabled', { reason: 'no data key; memory content is stored as plain text' })
    }
    return plain
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

export const isEncrypted = (stored: string) => typeof stored === 'string' && stored.startsWith(PREFIX)

/**
 * Opens sealed text. Rows written before encryption was switched on are plain
 * and pass through untouched, so upgrading is not a flag day.
 */
export function decryptText(stored: string): string {
  if (!isEncrypted(stored)) return stored
  if (!key) return '[encrypted: this memory needs the key from %APPDATA%\\Akansha\\memkey.bin]'
  const [, ivB64 = '', tagB64 = '', ctB64 = ''] = stored.split(':')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    logger.warn('crypto.undecryptable', { reason: 'wrong key or tampered row' })
    return '[encrypted: could not be decrypted with this Windows account]'
  }
}
