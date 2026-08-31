import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import { EVENT_CHANNEL, type AkanshaEvent } from '../../shared/ipc'

/**
 * Application event bus. Internal services subscribe with `bus.on`; anything
 * emitted through `emit` is also pushed to every open renderer so the dashboard
 * stays live without polling.
 */
class Bus extends EventEmitter {
  emitToUi(event: AkanshaEvent) {
    this.emit(event.type, event)
    this.emit('*', event)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event)
    }
  }
}

export const bus = new Bus()
bus.setMaxListeners(64)
