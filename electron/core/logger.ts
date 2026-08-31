import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './util'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 2 * 1024 * 1024

let logPath = ''
let writes = 0

export function initLogger(userDataDir: string) {
  const dir = join(userDataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  logPath = join(dir, 'akansha.log')
  adoptLegacyLog(dir)
  rotateIfNeeded()
  log('info', 'logger.ready', { logPath })
}

/**
 * The log was `jarvis.log` before the rename. Carry it forward once so the
 * history is not orphaned; if both names exist the current one wins and the old
 * file is left alone rather than clobbered.
 */
function adoptLegacyLog(dir: string) {
  try {
    const legacy = join(dir, 'jarvis.log')
    if (existsSync(legacy) && !existsSync(logPath)) renameSync(legacy, logPath)
  } catch {
    /* the log must never be the reason a launch fails */
  }
}

export const logFilePath = () => logPath

function rotateIfNeeded() {
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`)
    }
  } catch {
    /* rotation is best effort */
  }
}

/** Structured JSONL log. Secrets are stripped from `data` before writing. */
export function log(level: Level, event: string, data?: unknown) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(data === undefined ? {} : { data: redact(data) })
  })
  if (level === 'error') console.error(line)
  else console.log(line)
  if (!logPath) return
  try {
    // Checking the file size on every write would double the syscalls.
    if (++writes % 200 === 0) rotateIfNeeded()
    appendFileSync(logPath, `${line}\n`, 'utf8')
  } catch {
    /* never let logging break a feature */
  }
}

export const logger = {
  debug: (event: string, data?: unknown) => log('debug', event, data),
  info: (event: string, data?: unknown) => log('info', event, data),
  warn: (event: string, data?: unknown) => log('warn', event, data),
  error: (event: string, data?: unknown) => log('error', event, data)
}

export function readLog(lines = 400): { text: string; path: string } {
  if (!logPath || !existsSync(logPath)) return { text: '', path: logPath }
  const all = readFileSync(logPath, 'utf8').split('\n')
  return { text: all.slice(-lines).join('\n'), path: logPath }
}
