# Database

There is no file to check in here. The live database is created on first run at:

```
%APPDATA%\Akansha\database\akansha.db
```

It is SQLite via Node's built-in `node:sqlite` module (`DatabaseSync`), opened in
WAL mode with `foreign_keys = ON`. No native module, so nothing needs rebuilding
when Electron updates.

## Schema

Version 2, defined as the `MIGRATIONS` array in
[`electron/db/db.ts`](../electron/db/db.ts). A `schema_version` table records
which migrations have run; new versions are appended to the array and never
edited in place.

| Table | Holds | Owned by |
| --- | --- | --- |
| `conversations` | chat threads with created/updated stamps | `chat.repo.ts` |
| `messages` | one row per turn, cascade-deleted with its conversation | `chat.repo.ts` |
| `tasks` | reminders and scheduled automation runs, with last result | `state.repo.ts` |
| `memories` | durable facts, with category, source and confidence — bodies encrypted | `state.repo.ts` |
| `automations` | name, trigger and steps stored as JSON columns | `state.repo.ts` |
| `activity` | the audit trail: every tool call, outcome and duration | `log.repo.ts` |
| `usage` | tokens, latency and estimated cost per model | `log.repo.ts` |
| `notifications` | what Akansha told you, and whether you read it | `log.repo.ts` |
| `knowledge_folders` | indexed folders and when they were last indexed | `knowledge.repo.ts` |
| `knowledge_chunks` | text chunks plus search terms, cascade-deleted with the folder | `knowledge.repo.ts` |
| `knowledge_vectors` | one embedding per chunk: `model`, `dim`, and `vec` as a Float32 little-endian BLOB | `knowledge.repo.ts` |

`knowledge_vectors` came in with migration 2 and is only populated when embeddings
are turned on in Settings → Knowledge. A vector is never compared against a query
from a different model or a different dimension, so switching embedding models
degrades to keyword ranking until you reindex rather than returning nonsense.

## What is encrypted

Memory bodies are stored as `v1:iv:tag:ct` — AES-256-GCM with a random IV per
write. The 32-byte data key is generated on first run and wrapped with Windows
DPAPI in `%APPDATA%\Akansha\memkey.bin` (header `JKW1`; `JKP1` means OS encryption
was unavailable and the key is stored unwrapped, which the app reports rather than
hides). Copy the `.db` without the key file and the memory text is unreadable.

Nothing else in the file is encrypted: conversations, tasks and the audit trail are
plaintext, protected by the Windows account the folder lives under.

No API key, password or token is ever stored here — secrets live in
`%APPDATA%\Akansha\secrets.bin`, encrypted with Windows DPAPI. Credential-shaped
strings are redacted before an `activity`, `notifications` or conversation-title
row is written, so a key pasted into a prompt does not survive as a label.

## Working with it

Repositories are the only code that writes SQL; they use the `run` / `all` / `get`
helpers, which are always parameterised. `db` is assigned inside
`initDatabase(userDataDir)`, so a test can point it at a temp directory and still
import every repository — that is what `tests/database.test.ts` does.

To reset: quit Akansha and delete the `database` folder. Activity is pruned
automatically at startup according to Settings → Privacy → log retention.
