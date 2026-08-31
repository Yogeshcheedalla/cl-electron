import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { now, truncate } from '../core/util'
import { tasks } from '../db/state.repo'
import { audit } from '../core/audit'
import { automationEngine } from './automation'
import { notify } from './notify'
import type { Task } from '../../shared/records'

const TICK_MS = 30_000
const PERIODS = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 } as const

let timer: NodeJS.Timeout | null = null
let running = false

/** Repeating tasks roll forward past any missed windows instead of firing in a burst. */
function nextDue(task: Task): number | undefined {
  if (task.repeat === 'none') return undefined
  const period = PERIODS[task.repeat]
  let next = (task.dueMs ?? now()) + period
  while (next <= now()) next += period
  return next
}

export async function runTask(id: string): Promise<{ state: string }> {
  const task = tasks.get(id)
  if (!task) throw new Error(`No task with id ${id}.`)

  tasks.update(task.id, { state: 'RUNNING' })
  bus.emitToUi({ type: 'task', task: { ...task, state: 'RUNNING' } })

  let ok = true
  let result: string
  if (task.automationId) {
    try {
      const res = await automationEngine.run(task.automationId)
      ok = res.ok
      result = truncate(res.log.join('\n'), 800)
    } catch (e) {
      ok = false
      result = e instanceof Error ? e.message : String(e)
    }
  } else {
    // A reminder-only task: its job is to surface at the right moment.
    result = 'Reminder delivered.'
    notify({ category: 'TASK', title: task.title, body: task.detail || 'Task is due now.' })
  }

  const repeatAt = nextDue(task)
  const next = tasks.update(task.id, {
    state: repeatAt ? 'PENDING' : ok ? 'COMPLETED' : 'FAILED',
    lastResult: result,
    ...(repeatAt ? { dueMs: repeatAt } : {})
  })
  audit({
    kind: 'agent',
    label: `Task "${task.title}"`,
    detail: truncate(result, 400),
    ok
  })
  if (next) bus.emitToUi({ type: 'task', task: next })
  return { state: next?.state ?? 'COMPLETED' }
}

async function tick() {
  if (running) return
  running = true
  try {
    for (const task of tasks.due(now())) {
      logger.info('scheduler.fire', { id: task.id, title: task.title })
      await runTask(task.id)
    }
  } catch (e) {
    logger.warn('scheduler.tickFailed', { message: String(e) })
  } finally {
    running = false
  }
}

export function startScheduler() {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref?.()
  void tick()
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}
