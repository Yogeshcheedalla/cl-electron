import { Btn, Card, Empty, Pill } from '../components/ui'
import { useAction } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import { useApp } from '../stores/app'

/**
 * Pending approvals, and the trusted-tool list that lets some of them through
 * without asking. Answering here is the same as answering the blocking prompt.
 */
export function ApprovalsPage() {
  const { approvals, refreshApprovals, settings, saveSettings } = useApp()
  const { run, pending } = useAction()
  const trusted = settings?.automation.trustedTools ?? []

  const decide = (id: string, decision: 'once' | 'always' | 'deny', label: string) =>
    void run(label, async () => {
      await call(() => window.akansha.approvals.resolve(id, decision))
      await refreshApprovals()
    }, label)

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Approvals</h1>
        <span className="grow" />
        <Btn size="sm" onClick={() => void refreshApprovals()}>
          Refresh
        </Btn>
      </div>

      <Card title={`Waiting (${approvals.length})`} flush>
        {approvals.length === 0 ? (
          <Empty>Nothing is waiting for you.</Empty>
        ) : (
          <div className="col" style={{ gap: 10, padding: 10 }}>
            {approvals.map((a) => (
              <div key={a.id} className="card">
                <div className="row wrap between" style={{ gap: 8 }}>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <Pill tone={a.level === 'PRIVILEGED' ? 'priv' : 'warn'}>{a.level}</Pill>
                    <span className="mono small">{a.tool}</span>
                  </div>
                  <span className="dim small">{stamp(a.createdMs)}</span>
                </div>
                <div style={{ marginTop: 8 }}>{a.summary}</div>
                <div className="dim small">{a.reason}</div>
                <pre className="log" style={{ marginTop: 8 }}>
                  {JSON.stringify(a.input, null, 2)}
                </pre>
                <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                  <Btn variant="danger" disabled={pending !== null} onClick={() => decide(a.id, 'deny', 'Denied')}>
                    Deny
                  </Btn>
                  <Btn disabled={pending !== null} onClick={() => decide(a.id, 'always', `Always allow ${a.tool}`)}>
                    Always allow this tool
                  </Btn>
                  <Btn variant="primary" disabled={pending !== null} onClick={() => decide(a.id, 'once', 'Allowed once')}>
                    Allow once
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Trusted tools (${trusted.length})`}>
        <div className="dim small">
          These run without asking. Removing one brings its confirmation prompt back immediately.
        </div>
        {trusted.length === 0 ? (
          <Empty>Nothing is trusted yet — every action that can change the machine asks first.</Empty>
        ) : (
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            {trusted.map((name) => (
              <span key={name} className="pill">
                <span className="mono">{name}</span>
                <button
                  className="btn ghost sm"
                  style={{ padding: '0 4px', border: 0 }}
                  aria-label={`Stop trusting ${name}`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run('Update trusted tools', () =>
                      saveSettings({
                        automation: {
                          ...(settings as NonNullable<typeof settings>).automation,
                          trustedTools: trusted.filter((t) => t !== name)
                        }
                      })
                    , `${name} now asks again`)
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
