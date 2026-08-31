import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { id, truncate } from '../core/util'
import { audit } from '../core/audit'
import { classifyCommand } from './command-validator'
import { authorize } from './guard'
import { readablePath } from './path-guard'
import { cancelRun, runPowerShell } from './shell'
import type { TerminalResult } from '../../shared/api'

const MAX_TIMEOUT = 10 * 60_000

function resolveCwd(cwd?: string): string {
  if (!cwd) return homedir()
  const abs = readablePath(cwd)
  if (!statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder.`)
  return abs
}

export const terminal = {
  classify: classifyCommand,

  /**
   * Runs a PowerShell command after classification and (when needed) explicit
   * approval. Output streams to the UI as it arrives, the process tree is killed
   * on timeout, and both the command and its exit code are audited.
   */
  async execute(command: string, cwd?: string, timeoutMs?: number): Promise<TerminalResult> {
    const cmd = String(command ?? '').trim()
    const verdict = classifyCommand(cmd)
    if (verdict.level === 'BLOCKED') {
      audit({
        kind: 'permission',
        label: 'Blocked command',
        detail: `${truncate(cmd, 300)} -- ${verdict.reason}`,
        ok: false
      })
      throw new Error(
        `Akansha will not run that command because it ${verdict.reason}. Run it yourself in a terminal if you are certain.`
      )
    }

    await authorize({
      tool: 'terminal.execute',
      declared: verdict.level,
      summary: `Run in PowerShell: ${truncate(cmd, 400)}`,
      reason: `This command ${verdict.reason}.`,
      input: { command: cmd, cwd: cwd ?? homedir() }
    })

    const execId = id()
    const workingDir = resolveCwd(cwd)
    const timeout = Math.min(Math.max(Number(timeoutMs) || 60_000, 1000), MAX_TIMEOUT)
    const started = Date.now()

    bus.emitToUi({ type: 'terminal:output', execId, chunk: `> ${cmd}\n` })
    const res = await runPowerShell(cmd, {
      cwd: workingDir,
      timeoutMs: timeout,
      execId,
      onChunk: (chunk) => bus.emitToUi({ type: 'terminal:output', execId, chunk })
    })

    if (res.timedOut) {
      bus.emitToUi({
        type: 'terminal:output',
        execId,
        chunk: `\n[Akansha] Timed out after ${timeout} ms; the process tree was terminated.\n`
      })
    }
    audit({
      kind: 'tool',
      label: `PowerShell (${verdict.level.toLowerCase()})`,
      detail: `${truncate(cmd, 300)}\nexit=${res.exitCode}${res.timedOut ? ' timedOut' : ''}`,
      ok: res.exitCode === 0 && !res.timedOut,
      durationMs: Date.now() - started
    })
    logger.info('terminal.execute', { level: verdict.level, exitCode: res.exitCode, timedOut: res.timedOut })
    return res
  },

  cancel(execId: string): boolean {
    const stopped = cancelRun(execId)
    if (stopped) {
      bus.emitToUi({ type: 'terminal:output', execId, chunk: '\n[Akansha] Cancelled.\n' })
      audit({ kind: 'tool', label: 'Cancelled command', ok: true })
    }
    return stopped
  }
}
