import { useState } from 'react'
import { call, errorText } from '../services/api'
import { useApp } from '../stores/app'
import { Btn, Pill } from './ui'

/**
 * A blocking prompt for anything that changes the machine. It shows the exact
 * tool and the exact arguments, because "allow" has to mean something specific.
 * Closing the window is not an answer: the only ways out are the three buttons.
 */
export function ApprovalGate() {
  const { approvals, dropApproval, toast } = useApp()
  const [busy, setBusy] = useState('')
  const request = approvals[0]
  if (!request) return null

  const answer = async (decision: 'once' | 'always' | 'deny') => {
    setBusy(decision)
    try {
      await call(() => window.akansha.approvals.resolve(request.id, decision))
      dropApproval(request.id)
    } catch (e) {
      toast({ kind: 'bad', title: 'That approval could not be recorded', body: errorText(e) })
      dropApproval(request.id)
    } finally {
      setBusy('')
    }
  }

  const args = Object.entries(request.input ?? {})

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="modal fade-in">
        <header>
          <Pill tone={request.level === 'PRIVILEGED' ? 'priv' : 'warn'}>{request.level}</Pill>
          <h2 id="approval-title" className="grow">
            Akansha wants to {request.summary}
          </h2>
        </header>
        <div className="content col">
          <p style={{ margin: 0 }}>{request.reason}</p>
          <div className="small dim mono">{request.tool}</div>
          {args.length > 0 && (
            <div className="card scroll-160" style={{ background: 'var(--bg)' }}>
              {args.map(([key, value]) => (
                <div key={key} className="mono" style={{ display: 'flex', gap: 8 }}>
                  <span className="dim" style={{ minWidth: 90 }}>
                    {key}
                  </span>
                  <span style={{ overflowWrap: 'anywhere' }}>
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {approvals.length > 1 && (
            <div className="small dim">{approvals.length - 1} more request(s) waiting behind this one.</div>
          )}
        </div>
        <footer>
          <Btn variant="danger" disabled={!!busy} onClick={() => void answer('deny')}>
            Deny
          </Btn>
          <Btn disabled={!!busy} onClick={() => void answer('always')} title="Trust this tool from now on">
            Always allow
          </Btn>
          <Btn variant="primary" disabled={!!busy} onClick={() => void answer('once')}>
            Allow once
          </Btn>
        </footer>
      </div>
    </div>
  )
}
