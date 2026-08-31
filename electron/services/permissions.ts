import type { PermissionDecision, PermissionLevel } from '../../shared/types'
import { settings } from './settings'

/**
 * Turns a tool's declared level into a runtime decision. Kept pure so the
 * policy is unit-testable without Electron, a database or a live window.
 *
 * Precedence: BLOCKED always wins, then the user's per-tool override, then the
 * tool's declared level. PRIVILEGED can never be silenced by the trusted-tool
 * list -- shutting the machine down or elevating always asks.
 */
export function effectiveLevel(tool: string, declared: PermissionLevel): PermissionLevel {
  if (declared === 'BLOCKED') return 'BLOCKED'
  return settings.get().automation.toolLevels[tool] ?? declared
}

export interface Verdict {
  decision: PermissionDecision
  level: PermissionLevel
  reason: string
}

export function decide(tool: string, declared: PermissionLevel): Verdict {
  const level = effectiveLevel(tool, declared)
  const { confirmDestructive, trustedTools } = settings.get().automation

  if (level === 'BLOCKED') {
    return { decision: 'deny', level, reason: `${tool} is blocked by Akansha policy.` }
  }
  if (level === 'SAFE') {
    return { decision: 'allow', level, reason: 'safe operation' }
  }
  if (level === 'PRIVILEGED') {
    return { decision: 'confirm', level, reason: `${tool} changes the system and always asks first.` }
  }
  if (trustedTools.includes(tool)) {
    return { decision: 'allow', level, reason: `${tool} is in your trusted tools list.` }
  }
  if (!confirmDestructive) {
    return { decision: 'allow', level, reason: 'confirmation for destructive actions is turned off.' }
  }
  return { decision: 'confirm', level, reason: `${tool} can change or remove data.` }
}

/** Persisted from Settings > Permissions and from "always allow" approvals. */
export function setToolLevel(tool: string, level: PermissionLevel): void {
  const toolLevels = { ...settings.get().automation.toolLevels, [tool]: level }
  settings.update({ automation: { ...settings.get().automation, toolLevels } })
}

export function trustTool(tool: string): void {
  const { automation } = settings.get()
  if (automation.trustedTools.includes(tool)) return
  settings.update({
    automation: { ...automation, trustedTools: [...automation.trustedTools, tool] }
  })
}
