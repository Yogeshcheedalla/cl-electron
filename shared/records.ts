/** Conversation, task, memory, automation, activity and diagnostics records. */

export interface Conversation {
  id: string
  title: string
  createdMs: number
  updatedMs: number
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface StoredMessage {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  createdMs: number
  /** JSON blob with tool calls / agent metadata, rendered by the developer console. */
  meta?: string
}

export type TaskState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface Task {
  id: string
  title: string
  detail: string
  state: TaskState
  dueMs?: number
  /** Cron-ish repeat: none | daily | weekly | hourly */
  repeat: 'none' | 'hourly' | 'daily' | 'weekly'
  /** Automation id to run when the task fires, if any. */
  automationId?: string
  createdMs: number
  updatedMs: number
  lastResult?: string
}

export type MemoryCategory =
  | 'PREFERENCE'
  | 'PROJECT'
  | 'GOAL'
  | 'FACT'
  | 'WORKFLOW'
  | 'COMMAND'

export interface Memory {
  id: string
  category: MemoryCategory
  content: string
  source: string
  confidence: 'low' | 'medium' | 'high'
  createdMs: number
}

export interface AutomationStep {
  tool: string
  input: Record<string, unknown>
  /** Only run this step when the previous step succeeded (default true). */
  requiresPrevious?: boolean
}

export interface Automation {
  id: string
  name: string
  description: string
  trigger: { type: 'manual' | 'event' | 'schedule'; value?: string }
  steps: AutomationStep[]
  enabled: boolean
  lastRunMs?: number
  lastStatus?: 'ok' | 'failed'
}

/** One step as a dry run sees it: resolved, validated and gated, but not run. */
export interface DryRunStep {
  index: number
  tool: string
  /** 'run' | 'ask' | 'deny' | 'invalid' | 'unknown-tool' | 'skipped' */
  verdict: 'run' | 'ask' | 'deny' | 'invalid' | 'unknown-tool' | 'skipped'
  declaredLevel?: string
  effectiveLevel?: string
  summary: string
  detail: string
}

export interface DryRun {
  ok: boolean
  automation: string
  steps: DryRunStep[]
  log: string[]
}

export interface ActivityEntry {
  id: string
  ts: number
  kind: 'request' | 'plan' | 'tool' | 'permission' | 'agent' | 'error' | 'response' | 'system'
  label: string
  detail?: string
  ok: boolean
  durationMs?: number
}

export interface UsageEntry {
  id: string
  ts: number
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  estimatedCostUsd: number
  failed: boolean
}

export interface AkanshaNotification {
  id: string
  ts: number
  category: 'TASK' | 'SYSTEM' | 'AUTOMATION' | 'AI' | 'ERROR' | 'SECURITY'
  title: string
  body: string
  read: boolean
}

export interface ApprovalRequest {
  id: string
  tool: string
  summary: string
  reason: string
  input: Record<string, unknown>
  level: 'CONFIRM' | 'PRIVILEGED'
  createdMs: number
}

export interface HealthCheck {
  name: string
  status: 'HEALTHY' | 'WARNING' | 'ERROR'
  detail: string
}

export interface PlanStep {
  id: string
  label: string
  tool?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  detail?: string
}

export interface AgentRun {
  id: string
  conversationId: string
  agent: string
  responseMode: 'ANSWER' | 'ACTION' | 'PLAN' | 'RESEARCH' | 'EXECUTION' | 'CLARIFICATION'
  steps: PlanStep[]
  state: 'running' | 'done' | 'failed' | 'cancelled'
}

export interface KnowledgeFolder {
  id: string
  path: string
  fileCount: number
  chunkCount: number
  indexedMs?: number
}

export interface KnowledgeHit {
  path: string
  chunk: string
  score: number
  /** Which retrieval path found this chunk. Absent means keyword-only. */
  via?: 'keyword' | 'semantic' | 'both'
}
