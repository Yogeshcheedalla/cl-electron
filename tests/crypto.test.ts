import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { decryptText, encryptText, initCryptoStore, isEncrypted, cryptoStore } from '../electron/core/crypto'
import { initLogger } from '../electron/core/logger'
import { all, get, initDatabase, run } from '../electron/db/db'
import { memories } from '../electron/db/state.repo'
import { initSettings } from '../electron/services/settings'

/**
 * Memory encryption at rest.
 *
 * The point of the feature is that a copied `%APPDATA%` folder is boring, so the
 * decisive assertion is not "the roundtrip works" -- it is that the plaintext is
 * genuinely absent from the `content` column and from the `.db` file on disk.
 * Both are checked below with raw SQL and a byte search.
 *
 * In this suite `safeStorage.isEncryptionAvailable()` is false (see
 * `tests/stubs/electron.ts`), so the data key is written unwrapped with a `JKP1`
 * header. That is the documented degraded path, and it is worth testing on its
 * own: field encryption must still work when DPAPI does not.
 */

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-crypto-'))
  initLogger(dir)
  initSettings(dir)
  initCryptoStore(dir)
  initDatabase(dir)
})

describe('memory encryption', () => {
  it('creates a 32-byte data key on first run', () => {
    const file = join(dir, 'memkey.bin')
    expect(existsSync(file)).toBe(true)
    const buf = readFileSync(file)
    // No DPAPI in the test stub, so the honest header is the plain one.
    expect(buf.subarray(0, 4).toString('ascii')).toBe('JKP1')
    expect(buf.length - 4).toBe(32)
    expect(cryptoStore.available()).toBe(true)
    expect(cryptoStore.keyWrapped()).toBe(false)
  })

  it('reuses the same key when reopened', () => {
    const before = readFileSync(join(dir, 'memkey.bin'))
    const secret = encryptText('the same key must open this')
    initCryptoStore(dir)
    expect(readFileSync(join(dir, 'memkey.bin')).equals(before)).toBe(true)
    expect(decryptText(secret)).toBe('the same key must open this')
  })

  it('seals and opens text, and every sealing differs', () => {
    const plain = 'The user prefers dark mode and lives in Hyderabad.'
    const a = encryptText(plain)
    const b = encryptText(plain)
    expect(isEncrypted(a)).toBe(true)
    expect(a).not.toBe(b) // random IV per row
    expect(a).not.toContain('Hyderabad')
    expect(decryptText(a)).toBe(plain)
    expect(decryptText(b)).toBe(plain)
  })

  it('stores ciphertext in the content column, not the text', () => {
    const mem = memories.create({ content: 'Passport number is UNIQUEPHRASE42', category: 'FACT' })
    const row = get<{ content: string }>('SELECT content FROM memories WHERE id = ?', mem.id)
    expect(row?.content).toBeTruthy()
    expect(isEncrypted(row?.content ?? '')).toBe(true)
    expect(row?.content).not.toContain('UNIQUEPHRASE42')
    // The repository is the only thing that sees plaintext.
    expect(memories.list().find((m) => m.id === mem.id)?.content).toBe('Passport number is UNIQUEPHRASE42')
  })

  it('leaves no plaintext in the database file itself', () => {
    memories.create({ content: 'ANOTHERUNIQUEPHRASE99 should not be greppable' })
    // WAL mode: the row may still be in the write-ahead log, so both are checked.
    const db = join(dir, 'database', 'akansha.db')
    const bytes = [db, `${db}-wal`]
      .filter(existsSync)
      .map((f) => readFileSync(f).toString('latin1'))
      .join('')
    expect(bytes).not.toContain('ANOTHERUNIQUEPHRASE99')
  })

  it('still finds encrypted memories by content', () => {
    memories.create({ content: 'The dev server runs on port 5199.' })
    const hits = memories.search('port 5199')
    expect(hits.length).toBe(1)
    expect(hits[0]?.content).toContain('5199')
    expect(memories.search('nothing matches this at all')).toEqual([])
  })

  it('reads rows written before encryption existed, and seals them', () => {
    // Exactly what an upgraded database looks like: plain text in the column.
    run(
      'INSERT INTO memories (id,category,content,source,confidence,created_ms) VALUES (?,?,?,?,?,?)',
      'legacy-row',
      'PREFERENCE',
      'legacy plaintext memory',
      'user',
      'high',
      Date.now()
    )
    expect(memories.list().find((m) => m.id === 'legacy-row')?.content).toBe('legacy plaintext memory')
    expect(memories.search('legacy plaintext').length).toBe(1)

    const sealed = memories.sealPlaintext()
    expect(sealed).toBeGreaterThanOrEqual(1)
    const raw = get<{ content: string }>('SELECT content FROM memories WHERE id = ?', 'legacy-row')
    expect(isEncrypted(raw?.content ?? '')).toBe(true)
    expect(memories.list().find((m) => m.id === 'legacy-row')?.content).toBe('legacy plaintext memory')
    // Idempotent: a second pass has nothing left to convert.
    expect(memories.sealPlaintext()).toBe(0)
  })

  it('reports a tampered row instead of returning garbage', () => {
    const mem = memories.create({ content: 'authentic content' })
    const row = get<{ content: string }>('SELECT content FROM memories WHERE id = ?', mem.id)
    const parts = (row?.content ?? '').split(':')
    // Flip one byte of the ciphertext. AES-GCM authenticates, so this must fail
    // to open rather than decode to a plausible-looking string.
    const ct = Buffer.from(parts[3] ?? '', 'base64')
    ct[0] = (ct[0] ?? 0) ^ 0xff
    run(
      'UPDATE memories SET content = ? WHERE id = ?',
      `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString('base64')}`,
      mem.id
    )
    const reread = memories.list().find((m) => m.id === mem.id)?.content ?? ''
    expect(reread).toMatch(/^\[encrypted:/)
    expect(reread).not.toContain('authentic content')
  })

  it('encrypts every memory row the app has written', () => {
    const rows = all<{ content: string }>('SELECT content FROM memories')
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.every((r) => isEncrypted(r.content))).toBe(true)
  })
})
