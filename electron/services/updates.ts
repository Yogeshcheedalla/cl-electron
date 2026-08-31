import { app } from 'electron'
import { logger } from '../core/logger'
import { describeError } from '../core/util'
import { notify } from './notify'
import { settings } from './settings'
import type { UpdateState } from '../../shared/types'

/**
 * Auto-update over a generic HTTPS feed -- a directory holding the `latest.yml`
 * and installer that `npm run package` produces. Nothing is contacted until the
 * user turns updates on and supplies a URL, and nothing is downloaded or
 * installed without an explicit action: `autoDownload` and
 * `autoInstallOnAppQuit` are both off, and `install` goes through the approval
 * gate in the IPC layer because it quits the app and runs an installer.
 *
 * ponytail: `electron-updater` is the one dependency here that is not worth
 * rewriting. Update feeds mean parsing `latest.yml`, matching SHA-512 block
 * maps, differential downloads and handing a signed NSIS installer to Windows --
 * the failure mode of getting that wrong is a broken install, not a missing
 * feature. It is imported lazily so neither the tests nor cold start pay for it.
 */

let status: UpdateState['status'] = 'idle'
let availableVersion: string | undefined
let releaseNotes: string | undefined
let downloadPercent: number | undefined
let message: string | undefined
let checkedMs: number | undefined
let wired = false

type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<{ updateInfo?: { version?: string; releaseNotes?: unknown } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, forceRunAfter?: boolean): void
  on(event: string, listener: (payload: never) => void): unknown
}

const notesOf = (raw: unknown): string | undefined => {
  if (typeof raw === 'string') return raw.replace(/<[^>]+>/g, '').trim().slice(0, 2000) || undefined
  if (Array.isArray(raw)) {
    const joined = raw
      .map((n) => (typeof n === 'object' && n && 'note' in n ? String((n as { note?: string }).note ?? '') : String(n)))
      .join('\n')
    return notesOf(joined)
  }
  return undefined
}

/** Validated feed URL, or null when updates are off or misconfigured. */
function feedUrl(): string | null {
  const { enabled, feedUrl: raw } = settings.get().updates
  if (!enabled) return null
  const url = raw.trim()
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return null
    return url.replace(/\/$/, '')
  } catch {
    return null
  }
}

function snapshot(): UpdateState {
  const url = settings.get().updates.feedUrl.trim()
  return {
    supported: app.isPackaged,
    configured: feedUrl() !== null,
    enabled: settings.get().updates.enabled,
    currentVersion: app.getVersion(),
    feedUrl: url,
    status,
    ...(availableVersion ? { availableVersion } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(downloadPercent !== undefined ? { downloadPercent } : {}),
    ...(message ? { message } : {}),
    ...(checkedMs ? { checkedMs } : {})
  }
}

/** Loads electron-updater on first use and points it at the configured feed. */
async function updater(): Promise<Updater> {
  const url = feedUrl()
  if (!url) {
    throw new Error(
      'No update feed is configured. Turn updates on and paste an https URL in Settings > Updates.'
    )
  }
  if (!app.isPackaged) {
    throw new Error('Updates only work in an installed build; a development run has no installer to replace.')
  }
  const mod = (await import('electron-updater')) as unknown as { autoUpdater: Updater }
  const auto = mod.autoUpdater
  auto.autoDownload = false
  auto.autoInstallOnAppQuit = false
  if (!wired) {
    wired = true
    auto.on('download-progress', (p: never) => {
      downloadPercent = Math.round((p as { percent?: number }).percent ?? 0)
    })
    auto.on('error', (e: never) => {
      status = 'error'
      message = describeError(e)
      logger.warn('updates.error', { message })
    })
  }
  auto.setFeedURL({ provider: 'generic', url })
  return auto
}

export const updates = {
  state: (): UpdateState => snapshot(),

  async check(): Promise<UpdateState> {
    const auto = await updater()
    status = 'checking'
    message = undefined
    try {
      const result = await auto.checkForUpdates()
      checkedMs = Date.now()
      const found = result?.updateInfo?.version
      if (found && found !== app.getVersion()) {
        availableVersion = found
        releaseNotes = notesOf(result?.updateInfo?.releaseNotes)
        status = 'available'
        message = `Version ${found} is available.`
        notify({
          category: 'SYSTEM',
          title: `Akansha ${found} is available`,
          body: 'Open Settings > Updates to download it.',
          silent: true
        })
      } else {
        availableVersion = undefined
        releaseNotes = undefined
        status = 'idle'
        message = `No update found; ${app.getVersion()} is current.`
      }
      logger.info('updates.checked', { status, availableVersion })
    } catch (e) {
      status = 'error'
      message = describeError(e)
      logger.warn('updates.checkFailed', { message })
    }
    return snapshot()
  },

  async download(): Promise<UpdateState> {
    if (status !== 'available') {
      throw new Error('There is no downloaded-and-waiting update. Check for updates first.')
    }
    const auto = await updater()
    status = 'downloading'
    downloadPercent = 0
    try {
      await auto.downloadUpdate()
      status = 'downloaded'
      downloadPercent = 100
      message = `Version ${availableVersion ?? 'unknown'} is downloaded and ready to install.`
      notify({
        category: 'SYSTEM',
        title: 'Update ready to install',
        body: 'Akansha will restart when you install it.',
        silent: true
      })
    } catch (e) {
      status = 'error'
      message = describeError(e)
      logger.warn('updates.downloadFailed', { message })
    }
    return snapshot()
  },

  /**
   * Quits and runs the installer. The caller is responsible for approval; this
   * only refuses when there is nothing on disk to install.
   */
  async install(): Promise<UpdateState> {
    if (status !== 'downloaded') {
      throw new Error('No update has been downloaded yet, so there is nothing to install.')
    }
    const auto = await updater()
    logger.info('updates.installing', { version: availableVersion })
    // Give the reply time to reach the renderer before Electron tears down.
    setTimeout(() => auto.quitAndInstall(false, true), 400)
    return snapshot()
  },

  /** Called once at startup when the user asked for a check on launch. */
  async checkOnStart(): Promise<void> {
    const cfg = settings.get().updates
    if (!cfg.enabled || !cfg.checkOnStart || !app.isPackaged || !feedUrl()) return
    await updates.check().catch((e: unknown) => {
      logger.warn('updates.startupCheckFailed', { message: describeError(e) })
    })
  }
}
