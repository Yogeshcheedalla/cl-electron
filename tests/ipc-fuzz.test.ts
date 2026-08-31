import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CHANNELS } from '../shared/ipc'
import { initCryptoStore } from '../electron/core/crypto'
import { initLogger } from '../electron/core/logger'
import { initDatabase } from '../electron/db/db'
import { approvals } from '../electron/services/approvals'
import { initSecrets } from '../electron/services/secrets'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'
import { initSkills } from '../electron/services/skills'
import { assertHandlerCoverage, registerIpc } from '../electron/main/ipc'
import { ipcHandlers } from './stubs/electron'
import type { ToolResult } from '../shared/types'

/**
 * Argument fuzzing of every IPC channel, one channel at a time.
 *
 * `ipc-surface.test.ts` proves the three channel lists agree, and `tools.test.ts`
 * proves each tool validates its own input. Neither proves that a *channel*
 * survives hostile arguments, which is exactly what the renderer boundary
 * receives. This fires malformed and hostile arguments at the handlers the main
 * process registered -- the same functions `ipcMain.handle` would call -- and
 * requires that each one returns a `ToolResult` envelope instead of rejecting,
 * leaks neither a stack frame nor a secret, and leaves `Object.prototype` alone.
 *
 * Two containment measures make this safe to run: `allowedRoots` points at a
 * throwaway temp directory, so a write that somehow slipped past the path guard
 * lands there; and a background timer denies every approval request, so a channel
 * that asks for confirmation fails in milliseconds rather than waiting out the
 * three-minute approval timeout.
 */

/** Appears in one hostile string; must never come back out of a handler. */
const SECRET = 'FUZZSECRET0123456789'

const POLLUTION = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'
const trio = (value: unknown): unknown[] => [value, value, value]

/** Shapes a compromised or buggy renderer could send in place of a string. */
const STRUCTURAL: [string, unknown[]][] = [
  ['no arguments at all', []],
  ['null', trio(null)],
  ['undefined', trio(undefined)],
  ['an empty object', trio({})],
  ['an empty array', trio([])],
  ['a number', trio(42)],
  ['a negative number', trio(-1)],
  ['NaN and Infinity', [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
  ['booleans', [true, false, true]],
  ['a prototype-pollution payload', trio(JSON.parse(POLLUTION))],
  ['a 200k-character string', trio('a'.repeat(200_000))],
  ['a deeply nested array', trio([[[[[{ a: [1, 2, 3] }]]]]])],
  ['an object that throws when stringified', trio({ toString: () => { throw new Error('hostile toString') } })],
  ['a function-shaped object', trio({ then: 1, length: 9e9, constructor: 'x' })]
]

/** Strings a malicious prompt (or a stolen renderer) would try. */
const HOSTILE: [string, string][] = [
  ['a relative traversal', '..\\..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts'],
  ['a posix traversal', '../../../../etc/passwd'],
  ['a protected system path', 'C:\\Windows\\System32\\config\\SAM'],
  ['an extended-length path', '\\\\?\\C:\\Windows\\win.ini'],
  ['a UNC network path', '\\\\10.0.0.1\\share\\payload.exe'],
  ['an environment-variable path', '%USERPROFILE%\\..\\..\\Windows\\win.ini'],
  ['a credentials file', join(tmpdir(), 'akansha-fuzz', '.env')],
  ['an API key', `sk-ant-api03-${SECRET}`],
  ['a shell substitution', '$(Remove-Item -Recurse -Force C:\\)'],
  ['a chained destructive command', 'a & del /f /q C:\\*.* & rd /s /q C:\\'],
  ['a NUL byte', 'notes\u0000.txt'],
  ['a JSON prototype payload', '{"__proto__":{"polluted":true}}'],
  ['an internal event channel', 'akansha:event'],
  ['a script tag', '<script>alert(1)</script>'],
  ['a file URL', 'file:///C:/Windows/win.ini'],
  ['a 100k-character string', 'x'.repeat(100_000)]
]

/**
 * Channels whose handler ignores or coerces its arguments and then reaches the OS
 * or the network regardless: enumerating the Start Menu, running a PowerShell
 * probe, listing system voices, taking a diagnostic sweep. Fuzzing an argument
 * that cannot change the outcome proves nothing and costs a process per payload,
 * so they are named here instead of being quietly skipped.
 */
const IGNORES_ARGUMENTS = new Set([
  'apps:list',
  'system:getInfo',
  'system:processes',
  'computer:windows',
  'voice:capabilities',
  'diagnostics:run'
])

/**
 * Channels that validate first but would start a process, contact a network host
 * or change the power state if that validation ever failed. They still get the
 * structural battery -- an object or a number cannot be mistaken for a command --
 * but not the hostile strings, which are shaped to look like real arguments.
 */
const SPAWNS = new Set([
  'terminal:execute',
  'apps:launch',
  'apps:close',
  'apps:focus',
  'apps:openUrl',
  'apps:openPath',
  'system:control',
  'ai:send',
  'ai:test',
  'web:search',
  'web:fetchPage',
  'git:status',
  'git:diff',
  'git:log',
  'git:commit',
  'voice:transcribe',
  'files:search',
  'knowledge:addFolder',
  'knowledge:reindex',
  'tasks:run',
  'automations:run',
  'tools:invoke'
])

let sandbox = ''
let denier: NodeJS.Timeout

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'akansha-fuzz-'))
  sandbox = mkdtempSync(join(tmpdir(), 'akansha-fuzz-sandbox-'))
  initLogger(dir)
  initSettings(dir)
  initSecrets(dir)
  initCryptoStore(dir)
  initDatabase(dir)
  initSkills()
  registerIpc()
  // Nothing waits three minutes for an answer that is never coming.
  denier = setInterval(() => approvals.denyAll(), 20)
})

