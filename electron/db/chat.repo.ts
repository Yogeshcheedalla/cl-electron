import { all, get, run } from './db'
import { id, now, redact } from '../core/util'
import type { Conversation, StoredMessage } from '../../shared/records'

type ConvRow = { id: string; title: string; created_ms: number; updated_ms: number }
type MsgRow = {
  id: string
  conversation_id: string
  role: string
  content: string
  created_ms: number
  meta: string | null
}

const toConv = (r: ConvRow): Conversation => ({
  id: r.id,
  title: r.title,
  createdMs: r.created_ms,
  updatedMs: r.updated_ms
})

const toMsg = (r: MsgRow): StoredMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role as StoredMessage['role'],
  content: r.content,
  createdMs: r.created_ms,
  ...(r.meta ? { meta: r.meta } : {})
})

export const conversations = {
  list(limit = 50): Conversation[] {
    return all<ConvRow>(
      'SELECT * FROM conversations ORDER BY updated_ms DESC LIMIT ?',
      limit
    ).map(toConv)
  },

  create(title = 'New conversation'): Conversation {
    const ts = now()
    // Titles are usually derived from the first thing the user typed, so a
    // pasted key becomes a sidebar label that outlives the message. Titles are
    // labels and safe to rewrite; message bodies are the conversation itself and
    // are stored verbatim.
    const conv: Conversation = { id: id(), title: redact(title), createdMs: ts, updatedMs: ts }
    run(
      'INSERT INTO conversations (id, title, created_ms, updated_ms) VALUES (?,?,?,?)',
      conv.id,
      conv.title,
      ts,
      ts
    )
    return conv
  },

  get(cid: string): Conversation | undefined {
    const row = get<ConvRow>('SELECT * FROM conversations WHERE id = ?', cid)
    return row ? toConv(row) : undefined
  },

  rename(cid: string, title: string) {
    run('UPDATE conversations SET title = ?, updated_ms = ? WHERE id = ?', redact(title), now(), cid)
  },

  remove(cid: string) {
    run('DELETE FROM messages WHERE conversation_id = ?', cid)
    run('DELETE FROM conversations WHERE id = ?', cid)
  },

  touch(cid: string) {
    run('UPDATE conversations SET updated_ms = ? WHERE id = ?', now(), cid)
  },

  /** Full-text-ish search over message bodies; returns one hit per conversation. */
  search(query: string, limit = 20): { conversation: Conversation; snippet: string }[] {
    const rows = all<ConvRow & { snippet: string }>(
      `SELECT c.*, m.content AS snippet FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE m.content LIKE ? OR c.title LIKE ?
       GROUP BY c.id ORDER BY c.updated_ms DESC LIMIT ?`,
      `%${query}%`,
      `%${query}%`,
      limit
    )
    return rows.map((r) => ({ conversation: toConv(r), snippet: r.snippet.slice(0, 240) }))
  }
}

export const messages = {
  list(cid: string): StoredMessage[] {
    return all<MsgRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_ms ASC',
      cid
    ).map(toMsg)
  },

  /** Most recent messages, oldest-first, for building model context. */
  recent(cid: string, limit: number): StoredMessage[] {
    return all<MsgRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_ms DESC LIMIT ?',
      cid,
      limit
    )
      .map(toMsg)
      .reverse()
  },

  add(msg: Omit<StoredMessage, 'id' | 'createdMs'> & { createdMs?: number }): StoredMessage {
    const stored: StoredMessage = { id: id(), createdMs: msg.createdMs ?? now(), ...msg }
    run(
      'INSERT INTO messages (id, conversation_id, role, content, created_ms, meta) VALUES (?,?,?,?,?,?)',
      stored.id,
      stored.conversationId,
      stored.role,
      stored.content,
      stored.createdMs,
      stored.meta ?? null
    )
    conversations.touch(msg.conversationId)
    return stored
  }
}
