import { useEffect, useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Modal, Pill } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { bytes, stamp } from '../services/format'
import { useApp } from '../stores/app'
import type { FileEntry } from '../../shared/types'

const parent = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut > 1 ? trimmed.slice(0, cut) : trimmed
}

/**
 * A real file browser over the guarded filesystem service. Reads are scoped to
 * the allowed roots by the main process; writes, renames, moves and deletes go
 * through the tool registry, so they raise the normal approval prompt.
 */
export function FilesPage() {
  const settings = useApp((s) => s.settings)
  const roots = settings?.automation.allowedRoots ?? []
  const [dir, setDir] = useState('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean } | null>(null)
  const { run, pending } = useAction()

  useEffect(() => {
    if (!dir && roots.length) setDir(roots[0] as string)
  }, [dir, roots])

  const listing = useLoad<FileEntry[]>(
    () => (dir ? call(() => window.akansha.files.list(dir)) : Promise.resolve([])),
    [dir]
  )
  const [hits, setHits] = useState<FileEntry[] | null>(null)
  const entries = hits ?? listing.data ?? []

  const search = async () => {
    if (!query.trim()) return setHits(null)
    setSearching(true)
    const found = await run('Search files', () => call(() => window.akansha.files.search(dir, query.trim(), 200)))
    setSearching(false)
    if (found) setHits(found)
  }

  const openEntry = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      setHits(null)
      setQuery('')
      setDir(entry.path)
      return
    }
    const read = await run(`Read ${entry.name}`, () => call(() => window.akansha.files.read(entry.path)))
    if (read) setPreview(read)
  }

  const refresh = async () => {
    setHits(null)
    await listing.reload()
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Files</h1>
        <span className="grow" />
        <Btn
          disabled={pending !== null}
          onClick={() =>
            void run('Pick a folder', async () => {
              const { path } = await call(() => window.akansha.apps.pickFolder())
              if (path) {
                setHits(null)
                setDir(path)
              }
            })
          }
        >
          Choose folder…
        </Btn>
      </div>

      <Card>
        <div className="col" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn size="sm" disabled={!dir} onClick={() => (setHits(null), setDir(parent(dir)))}>
              ↑ Up
            </Btn>
            <input
              className="grow mono"
              value={dir}
              aria-label="Folder"
              placeholder="C:\Users\…"
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void refresh()}
            />
            <Btn size="sm" onClick={() => void refresh()}>
              Go
            </Btn>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {roots.map((r) => (
              <button key={r} className="pill" onClick={() => (setHits(null), setDir(r))}>
                {r}
              </button>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              type="search"
              className="grow"
              placeholder="Search inside this folder"
              value={query}
              aria-label="Search files"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void search()}
            />
            <Btn size="sm" disabled={!query.trim() || searching} onClick={() => void search()}>
              {searching ? 'Searching…' : 'Search'}
            </Btn>
            {hits && (
              <Btn size="sm" variant="ghost" onClick={() => (setHits(null), setQuery(''))}>
                Clear
              </Btn>
            )}
            <Btn
              size="sm"
              disabled={!dir || pending !== null}
              onClick={() => {
                const name = window.prompt('New folder name')
                if (!name?.trim()) return
                void run('Create folder', async () => {
                  await call(() => window.akansha.files.mkdir(`${dir}\\${name.trim()}`))
                  await refresh()
                }, 'Folder created')
              }}
            >
              New folder
            </Btn>
          </div>
        </div>
      </Card>

      <ErrorNote error={listing.error} />

      <Card title={hits ? `${entries.length} matches` : dir || 'No folder selected'} flush>
        {entries.length === 0 ? (
          <Empty>{listing.loading ? 'Reading the folder…' : 'Nothing here.'}</Empty>
        ) : (
          <div className="list scroll-320">
            {entries.map((entry) => (
              <div key={entry.path} className="list-item clickable" onClick={() => void openEntry(entry)}>
                <Pill tone={entry.isDirectory ? 'info' : ''}>{entry.isDirectory ? 'dir' : 'file'}</Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate">{entry.name}</div>
                  <div className="dim small">
                    {entry.isDirectory ? '' : `${bytes(entry.sizeBytes)} · `}
                    {stamp(entry.modifiedMs)}
                  </div>
                </div>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    void run('Open in Windows', () => call(() => window.akansha.apps.openPath(entry.path)))
                  }}
                >
                  Open
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    const name = window.prompt('Rename to', entry.name)
                    if (!name?.trim() || name === entry.name) return
                    void run('Rename', async () => {
                      await call(() => window.akansha.files.rename(entry.path, name.trim()))
                      await refresh()
                    }, 'Renamed')
                  }}
                >
                  Rename
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    // Recursion is never implied: a folder delete asks here, in
                    // words, before the tool is told it may take the contents.
                    if (
                      entry.isDirectory &&
                      !window.confirm(`Delete "${entry.name}" and everything inside it? This cannot be undone.`)
                    ) {
                      return
                    }
                    void run('Delete', async () => {
                      await call(() => window.akansha.files.remove(entry.path, entry.isDirectory))
                      await refresh()
                    }, 'Deleted')
                  }}
                >
                  ✕
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>

      {preview && (
        <Modal
          wide
          title={preview.path}
          onClose={() => setPreview(null)}
          footer={
            <>
              <span className="dim small grow">
                {preview.truncated ? 'Only the first part of this file is shown.' : 'Whole file shown.'}
              </span>
              <Btn variant="ghost" onClick={() => setPreview(null)}>
                Close
              </Btn>
              <Btn
                variant="primary"
                disabled={pending !== null}
                onClick={() =>
                  void run('Save file', async () => {
                    await call(() => window.akansha.files.write(preview.path, preview.content, true))
                    await refresh()
                  }, 'Saved')
                }
              >
                Save changes
              </Btn>
            </>
          }
        >
          <textarea
            className="mono"
            rows={18}
            value={preview.content}
            aria-label="File contents"
            onChange={(e) => setPreview({ ...preview, content: e.target.value })}
          />
        </Modal>
      )}
    </div>
  )
}
