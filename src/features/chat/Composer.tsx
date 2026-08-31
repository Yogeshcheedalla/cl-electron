import { useRef, useState } from 'react'
import { Btn, Pill } from '../../components/ui'
import { errorText } from '../../services/api'
import { bytes } from '../../services/format'
import { useApp } from '../../stores/app'
import { useChat, type Draft } from '../../stores/chat'

const MAX_BYTES = 12 * 1024 * 1024

async function toDraft(file: File): Promise<Draft> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is ${bytes(file.size)}; the limit is 12 MB.`)
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < buffer.length; i += 8192) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 8192))
  }
  return { name: file.name, mimeType: file.type || 'application/octet-stream', base64: btoa(binary) }
}

/**
 * Enter sends, Shift+Enter breaks the line. The mode selector maps to the same
 * `mode` the orchestrator honours: answer means "do not use tools".
 */
export function Composer() {
  const { send, cancel, busy, mode, setMode } = useChat()
  const toast = useApp((s) => s.toast)
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const box = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  const grow = () => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(190, el.scrollHeight)}px`
  }

  const submit = async () => {
    const value = text.trim()
    if (!value && !drafts.length) return
    try {
      await send(value, drafts)
      setText('')
      setDrafts([])
      requestAnimationFrame(grow)
    } catch (e) {
      toast({ kind: 'bad', title: 'Message not sent', body: errorText(e) })
    }
  }

  const attach = async (files: FileList | null) => {
    if (!files?.length) return
    const next: Draft[] = []
    for (const file of Array.from(files).slice(0, 8)) {
      try {
        next.push(await toDraft(file))
      } catch (e) {
        toast({ kind: 'bad', title: 'Attachment skipped', body: errorText(e) })
      }
    }
    setDrafts((current) => [...current, ...next].slice(0, 8))
    if (picker.current) picker.current.value = ''
  }

  return (
    <div className="composer">
      {drafts.length > 0 && (
        <div className="attach">
          {drafts.map((d, i) => (
            <Pill key={`${d.name}-${i}`}>
              {d.name}
              <button
                className="btn ghost sm"
                style={{ padding: '0 4px', border: 0 }}
                aria-label={`Remove ${d.name}`}
                onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </Pill>
          ))}
        </div>
      )}

      <textarea
        ref={box}
        value={text}
        placeholder="Ask Akansha, or tell it what to do on this PC…"
        aria-label="Message"
        onChange={(e) => {
          setText(e.target.value)
          grow()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />

      <div className="row">
        <select
          value={mode}
          aria-label="Response mode"
          style={{ width: 150 }}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="auto">Auto</option>
          <option value="answer">Answer only</option>
          <option value="research">Research</option>
        </select>

        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => void attach(e.target.files)}
          aria-label="Attach files"
        />
        <Btn size="sm" onClick={() => picker.current?.click()}>
          Attach
        </Btn>
        <span className="grow dim small">
          {mode === 'answer' ? 'Tools are disabled in this mode.' : 'Akansha may use tools; risky ones ask first.'}
        </span>

        {busy ? (
          <Btn variant="danger" onClick={() => void cancel()}>
            Stop
          </Btn>
        ) : (
          <Btn variant="primary" onClick={() => void submit()} disabled={!text.trim() && !drafts.length}>
            Send
          </Btn>
        )}
      </div>
    </div>
  )
}
