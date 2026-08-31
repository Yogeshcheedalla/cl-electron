import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLogger } from '../electron/core/logger'
import { initDatabase } from '../electron/db/db'
import { knowledge } from '../electron/db/knowledge.repo'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'

/**
 * Knowledge indexing, keyword ranking and the embedding layer on top of it.
 *
 * The embedding provider is mocked, and deliberately so: `embed` is an HTTP call
 * to OpenAI or Ollama, and a test that needed one would be a test of somebody
 * else's uptime. What is worth proving locally is everything around it -- that
 * vectors survive the Float32 BLOB roundtrip, that a vector from another model or
 * another dimension is never compared against the query, that a hit says which
 * path found it, and that when the provider fails the search still answers from
 * keywords instead of throwing.
 */

const vectors = new Map<string, number[]>()
let embedFails = false

vi.mock('../electron/ai/embeddings', () => ({
  embedUnavailable: () => null,
  embed: async (texts: string[]) => {
    if (embedFails) throw new Error('the embedding provider refused the request')
    return texts.map((t) => vectorFor(t))
  },
  embedQuery: async (text: string) => {
    if (embedFails) throw new Error('the embedding provider refused the request')
    return vectorFor(text)
  }
}))

/**
 * A deterministic stand-in for a real embedding: three axes counting words the
 * fixtures are built around, so "quantum" text is near other "quantum" text and
 * far from gardening. Small enough to reason about, which a real 1536-dimension
 * vector is not.
 */
function vectorFor(text: string): number[] {
  const t = text.toLowerCase()
  const count = (word: string) => t.split(word).length - 1
  return [count('quantum') + count('entangle'), count('garden') + count('compost'), count('invoice') + count('tax')]
}

let dir = ''
let corpus = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-knowledge-'))
  corpus = mkdtempSync(join(tmpdir(), 'akansha-corpus-'))
  initLogger(dir)
  initSettings(dir)
  initDatabase(dir)

  writeFileSync(join(corpus, 'physics.md'), '# Notes\nQuantum entanglement links two particles. Quantum states collapse on measurement.')
  writeFileSync(join(corpus, 'garden.txt'), 'The compost heap needs turning. A garden bed of tomatoes went in last week.')
  writeFileSync(join(corpus, 'finance.txt'), 'Invoice 4402 is unpaid. Tax filing is due in March.')
  mkdirSync(join(corpus, 'node_modules'), { recursive: true })
  writeFileSync(join(corpus, 'node_modules', 'ignored.txt'), 'Quantum quantum quantum inside node_modules.')
  writeFileSync(join(corpus, 'photo.png'), 'not text, and not an indexable extension')
})

beforeEach(() => {
  embedFails = false
  vectors.clear()
  settings.update({ knowledge: { ...DEFAULT_SETTINGS.knowledge }, automation: { ...DEFAULT_SETTINGS.automation, allowedRoots: [corpus] } })
})

/** Imported lazily so the mock above is in place before the service module loads. */
const service = async () => (await import('../electron/services/knowledge')).knowledgeService

describe('knowledge indexing', () => {
  it('indexes text files and skips node_modules and binaries', async () => {
    const svc = await service()
    const folder = svc.addFolder(corpus)
    const result = await svc.reindex(folder.id)
    expect(result.files).toBe(3)
    expect(result.chunks).toBeGreaterThanOrEqual(3)
    // Embeddings default to off, so nothing was sent anywhere.
    expect(result.embedded).toBe(0)
    expect(result.embedNote).toMatch(/turned off/i)
    const hits = await svc.search('quantum entanglement')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.path).toContain('physics.md')
    expect(hits.every((h) => !h.path.includes('node_modules'))).toBe(true)
  })

  it('ranks by keyword only, and labels nothing, when embeddings are off', async () => {
    const svc = await service()
    const hits = await svc.search('compost')
    expect(hits[0]?.path).toContain('garden.txt')
    expect(hits[0]?.via).toBeUndefined()
  })

  it('requires every query term to appear', async () => {
    const svc = await service()
    expect(await svc.search('quantum compost invoice')).toEqual([])
  })

  it('refuses to reindex a folder that is gone', async () => {
    const svc = await service()
    await expect(svc.reindex('not-a-folder')).rejects.toThrow(/no longer exists/i)
  })
})

