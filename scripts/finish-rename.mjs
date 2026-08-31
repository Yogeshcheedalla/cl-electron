import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * One-off: finishes the JARVIS -> Akansha rename in the places the earlier pass
 * left alone -- the renderer global, the push channel, the exported type names,
 * the two data file names and the temp-directory prefixes. Deliberately a list
 * of explicit rules rather than a blanket /akansha/i, so that `C:\jarvis claude`
 * (a real folder on this machine) and the LEGACY folder names in userdata.ts
 * survive untouched.
 */
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git', '.whisper', '.verify'])
const EXTS = new Set(['.ts', '.tsx', '.md', '.yml', '.html', '.css', '.mjs'])

const RULES = [
  [/\bJarvisApi\b/g, 'AkanshaApi'],
  [/\bJarvisEvent\b/g, 'AkanshaEvent'],
  [/\bJarvisNotification\b/g, 'AkanshaNotification'],
  [/\buseJarvisEvent\b/g, 'useAkanshaEvent'],
  [/window\.jarvis\b/g, 'window.akansha'],
  [/'akansha:event'/g, "'akansha:event'"],
  [/`akansha:event`/g, '`akansha:event`'],
  [/exposeInMainWorld\('jarvis'/g, "exposeInMainWorld('akansha'"],
  [/\bjarvis\.db\b/g, 'akansha.db'],
  [/\bjarvis\.log\b/g, 'akansha.log'],
  [/\bjarvis-/g, 'akansha-'],
  [/Namespace Akansha\b/g, 'Namespace Akansha'],
  [/\[Jarvis\.Win\]/g, '[Akansha.Win]'],
  [/\/akansha/g, '/akansha']
]

let touched = 0
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!EXTS.has(extname(name))) continue
    const before = readFileSync(full, 'utf8')
    let after = before
    for (const [re, to] of RULES) after = after.replace(re, to)
    if (after !== before) {
      writeFileSync(full, after, 'utf8')
      touched++
      console.log('rewrote', full)
    }
  }
}

walk(process.cwd())
console.log('files rewritten:', touched)
