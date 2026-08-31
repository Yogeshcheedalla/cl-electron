import { constants } from 'node:fs'
import { access, copyFile, cp, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { readablePath, writablePath } from './path-guard'
import { settings } from './settings'
import type { FileEntry } from '../../shared/types'

const MAX_ENTRIES = 2000
const DEFAULT_READ_BYTES = 200_000
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'out', 'dist', '$recycle.bin'])
const BINARY = new Set([
  '.exe', '.dll', '.zip', '.7z', '.rar', '.iso', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.ico', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.pdf', '.docx', '.xlsx', '.pptx', '.bin',
  '.db', '.sqlite', '.pyc', '.class', '.o', '.so', '.lib', '.pack', '.woff', '.woff2', '.ttf'
])

const exists = (p: string) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false
  )

async function toEntry(path: string, name: string, isDirectory: boolean): Promise<FileEntry> {
  try {
    const s = await stat(path)
    return {
      name,
      path,
      isDirectory,
      sizeBytes: isDirectory ? 0 : s.size,
      modifiedMs: Math.round(s.mtimeMs)
    }
  } catch {
    // Locked or vanished between readdir and stat -- still worth listing.
    return { name, path, isDirectory, sizeBytes: 0, modifiedMs: 0 }
  }
}

/** Refuses to delete or overwrite a configured root itself. */
function assertNotRoot(abs: string) {
  const roots = settings.get().automation.allowedRoots.map((r) => resolve(r).toLowerCase())
  if (roots.includes(abs.toLowerCase())) {
    throw new Error(`${abs} is an allowed-roots entry itself; Akansha will not remove or replace it.`)
  }
}

export const files = {
  async list(dir: string): Promise<FileEntry[]> {
    const abs = readablePath(dir)
    const entries = await readdir(abs, { withFileTypes: true })
    const out = await Promise.all(
      entries
        .slice(0, MAX_ENTRIES)
        .map((e) => toEntry(join(abs, e.name), e.name, e.isDirectory()))
    )
    return out.sort((a, b) =>
      a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
    )
  },

  /**
   * Name-substring search over a subtree.
   * ponytail: a bounded recursive walk, not a Windows Search Index query. It
   * skips build/VCS folders and stops at `limit`, which keeps a home-directory
   * search responsive. Query Windows Search (Search.CollatorDSO OLE DB) if
   * content search across the whole disk is ever needed.
   */
  async search(root: string, query: string, limit = 100): Promise<FileEntry[]> {
    const abs = readablePath(root)
    const needle = String(query ?? '').trim().toLowerCase()
    if (!needle) throw new Error('A search term is required.')
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500)
    const hits: FileEntry[] = []
    const queue: string[] = [abs]
    let scanned = 0

    while (queue.length && hits.length < cap && scanned < 40_000) {
      const dir = queue.shift() as string
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        scanned++
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('$')) queue.push(full)
        }
        if (e.name.toLowerCase().includes(needle)) {
          hits.push(await toEntry(full, e.name, e.isDirectory()))
          if (hits.length >= cap) break
        }
      }
    }
    return hits
  },

  async read(
    path: string,
    maxBytes = DEFAULT_READ_BYTES
  ): Promise<{ path: string; content: string; truncated: boolean }> {
    const abs = readablePath(path)
    const cap = Math.min(Math.max(Number(maxBytes) || DEFAULT_READ_BYTES, 1024), 2_000_000)
    const s = await stat(abs)
    if (s.isDirectory()) throw new Error(`${abs} is a folder. Use the file list tool instead.`)
    if (BINARY.has(extname(abs).toLowerCase())) {
      throw new Error(
        `${basename(abs)} is a binary file. Use the document reader for PDF/Office files, or open it in its application.`
      )
    }
    const handle = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(Math.min(s.size, cap))
      await handle.read(buf, 0, buf.length, 0)
      return { path: abs, content: buf.toString('utf8'), truncated: s.size > buf.length }
    } finally {
      await handle.close()
    }
  },

  async write(
    path: string,
    content: string,
    overwrite = false
  ): Promise<{ path: string; bytes: number }> {
    const abs = writablePath(path)
    assertNotRoot(abs)
    if (!overwrite && (await exists(abs))) {
      throw new Error(
        `${abs} already exists. Pass overwrite: true (or ask again confirming the overwrite) to replace it.`
      )
    }
    await mkdir(dirname(abs), { recursive: true })
    const body = String(content ?? '')
    await writeFile(abs, body, 'utf8')
    return { path: abs, bytes: Buffer.byteLength(body, 'utf8') }
  },

  async mkdir(path: string): Promise<{ path: string }> {
    const abs = writablePath(path)
    await mkdir(abs, { recursive: true })
    return { path: abs }
  },

  async rename(path: string, newName: string): Promise<{ path: string }> {
    const abs = writablePath(path)
    assertNotRoot(abs)
    const clean = String(newName ?? '').trim()
    if (!clean || clean.includes(sep) || clean.includes('/') || clean === '..') {
      throw new Error('The new name must be a file name, not a path.')
    }
    const target = writablePath(join(dirname(abs), clean))
    if (await exists(target)) throw new Error(`${target} already exists.`)
    await rename(abs, target)
    return { path: target }
  },

  async copy(from: string, to: string): Promise<{ path: string }> {
    const src = readablePath(from)
    const dest = writablePath(to)
    assertNotRoot(dest)
    if (await exists(dest)) throw new Error(`${dest} already exists.`)
    await mkdir(dirname(dest), { recursive: true })
    const s = await stat(src)
    if (s.isDirectory()) await cp(src, dest, { recursive: true, errorOnExist: true })
    else await copyFile(src, dest, constants.COPYFILE_EXCL)
    return { path: dest }
  },

  async move(from: string, to: string): Promise<{ path: string }> {
    const src = writablePath(from)
    const dest = writablePath(to)
    assertNotRoot(src)
    assertNotRoot(dest)
    if (await exists(dest)) throw new Error(`${dest} already exists.`)
    await mkdir(dirname(dest), { recursive: true })
    await rename(src, dest)
    return { path: dest }
  },

  async remove(path: string, recursive = false): Promise<{ path: string }> {
    const abs = writablePath(path)
    assertNotRoot(abs)
    const s = await stat(abs)
    if (s.isDirectory()) {
      const children = await readdir(abs)
      if (children.length && !recursive) {
        throw new Error(
          `${abs} contains ${children.length} item(s). Pass recursive: true to delete the folder and everything inside it.`
        )
      }
      await rm(abs, { recursive: true, force: false })
    } else {
      await rm(abs, { force: false })
    }
    return { path: abs }
  }
}
