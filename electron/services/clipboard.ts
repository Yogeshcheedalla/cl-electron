import { clipboard as electronClipboard } from 'electron'
import { logger } from '../core/logger'
import { now, truncate } from '../core/util'
import { settings } from './settings'

/**
 * Clipboard history lives in memory only and is never written to the database or
 * sent to a provider on its own -- the AI sees clipboard text only when the user
 * asks for it, and only through the explicit clipboard tool.
 *
 * Electron's clipboard module is promise-based, so every read and write here is
 * async even though the values are local.
 */
const MAX_HISTORY = 50
const history: { ts: number; text: string }[] = []
let timer: NodeJS.Timeout | null = null
let last = ''

function assertAllowed() {
  const { clipboardAccess, privacyMode } = settings.get().privacy
  if (privacyMode) throw new Error('Privacy mode is on, so Akansha is not reading the clipboard.')
  if (!clipboardAccess) {
    throw new Error('Clipboard access is off. Enable it in Settings > Privacy to let Akansha read or write the clipboard.')
  }
}

async function tick() {
  const { clipboardAccess, privacyMode } = settings.get().privacy
  if (!clipboardAccess || privacyMode) return
  let text: string
  try {
    text = await electronClipboard.readText()
  } catch (e) {
    logger.warn('clipboard.readFailed', { message: String(e) })
    return
  }
  if (!text || text === last) return
  last = text
  history.unshift({ ts: now(), text: truncate(text, 4000) })
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
}

/** Polling is the only way to observe clipboard changes on Windows without a hook. */
export function startClipboardWatcher() {
  if (timer) return
  timer = setInterval(() => void tick(), 2500)
  timer.unref?.()
}

export function stopClipboardWatcher() {
  if (timer) clearInterval(timer)
  timer = null
}

export const clipboardService = {
  async read(): Promise<{ text: string }> {
    assertAllowed()
    return { text: await electronClipboard.readText() }
  },

  async write(text: string): Promise<null> {
    assertAllowed()
    const value = String(text ?? '')
    await electronClipboard.writeText(value)
    last = value
    return null
  },

  clear(): null {
    assertAllowed()
    electronClipboard.clear()
    history.length = 0
    last = ''
    return null
  },

  history(): { ts: number; text: string }[] {
    assertAllowed()
    return [...history]
  }
}
