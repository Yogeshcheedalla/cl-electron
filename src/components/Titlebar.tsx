import { useApp, unreadCount } from '../stores/app'
import { Orb, STATE_TEXT } from './Orb'
import { call } from '../services/api'
import { PRODUCT } from '../../shared/brand'

/**
 * The frameless titlebar. The three window buttons call real window channels;
 * the chips are live counters, not decoration.
 */
export function Titlebar() {
  const { assistant, approvals, notifications, page, go, setPalette } = useApp()
  const unread = unreadCount(notifications)

  const win = (fn: () => Promise<unknown>) => () => void fn().catch(() => undefined)

  return (
    <header className="titlebar">
      <div className="brand">
        <Orb state={assistant} size={18} />
        {PRODUCT}
      </div>
      <span className="dim small no-drag">{STATE_TEXT[assistant] ?? assistant}</span>
      <span className="spacer" />

      <button className="tb-chip no-drag" onClick={() => setPalette(true)} title="Command palette (Ctrl+K)">
        Search <span className="dim">Ctrl K</span>
      </button>

      {approvals.length > 0 && (
        <button className="tb-chip alert" onClick={() => go('approvals')} title="Pending approvals">
          Approvals <span className="count">{approvals.length}</span>
        </button>
      )}

      <button
        className={`tb-chip ${unread ? 'alert' : ''}`}
        onClick={() => go('notifications')}
        title="Notifications"
        aria-current={page === 'notifications'}
      >
        Alerts {unread > 0 && <span className="count">{unread}</span>}
      </button>

      <button className="win-btn" onClick={win(() => call(() => window.akansha.window.minimize()))} aria-label="Minimize">
        —
      </button>
      <button
        className="win-btn"
        onClick={win(() => call(() => window.akansha.window.toggleMaximize()))}
        aria-label="Maximize or restore"
      >
        ▢
      </button>
      <button
        className="win-btn danger"
        onClick={win(() => call(() => window.akansha.window.close()))}
        aria-label="Close window"
      >
        ✕
      </button>
    </header>
  )
}
