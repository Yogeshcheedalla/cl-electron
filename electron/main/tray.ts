import { app, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { MOTTO, PRODUCT } from '../../shared/brand'
import { settings } from '../services/settings'
import { assertWakeAllowed } from '../services/voice'
import { showMainWindow, toggleMainWindow, mainWindow, setQuitting } from './windows'

let tray: Tray | null = null

/** Assets ship beside the app in development and under resources/ once packaged. */
export function assetPath(name: string): string {
  const candidates = [
    join(process.resourcesPath, 'assets', name),
    join(app.getAppPath(), 'assets', name),
    join(__dirname, '../../assets', name)
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[1]!
}

function navigate(page: string) {
  showMainWindow()
  bus.emitToUi({ type: 'navigate', page })
}

function buildMenu(): Menu {
  const privacy = settings.get().privacy
  const voice = settings.get().voice
  return Menu.buildFromTemplate([
    { label: 'Open Akansha', click: () => showMainWindow() },
    { label: 'New conversation', click: () => navigate('chat') },
    { type: 'separator' },
    { label: 'Dashboard', click: () => navigate('dashboard') },
    { label: 'Activity', click: () => navigate('activity') },
    { label: 'Approvals', click: () => navigate('approvals') },
    { label: 'Settings', click: () => navigate('settings') },
    { type: 'separator' },
    {
      // The kill switch for the open microphone. Reachable without opening the
      // window, which is the point: whatever is on screen, the tray can stop it.
      label: voice.wakeWordEnabled ? 'Listening for the wake word — click to stop' : 'Listen for the wake word',
      type: 'checkbox',
      checked: voice.wakeWordEnabled,
      click: (item) => void setWakeWord(item.checked)
    },
    {
      label: 'Allow screen capture',
      type: 'checkbox',
      checked: privacy.screenAccess,
      click: (item) => settings.update({ privacy: { ...privacy, screenAccess: item.checked } })
    },
    {
      label: 'Privacy mode (no clipboard or screen)',
      type: 'checkbox',
      checked: privacy.privacyMode,
      click: (item) => settings.update({ privacy: { ...privacy, privacyMode: item.checked } })
    },
    { type: 'separator' },
    { label: 'Quit Akansha', click: () => { setQuitting(true); app.quit() } }
  ])
}

/**
 * Turning it off always works. Turning it on runs the same checks the window
 * does, and refuses out loud rather than leaving a checkbox ticked next to a
 * microphone that is not open.
 */
async function setWakeWord(on: boolean) {
  const voice = settings.get().voice
  try {
    if (on) await assertWakeAllowed()
    settings.update({ voice: { ...voice, wakeWordEnabled: on } })
    logger.info(on ? 'voice.wakeArmed' : 'voice.wakeDisarmed', { from: 'tray' })
  } catch (e) {
    tray?.setContextMenu(buildMenu())
    flashTray('Akansha cannot listen continuously', e instanceof Error ? e.message : String(e))
    navigate('voice')
  }
}

function tooltip(): string {
  const listening = settings.get().voice.wakeWordEnabled
  return listening ? `${PRODUCT} — listening for the wake word` : `${PRODUCT} — ${MOTTO}`
}

export function createTray() {
  if (tray) return tray
  const image = nativeImage.createFromPath(assetPath('tray.png'))
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip(tooltip())
  tray.setContextMenu(buildMenu())
  tray.on('click', () => toggleMainWindow())
  tray.on('double-click', () => showMainWindow())

  // The menu shows live privacy and microphone state, so it is rebuilt whenever
  // settings change -- including from the window, so the two never disagree.
  bus.on('state', (event: { state?: string }) => {
    if (event?.state !== 'settings-changed') return
    tray?.setContextMenu(buildMenu())
    tray?.setToolTip(tooltip())
  })

  logger.info('tray.created', { icon: assetPath('tray.png'), fallback: image.isEmpty() })
  return tray
}

export function destroyTray() {
  tray?.destroy()
  tray = null
}

/** Used by the crash handler to tell the user the window is coming back. */
export function flashTray(title: string, body: string) {
  tray?.displayBalloon?.({ title, content: body })
  if (!mainWindow()) showMainWindow()
}
