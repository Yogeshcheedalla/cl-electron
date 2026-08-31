import { create } from 'zustand'
import { call } from '../services/api'
import type { Conversation, PlanStep, StoredMessage } from '../../shared/records'
import type { SendPayload } from '../../shared/api'

export interface Draft {
  name: string
  mimeType: string
  base64: string
}

interface ChatState {
  conversations: Conversation[]
  activeId: string | null
  messages: StoredMessage[]
  streaming: string
  runId: string | null
  plan: PlanStep[]
  busy: boolean
  mode: NonNullable<SendPayload['mode']>
  lastError: string | null
  setMode(mode: NonNullable<SendPayload['mode']>): void
  loadConversations(): Promise<void>
  open(id: string): Promise<void>
  startNew(): void
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
  send(text: string, attachments: Draft[]): Promise<void>
  regenerate(): Promise<void>
  cancel(): Promise<void>
  onDelta(runId: string, text: string): void
  onDone(runId: string): Promise<void>
  onError(runId: string, message: string): void
  onPlan(runId: string, steps: PlanStep[]): void
}

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  streaming: '',
  runId: null,
  plan: [],
  busy: false,
  mode: 'auto',
  lastError: null,

  setMode: (mode) => set({ mode }),

  async loadConversations() {
    set({ conversations: await call(() => window.akansha.conversations.list(80)) })
  },

  async open(id) {
    set({ activeId: id, messages: await call(() => window.akansha.conversations.messages(id)), plan: [], lastError: null })
  },

  startNew: () => set({ activeId: null, messages: [], streaming: '', plan: [], lastError: null }),

  async rename(id, title) {
    await call(() => window.akansha.conversations.rename(id, title))
    await get().loadConversations()
  },

  async remove(id) {
    await call(() => window.akansha.conversations.remove(id))
    const next = get().activeId === id ? { activeId: null, messages: [] } : {}
    set(next)
    await get().loadConversations()
  },

  async send(text, attachments) {
    if (get().busy) throw new Error('Akansha is still working on the previous message.')
    const optimistic: StoredMessage = {
      id: `local-${Date.now()}`,
      conversationId: get().activeId ?? 'pending',
      role: 'user',
      content: text,
      createdMs: Date.now()
    }
    set({ messages: [...get().messages, optimistic], streaming: '', plan: [], busy: true, lastError: null })
    try {
      const payload: SendPayload = {
        text,
        mode: get().mode,
        ...(attachments.length ? { attachments } : {}),
        ...(get().activeId ? { conversationId: get().activeId as string } : {})
      }
      const { runId, conversationId } = await call(() => window.akansha.ai.send(payload))
      set({ runId, activeId: conversationId })
      await get().loadConversations()
    } catch (e) {
      set({ busy: false, runId: null, messages: get().messages.filter((m) => m.id !== optimistic.id) })
      throw e
    }
  },

  async regenerate() {
    const lastUser = [...get().messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) throw new Error('There is nothing to send again.')
    await get().send(lastUser.content, [])
  },

  async cancel() {
    const runId = get().runId
    if (!runId) return
    await call(() => window.akansha.ai.cancel(runId))
  },

  onDelta(runId, text) {
    if (get().runId && get().runId !== runId) return
    set({ streaming: get().streaming + text })
  },

  async onDone(runId) {
    if (get().runId && get().runId !== runId) return
    const id = get().activeId
    set({ busy: false, runId: null, streaming: '' })
    if (id) set({ messages: await call(() => window.akansha.conversations.messages(id)) })
    await get().loadConversations()
  },

  onError(runId, message) {
    if (get().runId && get().runId !== runId) return
    set({ busy: false, runId: null, streaming: '', lastError: message })
  },

  onPlan(runId, steps) {
    if (get().runId && get().runId !== runId) return
    set({ plan: steps })
  }
}))
