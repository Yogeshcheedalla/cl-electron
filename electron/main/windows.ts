import { app, BrowserWindow, screen, session, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../core/logger'
import { settings } from '../services/settings'

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const DEFAULT_BOUNDS: Bounds = { width: 1320, height: 860 }
const MIN_WIDTH = 960
const MIN_HEIGHT = 640

let win: BrowserWindow | null = null
let quitting = false
let saveTimer: NodeJS.Timeout | null = null

const stateFile = () => join(app.getPath('userData'), 'window.json')

/** Keeps a remembered position only while it still lands on a connected display. */
function onScreen(b: Bounds): boolean {
  if (b.x === undefined || b.y === undefined) return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x! < a.x + a.width && b.x! + b.width > a.x && b.y! < a.y + a.height && b.y! + b.height > a.y
  })
}

function readBounds(): Bounds {
  try {
    const path = stateFile()
    if (!existsSync(path)) return DEFAULT_BOUNDS
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Bounds
    const merged: Bounds = {
      width: Math.max(MIN_WIDTH, Math.round(saved.width) || DEFAULT_BOUNDS.width),
      height: Math.max(MIN_HEIGHT, Math.round(saved.height) || DEFAULT_BOUNDS.height),
      ...(saved.maximized ? { maximized: true } : {}),
      ...(saved.x !== undefined && saved.y !== undefined ? { x: Math.round(saved.x), y: Math.round(saved.y) } : {})
    }
    return onScreen(merged) ? merged : { ...merged, x: undefined, y: undefined }
  } catch (e) {
    logger.warn('window.stateUnreadable', { message: String(e) })
    return DEFAULT_BOUNDS
  }
}

function saveBoundsSoon() {
  if (!win || win.isDestroyed()) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const b = win.getNormalBounds()
    try {
      writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }, null, 2), 'utf8')
    } catch (e) {
      logger.warn('window.stateUnwritable', { message: String(e) })
    }
  }, 500)
}

/** External links open in the user's browser; the window itself never navigates away. */
function lockNavigation(target: BrowserWindow) {
  const openExternally = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    else logger.warn('window.blockedUrl', { url })
  }
  target.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  target.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (url.startsWith('file://') || (allowed && url.startsWith(allowed))) return
    event.preventDefault()
    openExternally(url)
  })
  target.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

/**
 * What the renderer is allowed to ask Chromium for. Electron grants every
 * permission by default, which is too generous for a window that can reach the
 * whole machine: only the microphone is allowed, and only while privacy mode is
 * off. The camera is refused outright -- Akansha has no feature that needs it, so
 * a request for it is either a bug or something worse. Screenshots go through
 * `desktopCapturer` in the main process and never touch this path.
 */
function allowPermission(permission: string, mediaTypes: string[]): boolean {
  if (permission === 'media') {
    if (mediaTypes.includes('video')) return false
    return !settings.get().privacy.privacyMode
  }
  return permission === 'clipboard-sanitized-write'
}

export function installPermissionPolicy() {
  const current = session.defaultSession
  current.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const media = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    const allowed = allowPermission(permission, media)
    if (!allowed) logger.warn('permission.denied', { permission, media })
    callback(allowed)
  })
  // The check handler answers `navigator.permissions.query` and the
  // `getUserMedia` pre-flight, so both have to agree or the microphone appears
  // available and then fails.
  current.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    const type = (details as { mediaType?: string }).mediaType
    return allowPermission(permission, type && type !== 'unknown' ? [type] : [])
  })
  logger.info('permission.policyInstalled', { allowed: ['media(audio, unless privacy mode)', 'clipboard write'] })
}

export function createMainWindow(): BrowserWindow {
  const bounds = readBounds()
  win = new BrowserWindow({
    width: bounds.width || DEFAULT_BOUNDS.width,
    height: bounds.height || DEFAULT_BOUNDS.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: true,
    frame: true,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#080b12',
    title: 'Akansha',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      // Chromium throttles timers and audio callbacks in a hidden window, which
      // would stall the wake listener the moment Akansha is minimised to the
      // tray. The renderer is otherwise idle, so nothing else is affected.
      backgroundThrottling: false
    }
  })

  win.center()
  if (bounds.maximized) {
    win.maximize()
  }
  win.show()
  win.focus()
  lockNavigation(win)

  const showWhenReady = () => {
    const hidden = settings.get().general.startMinimized || process.argv.includes('--minimized')
    if (hidden) {
      logger.info('window.startedHidden')
    } else if (win && !win.isDestroyed()) {
      win.show()
      win.setAlwaysOnTop(true)
      win.setAlwaysOnTop(false)
      win.focus()
      logger.info('window.shown')
    }
  }

  win.once('ready-to-show', showWhenReady)
  win.webContents.on('did-finish-load', () => {
    const hidden = settings.get().general.startMinimized || process.argv.includes('--minimized')
    if (!hidden && win && !win.isDestroyed()) {
      win.show()
      win.setAlwaysOnTop(true)
      win.setAlwaysOnTop(false)
      win.focus()
      logger.info('window.shownFromDidFinishLoad')
    }
  })

  win.on('resize', saveBoundsSoon)
  win.on('move', saveBoundsSoon)
  win.on('maximize', saveBoundsSoon)
  win.on('unmaximize', saveBoundsSoon)

  win.on('close', (event) => {
    if (quitting || !settings.get().general.minimizeToTray) return
    event.preventDefault()
    win?.hide()
  })

  win.on('closed', () => {
    win = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info('window.created', { dev: Boolean(devUrl) })
  return win
}

export const mainWindow = () => (win && !win.isDestroyed() ? win : null)

export function showMainWindow() {
  const target = mainWindow() ?? createMainWindow()
  if (target.isMinimized()) target.restore()
  if (!target.isVisible()) target.show()
  target.show()
  target.setAlwaysOnTop(true)
  target.focus()
  setTimeout(() => {
    if (target && !target.isDestroyed()) {
      target.setAlwaysOnTop(false)
    }
  }, 150)
}

/** Global-shortcut behaviour: focused window hides, anything else comes forward. */
export function toggleMainWindow() {
  const target = mainWindow()
  if (target && !target.isDestroyed() && target.isVisible() && target.isFocused()) {
    target.hide()
  } else {
    showMainWindow()
  }
}

export function setQuitting(value: boolean) {
  quitting = value
}
