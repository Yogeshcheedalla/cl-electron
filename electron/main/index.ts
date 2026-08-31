import { app } from 'electron'
import { initCryptoStore } from '../core/crypto'
import { initLogger, logger } from '../core/logger'
import { describeError } from '../core/util'
import { startOllamaWatch } from '../ai/ollama'
import { providerBaseUrl } from '../ai/providers'
import { initDatabase } from '../db/db'
import { activity } from '../db/log.repo'
import { memories } from '../db/state.repo'
import { startClipboardWatcher } from '../services/clipboard'
import { notify } from '../services/notify'
import { startScheduler } from '../services/scheduler'
import { initSecrets } from '../services/secrets'
import { initSettings, settings } from '../services/settings'
import { initSkills } from '../services/skills'
import { syncLoginItem } from '../services/startup'
import { updates } from '../services/updates'
import { assertHandlerCoverage, registerIpc } from './ipc'
import { installCrashHandlers, shutdown } from './lifecycle'
import { registerShortcuts } from './shortcuts'
import { createTray } from './tray'
import { createMainWindow, installPermissionPolicy, mainWindow, showMainWindow } from './windows'
import { adoptLegacyUserData } from './userdata'

/**
 * Startup order matters: logging first so every later failure is recorded, then
 * settings and secrets (both need the userData path), then the database, then
 * the parts that read all three. A second launch hands its arguments to the
 * running instance instead of opening a second window over the same SQLite file.
 */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('com.akansha.assistant')
  app.on('second-instance', () => showMainWindow())
  void start()
}

async function start() {
  const userData = app.getPath('userData')
  // Before the logger: the rebrand moved this folder, and an existing install's
  // keys, memories and settings are carried forward once so the rename does not
  // read as data loss.
  const adopted = adoptLegacyUserData()
  initLogger(userData)
  installCrashHandlers()
  logger.info('app.starting', { version: app.getVersion(), electron: process.versions.electron })
  if (adopted) logger.info('app.adoptedUserData', { from: adopted.from, files: adopted.files })

  initSettings(userData)
  initSecrets(userData)
  // Before the database, so the memories repository can seal rows as it reads them.
  initCryptoStore(userData)
  initDatabase(userData)
  const sealed = memories.sealPlaintext()
  if (sealed) logger.info('crypto.sealedExisting', { memories: sealed })
  initSkills()

  registerIpc()
  const missing = assertHandlerCoverage()

  await app.whenReady()

  // Before any window exists, so no page can race the policy.
  installPermissionPolicy()
  createMainWindow()
  createTray()
  registerShortcuts()
  startScheduler()

  const cfg = settings.get()
  if (cfg.privacy.clipboardAccess && !cfg.privacy.privacyMode) startClipboardWatcher()
  syncLoginItem()
  // The local model runner is the default provider, so its state is polled from
  // the start: a truthful "not running" is what lets a request fall back to the
  // cloud without first waiting on a refused connection.
  startOllamaWatch(() => ({
    baseUrl: providerBaseUrl('ollama'),
    selected: settings.get().ai.routing.LOCAL.model
  }))
  activity.prune(Date.now() - Math.max(1, cfg.privacy.logRetentionDays) * 86_400_000)

  if (missing.length) {
    // A missing handler is a build defect: say so instead of failing per click.
    notify({
      category: 'ERROR',
      title: 'Akansha started with missing features',
      body: `${missing.length} internal channels have no handler (${missing.slice(0, 3).join(', ')}). Those screens will report errors.`
    })
  }
  logger.info('app.ready', { handlers: missing.length === 0 })
  // Last, and only when the user asked for it: nothing is downloaded on its own.
  void updates.checkOnStart()
}

// Closing the last window never quits on Windows when the tray is enabled; the
// tray menu and the taskbar keep Akansha reachable.
app.on('window-all-closed', () => {
  if (!settings.get().general.minimizeToTray) app.quit()
})

app.on('activate', () => {
  if (!mainWindow()) createMainWindow()
})

app.on('before-quit', () => shutdown())

process.on('exit', () => shutdown())

process.on('SIGINT', () => {
  logger.info('app.sigint')
  app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  // Defence in depth: even if a future window forgets lockNavigation, no page
  // inside Akansha may open a second Electron window on its own.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('render-process-gone', (_e, details) => {
    logger.warn('webContents.gone', { reason: details.reason, url: contents.getURL().slice(0, 200) })
  })
})

process.on('warning', (warning) => {
  logger.debug('process.warning', { name: warning.name, message: describeError(warning) })
})
