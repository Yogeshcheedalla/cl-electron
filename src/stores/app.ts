import { create } from 'zustand'
import { call, tryCall } from '../services/api'
import type {
  ActivityEntry,
  ApprovalRequest,
  AkanshaNotification
} from '../../shared/records'
import type { AssistantState, Settings } from '../../shared/types'
import type { WakePhase } from '../features/voice/wake'

export type Page =
  | 'dashboard'
  | 'chat'
  | 'voice'
  | 'tasks'
  | 'memory'
  | 'apps'
  | 'files'
  | 'system'
  | 'automations'
  | 'knowledge'
  | 'activity'
  | 'approvals'
  | 'notifications'
  | 'developer'
  | 'diagnostics'
  | 'settings'

export interface Toast {
  id: string
  kind: 'ok' | 'bad' | 'info'
  title: string
  body?: string
}

/**
 * Live state of the always-on listener. It lives here rather than inside the
 * Voice page because the on-screen indicator has to be visible on every screen
 * for as long as the microphone is open.
 */
export interface WakeState {
  /** The microphone is open right now. */
  armed: boolean
  phase: WakePhase
  /** Why it is not listening, when it is not. */
  detail: string
  /** The last phrase that actually triggered a wake, for the Voice page. */
  heard: string
  /** The last command dispatched by voice. */
  spoken: string
  /** True between a bare "Akansha" and the instruction that follows it. */
  awaiting: boolean
}

const NO_WAKE: WakeState = { armed: false, phase: 'off', detail: '', heard: '', spoken: '', awaiting: false }

interface AppState {
  page: Page
  ready: boolean
  settings: Settings | null
  assistant: AssistantState
  capturing: boolean
  paletteOpen: boolean
  activity: ActivityEntry[]
  approvals: ApprovalRequest[]
  notifications: AkanshaNotification[]
  toasts: Toast[]
  wake: WakeState
  go(page: Page): void
  setPalette(open: boolean): void
  load(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  refreshApprovals(): Promise<void>
  refreshNotifications(): Promise<void>
  refreshActivity(): Promise<void>
  setAssistant(state: AssistantState): void
  setCapturing(on: boolean): void
  setWake(patch: Partial<WakeState>): void
  pushActivity(entry: ActivityEntry): void
  pushApproval(request: ApprovalRequest): void
  dropApproval(id: string): void
  pushNotification(n: AkanshaNotification): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: string): void
}

const uid = () => Math.random().toString(36).slice(2, 10)

export const useApp = create<AppState>((set, get) => ({
  page: 'dashboard',
  ready: false,
  settings: null,
  assistant: 'IDLE',
  capturing: false,
  paletteOpen: false,
  activity: [],
  approvals: [],
  notifications: [],
  toasts: [],
  wake: NO_WAKE,

  go: (page) => set({ page, paletteOpen: false }),
  setPalette: (paletteOpen) => set({ paletteOpen }),

  async load() {
    const settings = await call(() => window.akansha.settings.get())
    const [approvals, notifications, activity] = await Promise.all([
      tryCall(() => window.akansha.approvals.list(), []),
      tryCall(() => window.akansha.notifications.list(), []),
      tryCall(() => window.akansha.activity.list(200), [])
    ])
    set({ settings, approvals, notifications, activity, ready: true })
  },

  async saveSettings(patch) {
    const settings = await call(() => window.akansha.settings.update(patch))
    set({ settings })
  },

  async refreshApprovals() {
    set({ approvals: await tryCall(() => window.akansha.approvals.list(), []) })
  },
  async refreshNotifications() {
    set({ notifications: await tryCall(() => window.akansha.notifications.list(), []) })
  },
  async refreshActivity() {
    set({ activity: await tryCall(() => window.akansha.activity.list(200), []) })
  },

  setAssistant: (assistant) => set({ assistant }),
  setCapturing: (capturing) => set({ capturing }),
  setWake: (patch) => set({ wake: { ...get().wake, ...patch } }),

  pushActivity: (entry) => set({ activity: [entry, ...get().activity].slice(0, 400) }),
  pushApproval: (request) => set({ approvals: [...get().approvals.filter((a) => a.id !== request.id), request] }),
  dropApproval: (id) => set({ approvals: get().approvals.filter((a) => a.id !== id) }),
  pushNotification: (n) => set({ notifications: [n, ...get().notifications].slice(0, 200) }),

  toast(t) {
    const entry = { ...t, id: uid() }
    set({ toasts: [...get().toasts, entry] })
    setTimeout(() => get().dismissToast(entry.id), t.kind === 'bad' ? 8000 : 4500)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

export const unreadCount = (list: AkanshaNotification[]) => list.filter((n) => !n.read).length
