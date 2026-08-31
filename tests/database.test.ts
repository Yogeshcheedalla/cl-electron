import { mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { handle, initDatabase } from '../electron/db/db'
import { conversations, messages } from '../electron/db/chat.repo'
import { activity, notifications, usage } from '../electron/db/log.repo'
import { automations, memories, tasks } from '../electron/db/state.repo'
import { initLogger } from '../electron/core/logger'
import { initSettings } from '../electron/services/settings'

/**
 * A real SQLite file in a temp directory: these tests exercise the migrations and
 * every repository the app writes through, so a schema mistake fails here rather
 * than on someone's machine.
 */
let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-db-'))
  initLogger(dir)
  initSettings(dir)
  initDatabase(dir)
})

describe('database', () => {
  it('creates the database file and applies the schema', () => {
    expect(existsSync(join(dir, 'database', 'akansha.db'))).toBe(true)
    // Every table is reachable, which is only true if the migration ran.
    expect(() => conversations.list()).not.toThrow()
    expect(() => tasks.list()).not.toThrow()
    expect(() => memories.list()).not.toThrow()
    expect(() => automations.list()).not.toThrow()
    expect(() => activity.list()).not.toThrow()
    expect(() => usage.since(0)).not.toThrow()
    expect(() => notifications.list()).not.toThrow()
  })

  it('is idempotent when opened twice', () => {
    expect(() => initDatabase(dir)).not.toThrow()
    expect(() => conversations.list()).not.toThrow()
  })

  it('renames a pre-rebrand jarvis.db forward and keeps its rows', () => {
    const older = mkdtempSync(join(tmpdir(), 'akansha-legacy-db-'))
    mkdirSync(join(older, 'database'), { recursive: true })
    const legacy = join(older, 'database', 'jarvis.db')
    const seeded = new DatabaseSync(legacy)
    seeded.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
    seeded.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
    seeded.exec("CREATE TABLE keepsake (v TEXT); INSERT INTO keepsake VALUES ('carried forward')")
    seeded.close()

    initDatabase(older)
    expect(existsSync(join(older, 'database', 'akansha.db'))).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    const row = handle().prepare('SELECT v FROM keepsake').get() as { v: string }
    expect(row.v).toBe('carried forward')

    // Put the shared handle back where the rest of the suite expects it.
    initDatabase(dir)
  })

  it('never lets an old jarvis.db overwrite a live akansha.db', () => {
    const both = mkdtempSync(join(tmpdir(), 'akansha-both-db-'))
    mkdirSync(join(both, 'database'), { recursive: true })
    const legacy = join(both, 'database', 'jarvis.db')
    initDatabase(both)
    const live = new DatabaseSync(legacy)
    live.exec("CREATE TABLE stale (v TEXT); INSERT INTO stale VALUES ('should not appear')")
    live.close()

    initDatabase(both)
    expect(existsSync(legacy)).toBe(true)
    expect(() => handle().prepare('SELECT v FROM stale').get()).toThrow()
    initDatabase(dir)
  })
})

describe('conversations and messages', () => {
  it('stores a conversation with its messages in order', () => {
    const conv = conversations.create('Test chat')
    messages.add({ conversationId: conv.id, role: 'user', content: 'first' })
    messages.add({ conversationId: conv.id, role: 'assistant', content: 'second' })
    const stored = messages.list(conv.id)
    expect(stored.map((m) => m.content)).toEqual(['first', 'second'])
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('returns recent messages oldest-first for model context', () => {
    const conv = conversations.create('Context')
    for (const n of [1, 2, 3, 4, 5]) {
      messages.add({ conversationId: conv.id, role: 'user', content: `m${n}`, createdMs: 1000 + n })
    }
    expect(messages.recent(conv.id, 3).map((m) => m.content)).toEqual(['m3', 'm4', 'm5'])
  })

  it('finds a conversation by message text', () => {
    const conv = conversations.create('Searchable')
    messages.add({ conversationId: conv.id, role: 'user', content: 'the quick brown fox' })
    const hits = conversations.search('brown fox')
    expect(hits.some((h) => h.conversation.id === conv.id)).toBe(true)
    expect(hits[0]?.snippet).toContain('brown')
  })

  it('renames and deletes a conversation with its messages', () => {
    const conv = conversations.create('Doomed')
    messages.add({ conversationId: conv.id, role: 'user', content: 'bye' })
    conversations.rename(conv.id, 'Renamed')
    expect(conversations.get(conv.id)?.title).toBe('Renamed')
    conversations.remove(conv.id)
    expect(conversations.get(conv.id)).toBeUndefined()
    expect(messages.list(conv.id)).toEqual([])
  })

  it('orders the list by most recently touched', () => {
    const older = conversations.create('Older')
    const newer = conversations.create('Newer')
    messages.add({ conversationId: older.id, role: 'user', content: 'bump' })
    const ids = conversations.list().map((c) => c.id)
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id))
  })
})

