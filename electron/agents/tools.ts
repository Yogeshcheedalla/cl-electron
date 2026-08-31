import { z } from 'zod'
import { truncate } from '../core/util'
import { audit } from '../core/audit'
import { memories, tasks } from '../db/state.repo'
import { apps } from '../services/apps'
import { clipboardService } from '../services/clipboard'
import { computer } from '../services/computer'
import { documents } from '../services/documents'
import { files } from '../services/files'
import { gitService } from '../services/git'
import { authorize } from '../services/guard'
import { knowledgeService } from '../services/knowledge'
import { notify } from '../services/notify'
import { effectiveLevel } from '../services/permissions'
import { system } from '../services/system'
import { terminal } from '../services/terminal'
import { web } from '../services/web'
import type { LlmTool } from '../ai/providers'
import type { ToolDescriptor } from '../../shared/api'
import type { PermissionLevel } from '../../shared/types'

export interface Tool {
  name: string
  description: string
  level: PermissionLevel
  group: string
  schema: z.ZodType
  /** The tool asks for its own approval (it classifies the request itself). */
  selfGuarded?: boolean
  summarize?: (input: Record<string, unknown>) => string
  run: (input: Record<string, unknown>) => Promise<unknown> | unknown
}

const S = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v))
const N = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : Number(v))
const B = (v: unknown): boolean => v === true || v === 'true'

const path = z.string().min(1).describe('Absolute Windows path')

