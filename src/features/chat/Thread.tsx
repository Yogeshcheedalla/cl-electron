import { useEffect, useRef, useState } from 'react'
import { Btn, Empty, Pill } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import { errorText } from '../../services/api'
import { clock } from '../../services/format'
import { useApp } from '../../stores/app'
import { useChat } from '../../stores/chat'
import { PRODUCT } from '../../../shared/brand'
import type { StoredMessage } from '../../../shared/records'

interface Meta {
  provider?: string
  model?: string
  role?: string
  inputTokens?: number
  outputTokens?: number
  ms?: number
  cancelled?: boolean
  tools?: { tool: string; ok: boolean; detail?: string }[]
}

const parseMeta = (raw?: string): Meta => {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Meta
  } catch {
    return {}
  }
}

function MetaLine({ meta }: { meta: Meta }) {
  const developer = useApp((s) => s.settings?.developerMode ?? false)
  const bits: string[] = []
  if (meta.model) bits.push(`${meta.provider ?? 'model'} · ${meta.model}`)
  if (meta.ms) bits.push(`${(meta.ms / 1000).toFixed(1)}s`)
  if (developer && (meta.inputTokens || meta.outputTokens)) {
    bits.push(`${meta.inputTokens ?? 0} in / ${meta.outputTokens ?? 0} out`)
  }
  if (meta.cancelled) bits.push('stopped by you')
  if (!bits.length && !meta.tools?.length) return null
  return (
    <div className="row wrap small dim" style={{ gap: 8 }}>
      {bits.join('  ·  ')}
      {meta.tools?.map((t, i) => (
        <Pill key={`${t.tool}-${i}`} tone={t.ok ? 'ok' : 'bad'}>
          {t.tool}
        </Pill>
      ))}
    </div>
  )
}

function Bubble({ message, onRegenerate }: { message: StoredMessage; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false)
  const meta = parseMeta(message.meta)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article className={`msg ${message.role}`}>
      <div className="who">
        {message.role === 'user' ? 'You' : <span className="wordmark">{PRODUCT}</span>} · {clock(message.createdMs)}
      </div>
      <div className="bubble">
        {message.role === 'assistant' ? <Markdown text={message.content} /> : message.content}
      </div>
      <MetaLine meta={meta} />
      <div className="msg-actions">
        <Btn size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Btn>
        {onRegenerate && (
          <Btn size="sm" variant="ghost" onClick={onRegenerate}>
            Regenerate
          </Btn>
        )}
      </div>
    </article>
  )
}

export function Thread() {
  const { messages, streaming, busy, plan, lastError, regenerate } = useChat()
  const toast = useApp((s) => s.toast)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, streaming, plan.length])

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')

  const again = () => {
    void regenerate().catch((e) => toast({ kind: 'bad', title: 'Could not resend', body: errorText(e) }))
  }

  return (
    <div className="thread">
      {messages.length === 0 && !streaming && (
        <Empty>
          Ask Akansha something, or tell it to do something on this PC. Destructive actions always ask first.
        </Empty>
      )}

      {messages.map((m) => (
        <Bubble
          key={m.id}
          message={m}
          {...(m.id === lastAssistant?.id && !busy ? { onRegenerate: again } : {})}
        />
      ))}

      {plan.length > 0 && busy && (
        <div className="plan">
          {plan.map((step) => (
            <div key={step.id} className="row" style={{ gap: 8 }}>
              <Pill tone={step.status === 'failed' ? 'bad' : step.status === 'done' ? 'ok' : 'info'}>
                {step.status}
              </Pill>
              <span className="grow truncate">{step.label}</span>
            </div>
          ))}
        </div>
      )}

      {streaming && (
        <article className="msg assistant">
          <div className="who">
            <span className="wordmark">{PRODUCT}</span> · now
          </div>
          <div className="bubble">
            <Markdown text={streaming} />
          </div>
        </article>
      )}

      {busy && !streaming && <div className="dim small">Akansha is working…</div>}
      {lastError && <div className="pill bad">{lastError}</div>}
      <div ref={end} />
    </div>
  )
}
