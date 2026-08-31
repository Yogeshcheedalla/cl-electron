import { useMemo, useState } from 'react'
import { Btn, Card, Empty, ErrorNote, Pill } from '../components/ui'
import { useAction, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'

/**
 * The list comes from the real Start Menu / PATH scan in the app service, and
 * every button calls the matching channel -- closing an app raises the same
 * approval prompt the model would get.
 */
export function AppsPage() {
  const apps = useLoad(() => call(() => window.akansha.apps.list()))
  const { run, pending } = useAction()
  const [query, setQuery] = useState('')
  const [url, setUrl] = useState('')

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = apps.data ?? []
    return needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all
  }, [apps.data, query])

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Applications</h1>
        <span className="grow" />
        <Btn
          disabled={pending !== null}
          onClick={() =>
            void run('Rescan applications', async () => {
              await call(() => window.akansha.apps.list(true))
              await apps.reload()
            }, 'Application list refreshed')
          }
        >
          Rescan
        </Btn>
      </div>

      <Card>
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            type="search"
            className="grow"
            placeholder="Search installed applications"
            value={query}
            aria-label="Search applications"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          <input
            className="grow"
            placeholder="Open a web address (https://…)"
            value={url}
            aria-label="Web address"
            onChange={(e) => setUrl(e.target.value)}
          />
          <Btn
            disabled={!url.trim() || pending !== null}
            onClick={() =>
              void run('Open link', () => call(() => window.akansha.apps.openUrl(url.trim())), 'Opened in your browser')
            }
          >
            Open link
          </Btn>
          <Btn
            disabled={pending !== null}
            onClick={() =>
              void run('Pick a folder', async () => {
                const { path } = await call(() => window.akansha.apps.pickFolder())
                if (path) await call(() => window.akansha.apps.openPath(path))
              })
            }
          >
            Open a folder…
          </Btn>
        </div>
      </Card>

      <ErrorNote error={apps.error} />

      <Card title={`${list.length} applications`} flush>
        {list.length === 0 ? (
          <Empty>{apps.loading ? 'Scanning the Start Menu…' : 'No application matches that.'}</Empty>
        ) : (
          <div className="list scroll-320">
            {list.map((a) => (
              <div key={`${a.source}:${a.target}`} className="list-item">
                <Pill>{a.source}</Pill>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate">{a.name}</div>
                  <div className="dim small mono truncate">{a.target}</div>
                </div>
                <Btn
                  size="sm"
                  variant="primary"
                  disabled={pending !== null}
                  onClick={() => void run(`Launch ${a.name}`, () => call(() => window.akansha.apps.launch(a.name)), `${a.name} launched`)}
                >
                  Launch
                </Btn>
                <Btn
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => void run(`Focus ${a.name}`, () => call(() => window.akansha.apps.focus(a.name)))}
                >
                  Focus
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`Close ${a.name}`, async () => {
                      const { closed } = await call(() => window.akansha.apps.close(a.name))
                      return closed
                    }, `${a.name} asked to close`)
                  }
                >
                  Close
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
