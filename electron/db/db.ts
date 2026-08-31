import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../core/logger'

/**
 * Local persistence uses Node's built-in SQLite (Node 22.5+/Electron 34+), so
 * there is no native module to rebuild per Electron release.
 */
let db: DatabaseSync

const MIGRATIONS: string[] = [
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY, title TEXT NOT NULL,
     created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
     content TEXT NOT NULL, created_ms INTEGER NOT NULL, meta TEXT,
     FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
   CREATE INDEX idx_messages_conv ON messages(conversation_id, created_ms);
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, state TEXT NOT NULL,
     due_ms INTEGER, repeat TEXT NOT NULL DEFAULT 'none', automation_id TEXT,
     created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, last_result TEXT);
   CREATE TABLE memories (
     id TEXT PRIMARY KEY, category TEXT NOT NULL, content TEXT NOT NULL,
     source TEXT NOT NULL, confidence TEXT NOT NULL, created_ms INTEGER NOT NULL);
   CREATE TABLE automations (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
     trigger_json TEXT NOT NULL, steps_json TEXT NOT NULL, enabled INTEGER NOT NULL,
     last_run_ms INTEGER, last_status TEXT);
   CREATE TABLE activity (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
     detail TEXT, ok INTEGER NOT NULL, duration_ms INTEGER);
   CREATE INDEX idx_activity_ts ON activity(ts DESC);
   CREATE TABLE usage (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
     cost_usd REAL NOT NULL, failed INTEGER NOT NULL);
   CREATE TABLE notifications (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
     body TEXT NOT NULL, read INTEGER NOT NULL);
   CREATE TABLE knowledge_folders (
     id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, indexed_ms INTEGER);
   CREATE TABLE knowledge_chunks (
     id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, path TEXT NOT NULL,
     chunk TEXT NOT NULL, terms TEXT NOT NULL,
     FOREIGN KEY(folder_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE);
   CREATE INDEX idx_chunks_folder ON knowledge_chunks(folder_id);`,
  // Semantic retrieval. One row per embedded chunk; `vec` is Float32 little-endian,
  // so cosine ranking reads it straight into a Float32Array with no parsing.
  `CREATE TABLE knowledge_vectors (
     chunk_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, model TEXT NOT NULL,
     dim INTEGER NOT NULL, vec BLOB NOT NULL,
     FOREIGN KEY(chunk_id) REFERENCES knowledge_chunks(id) ON DELETE CASCADE);
   CREATE INDEX idx_vectors_folder ON knowledge_vectors(folder_id);`
]

/**
 * The database file was `jarvis.db` before the rename. It is renamed forward
 * once, together with its WAL and shared-memory siblings -- moving the main file
 * alone would leave SQLite to reconstruct from a WAL that no longer matches, so
 * all three move or none do. If `akansha.db` already exists this is a no-op: an
 * older file never overwrites live data.
 */
function adoptLegacyDatabase(dir: string) {
  const target = join(dir, 'akansha.db')
  const legacy = join(dir, 'jarvis.db')
  if (existsSync(target) || !existsSync(legacy)) return
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, target + suffix)
    }
    logger.info('db.adoptedLegacy', { from: legacy, to: target })
  } catch (e) {
    // A half-moved set is worse than none, so say so loudly and let the open
    // below create a fresh database rather than pretending the move worked.
    logger.error('db.adoptFailed', { message: String(e) })
  }
}

export function initDatabase(userDataDir: string) {
  const dir = join(userDataDir, 'database')
  mkdirSync(dir, { recursive: true })
  adoptLegacyDatabase(dir)
  db = new DatabaseSync(join(dir, 'akansha.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')

  const row = db.prepare('SELECT version FROM schema_version').get() as { version?: number } | undefined
  let version = row?.version ?? 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()

  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i])
    version = i + 1
    db.prepare('UPDATE schema_version SET version = ?').run(version)
    logger.info('db.migrated', { version })
  }
  return db
}

export const handle = () => db

type Param = string | number | null | bigint | Uint8Array
export const run = (sql: string, ...params: Param[]) => db.prepare(sql).run(...params)
export const all = <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as T[]
export const get = <T>(sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as T | undefined

export const bool = (v: unknown) => v === 1 || v === true
export const flag = (v: boolean) => (v ? 1 : 0)

export function closeDatabase() {
  try {
    db?.close()
  } catch {
    /* already closed */
  }
}
