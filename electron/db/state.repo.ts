import { all, bool, flag, get, run } from './db'
import { id, now } from '../core/util'
import { decryptText, encryptText, isEncrypted } from '../core/crypto'
import type { Automation, Memory, Task } from '../../shared/records'

type TaskRow = {
  id: string
  title: string
  detail: string
  state: string
  due_ms: number | null
  repeat: string
  automation_id: string | null
  created_ms: number
  updated_ms: number
  last_result: string | null
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  detail: r.detail,
  state: r.state as Task['state'],
  repeat: r.repeat as Task['repeat'],
  createdMs: r.created_ms,
  updatedMs: r.updated_ms,
  ...(r.due_ms ? { dueMs: r.due_ms } : {}),
  ...(r.automation_id ? { automationId: r.automation_id } : {}),
  ...(r.last_result ? { lastResult: r.last_result } : {})
})

export const tasks = {
  list(): Task[] {
    return all<TaskRow>(
      "SELECT * FROM tasks ORDER BY CASE state WHEN 'RUNNING' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END, COALESCE(due_ms, updated_ms) ASC"
    ).map(toTask)
  },

  get(tid: string): Task | undefined {
    const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', tid)
    return row ? toTask(row) : undefined
  },

  /** Pending tasks whose due time has passed. */
  due(atMs: number): Task[] {
    return all<TaskRow>(
      "SELECT * FROM tasks WHERE state = 'PENDING' AND due_ms IS NOT NULL AND due_ms <= ?",
      atMs
    ).map(toTask)
  },

  create(input: Partial<Task>): Task {
    const ts = now()
    const task: Task = {
      id: id(),
      title: input.title?.trim() || 'Untitled task',
      detail: input.detail ?? '',
      state: input.state ?? 'PENDING',
      repeat: input.repeat ?? 'none',
      createdMs: ts,
      updatedMs: ts,
      ...(input.dueMs ? { dueMs: input.dueMs } : {}),
      ...(input.automationId ? { automationId: input.automationId } : {})
    }
    run(
      'INSERT INTO tasks (id,title,detail,state,due_ms,repeat,automation_id,created_ms,updated_ms,last_result) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
      task.id,
      task.title,
      task.detail,
      task.state,
      task.dueMs ?? null,
      task.repeat,
      task.automationId ?? null,
      ts,
      ts
    )
    return task
  },

  update(tid: string, patch: Partial<Task>): Task | undefined {
    const current = tasks.get(tid)
    if (!current) return undefined
    const next = { ...current, ...patch, updatedMs: now() }
    run(
      'UPDATE tasks SET title=?, detail=?, state=?, due_ms=?, repeat=?, automation_id=?, updated_ms=?, last_result=? WHERE id=?',
      next.title,
      next.detail,
      next.state,
      next.dueMs ?? null,
      next.repeat,
      next.automationId ?? null,
      next.updatedMs,
      next.lastResult ?? null,
      tid
    )
    return next
  },

  remove(tid: string) {
    run('DELETE FROM tasks WHERE id = ?', tid)
  }
}

type MemRow = {
  id: string
  category: string
  content: string
  source: string
  confidence: string
  created_ms: number
}

const toMemory = (r: MemRow): Memory => ({
  id: r.id,
  category: r.category as Memory['category'],
  content: decryptText(r.content),
  source: r.source,
  confidence: r.confidence as Memory['confidence'],
  createdMs: r.created_ms
})

