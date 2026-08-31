import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TOOLS, getTool, invokeTool, toolDescriptors, toolSchemas } from '../electron/agents/tools'
import { setToolLevel } from '../electron/services/permissions'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'
import { estimateCost, knownPricedModels, pickRole, resolveModel } from '../electron/ai/router'
import type { ModelRole } from '../shared/types'

beforeAll(() => {
  initSettings(mkdtempSync(join(tmpdir(), 'akansha-tools-')))
})

beforeEach(() => {
  settings.update({
    ai: { ...DEFAULT_SETTINGS.ai },
    automation: { ...DEFAULT_SETTINGS.automation }
  })
})

describe('tool registry', () => {
  it('has tools, each with a unique name', () => {
    expect(TOOLS.length).toBeGreaterThan(20)
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names every tool as group.action and describes it', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/)
      expect(t.description.length).toBeGreaterThan(15)
      expect(t.group).not.toBe('')
    }
  })

  it('gives every tool a zod schema that converts to JSON Schema', () => {
    for (const t of TOOLS) {
      expect(t.schema).toBeDefined()
      const json = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>
      expect(json.type).toBe('object')
    }
  })

  it('declares a real permission level for every tool', () => {
    for (const t of TOOLS) {
      expect(['SAFE', 'CONFIRM', 'PRIVILEGED', 'BLOCKED']).toContain(t.level)
    }
  })

  /**
   * The full SAFE list is spelled out so that promoting a tool to "runs without
   * asking" is a deliberate edit to this test, never a side effect of adding a
   * tool. Everything here either reads, or writes only where the user pointed
   * (clipboard, notification, memory, a new folder, a non-clobbering copy).
   */
  const SAFE_TOOLS = [
    'app.focus', 'app.launch', 'app.list', 'app.openPath', 'app.openUrl',
    'clipboard.read', 'clipboard.write', 'document.read',
    'file.copy', 'file.list', 'file.mkdir', 'file.read', 'file.search',
    'git.diff', 'git.log', 'git.status', 'knowledge.search',
    'memory.save', 'memory.search', 'notify.show',
    'system.info', 'system.processes', 'task.create', 'task.list', 'task.update',
    'web.fetch', 'web.search', 'window.list'
  ]

  it('runs exactly this list of tools without asking', () => {
    const safe = TOOLS.filter((t) => t.level === 'SAFE').map((t) => t.name).sort()
    expect(safe).toEqual([...SAFE_TOOLS].sort())
  })

  it('makes every destructive or system-changing tool ask first', () => {
    const expected: Record<string, string> = {
      'system.control': 'PRIVILEGED', // shutdown, restart, sleep, lock
      'terminal.run': 'CONFIRM', // classifies the command itself as well
      'file.write': 'CONFIRM',
      'file.rename': 'CONFIRM',
      'file.move': 'CONFIRM',
      'file.remove': 'CONFIRM',
      'app.close': 'CONFIRM',
      'git.commit': 'CONFIRM',
      'screen.capture': 'CONFIRM',
      'automation.run': 'CONFIRM'
    }
    for (const [name, level] of Object.entries(expected)) {
      expect(getTool(name), `${name} should exist`).toBeDefined()
      expect(getTool(name)?.level, `${name} must be ${level}`).toBe(level)
    }
  })

  it('lets the command classifier, not the registry, decide a terminal run', () => {
    expect(getTool('terminal.run')?.selfGuarded).toBe(true)
  })

  /**
   * The Windows actions Akansha is expected to perform, each mapped to the one
   * allowlisted tool that performs it. This is the answer to "can it turn the
   * volume down?" being a fixed enum rather than a shell string: every entry
   * here is a named tool with a schema, so a model asking for one of these can
   * only ask for one of these.
   */
  it('covers every advertised Windows action with an allowlisted tool', () => {
    const actions: Record<string, string> = {
      'open application': 'app.launch',
      'open URL': 'app.openUrl',
      'open folder': 'app.openPath',
      'web search': 'web.search',
      'volume up': 'system.control',
      'volume down': 'system.control',
      mute: 'system.control',
      screenshot: 'screen.capture',
      'read clipboard': 'clipboard.read',
      'write clipboard': 'clipboard.write',
      lock: 'system.control',
      sleep: 'system.control',
      restart: 'system.control',
      shutdown: 'system.control'
    }
    for (const [action, tool] of Object.entries(actions)) {
      expect(getTool(tool), `${action} needs ${tool}`).toBeDefined()
    }
  })

  it('accepts only the fixed set of machine actions, never a free-form command', () => {
    const control = getTool('system.control')
    const parsed = control?.schema.safeParse({ action: 'volume-mute' })
    expect(parsed?.success).toBe(true)
    for (const action of ['lock', 'sleep', 'shutdown', 'restart', 'signout', 'volume-up', 'volume-down', 'brightness']) {
      expect(control?.schema.safeParse({ action }).success, action).toBe(true)
    }
    // Anything outside the enum is refused before it reaches PowerShell.
    for (const action of ['Stop-Computer', 'rm -rf /', 'volume-up; shutdown', '']) {
      expect(control?.schema.safeParse({ action }).success, action).toBe(false)
    }
  })

  it('exposes no tool that reads secrets or runs unrestricted code', () => {
    for (const t of TOOLS) {
      expect(t.name).not.toMatch(/secret|apikey|credential|eval|require/i)
    }
  })

  it('describes the same tools to the UI as it registers', () => {
    const descriptors = toolDescriptors()
    expect(descriptors).toHaveLength(TOOLS.length)
    expect(descriptors.map((d) => d.name).sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })

  it('reports the user override as the effective level', () => {
    setToolLevel('system.info', 'CONFIRM')
    const row = toolDescriptors().find((d) => d.name === 'system.info')
    expect(row).toMatchObject({ level: 'SAFE', effectiveLevel: 'CONFIRM' })
  })

  it('hides a blocked tool from the model entirely', () => {
    const target = TOOLS.find((t) => t.level !== 'BLOCKED')?.name as string
    expect(toolSchemas().map((s) => s.name)).toContain(target)
    setToolLevel(target, 'BLOCKED')
    expect(toolSchemas().map((s) => s.name)).not.toContain(target)
  })

  it('sends the model a schema per tool with no $schema noise', () => {
    for (const s of toolSchemas()) {
      expect(s.name).not.toBe('')
      expect(s.description.length).toBeGreaterThan(0)
      expect(s.schema).not.toHaveProperty('$schema')
      expect(s.schema).toHaveProperty('type', 'object')
    }
  })
})

