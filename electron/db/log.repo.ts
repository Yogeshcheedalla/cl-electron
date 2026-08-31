import { all, bool, flag, get, run } from './db'
import { id, now, redact } from '../core/util'
import type { ActivityEntry, AkanshaNotification, UsageEntry } from '../../shared/records'

type ActRow = {
  id: string
  ts: number
  kind: string
  label: string
  detail: string | null
  ok: number
  duration_ms: number | null
}

export const activity = {
  add(entry: Omit<ActivityEntry, 'id' | 'ts'>): ActivityEntry {
    // Labels and details are assembled from tool arguments, so a key the user
    // pasted into a prompt can reach this table. Redacting here covers both
    // consumers at once: the row written to SQLite and the identical row pushed
    // to the live timeline.
    const row: ActivityEntry = redact({ id: id(), ts: now(), ...entry })
    run(
      'INSERT INTO activity (id,ts,kind,label,detail,ok,duration_ms) VALUES (?,?,?,?,?,?,?)',
      row.id,
      row.ts,
      row.kind,
      row.label,
      row.detail ?? null,
      flag(row.ok),
      row.durationMs ?? null
    )
    return row
  },

  list(limit = 200): ActivityEntry[] {
    return all<ActRow>('SELECT * FROM activity ORDER BY ts DESC LIMIT ?', limit).map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind as ActivityEntry['kind'],
      label: r.label,
      ok: bool(r.ok),
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {})
    }))
  },

  clear() {
    run('DELETE FROM activity')
  },

  prune(olderThanMs: number) {
    run('DELETE FROM activity WHERE ts < ?', olderThanMs)
  }
}

type UsageRow = {
  id: string
  ts: number
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  latency_ms: number
  cost_usd: number
  failed: number
}

export const usage = {
  add(entry: Omit<UsageEntry, 'id' | 'ts'>): UsageEntry {
    const row: UsageEntry = { id: id(), ts: now(), ...entry }
    run(
      'INSERT INTO usage (id,ts,provider,model,input_tokens,output_tokens,latency_ms,cost_usd,failed) VALUES (?,?,?,?,?,?,?,?,?)',
      row.id,
      row.ts,
      row.provider,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.latencyMs,
      row.estimatedCostUsd,
      flag(row.failed)
    )
    return row
  },

  since(sinceMs: number): UsageEntry[] {
    return all<UsageRow>('SELECT * FROM usage WHERE ts >= ? ORDER BY ts DESC', sinceMs).map((r) => ({
      id: r.id,
      ts: r.ts,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      latencyMs: r.latency_ms,
      estimatedCostUsd: r.cost_usd,
      failed: bool(r.failed)
    }))
  }
}

type NotifRow = {
  id: string
  ts: number
  category: string
  title: string
  body: string
  read: number
}

export const notifications = {
  add(entry: Omit<AkanshaNotification, 'id' | 'ts' | 'read'>): AkanshaNotification {
    // An approval prompt quotes the arguments it is asking about, so the same
    // redaction applies before the notification is stored or shown.
    const row: AkanshaNotification = redact({ id: id(), ts: now(), read: false, ...entry })
    run(
      'INSERT INTO notifications (id,ts,category,title,body,read) VALUES (?,?,?,?,?,0)',
      row.id,
      row.ts,
      row.category,
      row.title,
      row.body
    )
    return row
  },

  list(limit = 100): AkanshaNotification[] {
    return all<NotifRow>('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?', limit).map((r) => ({
      id: r.id,
      ts: r.ts,
      category: r.category as AkanshaNotification['category'],
      title: r.title,
      body: r.body,
      read: bool(r.read)
    }))
  },

  markRead(nid?: string) {
    if (nid) run('UPDATE notifications SET read = 1 WHERE id = ?', nid)
    else run('UPDATE notifications SET read = 1')
  },

  clear() {
    run('DELETE FROM notifications')
  },

  unreadCount(): number {
    return get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE read = 0')?.c ?? 0
  }
}
