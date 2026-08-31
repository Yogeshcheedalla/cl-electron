/** Domain types shared between the Electron main process and the React renderer. */

export type PermissionLevel = 'SAFE' | 'CONFIRM' | 'PRIVILEGED' | 'BLOCKED'
export type PermissionDecision = 'allow' | 'confirm' | 'deny'

export interface ToolError {
  code: string
  message: string
  hint?: string
}

export interface ToolResult<T = unknown> {
  success: boolean
  data?: T
  error?: ToolError
}

export type AssistantState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'EXECUTING' | 'ERROR'

export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'ollama'
export type ModelRole = 'GENERAL' | 'FAST' | 'REASONING' | 'CODING' | 'VISION' | 'LOCAL'

/**
 * Which providers a request may reach, and in what order.
 *
 * `LOCAL_FIRST` is the default: the local model answers when it can, and the
 * cloud is a fallback rather than a requirement. `LOCAL_ONLY` is the private
 * setting -- nothing leaves the machine, and a request fails rather than
 * quietly going to a cloud provider.
 */
export type FallbackMode = 'LOCAL_ONLY' | 'CLOUD_ONLY' | 'LOCAL_FIRST' | 'CLOUD_FIRST'

/** What the local model runner is doing right now. Reported, never assumed. */
export interface OllamaStatus {
  installed: boolean
  running: boolean
  exePath?: string
  models: string[]
  baseUrl: string
  selected: string
  selectedInstalled: boolean
  recommended: string
  recommendedInstalled: boolean
  detail: string
  hint?: string
  checkedMs: number
}

export interface ProviderConfig {
  id: ProviderId
  enabled: boolean
  baseUrl: string
  model: string
  hasApiKey: boolean
  /** Present for `ollama` only: why the local route is or is not ready. */
  local?: OllamaStatus
}

export interface Settings {
  general: {
    startWithWindows: boolean
    startMinimized: boolean
    minimizeToTray: boolean
    animations: boolean
    notifications: 'ALL' | 'IMPORTANT' | 'CRITICAL' | 'QUIET'
  }
  ai: {
    provider: ProviderId
    temperature: number
    maxTokens: number
    streaming: boolean
    systemPrompt: string
    routing: Record<ModelRole, { provider: ProviderId; model: string }>
    autoRoute: boolean
    /** Local/cloud preference and fallback order. Default `LOCAL_FIRST`. */
    fallback: FallbackMode
  }
  voice: {
    autoSpeak: boolean
    rate: number
    volume: number
    voiceName: string
    pushToTalk: boolean
    wakeWord: string
    wakeWordEnabled: boolean
    /**
     * Offline dictation through whisper.cpp. Off until the user points at a
     * binary and a model on disk: nothing is bundled and nothing is downloaded,
     * because a speech model is hundreds of megabytes and choosing one for the
     * user would be choosing their accuracy/size trade-off for them.
     */
    localStt: boolean
    /** `whisper-cli.exe` (or the older `main.exe`) from a whisper.cpp release. */
    whisperExePath: string
    /** A GGML/GGUF model file, e.g. `ggml-base.en.bin`. */
    whisperModelPath: string
    /** ISO code passed to `-l`, or `auto` to let whisper detect it. */
    whisperLanguage: string
  }
  automation: {
    confirmDestructive: boolean
    /** Tools the user has chosen to run without a confirmation prompt. */
    trustedTools: string[]
    allowedRoots: string[]
    /** User overrides of a tool's built-in permission level. */
    toolLevels: Record<string, PermissionLevel>
  }
  memory: { enabled: boolean }
  knowledge: {
    /**
     * Off by default: embedding a folder uploads its text to the configured
     * provider. Keyword ranking always runs, so turning this off only costs
     * recall on paraphrased questions.
     */
    embeddings: boolean
    provider: ProviderId
    model: string
  }
  updates: {
    /** No feed is contacted unless this is on AND feedUrl is set. */
    enabled: boolean
    /** https URL of a directory containing latest.yml, as produced by `npm run package`. */
    feedUrl: string
    checkOnStart: boolean
  }
  keyboard: { globalShortcut: string; commandPalette: string }
  privacy: {
    screenAccess: boolean
    clipboardAccess: boolean
    telemetry: boolean
    privacyMode: boolean
    logRetentionDays: number
    proactive: boolean
  }
  developerMode: boolean
  mode: 'STANDARD' | 'PRODUCTIVITY' | 'DEVELOPER' | 'RESEARCH' | 'PRIVACY' | 'AUTOMATION'
}

/**
 * What offline dictation knows about its own configuration. `configured` means
 * the user turned it on and filled both paths in; `ready` additionally means both
 * files were found on disk. `detail` always says which of the two is missing, so
 * the Voice page never has to guess why the mic button is disabled.
 */
export interface LocalSttStatus {
  configured: boolean
  ready: boolean
  detail: string
  exe?: string
  model?: string
}

/**
 * Which recogniser a recording would actually reach right now. Reported before
 * the user speaks rather than discovered afterwards, and `engine` is the honest
 * answer: `local` when whisper.cpp is configured and present, `openai` when a key
 * is stored, `none` when dictation would fail.
 */
export interface VoiceCapabilities {
  stt: boolean
  sttDetail: string
  tts: boolean
  engine: 'local' | 'openai' | 'none'
  local: LocalSttStatus
  /** True when an OpenAI key is stored, i.e. a cloud fallback exists. */
  cloud: boolean
}

export interface SystemInfo {
  os: string
  hostname: string
  uptimeSeconds: number
  cpu: { model: string; cores: number; loadPercent: number }
  memory: { totalBytes: number; freeBytes: number; usedPercent: number }
  disks: { drive: string; totalBytes: number; freeBytes: number }[]
  battery?: { percent: number; charging: boolean }
  gpu?: string[]
  network: { online: boolean; interfaces: { name: string; address: string }[] }
}

export interface ProcessInfo {
  pid: number
  name: string
  memoryBytes: number
  cpuSeconds: number
}

export interface AppEntry {
  name: string
  target: string
  source: 'start-menu' | 'path' | 'uwp' | 'alias'
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  sizeBytes: number
  modifiedMs: number
}

/**
 * What the updater actually knows. `configured` is false when no feed URL is
 * set, and `supported` is false in development, where there is no installer to
 * replace -- both are reported rather than dressed up as "up to date".
 */
export interface UpdateState {
  supported: boolean
  configured: boolean
  enabled: boolean
  currentVersion: string
  feedUrl: string
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  availableVersion?: string
  releaseNotes?: string
  downloadPercent?: number
  message?: string
  checkedMs?: number
}