export const TOOLS: Tool[] = [
  // -- system ---------------------------------------------------------------
  {
    name: 'system.info',
    description:
      'Read live system status: OS, uptime, CPU model and load, memory use, disk space, battery, GPU and network interfaces.',
    level: 'SAFE',
    group: 'System',
    schema: z.object({}),
    run: () => system.info()
  },
  {
    name: 'system.processes',
    description: 'List the top running processes by memory use.',
    level: 'SAFE',
    group: 'System',
    schema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    run: (i) => system.processes(N(i.limit) ?? 40)
  },
  {
    name: 'system.control',
    description:
      'Control the machine: lock, sleep, shutdown, restart, signout, volume-up, volume-down, volume-mute or brightness (value = percent for brightness, step count for volume).',
    level: 'PRIVILEGED',
    group: 'System',
    schema: z.object({
      action: z.enum([
        'lock',
        'sleep',
        'shutdown',
        'restart',
        'signout',
        'volume-up',
        'volume-down',
        'volume-mute',
        'brightness'
      ]),
      value: z.number().optional()
    }),
    summarize: (i) => `Run system action "${S(i.action)}"${i.value !== undefined ? ` with value ${S(i.value)}` : ''}`,
    run: (i) => system.control(S(i.action), N(i.value))
  },
  // -- applications ---------------------------------------------------------
  {
    name: 'app.list',
    description: 'List installed applications discovered from the Start Menu and the app folder.',
    level: 'SAFE',
    group: 'Applications',
    schema: z.object({ refresh: z.boolean().optional() }),
    run: (i) => apps.list(B(i.refresh))
  },
  {
    name: 'app.launch',
    description: 'Launch an installed application by name (fuzzy matched against the app index).',
    level: 'SAFE',
    group: 'Applications',
    schema: z.object({ name: z.string().min(1) }),
    run: (i) => apps.launch(S(i.name))
  },
  {
    name: 'app.close',
    description: 'Close a running application, asking its windows to close before killing it.',
    level: 'CONFIRM',
    group: 'Applications',
    schema: z.object({ name: z.string().min(1) }),
    summarize: (i) => `Close the application "${S(i.name)}" (unsaved work may be lost)`,
    run: (i) => apps.close(S(i.name))
  },
  {
    name: 'app.focus',
    description: 'Bring an application window to the foreground.',
    level: 'SAFE',
    group: 'Applications',
    schema: z.object({ name: z.string().min(1) }),
    run: (i) => apps.focus(S(i.name))
  },
  {
    name: 'app.openUrl',
    description: 'Open an http, https or mailto link in the default browser.',
    level: 'SAFE',
    group: 'Applications',
    schema: z.object({ url: z.string().min(1) }),
    run: (i) => apps.openUrl(S(i.url))
  },
  {
    name: 'app.openPath',
    description: 'Open a file or folder with its default Windows application.',
    level: 'SAFE',
    group: 'Applications',
    schema: z.object({ path }),
    run: (i) => apps.openPath(S(i.path))
  },
  // -- files ----------------------------------------------------------------
  {
    name: 'file.list',
    description: 'List the contents of a folder with sizes and modification times.',
    level: 'SAFE',
    group: 'Files',
    schema: z.object({ dir: path }),
    run: (i) => files.list(S(i.dir))
  },
  {
    name: 'file.search',
    description: 'Find files and folders whose name contains a term, searching a subtree.',
    level: 'SAFE',
    group: 'Files',
    schema: z.object({ root: path, query: z.string().min(1), limit: z.number().int().optional() }),
    run: (i) => files.search(S(i.root), S(i.query), N(i.limit) ?? 100)
  },
  {
    name: 'file.read',
    description: 'Read a text or code file. Use document.read for Word, Excel or PowerPoint files.',
    level: 'SAFE',
    group: 'Files',
    schema: z.object({ path, maxBytes: z.number().int().optional() }),
    run: (i) => files.read(S(i.path), N(i.maxBytes))
  },
  {
    name: 'file.write',
    description:
      'Create or replace a text file inside the allowed write roots. Set overwrite when replacing an existing file.',
    level: 'CONFIRM',
    group: 'Files',
    schema: z.object({ path, content: z.string(), overwrite: z.boolean().optional() }),
    summarize: (i) =>
      `${B(i.overwrite) ? 'Overwrite' : 'Create'} ${S(i.path)} with ${S(i.content).length} characters`,
    run: (i) => files.write(S(i.path), S(i.content), B(i.overwrite))
  },
  {
    name: 'file.mkdir',
    description: 'Create a folder (including parents) inside the allowed write roots.',
    level: 'SAFE',
    group: 'Files',
    schema: z.object({ path }),
    run: (i) => files.mkdir(S(i.path))
  },
  {
    name: 'file.rename',
    description: 'Rename a file or folder in place.',
    level: 'CONFIRM',
    group: 'Files',
    schema: z.object({ path, newName: z.string().min(1) }),
    summarize: (i) => `Rename ${S(i.path)} to "${S(i.newName)}"`,
    run: (i) => files.rename(S(i.path), S(i.newName))
  },
  {
    name: 'file.copy',
    description: 'Copy a file or folder to a new path that does not exist yet.',
    level: 'SAFE',
    group: 'Files',
    schema: z.object({ from: path, to: path }),
    run: (i) => files.copy(S(i.from), S(i.to))
  },
  {
    name: 'file.move',
    description: 'Move a file or folder to a new path that does not exist yet.',
    level: 'CONFIRM',
    group: 'Files',
    schema: z.object({ from: path, to: path }),
    summarize: (i) => `Move ${S(i.from)} to ${S(i.to)}`,
    run: (i) => files.move(S(i.from), S(i.to))
  },
  {
    name: 'file.remove',
    description:
      'Delete a file, or a folder when recursive is true. Deletion is permanent -- there is no recycle bin step.',
    level: 'CONFIRM',
    group: 'Files',
    schema: z.object({ path, recursive: z.boolean().optional() }),
    summarize: (i) =>
      `Permanently delete ${S(i.path)}${B(i.recursive) ? ' and everything inside it' : ''}`,
    run: (i) => files.remove(S(i.path), B(i.recursive))
  },
  {
    name: 'document.read',
    description: 'Extract text from a .docx, .xlsx, .pptx or plain-text document.',
    level: 'SAFE',
    group: 'Files',
    schema: z.object({ path }),
    run: (i) => documents.read(S(i.path))
  },
  // -- terminal -------------------------------------------------------------
  {
    name: 'terminal.run',
    description:
      'Run a PowerShell command and return stdout, stderr and the exit code. Destructive commands are classified and need approval; some are refused outright.',
    level: 'CONFIRM',
    group: 'Terminal',
    schema: z.object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().optional()
    }),
    // terminal.execute classifies the command itself and raises its own prompt.
    selfGuarded: true,
    run: (i) => terminal.execute(S(i.command), i.cwd ? S(i.cwd) : undefined, N(i.timeoutMs))
  },

  // -- knowledge, memory, web -----------------------------------------------
  {
    name: 'memory.save',
    description:
      'Remember a durable fact about the user, their projects, preferences or workflows so later sessions can use it.',
    level: 'SAFE',
    group: 'Memory',
    schema: z.object({
      content: z.string().min(3),
      category: z.enum(['PREFERENCE', 'PROJECT', 'GOAL', 'FACT', 'WORKFLOW', 'COMMAND']).optional(),
      confidence: z.enum(['low', 'medium', 'high']).optional()
    }),
    run: (i) =>
      memories.create({
        content: S(i.content),
        category: (i.category as 'FACT' | undefined) ?? 'FACT',
        confidence: (i.confidence as 'medium' | undefined) ?? 'medium',
        source: 'assistant'
      })
  },
  {
    name: 'memory.search',
    description: 'Look up previously remembered facts.',
    level: 'SAFE',
    group: 'Memory',
    schema: z.object({ query: z.string().min(1) }),
    run: (i) => memories.search(S(i.query))
  },
  {
    name: 'knowledge.search',
    description: 'Search the indexed knowledge folders for passages matching a query.',
    level: 'SAFE',
    group: 'Knowledge',
    schema: z.object({ query: z.string().min(1), limit: z.number().int().optional() }),
    run: (i) => knowledgeService.search(S(i.query), N(i.limit) ?? 8)
  },
  {
    name: 'web.search',
    description: 'Search the web and return titles, URLs and snippets.',
    level: 'SAFE',
    group: 'Web',
    schema: z.object({ query: z.string().min(1), limit: z.number().int().optional() }),
    run: (i) => web.search(S(i.query), N(i.limit) ?? 6)
  },
  {
    name: 'web.fetch',
    description: 'Fetch a public web page and return its readable text.',
    level: 'SAFE',
    group: 'Web',
    schema: z.object({ url: z.string().min(1) }),
    run: (i) => web.fetchPage(S(i.url))
  },

  // -- git ------------------------------------------------------------------
  {
    name: 'git.status',
    description: 'Show the branch and changed files of a git repository.',
    level: 'SAFE',
    group: 'Git',
    schema: z.object({ repo: path }),
    run: (i) => gitService.status(S(i.repo))
  },
  {
    name: 'git.diff',
    description: 'Show the working-tree or staged diff of a git repository.',
    level: 'SAFE',
    group: 'Git',
    schema: z.object({ repo: path, staged: z.boolean().optional() }),
    run: (i) => gitService.diff(S(i.repo), B(i.staged))
  },
  {
    name: 'git.log',
    description: 'Show recent commits of a git repository.',
    level: 'SAFE',
    group: 'Git',
    schema: z.object({ repo: path, limit: z.number().int().optional() }),
    run: (i) => gitService.log(S(i.repo), N(i.limit) ?? 20)
  },
  {
    name: 'git.commit',
    description: 'Commit changes in a repository. Akansha never pushes; that stays a manual step.',
    level: 'CONFIRM',
    group: 'Git',
    schema: z.object({ repo: path, message: z.string().min(1), addAll: z.boolean().optional() }),
    selfGuarded: true,
    run: (i) => gitService.commit(S(i.repo), S(i.message), B(i.addAll))
  },
  // -- clipboard, screen, tasks, notifications ------------------------------
  {
    name: 'clipboard.read',
    description: 'Read the current clipboard text (requires clipboard access in Settings > Privacy).',
    level: 'SAFE',
    group: 'Clipboard',
    schema: z.object({}),
    run: () => clipboardService.read()
  },
  {
    name: 'clipboard.write',
    description: 'Replace the clipboard contents with text.',
    level: 'SAFE',
    group: 'Clipboard',
    schema: z.object({ text: z.string() }),
    run: (i) => clipboardService.write(S(i.text))
  },
  {
    name: 'window.list',
    description: 'List open windows with their titles and owning processes.',
    level: 'SAFE',
    group: 'Computer',
    schema: z.object({}),
    run: () => computer.windows()
  },
  {
    name: 'screen.capture',
    description:
      'Capture the primary display as a PNG so a vision model can read it. Requires screen access in Settings > Privacy and always notifies the user.',
    level: 'CONFIRM',
    group: 'Computer',
    schema: z.object({}),
    summarize: () => 'Take a screenshot of your primary display',
    run: () => computer.screenshot()
  },
  {
    name: 'task.create',
    description:
      'Create a task, optionally scheduled. dueMs is a Unix timestamp in milliseconds; repeat may be none, hourly, daily or weekly.',
    level: 'SAFE',
    group: 'Tasks',
    schema: z.object({
      title: z.string().min(1),
      detail: z.string().optional(),
      dueMs: z.number().int().optional(),
      repeat: z.enum(['none', 'hourly', 'daily', 'weekly']).optional(),
      automationId: z.string().optional()
    }),
    run: (i) =>
      tasks.create({
        title: S(i.title),
        detail: S(i.detail),
        ...(N(i.dueMs) ? { dueMs: N(i.dueMs) } : {}),
        repeat: (i.repeat as 'none' | undefined) ?? 'none',
        ...(i.automationId ? { automationId: S(i.automationId) } : {})
      })
  },
  {
    name: 'task.list',
    description: 'List all tasks with their state and due time.',
    level: 'SAFE',
    group: 'Tasks',
    schema: z.object({}),
    run: () => tasks.list()
  },
  {
    name: 'task.update',
    description: 'Update a task: change its state (PENDING, RUNNING, COMPLETED, FAILED, CANCELLED), title, detail or due time.',
    level: 'SAFE',
    group: 'Tasks',
    schema: z.object({
      id: z.string().min(1),
      state: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
      dueMs: z.number().int().optional()
    }),
    run: (i) => {
      const patch: Record<string, unknown> = {}
      if (i.state) patch.state = i.state
      if (i.title !== undefined) patch.title = S(i.title)
      if (i.detail !== undefined) patch.detail = S(i.detail)
      if (N(i.dueMs)) patch.dueMs = N(i.dueMs)
      const next = tasks.update(S(i.id), patch)
      if (!next) throw new Error(`No task with id ${S(i.id)}.`)
      return next
    }
  },
  {
    name: 'automation.run',
    description: 'Run a saved automation by id. Each step still passes through its own permission check.',
    level: 'CONFIRM',
    group: 'Automations',
    schema: z.object({ id: z.string().min(1) }),
    summarize: (i) => `Run the saved automation ${S(i.id)}`,
    // Imported lazily: the automation engine invokes tools, so a static import
    // would make this module depend on itself.
    run: async (i) => (await import('../services/automation')).automationEngine.run(S(i.id))
  },
  {
    name: 'notify.show',
    description: 'Show a Windows notification and add it to the Akansha notification centre.',
    level: 'SAFE',
    group: 'System',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().default(''),
      category: z.enum(['TASK', 'SYSTEM', 'AUTOMATION', 'AI', 'ERROR', 'SECURITY']).optional()
    }),
    run: (i) =>
      notify({
        title: S(i.title),
        body: S(i.body),
        category: (i.category as 'AI' | undefined) ?? 'AI'
      })
  }
]

