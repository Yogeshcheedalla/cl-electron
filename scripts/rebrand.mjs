/**
 * One-shot rebrand sweep: the display word JARVIS becomes Akansha.
 *
 * Deliberately narrow. It rewrites the uppercase display word and the
 * `JARVIS_*` environment-variable prefix (which is user-visible in Settings),
 * and the reverse-DNS app id. It leaves the internal wiring alone -- the
 * `window.akansha` bridge, the `akansha:event` push channel, `akansha.db`, the
 * `AkanshaApi`/`AkanshaEvent`/`AkanshaNotification` type names and the `Jarvis.Win`
 * PowerShell namespace -- because renaming those would churn every call site
 * without changing anything a user can see.
 *
 * Run with: node scripts/rebrand.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'release'])
const EXT = new Set(['.ts', '.tsx', '.css', '.html', '.yml', '.yaml', '.json', '.md'])
const SKIP_FILES = new Set(['package-lock.json'])

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (EXT.has(extname(name)) && !SKIP_FILES.has(name)) files.push(full)
  }
}
walk(ROOT)

let changed = 0
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  const after = before
    // Env-var prefix first, so the generic rule below cannot turn it into `Akansha_`.
    .replace(/JARVIS_/g, 'AKANSHA_')
    .replace(/JARVIS/g, 'Akansha')
    .replace(/com\.jarvis\.assistant/g, 'com.akansha.assistant')
  if (after !== before) {
    writeFileSync(file, after)
    changed++
  }
}
process.stdout.write(`rebranded ${changed} of ${files.length} files\n`)
