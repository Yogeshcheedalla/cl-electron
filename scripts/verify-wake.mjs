/**
 * Live verification for the always-on wake listener.
 *
 * Everything else in this repository is checked by vitest, but the wake listener
 * cannot be: it needs a real microphone, a real audio thread and a real window.
 * So this script launches the built app with Chromium's debugging port open,
 * drives it over CDP exactly as the tray and the badge do, and reads the answers
 * back out of Windows itself -- the ConsentStore records when an executable opens
 * and releases the microphone, so "the microphone is open" is not something the
 * app is trusted to report about itself.
 *
 *   node scripts/verify-wake.mjs
 *
 * The debugging port is only ever passed here. Nothing in the shipped app opens
 * it, and the packaged build has no way to.
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const PORT = 9222
const EXE = process.argv[2] || 'node_modules/electron/dist/electron.exe'
const ENTRY = process.argv[2] ? [] : ['.']
// Windows keys its microphone records on the full executable path, so the same
// string has to be used for the lookup as for the launch.
const ABS_EXE = resolve(process.cwd(), EXE)

const results = []
let failures = 0

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Windows' own record of microphone use, keyed on the executable path. */
function micState(exePath) {
  const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\${exePath.replace(/\\/g, '#')}`
  const ps = `$v = Get-ItemProperty -Path '${key}' -ErrorAction SilentlyContinue; if ($null -eq $v) { 'missing' } else { "$($v.LastUsedTimeStart):$($v.LastUsedTimeStop)" }`
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
  if (out === 'missing') return { known: false, open: false }
  const [start, stop] = out.split(':')
  return { known: true, open: stop === '0' && start !== '0', start, stop }
}

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not listening yet */
    }
    await sleep(500)
  }
  throw new Error('The app never opened its debugging port.')
}

/** Minimal CDP client: one socket, Runtime.evaluate with awaitPromise. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiting = new Map()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      const pending = this.waiting.get(msg.id)
      if (!pending) return
      this.waiting.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    })
  }

  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    // Wrapped in an async arrow so the expressions below may await the bridge:
    // Runtime.evaluate has no top-level await of its own.
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'eval threw')
    return res.result.value
  }
}

const child = spawn(EXE, [...ENTRY, `--remote-debugging-port=${PORT}`], {
  cwd: process.cwd(),
  stdio: 'ignore',
  detached: false
})

let cdp
try {
  cdp = await Cdp.open(await target())
  await cdp.send('Runtime.enable')

  const exe = await cdp.eval('window.akansha ? "ok" : "missing"')
  record('the preload bridge is present', exe === 'ok', `window.akansha is ${exe}`)

  record(
    'the renderer has no Node access',
    (await cdp.eval(
      'JSON.stringify([typeof require, typeof process, typeof module, typeof window.akansha.ipcRenderer])'
    )) === '["undefined","undefined","undefined","undefined"]',
    'require / process / module / ipcRenderer all undefined'
  )

  // Settings are read through the same channel the UI uses.
  const settings = await cdp.eval('(await window.akansha.settings.get()).data')
  record('continuous listening is on in saved settings', settings?.voice?.wakeWordEnabled === true)

  await sleep(6000)
  const armed = micState(ABS_EXE)
  record('Windows reports the microphone open with no window interaction', armed.open, JSON.stringify(armed))

  const badge = await cdp.eval('document.querySelector(".wake-flag")?.innerText?.replace(/\\n/g, " | ") ?? "no badge"')
  record('the open microphone is shown on screen', badge !== 'no badge' && /microphone|listening/i.test(badge), badge)

  const phase = await cdp.eval('document.querySelector(".wake-flag")?.className ?? ""')
  record('the badge carries a live phase class', /wake-flag (listening|hearing|thinking|starting|speaking|muted)/.test(phase), phase)

  // Exactly what the tray kill switch does.
  await cdp.eval(
    'window.akansha.settings.update({ voice: { ...(await window.akansha.settings.get()).data.voice, wakeWordEnabled: false } })'
  )
  await sleep(5000)
  const stopped = micState(ABS_EXE)
  record('the kill switch closes the microphone for real', stopped.known && !stopped.open, JSON.stringify(stopped))
  record(
    'the badge disappears once the microphone is closed',
    (await cdp.eval('document.querySelector(".wake-flag") ? "still there" : "gone"')) === 'gone'
  )

  // And back on again, which is where a duplicate listener would show up.
  await cdp.eval(
    'window.akansha.settings.update({ voice: { ...(await window.akansha.settings.get()).data.voice, wakeWordEnabled: true } })'
  )
  await sleep(6000)
  const rearmed = micState(ABS_EXE)
  record('listening resumes after being switched back on', rearmed.open, JSON.stringify(rearmed))
  record(
    'exactly one listener exists after the off/on cycle',
    (await cdp.eval('document.querySelectorAll(".wake-flag").length')) === 1
  )
} catch (e) {
  record('the harness ran to completion', false, String(e))
} finally {
  try {
    await cdp?.eval(
      'window.akansha.settings.update({ voice: { ...(await window.akansha.settings.get()).data.voice, wakeWordEnabled: true } })'
    )
  } catch {
    /* app already gone */
  }
  child.kill()
  await sleep(2500)
}

console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
