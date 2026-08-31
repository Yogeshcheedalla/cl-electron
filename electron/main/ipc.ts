import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { audit } from '../core/audit'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { attempt, describeError, now } from '../core/util'
import { CHANNELS } from '../../shared/ipc'
import { activity, notifications, usage } from '../db/log.repo'
import { conversations, messages } from '../db/chat.repo'
import { automations, memories, tasks } from '../db/state.repo'
import { getTool, invokeTool, toolDescriptors } from '../agents/tools'
import { orchestrator } from '../ai/orchestrator'
import { provider, providerBaseUrl, providerIds } from '../ai/providers'
import { probeOllama } from '../ai/ollama'
import { approvals } from '../services/approvals'
import { apps } from '../services/apps'
import { automationEngine } from '../services/automation'
import { clipboardService, startClipboardWatcher, stopClipboardWatcher } from '../services/clipboard'
import { classifyCommand } from '../services/command-validator'
import { computer } from '../services/computer'
import { diagnostics } from '../services/diagnostics'
import { documents } from '../services/documents'
import { files } from '../services/files'
import { gitService } from '../services/git'
import { authorize } from '../services/guard'
import { knowledgeService } from '../services/knowledge'
import { setToolLevel } from '../services/permissions'
import { runTask } from '../services/scheduler'
import { secrets } from '../services/secrets'
import { settings } from '../services/settings'
import { skills } from '../services/skills'
import { syncLoginItem } from '../services/startup'
import { localStt } from '../services/stt-local'
import { system } from '../services/system'
import { terminal } from '../services/terminal'
import { updates } from '../services/updates'
import { voice } from '../services/voice'
import { web } from '../services/web'
import { registerShortcuts } from './shortcuts'
import { mainWindow } from './windows'
import type { Automation, AutomationStep, Memory, Task } from '../../shared/records'
import type { PermissionLevel, ProviderConfig, ProviderId, Settings } from '../../shared/types'

/**
 * Every renderer request lands here. A handler validates its arguments, applies
 * the permission layer where the action can change the machine, calls one
 * service, and returns a `ToolResult` -- failures included, never a throw across
 * the bridge. Destructive actions are delegated to the tool registry so the UI
 * and the model go through exactly the same approval path.
 */

const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
const LEVELS: PermissionLevel[] = ['SAFE', 'CONFIRM', 'PRIVILEGED', 'BLOCKED']
const POWER_ACTIONS = new Set(['shutdown', 'restart', 'signout', 'sleep'])
const TASK_STATES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']
const REPEATS = ['none', 'hourly', 'daily', 'weekly']
const CATEGORIES = ['PREFERENCE', 'PROJECT', 'GOAL', 'FACT', 'WORKFLOW', 'COMMAND']

const registered = new Set<string>()

type Handler = (args: unknown[], event: IpcMainInvokeEvent) => unknown

function handle(channel: string, code: string, fn: Handler) {
  registered.add(channel)
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const started = now()
    const result = await attempt(code, () => fn(args, event))
    if (!result.success) logger.warn('ipc.failed', { channel, message: result.error?.message })
    else if (now() - started > 5000) logger.debug('ipc.slow', { channel, ms: now() - started })
    return result
  })
}

function str(value: unknown, name: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  if (value.length > max) throw new Error(`${name} is longer than the ${max}-character limit.`)
  return value
}

const optionalStr = (value: unknown, name: string, max = 8000): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : str(value, name, max)

function int(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`)
  return Math.min(max, Math.max(min, Math.round(n)))
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`)
  return value as Record<string, unknown>
}

const yes = (value: unknown) => value === true

