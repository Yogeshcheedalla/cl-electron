import { useApp, unreadCount, type Page } from '../stores/app'

export const NAV: { group: string; items: { page: Page; label: string; icon: string }[] }[] = [
  {
    group: 'Assistant',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: '◈' },
      { page: 'chat', label: 'Chat', icon: '❯' },
      { page: 'voice', label: 'Voice', icon: '◉' },
      { page: 'tasks', label: 'Tasks', icon: '☑' },
      { page: 'memory', label: 'Memory', icon: '❖' }
    ]
  },
  {
    group: 'This PC',
    items: [
      { page: 'apps', label: 'Applications', icon: '▣' },
      { page: 'files', label: 'Files', icon: '▤' },
      { page: 'system', label: 'System', icon: '▥' },
      { page: 'automations', label: 'Automations', icon: '⟳' },
      { page: 'knowledge', label: 'Knowledge', icon: '▦' }
    ]
  },
  {
    group: 'Oversight',
    items: [
      { page: 'activity', label: 'Activity', icon: '☰' },
      { page: 'approvals', label: 'Approvals', icon: '⚑' },
      { page: 'notifications', label: 'Notifications', icon: '✦' },
      { page: 'developer', label: 'Developer', icon: '{}' },
      { page: 'diagnostics', label: 'Diagnostics', icon: '✚' },
      { page: 'settings', label: 'Settings', icon: '⚙' }
    ]
  }
]

export function Sidebar() {
  const { page, go, approvals, notifications } = useApp()
  const unread = unreadCount(notifications)

  const badge = (target: Page) =>
    target === 'approvals' && approvals.length
      ? approvals.length
      : target === 'notifications' && unread
        ? unread
        : null

  return (
    <nav className="sidebar" aria-label="Sections">
      {NAV.map((section) => (
        <div key={section.group}>
          <div className="nav-group">{section.group}</div>
          {section.items.map((item) => {
            const count = badge(item.page)
            return (
              <button
                key={item.page}
                className={`nav-item ${page === item.page ? 'active' : ''}`}
                onClick={() => go(item.page)}
                aria-current={page === item.page ? 'page' : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
                {count ? <span className="badge">{count}</span> : null}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
