/**
 * What Akansha actually knows about the local model runner.
 *
 * Ollama is the default provider, which means "is it there?" has to be answered
 * honestly and specifically -- a cloud provider is unavailable for exactly one
 * reason (no key), but a local one has four distinct states and each needs a
 * different sentence from the user:
 *
 *   not installed        -> download it
 *   installed, not running -> `ollama serve`
 *   running, no models   -> `ollama pull <model>`
 *   running, wrong model -> pull the one the LOCAL route points at
 *
 * Detection is filesystem + HTTP only. Nothing here spawns a shell, downloads a
 * model or starts a service on the user's behalf.
 *
 * The verdict is cached because `Provider.unavailable()` is synchronous and is
 * consulted on every request: with LOCAL FIRST as the default fallback mode, a
 * truthful cached "not running" is what lets a request skip straight to the
 * cloud instead of waiting on a connection that will be refused.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * The recommended local model. `gpt-oss:20b` is OpenAI's open-weight release
 * under Apache 2.0 -- it is the model that makes an OpenAI API key optional
 * rather than required, which is the whole point of the local route. It is a
 * mixture-of-experts model with ~3.6B active parameters, so it runs far lighter
 * than its 20B name suggests, and it supports tool calling, which Akansha's
 * router needs (a model that cannot emit a tool call can only chat).
 *
 * Roughly 14 GB pulled and ~16 GB of RAM to run comfortably. On a 16 GB machine
 * with no discrete GPU it works but leaves little headroom; `qwen3.5:9b`
 * (6.6 GB, Apache 2.0, tools + vision) is the lighter alternative and is what
 * the shipped LOCAL route points at. Nothing here downloads anything.
 */
export const RECOMMENDED_MODEL = 'gpt-oss:20b'

/** A lighter local model for machines where the recommendation does not fit. */
export const LIGHTER_MODEL = 'qwen3.5:9b'

export interface OllamaStatus {
  /** `ollama.exe` found on disk, or the API answered (which proves it). */
  installed: boolean
  /** The HTTP API answered. */
  running: boolean
  /** Full path of the executable when it was found on disk. */
  exePath?: string
  /** Model tags the daemon reports, e.g. `qwen3.5:9b`. */
  models: string[]
  baseUrl: string
  /** The model the LOCAL route is configured to use. */
  selected: string
  selectedInstalled: boolean
  recommended: string
  recommendedInstalled: boolean
  /** One sentence naming the state. Safe to show in the UI as-is. */
  detail: string
  /** The exact next step, usually a command to paste. */
  hint?: string
  checkedMs: number
}

/** Where the official Windows installer puts it, plus whatever is on PATH. */
function candidatePaths(): string[] {
  const out: string[] = []
  const local = process.env.LOCALAPPDATA
  const files = process.env.ProgramFiles
  const files86 = process.env['ProgramFiles(x86)']
  if (local) out.push(join(local, 'Programs', 'Ollama', 'ollama.exe'))
  if (files) out.push(join(files, 'Ollama', 'ollama.exe'))
  if (files86) out.push(join(files86, 'Ollama', 'ollama.exe'))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (trimmed) out.push(join(trimmed, 'ollama.exe'))
  }
  return out
}

/**
 * The executable, or null. A PATH scan rather than `where ollama`: spawning a
 * process to answer a question `existsSync` can answer is both slower and one
 * more shell call to justify.
 */
export function detectOllamaExe(): string | null {
  for (const path of candidatePaths()) {
    try {
      if (existsSync(path)) return path
    } catch {
      /* an unreadable PATH entry is not an answer */
    }
  }
  return null
}

/** Tag comparison that tolerates the implicit `:latest` Ollama adds on pull. */
export function hasModel(models: string[], want: string): boolean {
  if (!want) return false
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase()
  const target = norm(want)
  return models.some((m) => norm(m) === target)
}

