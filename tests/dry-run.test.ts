import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCryptoStore } from '../electron/core/crypto'
import { initLogger } from '../electron/core/logger'
import { initDatabase } from '../electron/db/db'
import { automations as store } from '../electron/db/state.repo'
import { automationEngine } from '../electron/services/automation'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'
import { initSecrets } from '../electron/services/secrets'
import type { Automation, AutomationStep } from '../shared/records'

/**
 * The per-automation dry run.
 *
 * A dry run is only useful if it is truthful in both directions: the verdict it
 * prints must match what a real run would decide, and it must not have done any
 * of it. The first is checked verdict by verdict against the same policy `run`
 * uses; the second is checked by dry-running a step that would create a file and
 * then asserting the file is not there.
 */

let dir = ''
let sandbox = ''
let seq = 0

const auto = (steps: AutomationStep[], enabled = true): Automation => {
  const a: Automation = {
    id: `dry-${seq++}`,
    name: `Dry run fixture ${seq}`,
    description: '',
    trigger: { type: 'manual' },
    steps,
    enabled
  }
  return store.save(a)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-dry-'))
  sandbox = mkdtempSync(join(tmpdir(), 'akansha-dry-sandbox-'))
  initLogger(dir)
  initSettings(dir)
  initSecrets(dir)
  initCryptoStore(dir)
  initDatabase(dir)
})

beforeEach(() => {
  settings.update({
    automation: { ...DEFAULT_SETTINGS.automation, allowedRoots: [sandbox] }
  })
})

describe('automation dry run', () => {
  it('refuses an id that does not exist', () => {
    expect(() => automationEngine.dryRun('no-such-automation')).toThrow(/No automation/)
  })

  it('reports a safe step as one that would run', () => {
    const a = auto([{ tool: 'system.info', input: {} }])
    const plan = automationEngine.dryRun(a.id)
    expect(plan.ok).toBe(true)
    expect(plan.automation).toBe(a.name)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.verdict).toBe('run')
    expect(plan.steps[0]?.index).toBe(1)
    expect(plan.steps[0]?.effectiveLevel).toBe('SAFE')
    expect(plan.steps[0]?.summary).toContain('system.info(')
  })

  it('reports a destructive step as one that would ask first', () => {
    const a = auto([
      { tool: 'file.write', input: { path: join(sandbox, 'from-dry-run.txt'), content: 'hello' } }
    ])
    const plan = automationEngine.dryRun(a.id)
    expect(plan.steps[0]?.verdict).toBe('ask')
    expect(plan.steps[0]?.declaredLevel).toBe('CONFIRM')
    // ...and nothing was written. This is the assertion the feature exists for.
    expect(existsSync(join(sandbox, 'from-dry-run.txt'))).toBe(false)
    expect(plan.ok).toBe(true)
  })

  it('drops the confirmation once the tool is trusted, exactly as a real run would', () => {
    const a = auto([{ tool: 'file.write', input: { path: join(sandbox, 'trusted.txt'), content: 'x' } }])
    settings.update({
      automation: { ...settings.get().automation, trustedTools: ['file.write'] }
    })
    expect(automationEngine.dryRun(a.id).steps[0]?.verdict).toBe('run')
    expect(existsSync(join(sandbox, 'trusted.txt'))).toBe(false)
  })

  it('reports a blocked tool as denied', () => {
    const a = auto([{ tool: 'system.info', input: {} }])
    settings.update({
      automation: { ...settings.get().automation, toolLevels: { 'system.info': 'BLOCKED' } }
    })
    const plan = automationEngine.dryRun(a.id)
    expect(plan.ok).toBe(false)
    expect(plan.steps[0]?.verdict).toBe('deny')
    expect(plan.steps[0]?.effectiveLevel).toBe('BLOCKED')
    expect(plan.steps[0]?.detail).toMatch(/blocked/i)
  })

  it('names the field when a step would fail its own schema', () => {
    const a = auto([{ tool: 'file.read', input: { notAPath: 42 } }])
    const plan = automationEngine.dryRun(a.id)
    expect(plan.ok).toBe(false)
    expect(plan.steps[0]?.verdict).toBe('invalid')
    expect(plan.steps[0]?.detail).toContain('path')
  })

  it('reports a step whose tool does not exist', () => {
    const a = auto([{ tool: 'definitely.not.a.tool', input: {} }])
    const plan = automationEngine.dryRun(a.id)
    expect(plan.ok).toBe(false)
    expect(plan.steps[0]?.verdict).toBe('unknown-tool')
    expect(plan.steps[0]?.detail).toContain('definitely.not.a.tool')
  })

  it('marks steps that depend on a step which would not run', () => {
    const a = auto([
      { tool: 'file.read', input: {} },
      { tool: 'system.info', input: {} },
      { tool: 'system.processes', input: {}, requiresPrevious: false }
    ])
    const plan = automationEngine.dryRun(a.id)
    expect(plan.steps.map((s) => s.verdict)).toEqual(['invalid', 'skipped', 'run'])
    expect(plan.steps[1]?.detail).toMatch(/previous step/i)
    expect(plan.ok).toBe(false)
  })

  it('says a disabled automation would refuse before any step', () => {
    const a = auto([{ tool: 'system.info', input: {} }], false)
    const plan = automationEngine.dryRun(a.id)
    expect(plan.ok).toBe(false)
    expect(plan.log.join('\n')).toMatch(/disabled/i)
    // The steps are still analysed, so the user can fix everything in one pass.
    expect(plan.steps[0]?.verdict).toBe('run')
  })

  it('says so when an automation has no steps', () => {
    // `save` refuses empty steps through the engine, so this goes in the way a
    // hand-edited database row would.
    const a = store.save({
      id: 'dry-empty',
      name: 'Empty',
      description: '',
      trigger: { type: 'manual' },
      steps: [],
      enabled: true
    })
    const plan = automationEngine.dryRun(a.id)
    expect(plan.steps).toEqual([])
    expect(plan.log.join('\n')).toMatch(/no steps/i)
  })

  it('does not change the automation it inspected', () => {
    const a = auto([{ tool: 'system.info', input: {} }])
    automationEngine.dryRun(a.id)
    const after = store.get(a.id)
    // A real run stamps lastRunMs and lastStatus; a dry run must not.
    expect(after?.lastRunMs).toBeUndefined()
    expect(after?.lastStatus).toBeUndefined()
  })
})
