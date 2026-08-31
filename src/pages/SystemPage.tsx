import { useState } from 'react'
import { Bar, Btn, Card, Empty, ErrorNote, Metric, Pill } from '../components/ui'
import { useAction, useInterval, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { bytes, duration, percent } from '../services/format'

const POWER: { action: string; label: string }[] = [
  { action: 'lock', label: 'Lock' },
  { action: 'signout', label: 'Sign out' },
  { action: 'sleep', label: 'Sleep' },
  { action: 'restart', label: 'Restart' },
  { action: 'shutdown', label: 'Shut down' }
]

/**
 * Live machine state. Power actions are PRIVILEGED in the tool registry, so each
 * one raises a confirmation before anything happens.
 */
export function SystemPage() {
  const info = useLoad(() => call(() => window.akansha.system.getInfo()))
  const procs = useLoad(() => call(() => window.akansha.system.processes(40)))
  const { run, pending } = useAction()
  const [live, setLive] = useState(true)

  useInterval(() => {
    void info.reload()
    void procs.reload()
  }, live ? 8000 : null)

  const sys = info.data

  const control = (action: string, label: string, value?: number) =>
    void run(label, async () => {
      const { detail } = await call(() => window.akansha.system.control(action, value))
      return detail
    }, label)

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>System</h1>
        <span className="grow" />
        <Btn size="sm" variant={live ? 'primary' : 'default'} onClick={() => setLive(!live)}>
          {live ? 'Live · on' : 'Live · off'}
        </Btn>
        <Btn size="sm" onClick={() => (void info.reload(), void procs.reload())}>
          Refresh
        </Btn>
      </div>

      <ErrorNote error={info.error} />

      <div className="grid cols-4">
        <Metric label="CPU" value={sys ? percent(sys.cpu.loadPercent) : '—'} sub={sys ? `${sys.cpu.cores} cores` : ''} />
        <Metric
          label="Memory"
          value={sys ? percent(sys.memory.usedPercent) : '—'}
          sub={sys ? `${bytes(sys.memory.freeBytes)} free` : ''}
        />
        <Metric label="Uptime" value={sys ? duration(sys.uptimeSeconds) : '—'} sub={sys?.os} />
        <Metric
          label="Network"
          value={sys ? (sys.network.online ? 'Online' : 'Offline') : '—'}
          sub={sys?.network.interfaces[0]?.address}
        />
      </div>

      <div className="grid cols-2">
        <Card title="Hardware">
          {!sys ? (
            <Empty>Reading…</Empty>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <div className="small mono">{sys.cpu.model}</div>
              <div>
                <div className="row between small">
                  <span>Memory</span>
                  <span className="dim">
                    {bytes(sys.memory.totalBytes - sys.memory.freeBytes)} of {bytes(sys.memory.totalBytes)}
                  </span>
                </div>
                <Bar value={sys.memory.usedPercent} />
              </div>
              {sys.disks.map((d) => (
                <div key={d.drive}>
                  <div className="row between small">
                    <span>{d.drive}</span>
                    <span className="dim">{bytes(d.freeBytes)} free</span>
                  </div>
                  <Bar value={d.totalBytes ? ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100 : 0} />
                </div>
              ))}
              <div className="row wrap" style={{ gap: 8 }}>
                {sys.battery && (
                  <Pill tone={sys.battery.charging ? 'ok' : sys.battery.percent < 20 ? 'bad' : ''}>
                    Battery {percent(sys.battery.percent)}
                  </Pill>
                )}
                {sys.gpu?.map((g) => (
                  <Pill key={g}>{g}</Pill>
                ))}
                {sys.network.interfaces.map((n) => (
                  <Pill key={n.name}>
                    {n.name} · {n.address}
                  </Pill>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card title="Controls">
          <div className="col" style={{ gap: 12 }}>
            <div>
              <div className="card-title">Power</div>
              <div className="row wrap" style={{ gap: 8 }}>
                {POWER.map((p) => (
                  <Btn
                    key={p.action}
                    variant={p.action === 'shutdown' || p.action === 'restart' ? 'danger' : 'default'}
                    disabled={pending !== null}
                    onClick={() => control(p.action, p.label)}
                  >
                    {p.label}
                  </Btn>
                ))}
              </div>
              <div className="dim small" style={{ marginTop: 6 }}>
                Sleep, restart, shut down and sign out ask for confirmation first.
              </div>
            </div>
            <div>
              <div className="card-title">Volume</div>
              <div className="row wrap" style={{ gap: 8 }}>
                <Btn disabled={pending !== null} onClick={() => control('volume-down', 'Volume down', 2)}>
                  −
                </Btn>
                <Btn disabled={pending !== null} onClick={() => control('volume-up', 'Volume up', 2)}>
                  +
                </Btn>
                <Btn disabled={pending !== null} onClick={() => control('volume-mute', 'Mute')}>
                  Mute
                </Btn>
              </div>
              <div className="dim small" style={{ marginTop: 6 }}>
                Volume is stepped with the media keys, so Akansha cannot report an exact level.
              </div>
            </div>
            <div>
              <div className="card-title">Brightness</div>
              <div className="row wrap" style={{ gap: 8 }}>
                {[25, 50, 75, 100].map((v) => (
                  <Btn key={v} disabled={pending !== null} onClick={() => control('brightness', `Brightness ${v}%`, v)}>
                    {v}%
                  </Btn>
                ))}
              </div>
              <div className="dim small" style={{ marginTop: 6 }}>
                Works on integrated panels only; external monitors report a failure.
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Top processes by memory" flush>
        <ErrorNote error={procs.error} />
        {!procs.data?.length ? (
          <Empty>{procs.loading ? 'Listing processes…' : 'No process information available.'}</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>PID</th>
                <th>Memory</th>
                <th>CPU time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {procs.data.map((p) => (
                <tr key={p.pid}>
                  <td className="truncate">{p.name}</td>
                  <td className="mono dim">{p.pid}</td>
                  <td>{bytes(p.memoryBytes)}</td>
                  <td className="dim">{p.cpuSeconds}s</td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() =>
                        void run(`Close ${p.name}`, async () => {
                          const { closed } = await call(() => window.akansha.apps.close(p.name))
                          await procs.reload()
                          return closed
                        }, `Asked ${p.name} to close`)
                      }
                    >
                      Close
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
