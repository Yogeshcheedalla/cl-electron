/**
 * Single source of truth for the renderer <-> main bridge.
 *
 * `API_SHAPE` drives both the preload whitelist and (via a test) the set of
 * handlers the main process must register. Channel name is always `ns:method`.
 */
export const API_SHAPE = {
  window: ['minimize', 'toggleMaximize', 'close', 'hide'],
  settings: ['get', 'update', 'resetSection'],
  system: ['getInfo', 'processes', 'control'],
  apps: ['list', 'launch', 'close', 'focus', 'openUrl', 'openPath', 'pickFolder'],
  files: ['list', 'search', 'read', 'write', 'mkdir', 'rename', 'copy', 'move', 'remove'],
  terminal: ['execute', 'cancel', 'classify'],
  ai: ['send', 'cancel', 'providers', 'setKey', 'clearKey', 'test', 'usage'],
  conversations: ['list', 'create', 'rename', 'remove', 'messages', 'search', 'exportText'],
  tasks: ['list', 'create', 'update', 'remove', 'run'],
  memory: ['list', 'search', 'create', 'update', 'remove', 'clear'],
  automations: ['list', 'save', 'remove', 'run', 'dryRun'],
  knowledge: ['folders', 'addFolder', 'removeFolder', 'reindex', 'search'],
  web: ['search', 'fetchPage'],
  git: ['status', 'diff', 'log', 'commit'],
  documents: ['read'],
  clipboardApi: ['read', 'write', 'clear', 'history'],
  notifications: ['list', 'markRead', 'clear'],
  approvals: ['list', 'resolve'],
  activity: ['list', 'clear'],
  diagnostics: ['run', 'logs'],
  skills: ['list', 'setEnabled'],
  tools: ['list', 'setPermission', 'invoke'],
  voice: ['transcribe', 'capabilities'],
  computer: ['windows', 'screenshot', 'capabilities'],
  updates: ['state', 'check', 'download', 'install']
} as const

export type ApiShape = typeof API_SHAPE

/** Flat `ns:method` channel list. */
export const CHANNELS: string[] = Object.entries(API_SHAPE).flatMap(([ns, methods]) =>
  (methods as readonly string[]).map((m) => `${ns}:${m}`)
)

/** Every main -> renderer push travels on this one channel. */
export const EVENT_CHANNEL = 'akansha:event'

export type AkanshaEvent =
  | { type: 'ai:delta'; runId: string; text: string }
  | { type: 'ai:done'; runId: string; message: string; meta?: unknown }
  | { type: 'ai:error'; runId: string; message: string }
  | { type: 'ai:tool'; runId: string; tool: string; phase: 'start' | 'end'; ok?: boolean; detail?: string }
  | { type: 'ai:plan'; runId: string; steps: unknown[] }
  | { type: 'state'; state: string }
  | { type: 'activity'; entry: unknown }
  | { type: 'approval'; request: unknown }
  | { type: 'approval:resolved'; id: string }
  | { type: 'notification'; notification: unknown }
  | { type: 'task'; task: unknown }
  | { type: 'system'; info: unknown }
  | { type: 'voice:command'; action: 'start' | 'stop' }
  | { type: 'navigate'; page: string }
  | { type: 'terminal:output'; execId: string; chunk: string }