/**
 * The sentence a user can act on, derived purely from the facts. Pure so the
 * wording is testable without a daemon, a network or a filesystem.
 */
export function ollamaAdvice(f: {
  installed: boolean
  running: boolean
  models: string[]
  selected: string
  selectedInstalled: boolean
  baseUrl: string
}): { detail: string; hint?: string } {
  if (!f.installed && !f.running) {
    return {
      detail: 'Ollama is not installed, so the local model route cannot run.',
      hint: `Install it from https://ollama.com/download, then run \`ollama pull ${RECOMMENDED_MODEL}\`.`
    }
  }
  if (!f.running) {
    return {
      detail: `Ollama is installed but not answering at ${f.baseUrl}.`,
      hint: 'Start it from the Start Menu, or run `ollama serve` in a terminal.'
    }
  }
  if (!f.models.length) {
    return {
      detail: 'Ollama is running but has no models pulled.',
      hint: `Run \`ollama pull ${RECOMMENDED_MODEL}\` (about 14 GB), or \`ollama pull ${LIGHTER_MODEL}\` (6.6 GB) on a smaller machine.`
    }
  }
  if (!f.selectedInstalled) {
    return {
      detail: `Ollama is running, but "${f.selected}" is not pulled. Available: ${f.models.slice(0, 6).join(', ')}.`,
      hint: `Run \`ollama pull ${f.selected}\`, or pick one of the pulled models in Settings > AI.`
    }
  }
  return { detail: `Ollama is running with "${f.selected}" ready (${f.models.length} model(s) pulled).` }
}

let cached: OllamaStatus | null = null

/**
 * Asks the daemon what it has. Never throws: a refused connection is an answer,
 * not an error, and this runs on a timer.
 */
export async function probeOllama(baseUrl: string, selected: string): Promise<OllamaStatus> {
  const exePath = detectOllamaExe()
  let running = false
  let models: string[] = []
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) })
    if (res.ok) {
      running = true
      const json = (await res.json()) as { models?: { name?: string }[] }
      models = (json.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean)
    }
  } catch {
    /* not running, or not reachable at that URL */
  }
  const selectedInstalled = running && hasModel(models, selected)
  const facts = { installed: Boolean(exePath) || running, running, models, selected, selectedInstalled, baseUrl }
  const { detail, hint } = ollamaAdvice(facts)
  cached = {
    ...facts,
    ...(exePath ? { exePath } : {}),
    recommended: RECOMMENDED_MODEL,
    recommendedInstalled: hasModel(models, RECOMMENDED_MODEL),
    detail,
    ...(hint ? { hint } : {}),
    checkedMs: Date.now()
  }
  return cached
}

export const ollamaLastStatus = (): OllamaStatus | null => cached

/**
 * The cached reason the local provider cannot serve a request, or null.
 *
 * Null before the first probe: an unprobed local provider is treated as
 * available rather than blamed, so a slow first second after launch does not
 * push a request to the cloud. Once probed, this is the truth and it is what
 * makes LOCAL FIRST cheap.
 */
export function ollamaVerdict(): string | null {
  if (!cached) return null
  if (!cached.running || !cached.selectedInstalled) return [cached.detail, cached.hint].filter(Boolean).join(' ')
  return null
}

let timer: NodeJS.Timeout | null = null

/**
 * Keeps the verdict fresh. Every 30 s against a localhost endpoint costs
 * nothing measurable and means "I started Ollama just now" is noticed without
 * the user restarting Akansha.
 */
export function startOllamaWatch(read: () => { baseUrl: string; selected: string }, everyMs = 30_000) {
  const tick = () => {
    const { baseUrl, selected } = read()
    void probeOllama(baseUrl, selected)
  }
  tick()
  if (timer) clearInterval(timer)
  timer = setInterval(tick, everyMs)
  timer.unref?.()
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}

/** Test seam: forget the cached verdict. */
export function resetOllamaStatus() {
  cached = null
}