afterAll(() => clearInterval(denier))

beforeEach(() => {
  // Re-asserted every test: a payload that reached the settings service cannot
  // widen the write sandbox for the next one.
  settings.update({
    automation: { ...DEFAULT_SETTINGS.automation, allowedRoots: [sandbox] },
    privacy: { ...DEFAULT_SETTINGS.privacy },
    knowledge: { ...DEFAULT_SETTINGS.knowledge },
    updates: { ...DEFAULT_SETTINGS.updates }
  })
})

const fuzzable = CHANNELS.filter((c) => !IGNORES_ARGUMENTS.has(c))

/** Calls a channel exactly the way the preload bridge would, and audits the reply. */
async function fire(channel: string, args: unknown[]): Promise<ToolResult> {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`${channel} has no registered handler.`)
  const result = (await handler({ sender: {} }, ...args)) as ToolResult

  // 1. Always an envelope. A rejected promise would surface in the renderer as
  //    an unhandled Error with a main-process stack attached to it.
  expect(typeof result?.success, `${channel} did not return a ToolResult`).toBe('boolean')

  const body = JSON.stringify(result) ?? ''
  // 2. No stack frames: the renderer gets a sentence, never a file path listing.
  expect(body, `${channel} leaked a stack frame`).not.toMatch(/\\n\s+at /)
  // 3. No secret material. `redact` keeps the `sk-ant-` prefix on purpose, so it
  //    is the body of the key that must be gone.
  expect(body, `${channel} echoed a secret`).not.toContain(SECRET)
  return result
}

describe('IPC argument fuzzing', () => {
  it('registers a handler for every channel before any of this runs', () => {
    expect(assertHandlerCoverage()).toEqual([])
    expect([...ipcHandlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  it('documents every channel it skips', () => {
    for (const channel of [...IGNORES_ARGUMENTS, ...SPAWNS]) expect(CHANNELS).toContain(channel)
    // The skip lists are a small, deliberate minority of the surface.
    expect(IGNORES_ARGUMENTS.size + SPAWNS.size).toBeLessThan(CHANNELS.length / 2)
  })

  for (const [label, args] of STRUCTURAL) {
    it(`survives ${label} on every channel`, { timeout: 120_000 }, async () => {
      for (const channel of fuzzable) await fire(channel, args)
    })
  }

  for (const [label, value] of HOSTILE) {
    it(`refuses ${label} on every channel`, { timeout: 120_000 }, async () => {
      for (const channel of fuzzable) {
        if (SPAWNS.has(channel)) continue
        await fire(channel, [value, value, value])
      }
    })
  }

  it('never polluted Object.prototype', () => {
    const probe = {} as Record<string, unknown>
    expect(probe.polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })
})
