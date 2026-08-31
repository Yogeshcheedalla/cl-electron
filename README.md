# Akansha

A Windows desktop AI assistant that actually operates the machine: real files,
real processes, real PowerShell, real scheduled work — behind a permission gate
that asks before anything destructive happens.

Electron + React + TypeScript. No mock buttons, no simulated tool results: every
control either performs a real operation or says why it cannot.

This app was called JARVIS. On first launch after the rename it copies
`%APPDATA%\JARVIS` forward to `%APPDATA%\Akansha` so an existing install keeps its
API keys, memories and history; the old folder is left in place. Inside it,
`jarvis.db` and `jarvis.log` are renamed to `akansha.db` and `akansha.log` once,
and nothing is renamed if the new name is already there. The renderer global is
`window.akansha` and the single main → renderer push channel is `akansha:event`.

## What it does

| Area | Capability |
| --- | --- |
| Chat | Streaming replies, tool use, attachments (images + readable documents), per-conversation history in SQLite |
| Models | Anthropic, OpenAI, and local Ollama; automatic role routing (fast / general / reasoning / coding / vision) with per-role model overrides |
| Files | Browse, search, read, write, copy, move, rename, delete — inside allowed roots, with traversal and clobber protection |
| Terminal | PowerShell and argv-only process execution, classified per command, with timeout, tree-kill and full output capture |
| System | Live CPU / memory / disk / battery / network, top processes, shutdown / restart / sleep / lock (always confirmed) |
| Apps | Enumerate installed apps from the Start Menu, launch, focus, close, open URLs and paths |
| Automations | Multi-step tool sequences, manual or scheduled, with per-step results and a dry run that prints the calls it would make |
| Tasks | One-off and repeating reminders with real Windows notifications |
| Memory | Durable facts the assistant may recall, searchable and editable by you, encrypted at rest |
| Knowledge | Index local folders — including PDFs — and search them by keyword, or by keyword blended with embeddings |
| Web | Search and page-to-text extraction |
| Git | Status, diff, log, and commit (confirmed) for a repository you point it at |
| Voice | Speech out via Windows voices; dictation offline through whisper.cpp when you point at it, otherwise OpenAI Whisper |
| Screen | On-demand screenshots, off by default, always announced |
| Updates | Optional auto-update from an HTTPS feed you configure; nothing is contacted, downloaded or installed without you asking |
| Developer | Tool registry with per-tool permission overrides, direct tool invocation, activity audit, diagnostics, token/cost usage |

38 tools are registered. The Developer page lists every one with its permission
level, and the Activity page records every call with its outcome.

## Requirements

- Windows 10 or 11
- Node.js 24 or newer — the database uses the built-in `node:sqlite` module, so
  there is no native build step
- An API key for at least one cloud provider, or a local Ollama install. The
  `LOCAL` role defaults to `qwen3.5:9b` (Apache-2.0, 6.6 GB, tools + vision), so
  `ollama pull qwen3.5:9b` is all it takes to run with no key at all; drop to
  `qwen3.5:4b` on a tight 16 GB machine. Nothing here downloads a model for you.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Then open Settings → AI Providers and paste a key. Keys are encrypted with
Windows DPAPI (Electron `safeStorage`) and are never sent to the renderer, never
written to a log, and never shown again after saving.

## Offline dictation (optional)

Nothing is bundled and the app never downloads a model on your behalf, so this is
two manual files. Fetch a whisper.cpp Windows build — a release asset named like
`whisper-blas-bin-x64.zip` from `ggerganov/whisper.cpp` — and one GGML model from
`ggerganov/whisper.cpp` on Hugging Face, then unpack both into one folder. On this
machine that folder is `C:\jarvis claude\.whisper`, holding `whisper-cli.exe`
beside its DLLs and `ggml-base.en.bin`; `.whisper/` is git-ignored, since it is
~218 MB of binaries and weights.

Point Settings → Voice at the two paths, turn *Offline dictation* on, and the
card shows **Ready** with the model it will use. `base.en` transcribes a five
second clip in about 1.3 s on CPU and gets ordinary commands verbatim, but it
misses proper nouns — it rendered "Akansha" as "Akuncha" and "Priya" as
"pre-ya". `ggml-small.en` and `ggml-medium.en` fix most of that in exchange for
size and time.

## Build and package

```bash
npm run build
```

```bash
npm run package
```

The installer lands in `dist\Akansha Setup 0.1.0.exe`. It is **not code-signed**:
no certificate is configured, so Windows SmartScreen will warn on first run. Set
`CSC_LINK` and `CSC_KEY_PASSWORD` to produce a signed build.

## Checks

```bash
npm run typecheck && npm run lint && npm run test
```

267 tests cover command classification, the permission gate, path guarding, the
IPC surface — including a fuzz pass that drives every channel with hostile
arguments — the tool registry, the database, memory encryption, the PDF parser,
knowledge indexing and vector storage, automation dry runs, the update feed, the
scheduler and the process layer. `tests/shell.test.ts` starts real PowerShell
processes and the fuzz pass waits on a UNC timeout, so the suite takes about
thirty seconds.

## Safety defaults

Screen capture, proactive mode, wake word, telemetry and start-with-Windows are
all **off** until you turn them on. Destructive confirmation is **on**. The
microphone is only ever opened while you hold the push-to-talk control.

`SECURITY.md` documents the threat model and every guard. `ARCHITECTURE.md`
explains the process split and where to add code. `DEVELOPMENT.md` covers the
day-to-day workflow.

## Known limitations

- The installer is unsigned. Signing is wired up and environment-driven, but no
  certificate is available here, so Windows SmartScreen warns on first run.
- The auto-update feed is off and empty by default. It works against a directory
  of `npm run package` output served over HTTPS; there is no hosted feed.
- Dictation is offline only if you supply the recogniser. whisper.cpp runs the
  clip locally with no key and no upload, but the binary and the model are not
  bundled and are not downloaded — you point Settings → Voice at both. Without
  them, dictation falls back to OpenAI Whisper, which uploads the clip. Which
  engine will run is shown before you speak.
- The wake word setting exists but always-on listening is not implemented; voice
  input is push-to-talk only.
- No synthetic mouse or keyboard input. Akansha focuses windows and runs real
  commands instead of pretending to click.
- Embeddings call out to a provider — OpenAI-compatible `/v1/embeddings` or a
  local Ollama — rather than running an ONNX model in process. They are off by
  default, and keyword ranking is always the fallback.
- Semantic search is a brute-force cosine scan over every stored vector. Fine for
  tens of thousands of chunks, not for millions.
- PDF text extraction reads the text layer. A scanned PDF has no text layer and is
  reported as such rather than returning an empty string; there is no OCR.
- Memories are encrypted at rest; the rest of the database is not.
- One orchestrator drives all tool use with role-based model routing; there is no
  multi-agent delegation.
