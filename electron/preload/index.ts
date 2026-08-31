import { contextBridge, ipcRenderer } from 'electron'
import { API_SHAPE, EVENT_CHANNEL, type AkanshaEvent } from '../../shared/ipc'

/**
 * The renderer gets exactly these `ns:method` invoke channels and one read-only
 * event stream. No raw ipcRenderer, no Node built-ins, no dynamic channels.
 */
const api: Record<string, unknown> = {}

for (const [ns, methods] of Object.entries(API_SHAPE)) {
  const group: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods as readonly string[]) {
    const channel = `${ns}:${method}`
    group[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  }
  api[ns] = group
}

api.onEvent = (listener: (event: AkanshaEvent) => void) => {
  const handler = (_e: unknown, payload: AkanshaEvent) => listener(payload)
  ipcRenderer.on(EVENT_CHANNEL, handler)
  return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler)
}

contextBridge.exposeInMainWorld('akansha', api)
