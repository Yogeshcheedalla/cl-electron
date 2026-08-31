import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLegacyUserData } from '../electron/main/userdata'
import { initLogger, logFilePath } from '../electron/core/logger'

/**
 * The rebrand moved the user data folder, and this is the code that stops that
 * from reading as data loss. What has to be true: an existing install's keys,
 * memory key, settings and database arrive in the new folder; a folder that
 * already has data is never overwritten by an older copy; and the old folder is
 * still there afterwards, because the copy is a copy.
 */

/** A plausible pre-rebrand folder, database file name and all. */
function legacyInstall(parent: string, name: string): string {
  const dir = join(parent, name)
  mkdirSync(join(dir, 'database'), { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{"general":{"launchAtLogin":false}}')
  writeFileSync(join(dir, 'secrets.bin'), 'DPAPI-BLOB')
  writeFileSync(join(dir, 'memkey.bin'), 'JKW1KEYBYTES')
  writeFileSync(join(dir, 'database', 'jarvis.db'), 'SQLITE-FORMAT-3')
  return dir
}

const parent = () => mkdtempSync(join(tmpdir(), 'akansha-userdata-'))

describe('legacy user data adoption', () => {
  it('carries an existing install forward to the renamed folder', () => {
    const root = parent()
    const legacy = legacyInstall(root, 'JARVIS')
    const current = join(root, 'Akansha')

    const result = adoptLegacyUserData(current)
    expect(result?.from).toBe(legacy)
    expect(result?.files).toBe(4)
    // The things whose loss the user would actually notice.
    expect(readFileSync(join(current, 'secrets.bin'), 'utf8')).toBe('DPAPI-BLOB')
    expect(readFileSync(join(current, 'memkey.bin'), 'utf8')).toBe('JKW1KEYBYTES')
    expect(readFileSync(join(current, 'database', 'jarvis.db'), 'utf8')).toBe('SQLITE-FORMAT-3')
    // ...and nothing was moved: the old install still works if this build is rolled back.
    expect(existsSync(join(legacy, 'secrets.bin'))).toBe(true)
  })

  it('also finds the lowercase folder a development run left behind', () => {
    const root = parent()
    legacyInstall(root, 'jarvis')
    const current = join(root, 'akansha')
    expect(adoptLegacyUserData(current)?.files).toBe(4)
  })

  it('refuses to touch a folder that already holds data', () => {
    const root = parent()
    legacyInstall(root, 'JARVIS')
    const current = join(root, 'Akansha')
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'settings.json'), '{"general":{"launchAtLogin":true}}')

    expect(adoptLegacyUserData(current)).toBeNull()
    // The live setting survived; the older copy did not win.
    expect(readFileSync(join(current, 'settings.json'), 'utf8')).toContain('true')
    expect(existsSync(join(current, 'secrets.bin'))).toBe(false)
  })

  it('does nothing on a first-ever launch', () => {
    const root = parent()
    expect(adoptLegacyUserData(join(root, 'Akansha'))).toBeNull()
  })

  it('ignores an empty folder left by an uninstall', () => {
    const root = parent()
    mkdirSync(join(root, 'JARVIS'), { recursive: true })
    expect(adoptLegacyUserData(join(root, 'Akansha'))).toBeNull()
  })
})

describe('legacy log adoption', () => {
  it('renames a pre-rebrand jarvis.log forward and keeps its history', () => {
    const dir = parent()
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'jarvis.log'), '{"event":"old.line"}\n')

    initLogger(dir)
    expect(logFilePath()).toBe(join(dir, 'logs', 'akansha.log'))
    expect(existsSync(join(dir, 'logs', 'jarvis.log'))).toBe(false)
    const carried = readFileSync(join(dir, 'logs', 'akansha.log'), 'utf8')
    expect(carried).toContain('old.line')
    expect(carried).toContain('logger.ready')
  })

  it('leaves an old log alone when the renamed one already exists', () => {
    const dir = parent()
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'jarvis.log'), 'STALE\n')
    writeFileSync(join(dir, 'logs', 'akansha.log'), 'LIVE\n')

    initLogger(dir)
    expect(readFileSync(join(dir, 'logs', 'jarvis.log'), 'utf8')).toBe('STALE\n')
    expect(readFileSync(join(dir, 'logs', 'akansha.log'), 'utf8')).toContain('LIVE')
  })
})
