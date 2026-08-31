import { useEffect, useState } from 'react'
import { Btn } from '../../components/ui'
import { call, errorText } from '../../services/api'
import { ago } from '../../services/format'
import { useApp } from '../../stores/app'
import { useChat } from '../../stores/chat'
import { Composer } from './Composer'
import { Thread } from './Thread'
import type { Conversation } from '../../../shared/records'

function Sidebar() {
  const { conversations, activeId, open, startNew, rename, remove, loadConversations } = useChat()
  const toast = useApp((s) => s.toast)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Conversation[] | null>(null)

  const search = async (value: string) => {
    setQuery(value)
    if (!value.trim()) return setHits(null)
    try {
      const found = await call(() => window.akansha.conversations.search(value.trim()))
      setHits(found.map((f) => f.conversation))
    } catch (e) {
      toast({ kind: 'bad', title: 'Search failed', body: errorText(e) })
    }
  }

  const list = hits ?? conversations

  const renameOne = async (c: Conversation) => {
    const title = window.prompt('Rename conversation', c.title)
    if (!title?.trim()) return
    try {
      await rename(c.id, title.trim())
    } catch (e) {
      toast({ kind: 'bad', title: 'Rename failed', body: errorText(e) })
    }
  }

  const removeOne = async (c: Conversation) => {
    if (!window.confirm(`Delete "${c.title}" and its messages? This cannot be undone.`)) return
    try {
      await remove(c.id)
      toast({ kind: 'ok', title: 'Conversation deleted' })
    } catch (e) {
      toast({ kind: 'bad', title: 'Delete failed', body: errorText(e) })
    }
  }

  const exportOne = async (c: Conversation) => {
    try {
      const { path } = await call(() => window.akansha.conversations.exportText(c.id))
      toast({ kind: 'ok', title: 'Exported', body: path })
    } catch (e) {
      toast({ kind: 'bad', title: 'Export failed', body: errorText(e) })
    }
  }

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  return (
    <aside className="chat-list">
      <div className="col" style={{ padding: 10, gap: 8 }}>
        <Btn variant="primary" onClick={startNew}>
          New conversation
        </Btn>
        <input type="search" placeholder="Search messages" value={query} onChange={(e) => void search(e.target.value)} />
      </div>
      <div className="list grow" style={{ overflow: 'auto' }}>
        {list.length === 0 && <div className="empty">No conversations yet.</div>}
        {list.map((c) => (
          <div
            key={c.id}
            className={`list-item clickable ${activeId === c.id ? 'active' : ''}`}
            style={activeId === c.id ? { background: 'var(--accent-dim)' } : undefined}
            onClick={() => void open(c.id)}
          >
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate">{c.title}</div>
              <div className="dim small">{ago(c.updatedMs)}</div>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <button className="btn ghost sm" onClick={(e) => (e.stopPropagation(), void renameOne(c))} title="Rename">
                ✎
              </button>
              <button className="btn ghost sm" onClick={(e) => (e.stopPropagation(), void exportOne(c))} title="Export as text">
                ⇩
              </button>
              <button
                className="btn ghost sm"
                onClick={(e) => (e.stopPropagation(), void removeOne(c))}
                title="Delete"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

export function ChatPage() {
  return (
    <div className="chat">
      <Sidebar />
      <div className="chat-main">
        <Thread />
        <Composer />
      </div>
    </div>
  )
}
