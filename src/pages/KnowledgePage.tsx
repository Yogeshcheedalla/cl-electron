import { useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Pill } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import { useApp } from '../stores/app'
import type { KnowledgeHit } from '../../shared/records'

type Indexed = { files: number; chunks: number; embedded: number; embedNote?: string }

const VIA_TONE: Record<NonNullable<KnowledgeHit['via']>, string> = {
  keyword: '',
  semantic: 'info',
  both: 'ok'
}

/**
 * Folders Akansha is allowed to read for context. Keyword ranking always runs;
 * embeddings are added on top when Settings > Knowledge turns them on, and every
 * hit says which path found it.
 */
export function KnowledgePage() {
  const folders = useLoad(() => call(() => window.akansha.knowledge.folders()))
  const { run, pending } = useAction()
  const settings = useApp((s) => s.settings)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null)
  const [indexed, setIndexed] = useState<Indexed | null>(null)

  const embeddings = settings?.knowledge.embeddings ?? false

  const search = async () => {
    if (!query.trim()) return setHits(null)
    const found = await run('Search knowledge', () => call(() => window.akansha.knowledge.search(query.trim(), 30)))
    if (found) setHits(found)
  }

  const reindex = (label: string, id?: string) =>
    void run(label, async () => {
      const result = await call(() => window.akansha.knowledge.reindex(id))
      setIndexed(result)
      await folders.reload()
    }, 'Index rebuilt')

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Knowledge</h1>
        <span className="grow" />
        <Pill tone={embeddings ? 'ok' : ''}>{embeddings ? 'keyword + embeddings' : 'keyword only'}</Pill>
        <Btn
          disabled={pending !== null}
          onClick={() =>
            void run('Add folder', async () => {
              const { path } = await call(() => window.akansha.apps.pickFolder())
              if (!path) return
              await call(() => window.akansha.knowledge.addFolder(path))
              await folders.reload()
            }, 'Folder added')
          }
        >
          Add folder…
        </Btn>
        <Btn variant="primary" disabled={pending !== null || !folders.data?.length} onClick={() => reindex('Reindex')}>
          Reindex all
        </Btn>
      </div>

      <ErrorNote error={folders.error} />

      {indexed && (
        <div className="card small">
          {indexed.files} files, {indexed.chunks} chunks
          {indexed.embedded > 0 ? `, ${indexed.embedded} chunks embedded` : ', no chunks embedded'}.
          {indexed.embedNote ? ` ${indexed.embedNote}` : ''}
        </div>
      )}

      <Card title="Indexed folders" flush>
        {!folders.data?.length ? (
          <Empty>
            {folders.loading ? 'Loading…' : 'No folders yet. Add one and Akansha can quote from the documents inside it.'}
          </Empty>
        ) : (
          <div className="list">
            {folders.data.map((f) => (
              <div key={f.id} className="list-item">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate mono small">{f.path}</div>
                  <div className="dim small">
                    {f.fileCount} files · {f.chunkCount} chunks · {f.indexedMs ? `indexed ${stamp(f.indexedMs)}` : 'not indexed yet'}
                  </div>
                </div>
                <Btn
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => reindex('Reindex folder', f.id)}
                >
                  Reindex
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() =>
                    void run('Remove folder', async () => {
                      await call(() => window.akansha.knowledge.removeFolder(f.id))
                      await folders.reload()
                    }, 'Folder removed')
                  }
                >
                  ✕
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Search">
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            type="search"
            className="grow"
            placeholder="Find a phrase across every indexed document"
            value={query}
            aria-label="Search knowledge"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
          />
          <Btn disabled={!query.trim() || pending !== null} onClick={() => void search()}>
            Search
          </Btn>
        </div>
        <div className="dim small" style={{ marginTop: 8 }}>
          {embeddings
            ? 'Keyword and embedding results are merged, so paraphrases match as well as exact wording. Chunks embedded before you changed the model are ignored until you reindex.'
            : 'Matching is keyword-based, so wording matters. Turn on embeddings in Settings > Knowledge to match paraphrases as well.'}
        </div>
        {hits && (
          <div className="list scroll-320" style={{ marginTop: 10 }}>
            {hits.length === 0 && <Empty>Nothing matched that.</Empty>}
            {hits.map((h, i) => (
              <div key={`${h.path}-${i}`} className="list-item">
                <Pill tone={h.via ? VIA_TONE[h.via] : ''}>{h.score.toFixed(2)}</Pill>
                {h.via && h.via !== 'keyword' && <Pill tone={VIA_TONE[h.via]}>{h.via}</Pill>}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="mono small truncate">{h.path}</div>
                  <div className="dim small">{h.chunk.slice(0, 400)}</div>
                </div>
                <Btn size="sm" variant="ghost" onClick={() => void run('Open file', () => call(() => window.akansha.apps.openPath(h.path)))}>
                  Open
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