const byName = new Map(TOOLS.map((t) => [t.name, t]))

export const getTool = (name: string) => byName.get(name)

export function toolDescriptors(): ToolDescriptor[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    level: t.level,
    effectiveLevel: effectiveLevel(t.name, t.level),
    group: t.group
  }))
}

/** JSON Schema for provider tool-calling, derived from the same zod schema we validate with. */
export function toolSchemas(): LlmTool[] {
  return TOOLS.filter((t) => effectiveLevel(t.name, t.level) !== 'BLOCKED').map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>
    delete schema.$schema
    return { name: t.name, description: t.description, schema }
  })
}

function readableIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
    .slice(0, 6)
    .join('; ')
}

/**
 * The single entry point for running a tool, whether the caller is the AI, an
 * automation step or the developer console. Validate -> check permission ->
 * execute -> audit, with failures returned as thrown errors the caller reports.
 */
export async function invokeTool(
  name: string,
  rawInput: unknown,
  meta: { source?: string } = {}
): Promise<unknown> {
  const tool = byName.get(name)
  if (!tool) throw new Error(`Unknown tool "${name}".`)

  const parsed = tool.schema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    throw new Error(`Invalid input for ${name} -- ${readableIssues(parsed.error)}`)
  }
  const input = parsed.data as Record<string, unknown>

  if (!tool.selfGuarded) {
    await authorize({
      tool: tool.name,
      declared: tool.level,
      summary: tool.summarize?.(input) ?? `Run ${tool.name} with ${truncate(JSON.stringify(input), 200)}`,
      input
    })
  }

  const started = Date.now()
  try {
    const data = await tool.run(input)
    audit({
      kind: 'tool',
      label: `${tool.name}${meta.source ? ` (${meta.source})` : ''}`,
      detail: truncate(JSON.stringify(input), 400),
      ok: true,
      durationMs: Date.now() - started
    })
    return data
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    audit({
      kind: 'error',
      label: `${tool.name} failed`,
      detail: truncate(message, 400),
      ok: false,
      durationMs: Date.now() - started
    })
    throw e
  }
}
