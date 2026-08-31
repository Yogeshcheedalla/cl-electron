import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../core/logger'
import { bus } from '../core/bus'
import type { Settings } from '../../shared/types'

export const DEFAULT_SYSTEM_PROMPT = `You are Akansha, a highly capable Windows desktop AI assistant.

Your responsibilities are to help the user accomplish tasks efficiently and safely.

You can reason about requests, communicate naturally, use available tools, interact with Windows, manage files, launch applications, perform automation, and provide useful information.

Before performing potentially destructive operations, clearly explain what will happen and request confirmation when appropriate.

Never claim that an operation succeeded unless the tool actually reports success.

When a tool fails, explain the failure and provide a useful next step.

Prefer concise responses for simple actions and detailed responses for complex tasks.

Respect user privacy and minimize unnecessary access to files, applications, and system resources.

Use tools when an action is requested rather than merely describing how the user could perform it.`

const home = homedir()

export const DEFAULT_SETTINGS: Settings = {
  general: {
    startWithWindows: false,
    startMinimized: false,
    minimizeToTray: true,
    animations: true,
    notifications: 'ALL'
  },
  ai: {
    // Local by default, so a fresh install works with no API key and no account.
    // The cloud entries below are only reached when the user adds a key -- see
    // `fallback` and `electron/ai/router.ts`.
    provider: 'ollama',
    temperature: 0.4,
    maxTokens: 4096,
    streaming: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    autoRoute: true,
    // LOCAL FIRST: try the local model, fall back to a cloud provider only when
    // the local one cannot serve the request and a key exists for the cloud one.
    fallback: 'LOCAL_FIRST',
    routing: {
      GENERAL: { provider: 'anthropic', model: 'claude-sonnet-5' },
      FAST: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      REASONING: { provider: 'anthropic', model: 'claude-opus-5' },
      CODING: { provider: 'anthropic', model: 'claude-opus-5' },
      VISION: { provider: 'anthropic', model: 'claude-sonnet-5' },
      // The fully-local option -- the one that makes an API key optional rather
      // than required. Qwen3.5 9B is the shipped pick over the heavier
      // recommendation in `electron/ai/ollama.ts`: Apache-2.0, 6.6 GB pulled,
      // and it carries all three capabilities Akansha's router needs from one
      // model -- tools (a model that cannot emit a tool call can only chat),
      // vision (so the VISION role has a local answer too) and a 256K context.
      // `gpt-oss:20b` is the recommendation on a roomier machine; `qwen3.5:4b`
      // (3.4 GB) if 16 GB of RAM is tight while the app is running. Change it to
      // any tag you have pulled; nothing here downloads a model.
      LOCAL: { provider: 'ollama', model: 'qwen3.5:9b' }
    }
  },
  voice: {
    autoSpeak: false,
    rate: 1,
    volume: 1,
    voiceName: '',
    pushToTalk: true,
    wakeWord: 'hey akansha',
    wakeWordEnabled: false,
    // Offline dictation is opt-in and points at nothing: the user supplies the
    // whisper.cpp binary and the model. Until then, dictation uses OpenAI if a
    // key is present and is unavailable if not.
    localStt: false,
    whisperExePath: '',
    whisperModelPath: '',
    whisperLanguage: 'auto'
  },
  automation: {
    confirmDestructive: true,
    trustedTools: [],
    // The user's own profile only. Anything else -- another drive, a repo
    // outside home -- has to be added deliberately in Settings > Automation.
    allowedRoots: [home],
    toolLevels: {}
  },
  memory: { enabled: true },
  // Embeddings are opt-in: indexing with them on sends chunk text to the
  // configured provider. Keyword ranking works with no network at all.
  knowledge: { embeddings: false, provider: 'openai', model: 'text-embedding-3-small' },
  // No update feed is contacted until the user turns this on and supplies a URL.
  updates: { enabled: false, feedUrl: '', checkOnStart: false },
  keyboard: { globalShortcut: 'Control+Space', commandPalette: 'Control+K' },
  privacy: {
    screenAccess: false,
    clipboardAccess: true,
    telemetry: false,
    privacyMode: false,
    logRetentionDays: 30,
    proactive: false
  },
  developerMode: false,
  mode: 'STANDARD'
}

let file = ''
let current: Settings = DEFAULT_SETTINGS

/** Shallow-merges each top-level section so new defaults appear after upgrades. */
function merge(base: Settings, patch: Partial<Settings>): Settings {
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k]
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && existing && typeof existing === 'object'
        ? { ...(existing as object), ...(v as object) }
        : v
  }
  return out as unknown as Settings
}

export function initSettings(userDataDir: string) {
  mkdirSync(userDataDir, { recursive: true })
  file = join(userDataDir, 'settings.json')
  if (existsSync(file)) {
    try {
      current = merge(DEFAULT_SETTINGS, JSON.parse(readFileSync(file, 'utf8')))
    } catch (e) {
      logger.warn('settings.corrupt', { message: String(e) })
      current = DEFAULT_SETTINGS
    }
  }
  save()
  return current
}

function save() {
  if (!file) return
  writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
}

export const settings = {
  get: () => current,

  update(patch: Partial<Settings>): Settings {
    current = merge(current, patch)
    save()
    logger.info('settings.updated', { sections: Object.keys(patch) })
    bus.emitToUi({ type: 'state', state: 'settings-changed' })
    return current
  },

  resetSection(section: keyof Settings): Settings {
    current = merge(current, { [section]: DEFAULT_SETTINGS[section] } as Partial<Settings>)
    save()
    return current
  }
}
