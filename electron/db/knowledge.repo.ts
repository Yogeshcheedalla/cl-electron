import { all, get, run } from './db'
import { id } from '../core/util'
import type { KnowledgeFolder, KnowledgeHit } from '../../shared/records'

type FolderRow = { id: string; path: string; indexed_ms: number | null }

const counts = (fid: string) =>
  get<{ files: number; chunks: number }>(
    'SELECT COUNT(DISTINCT path) AS files, COUNT(*) AS chunks FROM knowledge_chunks WHERE folder_id = ?',
    fid
  ) ?? { files: 0, chunks: 0 }

const toFolder = (r: FolderRow): KnowledgeFolder => {
  const c = counts(r.id)
  return {
    id: r.id,
    path: r.path,
    fileCount: c.files,
    chunkCount: c.chunks,
    ...(r.indexed_ms ? { indexedMs: r.indexed_ms } : {})
  }
}

export const knowledge = {
  folders(): KnowledgeFolder[] {
    return all<FolderRow>('SELECT * FROM knowledge_folders ORDER BY path').map(toFolder)
  },

  addFolder(path: string): KnowledgeFolder {
    const existing = get<FolderRow>('SELECT * FROM knowledge_folders WHERE path = ?', path)
    if (existing) return toFolder(existing)
    const fid = id()
    run('INSERT INTO knowledge_folders (id, path, indexed_ms) VALUES (?,?,NULL)', fid, path)
    return { id: fid, path, fileCount: 0, chunkCount: 0 }
  },

  removeFolder(fid: string) {
    run('DELETE FROM knowledge_chunks WHERE folder_id = ?', fid)
    run('DELETE FROM knowledge_folders WHERE id = ?', fid)
  },

  clearChunks(fid: string) {
    run('DELETE FROM knowledge_chunks WHERE folder_id = ?', fid)
  },

  /** Returns the new chunk's id so its embedding can be attached to it. */
  addChunk(fid: string, path: string, chunk: string): string {
    const cid = id()
    run(
      'INSERT INTO knowledge_chunks (id, folder_id, path, chunk, terms) VALUES (?,?,?,?,?)',
      cid,
      fid,
      path,
      chunk,
      chunk.toLowerCase()
    )
    return cid
  },

  /** Stores one chunk's embedding as little-endian Float32. */
  setVector(cid: string, fid: string, model: string, vec: number[]) {
    const f32 = new Float32Array(vec)
    run(
      'INSERT INTO knowledge_vectors (chunk_id, folder_id, model, dim, vec) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec',
      cid,
      fid,
      model,
      f32.length,
      new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
    )
  },

  vectorCount(): number {
    return get<{ c: number }>('SELECT COUNT(*) AS c FROM knowledge_vectors')?.c ?? 0
  },

  /**
   * Cosine similarity against every stored vector. A brute-force scan is the
   * right answer here: 2000 files cap out around 20k chunks, and 20k dot
   * products of 1536 floats is a few milliseconds -- an ANN index would be more
   * code and another dependency to be wrong about.
   */
  semantic(query: number[], model: string, limit: number): { path: string; chunk: string; score: number }[] {
    const q = new Float32Array(query)
    let qn = 0
    for (const v of q) qn += v * v
    qn = Math.sqrt(qn) || 1
    const rows = all<{ path: string; chunk: string; dim: number; vec: Uint8Array }>(
      `SELECT c.path AS path, c.chunk AS chunk, v.dim AS dim, v.vec AS vec
         FROM knowledge_vectors v JOIN knowledge_chunks c ON c.id = v.chunk_id
        WHERE v.model = ? AND v.dim = ?`,
      model,
      q.length
    )
    const scored: { path: string; chunk: string; score: number }[] = []
    for (const r of rows) {
      const bytes = Uint8Array.from(r.vec)
      const vec = new Float32Array(bytes.buffer, bytes.byteOffset, r.dim)
      let dot = 0
      let vn = 0
      for (let i = 0; i < r.dim; i++) {
        const a = vec[i] as number
        dot += a * (q[i] as number)
        vn += a * a
      }
      const score = dot / (qn * (Math.sqrt(vn) || 1))
      if (score > 0.05) scored.push({ path: r.path, chunk: r.chunk, score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  },

  markIndexed(fid: string, ms: number) {
    run('UPDATE knowledge_folders SET indexed_ms = ? WHERE id = ?', ms, fid)
  },

  /**
   * Lexical retrieval: every query term must appear, ranked by total term
   * frequency and inverse chunk length. Always runs, with or without
   * embeddings -- `blend` in the service layer merges the two lists.
   */
  search(query: string, limit = 8): KnowledgeHit[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_+#.-]+/)
      .filter((t) => t.length > 2)
      .slice(0, 8)
    if (!terms.length) return []

    const where = terms.map(() => 'terms LIKE ?').join(' AND ')
    const rows = all<{ path: string; chunk: string; terms: string }>(
      `SELECT path, chunk, terms FROM knowledge_chunks WHERE ${where} LIMIT 400`,
      ...terms.map((t) => `%${t}%`)
    )

    return rows
      .map((r) => {
        const hits = terms.reduce((sum, t) => sum + r.terms.split(t).length - 1, 0)
        return { path: r.path, chunk: r.chunk, score: hits / Math.log(r.chunk.length + 10) }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}
