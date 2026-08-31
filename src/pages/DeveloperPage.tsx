import { useState } from 'react'
import { Btn, Card, Empty, Field, Pill, Toggle } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { money, stamp } from '../services/format'
import { useApp } from '../stores/app'
import type { PermissionLevel } from '../../shared/types'
import type { TerminalResult } from '../../shared/api'

/**
 * The developer console: run a command through the classified command layer,
 * invoke a single tool with JSON input, and read the model usage ledger. None of
 * it bypasses the permission manager -- a CONFIRM command still asks.
 */
export function DeveloperPage() {
  const { settings, saveSettings } = useApp()
  const { run, pending } = useAction()

  const tools = useLoad(() => call(() => window.akansha.tools.list()))
  const skills = useLoad(() => call(() => window.akansha.skills.list()))
  const usage = useLoad(() => call(() => window.akansha.ai.usage(30)))

  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [classified, setClassified] = useState<{ level: PermissionLevel; reason: string } | null>(null)
  const [result, setResult] = useState<TerminalResult | null>(null)

  const [toolName, setToolName] = useState('')
  const [toolInput, setToolInput] = useState('{}')
  const [toolOut, setToolOut] = useState<string | null>(null)
  // Null means "unchanged", so the textarea shows the saved prompt until edited.
  const [prompt, setPrompt] = useState<string | null>(null)

  const classify = async () => {
    if (!command.trim()) return
    const out = await run('Classify command', () => call(() => window.akansha.terminal.classify(command.trim())))
    if (out) setClassified(out)
  }

  const execute = async () => {
    if (!command.trim()) return
    setResult(null)
    const out = await run('Run command', () =>
      call(() => window.akansha.terminal.execute(command.trim(), cwd.trim() || undefined))
    )
    if (out) setResult(out)
  }

  const invoke = async () => {
    if (!toolName) return
    let input: Record<string, unknown>
    try {
      input = toolInput.trim() ? (JSON.parse(toolInput) as Record<string, unknown>) : {}
    } catch {
      await run('Tool input', async () => {
        throw new Error('That input is not valid JSON.')
      })
      return
    }
    const out = await run(`Invoke ${toolName}`, () => call(() => window.akansha.tools.invoke(toolName, input)))
    if (out !== undefined) setToolOut(JSON.stringify(out, null, 2))
  }

  const entries = usage.data?.entries ?? []
  const cost = entries.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0)

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Developer</h1>
        <span className="grow" />
        <Toggle
          label="Developer mode"
          hint="Shows token counts and raw payloads elsewhere in the app."
          checked={settings?.developerMode ?? false}
          onChange={(developerMode) => void saveSettings({ developerMode })}
        />
      </div>

      <Card title="Command">
        <div className="col" style={{ gap: 8 }}>
          <textarea
            className="mono"
            rows={2}
            value={command}
            aria-label="Command"
            placeholder="git status"
            onChange={(e) => (setCommand(e.target.value), setClassified(null))}
          />
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="grow mono"
              placeholder="Working directory (optional)"
              value={cwd}
              aria-label="Working directory"
              onChange={(e) => setCwd(e.target.value)}
            />
            <Btn disabled={!command.trim() || pending !== null} onClick={() => void classify()}>
              Classify
            </Btn>
            <Btn variant="primary" disabled={!command.trim() || pending !== null} onClick={() => void execute()}>
              Run
            </Btn>
          </div>
          {classified && (
            <div className="row wrap" style={{ gap: 8 }}>
              <Pill
                tone={
                  classified.level === 'BLOCKED'
                    ? 'bad'
                    : classified.level === 'PRIVILEGED'
                      ? 'priv'
                      : classified.level === 'CONFIRM'
                        ? 'warn'
                        : 'ok'
                }
              >
                {classified.level}
              </Pill>
              <span className="dim small">{classified.reason}</span>
            </div>
          )}
          {result && (
            <div className="col" style={{ gap: 6 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <Pill tone={result.exitCode === 0 ? 'ok' : 'bad'}>exit {result.exitCode ?? 'killed'}</Pill>
                {result.timedOut && <Pill tone="warn">timed out</Pill>}
              </div>
              {result.stdout && <pre className="log">{result.stdout}</pre>}
              {result.stderr && (
                <pre className="log" style={{ color: '#fca5a5' }}>
                  {result.stderr}
                </pre>
              )}
              {!result.stdout && !result.stderr && <div className="dim small">No output.</div>}
            </div>
          )}
        </div>
      </Card>

      <Card title="Invoke a tool">
        <div className="col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="grow" value={toolName} aria-label="Tool" onChange={(e) => setToolName(e.target.value)}>
              <option value="">Choose a tool…</option>
              {(tools.data ?? []).map((t) => (
                <option key={t.name} value={t.name} disabled={t.effectiveLevel === 'BLOCKED'}>
                  {t.name} · {t.effectiveLevel}
                </option>
              ))}
            </select>
            <Btn variant="primary" disabled={!toolName || pending !== null} onClick={() => void invoke()}>
              Invoke
            </Btn>
          </div>
          <div className="dim small">{(tools.data ?? []).find((t) => t.name === toolName)?.description ?? ''}</div>
          <textarea className="mono" rows={4} value={toolInput} aria-label="Tool input" onChange={(e) => setToolInput(e.target.value)} />
          {toolOut !== null && <pre className="log">{toolOut}</pre>}
        </div>
      </Card>

      <div className="grid cols-2">
        <Card title={`Model usage (30 days) — ${money(cost)}`} flush>
          {entries.length === 0 ? (
            <Empty>{usage.error ?? 'No model calls recorded yet.'}</Empty>
          ) : (
            <div className="scroll-320">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Model</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(0, 80).map((e) => (
                    <tr key={e.id} style={e.failed ? { color: '#fca5a5' } : undefined}>
                      <td className="dim small">{stamp(e.ts)}</td>
                      <td className="truncate">
                        {e.provider}/{e.model}
                      </td>
                      <td>{e.inputTokens}</td>
                      <td>{e.outputTokens}</td>
                      <td className="dim">{(e.latencyMs / 1000).toFixed(1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Skills" flush>
          {!skills.data?.length ? (
            <Empty>{skills.error ?? 'No skills are installed.'}</Empty>
          ) : (
            <div className="list scroll-320">
              {skills.data.map((s) => (
                <div key={s.name} className="list-item">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate">
                      {s.name} <span className="dim small">v{s.version}</span>
                    </div>
                    <div className="dim small truncate">{s.description}</div>
                    <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                      {s.tools.map((t) => (
                        <span key={t} className="pill">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Toggle
                    label=""
                    checked={s.enabled}
                    onChange={(enabled) =>
                      void run(`Update ${s.name}`, async () => {
                        await call(() => window.akansha.skills.setEnabled(s.name, enabled))
                        await skills.reload()
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="System prompt"
        right={
          <Btn
            size="sm"
            variant="primary"
            disabled={!settings || prompt === null || pending !== null}
            onClick={() =>
              settings &&
              prompt !== null &&
              void run('Save system prompt', async () => {
                await saveSettings({ ai: { ...settings.ai, systemPrompt: prompt } })
                setPrompt(null)
              }, 'System prompt saved')
            }
          >
            Save
          </Btn>
        }
      >
        <Field label="Sent with every conversation" hint="Leave blank to use the built-in prompt.">
          <textarea
            rows={5}
            value={prompt ?? settings?.ai.systemPrompt ?? ''}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
      </Card>
    </div>
  )
}