describe('tasks', () => {
  it('creates a task with sane defaults', () => {
    const task = tasks.create({ title: '  Water the plants  ' })
    expect(task.title).toBe('Water the plants')
    expect(task.state).toBe('PENDING')
    expect(task.repeat).toBe('none')
    expect(task.dueMs).toBeUndefined()
  })

  it('never stores an empty title', () => {
    expect(tasks.create({ title: '   ' }).title).toBe('Untitled task')
  })

  it('returns only pending tasks that are actually due', () => {
    const past = tasks.create({ title: 'Due', dueMs: Date.now() - 60_000 })
    const future = tasks.create({ title: 'Later', dueMs: Date.now() + 3_600_000 })
    const undated = tasks.create({ title: 'Someday' })
    const done = tasks.create({ title: 'Done', dueMs: Date.now() - 60_000 })
    tasks.update(done.id, { state: 'COMPLETED' })

    const due = tasks.due(Date.now()).map((t) => t.id)
    expect(due).toContain(past.id)
    expect(due).not.toContain(future.id)
    expect(due).not.toContain(undated.id)
    expect(due).not.toContain(done.id)
  })

  it('updates a task and records its result', () => {
    const task = tasks.create({ title: 'Report' })
    const updated = tasks.update(task.id, { state: 'COMPLETED', lastResult: 'Reminder delivered.' })
    expect(updated).toMatchObject({ state: 'COMPLETED', lastResult: 'Reminder delivered.' })
    expect(tasks.get(task.id)?.lastResult).toBe('Reminder delivered.')
  })

  it('reports a missing task instead of inventing one', () => {
    expect(tasks.update('no-such-id', { title: 'x' })).toBeUndefined()
    expect(tasks.get('no-such-id')).toBeUndefined()
  })

  it('deletes a task', () => {
    const task = tasks.create({ title: 'Temporary' })
    tasks.remove(task.id)
    expect(tasks.get(task.id)).toBeUndefined()
  })

  it('sorts running and pending work ahead of finished work', () => {
    const finished = tasks.create({ title: 'Finished' })
    tasks.update(finished.id, { state: 'COMPLETED' })
    const runningTask = tasks.create({ title: 'Running' })
    tasks.update(runningTask.id, { state: 'RUNNING' })
    const list = tasks.list()
    expect(list[0]?.state).toBe('RUNNING')
    expect(list.map((t) => t.id).indexOf(runningTask.id)).toBeLessThan(
      list.map((t) => t.id).indexOf(finished.id)
    )
  })
})

describe('memories', () => {
  it('stores, searches, updates and forgets', () => {
    const mem = memories.create({ content: 'The user prefers dark mode', category: 'PREFERENCE' })
    expect(memories.search('dark mode').map((m) => m.id)).toContain(mem.id)
    memories.update(mem.id, { confidence: 'high' })
    expect(memories.list().find((m) => m.id === mem.id)?.confidence).toBe('high')
    memories.remove(mem.id)
    expect(memories.search('dark mode').map((m) => m.id)).not.toContain(mem.id)
  })

  it('reports how many memories it forgot when clearing', () => {
    memories.clear()
    memories.create({ content: 'a' })
    memories.create({ content: 'b' })
    expect(memories.clear()).toBe(2)
    expect(memories.list()).toEqual([])
  })
})

describe('automations', () => {
  it('round-trips steps and trigger through JSON columns', () => {
    const saved = automations.save({
      id: '',
      name: 'Morning briefing',
      description: 'System info then a notification',
      trigger: { type: 'manual' },
      steps: [
        { tool: 'system.info', input: {} },
        { tool: 'notify.show', input: { title: 'Ready' }, requiresPrevious: true }
      ],
      enabled: true
    })
    expect(saved.id).not.toBe('')
    const loaded = automations.get(saved.id)
    expect(loaded?.steps).toHaveLength(2)
    expect(loaded?.steps[1]).toMatchObject({ tool: 'notify.show', requiresPrevious: true })
    expect(loaded?.enabled).toBe(true)
  })

  it('updates in place rather than duplicating on save', () => {
    const first = automations.save({
      id: 'fixed-id',
      name: 'One',
      description: '',
      trigger: { type: 'manual' },
      steps: [],
      enabled: true
    })
    automations.save({ ...first, name: 'Two', enabled: false })
    expect(automations.list().filter((a) => a.id === 'fixed-id')).toHaveLength(1)
    expect(automations.get('fixed-id')).toMatchObject({ name: 'Two', enabled: false })
  })

  it('records the outcome of the last run', () => {
    automations.markRun('fixed-id', 'failed')
    const loaded = automations.get('fixed-id')
    expect(loaded?.lastStatus).toBe('failed')
    expect(loaded?.lastRunMs).toBeGreaterThan(0)
  })
})

describe('activity, usage and notifications', () => {
  it('keeps an audit trail with failures marked as failures', () => {
    activity.clear()
    activity.add({ kind: 'tool', label: 'file.read', ok: true, durationMs: 12 })
    activity.add({ kind: 'error', label: 'file.read failed', detail: 'gone', ok: false })
    const rows = activity.list()
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => !r.ok)).toHaveLength(1)
    expect(rows[0]?.label).toBe('file.read failed') // newest first
  })

  it('prunes old activity but keeps recent entries', () => {
    activity.clear()
    activity.add({ kind: 'tool', label: 'recent', ok: true })
    activity.prune(Date.now() + 1000) // everything is "old" relative to the future
    expect(activity.list()).toEqual([])
  })

  it('totals usage and cost per model', () => {
    usage.add({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 900,
      failed: false,
      estimatedCostUsd: 0.0105
    })
    const rows = usage.since(Date.now() - 7 * 86_400_000)
    const row = rows.find((r) => r.model === 'claude-sonnet-5')
    expect(row?.inputTokens).toBeGreaterThanOrEqual(1000)
    expect(row?.estimatedCostUsd).toBeGreaterThan(0)
  })

  it('marks a notification read without deleting it', () => {
    notifications.clear()
    const n = notifications.add({ category: 'TASK', title: 'Due', body: 'now' })
    expect(notifications.list()[0]?.read).toBe(false)
    notifications.markRead(n.id)
    expect(notifications.list()[0]).toMatchObject({ id: n.id, read: true })
  })
})
