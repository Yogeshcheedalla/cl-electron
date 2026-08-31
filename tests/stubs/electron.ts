/**
 * Minimal stand-in for the parts of `electron` the services touch at import
 * time. Nothing here pretends to work: a test that needs real Electron
 * behaviour would have to run under Electron itself.
 */

export const app = {
  getPath: (name: string) => `C:\\tmp\\akansha-test\\${name}`,
  getVersion: () => '0.0.0-test',
  getName: () => 'akansha',
  isPackaged: false,
  on: () => app,
  whenReady: async () => undefined,
  quit: () => undefined,
  setAppUserModelId: () => undefined,
  setLoginItemSettings: () => undefined,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  requestSingleInstanceLock: () => true
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static fromWebContents(): BrowserWindow | null {
    return null
  }
  webContents = { send: () => undefined }
  isDestroyed = () => true
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (buffer: Buffer) => buffer.toString('utf8')
}

export const clipboard = {
  readText: async () => '',
  writeText: async () => undefined,
  clear: () => undefined
}

export class Notification {
  static isSupported = () => false
  show(): void {}
  on(): this {
    return this
  }
}

export const dialog = {
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] })
}

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => '',
  showItemInFolder: () => undefined
}

export type StubIpcHandler = (event: unknown, ...args: unknown[]) => unknown

/**
 * Registered handlers, keyed by channel. Real Electron keeps these inside the
 * main process; recording them here is what lets `ipc-fuzz.test.ts` call a
 * channel the same way the renderer would, without an Electron process.
 */
export const ipcHandlers = new Map<string, StubIpcHandler>()

export const ipcMain = {
  handle: (channel: string, fn: StubIpcHandler) => {
    ipcHandlers.set(channel, fn)
  },
  removeHandler: (channel: string) => {
    ipcHandlers.delete(channel)
  }
}
export const globalShortcut = { register: () => false, unregisterAll: () => undefined }
export const powerMonitor = { on: () => undefined }
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) }
export const nativeTheme = { shouldUseDarkColors: true }
export const desktopCapturer = { getSources: async () => [] }
export const screen = { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) }
export const Menu = { buildFromTemplate: () => ({}) }
export class Tray {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): this {
    return this
  }
}

export default { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell }
