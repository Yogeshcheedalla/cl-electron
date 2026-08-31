import { spawn } from 'node:child_process'
import { logger } from '../core/logger'

/**
 * The only place Akansha starts a process. Everything else (system info, apps,
 * terminal, git) goes through here so timeout, tree-kill, output caps and
 * auditing exist exactly once.
 *
 * Arguments are always passed as an argv array with `shell: false`, so a path or
 * a query can never break out into a second command. PowerShell scripts are the
 * one exception by design -- there the script *is* the payload, which is why
 * command-validator.ts classifies it and approvals.ts gates it first.
 */
export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** Streams stdout/stderr as it arrives (used by the terminal panel). */
  onChunk?: (chunk: string) => void
  /** Lets the renderer cancel a long-running execution. */
  execId?: string
  input?: string
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

const MAX_OUTPUT = 1_000_000
const DEFAULT_TIMEOUT = 60_000
const running = new Map<string, number>()

const PS = 'powershell.exe'
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Hard-kills a process tree; a plain SIGKILL leaves PowerShell children alive. */
function killTree(pid: number) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).unref()
  } catch (e) {
    logger.warn('shell.killFailed', { pid, message: String(e) })
  }
}

export function runExe(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  return new Promise<RunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(file, args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false
    })

    if (opts.execId && child.pid) running.set(opts.execId, child.pid)

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
      child.kill('SIGKILL')
    }, timeoutMs)

    const collect = (target: 'out' | 'err') => (buf: Buffer) => {
      const text = buf.toString('utf8')
      if (target === 'out') stdout = (stdout + text).slice(0, MAX_OUTPUT)
      else stderr = (stderr + text).slice(0, MAX_OUTPUT)
      opts.onChunk?.(text)
    }

    child.stdout?.on('data', collect('out'))
    child.stderr?.on('data', collect('err'))

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }

    const done = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.execId) running.delete(opts.execId)
      resolve({ stdout, stderr, exitCode, timedOut })
    }

    child.on('error', (e) => {
      stderr = `${stderr}${describeSpawnError(file, e)}`
      done(null)
    })
    child.on('close', (code) => done(code))
  })
}

function describeSpawnError(file: string, e: NodeJS.ErrnoException) {
  return e.code === 'ENOENT' ? `${file} was not found on this system.` : e.message
}

export function runPowerShell(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return runExe(PS, [...PS_FLAGS, script], opts)
}

/** Escapes a value for embedding inside a single-quoted PowerShell literal. */
export const psQuote = (value: string) => `'${String(value).replace(/'/g, "''")}'`

/**
 * Runs a script that ends in `ConvertTo-Json` and parses the result. PowerShell
 * emits a bare object for one item and an array for many, so callers that want a
 * list should append `-AsArray` or wrap with `@(...)`.
 */
export async function psJson<T>(script: string, opts: RunOptions = {}): Promise<T | null> {
  const res = await runPowerShell(script, opts)
  const text = res.stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    logger.warn('shell.badJson', { script: script.slice(0, 120), stderr: res.stderr.slice(0, 200) })
    return null
  }
}

export function cancelRun(execId: string): boolean {
  const pid = running.get(execId)
  if (!pid) return false
  killTree(pid)
  running.delete(execId)
  return true
}

export const activeRuns = () => [...running.keys()]
