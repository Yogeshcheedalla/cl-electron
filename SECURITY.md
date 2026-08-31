# Security

Akansha runs arbitrary-looking work on a real Windows machine on behalf of a
language model. The design assumption is therefore that **the model may be wrong,
confused or manipulated** by a web page or a document it reads, and that the user
is the only authority. Everything below exists to keep that true.

## Renderer isolation

`electron/main/windows.ts` creates every window with:

```
contextIsolation: true
nodeIntegration: false
sandbox: true
```

The renderer receives exactly one global, `window.akansha`, generated from
`API_SHAPE`. It never receives `require`, `fs`, `child_process`, `process`,
`shell` or `ipcRenderer`. There is no generic execute channel: `tests/ipc-surface.test.ts`
fails the build if a channel matching `execute-anything`, `:eval`, `:exec`,
`:raw` or `node:` ever appears, if a handler exists outside `API_SHAPE`, if a
window option is loosened, or if the preload starts exposing raw IPC.

Navigation is locked to the app's own origin, and `web-contents-created` denies
every `window.open`.

## Permission model

Four levels, declared per tool in `electron/agents/tools.ts`:

| Level | Meaning |
| --- | --- |
| **SAFE** | Runs without a prompt. Reads, or writes only where the user pointed (clipboard, notification, memory, a new folder, a non-clobbering copy). 28 tools. |
| **CONFIRM** | Prompts once, and can be trusted per tool. Writing, deleting, renaming, moving, closing apps, committing, capturing the screen, running commands. |
| **PRIVILEGED** | Prompts **every time**, even when the tool is trusted and even with `confirmDestructive` off. Shutdown, restart, sleep, lock. |
| **BLOCKED** | Never runs and is not even offered to the model. A user override cannot loosen it. |

The SAFE set is spelled out as a literal list in `tests/tools.test.ts`, so
promoting a tool to "runs without asking" requires a deliberate edit to a test —
it can never happen as a side effect of adding a tool.

An approval prompt shows the tool, the reason, and the exact validated input.
Pending prompts expire after three minutes and **deny by default**; every prompt
still open at shutdown is denied. A denial throws `PermissionRefused`, so the
caller cannot continue and the model is told plainly that the user said no.

## Command execution

No string from the user or the model is ever handed to a shell for parsing.
`electron/services/shell.ts` is the only place in the codebase that spawns a
process, and it always uses argv arrays with `shell: false`. Values interpolated
into PowerShell go through `psQuote`, which doubles single quotes.

Before that, `command-validator.ts` classifies the command itself against a
curated rule table, decoding base64 `-EncodedCommand` payloads first and taking
the **highest** severity found anywhere in a chained command. Blocked outright:
disk formatting, `diskpart`, `vssadmin delete`, `bcdedit`, disabling Defender or
adding Defender exclusions, turning off the firewall, recursive deletion of a
drive root, `reg delete HKLM`, and download-and-execute pipelines
(`iwr … | iex`). Every run has a timeout, is killed as a process tree on expiry,
caps captured output at 1 MB, and lands in the audit log.

## Filesystem

Three layers, in order:

1. `safePath` — resolves and normalises (so `..` cannot escape), expands `~`, and
   refuses `C:\Windows`, `C:\Program Files\WindowsApps`, `C:\$Recycle.Bin`,
   `System Volume Information` and the all-users Startup folder.
2. `readablePath` — additionally refuses anything that looks like a credential
   store: `.env`, `id_rsa`, `*.pem`, `credentials.json`, `secrets.bin`.
3. `writablePath` — the target must sit inside a root listed in
   Settings → Automation. The default is your user profile and nothing else.

Overwrites require `overwrite: true`, copy and move refuse to clobber, deleting a
non-empty folder requires `recursive: true`, and deleting an allowed root itself
is refused. In the Files page a folder delete asks, in words, before recursion is
requested at all.

## Secrets

API keys are encrypted with Electron `safeStorage` (Windows DPAPI, scoped to the
signed-in account) in `%APPDATA%\Akansha\secrets.bin`. If OS encryption is
unavailable the fallback is recorded as a warning rather than hidden. Keys are
never returned over IPC — the UI can only ask `has(provider)` — never written to
a log, and never shown again after saving. `.env` is git-ignored and the app does
not read one.

`redact()` in `electron/core/util.ts` strips `sk-ant-…`, `sk-…`, `ghp_…`, `gho_…`
tokens and any value under a key named like `apiKey`, `password` or `token`. It
runs over log lines, over IPC results, and — after a test found the gap — inside
`describeError()`, so an upstream 401 body cannot carry a key into the UI.

It also runs at the persistence boundary. `tests/ipc-fuzz.test.ts` found that a
credential-shaped string pasted into a prompt survived verbatim in the `activity`
and `notifications` tables (both assemble their labels from tool arguments) and as
a conversation title. `redact()` is now applied to the whole row in
`activity.add`, `notifications.add`, `conversations.create` and
`conversations.rename` — which covers the SQLite write and the identical row
pushed to the live UI in one place. Message bodies are deliberately *not*
redacted: they are the conversation itself, not a label.