describe('vector storage', () => {
  it('survives the Float32 BLOB roundtrip', () => {
    const folder = knowledge.addFolder(join(corpus, 'vectors'))
    const cid = knowledge.addChunk(folder.id, 'a.txt', 'alpha beta gamma')
    knowledge.setVector(cid, folder.id, 'test-model', [0.25, 0.5, 0.75])
    const hits = knowledge.semantic([0.25, 0.5, 0.75], 'test-model', 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.chunk).toBe('alpha beta gamma')
    // Same vector, so cosine similarity is 1 up to float error.
    expect(hits[0]?.score).toBeCloseTo(1, 5)
    knowledge.removeFolder(folder.id)
  })

  it('never compares a vector from another model or dimension', () => {
    const folder = knowledge.addFolder(join(corpus, 'isolation'))
    const a = knowledge.addChunk(folder.id, 'a.txt', 'model A chunk')
    const b = knowledge.addChunk(folder.id, 'b.txt', 'model B chunk')
    const c = knowledge.addChunk(folder.id, 'c.txt', 'wrong dimension chunk')
    knowledge.setVector(a, folder.id, 'model-a', [1, 0, 0])
    knowledge.setVector(b, folder.id, 'model-b', [1, 0, 0])
    knowledge.setVector(c, folder.id, 'model-a', [1, 0, 0, 0])
    const hits = knowledge.semantic([1, 0, 0], 'model-a', 10)
    expect(hits.map((h) => h.chunk)).toEqual(['model A chunk'])
    knowledge.removeFolder(folder.id)
  })

  it('replaces rather than duplicates a chunk re-embedded with a new model', () => {
    const folder = knowledge.addFolder(join(corpus, 'replace'))
    const cid = knowledge.addChunk(folder.id, 'a.txt', 'reindexed chunk')
    knowledge.setVector(cid, folder.id, 'old-model', [1, 0, 0])
    const before = knowledge.vectorCount()
    knowledge.setVector(cid, folder.id, 'new-model', [0, 1, 0])
    expect(knowledge.vectorCount()).toBe(before)
    expect(knowledge.semantic([1, 0, 0], 'old-model', 5)).toEqual([])
    expect(knowledge.semantic([0, 1, 0], 'new-model', 5)).toHaveLength(1)
    knowledge.removeFolder(folder.id)
  })

  it('drops the vectors when the folder is removed', () => {
    const folder = knowledge.addFolder(join(corpus, 'temporary'))
    const cid = knowledge.addChunk(folder.id, 'a.txt', 'about to be deleted')
    knowledge.setVector(cid, folder.id, 'test-model', [1, 1, 1])
    const before = knowledge.vectorCount()
    knowledge.removeFolder(folder.id)
    expect(knowledge.vectorCount()).toBeLessThan(before)
  })
})

describe('embedding-backed search', () => {
  it('embeds each chunk and labels how every hit was found', async () => {
    const svc = await service()
    settings.update({ knowledge: { ...DEFAULT_SETTINGS.knowledge, embeddings: true, model: 'stub-model' } })
    const folder = svc.folders().find((f) => f.path === corpus)
    const result = await svc.reindex(folder?.id)
    expect(result.embedded).toBe(result.chunks)
    expect(result.embedNote).toBeUndefined()

    // "entanglement" is in the physics file, so keyword and vector agree on it.
    const both = await svc.search('quantum entanglement')
    expect(both[0]?.path).toContain('physics.md')
    expect(both[0]?.via).toBe('both')

    // "composting" appears in no file, so keyword ranking finds nothing and only
    // the vector can reach the gardening chunk -- the whole reason embeddings
    // are here.
    const semantic = await svc.search('composting')
    expect(semantic.some((h) => h.via === 'semantic' && h.path.includes('garden.txt'))).toBe(true)
  })

  it('falls back to keyword ranking when the provider fails mid-search', async () => {
    const svc = await service()
    settings.update({ knowledge: { ...DEFAULT_SETTINGS.knowledge, embeddings: true, model: 'stub-model' } })
    const folder = svc.folders().find((f) => f.path === corpus)
    await svc.reindex(folder?.id)
    embedFails = true
    const hits = await svc.search('invoice')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.path).toContain('finance.txt')
    // No semantic list to blend, so no hit claims one found it.
    expect(hits.every((h) => h.via === undefined)).toBe(true)
  })

  it('reports an indexing failure instead of throwing it', async () => {
    const svc = await service()
    settings.update({ knowledge: { ...DEFAULT_SETTINGS.knowledge, embeddings: true, model: 'stub-model' } })
    embedFails = true
    const folder = svc.folders().find((f) => f.path === corpus)
    const result = await svc.reindex(folder?.id)
    expect(result.chunks).toBeGreaterThan(0)
    expect(result.embedded).toBe(0)
    expect(result.embedNote).toMatch(/refused the request/)
    // Keyword search is unaffected, which is what "fallback" has to mean.
    expect((await svc.search('tax filing')).length).toBeGreaterThan(0)
  })
})
