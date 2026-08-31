import { useEffect, type ComponentType } from 'react'
import { ApprovalGate } from './components/ApprovalGate'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { Toasts } from './components/Toasts'
import { WakeFlag } from './components/WakeFlag'
import { ChatPage } from './features/chat/ChatPage'
import { useGlobalEvents } from './hooks/useEvents'
import { useWakeWord } from './hooks/useWakeWord'
import { ActivityPage } from './pages/ActivityPage'
import { AppsPage } from './pages/AppsPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { DashboardPage } from './pages/DashboardPage'
import { DeveloperPage } from './pages/DeveloperPage'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import { FilesPage } from './pages/FilesPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { MemoryPage } from './pages/MemoryPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SystemPage } from './pages/SystemPage'
import { TasksPage } from './pages/TasksPage'
import { VoicePage } from './pages/VoicePage'
import { bridgeReady, errorText } from './services/api'
import { useApp, type Page } from './stores/app'

const PAGES: Record<Page, ComponentType> = {
  dashboard: DashboardPage,
  chat: ChatPage,
  voice: VoicePage,
  tasks: TasksPage,
  memory: MemoryPage,
  apps: AppsPage,
  files: FilesPage,
  system: SystemPage,
  automations: AutomationsPage,
  knowledge: KnowledgePage,
  activity: ActivityPage,
  approvals: ApprovalsPage,
  notifications: NotificationsPage,
  developer: DeveloperPage,
  diagnostics: DiagnosticsPage,
  settings: SettingsPage
}

/**
 * The shell. It owns four cross-cutting concerns and nothing else: the single
 * event subscription, the one-time settings load, the keyboard shortcut for the
 * palette, and the wake listener -- which lives here because hands-free voice has
 * to work whatever page is open, and its indicator has to be visible on all of
 * them. Pages fetch their own data so a failure stays on one screen.
 */
export default function App() {
  const { page, ready, settings, capturing, setPalette, load, toast } = useApp()

  useGlobalEvents()
  useWakeWord()

  useEffect(() => {
    if (!bridgeReady()) return
    load().catch((e) => toast({ kind: 'bad', title: 'Akansha could not load its settings', body: errorText(e) }))
  }, [load, toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPalette])

  // Animations are a setting, and `prefers-reduced-motion` overrides it in CSS.
  const motion = settings?.general.animations ?? true

  if (!bridgeReady()) {
    return (
      <div className="shell">
        <div className="page">
          <div className="empty">
            The Akansha bridge did not load, so nothing on this window can reach the machine. Close Akansha and start it
            again.
          </div>
        </div>
      </div>
    )
  }

  const Current = PAGES[page]

  return (
    <div className={`shell ${motion ? 'motion' : ''}`.trim()}>
      <Titlebar />
      <div className="body">
        <Sidebar />
        <main className="page">
          {ready ? <Current /> : <div className="empty">Starting Akansha…</div>}
        </main>
      </div>
      {capturing && (
        <div className="capture-flag" role="status">
          ● Screen is being captured
        </div>
      )}
      <WakeFlag />
      <ApprovalGate />
      <CommandPalette />
      <Toasts />
    </div>
  )
}
