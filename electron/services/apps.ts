import { dialog, shell as electronShell } from 'electron'
import { readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { logger } from '../core/logger'
import { psJson, psQuote, runExe, runPowerShell } from './shell'
import type { AppEntry } from '../../shared/types'

const startMenus = [
  join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
  join(process.env.APPDATA ?? '', 'Microsoft\\Windows\\Start Menu\\Programs')
].filter(Boolean)

const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

/** Built-ins that are not always present as Start Menu shortcuts. */
const ALIASES: AppEntry[] = [
  { name: 'Notepad', target: join(sys, 'notepad.exe'), source: 'alias' },
  { name: 'Calculator', target: join(sys, 'calc.exe'), source: 'alias' },
  { name: 'Paint', target: join(sys, 'mspaint.exe'), source: 'alias' },
  { name: 'File Explorer', target: join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), source: 'alias' },
  { name: 'Command Prompt', target: join(sys, 'cmd.exe'), source: 'alias' },
  { name: 'PowerShell', target: join(sys, 'WindowsPowerShell\\v1.0\\powershell.exe'), source: 'alias' },
  { name: 'Task Manager', target: join(sys, 'Taskmgr.exe'), source: 'alias' },
  { name: 'Settings', target: 'shell:AppsFolder\\windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', source: 'uwp' },
  { name: 'Registry Editor', target: join(process.env.SystemRoot ?? 'C:\\Windows', 'regedit.exe'), source: 'alias' }
]

let cache: AppEntry[] | null = null

function scanStartMenu(): AppEntry[] {
  const found: AppEntry[] = []
  for (const root of startMenus) {
    try {
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        const ext = extname(entry.name).toLowerCase()
        if (entry.isFile() && (ext === '.lnk' || ext === '.url')) {
          found.push({
            name: basename(entry.name, extname(entry.name)),
            target: join(entry.parentPath ?? root, entry.name),
            source: 'start-menu'
          })
        }
      }
    } catch (e) {
      logger.warn('apps.scanFailed', { root, message: String(e) })
    }
  }
  return found
}

async function scanStartApps(): Promise<AppEntry[]> {
  const rows =
    (await psJson<{ Name: string; AppID: string }[]>(
      'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -AsArray -Compress'
    )) ?? []
  return rows
    .filter((r) => r?.Name && r?.AppID)
    .map((r) => ({
      name: r.Name,
      // A path-like AppID is a classic desktop app; anything else is a UWP AUMID.
      target: r.AppID.includes('\\') && r.AppID.includes(':') ? r.AppID : `shell:AppsFolder\\${r.AppID}`,
      source: r.AppID.includes('!') ? ('uwp' as const) : ('path' as const)
    }))
}

/** Later sources win only when they add a new name, so Start Menu labels survive. */
function dedupe(lists: AppEntry[][]): AppEntry[] {
  const byName = new Map<string, AppEntry>()
  for (const list of lists) {
    for (const app of list) {
      const key = app.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, app)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function load(refresh = false): Promise<AppEntry[]> {
  if (cache && !refresh) return cache
  const startApps = await scanStartApps()
  cache = dedupe([scanStartMenu(), startApps, ALIASES])
  logger.info('apps.indexed', { count: cache.length })
  return cache
}

/** Exact match, then prefix, then substring, then token overlap. */
function match(list: AppEntry[], query: string): AppEntry | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const named = (fn: (n: string) => boolean) => list.find((a) => fn(a.name.toLowerCase()))
  return (
    named((n) => n === q) ??
    named((n) => n === q.replace(/\.exe$/, '')) ??
    named((n) => n.startsWith(q)) ??
    named((n) => n.includes(q)) ??
    list.find((a) => {
      const tokens = q.split(/\s+/)
      const name = a.name.toLowerCase()
      return tokens.length > 1 && tokens.every((t) => name.includes(t))
    })
  )
}

export const apps = {
  list: (refresh = false) => load(refresh),

  async launch(name: string): Promise<{ launched: string; pid?: number }> {
    const list = await load()
    const app = match(list, name)
    if (!app) {
      throw new Error(
        `No installed application matches "${name}". Ask Akansha to list applications to see what is available.`
      )
    }
    if (app.target.startsWith('shell:')) {
      const res = await runExe('explorer.exe', [app.target], { timeoutMs: 10_000 })
      // explorer.exe returns 1 even on success when it hands off to another process.
      if (res.timedOut) throw new Error(`Launching ${app.name} timed out.`)
      return { launched: app.name }
    }
    const error = await electronShell.openPath(app.target)
    if (error) throw new Error(`Windows refused to launch ${app.name}: ${error}`)
    return { launched: app.name }
  },

  /** Closes every visible window of the matching process, gracefully first. */
  async close(name: string): Promise<{ closed: number }> {
    const q = psQuote(`*${name.trim()}*`)
    const bare = psQuote(name.trim().replace(/\.exe$/i, ''))
    const res = await psJson<{ closed: number }>(
      `$t = Get-Process | Where-Object { $_.ProcessName -eq ${bare} -or $_.MainWindowTitle -like ${q} }
       $n = 0
       foreach ($p in $t) { if ($p.CloseMainWindow()) { $n++ } }
       Start-Sleep -Milliseconds 400
       foreach ($p in $t) { if (-not $p.HasExited) { try { $p.Kill(); $n++ } catch {} } }
       [pscustomobject]@{ closed = $n } | ConvertTo-Json -Compress`,
      { timeoutMs: 20_000 }
    )
    const closed = Number(res?.closed ?? 0)
    if (!closed) throw new Error(`Nothing matching "${name}" was running.`)
    return { closed }
  },

  async focus(name: string): Promise<{ focused: boolean }> {
    const q = psQuote(`*${name.trim()}*`)
    const bare = psQuote(name.trim().replace(/\.exe$/i, ''))
    const res = await runPowerShell(
      `Add-Type -Namespace Akansha -Name Win -MemberDefinition '
         [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
         [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int c);'
       $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -eq ${bare} -or $_.MainWindowTitle -like ${q}) } | Select-Object -First 1
       if ($p) { [Akansha.Win]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; [Akansha.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Write-Output 'ok' } else { Write-Output 'none' }`,
      { timeoutMs: 20_000 }
    )
    if (!res.stdout.includes('ok')) {
      throw new Error(`No visible window matching "${name}" is open.`)
    }
    return { focused: true }
  },

  async openUrl(url: string): Promise<{ url: string }> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`"${url}" is not a valid URL.`)
    }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      throw new Error(`Only http, https and mailto links can be opened (got ${parsed.protocol}).`)
    }
    await electronShell.openExternal(parsed.toString())
    return { url: parsed.toString() }
  },

  async openPath(path: string): Promise<{ path: string }> {
    const error = await electronShell.openPath(path)
    if (error) throw new Error(error)
    return { path }
  },

  async pickFolder(): Promise<{ path: string | null }> {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a folder for Akansha'
    })
    return { path: res.canceled ? null : (res.filePaths[0] ?? null) }
  }
}
