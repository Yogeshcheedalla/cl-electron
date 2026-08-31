import { useEffect, useRef } from 'react'
import { useApp } from '../stores/app'
import { useChat } from '../stores/chat'
import type { AkanshaEvent } from '../../shared/ipc'
import type { ActivityEntry, ApprovalRequest, AkanshaNotification, PlanStep } from '../../shared/records'
import type { AssistantState } from '../../shared/types'
import type { Page } from '../stores/app'

const ASSISTANT_STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'EXECUTING', 'ERROR']
const PAGES = new Set<string>([
  'dashboard',
  'chat',
  'voice',
  'tasks',
  'memory',
  'apps',
  'files',
  'system',
  'automations',
  'knowledge',
  'activity',
  'approvals',
  'notifications',
  'developer',
  'diagnostics',
  'settings'
])

/** Subscribe to one event type from a page without touching the global wiring. */
export function useAkanshaEvent<T extends AkanshaEvent['type']>(
  type: T,
  handler: (event: Extract<AkanshaEvent, { type: T }>) => void
) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!window.akansha) return
    return window.akansha.onEvent((event) => {
      if (event.type === type) ref.current(event as Extract<AkanshaEvent, { type: T }>)
    })
  }, [type])
}

/**
 * The single push-stream reader. Everything the main process announces lands in
 * a store here, so no screen has to poll to stay current.
 */
export function useGlobalEvents() {
  useEffect(() => {
    if (!window.akansha) return
    const app = useApp.getState
    const chat = useChat.getState

    return window.akansha.onEvent((event: AkanshaEvent) => {
      switch (event.type) {
        case 'ai:delta':
          chat().onDelta(event.runId, event.text)
          break
        case 'ai:done':
          void chat().onDone(event.runId)
          break
        case 'ai:error':
          chat().onError(event.runId, event.message)
          app().toast({ kind: 'bad', title: 'Akansha could not answer', body: event.message })
          break
        case 'ai:plan':
          chat().onPlan(event.runId, event.steps as PlanStep[])
          break
        case 'state': {
          if (ASSISTANT_STATES.includes(event.state)) {
            app().setAssistant(event.state as AssistantState)
            break
          }
          if (event.state === 'settings-changed') {
            void useApp.getState().load()
            break
          }
          if (event.state === 'screen-capture') {
            app().setCapturing(true)
            setTimeout(() => useApp.getState().setCapturing(false), 2600)
          }
          break
        }
        case 'activity':
          app().pushActivity(event.entry as ActivityEntry)
          break
        case 'approval':
          app().pushApproval(event.request as ApprovalRequest)
          break
        case 'approval:resolved':
          app().dropApproval(event.id)
          break
        case 'notification': {
          const n = event.notification as AkanshaNotification
          app().pushNotification(n)
          if (n.category === 'ERROR' || n.category === 'SECURITY') {
            app().toast({ kind: 'bad', title: n.title, body: n.body })
          }
          break
        }
        case 'navigate':
          if (event.page === 'palette') app().setPalette(true)
          else if (PAGES.has(event.page)) app().go(event.page as Page)
          break
        default:
          break
      }
    })
  }, [])
}
