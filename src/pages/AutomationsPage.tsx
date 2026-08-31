import { useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Field, Modal, Pill, Toggle } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import type { Automation, AutomationStep, DryRun, DryRunStep } from '../../shared/records'

const VERDICT_TONE: Record<DryRunStep['verdict'], string> = {
  run: 'ok',
  ask: 'warn',
  deny: 'bad',
  invalid: 'bad',
  'unknown-tool': 'bad',
  skipped: ''
}

const blank = (): Automation => ({
  id: '',
  name: '',
  description: '',
  trigger: { type: 'manual' },
  steps: [{ tool: '', input: {} }],
  enabled: true
})

/**
 * An automation is a list of real tool calls. Steps are validated by the tool
 * registry when they run, and a step whose level needs approval still asks.
 * "Dry run" answers what a run would do -- resolved, validated and gated --
 * without calling a single tool.
 */
export function AutomationsPage() {
  const automations = useLoad(() => call(() => window.akansha.automations.list()))
  const tools = useLoad(() => call(() => window.akansha.tools.list()))
  const { run, pending } = useAction()
  const [draft, setDraft] = useState<Automation | null>(null)
  const [log, setLog] = useState<{ name: string; ok: boolean; lines: string[] } | null>(null)
  const [plan, setPlan] = useState<DryRun | null>(null)
  const [inputText, setInputText] = useState<Record<number, string>>({})

  const usable = (tools.data ?? []).filter((t) => t.effectiveLevel !== 'BLOCKED')

  const setStep = (index: number, patch: Partial<AutomationStep>) => {
    if (!draft) return
    setDraft({ ...draft, steps: draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  }

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    // Parse each step's JSON here so a typo is reported before it is stored.
    const steps: AutomationStep[] = []
    for (let i = 0; i < draft.steps.length; i += 1) {
      const step = draft.steps[i] as AutomationStep
      if (!step.tool) continue
      const raw = inputText[i]
      let input = step.input
      if (raw !== undefined) {
        try {
          input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {
          await run(`Step ${i + 1} input`, async () => {
            throw new Error('That step\'s input is not valid JSON.')
          })
          return
        }
      }
      steps.push({ tool: step.tool, input, ...(step.requiresPrevious === false ? { requiresPrevious: false } : {}) })
    }
    if (!steps.length) {
      await run('Save automation', async () => {
        throw new Error('An automation needs at least one step with a tool.')
      })
      return
    }
    const done = await run(
      'Save automation',
      () => call(() => window.akansha.automations.save({ ...draft, steps })),
      'Automation saved'
    )
    if (done) {
      setDraft(null)
      setInputText({})
      await automations.reload()
    }
  }

  const edit = (a: Automation) => {
    setDraft({ ...a, steps: a.steps.length ? a.steps : [{ tool: '', input: {} }] })
    setInputText(Object.fromEntries(a.steps.map((s, i) => [i, JSON.stringify(s.input ?? {}, null, 2)])))
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Automations</h1>
        <span className="grow" />
        <Btn
          variant="primary"
          onClick={() => {
            setDraft(blank())
            setInputText({ 0: '{}' })
          }}
        >
          New automation
        </Btn>
      </div>

      <ErrorNote error={automations.error} />

      <Card flush>
        {!automations.data?.length ? (
          <Empty>{automations.loading ? 'Loading…' : 'No automations yet. Create one to chain real tool calls.'}</Empty>
        ) : (
          <div className="list">
            {automations.data.map((a) => (
              <div key={a.id} className="list-item">
                <Pill tone={a.lastStatus === 'failed' ? 'bad' : a.lastStatus === 'ok' ? 'ok' : ''}>
                  {a.trigger.type}
                </Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate">{a.name}</div>
                  <div className="dim small truncate">
                    {[
                      `${a.steps.length} step${a.steps.length === 1 ? '' : 's'}`,
                      a.description,
                      a.trigger.value,
                      a.lastRunMs ? `last run ${stamp(a.lastRunMs)}` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <Toggle
                  label=""
                  checked={a.enabled}
                  onChange={(enabled) =>
                    void run('Update automation', async () => {
                      await call(() => window.akansha.automations.save({ ...a, enabled }))
                      await automations.reload()
                    })
                  }
                />
                <Btn
                  size="sm"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`Dry run ${a.name}`, async () => {
                      setPlan(await call(() => window.akansha.automations.dryRun(a.id)))
                    })
                  }
                >
                  Dry run
                </Btn>
                <Btn
                  size="sm"
                  variant="primary"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`Run ${a.name}`, async () => {
                      const result = await call(() => window.akansha.automations.run(a.id))
                      setLog({ name: a.name, ok: result.ok, lines: result.log })
                      await automations.reload()
                    })
                  }
                >
                  Run
                </Btn>
                <Btn size="sm" variant="ghost" onClick={() => edit(a)}>
                  Edit
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run('Delete automation', async () => {
                      await call(() => window.akansha.automations.remove(a.id))
                      await automations.reload()
                    }, 'Automation deleted')
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
          wide
          title={draft.id ? `Edit ${draft.name || 'automation'}` : 'New automation'}
          onClose={() => (setDraft(null), setInputText({}))}
          footer={
            <>
              <Btn variant="ghost" onClick={() => (setDraft(null), setInputText({}))}>
                Cancel
              </Btn>
              <Btn variant="primary" disabled={!draft.name.trim() || pending !== null} onClick={() => void save()}>
                Save
              </Btn>
            </>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <div className="grid cols-2">
              <Field label="Name">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Trigger">
                <select
                  value={draft.trigger.type}
                  onChange={(e) =>
                    setDraft({ ...draft, trigger: { ...draft.trigger, type: e.target.value as Automation['trigger']['type'] } })
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="schedule">Schedule (attach a task)</option>
                  <option value="event">Event</option>
                </select>
              </Field>
            </div>
            <Field label="Description">
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>

            <div className="card-title">Steps</div>
            {draft.steps.map((step, i) => (
              <div key={i} className="card" style={{ gap: 8 }}>
                <div className="row wrap" style={{ gap: 8 }}>
                  <select
                    className="grow"
                    value={step.tool}
                    aria-label={`Step ${i + 1} tool`}
                    onChange={(e) => setStep(i, { tool: e.target.value })}
                  >
                    <option value="">Choose a tool…</option>
                    {usable.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name} · {t.effectiveLevel}
                      </option>
                    ))}
                  </select>
                  <Btn
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })
                      setInputText(Object.fromEntries(Object.entries(inputText).filter(([k]) => Number(k) !== i)))
                    }}
                  >
                    Remove
                  </Btn>
                </div>
                <div className="dim small">
                  {usable.find((t) => t.name === step.tool)?.description ?? 'Pick a tool to see what it does.'}
                </div>
                <textarea
                  className="mono"
                  rows={3}
                  aria-label={`Step ${i + 1} input`}
                  placeholder='{ "path": "C:\\\\Users\\\\me\\\\notes.txt" }'
                  value={inputText[i] ?? JSON.stringify(step.input ?? {}, null, 2)}
                  onChange={(e) => setInputText({ ...inputText, [i]: e.target.value })}
                />
                <Toggle
                  label="Only run when the previous step succeeded"
                  checked={step.requiresPrevious !== false}
                  onChange={(value) => setStep(i, { requiresPrevious: value })}
                />
              </div>
            ))}
            <Btn size="sm" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { tool: '', input: {} }] })}>
              Add step
            </Btn>
          </div>
        </Modal>
      )}

      {plan && (
        <Modal
          wide
          title={`${plan.automation} — dry run`}
          onClose={() => setPlan(null)}
          footer={
            <Btn variant="ghost" onClick={() => setPlan(null)}>
              Close
            </Btn>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <div className="dim small">
              Nothing below has run. Each step was resolved in the tool registry, checked against that tool&apos;s own input
              schema and put through the same permission decision as a real run — but no tool was called and no approval was
              requested.
            </div>
            <div className="list">
              {plan.steps.map((s) => (
                <div key={s.index} className="list-item">
                  <Pill tone={VERDICT_TONE[s.verdict]}>{s.verdict}</Pill>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="mono small truncate">
                      {s.index}. {s.summary}
                    </div>
                    <div className="dim small">
                      {[s.detail, s.declaredLevel && s.effectiveLevel && s.declaredLevel === s.effectiveLevel
                        ? s.declaredLevel
                        : [s.declaredLevel, s.effectiveLevel].filter(Boolean).join(' → ')]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                </div>
              ))}
              {!plan.steps.length && <Empty>This automation has no steps.</Empty>}
            </div>
            {plan.log.length > 0 && <pre className="log">{plan.log.join('\n')}</pre>}
            <Pill tone={plan.ok ? 'ok' : 'warn'}>
              {plan.ok ? 'Every step would run or ask' : 'Some steps would not run as written'}
            </Pill>
          </div>
        </Modal>
      )}

      {log && (
        <Modal wide title={`${log.name} — ${log.ok ? 'finished' : 'failed'}`} onClose={() => setLog(null)}>
          <pre className="log">{log.lines.join('\n') || 'No output.'}</pre>
        </Modal>
      )}
    </div>
  )
}
