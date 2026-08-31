import { net } from 'electron'
import { cpus, freemem, hostname, networkInterfaces, totalmem, uptime, release, version } from 'node:os'
import { psJson, runExe, runPowerShell } from './shell'
import type { ProcessInfo, SystemInfo } from '../../shared/types'

/** Slow WMI facts are cached; a GPU list does not change between reads. */
let gpuCache: string[] | null = null
let diskCache: { at: number; disks: SystemInfo['disks'] } | null = null
const DISK_TTL = 30_000

const idleTotal = () => {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

/** Two samples 150 ms apart; `os.loadavg()` is always 0 on Windows. */
async function cpuLoadPercent(): Promise<number> {
  const a = idleTotal()
  await new Promise((r) => setTimeout(r, 150))
  const b = idleTotal()
  const totalDelta = b.total - a.total
  if (totalDelta <= 0) return 0
  return Math.round((1 - (b.idle - a.idle) / totalDelta) * 100)
}

async function disks(): Promise<SystemInfo['disks']> {
  if (diskCache && Date.now() - diskCache.at < DISK_TTL) return diskCache.disks
  const rows =
    (await psJson<{ DeviceID: string; Size: number | null; FreeSpace: number | null }[]>(
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -AsArray -Compress'
    )) ?? []
  const list = rows.map((r) => ({
    drive: r.DeviceID,
    totalBytes: Number(r.Size ?? 0),
    freeBytes: Number(r.FreeSpace ?? 0)
  }))
  diskCache = { at: Date.now(), disks: list }
  return list
}

async function battery(): Promise<SystemInfo['battery'] | undefined> {
  const row = await psJson<{ EstimatedChargeRemaining: number; BatteryStatus: number }>(
    'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'
  )
  if (!row || row.EstimatedChargeRemaining === undefined || row.EstimatedChargeRemaining === null) {
    return undefined
  }
  // BatteryStatus 2 = AC power, 6/7/8/9 = charging states.
  return {
    percent: Number(row.EstimatedChargeRemaining),
    charging: [2, 6, 7, 8, 9].includes(Number(row.BatteryStatus))
  }
}

async function gpus(): Promise<string[]> {
  if (gpuCache) return gpuCache
  const rows = await psJson<string[] | string>(
    'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json -AsArray -Compress'
  )
  gpuCache = Array.isArray(rows) ? rows : rows ? [rows] : []
  return gpuCache
}

function interfaces(): { name: string; address: string }[] {
  // Local addresses only; no external lookup, so nothing leaves the machine.
  const out: { name: string; address: string }[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') out.push({ name, address: a.address })
    }
  }
  return out
}

export const system = {
  async info(): Promise<SystemInfo> {
    const [loadPercent, diskList, batt, gpu] = await Promise.all([
      cpuLoadPercent(),
      disks(),
      battery(),
      gpus()
    ])
    const total = totalmem()
    const free = freemem()
    return {
      os: `${version()} (${release()})`,
      hostname: hostname(),
      uptimeSeconds: Math.round(uptime()),
      cpu: { model: cpus()[0]?.model?.trim() ?? 'Unknown CPU', cores: cpus().length, loadPercent },
      memory: {
        totalBytes: total,
        freeBytes: free,
        usedPercent: Math.round(((total - free) / total) * 100)
      },
      disks: diskList,
      ...(batt ? { battery: batt } : {}),
      ...(gpu.length ? { gpu } : {}),
      network: { online: net.isOnline(), interfaces: interfaces() }
    }
  },

  async processes(limit = 40): Promise<ProcessInfo[]> {
    const capped = Math.min(Math.max(Number(limit) || 40, 1), 200)
    const rows =
      (await psJson<
        { Id: number; ProcessName: string; WorkingSet64: number; CPU: number | null }[]
      >(
        `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${capped} Id,ProcessName,WorkingSet64,CPU | ConvertTo-Json -AsArray -Compress`
      )) ?? []
    return rows.map((r) => ({
      pid: Number(r.Id),
      name: r.ProcessName,
      memoryBytes: Number(r.WorkingSet64 ?? 0),
      cpuSeconds: Math.round(Number(r.CPU ?? 0))
    }))
  },

  /**
   * Power and hardware controls. Every entry here is declared PRIVILEGED in the
   * tool registry, so the user has already confirmed by the time we run.
   *
   * ponytail: volume is stepped through the media keys and brightness through
   * WMI. Absolute volume needs IAudioEndpointVolume COM interop and brightness
   * only works on integrated panels -- both report an honest failure instead of
   * pretending. Add a small C# helper if exact levels ever matter.
   */
  async control(action: string, value?: number): Promise<string> {
    const step = Math.min(Math.max(Number(value ?? 2) || 2, 1), 10)
    switch (action) {
      case 'lock':
        await runExe('rundll32.exe', ['user32.dll,LockWorkStation'])
        return 'Workstation locked.'
      case 'sleep':
        await runExe('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
        return 'Sleep requested.'
      case 'shutdown':
        await runExe('shutdown.exe', ['/s', '/t', '5'])
        return 'Shutting down in 5 seconds (run `shutdown /a` to abort).'
      case 'restart':
        await runExe('shutdown.exe', ['/r', '/t', '5'])
        return 'Restarting in 5 seconds (run `shutdown /a` to abort).'
      case 'signout':
        await runExe('shutdown.exe', ['/l'])
        return 'Signing out.'
      case 'volume-up':
      case 'volume-down':
      case 'volume-mute': {
        const key = action === 'volume-up' ? 175 : action === 'volume-down' ? 174 : 173
        const presses = action === 'volume-mute' ? 1 : step
        const res = await runPowerShell(
          `$s = New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $s.SendKeys([char]${key}) }`
        )
        if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'Volume change failed.')
        return action === 'volume-mute' ? 'Toggled mute.' : `${action} x${presses}.`
      }
      case 'brightness': {
        const percent = Math.min(Math.max(Number(value ?? 50) || 50, 0), 100)
        const res = await runPowerShell(
          `(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1,${percent})`
        )
        if (res.exitCode !== 0) {
          throw new Error(
            'This display does not expose WMI brightness control (common on desktop monitors). Use the monitor buttons or Windows Settings.'
          )
        }
        return `Brightness set to ${percent}%.`
      }
      default:
        throw new Error(
          `Unknown system action "${action}". Supported: lock, sleep, shutdown, restart, signout, volume-up, volume-down, volume-mute, brightness.`
        )
    }
  }
}
