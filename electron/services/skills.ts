import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../core/logger'
import { truncate } from '../core/util'
import { getTool } from '../agents/tools'

export interface LoadedSkill {
  name: string
  description: string
  version: string
  enabled: boolean
  permissions: Record<string, boolean>
  tools: string[]
  instructions: string
  dir: string
}

/**
 * Skills are declarative, not executable: a manifest, a prompt fragment and a
 * whitelist of tools that already exist in Akansha. Nothing in a skill folder is
 * ever `require`d or evaluated, which is why a skill can be dropped in from the
 * internet without a sandbox -- the worst a malicious one can do is ask for
 * tools the user has not permitted, and the permission layer still applies.
 *
 * ponytail: no JavaScript skill runtime. Executable plugins would need a real
 * sandbox (utilityProcess + a capability-restricted bridge); that is a large
 * subsystem with its own threat model, so Akansha deliberately stops at prompt +
 * tool-whitelist skills.
 */
let stateFile = ''
let disabled = new Set<string>()

function skillRoots(): string[] {
  const roots = [join(app.getPath('userData'), 'skills')]
  roots.push(app.isPackaged ? join(process.resourcesPath, 'skills') : join(app.getAppPath(), 'skills'))
  return roots.filter((r) => existsSync(r))
}

export function initSkills() {
  stateFile = join(app.getPath('userData'), 'skills.json')
  if (!existsSync(stateFile)) return
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { disabled?: string[] }
    disabled = new Set(parsed.disabled ?? [])
  } catch (e) {
    logger.warn('skills.stateUnreadable', { message: String(e) })
  }
}

function persist() {
  if (!stateFile) return
  writeFileSync(stateFile, JSON.stringify({ disabled: [...disabled] }, null, 2), 'utf8')
}

function readSkill(dir: string): LoadedSkill | null {
  const manifestPath = join(dir, 'skill.json')
  if (!existsSync(manifestPath)) return null
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<LoadedSkill> & { prompt?: string }
    const name = String(m.name ?? '').trim()
    if (!name) return null
    const promptFile = join(dir, 'prompt.md')
    const instructions = m.prompt ?? (existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '')
    const tools = (Array.isArray(m.tools) ? m.tools : []).filter((t) => typeof t === 'string')
    const unknown = tools.filter((t) => !getTool(t))
    if (unknown.length) logger.warn('skills.unknownTools', { name, unknown })
    return {
      name,
      description: String(m.description ?? ''),
      version: String(m.version ?? '0.0.0'),
      enabled: !disabled.has(name),
      permissions: (m.permissions as Record<string, boolean>) ?? {},
      tools: tools.filter((t) => getTool(t)),
      instructions: truncate(instructions.trim(), 4000),
      dir
    }
  } catch (e) {
    logger.warn('skills.manifestInvalid', { dir, message: String(e) })
    return null
  }
}

export const skills = {
  list(): LoadedSkill[] {
    const found = new Map<string, LoadedSkill>()
    for (const root of skillRoots()) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skill = readSkill(join(root, entry.name))
        // User-data skills are read first, so they win over bundled ones.
        if (skill && !found.has(skill.name)) found.set(skill.name, skill)
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  },

  setEnabled(name: string, enabled: boolean): null {
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    persist()
    logger.info('skills.setEnabled', { name, enabled })
    return null
  },

  /** Prompt text contributed by enabled skills, appended to the system prompt. */
  promptFragment(): string {
    const active = skills.list().filter((s) => s.enabled && s.instructions)
    if (!active.length) return ''
    return [
      '',
      'Installed skills (user-provided instructions for specific situations):',
      ...active.map(
        (s) =>
          `- ${s.name} v${s.version}${s.tools.length ? ` [tools: ${s.tools.join(', ')}]` : ''}\n${s.instructions}`
      )
    ].join('\n')
  }
}
