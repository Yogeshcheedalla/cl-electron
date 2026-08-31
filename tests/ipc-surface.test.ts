import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_SHAPE, CHANNELS, EVENT_CHANNEL } from '../shared/ipc'

/**
 * The bridge is only as trustworthy as the match between three lists: the shape
 * the preload whitelists, the channels the main process answers, and the API the
 * renderer calls. A drift here is a dead button (or worse, an unreachable
 * permission check), so it fails the build instead.
 *
 * These are source-level checks on purpose -- importing the real modules would
 * drag a live Electron app, a database and PowerShell into a unit test.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')

const ipcSource = read('electron/main/ipc.ts')
const preloadSource = read('electron/preload/index.ts')
const apiSource = read('shared/api.ts')

/** Every `handle('ns:method', ...)` literal in the main process. */
const handled = [...ipcSource.matchAll(/\bhandle\('([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1])

describe('IPC surface', () => {
  it('registers a handler for every channel in API_SHAPE', () => {
    const missing = CHANNELS.filter((c) => !handled.includes(c))
    expect(missing).toEqual([])
  })

  it('registers no channel that API_SHAPE does not declare', () => {
    const extra = handled.filter((c) => !CHANNELS.includes(c))
    expect(extra).toEqual([])
  })

  it('registers each channel exactly once', () => {
    const duplicates = handled.filter((c, i) => handled.indexOf(c) !== i)
    expect(duplicates).toEqual([])
  })

  it('never exposes a generic execute/eval channel', () => {
    const forbidden = CHANNELS.filter((c) => /execute-?anything|:eval$|:exec$|:invokeRaw|:raw$|node:/i.test(c))
    expect(forbidden).toEqual([])
  })

  it('describes every namespace in the renderer-facing type', () => {
    for (const ns of Object.keys(API_SHAPE)) expect(apiSource).toContain(`${ns}:`)
  })
})

describe('preload', () => {
  it('builds the bridge from API_SHAPE rather than a hand-written list', () => {
    expect(preloadSource).toContain('API_SHAPE')
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld')
  })

  it('does not hand the renderer ipcRenderer, require or process', () => {
    // `ipcRenderer.invoke` is used *inside* the closure; what must never happen
    // is exposing the object (or Node) itself across the bridge.
    expect(preloadSource).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/)
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*['"](require|process|fs|node)['"]/)
    expect(preloadSource).not.toMatch(/\bipcRenderer\s*,?\s*}\s*\)/)
    expect(preloadSource).not.toContain('nodeIntegration')
  })

  it('sends every main -> renderer push over the single event channel', () => {
    expect(preloadSource).toMatch(/EVENT_CHANNEL/)
    const listened = [...preloadSource.matchAll(/ipcRenderer\.on\(\s*([^,]+),/g)].map((m) => m[1].trim())
    expect(listened.length).toBeGreaterThan(0)
    expect(listened.every((c) => c === 'EVENT_CHANNEL' || c === `'${EVENT_CHANNEL}'`)).toBe(true)
  })
})

describe('window creation', () => {
  const windows = read('electron/main/windows.ts')

  it('keeps the renderer sandboxed with context isolation on', () => {
    expect(windows).toMatch(/contextIsolation:\s*true/)
    expect(windows).toMatch(/nodeIntegration:\s*false/)
    expect(windows).toMatch(/sandbox:\s*true/)
  })

  it('does not enable remote content or the remote module', () => {
    expect(windows).not.toMatch(/webSecurity:\s*false/)
    expect(windows).not.toMatch(/enableRemoteModule/)
    expect(windows).not.toMatch(/allowRunningInsecureContent/)
  })
})
