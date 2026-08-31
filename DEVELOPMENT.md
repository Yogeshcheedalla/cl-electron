# Development

## Setup

```bash
npm install
```

Node 24+ is required: the database uses the built-in `node:sqlite` module, so
there is no native compilation and no `better-sqlite3` rebuild step. Electron 44
ships a matching Node, which is why the module is marked external in the main
build.

```bash
npm run dev
```

`electron-vite dev` starts the Vite dev server for the renderer, builds main and
preload, and launches Electron. Editing anything under `src/` hot-reloads;
editing `electron/` or `shared/` restarts the main process. `Ctrl+Shift+I` opens
devtools.

Without an API key the app still runs — chat reports the missing key honestly and
every other page works.

## Layout

```
electron/
  main/       window creation, tray, global shortcuts, IPC registration, lifecycle
  preload/    the contextBridge whitelist (the only file that touches ipcRenderer)
  services/   OS-facing work: files, shell, terminal, apps, system, voice, ...
  agents/     the tool registry the model and the UI both call
  ai/         providers, role router, prompt context, orchestrator
  db/         node:sqlite connection, migrations, repositories
  core/       logger, audit, event bus, redaction and small helpers
shared/       API_SHAPE, channel list, event union, types, record types
src/          React renderer: components, features, pages, hooks, stores, styles
skills/       declarative skills (manifest + prompt), bundled with the installer
tests/        vitest suites, plus the electron stub they run against
scripts/      build-time helpers (icon generation)
assets/       tray and app icons
```

## Adding an operation end to end

1. **Service** — put the work in `electron/services/`. Spawn nothing yourself:
   call `runPowerShell` / `runExe` from `services/shell.ts`. Resolve every path
   through `path-guard.ts`.
2. **Tool** — register it in `electron/agents/tools.ts` with a zod schema, a
   description the model can act on, and a permission level. This is what makes it
   available to the model, to automations and to the Developer page at once.
3. **Bridge** — add the method to `API_SHAPE` in `shared/ipc.ts`, type it in
   `shared/api.ts`, and register the handler in `electron/main/ipc.ts`. Handlers
   return `ok(value)` / `fail(...)`; use `attempt()` to turn a throw into a
   structured failure.
4. **UI** — call it as `window.akansha.<ns>.<method>()` via `src/services/api.ts`.
5. **Test** — see below.

Skipping step 3 fails `tests/ipc-surface.test.ts`; skipping the schema fails
`tests/tools.test.ts`.

## Tests

```bash
npm run test
```

Seventeen suites, 284 tests, about thirty seconds end to end. They run in plain
Node, not in Electron: `vitest.config.ts` aliases `electron` to
`tests/stubs/electron.ts`, and `initLogger` / `initSettings` / `initDatabase` are
called with a fresh temp directory per suite, so nothing touches your real
`%APPDATA%\Akansha`.

| Suite | Covers |
| --- | --- |
| `security.test.ts` | command classification table, permission levels, overrides |
| `filesystem.test.ts` | path guard layers and the files service |
| `approvals.test.ts` | the approval gate, trust, denial, shutdown |
| `tools.test.ts` | registry shape, schemas, the SAFE allowlist, model routing |
| `ipc-surface.test.ts` | channel/handler parity and window hardening, by source inspection |
| `ipc-fuzz.test.ts` | every channel against hostile arguments: traversal, UNC, injection, secrets |
| `database.test.ts` | migrations, every repository against real SQLite, and the `jarvis.db` forward-rename |
| `crypto.test.ts` | memory encryption, key wrapping, and the absence of plaintext in the `.db` |
| `knowledge.test.ts` | indexing, keyword ranking, vector storage, and the keyword fallback |
| `pdf.test.ts` | the PDF parser against PDFs built byte by byte in the test |
| `dry-run.test.ts` | dry-run verdicts, and that nothing was written or stamped |
| `updates.test.ts` | update feed validation and every refusal path |
| `userdata.test.ts` | carrying a pre-rebrand `%APPDATA%\JARVIS` install and its log forward |
| `voice.test.ts` | offline dictation: every refusal, and the argv whisper.cpp receives |
| `scheduler.test.ts` | reminders, repeat rollover, automation failure paths |
| `shell.test.ts` | real PowerShell: output, exit codes, timeout kill, argv safety |
| `core.test.ts` | redaction, result envelopes, settings merge, providers |

`vitest` runs with `silent: true` because the services log through the app's own
logger; failures are still printed in full. Vitest 4 takes options as the second
argument — `it('name', { timeout: 30_000 }, fn)`.

Four conventions worth knowing:

- The SAFE tool list in `tests/tools.test.ts` is a literal allowlist. If your new
  tool is SAFE, add it there by hand and be able to justify it.
- `tests/ipc-surface.test.ts` reads source with regexes rather than importing the
  main process, because importing it would drag in all of Electron.
- `tests/ipc-fuzz.test.ts` drives the real handlers with hostile arguments and
  asserts, among other things, that no reply echoes a credential-shaped string
  back. It is the slowest suite (a UNC path has to time out); that is the cost of
  it being real.
- `tests/pdf.test.ts` writes every fixture PDF from bytes at run time. No binary
  fixtures are committed, so there is nothing to trust in the repository.

## Typecheck and lint

```bash
npm run typecheck && npm run lint
```

Two TypeScript projects: `tsconfig.node.json` (main, preload, shared, tests) and
`tsconfig.web.json` (renderer). ESLint 10 flat config in `eslint.config.mjs`;
type-aware rules are deliberately off because `typecheck` already does that work.
`no-console` is an error outside `core/logger.ts` and `scripts/` — log through the
logger so output is redacted and written to disk.

## Build and package

```bash
npm run build
```

```bash
npm run package
```

`build` typechecks then emits `out/{main,preload,renderer}`. `package` runs the
build and then `electron-builder --win`, producing an NSIS installer in `dist/`.
The build is **unsigned**; set `CSC_LINK` and `CSC_KEY_PASSWORD` to sign.

`npm run clean` removes `out/` and `dist/`.

## Where the app keeps state

```
%APPDATA%\Akansha\
  settings.json     plain JSON, no secrets
  secrets.bin       API keys, DPAPI-encrypted
  memkey.bin        the memory data key, DPAPI-wrapped
  skills.json       which skills are disabled
  database\akansha.db  conversations, tasks, memories, automations, activity, usage
  logs\             daily log files, redacted
  skills\           your own skills; these win over bundled ones
```

The folder used to be `%APPDATA%\JARVIS`. On first launch after the rename,
`electron/main/userdata.ts` copies the old folder forward — a copy, not a move,
so rolling back to a JARVIS build still finds its keys and memories. It refuses
to run if the new folder already has data.

The two data files inside it were renamed too. `jarvis.db` becomes `akansha.db`
(`electron/db/db.ts`, moving the WAL and shared-memory siblings with it, since a
main file without its matching WAL is a corrupt database) and `jarvis.log` becomes
`akansha.log` (`electron/core/logger.ts`). Both are renames rather than copies,
both are skipped when the new name already exists, and both are covered by
`tests/database.test.ts` and `tests/userdata.test.ts`.

Delete the folder to reset the app completely. Uninstalling does not remove it.

## House rules

- Never spawn a process outside `services/shell.ts`, and never build a command by
  interpolating a value into a string without `psQuote`.
- Never expose a new global to the renderer. Everything goes through `API_SHAPE`.
- Never log a secret. `redact()` is applied for you if you log through `logger`.
- Never report success you did not observe: return what the tool actually said,
  including the exit code and stderr.
- Prefer the standard library and an existing choke point over a new dependency or
  a new abstraction.
