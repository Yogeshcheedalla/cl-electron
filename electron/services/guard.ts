import type { PermissionLevel } from '../../shared/types'
import { approvals } from './approvals'
import { decide } from './permissions'

export class PermissionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionRefused'
  }
}

/**
 * The one gate every side-effecting operation passes through: policy decides,
 * the user confirms, and a refusal throws so callers cannot accidentally
 * continue past a denial.
 */
export async function authorize(opts: {
  tool: string
  declared: PermissionLevel
  summary: string
  reason?: string
  input?: Record<string, unknown>
}): Promise<void> {
  const verdict = decide(opts.tool, opts.declared)
  if (verdict.decision === 'allow') return
  if (verdict.decision === 'deny') throw new PermissionRefused(verdict.reason)

  const allowed = await approvals.ask({
    tool: opts.tool,
    summary: opts.summary,
    reason: opts.reason ?? verdict.reason,
    level: verdict.level === 'PRIVILEGED' ? 'PRIVILEGED' : 'CONFIRM',
    ...(opts.input ? { input: opts.input } : {})
  })
  if (!allowed) throw new PermissionRefused(`You declined: ${opts.summary}`)
}