describe('invokeTool', () => {
  it('refuses an unknown tool by name', async () => {
    await expect(invokeTool('nope.nothing', {})).rejects.toThrow(/Unknown tool/i)
  })

  it('refuses a tool the model invented from a real namespace', async () => {
    await expect(invokeTool('files.deleteEverything', {})).rejects.toThrow(/Unknown tool/i)
  })

  it('rejects input that fails the schema before doing any work', async () => {
    // file.read needs a path; an empty object must not reach the filesystem.
    await expect(invokeTool('file.read', {})).rejects.toThrow(/Invalid input/i)
    await expect(invokeTool('file.read', { path: '' })).rejects.toThrow(/Invalid input/i)
  })

  it('names the offending field so the model can correct itself', async () => {
    await expect(invokeTool('file.read', { path: 123 })).rejects.toThrow(/path/i)
  })

  it('resolves a tool by name for the developer console', () => {
    expect(getTool('system.info')?.level).toBe('SAFE')
    expect(getTool('does.notExist')).toBeUndefined()
  })
})

describe('model routing', () => {
  const role = (text: string, opts?: { hasImages?: boolean }) => pickRole(text, opts)

  it('routes short pleasantries to the fast model', () => {
    expect(role('hi')).toBe('FAST')
    expect(role('thanks!')).toBe('FAST')
  })

  it('routes code questions to the coding model', () => {
    expect(role('why does this typescript function throw a stack trace?')).toBe('CODING')
    expect(role('fix the failing npm test')).toBe('CODING')
  })

  it('routes analysis and long prompts to the reasoning model', () => {
    expect(role('compare these two approaches and explain the trade-offs')).toBe('REASONING')
    expect(role('a'.repeat(1000))).toBe('REASONING')
  })

  it('routes anything with an image to the vision model', () => {
    expect(role('what is on my screen?', { hasImages: true })).toBe('VISION')
    // Images win even when the text looks like code.
    expect(role('debug this typescript error', { hasImages: true })).toBe('VISION')
  })

  it('falls back to the general model', () => {
    expect(role('remind me what my calendar looks like tomorrow')).toBe('GENERAL')
  })

  it('survives empty and non-string input', () => {
    expect(role('')).toBe('GENERAL')
    expect(pickRole(undefined as unknown as string)).toBe('GENERAL')
  })

  it('resolves each role to its configured provider and model', () => {
    for (const r of ['GENERAL', 'FAST', 'REASONING', 'CODING', 'VISION', 'LOCAL'] as ModelRole[]) {
      const resolved = resolveModel(r)
      expect(resolved.role).toBe(r)
      expect(resolved.model).toBe(DEFAULT_SETTINGS.ai.routing[r].model)
    }
  })

  it('pins one model when auto-routing is off', () => {
    settings.update({ ai: { ...settings.get().ai, autoRoute: false, provider: 'openai' } })
    const resolved = resolveModel('CODING')
    expect(resolved).toMatchObject({ role: 'GENERAL', provider: 'openai' })
  })

  it('costs a known model and returns zero for an unknown one', () => {
    expect(estimateCost('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(3)
    expect(estimateCost('claude-sonnet-5', 0, 1_000_000)).toBeCloseTo(15)
    expect(estimateCost('some-local-model', 1_000_000, 1_000_000)).toBe(0)
    expect(estimateCost('claude-sonnet-5', 0, 0)).toBe(0)
  })

  it('prices every model the default routing table points at', () => {
    for (const entry of Object.values(DEFAULT_SETTINGS.ai.routing)) {
      if (entry.provider === 'ollama') continue // local models are free
      expect(knownPricedModels).toContain(entry.model)
    }
  })
})
