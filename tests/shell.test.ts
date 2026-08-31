import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeRuns, cancelRun, psJson, psQuote, runExe, runPowerShell } from '../electron/services/shell'
import { initLogger } from '../electron/core/logger'

/**
 * These tests start real PowerShell processes, so they are the slow ones -- and
 * the only ones that prove the execution layer actually captures output, reports
 * exit codes and kills a run that overstays its timeout.
 */
beforeAll(() => {
  initLogger(mkdtempSync(join(tmpdir(), 'akansha-shell-')))
})

const slow = { timeout: 30_000 }

describe('process execution', () => {
  it('captures stdout and a zero exit code', slow, async () => {
    const res = await runPowerShell('Write-Output "hello from akansha"')
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('hello from akansha')
    expect(res.timedOut).toBe(false)
  })

  it('reports a non-zero exit code instead of pretending it worked', slow, async () => {
    const res = await runPowerShell('exit 3')
    expect(res.exitCode).toBe(3)
    expect(res.timedOut).toBe(false)
  })

  it('captures stderr separately from stdout', slow, async () => {
    const res = await runPowerShell('Write-Output "out"; Write-Error "something broke"')
    expect(res.stdout).toContain('out')
    expect(res.stderr).toContain('something broke')
  })

  it('kills a command that outstays its timeout', slow, async () => {
    const started = Date.now()
    const res = await runPowerShell('Start-Sleep -Seconds 30', { timeoutMs: 1500 })
    expect(res.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('reports a missing executable rather than throwing', slow, async () => {
    const res = await runExe('definitely-not-a-real-binary.exe', ['--version'])
    expect(res.exitCode).toBeNull()
    expect(res.stderr).toMatch(/not found/i)
  })

  it('passes arguments as argv, so a metacharacter stays data', slow, async () => {
    // Node echoes the argument it actually received. With `shell: true` the `&`
    // would split into a second command; with argv it arrives intact.
    const payload = 'a & echo INJECTED | more'
    const res = await runExe(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe(payload)
  })

  it('tracks a run by id and can cancel it', slow, async () => {
    const execId = 'test-run'
    const pending = runPowerShell('Start-Sleep -Seconds 20', { execId, timeoutMs: 25_000 })
    // Give the process a moment to spawn and register its pid.
    await new Promise((r) => setTimeout(r, 1200))
    expect(activeRuns()).toContain(execId)
    expect(cancelRun(execId)).toBe(true)
    const res = await pending
    expect(res.timedOut).toBe(false)
    expect(activeRuns()).not.toContain(execId)
  })

  it('returns false when cancelling something that is not running', () => {
    expect(cancelRun('no-such-run')).toBe(false)
  })

  it('parses JSON output and survives output that is not JSON', slow, async () => {
    const parsed = await psJson<{ name: string }>('[pscustomobject]@{ name = "akansha" } | ConvertTo-Json')
    expect(parsed?.name).toBe('akansha')
    expect(await psJson('Write-Output "plain text"')).toBeNull()
    expect(await psJson('Write-Output ""')).toBeNull()
  })
})

describe('psQuote', () => {
  it('doubles single quotes so a value cannot close the literal', () => {
    expect(psQuote("O'Brien")).toBe("'O''Brien'")
    expect(psQuote("'; Remove-Item C:\\ -Recurse; '")).toBe("'''; Remove-Item C:\\ -Recurse; '''")
  })

  it('keeps a quoted value inert when PowerShell evaluates it', slow, async () => {
    const nasty = "'; Write-Output INJECTED; '"
    const res = await runPowerShell(`Write-Output ${psQuote(nasty)}`)
    expect(res.stdout).toContain(nasty)
    expect(res.stdout).not.toMatch(/^INJECTED$/m)
  })
})
