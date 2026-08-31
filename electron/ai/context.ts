import { hostname, userInfo } from 'node:os'
import { truncate } from '../core/util'
import { memories } from '../db/state.repo'
import { knowledge } from '../db/knowledge.repo'
import { settings } from '../services/settings'
import { skills } from '../services/skills'
import { system } from '../services/system'

const SYSTEM_WORDS = /\b(cpu|ram|memory|disk|drive|space|battery|uptime|gpu|temperature|slow|performance|system|process)\b/i

const keywords = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? [])].slice(0, 6)

/**
 * Assembles the system prompt for one turn: the user's personality prompt, what
 * Akansha can do, enabled skills, remembered facts, knowledge excerpts and -- only
 * when the request sounds like it needs them -- live machine stats.
 *
 * Nothing here is invented: every section is omitted when its source is empty, so
 * the model is never told about context it does not have.
 */
export async function buildSystemPrompt(userText: string): Promise<string> {
  const cfg = settings.get()
  const parts: string[] = [cfg.ai.systemPrompt]

  parts.push(
    [
      '',
      'Environment:',
      `- Windows desktop, host ${hostname()}, user ${userInfo().username}`,
      `- Local time ${new Date().toLocaleString()}`,
      `- Assistant mode: ${cfg.mode}`,
      `- Files may be written only inside: ${cfg.automation.allowedRoots.join(', ')}`,
      `- Screen capture ${cfg.privacy.screenAccess ? 'is allowed' : 'is disabled'}; clipboard access ${cfg.privacy.clipboardAccess ? 'is allowed' : 'is disabled'}.`
    ].join('\n')
  )

  parts.push(
    [
      '',
      'Tool rules:',
      '- Use tools to act; never claim an action happened without a successful tool result.',
      '- Destructive tools ask the user for approval. If a tool returns a refusal, tell the user plainly and offer an alternative.',
      '- Prefer one precise tool call over several speculative ones, and report exactly what the tool returned.',
      '- Save a memory only for durable facts (preferences, projects, workflows), never for one-off details.'
    ].join('\n')
  )

  if (cfg.memory.enabled) {
    const terms = keywords(userText)
    const found = new Map<string, string>()
    for (const term of terms) {
      for (const m of memories.search(term, 5)) found.set(m.id, `[${m.category}] ${m.content}`)
    }
    for (const m of memories.list().filter((m) => m.category === 'PREFERENCE').slice(0, 8)) {
      found.set(m.id, `[PREFERENCE] ${m.content}`)
    }
    if (found.size) {
      parts.push(['', 'Remembered about this user:', ...[...found.values()].slice(0, 14).map((c) => `- ${c}`)].join('\n'))
    }
  }

  const hits = knowledge.folders().length ? knowledge.search(userText, 4) : []
  if (hits.length) {
    parts.push(
      [
        '',
        'Excerpts from the indexed knowledge folders (cite the file path when you use one):',
        ...hits.map((h) => `--- ${h.path}\n${truncate(h.chunk, 800)}`)
      ].join('\n')
    )
  }

  if (SYSTEM_WORDS.test(userText)) {
    try {
      const info = await system.info()
      parts.push(
        [
          '',
          'Live system status:',
          `- OS ${info.os}, up ${Math.round(info.uptimeSeconds / 3600)} h`,
          `- CPU ${info.cpu.model} (${info.cpu.cores} cores) at ${info.cpu.loadPercent}%`,
          `- Memory ${info.memory.usedPercent}% used of ${(info.memory.totalBytes / 1024 ** 3).toFixed(1)} GB`,
          ...info.disks.map(
            (d) => `- Disk ${d.drive} ${(d.freeBytes / 1024 ** 3).toFixed(1)} GB free of ${(d.totalBytes / 1024 ** 3).toFixed(1)} GB`
          ),
          ...(info.battery ? [`- Battery ${info.battery.percent}%${info.battery.charging ? ' (charging)' : ''}`] : [])
        ].join('\n')
      )
    } catch {
      /* live stats are a bonus, not a requirement */
    }
  }

  const skillText = skills.promptFragment()
  if (skillText) parts.push(skillText)

  return parts.join('\n')
}
