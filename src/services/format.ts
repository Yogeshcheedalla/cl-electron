/** Formatting helpers shared by the dashboard, files, system and usage screens. */

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const value = n / 1024 ** i
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-'
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function ago(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 45_000) return 'just now'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString()
}

export const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const stamp = (ms: number): string => new Date(ms).toLocaleString()

export function money(usd: number): string {
  if (!usd) return '$0.00'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export const percent = (n: number): string => `${Math.round(n)}%`

/** Turns a due timestamp into the value an `<input type="datetime-local">` wants. */
export function toLocalInput(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export const fromLocalInput = (value: string): number | undefined =>
  value ? new Date(value).getTime() : undefined
