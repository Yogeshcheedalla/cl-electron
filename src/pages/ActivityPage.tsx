import { useMemo, useState } from 'react'
import { Btn, Card, Empty, Pill } from '../components/ui'
import { useAction } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import { useApp } from '../stores/app'
import type { ActivityEntry } from '../../shared/records'

const KINDS: ActivityEntry['kind'][] = ['request', 'plan', 'tool', 'permission', 'agent', 'error', 'response', 'system']

/** Every action Akansha took, in order, straight from the audit table. */
export function ActivityPage() {
  const { activity, refreshActivity } = useApp()
  const { run, pending } = useAction()
  const [kind, setKind] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return activity.filter(
      (a) =>
        (kind === 'all' || a.kind === kind) &&
        (!failedOnly || !a.ok) &&
        (!needle || `${a.label} ${a.detail ?? ''}`.toLowerCase().includes(needle))
    )
  }, [activity, failedOnly, kind, query])

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Activity</h1>
        <span className="grow" />
        <Btn size="sm" onClick={() => void refreshActivity()}>
          Refresh
        </Btn>
        <Btn
          size="sm"
          variant="danger"
          disabled={pending !== null || activity.length === 0}
          onClick={() =>
            void run('Clear activity', async () => {
              await call(() => window.akansha.activity.clear())
              await refreshActivity()
            }, 'Activity cleared')
          }
        >
          Clear log
        </Btn>
      </div>

      <Card>
        <div className="row wrap" style={{ gap: 8 }}>
          <select value={kind} aria-label="Kind" style={{ width: 160 }} onChange={(e) => setKind(e.target.value)}>
            <option value="all">Everything</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            type="search"
            className="grow"
            placeholder="Filter by text"
            value={query}
            aria-label="Filter activity"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Btn size="sm" variant={failedOnly ? 'primary' : 'default'} onClick={() => setFailedOnly(!failedOnly)}>
            Failures only
          </Btn>
        </div>
      </Card>

      <Card title={`${rows.length} of ${activity.length} entries`} flush>
        {rows.length === 0 ? (
          <Empty>Nothing matches that filter.</Empty>
        ) : (
          <div className="list scroll-320" style={{ maxHeight: '60vh' }}>
            {rows.map((a) => (
              <div key={a.id} className="list-item">
                <Pill tone={a.ok ? 'ok' : 'bad'}>{a.kind}</Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>{a.label}</div>
                  {a.detail && <div className="dim small mono">{a.detail}</div>}
                </div>
                {a.durationMs !== undefined && (
                  <span className="dim small">
                    {a.durationMs < 1000 ? `${a.durationMs} ms` : `${(a.durationMs / 1000).toFixed(1)} s`}
                  </span>
                )}
                <span className="dim small">{stamp(a.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
