import { Notification } from 'electron'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { notifications } from '../db/log.repo'
import { settings } from './settings'
import type { AkanshaNotification } from '../../shared/records'

const IMPORTANCE: Record<AkanshaNotification['category'], number> = {
  ERROR: 3,
  SECURITY: 3,
  TASK: 2,
  AUTOMATION: 2,
  SYSTEM: 1,
  AI: 1
}

const THRESHOLD = { ALL: 0, IMPORTANT: 2, CRITICAL: 3, QUIET: 99 } as const

/** Stores the notification, pushes it to the UI, and raises an OS toast if allowed. */
export function notify(input: {
  category: AkanshaNotification['category']
  title: string
  body: string
  /** Skip the Windows toast even when the level allows it (used for chat replies). */
  silent?: boolean
}): AkanshaNotification {
  const entry = notifications.add({ category: input.category, title: input.title, body: input.body })
  bus.emitToUi({ type: 'notification', notification: entry })

  const level = settings.get().general.notifications
  const wanted = IMPORTANCE[input.category] >= THRESHOLD[level]
  if (wanted && !input.silent && Notification.isSupported()) {
    try {
      new Notification({ title: input.title, body: input.body, silent: false }).show()
    } catch (e) {
      logger.warn('notify.toastFailed', { message: String(e) })
    }
  }
  return entry
}
