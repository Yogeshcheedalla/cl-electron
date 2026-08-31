import type {
  AppEntry,
  FileEntry,
  PermissionLevel,
  ProcessInfo,
  ProviderConfig,
  Settings,
  SystemInfo,
  ToolResult,
  UpdateState,
  VoiceCapabilities
} from './types'
import type {
  ActivityEntry,
  ApprovalRequest,
  Automation,
  Conversation,
  DryRun,
  HealthCheck,
  AkanshaNotification,
  KnowledgeFolder,
  KnowledgeHit,
  Memory,
  StoredMessage,
  Task,
  UsageEntry
} from './records'
import type { AkanshaEvent } from './ipc'

export type R<T> = Promise<ToolResult<T>>

export interface ToolDescriptor {
  name: string
  description: string
  level: PermissionLevel
  effectiveLevel: PermissionLevel
  group: string
}

export interface TerminalResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export interface SendPayload {
  conversationId?: string
  text: string
  attachments?: { name: string; mimeType: string; base64: string }[]
  /** Force a response mode instead of letting Akansha decide. */
  mode?: 'auto' | 'answer' | 'research'
}

export interface AkanshaApi {
  window: {
    minimize(): R<null>
    toggleMaximize(): R<null>
    close(): R<null>
    hide(): R<null>
  }
  settings: {
    get(): R<Settings>
    update(patch: Partial<Settings>): R<Settings>
    resetSection(section: keyof Settings): R<Settings>
  }
  system: {
    getInfo(): R<SystemInfo>
    processes(limit?: number): R<ProcessInfo[]>
    control(action: string, value?: number): R<{ action: string; detail: string }>
  }
  apps: {
    list(refresh?: boolean): R<AppEntry[]>
    launch(name: string): R<{ launched: string; pid?: number }>
    close(name: string): R<{ closed: number }>
    focus(name: string): R<{ focused: boolean }>
    openUrl(url: string): R<{ url: string }>
    openPath(path: string): R<{ path: string }>
    pickFolder(): R<{ path: string | null }>
  }
  files: {
    list(dir: string): R<FileEntry[]>
    search(root: string, query: string, limit?: number): R<FileEntry[]>
    read(path: string, maxBytes?: number): R<{ path: string; content: string; truncated: boolean }>
    write(path: string, content: string, overwrite?: boolean): R<{ path: string; bytes: number }>
    mkdir(path: string): R<{ path: string }>
    rename(path: string, newName: string): R<{ path: string }>
    copy(from: string, to: string): R<{ path: string }>
    move(from: string, to: string): R<{ path: string }>
    remove(path: string, recursive?: boolean): R<{ path: string }>
  }
  terminal: {
    execute(command: string, cwd?: string, timeoutMs?: number): R<TerminalResult>
    cancel(execId: string): R<null>
    classify(command: string): R<{ level: PermissionLevel; reason: string }>
  }
  ai: {
    send(payload: SendPayload): R<{ runId: string; conversationId: string }>
    cancel(runId: string): R<null>
    providers(): R<ProviderConfig[]>
    setKey(provider: string, key: string): R<null>
    clearKey(provider: string): R<null>
    test(provider: string): R<{ ok: boolean; detail: string }>
    usage(days?: number): R<{ entries: UsageEntry[]; totals: Record<string, number> }>
  }
  conversations: {
    list(limit?: number): R<Conversation[]>
    create(title?: string): R<Conversation>
    rename(id: string, title: string): R<null>
    remove(id: string): R<null>
    messages(id: string): R<StoredMessage[]>
    search(query: string): R<{ conversation: Conversation; snippet: string }[]>
    exportText(id: string): R<{ path: string }>
  }
  tasks: {
    list(): R<Task[]>
    create(task: Partial<Task>): R<Task>
    update(id: string, patch: Partial<Task>): R<Task>
    remove(id: string): R<null>
    run(id: string): R<{ state: string }>
  }
  memory: {
    list(): R<Memory[]>
    search(query: string): R<Memory[]>
    create(memory: Partial<Memory>): R<Memory>
    update(id: string, patch: Partial<Memory>): R<Memory>
    remove(id: string): R<null>
    clear(): R<{ removed: number }>
  }
  automations: {
    list(): R<Automation[]>
    save(automation: Automation): R<Automation>
    remove(id: string): R<null>
    run(id: string): R<{ ok: boolean; log: string[] }>
    /** Reports what `run` would do -- resolves, validates and gates every step, executes none. */
    dryRun(id: string): R<DryRun>
  }
  knowledge: {
    folders(): R<KnowledgeFolder[]>
    addFolder(path: string): R<KnowledgeFolder>
    removeFolder(id: string): R<null>
    reindex(id?: string): R<{ files: number; chunks: number; embedded: number; embedNote?: string }>
    search(query: string, limit?: number): R<KnowledgeHit[]>
  }
  web: {
    search(query: string, limit?: number): R<{ title: string; url: string; snippet: string }[]>
    fetchPage(url: string): R<{ url: string; title: string; text: string }>
  }
  git: {
    status(repo: string): R<{ branch: string; files: string[]; clean: boolean }>
    diff(repo: string, staged?: boolean): R<{ diff: string }>
    log(repo: string, limit?: number): R<{ entries: string[] }>
    commit(repo: string, message: string, addAll?: boolean): R<{ commit: string }>
  }
  documents: {
    read(path: string): R<{ path: string; kind: string; text: string; truncated: boolean }>
  }
  clipboardApi: {
    read(): R<{ text: string }>
    write(text: string): R<null>
    clear(): R<null>
    history(): R<{ ts: number; text: string }[]>
  }
  notifications: {
    list(): R<AkanshaNotification[]>
    markRead(id?: string): R<null>
    clear(): R<null>
  }
  approvals: {
    list(): R<ApprovalRequest[]>
    resolve(id: string, decision: 'once' | 'always' | 'deny'): R<null>
  }
  activity: {
    list(limit?: number): R<ActivityEntry[]>
    clear(): R<null>
  }
  diagnostics: {
    run(): R<HealthCheck[]>
    logs(lines?: number): R<{ text: string; path: string }>
  }
  skills: {
    list(): R<{ name: string; description: string; version: string; enabled: boolean; permissions: Record<string, boolean>; tools: string[] }[]>
    setEnabled(name: string, enabled: boolean): R<null>
  }
  tools: {
    list(): R<ToolDescriptor[]>
    setPermission(name: string, level: PermissionLevel): R<null>
    invoke(name: string, input: Record<string, unknown>): R<unknown>
  }
  voice: {
    transcribe(audio: { base64: string; mimeType: string }): R<{ text: string; engine: 'local' | 'openai' }>
    capabilities(): R<VoiceCapabilities>
  }
  computer: {
    windows(): R<{ title: string; processName: string; pid: number }[]>
    screenshot(): R<{ base64: string; width: number; height: number }>
    capabilities(): R<{ screen: boolean; input: boolean; detail: string }>
  }
  updates: {
    state(): R<UpdateState>
    check(): R<UpdateState>
    download(): R<UpdateState>
    /** Quits Akansha and runs the downloaded installer. Confirmed every time. */
    install(): R<UpdateState>
  }
  onEvent(listener: (event: AkanshaEvent) => void): () => void
}