function oneOf<T extends string>(value: unknown, allowed: readonly string[], name: string): T {
  const found = str(value, name, 60)
  if (!allowed.includes(found)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`)
  return found as T
}

function providerOf(value: unknown): ProviderId {
  const id = str(value, 'provider', 40) as ProviderId
  if (!providerIds.includes(id)) throw new Error(`Unknown provider "${id}". Known: ${providerIds.join(', ')}.`)
  return id
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow()
  if (!win) throw new Error('No Akansha window is open.')
  return win
}

function attachment(raw: unknown) {
  const a = record(raw, 'attachment')
  const base64 = str(a.base64, 'attachment data', 24_000_000)
  if (Buffer.byteLength(base64, 'base64') > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachments are limited to 12 MB each.')
  }
  return {
    name: str(a.name, 'attachment name', 260),
    mimeType: str(a.mimeType, 'attachment type', 200),
    base64
  }
}

function taskPatch(raw: unknown): Partial<Task> {
  const t = record(raw, 'task')
  const out: Partial<Task> = {}
  if (t.title !== undefined) out.title = str(t.title, 'task title', 300)
  if (t.detail !== undefined) out.detail = String(t.detail ?? '').slice(0, 4000)
  if (t.state !== undefined) out.state = oneOf<Task['state']>(t.state, TASK_STATES, 'task state')
  if (t.repeat !== undefined) out.repeat = oneOf<Task['repeat']>(t.repeat, REPEATS, 'repeat')
  if (t.dueMs !== undefined && t.dueMs !== null) {
    out.dueMs = int(t.dueMs, 'due time', 0, Number.MAX_SAFE_INTEGER, 0)
  }
  if (t.automationId !== undefined && t.automationId !== null) {
    const aid = optionalStr(t.automationId, 'automation id', 80)
    if (aid && !automations.get(aid)) throw new Error('That automation no longer exists.')
    if (aid) out.automationId = aid
  }
  return out
}

function memoryPatch(raw: unknown): Partial<Memory> {
  const m = record(raw, 'memory')
  const out: Partial<Memory> = {}
  if (m.content !== undefined) out.content = str(m.content, 'memory content', 4000)
  if (m.category !== undefined) out.category = oneOf<Memory['category']>(m.category, CATEGORIES, 'category')
  if (m.confidence !== undefined) {
    out.confidence = oneOf<Memory['confidence']>(m.confidence, ['low', 'medium', 'high'], 'confidence')
  }
  if (m.source !== undefined) out.source = String(m.source ?? 'user').slice(0, 120)
  return out
}

/** Steps may only reference tools that exist, so a saved automation cannot fail blind. */
function automationFrom(raw: unknown): Automation {
  const a = record(raw, 'automation')
  const steps = Array.isArray(a.steps) ? a.steps : []
  if (!steps.length) throw new Error('An automation needs at least one step.')
  if (steps.length > 40) throw new Error('Automations are limited to 40 steps.')
  const trigger = record(a.trigger ?? { type: 'manual' }, 'trigger')
  const triggerValue = optionalStr(trigger.value, 'trigger value', 200)
  return {
    id: optionalStr(a.id, 'automation id', 80) ?? '',
    name: str(a.name, 'automation name', 120),
    description: String(a.description ?? '').slice(0, 1000),
    trigger: {
      type: oneOf<'manual' | 'event' | 'schedule'>(
        trigger.type ?? 'manual',
        ['manual', 'event', 'schedule'],
        'trigger type'
      ),
      ...(triggerValue ? { value: triggerValue } : {})
    },
    steps: steps.map((raw): AutomationStep => {
      const s = record(raw, 'step')
      const tool = str(s.tool, 'step tool', 80)
      if (!getTool(tool)) throw new Error(`Step tool "${tool}" does not exist in Akansha.`)
      return {
        tool,
        input: s.input === undefined ? {} : record(s.input, `input for ${tool}`),
        ...(s.requiresPrevious === false ? { requiresPrevious: false } : {})
      }
    }),
    enabled: a.enabled !== false
  }
}

/**
 * Continuous listening is the one setting the main process refuses on the
 * renderer's behalf. Arming it opens the microphone until it is switched off, so
 * two conditions are checked here rather than trusted to the window: privacy mode
 * must be off, and whisper.cpp must actually be usable -- an always-on microphone
 * feeding a cloud recogniser would upload every sound in the room.
 */
async function guardWakeWord(before: Settings, patch: Partial<Settings>) {
  if (patch.voice?.wakeWordEnabled !== true || before.voice.wakeWordEnabled) return
  // The patch is checked as it will be, not as it is: turning privacy mode off and
  // the microphone on in one call must not slip past the privacy test.
  const privacy = { ...before.privacy, ...(patch.privacy ?? {}) }
  if (privacy.privacyMode) {
    throw new Error('Privacy mode is on, so continuous listening cannot be switched on. Turn privacy mode off first.')
  }
  const local = await localStt.status()
  if (!local.ready) {
    throw new Error(
      `Continuous listening needs whisper.cpp on this machine so clips are transcribed here and deleted: ${local.detail}`
    )
  }
  logger.info('voice.wakeArmed', { phrase: before.voice.wakeWord })
  audit({ kind: 'system', label: 'Continuous listening switched on (microphone stays open)', ok: true })
}

/** Settings changes that touch the OS are applied immediately, never silently. */
function applySideEffects(before: Settings, after: Settings) {
  if (
    before.general.startWithWindows !== after.general.startWithWindows ||
    before.general.startMinimized !== after.general.startMinimized
  ) {
    syncLoginItem()
  }
  if (
    before.keyboard.globalShortcut !== after.keyboard.globalShortcut ||
    before.keyboard.commandPalette !== after.keyboard.commandPalette
  ) {
    registerShortcuts()
  }
  const wants = after.privacy.clipboardAccess && !after.privacy.privacyMode
  const had = before.privacy.clipboardAccess && !before.privacy.privacyMode
  if (wants !== had) {
    if (wants) startClipboardWatcher()
    else stopClipboardWatcher()
  }
}

export function registerIpc() {
  // --- Window chrome (frameless titlebar buttons) -------------------------
  handle('window:minimize', 'WINDOW', (_a, e) => {
    senderWindow(e).minimize()
    return null
  })
  handle('window:toggleMaximize', 'WINDOW', (_a, e) => {
    const win = senderWindow(e)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return null
  })
  handle('window:close', 'WINDOW', (_a, e) => {
    senderWindow(e).close()
    return null
  })
  handle('window:hide', 'WINDOW', (_a, e) => {
    senderWindow(e).hide()
    return null
  })

  // --- Settings ----------------------------------------------------------
  handle('settings:get', 'SETTINGS', () => settings.get())
  handle('settings:update', 'SETTINGS', async (args) => {
    const patch = record(args[0], 'settings patch') as Partial<Settings>
    const before = settings.get()
    await guardWakeWord(before, patch)
    const after = settings.update(patch)
    applySideEffects(before, after)
    if (before.voice.wakeWordEnabled && !after.voice.wakeWordEnabled) {
      logger.info('voice.wakeDisarmed', {})
      audit({ kind: 'system', label: 'Continuous listening switched off', ok: true })
    }
    audit({ kind: 'system', label: `Settings updated (${Object.keys(patch).join(', ')})`, ok: true })
    return after
  })
  handle('settings:resetSection', 'SETTINGS', (args) => {
    const section = str(args[0], 'section', 40) as keyof Settings
    if (!(section in settings.get())) throw new Error(`Unknown settings section "${String(section)}".`)
    const before = settings.get()
    const after = settings.resetSection(section)
    applySideEffects(before, after)
    return after
  })

  // --- System and apps ---------------------------------------------------
  handle('system:getInfo', 'SYSTEM', () => system.info())
  handle('system:processes', 'SYSTEM', (args) => system.processes(int(args[0], 'limit', 1, 200, 40)))
  handle('system:control', 'SYSTEM', async (args) => {
    const action = str(args[0], 'action', 40).toLowerCase()
    const value = args[1] === undefined ? undefined : int(args[1], 'value', 0, 100, 50)
    if (POWER_ACTIONS.has(action)) {
      await authorize({
        tool: 'system.control',
        declared: 'PRIVILEGED',
        summary: `${action} this PC`,
        reason: 'Power actions close your open applications.',
        input: { action }
      })
    }
    const detail = await system.control(action, value)
    audit({ kind: 'system', label: `System ${action}`, detail, ok: true })
    return { action, detail }
  })

  handle('apps:list', 'APPS', (args) => apps.list(yes(args[0])))
  handle('apps:launch', 'APPS', (args) => apps.launch(str(args[0], 'application name', 200)))
  handle('apps:close', 'APPS', (args) =>
    invokeTool('app.close', { name: str(args[0], 'application name', 200) }, { source: 'ui' })
  )
  handle('apps:focus', 'APPS', (args) => apps.focus(str(args[0], 'application name', 200)))
  handle('apps:openUrl', 'APPS', (args) => apps.openUrl(str(args[0], 'url', 2000)))
  handle('apps:openPath', 'APPS', (args) => apps.openPath(str(args[0], 'path', 1000)))
  handle('apps:pickFolder', 'APPS', () => apps.pickFolder())

  // --- Files (writes and deletes go through the tool registry) -----------
  handle('files:list', 'FILES', (args) => files.list(str(args[0], 'folder', 1000)))
  handle('files:search', 'FILES', (args) =>
    files.search(str(args[0], 'folder', 1000), str(args[1], 'query', 200), int(args[2], 'limit', 1, 500, 60))
  )
  handle('files:read', 'FILES', (args) =>
    files.read(str(args[0], 'path', 1000), int(args[1], 'maxBytes', 1000, 2_000_000, 200_000))
  )
  handle('files:mkdir', 'FILES', (args) => files.mkdir(str(args[0], 'path', 1000)))
  handle('files:copy', 'FILES', (args) => files.copy(str(args[0], 'source', 1000), str(args[1], 'target', 1000)))
  handle('files:write', 'FILES', (args) =>
    invokeTool(
      'file.write',
      { path: str(args[0], 'path', 1000), content: String(args[1] ?? ''), overwrite: yes(args[2]) },
      { source: 'ui' }
    )
  )

  handle('files:rename', 'FILES', (args) =>
    invokeTool(
      'file.rename',
      { path: str(args[0], 'path', 1000), newName: str(args[1], 'new name', 260) },
      { source: 'ui' }
    )
  )
  handle('files:move', 'FILES', (args) =>
    invokeTool('file.move', { from: str(args[0], 'source', 1000), to: str(args[1], 'target', 1000) }, { source: 'ui' })
  )
  handle('files:remove', 'FILES', (args) =>
    invokeTool('file.remove', { path: str(args[0], 'path', 1000), recursive: yes(args[1]) }, { source: 'ui' })
  )
  handle('documents:read', 'DOCUMENT', (args) => documents.read(str(args[0], 'path', 1000)))

  // --- Terminal (classified, then confirmed by the permission layer) ------
  handle('terminal:execute', 'TERMINAL', (args) =>
    terminal.execute(
      str(args[0], 'command', 4000),
      optionalStr(args[1], 'working folder', 1000),
      int(args[2], 'timeout', 1000, 600_000, 60_000)
    )
  )
  handle('terminal:cancel', 'TERMINAL', (args) => terminal.cancel(str(args[0], 'execution id', 120)))
  handle('terminal:classify', 'TERMINAL', (args) => classifyCommand(str(args[0], 'command', 4000)))

  // --- AI ----------------------------------------------------------------
  handle('ai:send', 'AI', (args) => {
    const payload = record(args[0], 'message')
    const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).slice(0, 8).map(attachment)
    const text = String(payload.text ?? '')
    if (text.length > 200_000) throw new Error('That message is too long to send (200,000 character limit).')
    return orchestrator.send({
      text,
      attachments,
      mode: payload.mode === 'answer' || payload.mode === 'research' ? payload.mode : 'auto',
      ...(optionalStr(payload.conversationId, 'conversation id', 80)
        ? { conversationId: String(payload.conversationId) }
        : {})
    })
  })
  handle('ai:cancel', 'AI', (args) => {
    orchestrator.cancel(str(args[0], 'run id', 80))
    return null
  })
  handle('ai:providers', 'AI', async () => {
    const routing = Object.values(settings.get().ai.routing)
    // The local runner is probed here rather than trusted: Settings must be able
    // to say installed / running / model pulled, not just "no key needed".
    const local = await probeOllama(providerBaseUrl('ollama'), settings.get().ai.routing.LOCAL.model)
    return providerIds.map(
      (id): ProviderConfig => ({
        id,
        enabled: !provider(id).unavailable(),
        baseUrl: providerBaseUrl(id),
        model: routing.find((r) => r.provider === id)?.model ?? '',
        hasApiKey: secrets.has(id),
        ...(id === 'ollama' ? { local } : {})
      })
    )
  })

  handle('ai:setKey', 'AI', (args) => {
    const id = providerOf(args[0])
    secrets.set(id, str(args[1], 'API key', 500))
    audit({ kind: 'system', label: `Saved the ${id} API key`, ok: true })
    return null
  })
  handle('ai:clearKey', 'AI', (args) => {
    const id = providerOf(args[0])
    secrets.clear(id)
    audit({ kind: 'system', label: `Removed the ${id} API key`, ok: true })
    return null
  })
  handle('ai:test', 'AI', async (args) => {
    const id = providerOf(args[0])
    try {
      return { ok: true, detail: await provider(id).test() }
    } catch (e) {
      return { ok: false, detail: describeError(e) }
    }
  })
  handle('ai:usage', 'AI', (args) => {
    const days = int(args[0], 'days', 1, 365, 30)
    const entries = usage.since(now() - days * 86_400_000)
    const totals = entries.reduce<Record<string, number>>(
      (acc, e) => ({
        calls: (acc.calls ?? 0) + 1,
        failures: (acc.failures ?? 0) + (e.failed ? 1 : 0),
        inputTokens: (acc.inputTokens ?? 0) + e.inputTokens,
        outputTokens: (acc.outputTokens ?? 0) + e.outputTokens,
        estimatedCostUsd: Number(((acc.estimatedCostUsd ?? 0) + e.estimatedCostUsd).toFixed(6)),
        latencyMsAvg: Math.round(
          ((acc.latencyMsAvg ?? 0) * ((acc.calls ?? 0) / ((acc.calls ?? 0) + 1))) + e.latencyMs / ((acc.calls ?? 0) + 1)
        )
      }),
      {}
    )
    return { entries, totals }
  })

  // --- Conversations -----------------------------------------------------
  handle('conversations:list', 'CHAT', (args) => conversations.list(int(args[0], 'limit', 1, 500, 60)))
  handle('conversations:create', 'CHAT', (args) =>
    conversations.create(optionalStr(args[0], 'title', 200) ?? 'New conversation')
  )
  handle('conversations:rename', 'CHAT', (args) => {
    conversations.rename(str(args[0], 'conversation id', 80), str(args[1], 'title', 200))
    return null
  })
  handle('conversations:remove', 'CHAT', (args) => {
    conversations.remove(str(args[0], 'conversation id', 80))
    return null
  })
  handle('conversations:messages', 'CHAT', (args) => messages.list(str(args[0], 'conversation id', 80)))
  handle('conversations:search', 'CHAT', (args) => conversations.search(str(args[0], 'query', 200)))
  handle('conversations:exportText', 'CHAT', async (args, event) => {
    const cid = str(args[0], 'conversation id', 80)
    const convo = conversations.get(cid)
    if (!convo) throw new Error('That conversation no longer exists.')
    const rows = messages.list(cid)
    const safe = convo.title.replace(/[^\w .-]+/g, '_').slice(0, 80) || 'conversation'
    const picked = await dialog.showSaveDialog(senderWindow(event), {
      title: 'Export conversation',
      defaultPath: join(app.getPath('documents'), `${safe}.txt`),
      filters: [{ name: 'Text file', extensions: ['txt'] }]
    })
    if (picked.canceled || !picked.filePath) throw new Error('Export cancelled.')
    const body = rows
      .map((m) => `[${new Date(m.createdMs).toLocaleString()}] ${m.role.toUpperCase()}\n${m.content}`)
      .join('\n\n')
    writeFileSync(picked.filePath, `${convo.title}\n${'='.repeat(convo.title.length)}\n\n${body}\n`, 'utf8')
    audit({ kind: 'system', label: `Exported conversation "${convo.title}"`, detail: picked.filePath, ok: true })
    return { path: picked.filePath }
  })

  // --- Tasks -------------------------------------------------------------
  handle('tasks:list', 'TASK', () => tasks.list())
  handle('tasks:create', 'TASK', (args) => {
    const patch = taskPatch(args[0])
    if (!patch.title) throw new Error('A task needs a title.')
    const task = tasks.create(patch)
    audit({ kind: 'system', label: `Task created: ${task.title}`, ok: true })
    bus.emitToUi({ type: 'task', task })
    return task
  })
  handle('tasks:update', 'TASK', (args) => {
    const tid = str(args[0], 'task id', 80)
    const next = tasks.update(tid, taskPatch(args[1]))
    if (!next) throw new Error('That task no longer exists.')
    bus.emitToUi({ type: 'task', task: next })
    return next
  })
  handle('tasks:remove', 'TASK', (args) => {
    const tid = str(args[0], 'task id', 80)
    const existing = tasks.get(tid)
    if (!existing) throw new Error('That task no longer exists.')
    tasks.remove(tid)
    audit({ kind: 'system', label: `Task deleted: ${existing.title}`, ok: true })
    bus.emitToUi({ type: 'task', task: { ...existing, state: 'CANCELLED' } })
    return null
  })
  handle('tasks:run', 'TASK', (args) => runTask(str(args[0], 'task id', 80)))

  // --- Memory ------------------------------------------------------------
  handle('memory:list', 'MEMORY', () => memories.list())
  handle('memory:search', 'MEMORY', (args) => memories.search(str(args[0], 'query', 200)))
  handle('memory:create', 'MEMORY', (args) => {
    const patch = memoryPatch(args[0])
    if (!patch.content) throw new Error('A memory needs content.')
    return memories.create(patch)
  })
  handle('memory:update', 'MEMORY', (args) => {
    const next = memories.update(str(args[0], 'memory id', 80), memoryPatch(args[1]))
    if (!next) throw new Error('That memory no longer exists.')
    return next
  })
  handle('memory:remove', 'MEMORY', (args) => {
    memories.remove(str(args[0], 'memory id', 80))
    return null
  })
  // Clearing everything Akansha remembers is not reversible, so it needs approval.
  handle('memory:clear', 'MEMORY', async () => {
    await authorize({
      tool: 'memory.clear',
      declared: 'CONFIRM',
      summary: `forget all ${memories.list().length} stored memories`,
      reason: 'Deleted memories cannot be recovered.',
      input: {}
    })
    const removed = memories.clear()
    audit({ kind: 'system', label: `Cleared ${removed} memories`, ok: true })
    return { removed }
  })

  // --- Automations --------------------------------------------------------
  handle('automations:list', 'AUTOMATION', () => automationEngine.list())
  handle('automations:save', 'AUTOMATION', (args) => automationEngine.save(automationFrom(args[0])))
  handle('automations:remove', 'AUTOMATION', (args) => automationEngine.remove(str(args[0], 'automation id', 80)))
  handle('automations:run', 'AUTOMATION', (args) => automationEngine.run(str(args[0], 'automation id', 80)))
  // Read-only by construction: it resolves and gates every step, executes none.
  handle('automations:dryRun', 'AUTOMATION', (args) =>
    automationEngine.dryRun(str(args[0], 'automation id', 80))
  )

  // --- Knowledge ---------------------------------------------------------
  handle('knowledge:folders', 'KNOWLEDGE', () => knowledgeService.folders())
  handle('knowledge:addFolder', 'KNOWLEDGE', (args) => knowledgeService.addFolder(str(args[0], 'folder', 1000)))
  handle('knowledge:removeFolder', 'KNOWLEDGE', (args) =>
    knowledgeService.removeFolder(str(args[0], 'folder id', 80))
  )
  handle('knowledge:reindex', 'KNOWLEDGE', (args) => knowledgeService.reindex(optionalStr(args[0], 'folder id', 80)))
  handle('knowledge:search', 'KNOWLEDGE', (args) =>
    knowledgeService.search(str(args[0], 'query', 500), int(args[1], 'limit', 1, 50, 8))
  )

  // --- Web ---------------------------------------------------------------
  handle('web:search', 'WEB', (args) => web.search(str(args[0], 'query', 500), int(args[1], 'limit', 1, 20, 6)))
  handle('web:fetchPage', 'WEB', (args) => web.fetchPage(str(args[0], 'url', 2000)))

  // --- Git (commit is the only write, and it goes through the tool) -------
  handle('git:status', 'GIT', (args) => gitService.status(str(args[0], 'repository', 1000)))
  handle('git:diff', 'GIT', (args) => gitService.diff(str(args[0], 'repository', 1000), yes(args[1])))
  handle('git:log', 'GIT', (args) => gitService.log(str(args[0], 'repository', 1000), int(args[1], 'limit', 1, 200, 20)))
  handle('git:commit', 'GIT', (args) =>
    invokeTool(
      'git.commit',
      {
        repo: str(args[0], 'repository', 1000),
        message: str(args[1], 'commit message', 2000),
        addAll: yes(args[2])
      },
      { source: 'ui' }
    )
  )

  // --- Clipboard (watcher and reads honour privacy mode in the service) ---
  handle('clipboardApi:read', 'CLIPBOARD', () => clipboardService.read())
  handle('clipboardApi:write', 'CLIPBOARD', (args) => clipboardService.write(String(args[0] ?? '').slice(0, 100_000)))
  handle('clipboardApi:clear', 'CLIPBOARD', () => clipboardService.clear())
  handle('clipboardApi:history', 'CLIPBOARD', () => clipboardService.history())

  // --- Notifications, approvals, activity ---------------------------------
  handle('notifications:list', 'NOTIFY', () => notifications.list(200))
  handle('notifications:markRead', 'NOTIFY', (args) => {
    notifications.markRead(optionalStr(args[0], 'notification id', 80))
    return null
  })
  handle('notifications:clear', 'NOTIFY', () => {
    notifications.clear()
    return null
  })

  handle('approvals:list', 'APPROVAL', () => approvals.list())
  handle('approvals:resolve', 'APPROVAL', (args) => {
    const approvalId = str(args[0], 'approval id', 80)
    const decision = oneOf<'once' | 'always' | 'deny'>(args[1], ['once', 'always', 'deny'], 'decision')
    if (!approvals.resolve(approvalId, decision)) {
      throw new Error('That request already timed out or was answered elsewhere.')
    }
    return null
  })

  handle('activity:list', 'ACTIVITY', (args) => activity.list(int(args[0], 'limit', 1, 1000, 200)))
  handle('activity:clear', 'ACTIVITY', () => {
    activity.clear()
    audit({ kind: 'system', label: 'Activity history cleared', ok: true })
    return null
  })

  // --- Diagnostics and skills --------------------------------------------
  handle('diagnostics:run', 'DIAGNOSTIC', () => diagnostics.run())
  handle('diagnostics:logs', 'DIAGNOSTIC', (args) => diagnostics.logs(int(args[0], 'lines', 10, 5000, 400)))

  handle('skills:list', 'SKILL', () =>
    skills.list().map(({ instructions: _instructions, dir: _dir, ...rest }) => rest)
  )
  handle('skills:setEnabled', 'SKILL', (args) => skills.setEnabled(str(args[0], 'skill name', 120), yes(args[1])))

  // --- Tools (the same registry the model uses) ---------------------------
  handle('tools:list', 'TOOL', () => toolDescriptors())
  handle('tools:setPermission', 'TOOL', (args) => {
    const name = str(args[0], 'tool name', 80)
    if (!getTool(name)) throw new Error(`There is no tool called "${name}".`)
    const level = oneOf<PermissionLevel>(args[1], LEVELS, 'permission level')
    setToolLevel(name, level)
    audit({ kind: 'permission', label: `Tool ${name} set to ${level}`, ok: true })
    return null
  })
  handle('tools:invoke', 'TOOL', (args) =>
    invokeTool(str(args[0], 'tool name', 80), args[1] === undefined ? {} : record(args[1], 'tool input'), {
      source: 'ui'
    })
  )

  // --- Voice and screen ---------------------------------------------------
  handle('voice:transcribe', 'VOICE', (args) => {
    const audio = record(args[0], 'audio')
    const base64 = str(audio.base64, 'audio data', 96_000_000)
    // A ceiling on what crosses the bridge at all. Each engine then applies its
    // own real limit: 25 MB for OpenAI, far more for a local whisper.cpp run,
    // where 16 kHz mono WAV is bulkier than the webm the browser records.
    if (Buffer.byteLength(base64, 'base64') > 64 * 1024 * 1024) {
      throw new Error('That recording is larger than the 64 MB transcription limit.')
    }
    return voice.transcribe({ base64, mimeType: str(audio.mimeType, 'audio type', 120) })
  })
  handle('voice:capabilities', 'VOICE', () => voice.capabilities())

  handle('computer:windows', 'COMPUTER', () => computer.windows())
  handle('computer:screenshot', 'COMPUTER', () => computer.screenshot())
  handle('computer:capabilities', 'COMPUTER', () => computer.capabilities())

  // --- Updates ------------------------------------------------------------
  handle('updates:state', 'UPDATE', () => updates.state())
  handle('updates:check', 'UPDATE', () => updates.check())
  handle('updates:download', 'UPDATE', () => updates.download())
  // Installing quits Akansha and runs a downloaded installer, so it always asks.
  handle('updates:install', 'UPDATE', async () => {
    const state = updates.state()
    await authorize({
      tool: 'updates.install',
      declared: 'PRIVILEGED',
      summary: `quit Akansha and install version ${state.availableVersion ?? 'unknown'}`,
      reason: 'The running app closes and the downloaded installer takes over.',
      input: { version: state.availableVersion ?? '' }
    })
    const next = await updates.install()
    audit({ kind: 'system', label: `Installing update ${next.availableVersion ?? ''}`.trim(), ok: true })
    return next
  })
}

/** Fails loudly when a channel in API_SHAPE has no handler. */
export function assertHandlerCoverage(): string[] {
  const missing = CHANNELS.filter((c) => !registered.has(c))
  if (missing.length) logger.error('ipc.missingHandlers', { missing })
  return missing
}

export const registeredChannels = () => [...registered]
