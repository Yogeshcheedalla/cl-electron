import { globalShortcut } from 'electron'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { notify } from '../services/notify'
import { settings } from '../services/settings'
import { showMainWindow, toggleMainWindow } from './windows'

let registered: string[] = []

function bind(accelerator: string, label: string, action: () => void): boolean {
  if (!accelerator?.trim()) return false
  try {
    const ok = globalShortcut.register(accelerator, action)
    if (ok) registered.push(accelerator)
    else {
      logger.warn('shortcuts.taken', { accelerator, label })
      notify({
        category: 'SYSTEM',
        title: 'Shortcut unavailable',
        body: `Windows or another app already owns ${accelerator}, so the ${label} shortcut is inactive. Pick a different one in Settings > Keyboard.`,
        silent: true
      })
    }
    return ok
  } catch (e) {
    logger.warn('shortcuts.invalid', { accelerator, message: String(e) })
    return false
  }
}

/**
 * Global hotkeys for Akansha:
 * Toggles the main window so the user can summon or dismiss Akansha from anywhere.
 */
export function registerShortcuts() {
  unregisterShortcuts()
  const keys = settings.get().keyboard

  const handleGlobalToggle = () => {
    toggleMainWindow()
    bus.emitToUi({ type: 'voice:command', action: 'start' })
  }

  // Primary configured shortcut
  bind(keys.globalShortcut, 'talk to Akansha', handleGlobalToggle)

  // Secondary fallback shortcuts if Control+Space is intercepted by Windows IME
  if (keys.globalShortcut === 'Control+Space') {
    bind('Control+Shift+Space', 'talk to Akansha (fallback)', handleGlobalToggle)
    bind('Alt+Space', 'talk to Akansha (fallback)', handleGlobalToggle)
  }

  bind(keys.commandPalette, 'command palette', () => {
    showMainWindow()
    bus.emitToUi({ type: 'navigate', page: 'palette' })
  })
  logger.info('shortcuts.registered', { registered })
}

export function unregisterShortcuts() {
  for (const accelerator of registered) globalShortcut.unregister(accelerator)
  registered = []
}

export const activeShortcuts = () => [...registered]
