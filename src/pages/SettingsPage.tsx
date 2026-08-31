import { useState } from 'react'
import { Bar, Btn, Card, Empty, Field, Pill, Toggle } from '../components/ui'
import { useAction, useInterval, useLoad } from '../hooks/useAsync'
import { call } from '../services/api'
import { stamp } from '../services/format'
import { useApp } from '../stores/app'
import type { ModelRole, PermissionLevel, ProviderConfig, Settings, ToolResult, UpdateState } from '../../shared/types'

const LEVELS: PermissionLevel[] = ['SAFE', 'CONFIRM', 'PRIVILEGED', 'BLOCKED']
const ROLES: ModelRole[] = ['GENERAL', 'FAST', 'REASONING', 'CODING', 'VISION', 'LOCAL']
const MODES: Settings['mode'][] = ['STANDARD', 'PRODUCTIVITY', 'DEVELOPER', 'RESEARCH', 'PRIVACY', 'AUTOMATION']

/** What each fallback mode actually does to a request, in one line. */
const FALLBACK_HINTS: Record<Settings['ai']['fallback'], string> = {
  LOCAL_FIRST: 'Ollama answers when it can; a cloud provider is used only if the local model cannot.',
  CLOUD_FIRST: 'The routed cloud model answers; Ollama is the fallback when the cloud call fails.',
  LOCAL_ONLY: 'Nothing leaves this machine. A request fails rather than reaching a cloud provider.',
  CLOUD_ONLY: 'Only cloud providers are used. Needs an API key.'
}
const SECTIONS: (keyof Settings)[] = [
  'general',
  'ai',
  'voice',
  'automation',
  'memory',
  'knowledge',
  'updates',
  'keyboard',
  'privacy'
]

const STATUS_TONE: Record<UpdateState['status'], string> = {
  idle: '',
  checking: 'info',
  available: 'warn',
  downloading: 'info',
  downloaded: 'ok',
  error: 'bad'
}

/**
 * A saved key is never sent back to this window: the provider list only reports
 * whether one exists. The input is write-only and clears itself after saving.
 *
 * Ollama is the one provider with no key box at all -- it takes no key, and a
 * disabled password field would only invite the question. In its place goes the
 * real state of the local runner: installed, running, and whether the model the
 * LOCAL route names has been pulled.
 */
