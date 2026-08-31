import { randomUUID } from 'node:crypto'
import type { ToolResult } from '../../shared/types'

export const ok = <T>(data: T): ToolResult<T> => ({ success: true, data })

export const fail = (code: string, message: string, hint?: string): ToolResult<never> => ({
  success: false,
  error: hint ? { code, message, hint } : { code, message }
})

export const id = () => randomUUID()
export const now = () => Date.now()

/**
 * Human-readable message for an unknown throwable, never leaking a stack to the
 * UI. Redacted on the way out: provider errors quote the request, and an
 * upstream 401 body can contain the key that failed.
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return redact(e.message)
  if (typeof e === 'string') return redact(e)
  return 'Unknown error'
}

/** Wraps a service call so a throw becomes a structured failure instead of a crash. */
export async function attempt<T>(
  code: string,
  fn: () => Promise<T> | T
): Promise<ToolResult<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail(code, describeError(e))
  }
}

export const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`

const SECRET_KEYS = /(api[_-]?key|token|password|secret|authorization|bearer)/i

/** Redacts obvious secrets before anything reaches a log file or the UI. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') {
    // Longest prefix first, so an Anthropic key is reported as `sk-ant-` rather
    // than being swallowed by the shorter `sk-` alternative.
    return value.replace(/\b(sk-ant-|sk-|ghp_|gho_)[A-Za-z0-9\-_]{8,}/g, '$1[redacted]') as T
  }
  if (Array.isArray(value)) return value.map(redact) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v)
    }
    return out as T
  }
  return value
}
