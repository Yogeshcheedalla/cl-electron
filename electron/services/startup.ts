import { app } from 'electron'
import { logger } from '../core/logger'
import { settings } from './settings'

/**
 * Windows startup is only touched when the user turns the setting on, and the
 * login item is written with `--minimized` so Akansha never steals focus at boot.
 *
 * A launch at login arms the microphone only if the user had already switched
 * continuous listening on themselves; the setting is never turned on here, and
 * when it is on the on-screen badge and the tray both say so from the first
 * moment. Nothing about the microphone is decided by this file.
 */
export function syncLoginItem() {
  const { startWithWindows, startMinimized } = settings.get().general
  try {
    // `openAsHidden` is macOS-only, so on Windows the `--minimized` argument is
    // what actually keeps the window out of the way at boot.
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      args: startMinimized ? ['--minimized'] : []
    })
    logger.info('startup.loginItem', { openAtLogin: startWithWindows, minimized: startMinimized })
  } catch (e) {
    logger.warn('startup.loginItemFailed', { message: String(e) })
  }
}

export function loginItemEnabled(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}
