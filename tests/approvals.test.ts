import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from '../electron/db/db'
import { initLogger } from '../electron/core/logger'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'
import { approvals } from '../electron/services/approvals'
import { PermissionRefused, authorize } from '../electron/services/guard'
import { invokeTool } from '../electron/agents/tools'

/**
 * The approval gate is the last thing standing between the model and a
 * destructive action, so these tests answer prompts the way the user would and
 * check that a refusal actually stops the call.
 */
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'akansha-approvals-'))
  initLogger(dir)
  initSettings(dir)
  initDatabase(dir)
})

beforeEach(() => {
  settings.update({ automation: { ...DEFAULT_SETTINGS.automation } })
})

afterEach(() => {
  approvals.denyAll()
})

/** Waits for the request to appear, then answers it the way the user would. */
async function answer(decision: 'once' | 'always' | 'deny'): Promise<void> {
  for (let i = 0; i < 50 && approvals.list().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  const request = approvals.list()[0]
  if (!request) throw new Error('No approval request was raised.')
  approvals.resolve(request.id, decision)
}

describe('authorize', () => {
  it('lets a SAFE operation through without a prompt', async () => {
    await expect(authorize({ tool: 'system.info', declared: 'SAFE', summary: 'read status' })).resolves
      .toBeUndefined()
    expect(approvals.list()).toEqual([])
  })

  it('refuses a BLOCKED operation without asking the user', async () => {
    await expect(
      authorize({ tool: 'evil.tool', declared: 'BLOCKED', summary: 'do harm' })
    ).rejects.toBeInstanceOf(PermissionRefused)
    expect(approvals.list()).toEqual([])
  })

  it('raises a request for a CONFIRM operation and proceeds when allowed', async () => {
    const pending = authorize({ tool: 'file.remove', declared: 'CONFIRM', summary: 'delete notes.txt' })
    await answer('once')
    await expect(pending).resolves.toBeUndefined()
  })

  it('throws when the user declines, so the caller cannot continue', async () => {
    const pending = authorize({ tool: 'file.remove', declared: 'CONFIRM', summary: 'delete notes.txt' })
    await answer('deny')
    await expect(pending).rejects.toThrow(/You declined/)
  })

  it('remembers "always allow" so the same tool stops asking', async () => {
    const first = authorize({ tool: 'file.write', declared: 'CONFIRM', summary: 'write a.txt' })
    await answer('always')
    await first
    expect(settings.get().automation.trustedTools).toContain('file.write')

    // The second call must not raise anything at all.
    await expect(authorize({ tool: 'file.write', declared: 'CONFIRM', summary: 'write b.txt' })).resolves
      .toBeUndefined()
    expect(approvals.list()).toEqual([])
  })

  it('keeps asking for PRIVILEGED work even after "always allow"', async () => {
    const first = authorize({ tool: 'system.control', declared: 'PRIVILEGED', summary: 'restart' })
    await answer('always')
    await first

    const second = authorize({ tool: 'system.control', declared: 'PRIVILEGED', summary: 'restart again' })
    await answer('deny')
    await expect(second).rejects.toThrow(/You declined/)
  })

  it('shows the user the tool, the reason and the exact input', async () => {
    const pending = authorize({
      tool: 'file.remove',
      declared: 'CONFIRM',
      summary: 'delete C:\\work\\old.txt',
      reason: 'This deletes a file.',
      input: { path: 'C:\\work\\old.txt', recursive: false }
    })
    for (let i = 0; i < 50 && approvals.list().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(approvals.list()[0]).toMatchObject({
      tool: 'file.remove',
      summary: 'delete C:\\work\\old.txt',
      reason: 'This deletes a file.',
      level: 'CONFIRM',
      input: { path: 'C:\\work\\old.txt', recursive: false }
    })
    await answer('deny')
    await expect(pending).rejects.toThrow()
  })

  it('denies everything still pending on shutdown', async () => {
    const pending = authorize({ tool: 'file.remove', declared: 'CONFIRM', summary: 'delete x' })
    for (let i = 0; i < 50 && approvals.list().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    approvals.denyAll()
    await expect(pending).rejects.toThrow(/You declined/)
    expect(approvals.list()).toEqual([])
  })

  it('reports an unknown approval id instead of pretending it resolved', () => {
    expect(approvals.resolve('not-a-request', 'once')).toBe(false)
  })
})

describe('invokeTool through the gate', () => {
  it('does not run a tool the user declined', async () => {
    const pending = invokeTool('file.write', { path: 'C:\\nope\\x.txt', content: 'hi' }, { source: 'test' })
    await answer('deny')
    await expect(pending).rejects.toThrow(/You declined/)
  })

  it('asks before running, not after', async () => {
    // The tool would fail on the path guard; the approval must come first, which
    // is what makes the prompt meaningful.
    const pending = invokeTool('file.remove', { path: 'C:\\Windows\\System32' }, { source: 'test' })
    await answer('deny')
    await expect(pending).rejects.toThrow(/You declined/)
  })
})