function ProviderRow({ provider, onChanged }: { provider: ProviderConfig; onChanged: () => Promise<void> }) {
  const { settings, saveSettings } = useApp()
  const { run, pending } = useAction()
  const [key, setKey] = useState('')
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null)
  const local = provider.local

  return (
    <div className="card">
      <div className="row wrap between" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <strong>{provider.id}</strong>
          {local ? (
            <Pill tone={local.running && local.selectedInstalled ? 'ok' : local.installed ? 'warn' : 'bad'}>
              {!local.installed
                ? 'Not installed'
                : !local.running
                  ? 'Not running'
                  : !local.selectedInstalled
                    ? 'Model not pulled'
                    : 'Ready — no key needed'}
            </Pill>
          ) : (
            <Pill tone={provider.hasApiKey ? 'ok' : 'warn'}>{provider.hasApiKey ? 'Key saved' : 'No key'}</Pill>
          )}
          {settings?.ai.provider === provider.id && <Pill tone="info">Default</Pill>}
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Btn
            size="sm"
            disabled={pending !== null}
            onClick={() =>
              void run(`Test ${provider.id}`, async () => {
                setTest(await call(() => window.akansha.ai.test(provider.id)))
              })
            }
          >
            Test
          </Btn>
          {settings && settings.ai.provider !== provider.id && (
            <Btn
              size="sm"
              disabled={pending !== null}
              onClick={() => void run('Set default provider', () => saveSettings({ ai: { ...settings.ai, provider: provider.id } }), `${provider.id} is now the default`)}
            >
              Make default
            </Btn>
          )}
        </div>
      </div>

      {local ? (
        <div className="col" style={{ gap: 6, marginTop: 8 }}>
          <span className="small">{local.detail}</span>
          {local.hint && <span className="dim small mono">{local.hint}</span>}
          <span className="dim small">
            {local.models.length
              ? `Pulled: ${local.models.slice(0, 8).join(', ')}`
              : 'No models pulled yet.'}
            {' · '}
            Recommended: {local.recommended}
            {local.recommendedInstalled ? ' (pulled)' : ''}
          </span>
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
          <input
            className="grow"
            type="password"
            autoComplete="off"
            placeholder={provider.hasApiKey ? 'Replace the saved key' : 'Paste an API key'}
            aria-label={`${provider.id} API key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Btn
            size="sm"
            variant="primary"
            disabled={!key.trim() || pending !== null}
            onClick={() =>
              void run(`Save ${provider.id} key`, async () => {
                await call(() => window.akansha.ai.setKey(provider.id, key.trim()))
                setKey('')
                await onChanged()
              }, 'Key saved to Windows Credential storage')
            }
          >
            Save key
          </Btn>
          {provider.hasApiKey && (
            <Btn
              size="sm"
              variant="danger"
              disabled={pending !== null}
              onClick={() =>
                void run(`Remove ${provider.id} key`, async () => {
                  await call(() => window.akansha.ai.clearKey(provider.id))
                  await onChanged()
                }, 'Key removed')
              }
            >
              Remove key
            </Btn>
          )}
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
        <span className="dim small mono grow truncate">
          {provider.baseUrl} · {provider.model}
        </span>
        {test && <Pill tone={test.ok ? 'ok' : 'bad'}>{test.detail}</Pill>}
      </div>
    </div>
  )
}

/** The permissions dashboard: every tool, its built-in level and your override. */
function PermissionsCard() {
  const tools = useLoad(() => call(() => window.akansha.tools.list()))
  const { run, pending } = useAction()
  const [group, setGroup] = useState('all')

  const all = tools.data ?? []
  const groups = [...new Set(all.map((t) => t.group))].sort()
  const rows = group === 'all' ? all : all.filter((t) => t.group === group)

  return (
    <Card
      title={`Tool permissions (${all.length})`}
      right={
        <select value={group} aria-label="Tool group" style={{ width: 160 }} onChange={(e) => setGroup(e.target.value)}>
          <option value="all">Every group</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      }
      flush
    >
      {rows.length === 0 ? (
        <Empty>{tools.error ?? 'Loading tools…'}</Empty>
      ) : (
        <div className="scroll-320" style={{ maxHeight: '48vh' }}>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it does</th>
                <th>Built-in</th>
                <th>In force</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.name}>
                  <td className="mono small">{t.name}</td>
                  <td className="dim small">{t.description}</td>
                  <td>
                    <Pill tone={t.level === 'BLOCKED' ? 'bad' : t.level === 'PRIVILEGED' ? 'priv' : t.level === 'CONFIRM' ? 'warn' : 'ok'}>
                      {t.level}
                    </Pill>
                  </td>
                  <td>
                    <select
                      value={t.effectiveLevel}
                      aria-label={`Permission for ${t.name}`}
                      disabled={pending !== null}
                      onChange={(e) =>
                        void run(`Set ${t.name}`, async () => {
                          await call(() => window.akansha.tools.setPermission(t.name, e.target.value as PermissionLevel))
                          await tools.reload()
                        }, `${t.name} → ${e.target.value}`)
                      }
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/**
 * The updater, reported as it actually is. `supported` is false when Akansha runs
 * from source -- there is no installer to replace -- and `configured` is false
 * until an https feed URL is saved. Nothing is checked, downloaded or installed
 * without a click, and installing asks for confirmation in the main process.
 */
function UpdatesCard() {
  const { settings, saveSettings } = useApp()
  const { run, pending } = useAction()
  const state = useLoad(() => call(() => window.akansha.updates.state()))
  const [feed, setFeed] = useState<string | null>(null)

  const u = state.data
  // Poll only while bytes are moving: progress is reported through updates:state.
  useInterval(() => void state.reload(), u?.status === 'downloading' ? 1000 : null)

  if (!settings) return null
  const cfg = settings.updates
  const url = feed ?? cfg.feedUrl
  const act = (label: string, fn: () => Promise<ToolResult<UpdateState>>) =>
    void run(label, async () => {
      state.setData(await call(fn))
    })

  return (
    <Card title="Updates" right={u ? <Pill tone={STATUS_TONE[u.status]}>{u.status}</Pill> : null}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <span className="dim small grow">
          Version {u?.currentVersion ?? '…'}
          {u?.checkedMs ? ` · last checked ${stamp(u.checkedMs)}` : ' · never checked'}
        </span>
        <Btn
          size="sm"
          disabled={pending !== null || !u?.configured || !cfg.enabled}
          onClick={() => act('Check for updates', () => window.akansha.updates.check())}
        >
          Check now
        </Btn>
        <Btn
          size="sm"
          variant="primary"
          disabled={pending !== null || u?.status !== 'available'}
          onClick={() => act('Download update', () => window.akansha.updates.download())}
        >
          Download
        </Btn>
        <Btn
          size="sm"
          variant="danger"
          disabled={pending !== null || u?.status !== 'downloaded'}
          onClick={() => act('Install update', () => window.akansha.updates.install())}
        >
          Install and restart
        </Btn>
      </div>

      {u?.status === 'downloading' && <Bar value={u.downloadPercent ?? 0} />}
      {u?.availableVersion && (
        <div className="small">
          Version {u.availableVersion} is available.
          {u.status === 'downloaded' ? ' Installing quits Akansha and runs the installer.' : ''}
        </div>
      )}
      {u?.message && <div className={`small ${u.status === 'error' ? '' : 'dim'}`}>{u.message}</div>}
      {u?.releaseNotes && <pre className="log" style={{ maxHeight: 160 }}>{u.releaseNotes}</pre>}

      <div className="col" style={{ gap: 8, marginTop: 10 }}>
        <Toggle
          label="Allow update checks"
          hint="Off means no update server is ever contacted."
          checked={cfg.enabled}
          onChange={(enabled) => void run('Save settings', () => saveSettings({ updates: { ...cfg, enabled } }))}
        />
        <Toggle
          label="Check once at startup"
          hint="Checks only. Downloading and installing always need a click."
          checked={cfg.checkOnStart}
          disabled={!cfg.enabled}
          onChange={(checkOnStart) => void run('Save settings', () => saveSettings({ updates: { ...cfg, checkOnStart } }))}
        />
        <Field label="Update feed URL" hint="An https directory containing latest.yml and the installer, as produced by npm run package.">
          <div className="row" style={{ gap: 6 }}>
            <input
              className="grow mono"
              placeholder="https://example.com/akansha/"
              value={url}
              aria-label="Update feed URL"
              onChange={(e) => setFeed(e.target.value)}
            />
            <Btn
              size="sm"
              disabled={pending !== null || url.trim() === cfg.feedUrl}
              onClick={() =>
                void run('Save settings', async () => {
                  await saveSettings({ updates: { ...cfg, feedUrl: url.trim() } })
                  setFeed(null)
                  await state.reload()
                }, 'Update feed saved')
              }
            >
              Save
            </Btn>
          </div>
        </Field>
      </div>

      <div className="dim small" style={{ marginTop: 8 }}>
        {u && !u.supported
          ? 'This copy is running from source, so there is no installed build to replace. Update checks only work in a packaged install.'
          : u && !u.configured
            ? 'No https feed URL is set, so no update server is contacted.'
            : 'Downloads are verified against the signature electron-builder wrote into latest.yml. An unsigned build still installs, but Windows SmartScreen will warn.'}
      </div>
    </Card>
  )
}

export function SettingsPage() {
  const { settings, saveSettings } = useApp()
  const { run, pending } = useAction()
  const providers = useLoad(() => call(() => window.akansha.ai.providers()))
  const [root, setRoot] = useState('')

  if (!settings) return <Empty>Loading settings…</Empty>
  const s = settings

  const patch = <K extends keyof Settings>(section: K, value: Settings[K]) =>
    void run('Save settings', () => saveSettings({ [section]: value } as Partial<Settings>))

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Settings</h1>
        <span className="grow" />
        <select
          value={s.mode}
          aria-label="Assistant mode"
          style={{ width: 170 }}
          onChange={(e) => void run('Change mode', () => saveSettings({ mode: e.target.value as Settings['mode'] }))}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <Card title="General">
        <div className="grid cols-2">
          <div className="col" style={{ gap: 8 }}>
            <Toggle
              label="Start with Windows"
              hint="Registers a login item. Nothing is added to startup without this switch."
              checked={s.general.startWithWindows}
              onChange={(startWithWindows) => patch('general', { ...s.general, startWithWindows })}
            />
            <Toggle
              label="Start minimised"
              checked={s.general.startMinimized}
              onChange={(startMinimized) => patch('general', { ...s.general, startMinimized })}
            />
            <Toggle
              label="Close to tray instead of quitting"
              checked={s.general.minimizeToTray}
              onChange={(minimizeToTray) => patch('general', { ...s.general, minimizeToTray })}
            />
            <Toggle
              label="Animations"
              hint="Your system's reduced-motion preference always wins."
              checked={s.general.animations}
              onChange={(animations) => patch('general', { ...s.general, animations })}
            />
          </div>
          <div className="col" style={{ gap: 8 }}>
            <Field label="Desktop notifications">
              <select
                value={s.general.notifications}
                onChange={(e) => patch('general', { ...s.general, notifications: e.target.value as Settings['general']['notifications'] })}
              >
                <option value="ALL">Everything</option>
                <option value="IMPORTANT">Important only</option>
                <option value="CRITICAL">Critical only</option>
                <option value="QUIET">Nothing</option>
              </select>
            </Field>
            <Field
              label="Talk hotkey"
              hint="Shows the window and takes one spoken instruction, wake word or not. Restart Akansha after changing this."
            >
              <input
                value={s.keyboard.globalShortcut}
                onChange={(e) => patch('keyboard', { ...s.keyboard, globalShortcut: e.target.value })}
              />
            </Field>
            <Field label="Command palette">
              <input
                value={s.keyboard.commandPalette}
                onChange={(e) => patch('keyboard', { ...s.keyboard, commandPalette: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Models">
        <div className="grid cols-2">
          <Field label={`Temperature — ${s.ai.temperature.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.ai.temperature}
              onChange={(e) => patch('ai', { ...s.ai, temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label="Maximum reply length (tokens)">
            <input
              type="number"
              min={256}
              max={32000}
              step={256}
              value={s.ai.maxTokens}
              onChange={(e) => patch('ai', { ...s.ai, maxTokens: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="grid cols-2" style={{ marginTop: 8 }}>
          <Field
            label="Local / cloud preference"
            hint={FALLBACK_HINTS[s.ai.fallback]}
          >
            <select
              value={s.ai.fallback}
              aria-label="Local or cloud preference"
              onChange={(e) => patch('ai', { ...s.ai, fallback: e.target.value as Settings['ai']['fallback'] })}
            >
              <option value="LOCAL_FIRST">Local first</option>
              <option value="CLOUD_FIRST">Cloud first</option>
              <option value="LOCAL_ONLY">Local only</option>
              <option value="CLOUD_ONLY">Cloud only</option>
            </select>
          </Field>
        </div>
        <div className="row wrap" style={{ gap: 16, marginTop: 8 }}>
          <Toggle label="Stream replies" checked={s.ai.streaming} onChange={(streaming) => patch('ai', { ...s.ai, streaming })} />
          <Toggle
            label="Pick a model per task"
            hint="Routes coding, reasoning and vision work to the models below."
            checked={s.ai.autoRoute}
            onChange={(autoRoute) => patch('ai', { ...s.ai, autoRoute })}
          />
        </div>
        {s.ai.autoRoute && (
          <div className="grid cols-3" style={{ marginTop: 10 }}>
            {ROLES.map((role) => {
              const entry = s.ai.routing[role]
              return (
                <Field key={role} label={role}>
                  <div className="row" style={{ gap: 6 }}>
                    <select
                      value={entry.provider}
                      aria-label={`${role} provider`}
                      onChange={(e) =>
                        patch('ai', {
                          ...s.ai,
                          routing: { ...s.ai.routing, [role]: { ...entry, provider: e.target.value as ProviderConfig['id'] } }
                        })
                      }
                    >
                      {(providers.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}
                        </option>
                      ))}
                    </select>
                    <input
                      className="grow"
                      value={entry.model}
                      aria-label={`${role} model`}
                      onChange={(e) => patch('ai', { ...s.ai, routing: { ...s.ai.routing, [role]: { ...entry, model: e.target.value } } })}
                    />
                  </div>
                </Field>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Providers and keys">
        <div className="col" style={{ gap: 10 }}>
          {(providers.data ?? []).map((p) => (
            <ProviderRow key={p.id} provider={p} onChanged={providers.reload} />
          ))}
          {!providers.data?.length && <Empty>{providers.error ?? 'Loading providers…'}</Empty>}
          <div className="dim small">
            Keys are encrypted with Windows DPAPI through Electron's safeStorage and never sent back to this window. You can
            also set <span className="mono">AKANSHA_ANTHROPIC_API_KEY</span> or <span className="mono">AKANSHA_OPENAI_API_KEY</span>{' '}
            in the environment instead.
          </div>
        </div>
      </Card>

      <PermissionsCard />

      <Card title="Automation">
        <Toggle
          label="Always confirm destructive actions"
          hint="Turning this off still leaves PRIVILEGED tools asking."
          checked={s.automation.confirmDestructive}
          onChange={(confirmDestructive) => patch('automation', { ...s.automation, confirmDestructive })}
        />
        <div className="card-title" style={{ marginTop: 12 }}>
          Folders Akansha may touch
        </div>
        <div className="col" style={{ gap: 6 }}>
          {s.automation.allowedRoots.map((r) => (
            <div key={r} className="row" style={{ gap: 8 }}>
              <span className="grow mono small truncate">{r}</span>
              <Btn
                size="sm"
                variant="ghost"
                disabled={pending !== null || s.automation.allowedRoots.length === 1}
                onClick={() =>
                  patch('automation', { ...s.automation, allowedRoots: s.automation.allowedRoots.filter((x) => x !== r) })
                }
              >
                Remove
              </Btn>
            </div>
          ))}
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="grow mono"
              placeholder="C:\Users\you\Projects"
              value={root}
              aria-label="New allowed folder"
              onChange={(e) => setRoot(e.target.value)}
            />
            <Btn
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void run('Choose folder', async () => {
                  const { path } = await call(() => window.akansha.apps.pickFolder())
                  if (path) setRoot(path)
                })
              }
            >
              Choose…
            </Btn>
            <Btn
              size="sm"
              variant="primary"
              disabled={!root.trim() || pending !== null}
              onClick={() => {
                patch('automation', { ...s.automation, allowedRoots: [...s.automation.allowedRoots, root.trim()] })
                setRoot('')
              }}
            >
              Add folder
            </Btn>
          </div>
          <div className="dim small">Anything outside these folders is refused by the path guard, for you and for the model.</div>
        </div>
      </Card>

      <Card title="Privacy">
        <div className="grid cols-2">
          <div className="col" style={{ gap: 8 }}>
            <Toggle
              label="Privacy mode"
              hint="Blocks clipboard reads, screen capture and the microphone outright."
              checked={s.privacy.privacyMode}
              onChange={(privacyMode) => patch('privacy', { ...s.privacy, privacyMode })}
            />
            <Toggle
              label="Allow screen capture"
              hint="Off by default. A banner appears in the window whenever a capture happens."
              checked={s.privacy.screenAccess}
              onChange={(screenAccess) => patch('privacy', { ...s.privacy, screenAccess })}
            />
            <Toggle
              label="Watch the clipboard"
              hint="Clipboard text stays local unless a request needs it."
              checked={s.privacy.clipboardAccess}
              onChange={(clipboardAccess) => patch('privacy', { ...s.privacy, clipboardAccess })}
            />
          </div>
          <div className="col" style={{ gap: 8 }}>
            <Toggle
              label="Proactive suggestions"
              hint="Off by default: Akansha stays quiet until you ask."
              checked={s.privacy.proactive}
              onChange={(proactive) => patch('privacy', { ...s.privacy, proactive })}
            />
            <Toggle
              label="Usage telemetry"
              hint="Local only — nothing is sent anywhere."
              checked={s.privacy.telemetry}
              onChange={(telemetry) => patch('privacy', { ...s.privacy, telemetry })}
            />
            <Field label="Keep the activity log for (days)">
              <input
                type="number"
                min={1}
                max={365}
                value={s.privacy.logRetentionDays}
                onChange={(e) => patch('privacy', { ...s.privacy, logRetentionDays: Number(e.target.value) })}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Knowledge and retrieval">
        <Toggle
          label="Use embeddings for knowledge search"
          hint="Off by default: indexing a folder sends its text to the provider below. Keyword ranking always runs, so this only adds recall on paraphrased questions."
          checked={s.knowledge.embeddings}
          onChange={(embeddings) => patch('knowledge', { ...s.knowledge, embeddings })}
        />
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          <Field label="Embedding provider">
            <select
              value={s.knowledge.provider}
              disabled={!s.knowledge.embeddings}
              onChange={(e) => patch('knowledge', { ...s.knowledge, provider: e.target.value as ProviderConfig['id'] })}
            >
              {(providers.data ?? [])
                .filter((p) => p.id !== 'anthropic' && p.id !== 'openrouter')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Embedding model">
            <input
              className="mono"
              value={s.knowledge.model}
              disabled={!s.knowledge.embeddings}
              aria-label="Embedding model"
              onChange={(e) => patch('knowledge', { ...s.knowledge, model: e.target.value })}
            />
          </Field>
        </div>
        <div className="dim small" style={{ marginTop: 8 }}>
          Anthropic and OpenRouter have no embeddings endpoint, so they are not listed. <span className="mono">ollama</span> keeps
          the text on this machine — install a model such as <span className="mono">nomic-embed-text</span> and nothing leaves your
          PC. Changing the model means reindexing: vectors are only compared against ones from the same model and dimension.
        </div>
      </Card>

      <UpdatesCard />

      <Card title="Reset">
        <div className="row wrap" style={{ gap: 8 }}>
          {SECTIONS.map((section) => (
            <Btn
              key={section}
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void run(`Reset ${section}`, async () => {
                  await call(() => window.akansha.settings.resetSection(section))
                  await useApp.getState().load()
                }, `${section} reset to defaults`)
              }
            >
              Reset {section}
            </Btn>
          ))}
        </div>
      </Card>
    </div>
  )
}
