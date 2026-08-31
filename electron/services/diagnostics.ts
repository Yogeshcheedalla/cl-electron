import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { get } from '../db/db'
import { logger, readLog, logFilePath } from '../core/logger'
import { activity } from '../db/log.repo'
import { knowledge } from '../db/knowledge.repo'
import { providerIds, provider } from '../ai/providers'
import { secrets } from './secrets'
import { settings } from './settings'
import { now } from '../core/util'
import type { HealthCheck } from '../../shared/records'

const MB = (n: number) => `${(n / 1024 ** 2).toFixed(0)} MB`

/**
 * Checks report what Akansha can actually verify right now. The only repairs done
 * here are safe and idempotent: recreating a missing data directory and pruning
 * activity past the retention window.
 */
export const diagnostics = {
  run(): HealthCheck[] {
    const checks: HealthCheck[] = []
    const push = (name: string, status: HealthCheck['status'], detail: string) =>
      checks.push({ name, status, detail })

    // Database
    try {
      const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')
      push('Database', 'HEALTHY', `SQLite is responding (${row?.n ?? 0} conversations stored).`)
    } catch (e) {
      push('Database', 'ERROR', `SQLite query failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Secret storage
    push(
      'Secret storage',
      secrets.encryptionAvailable() ? 'HEALTHY' : 'WARNING',
      secrets.encryptionAvailable()
        ? 'API keys are encrypted with Windows DPAPI via Electron safeStorage.'
        : 'OS encryption is unavailable, so saved keys are stored as plain text in the app data folder.'
    )

    // Providers
    const ready = providerIds.filter((id) => !provider(id).unavailable())
    push(
      'AI providers',
      ready.length ? 'HEALTHY' : 'WARNING',
      ready.length
        ? `Configured: ${ready.join(', ')}. Active: ${settings.get().ai.provider}.`
        : 'No provider is usable yet. Add an API key in Settings > AI Providers, or run Ollama locally.'
    )

    // Write roots
    const missing = settings.get().automation.allowedRoots.filter((r) => !existsSync(r))
    push(
      'Write roots',
      missing.length ? 'WARNING' : 'HEALTHY',
      missing.length
        ? `These allowed write roots do not exist: ${missing.join(', ')}`
        : `Writes are limited to ${settings.get().automation.allowedRoots.join(', ')}`
    )

    // Data directory (repaired if missing)
    const userData = app.getPath('userData')
    try {
      mkdirSync(userData, { recursive: true })
      const mem = process.getSystemMemoryInfo()
      push('Data directory', 'HEALTHY', `${userData} -- system memory free ${MB(mem.free * 1024)}`)
    } catch (e) {
      push('Data directory', 'ERROR', `${userData} is not writable: ${String(e)}`)
    }

    // Log file
    try {
      const path = logFilePath()
      const size = path && existsSync(path) ? statSync(path).size : 0
      push('Logs', 'HEALTHY', `${path || 'not initialised'} (${(size / 1024).toFixed(0)} KB, rotates at 2 MB)`)
    } catch (e) {
      push('Logs', 'WARNING', `Log file not readable: ${String(e)}`)
    }

    // Knowledge index
    const folders = knowledge.folders()
    push(
      'Knowledge index',
      folders.length ? 'HEALTHY' : 'WARNING',
      folders.length
        ? `${folders.length} folder(s), ${folders.reduce((n, f) => n + f.chunkCount, 0)} chunks indexed.`
        : 'No knowledge folders added yet (Knowledge screen > Add folder).'
    )

    // Retention (repair)
    const days = settings.get().privacy.logRetentionDays
    if (days > 0) {
      activity.prune(now() - days * 86_400_000)
      push('Retention', 'HEALTHY', `Activity older than ${days} days is pruned automatically.`)
    } else {
      push('Retention', 'WARNING', 'Log retention is set to 0 days, so activity is not kept.')
    }

    logger.info('diagnostics.run', { checks: checks.length })
    return checks
  },

  logs(lines = 400): { text: string; path: string } {
    return readLog(Math.min(Math.max(Number(lines) || 400, 20), 5000))
  }
}
