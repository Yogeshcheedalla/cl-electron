import { useEffect, useMemo, useRef, useState } from 'react'
import { call, errorText } from '../services/api'
import { useApp, type Page } from '../stores/app'
import { NAV } from './Sidebar'

interface Command {
  id: string
  label: string
  hint: string
  run: () => void | Promise<void>
}

/**
 * Ctrl+K. Every entry performs a real action; nothing here is a placeholder, so
 * an action that needs approval raises the same prompt it would anywhere else.
 */
export function CommandPalette() {
  const { paletteOpen, setPalette, go, settings, saveSettings, toast } = useApp()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (paletteOpen) {
      setQuery('')
      setCursor(0)
      input.current?.focus()
    }
  }, [paletteOpen])

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = NAV.flatMap((s) =>
      s.items.map((item) => ({
        id: `go:${item.page}`,
        label: `Go to ${item.label}`,
        hint: s.group,
        run: () => go(item.page as Page)
      }))
    )
    const guard = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
        toast({ kind: 'ok', title: label })
      } catch (e) {
        toast({ kind: 'bad', title: label, body: errorText(e) })
      }
    }
    list.push(
      {
        id: 'diag',
        label: 'Run diagnostics',
        hint: 'Health check',
        run: () => guard('Diagnostics finished', async () => {
          await call(() => window.akansha.diagnostics.run())
          go('diagnostics')
        })
      },
      {
        id: 'clear-notifications',
        label: 'Clear notifications',
        hint: 'Notification centre',
        run: () => guard('Notifications cleared', () => call(() => window.akansha.notifications.clear()))
      },
      {
        id: 'hide',
        label: 'Hide Akansha to the tray',
        hint: 'Window',
        run: () => guard('Hidden', () => call(() => window.akansha.window.hide()))
      }
    )
    // The privacy toggles need current settings to flip, so they only appear once
    // settings have loaded.
    if (settings) {
      const privacy = settings.privacy
      list.push(
        {
          id: 'privacy',
          label: privacy.privacyMode ? 'Turn privacy mode off' : 'Turn privacy mode on',
          hint: 'Blocks clipboard and screen access',
          run: () =>
            guard('Privacy mode updated', () =>
              saveSettings({ privacy: { ...privacy, privacyMode: !privacy.privacyMode } })
            )
        },
        {
          id: 'screen',
          label: privacy.screenAccess ? 'Disable screen capture' : 'Enable screen capture',
          hint: 'Privacy',
          run: () =>
            guard('Screen capture updated', () =>
              saveSettings({ privacy: { ...privacy, screenAccess: !privacy.screenAccess } })
            )
        }
      )
    }
    return list
  }, [go, saveSettings, settings, toast])

  const hits = commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(query.trim().toLowerCase()))

  if (!paletteOpen) return null

  const choose = (command?: Command) => {
    if (!command) return
    setPalette(false)
    void command.run()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="modal palette fade-in" style={{ width: 'min(560px, 92vw)' }}>
        <input
          ref={input}
          type="search"
          placeholder="Type a command..."
          value={query}
          aria-label="Command"
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPalette(false)
            if (e.key === 'ArrowDown') setCursor((c) => Math.min(hits.length - 1, c + 1))
            if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
            if (e.key === 'Enter') choose(hits[cursor])
          }}
        />
        <div style={{ borderTop: '1px solid var(--line)', maxHeight: '46vh', overflow: 'auto' }}>
          {hits.length === 0 && <div className="empty">No command matches that.</div>}
          {hits.map((c, i) => (
            <div
              key={c.id}
              className={`hit ${i === cursor ? 'on' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={() => choose(c)}
            >
              <span className="grow">{c.label}</span>
              <span className="dim small">{c.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
