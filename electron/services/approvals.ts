import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { id, now, truncate } from '../core/util'
import { notifications } from '../db/log.repo'
import { audit } from '../core/audit'
import { trustTool } from './permissions'
import type { ApprovalRequest } from '../../shared/records'

export type ApprovalDecision = 'once' | 'always' | 'deny'

type Pending = {
  request: ApprovalRequest
  settle: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

/** Unanswered prompts expire so a forgotten dialog can never wedge an agent. */
const TIMEOUT_MS = 3 * 60_000

const pending = new Map<string, Pending>()

function finish(entry: Pending, decision: ApprovalDecision) {
  clearTimeout(entry.timer)
  pending.delete(entry.request.id)
  if (decision === 'always') trustTool(entry.request.tool)
  audit({
    kind: 'permission',
    label: `${decision === 'deny' ? 'Denied' : 'Approved'} ${entry.request.tool}`,
    detail: truncate(entry.request.summary, 300),
    ok: decision !== 'deny'
  })
  logger.info('approval.resolved', { tool: entry.request.tool, decision })
  bus.emitToUi({ type: 'approval:resolved', id: entry.request.id })
  entry.settle(decision)
}

export const approvals = {
  list(): ApprovalRequest[] {
    return [...pending.values()].map((p) => p.request).sort((a, b) => a.createdMs - b.createdMs)
  },

  /**
   * Shows the request in the approval centre and resolves once the user answers.
   * Returns true when the action may proceed.
   */
  ask(input: {
    tool: string
    summary: string
    reason: string
    level: 'CONFIRM' | 'PRIVILEGED'
    input?: Record<string, unknown>
  }): Promise<boolean> {
    const request: ApprovalRequest = {
      id: id(),
      tool: input.tool,
      summary: input.summary,
      reason: input.reason,
      level: input.level,
      input: input.input ?? {},
      createdMs: now()
    }

    return new Promise<boolean>((resolvePromise) => {
      const entry: Pending = {
        request,
        settle: (decision) => resolvePromise(decision !== 'deny'),
        timer: setTimeout(() => {
          const live = pending.get(request.id)
          if (live) finish(live, 'deny')
        }, TIMEOUT_MS)
      }
      pending.set(request.id, entry)

      notifications.add({
        category: 'SECURITY',
        title: `Approval needed: ${request.tool}`,
        body: request.summary
      })
      logger.info('approval.requested', { tool: request.tool, level: request.level })
      bus.emitToUi({ type: 'approval', request })
    })
  },

  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = pending.get(approvalId)
    if (!entry) return false
    finish(entry, decision)
    return true
  },

  /** Called on shutdown so nothing is left awaiting an answer. */
  denyAll(): void {
    for (const entry of [...pending.values()]) finish(entry, 'deny')
  }
}
