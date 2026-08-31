import { useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Field, Modal, Pill, Toggle } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import { useApp } from '../stores/app'
import type { Memory, MemoryCategory } from '../../shared/records'

const CATEGORIES: MemoryCategory[] = ['PREFERENCE', 'PROJECT', 'GOAL', 'FACT', 'WORKFLOW', 'COMMAND']
const CONFIDENCE: Memory['confidence'][] = ['low', 'medium', 'high']

/** What Akansha remembers, and the only place it can be edited or forgotten. */
export function MemoryPage() {
  const { settings, saveSettings } = useApp()
  const [query, setQuery] = useState('')
  const memories = useLoad(
    () => (query.trim() ? call(() => window.akansha.memory.search(query.trim())) : call(() => window.akansha.memory.list())),
    [query]
  )
  const { run, pending } = useAction()
  const [draft, setDraft] = useState<Partial<Memory> | null>(null)

  const save = async () => {
    if (!draft?.content?.trim()) return
    const body: Partial<Memory> = {
      content: draft.content.trim(),
      category: draft.category ?? 'FACT',
      confidence: draft.confidence ?? 'medium',
      source: draft.source ?? 'you'
    }
    const done = await run(
      draft.id ? 'Update memory' : 'Save memory',
      () =>
        draft.id
          ? call(() => window.akansha.memory.update(draft.id as string, body))
          : call(() => window.akansha.memory.create(body)),
      draft.id ? 'Memory updated' : 'Memory saved'
    )
    if (done) {
      setDraft(null)
      await memories.reload()
    }
  }

  const list = memories.data ?? []
  const enabled = settings?.memory.enabled ?? true

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Memory</h1>
        <span className="grow" />
        <Btn variant="primary" onClick={() => setDraft({ category: 'FACT', confidence: 'medium', source: 'you' })}>
          Add memory
        </Btn>
        <Btn
          variant="danger"
          disabled={!list.length || pending !== null}
          onClick={() =>
            void run('Forget everything', async () => {
              const { removed } = await call(() => window.akansha.memory.clear())
              await memories.reload()
              return removed
            }, 'Memories cleared')
          }
        >
          Forget all
        </Btn>
      </div>

      <Card>
        <div className="col" style={{ gap: 10 }}>
          <Toggle
            label="Let Akansha remember things between conversations"
            hint="When this is off, nothing new is stored and existing memories are not used."
            checked={enabled}
            onChange={(value) => void saveSettings({ memory: { enabled: value } })}
          />
          <input
            type="search"
            placeholder="Search memories"
            value={query}
            aria-label="Search memories"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </Card>

      <ErrorNote error={memories.error} />

      <Card title={`${list.length} ${query.trim() ? 'matches' : 'stored'}`} flush>
        {list.length === 0 ? (
          <Empty>{memories.loading ? 'Loading…' : query.trim() ? 'Nothing matches that.' : 'Akansha has not stored anything yet.'}</Empty>
        ) : (
          <div className="list scroll-320">
            {list.map((m) => (
              <div key={m.id} className="list-item">
                <Pill tone={m.confidence === 'high' ? 'ok' : m.confidence === 'low' ? 'warn' : ''}>{m.category}</Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>{m.content}</div>
                  <div className="dim small">
                    {m.source} · {m.confidence} confidence · {stamp(m.createdMs)}
                  </div>
                </div>
                <Btn size="sm" variant="ghost" onClick={() => setDraft({ ...m })}>
                  Edit
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run('Forget memory', async () => {
                      await call(() => window.akansha.memory.remove(m.id))
                      await memories.reload()
                    }, 'Forgotten')
                  }
                >
                  ✕
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>

      {draft && (
        <Modal
          title={draft.id ? 'Edit memory' : 'Add memory'}
          onClose={() => setDraft(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Btn>
              <Btn variant="primary" disabled={!draft.content?.trim() || pending !== null} onClick={() => void save()}>
                Save
              </Btn>
            </>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <Field label="What should Akansha remember?">
              <textarea rows={3} value={draft.content ?? ''} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
            </Field>
            <div className="grid cols-2">
              <Field label="Category">
                <select
                  value={draft.category ?? 'FACT'}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as MemoryCategory })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Confidence">
                <select
                  value={draft.confidence ?? 'medium'}
                  onChange={(e) => setDraft({ ...draft, confidence: e.target.value as Memory['confidence'] })}
                >
                  {CONFIDENCE.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
