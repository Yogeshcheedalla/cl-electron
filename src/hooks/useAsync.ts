import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../services/api'
import { useApp } from '../stores/app'

/**
 * Loads data from the bridge and keeps the last error visible instead of
 * throwing it away -- a screen that cannot load says why.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const run = useRef(loader)
  run.current = loader

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const value = await run.current()
      if (alive.current) {
        setData(value)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void reload()
    return () => {
      alive.current = false
    }
    // `deps` is the caller's dependency list, passed through verbatim.
  }, deps)

  return { data, error, loading, reload, setData }
}

/** Runs an action, reports the outcome as a toast, and tracks a pending flag. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  const run = useCallback(
    async <T>(label: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setPending(label)
      try {
        const value = await fn()
        if (success) toast({ kind: 'ok', title: success })
        return value
      } catch (e) {
        toast({ kind: 'bad', title: label, body: errorText(e) })
        return undefined
      } finally {
        setPending(null)
      }
    },
    [toast]
  )

  return { run, pending, busy: (label: string) => pending === label }
}

/** Poll while a screen is open (system stats, processes). */
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (ms === null) return
    const timer = setInterval(() => ref.current(), ms)
    return () => clearInterval(timer)
  }, [ms])
}
