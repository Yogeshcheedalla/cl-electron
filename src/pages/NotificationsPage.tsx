import { useState } from 'react'
import { Btn, Card, Empty, Pill } from '../components/ui'
import { useAction } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import { useApp, unreadCount } from '../stores/app'
import type { AkanshaNotification } from '../../shared/records'

const TONE: Record<AkanshaNotification['category'], string> = {
  TASK: '',
  SYSTEM: 'info',
  AUTOMATION: 'info',
  AI: '',
  ERROR: 'bad',
  SECURITY: 'priv'
}

/** Everything Akansha wanted to tell you, kept until you clear it. */
export function NotificationsPage() {
  const { notifications, refreshNotifications } = useApp()
  const { run, pending } = useAction()
  const [filter, setFilter] = useState<string>('all')

  const rows = notifications.filter((n) => filter === 'all' || n.category === filter)
  const unread = unreadCount(notifications)

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Notifications</h1>
        <span className="grow" />
        <select value={filter} aria-label="Category" style={{ width: 160 }} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All categories</option>
          {Object.keys(TONE).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Btn
          size="sm"
          disabled={pending !== null || unread === 0}
          onClick={() =>
            void run('Mark all read', async () => {
              await call(() => window.akansha.notifications.markRead())
              await refreshNotifications()
            })
          }
        >
          Mark all read
        </Btn>
        <Btn
          size="sm"
          variant="danger"
          disabled={pending !== null || notifications.length === 0}
          onClick={() =>
            void run('Clear notifications', async () => {
              await call(() => window.akansha.notifications.clear())
              await refreshNotifications()
            }, 'Notifications cleared')
          }
        >
          Clear
        </Btn>
      </div>

      <Card title={`${rows.length} shown · ${unread} unread`} flush>
        {rows.length === 0 ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <div className="list scroll-320" style={{ maxHeight: '64vh' }}>
            {rows.map((n) => (
              <div
                key={n.id}
                className="list-item clickable"
                style={n.read ? { opacity: 0.72 } : undefined}
                onClick={() =>
                  n.read
                    ? undefined
                    : void run('Mark read', async () => {
                        await call(() => window.akansha.notifications.markRead(n.id))
                        await refreshNotifications()
                      })
                }
              >
                <Pill tone={TONE[n.category]}>{n.category}</Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className={n.read ? '' : 'grow'} style={{ fontWeight: n.read ? 400 : 600 }}>
                    {n.title}
                  </div>
                  <div className="dim small">{n.body}</div>
                </div>
                <span className="dim small">{stamp(n.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
