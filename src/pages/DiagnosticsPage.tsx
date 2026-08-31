import { useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Modal, Pill } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import type { HealthCheck } from '../../shared/records'

const TONE: Record<HealthCheck['status'], string> = { HEALTHY: 'ok', WARNING: 'warn', ERROR: 'bad' }

/** Real health checks from the main process, plus the log file it writes. */
export function DiagnosticsPage() {
  const checks = useLoad(() => call(() => window.akansha.diagnostics.run()))
  const { run, pending } = useAction()
  const [logs, setLogs] = useState<{ text: string; path: string } | null>(null)
  const [caps, setCaps] = useState<string[] | null>(null)

  const openLogs = async () => {
    const out = await run('Read log file', () => call(() => window.akansha.diagnostics.logs(400)))
    if (out) setLogs(out)
  }

  const readCapabilities = async () => {
    const out = await run('Check capabilities', async () => {
      const [voice, computer] = await Promise.all([
        call(() => window.akansha.voice.capabilities()),
        call(() => window.akansha.computer.capabilities())
      ])
      return [
        `Speech to text: ${voice.stt ? 'available' : 'unavailable'} — ${voice.sttDetail}`,
        `Text to speech: ${voice.tts ? 'available' : 'unavailable'}`,
        `Screen capture: ${computer.screen ? 'available' : 'unavailable'}`,
        `Synthetic input: ${computer.input ? 'available' : 'unavailable'}`,
        computer.detail
      ]
    })
    if (out) setCaps(out)
  }

  const rows = checks.data ?? []
  const worst = rows.some((c) => c.status === 'ERROR') ? 'ERROR' : rows.some((c) => c.status === 'WARNING') ? 'WARNING' : 'HEALTHY'

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Diagnostics</h1>
        <span className="grow" />
        {rows.length > 0 && <Pill tone={TONE[worst as HealthCheck['status']]}>{worst}</Pill>}
        <Btn size="sm" disabled={pending !== null} onClick={() => void readCapabilities()}>
          Capabilities
        </Btn>
        <Btn size="sm" disabled={pending !== null} onClick={() => void openLogs()}>
          View log file
        </Btn>
        <Btn size="sm" variant="primary" disabled={checks.loading} onClick={() => void checks.reload()}>
          {checks.loading ? 'Running…' : 'Run again'}
        </Btn>
      </div>

      <ErrorNote error={checks.error} />

      <Card flush>
        {rows.length === 0 ? (
          <Empty>{checks.loading ? 'Running health checks…' : 'No checks reported.'}</Empty>
        ) : (
          <div className="list">
            {rows.map((c) => (
              <div key={c.name} className="list-item">
                <Pill tone={TONE[c.status]}>{c.status}</Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>{c.name}</div>
                  <div className="dim small">{c.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {caps && (
        <Card title="Capabilities on this machine">
          <div className="col" style={{ gap: 4 }}>
            {caps.filter(Boolean).map((line) => (
              <div key={line} className="small">
                {line}
              </div>
            ))}
          </div>
        </Card>
      )}

      {logs && (
        <Modal
          wide
          title={logs.path}
          onClose={() => setLogs(null)}
          footer={
            <>
              <span className="grow dim small">Keys and tokens are never written to this file.</span>
              <Btn variant="ghost" onClick={() => setLogs(null)}>
                Close
              </Btn>
            </>
          }
        >
          <pre className="log" style={{ maxHeight: '60vh' }}>
            {logs.text || 'The log file is empty.'}
          </pre>
        </Modal>
      )}
    </div>
  )
}
