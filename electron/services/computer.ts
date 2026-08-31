import { desktopCapturer, screen } from 'electron'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { notify } from './notify'
import { psJson } from './shell'
import { settings } from './settings'

/**
 * Screen access is off by default. Every capture emits a `screen-capture` state
 * event and writes a notification, so a screenshot can never happen invisibly.
 *
 * ponytail: capture only, no synthetic mouse/keyboard input. Driving other apps
 * needs SendInput via native interop, which is both the riskiest surface here and
 * the least reliable; Akansha focuses windows and runs real commands instead of
 * pretending to click. Add a signed native helper if true GUI automation is
 * required.
 */
export const computer = {
  async windows(): Promise<{ title: string; processName: string; pid: number }[]> {
    const rows =
      (await psJson<{ MainWindowTitle: string; ProcessName: string; Id: number }[]>(
        'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object MainWindowTitle,ProcessName,Id | ConvertTo-Json -AsArray -Compress'
      )) ?? []
    return rows.map((r) => ({
      title: r.MainWindowTitle,
      processName: r.ProcessName,
      pid: Number(r.Id)
    }))
  },

  async screenshot(): Promise<{ base64: string; width: number; height: number }> {
    if (!settings.get().privacy.screenAccess) {
      throw new Error(
        'Screen access is off. Enable it in Settings > Privacy before asking Akansha to look at your screen.'
      )
    }
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const scale = Math.min(1, 1600 / Math.max(width, height))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
    })
    const source = sources[0]
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('Windows returned an empty screen capture.')
    }

    bus.emitToUi({ type: 'state', state: 'screen-capture' })
    notify({
      category: 'SECURITY',
      title: 'Screen captured',
      body: 'Akansha took a screenshot of your primary display.'
    })
    logger.info('computer.screenshot', { width, height })

    const size = source.thumbnail.getSize()
    return {
      base64: source.thumbnail.toPNG().toString('base64'),
      width: size.width,
      height: size.height
    }
  },

  capabilities(): { screen: boolean; input: boolean; detail: string } {
    const screenAccess = settings.get().privacy.screenAccess
    return {
      screen: screenAccess,
      input: false,
      detail: screenAccess
        ? 'Screen capture is enabled. Akansha can read the screen and list windows, focus or close applications, and run commands. It cannot move the mouse or synthesise keystrokes.'
        : 'Screen capture is disabled in Settings > Privacy. Akansha can still list, focus and close windows. It cannot move the mouse or synthesise keystrokes.'
    }
  }
}
