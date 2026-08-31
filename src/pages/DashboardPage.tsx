import { Orb, STATE_TEXT } from '../components/Orb'
import { Bar, Btn, Card, Empty, Metric, Pill } from '../components/ui'
import { useAction, useInterval, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { MOTTO, PRODUCT } from '../../shared/brand'
import { ago, bytes, duration, percent, stamp } from '../services/format'
import { useApp } from '../stores/app'

/**
 * The command centre. Everything here is live: system numbers come from the
 * system service, the lists come from the database, and each quick action calls
 * the same IPC channel its own page would.
 */
export function DashboardPage() {
  const { assistant, activity, notifications, go } = useApp()
  const { run, busy } = useAction()

  const info = useLoad(() => call(() => window.akansha.system.getInfo()))
  const tasks = useLoad(() => call(() => window.akansha.tasks.list()))
  const usage = useLoad(() => call(() => window.akansha.ai.usage(7)))

  useInterval(() => void info.reload(), 15_000)

  const sys = info.data
  const pending = (tasks.data ?? []).filter((t) => t.state === 'PENDING' || t.state === 'RUNNING')
  const totals = usage.data?.totals ?? {}

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row between wrap" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 14 }}>
          <Orb state={assistant} size={64} />
          <div>
            <h1 className="wordmark" style={{ margin: 0, fontSize: 22 }}>
              {PRODUCT}
            </h1>
            <div className="dim small">{MOTTO}</div>
            <div className="dim">{STATE_TEXT[assistant]}</div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Btn variant="primary" onClick={() => go('chat')}>
            Open chat
          </Btn>
          <Btn
            disabled={busy('Diagnostics')}
            onClick={() =>
              void run('Diagnostics', async () => {
                await call(() => window.akansha.diagnostics.run())
                go('diagnostics')
              })
            }
          >
            Run diagnostics
          </Btn>
          <Btn onClick={() => go('files')}>Browse files</Btn>
        </div>
      </div>

      <div className="grid cols-4">
        <Metric
          label="CPU load"
          value={sys ? percent(sys.cpu.loadPercent) : '—'}
          sub={sys ? `${sys.cpu.cores} cores` : info.error ?? 'reading…'}
        />
        <Metric
          label="Memory"
          value={sys ? percent(sys.memory.usedPercent) : '—'}
          sub={sys ? `${bytes(sys.memory.totalBytes - sys.memory.freeBytes)} of ${bytes(sys.memory.totalBytes)}` : ''}
        />
        <Metric label="Uptime" value={sys ? duration(sys.uptimeSeconds) : '—'} sub={sys?.hostname} />
        <Metric
          label="Open tasks"
          value={pending.length}
          sub={notifications.filter((n) => !n.read).length ? `${notifications.filter((n) => !n.read).length} unread alerts` : 'nothing unread'}
        />
      </div>

      <div className="grid cols-2">
        <Card title="This machine">
          {!sys ? (
            <Empty>{info.error ?? 'Reading system information…'}</Empty>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <div className="small dim">{sys.os}</div>
              <div className="small mono">{sys.cpu.model}</div>
              {sys.disks.map((d) => {
                const used = d.totalBytes ? ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100 : 0
                return (
                  <div key={d.drive}>
                    <div className="row between small">
                      <span>{d.drive}</span>
                      <span className="dim">
                        {bytes(d.freeBytes)} free of {bytes(d.totalBytes)}
                      </span>
                    </div>
                    <Bar value={used} />
                  </div>
                )
              })}
              <div className="row wrap" style={{ gap: 8 }}>
                <Pill tone={sys.network.online ? 'ok' : 'bad'}>{sys.network.online ? 'Online' : 'Offline'}</Pill>
                {sys.battery && (
                  <Pill tone={sys.battery.percent < 20 && !sys.battery.charging ? 'warn' : ''}>
                    Battery {percent(sys.battery.percent)}
                    {sys.battery.charging ? ' (charging)' : ''}
                  </Pill>
                )}
                {sys.gpu?.slice(0, 2).map((g) => (
                  <Pill key={g}>{g}</Pill>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card title="Recent activity" right={<Btn size="sm" variant="ghost" onClick={() => go('activity')}>All</Btn>}>
          {activity.length === 0 ? (
            <Empty>Nothing has happened yet.</Empty>
          ) : (
            <div className="list scroll-320">
              {activity.slice(0, 12).map((a) => (
                <div key={a.id} className="list-item">
                  <Pill tone={a.ok ? 'ok' : 'bad'}>{a.kind}</Pill>
                  <span className="grow truncate">{a.label}</span>
                  <span className="dim small">{ago(a.ts)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Tasks" right={<Btn size="sm" variant="ghost" onClick={() => go('tasks')}>Manage</Btn>}>
          {pending.length === 0 ? (
            <Empty>{tasks.error ?? 'No open tasks.'}</Empty>
          ) : (
            <div className="list">
              {pending.slice(0, 8).map((t) => (
                <div key={t.id} className="list-item">
                  <Pill tone={t.state === 'RUNNING' ? 'info' : ''}>{t.state}</Pill>
                  <span className="grow truncate">{t.title}</span>
                  <span className="dim small">{t.dueMs ? stamp(t.dueMs) : t.repeat}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Model usage (7 days)" right={<Btn size="sm" variant="ghost" onClick={() => go('developer')}>Details</Btn>}>
          {!usage.data || usage.data.entries.length === 0 ? (
            <Empty>{usage.error ?? 'No model calls recorded yet.'}</Empty>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              <div className="row between small">
                <span className="dim">Calls</span>
                <span>{usage.data.entries.length}</span>
              </div>
              {Object.entries(totals).map(([key, value]) => (
                <div key={key} className="row between small">
                  <span className="dim">{key}</span>
                  <span className="mono">{typeof value === 'number' ? value.toLocaleString() : String(value)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