export const memories = {
  list(): Memory[] {
    return all<MemRow>('SELECT * FROM memories ORDER BY created_ms DESC').map(toMemory)
  },

  /**
   * Decrypt-and-filter in JS. `content LIKE ?` cannot work once the column holds
   * ciphertext, and a searchable hash of each word would leak exactly the thing
   * the encryption is there to hide. Memories are a few hundred short rows, so
   * scanning them costs less than a millisecond.
   */
  search(query: string, limit = 20): Memory[] {
    const needle = String(query ?? '').trim().toLowerCase()
    if (!needle) return []
    const out: Memory[] = []
    for (const row of all<MemRow>('SELECT * FROM memories ORDER BY created_ms DESC')) {
      const mem = toMemory(row)
      if (mem.content.toLowerCase().includes(needle)) out.push(mem)
      if (out.length >= limit) break
    }
    return out
  },

  create(input: Partial<Memory>): Memory {
    const mem: Memory = {
      id: id(),
      category: input.category ?? 'FACT',
      content: (input.content ?? '').trim(),
      source: input.source ?? 'user',
      confidence: input.confidence ?? 'medium',
      createdMs: now()
    }
    run(
      'INSERT INTO memories (id,category,content,source,confidence,created_ms) VALUES (?,?,?,?,?,?)',
      mem.id,
      mem.category,
      encryptText(mem.content),
      mem.source,
      mem.confidence,
      mem.createdMs
    )
    return mem
  },

  update(mid: string, patch: Partial<Memory>): Memory | undefined {
    const row = get<MemRow>('SELECT * FROM memories WHERE id = ?', mid)
    if (!row) return undefined
    const next = { ...toMemory(row), ...patch }
    run(
      'UPDATE memories SET category=?, content=?, source=?, confidence=? WHERE id=?',
      next.category,
      encryptText(next.content),
      next.source,
      next.confidence,
      mid
    )
    return next
  },

  remove(mid: string) {
    run('DELETE FROM memories WHERE id = ?', mid)
  },

  clear(): number {
    const n = (get<{ c: number }>('SELECT COUNT(*) AS c FROM memories')?.c ?? 0) as number
    run('DELETE FROM memories')
    return n
  },

  /**
   * Seals rows written before encryption was available. Runs once at startup;
   * returns how many rows it converted so the log can say so honestly.
   */
  sealPlaintext(): number {
    let sealed = 0
    for (const row of all<MemRow>('SELECT id, content FROM memories')) {
      if (isEncrypted(row.content)) continue
      const ciphertext = encryptText(row.content)
      if (!isEncrypted(ciphertext)) break // no key: leave the rows alone rather than churn them
      run('UPDATE memories SET content = ? WHERE id = ?', ciphertext, row.id)
      sealed++
    }
    return sealed
  }
}

type AutoRow = {
  id: string
  name: string
  description: string
  trigger_json: string
  steps_json: string
  enabled: number
  last_run_ms: number | null
  last_status: string | null
}

const toAutomation = (r: AutoRow): Automation => ({
  id: r.id,
  name: r.name,
  description: r.description,
  trigger: JSON.parse(r.trigger_json),
  steps: JSON.parse(r.steps_json),
  enabled: bool(r.enabled),
  ...(r.last_run_ms ? { lastRunMs: r.last_run_ms } : {}),
  ...(r.last_status ? { lastStatus: r.last_status as Automation['lastStatus'] } : {})
})

export const automations = {
  list(): Automation[] {
    return all<AutoRow>('SELECT * FROM automations ORDER BY name ASC').map(toAutomation)
  },

  get(aid: string): Automation | undefined {
    const row = get<AutoRow>('SELECT * FROM automations WHERE id = ?', aid)
    return row ? toAutomation(row) : undefined
  },

  save(a: Automation): Automation {
    const next = { ...a, id: a.id || id() }
    run(
      `INSERT INTO automations (id,name,description,trigger_json,steps_json,enabled,last_run_ms,last_status)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         trigger_json=excluded.trigger_json, steps_json=excluded.steps_json, enabled=excluded.enabled`,
      next.id,
      next.name,
      next.description,
      JSON.stringify(next.trigger),
      JSON.stringify(next.steps),
      flag(next.enabled),
      next.lastRunMs ?? null,
      next.lastStatus ?? null
    )
    return next
  },

  markRun(aid: string, status: 'ok' | 'failed') {
    run('UPDATE automations SET last_run_ms = ?, last_status = ? WHERE id = ?', now(), status, aid)
  },

  remove(aid: string) {
    run('DELETE FROM automations WHERE id = ?', aid)
  }
}
