# Architecture

## Two processes, one narrow bridge

```
┌─ Renderer (sandboxed, no Node) ──────────────┐
│  src/  React 19 + zustand                    │
│  window.akansha.<ns>.<method>(...)            │
└───────────────┬──────────────────────────────┘
                │  contextBridge, generated from API_SHAPE
┌───────────────▼──────────────────────────────┐
│  electron/preload/index.ts                   │
│  invoke('ns:method') + one push channel      │
└───────────────┬──────────────────────────────┘
                │  ipcMain.handle, one handler per channel
┌───────────────▼──────────────────────────────┐
│  Main process                                │
│  main/      window, tray, shortcuts, IPC     │
│  services/  the OS-facing work               │
│  agents/    the tool registry                │
│  ai/        providers, router, orchestrator  │
│  db/        SQLite repositories              │
│  core/      logger, audit, bus, util         │
└──────────────────────────────────────────────┘
```

`shared/ipc.ts` holds `API_SHAPE`, a plain object of namespace → method names. It
is the single source of truth: the preload builds its whitelist from it, the main
process must register a handler for every entry (checked at boot by
`assertHandlerCoverage()` and at build time by `tests/ipc-surface.test.ts`), and
`shared/api.ts` gives the same shape its types. Adding a feature means editing
`API_SHAPE` first; forgetting the handler fails the test suite rather than a click.

Main → renderer traffic uses exactly one channel, `akansha:event`, carrying a
discriminated union (`AkanshaEvent`) for streaming deltas, tool progress, approval
requests, notifications, task updates and state changes. There is no generic
`invoke`, no `eval` channel and no way to reach Node from React.

## Request path

Every operation — whether the user clicked it, the model asked for it, or a
schedule fired it — converges on one function:

```
invokeTool(name, input, { source })
  ├─ getTool(name)                 unknown name → refuse
  ├─ schema.parse(input)           zod; invalid input never reaches the OS
  ├─ authorize({...})              effectiveLevel → allow | ask | deny
  │    └─ approvals.ask()          UI prompt, 3-minute timeout, deny by default
  ├─ tool.run(input)               the actual work
  └─ activity.add(...)             audit row with outcome and duration
```

`electron/services/permissions.ts` computes the effective level (declared level,
plus any user override, plus trusted-tool state). `guard.ts` turns that into
allow / ask / deny. `approvals.ts` owns the pending prompts. Nothing calls a
service directly to bypass this; the IPC handlers for destructive namespaces go
through the same gate.

## The choke points

Each dangerous capability has exactly one implementation, so a guard cannot be
forgotten in a second copy:

| Concern | File | What it guarantees |
| --- | --- | --- |
| Process spawning | `services/shell.ts` | argv-only `spawn`, `shell: false`, timeout + `taskkill /T /F`, 1 MB output cap, cancellable by `execId` |
| Command intent | `services/command-validator.ts` | Rule table → SAFE / CONFIRM / PRIVILEGED / BLOCKED, highest severity wins, base64 `-EncodedCommand` decoded first |
| Paths | `services/path-guard.ts` | `safePath` (system locations denied) → `readablePath` (credential files refused) → `writablePath` (must sit inside an allowed root) |
| Secrets | `services/secrets.ts` | DPAPI-encrypted at rest, never returned over IPC, only `has()` is exposed |
| Memory at rest | `core/crypto.ts` | AES-256-GCM over memory bodies; the data key is DPAPI-wrapped in `memkey.bin` |
| Redaction | `core/util.ts` | `redact()` runs over logs, errors and IPC results — and over the row before `activity`, `notifications` and conversation titles are written |
| Dictation | `services/stt-local.ts` | whisper.cpp through `runExe` with fixed argv; both paths via `readablePath`; non-WAV refused before spawning; the clip lives in a `mkdtemp` dir deleted in `finally` |

## AI layer

`ai/router.ts` picks a role from the prompt (FAST for pleasantries, CODING for
code, REASONING for analysis or long input, VISION when an image is attached,
GENERAL otherwise) and resolves it to a provider + model from settings; turn
`autoRoute` off to pin one model. It also prices usage per model.

`ai/providers.ts` implements Anthropic, OpenAI and Ollama behind one interface
(`stream`, tool calls, images). `ai/context.ts` builds the system prompt from
settings, machine facts, memories and enabled skills. `ai/orchestrator.ts` runs
the model → tool → model loop, at most 8 rounds per request, streaming deltas and
tool phases to the UI and persisting the conversation.

Skills are declarative only: a manifest plus prompt text plus a list of existing
tool names. Nothing in a skill folder is imported or evaluated, which is why they
need no sandbox — see `skills/README.md`.

## Storage

`node:sqlite` (`DatabaseSync`) in WAL mode at `%APPDATA%\Akansha\database\akansha.db`,
with a `MIGRATIONS` array and a `schema_version` table. Repositories are split by
concern: `chat.repo` (conversations, messages), `state.repo` (tasks, memories,
automations), `log.repo` (activity, usage, notifications), `knowledge.repo`
(indexed folders, chunks, and `knowledge_vectors` — one Float32 BLOB per chunk,
tagged with the model that produced it). `db` is assigned only inside
`initDatabase()`, so repositories import cleanly in tests against a temp
directory.

Memory bodies are stored encrypted (`v1:iv:tag:ct`, AES-256-GCM); the data key is
generated once and wrapped with DPAPI in `memkey.bin`. Rows written by an older
build in plaintext are read as-is and sealed on the next launch, so upgrading is
not a flag day. Nothing else in the database is encrypted — the file is protected
by the account it lives under.

Settings live in `%APPDATA%\Akansha\settings.json` (plain JSON, no secrets), keys
in `secrets.bin` (DPAPI), logs in `logs\`. The folder was `%APPDATA%\JARVIS`
before the rename; `main/userdata.ts` copies it forward once and never deletes it.
The database and log files were `jarvis.db` and `jarvis.log`; `db/db.ts` and
`core/logger.ts` rename each forward once — the database together with its `-wal`
and `-shm` siblings — and skip the rename when the new name already exists.

## The wordmark

`shared/brand.ts` holds `PRODUCT` and `MOTTO`, so the name and the tagline have a
single definition shared by the titlebar, the dashboard header and the tray
tooltip. The renderer global (`window.akansha`), the push channel
(`akansha:event`) and the exported types (`AkanshaApi`, `AkanshaEvent`,
`AkanshaNotification`) carry the same name, so nothing in the bridge still reads
as the old brand.

## Adding a capability

1. Write the work in `electron/services/`, using `shell.ts` for processes and
   `path-guard.ts` for paths.
2. Register a tool in `electron/agents/tools.ts` with a zod schema and a
   permission level, so the model and the UI get it at once.
3. Add the method to `API_SHAPE`, type it in `shared/api.ts`, and handle it in
   `electron/main/ipc.ts`.
4. Add a test. If the tool is SAFE, `tests/tools.test.ts` must be edited by hand —
   that is deliberate.