## Data at rest

Memory bodies are encrypted with AES-256-GCM (`v1:iv:tag:ct`, random IV per
write). The 32-byte data key is generated once and wrapped with DPAPI in
`%APPDATA%\Akansha\memkey.bin`, header `JKW1`. When OS encryption is unavailable
the key is written unwrapped under header `JKP1` and the app says so — the
degraded mode is reported, not hidden. A tampered row decrypts to a visible
`[encrypted: …]` marker rather than silently returning wrong text, because GCM
authenticates it.

`tests/crypto.test.ts` asserts the property that matters: after writing a memory,
the plaintext does not appear in the bytes of `akansha.db` or its WAL file.

The rest of the database — conversations, tasks, activity — is plaintext, and the
protection is the Windows account the folder lives under. Full-file encryption
would need a key at open time and a native SQLite build; `node:sqlite` has no
`sqlcipher` option.

## Offline dictation

whisper.cpp is launched like every other process here: through `runExe`, argv
only, `shell: false`, hard timeout, tree-kill on expiry. Both configured paths go
through `readablePath`, so `C:\Windows` is refused and a path that is not an
`.exe` is refused before a process is created. A clip that is not a RIFF/WAVE
file is rejected in `stt-local.ts` rather than handed to the binary. The clip is
written to a `mkdtemp` directory and that directory is deleted in a `finally`, so
a recording of the user's voice does not outlive its transcription. Nothing is
bundled and nothing is downloaded — the app never fetches a model on the user's
behalf.

## Updates

Auto-update is off with no feed URL until you set one. The URL must parse as
`https:` or it does not count as configured — `http:`, `ftp:` and `file:` are
refused. `autoDownload` and `autoInstallOnAppQuit` are both false, so a check
never becomes a download and a download never becomes an install; installing quits
the app and runs an installer, so it goes through the approval gate every time.
`electron-updater` is imported lazily, which means an unconfigured build never
loads the code that could contact a host. The feed URL baked into
`electron-builder.yml` is on the reserved `.invalid` TLD on purpose: a build that
forgets to configure a feed cannot phone home to a real one.

## Privacy defaults

| Setting | Default |
| --- | --- |
| Screen capture | **off**; every capture emits a state event and writes a notification, so it cannot happen invisibly |
| Microphone | only open while push-to-talk is held; no always-on listening exists |
| Dictation engine | **whisper.cpp locally when you configure it**, otherwise OpenAI. The engine that will run is shown before you record, and the engine that did run is shown with the transcript, so a fall back to the cloud is never silent |
| Wake word | **off** (and not implemented — the setting cannot silently enable listening) |
| Proactive mode | **off** |
| Telemetry | **off** — nothing is sent anywhere except the model provider you configured |
| Clipboard watcher | only runs when clipboard access is on and privacy mode is off; history stays local and is never auto-attached to a prompt |
| Start with Windows | **off**; changing it edits only the login item, with no mic activation |
| Destructive confirmation | **on** |

Activity logs are pruned to the configured retention window at every start.

## What Akansha will not do

No authentication, paywall or CAPTCHA bypass. No credential harvesting. No
disabling of security software. No silent shutdown, restart or process kill. No
git push, force-push or history rewrite without an explicit request. No network
listener: nothing about Akansha is reachable from another machine.

## Honest gaps

- **The installer is unsigned.** No certificate is configured, so SmartScreen will
  warn. `electron-builder.yml` documents how to sign.
- **An unsigned auto-update is only as trustworthy as its feed.** `electron-updater`
  verifies the SHA-512 in `latest.yml`, which proves the download matches what the
  feed published — not who published it. Serve the feed over HTTPS from a host you
  control, and sign the installer if you intend to ship to anyone else.
- Embeddings send chunk text to whichever endpoint you configured. With Ollama that
  is local; with an OpenAI-compatible endpoint it leaves the machine. Embeddings are
  off by default and the Knowledge page names the provider before you turn them on.
- Only memory bodies are encrypted at rest, not the whole database. See above.
- A CONFIRM tool that the user trusts stops prompting, by design. Trust is per
  tool and visible on the Developer page, where it can be revoked.
- Command classification is a curated rule table, not a parser. It is deliberately
  strict, but a sufficiently creative obfuscation could be rated CONFIRM instead
  of BLOCKED — which still means the user is asked before it runs.
- Prompt injection from a fetched page or document can make the model *attempt*
  something unwanted. The permission gate is what stops it, so leaving
  `confirmDestructive` on and keeping the trusted-tool list short matters.
- Skills contribute prompt text only. Executable plugins would need a real
  sandbox and are not supported.

## Reporting

Found something? Open an issue with reproduction steps. Do not include an API key
in the report.
