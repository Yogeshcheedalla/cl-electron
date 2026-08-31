import { useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Field, Modal, Pill } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { useAkanshaEvent } from '../hooks/useEvents'
import { call } from '../services/api'
import { fromLocalInput, stamp, toLocalInput } from '../services/format'
import type { Task, TaskState } from '../../shared/records'

const TONE: Record<TaskState, string> = {
  PENDING: '',
  RUNNING: 'info',
  COMPLETED: 'ok',
  FAILED: 'bad',
  CANCELLED: 'warn'
}

const empty = (): Partial<Task> => ({ title: '', detail: '', repeat: 'none', state: 'PENDING' })

/**
 * Tasks are stored in SQLite and fired by the main-process scheduler, so this
 * screen only edits records -- it never simulates a run.
 */
export function TasksPage() {
  const tasks = useLoad(() => call(() => window.akansha.tasks.list()))
  const automations = useLoad(() => call(() => window.akansha.automations.list()))
  const { run, pending } = useAction()
  const [draft, setDraft] = useState<Partial<Task> | null>(null)

  // The scheduler pushes every state change, so the list stays true without polling.
  useAkanshaEvent('task', () => void tasks.reload())

  const save = async () => {
    if (!draft?.title?.trim()) return
    const body: Partial<Task> = {
      title: draft.title.trim(),
      detail: draft.detail ?? '',
      repeat: draft.repeat ?? 'none',
      ...(draft.dueMs ? { dueMs: draft.dueMs } : {}),
      ...(draft.automationId ? { automationId: draft.automationId } : {})
    }
    const done = await run(
      draft.id ? 'Update task' : 'Create task',
      () => (draft.id ? call(() => window.akansha.tasks.update(draft.id as string, body)) : call(() => window.akansha.tasks.create(body))),
      draft.id ? 'Task updated' : 'Task created'
    )
    if (done) {
      setDraft(null)
      await tasks.reload()
    }
  }

  const list = tasks.data ?? []
  const open = list.filter((t) => t.state === 'PENDING' || t.state === 'RUNNING')
  const closed = list.filter((t) => !open.includes(t))

  const row = (t: Task) => (
    <div key={t.id} className="list-item">
      <Pill tone={TONE[t.state]}>{t.state}</Pill>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="truncate">{t.title}</div>
        <div className="dim small truncate">
          {[t.detail, t.dueMs ? `due ${stamp(t.dueMs)}` : null, t.repeat !== 'none' ? `repeats ${t.repeat}` : null, t.lastResult]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <Btn
        size="sm"
        disabled={pending !== null || t.state === 'RUNNING'}
        onClick={() =>
          void run('Run task', async () => {
            await call(() => window.akansha.tasks.run(t.id))
            await tasks.reload()
          }, 'Task started')
        }
      >
        Run now
      </Btn>
      <Btn size="sm" variant="ghost" onClick={() => setDraft({ ...t })}>
        Edit
      </Btn>
      <Btn
        size="sm"
        variant="ghost"
        onClick={() =>
          void run('Delete task', async () => {
            await call(() => window.akansha.tasks.remove(t.id))
            await tasks.reload()
          }, 'Task deleted')
        }
      >
        ✕
      </Btn>
    </div>
  )

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Tasks</h1>
        <span className="grow" />
        <Btn variant="primary" onClick={() => setDraft(empty())}>
          New task
        </Btn>
      </div>

      <ErrorNote error={tasks.error} />

      <Card title={`Open (${open.length})`} flush>
        {open.length === 0 ? <Empty>Nothing scheduled.</Empty> : <div className="list">{open.map(row)}</div>}
      </Card>

      {closed.length > 0 && (
        <Card title={`Finished (${closed.length})`} flush>
          <div className="list scroll-320">{closed.map(row)}</div>
        </Card>
      )}

      {draft && (
        <Modal
          title={draft.id ? 'Edit task' : 'New task'}
          onClose={() => setDraft(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Btn>
              <Btn variant="primary" disabled={!draft.title?.trim() || pending !== null} onClick={() => void save()}>
                Save
              </Btn>
            </>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <Field label="Title">
              <input value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label="Detail" hint="What Akansha should do, or a note for yourself.">
              <textarea rows={3} value={draft.detail ?? ''} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} />
            </Field>
            <div className="grid cols-2">
              <Field label="Due">
                <input
                  type="datetime-local"
                  value={toLocalInput(draft.dueMs)}
                  onChange={(e) => setDraft({ ...draft, dueMs: fromLocalInput(e.target.value) })}
                />
              </Field>
              <Field label="Repeat">
                <select
                  value={draft.repeat ?? 'none'}
                  onChange={(e) => setDraft({ ...draft, repeat: e.target.value as Task['repeat'] })}
                >
                  <option value="none">Once</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </Field>
            </div>
            <Field label="Run an automation when it fires" hint="Leave empty to just be reminded.">
              <select
                value={draft.automationId ?? ''}
                onChange={(e) => setDraft({ ...draft, automationId: e.target.value || undefined })}
              >
                <option value="">No automation</option>
                {(automations.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}
