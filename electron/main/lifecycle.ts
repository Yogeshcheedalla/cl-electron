import { app, type RenderProcessGoneDetails } from 'electron'
import { audit } from '../core/audit'
import { logger } from '../core/logger'
import { describeError } from '../core/util'
import { closeDatabase } from '../db/db'
import { approvals } from '../services/approvals'
import { stopClipboardWatcher } from '../services/clipboard'
import { notify } from '../services/notify'
import { stopScheduler } from '../services/scheduler'
import { destroyTray } from './tray'
import { unregisterShortcuts } from './shortcuts'
import { createMainWindow, mainWindow, setQuitting } from './windows'

const MAX_RECOVERIES = 3
let recoveries = 0
let shuttingDown = false

/**
 * Crash handling is honest: the renderer is rebuilt at most three times and the
 * user is told each time. A main-process exception is logged and surfaced rather
 * than swallowed, because a silent half-broken assistant is worse than a visible
 * error.
 */
export function installCrashHandlers() {
  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught', { message: error.message, stack: error.stack?.slice(0, 800) })
    audit({ kind: 'error', label: 'Unhandled error in Akansha', detail: error.message, ok: false })
    notify({ category: 'ERROR', title: 'Akansha hit an internal error', body: describeError(error) })
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandledRejection', { message: describeError(reason) })
    audit({ kind: 'error', label: 'Unhandled promise rejection', detail: describeError(reason), ok: false })
  })

  app.on('render-process-gone', (_event, _contents, details: RenderProcessGoneDetails) => {
    logger.error('window.renderGone', { reason: details.reason, exitCode: details.exitCode })
    audit({ kind: 'error', label: `Window stopped (${details.reason})`, ok: false })
    if (details.reason === 'clean-exit' || shuttingDown) return
    if (recoveries >= MAX_RECOVERIES) {
      notify({
        category: 'ERROR',
        title: 'Akansha window keeps crashing',
        body: `The interface crashed ${recoveries} times (${details.reason}). Restart Akansha, then send the log from Settings > Diagnostics.`
      })
      return
    }
    recoveries += 1
    notify({
      category: 'ERROR',
      title: 'Akansha reloaded its window',
      body: `The interface stopped (${details.reason}) and was restarted. Your conversations are stored, so nothing was lost.`
    })
    const win = mainWindow()
    if (win) win.reload()
    else createMainWindow()
  })

  app.on('child-process-gone', (_event, details) => {
    logger.warn('process.childGone', { type: details.type, reason: details.reason })
  })
}

/** Stops every background worker, denies queued approvals and closes SQLite. */
export function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  setQuitting(true)
  try {
    unregisterShortcuts()
    stopScheduler()
    stopClipboardWatcher()
    approvals.denyAll()
    destroyTray()
    closeDatabase()
    logger.info('app.shutdown')
  } catch (e) {
    logger.warn('app.shutdownProblem', { message: describeError(e) })
  }
}
