import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initDatabase } from '../electron/db/db'
import { notifications } from '../electron/db/log.repo'
import { automations, tasks } from '../electron/db/state.repo'
import { initLogger } from '../electron/core/logger'
import { initSettings } from '../electron/services/settings'
import { runTask } from '../electron/services/scheduler'

/**
 * The scheduler is exercised through `runTask`, the same entry point the timer
 * and the Tasks page use. No Electron window exists here, so the UI push is a
 * no-op and the observable effects are the stored task and the notification.
 */
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'akansha-sched-'))
  initLogger(dir)
  initSettings(dir)
  initDatabase(dir)
})

describe('runTask', () => {
  it('refuses a task id that does not exist', async () => {
    await expect(runTask('missing')).rejects.toThrow(/No task with id/)
  })

  it('delivers a reminder and completes the task', async () => {
    notifications.clear()
    const task = tasks.create({ title: 'Stand up', detail: 'Stretch your legs', dueMs: Date.now() - 1000 })
    const out = await runTask(task.id)
    expect(out.state).toBe('COMPLETED')

    const stored = tasks.get(task.id)
    expect(stored?.state).toBe('COMPLETED')
    expect(stored?.lastResult).toBe('Reminder delivered.')

    const notification = notifications.list().find((n) => n.title === 'Stand up')
    expect(notification?.body).toBe('Stretch your legs')
    expect(notification?.category).toBe('TASK')
  })

  it('says something even when the task has no detail', async () => {
    notifications.clear()
    const task = tasks.create({ title: 'Bare reminder' })
    await runTask(task.id)
    expect(notifications.list()[0]?.body).toBe('Task is due now.')
  })

  it('rolls a repeating task forward instead of completing it', async () => {
    const dueMs = Date.now() - 5 * 3_600_000 // five hours late
    const task = tasks.create({ title: 'Hourly check', repeat: 'hourly', dueMs })
    const out = await runTask(task.id)

    expect(out.state).toBe('PENDING')
    const stored = tasks.get(task.id)
    expect(stored?.state).toBe('PENDING')
    // Missed windows are skipped: the next run is in the future, once.
    expect(stored?.dueMs).toBeGreaterThan(Date.now())
    expect(stored?.dueMs).toBeLessThanOrEqual(Date.now() + 3_600_000)
  })

  it('schedules a daily task a day ahead', async () => {
    const task = tasks.create({ title: 'Daily digest', repeat: 'daily', dueMs: Date.now() - 1000 })
    await runTask(task.id)
    const stored = tasks.get(task.id)
    expect(stored?.dueMs).toBeGreaterThan(Date.now() + 86_000_000)
  })

  it('marks a task failed when its automation fails, and keeps the reason', async () => {
    const automation = automations.save({
      id: '',
      name: 'Broken',
      description: 'Points at a tool that does not exist',
      trigger: { type: 'manual' },
      steps: [{ tool: 'no.suchTool', input: {} }],
      enabled: true
    })
    const task = tasks.create({ title: 'Run broken automation', automationId: automation.id })
    const out = await runTask(task.id)

    expect(out.state).toBe('FAILED')
    const stored = tasks.get(task.id)
    expect(stored?.state).toBe('FAILED')
    expect(stored?.lastResult).toMatch(/no\.suchTool|Unknown tool/i)
  })

  it('does not run a disabled automation silently', async () => {
    const automation = automations.save({
      id: '',
      name: 'Disabled',
      description: '',
      trigger: { type: 'manual' },
      steps: [{ tool: 'system.info', input: {} }],
      enabled: false
    })
    const task = tasks.create({ title: 'Disabled automation', automationId: automation.id })
    const out = await runTask(task.id)
    expect(out.state).toBe('FAILED')
    expect(tasks.get(task.id)?.lastResult).toMatch(/disabled/i)
  })
})
