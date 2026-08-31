import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initLogger } from '../electron/core/logger'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'
import { updates } from '../electron/services/updates'

/**
 * The updater's refusals, which are the half of it that can be tested without a
 * live feed and an installed build.
 *
 * `app.isPackaged` is false in this suite (see `tests/stubs/electron.ts`), which
 * is exactly the state a developer run is in -- so these tests double as proof
 * that a run-from-source copy says so instead of failing obscurely against a
 * feed. `electron-updater` is imported lazily inside `updater()`, and every path
 * below refuses before that import, so nothing here touches the network.
 */

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-updates-'))
  initLogger(dir)
  initSettings(dir)
})

beforeEach(() => {
  settings.update({ updates: { ...DEFAULT_SETTINGS.updates } })
})

const config = (patch: Partial<typeof DEFAULT_SETTINGS.updates>) =>
  settings.update({ updates: { ...DEFAULT_SETTINGS.updates, ...patch } })

describe('update feed configuration', () => {
  it('ships with updates off and no feed', () => {
    const s = updates.state()
    expect(s.enabled).toBe(false)
    expect(s.feedUrl).toBe('')
    expect(s.configured).toBe(false)
    expect(s.status).toBe('idle')
  })

  it('is unsupported when running from source', () => {
    // The distinction the Settings card reports: "no installer to replace" is not
    // the same problem as "no feed URL".
    expect(updates.state().supported).toBe(false)
  })

  it('stays unconfigured until updates are enabled', () => {
    config({ enabled: false, feedUrl: 'https://downloads.example.com/akansha' })
    expect(updates.state().configured).toBe(false)
  })

  it('refuses a feed that is not https', () => {
    for (const url of [
      'http://downloads.example.com/akansha',
      'ftp://downloads.example.com/akansha',
      'file:///C:/Windows/Temp',
      'downloads.example.com/akansha',
      '  '
    ]) {
      config({ enabled: true, feedUrl: url })
      expect(updates.state().configured, `${url} must not count as configured`).toBe(false)
    }
  })

  it('accepts an https feed and reports the URL back', () => {
    config({ enabled: true, feedUrl: 'https://downloads.example.com/akansha/' })
    const s = updates.state()
    expect(s.configured).toBe(true)
    expect(s.feedUrl).toBe('https://downloads.example.com/akansha/')
  })
})

describe('update actions', () => {
  it('will not check with no feed configured', async () => {
    await expect(updates.check()).rejects.toThrow(/No update feed is configured/i)
  })

  it('says a development run has no installer to replace', async () => {
    config({ enabled: true, feedUrl: 'https://downloads.example.com/akansha' })
    await expect(updates.check()).rejects.toThrow(/installed build/i)
  })

  it('will not download or install with nothing found', async () => {
    config({ enabled: true, feedUrl: 'https://downloads.example.com/akansha' })
    await expect(updates.download()).rejects.toThrow(/no downloaded-and-waiting update/i)
    await expect(updates.install()).rejects.toThrow(/nothing to install/i)
  })

  it('does nothing at startup unless the user asked for it', async () => {
    // Enabled, configured, but checkOnStart off: still silent.
    config({ enabled: true, feedUrl: 'https://downloads.example.com/akansha', checkOnStart: false })
    await expect(updates.checkOnStart()).resolves.toBeUndefined()
    expect(updates.state().checkedMs).toBeUndefined()

    // And with it on, an unpackaged build still refuses -- without throwing into
    // startup, which is the part that matters.
    config({ enabled: true, feedUrl: 'https://downloads.example.com/akansha', checkOnStart: true })
    await expect(updates.checkOnStart()).resolves.toBeUndefined()
    expect(updates.state().checkedMs).toBeUndefined()
  })
})
