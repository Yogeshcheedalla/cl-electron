import type { ToolResult } from '../../shared/types'

/**
 * Every bridge call returns `ToolResult`, never a throw. `call()` turns a failed
 * result into a real Error so components can use try/catch, and keeps the error
 * text the main process wrote -- the UI never invents a reason of its own.
 */

export class BridgeError extends Error {
  code: string
  hint?: string
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (hint) this.hint = hint
  }
}

export const bridgeReady = (): boolean => typeof window !== 'undefined' && !!window.akansha

export async function call<T>(fn: () => Promise<ToolResult<T>>): Promise<T> {
  if (!bridgeReady()) {
    throw new BridgeError('NO_BRIDGE', 'The Akansha bridge is unavailable. Restart the app.')
  }
  const result = await fn()
  if (!result?.success) {
    const error = result?.error
    throw new BridgeError(error?.code ?? 'UNKNOWN', error?.message ?? 'That request failed.', error?.hint)
  }
  return result.data as T
}

/** For calls whose failure should not interrupt a render (dashboard tiles, polls). */
export async function tryCall<T>(fn: () => Promise<ToolResult<T>>, fallback: T): Promise<T> {
  try {
    return await call(fn)
  } catch {
    return fallback
  }
}

export const api = () => window.akansha

export const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.'
