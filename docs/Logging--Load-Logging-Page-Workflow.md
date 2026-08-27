# Load Logging Page Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-27
**Status:** ✅ Implemented — no dedicated Rust command required (verified against `invoke_handler`)

---

## Overview

When the user opens the **Logging** page, the view mounts and fires a single
`load()` that reads the persisted activity log and renders it as a sortable,
searchable `DataTable`, with a header stats line (entry count + earliest
creation date) and an empty state.

1. **Vue UI** (`LoggingView.vue`) — `onMounted(load)` fires one loader that
   calls `logRepository.list()`, reverses + caps the result to the newest 100,
   and computes the header stats.
2. **Composable boundary** (`useAppContext.ts`) — DI provides the
   `logRepository` implementation (`JsonLogRepository` over `TauriFileStorage`)
   to the view; the view itself contains the loader logic (no dedicated
   load composable).
3. **TS services** (`src/services/log/`) — `JsonLogRepository.list()` reads
   `logs.json` through `FileStorage.read()` and yields `[]` when the file is
   absent or corrupt.
4. **Rust backend** supplies only the generic command already registered —
   `read_text_file` (the JSON read). The write side of the log (`append` /
   `clear`) re-uses `write_text_file`, and the producer (`AppLogger`) calls
   the generic `get_app_mode` command for the per-entry `mode` field.

The entire "Load Logging page" path is implemented on the frontend.
Persistence re-uses `JsonLogRepository` over `TauriFileStorage`, and the
entries it renders were produced by `AppLogger` (`app`, `runtime.check`,
`task.run`, ... sources) — no dedicated load or logging command is registered.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── LoggingView.vue                    ← Step 1-2: onMounted + load loader + table
├── composables/
│   ├── useAppContext.ts                   ← DI: wires logRepository + logger
│   └── useAutoDismiss.ts                  ← feedback banner auto-dismiss (3s)
├── components/
│   ├── DataTable.vue                      ← renders the log rows (sort/search/paging)
│   └── DataTableColumn.ts                 ← column contract (sortable/searchable/sortValue/value)
├── services/
│   ├── log/
│   │   ├── LogRepository.ts               ← port (interface)
│   │   ├── JsonLogRepository.ts           ← Step 3: logs.json adapter (list/append/clear)
│   │   └── AppLogger.ts                   ← Step 4: producer (record → get_app_mode + append)
│   └── shared/
│       ├── FileStorage.ts                 ← port (interface)
│       └── TauriFileStorage.ts            ← Step 3: invoke read/write adapter
└── models/
    └── LogEntry.ts                        ← LogEntry model + logsFromJson/logsToJson
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/LoggingView.vue` | `onMounted(load)` + `load()`/`confirmClear()` + log table |
| `src/composables/useAppContext.ts` | DI: builds `logRepository` + `logger` |
| `src/composables/useAutoDismiss.ts` | Auto-dismisses the `feedback` alert after 3s |
| `src/components/DataTable.vue` | Reusable table (sort/search/page-size/pagination) |
| `src/services/log/LogRepository.ts` | `list()`/`append()`/`clear()` port |
| `src/services/log/JsonLogRepository.ts` | `logs.json` adapter (200-entry cap) |
| `src/services/log/AppLogger.ts` | Producer: `record()` + cached `get_app_mode` |
| `src/services/shared/FileStorage.ts` / `TauriFileStorage.ts` | port + invoke-based adapter |
| `src/models/LogEntry.ts` | LogEntry model + JSON codecs |

---

### Rust Backend

```
src-tauri/
└── src/
    └── lib.rs                           ← registers generic I/O + app-mode commands
```

**Relevant existing commands (already registered in `invoke_handler`, `src-tauri/src/lib.rs:508-541`):**

- `read_text_file` — `TauriFileStorage.read()` for `logs.json` (the load path; fn at `lib.rs:119-125`, registered at `lib.rs:511`)
- `write_text_file` — `TauriFileStorage.write()` for `append`/`clear` (other flows; fn at `lib.rs:127`, registered at `lib.rs:512`)
- `get_app_mode` — `AppLogger.modeOf()` resolves the per-entry `mode` field (`dev`/`prod`); fn at `lib.rs:27-30`, registered at `lib.rs:524`

No load-specific command exists; the page composes these generic commands.

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const logRepository = overrides.logRepository ?? new JsonLogRepository(storage, 'logs.json')
const logger = overrides.logger ?? new AppLogger(logRepository)
```

Both are returned on the `AppContext` (`useAppContext.ts:65-66`). The logger is
kept distinct from the repository so callers record through `AppLogger` (which
adds the backend-reported `mode`) while the view reads through the repository.

`LoggingView.vue` consumes them in `setup`:

```ts
const { logRepository } = useAppContext()
```

Tests supply fakes at the same boundary (`createAppContext({ logRepository })`
with a `FakeLogRepository` in `LoggingView.test.ts`).

---

## Execution Flow

### Step 1 — Mount & Kick-off

**Location:** `src/views/LoggingView.vue:49`

```ts
onMounted(load)
```

**Behaviour:**

1. `onMounted` fires the single `load()` loader (unlike the Task page, which
   kicks off two parallel loads — the Logging page has one read source).
2. While `load()` is in flight, `logs` is `[]` and `stats` is `null`, so the
   template renders the header fallback "Loading..." (`LoggingView.vue:75`)
   and the body's `v-else` empty state ("No logs yet.") is shown until the
   entries resolve.
3. There is no `busy` ref on this page — the only loading affordance is the
   header `stats` fallback text.

**Flow chain:**
Page mount → `load()`

---

### Step 2 — View Loader (entries + stats)

**Location:** `src/views/LoggingView.vue:26-40`

```ts
async function load() {
  try {
    const entries = await logRepository.list()
    logs.value = [...entries].reverse().slice(0, 100)
    stats.value = entries.length === 0
      ? null
      : {
          count: entries.length,
          createdDate: new Date(Math.min(...entries.map(entry => Date.parse(entry.createdAt)))).toLocaleString(),
        }
  } catch {
    logs.value = []
    stats.value = null
  }
}
```

**Behaviour:**

1. `logRepository.list()` reads all persisted entries from `logs.json` (up to
   the repository's 200-entry cap).
2. The view renders the **newest 100** entries, newest-first: `entries` are
   reversed, then sliced to 100. The table additionally defaults to a `time`
   column sort in `desc` order (`LoggingView.vue:89-90`), so the newest entry
   sits at the top.
3. `stats` holds the total count (`entries.length`, the whole file — up to 200,
   not just the shown 100) and `createdDate` — the earliest `createdAt` across
   all entries, i.e. "since when the log started".
4. Defensive failure: any throw sets `logs.value = []` and `stats.value = null`
   — the view renders the empty state instead of an error banner.

---

### Step 3 — Repository / Persistence Layer

**Location:** `src/views/LoggingView.vue:28` → `src/services/log/JsonLogRepository.ts:14-22`

```ts
async list(): Promise<LogEntry[]> {
  const content = await this.fileStorage.read(this.logsFilePath)
  if (content === null) return []
  try {
    return logsFromJson(content)
  } catch {
    return []
  }
}
```

**Behaviour:**

1. `list()` reads through `FileStorage.read()` (`TauriFileStorage` →
   `invoke('read_text_file')`, keyed to `logs.json` in `useAppContext.ts:58`).
2. `null` content — the JSON file not created yet, `read_text_file` returning
   `Ok(None)` on NotFound — yields `[]`. This powers the "No logs yet."
   empty state (`LoggingView.vue:81`). There is no dedicated bootstrap path.
3. `logsFromJson` (`src/models/LogEntry.ts:30-33`) parses and guards against
   non-array content; the adapter additionally swallows parse errors (`[]`
   fallback), so a corrupted `logs.json` never breaks the page.
4. The repository caps persistence at **200 entries** (`MAX_ENTRIES`,
   `JsonLogRepository.ts:6`, applied in `append()` at `:27`) — the view's
   `.slice(0, 100)` is a display cap on top of that.

---

### Step 4 — Rust Commands (reference)

**Location:** `src-tauri/src/lib.rs:119-125` (`read_text_file`), `src-tauri/src/lib.rs:27-30` (`get_app_mode`)

```rust
#[tauri::command]
fn read_text_file(
    state: tauri::State<'_, AppDataDir>,
    path: String,
) -> Result<Option<String>, String> {
    read_app_file(&state.0, &path)
}

#[tauri::command]
fn get_app_mode() -> String {
    app_mode(cfg!(debug_assertions)).to_string()
}
```

Both are generic, pre-existing commands. The page-load path only touches
`read_text_file`; `get_app_mode` is used by the *producer* side of the log —
`AppLogger.record()` calls it once and caches the result (`AppLogger.ts:20-25`),
so every entry stores `mode: 'dev' | 'prod'` (`LogEntry.ts:1`), which the Logging
page renders as the Mode badge (`LoggingView.vue:94`).

```ts
private async modeOf(): Promise<AppMode> {
  if (this.mode === null) {
    this.mode = await invoke<AppMode>('get_app_mode')
  }
  return this.mode
}
```

**Producer note:** the entries this page displays are written at startup and on
runtime events by `App.vue` (`app`/`runtime.check` sources, `App.vue:61-83`)
and by task flows (`task.run`). Every `record()` wraps the append in
try/catch — logging never breaks the caller (`AppLogger.ts:11-18`).

```
LoggingView (onMounted:49)
  └─ load() (26-40)
      └─ logRepository.list()        → JsonLogRepository.list() → read_text_file (logs.json)
          └─ reverse + slice(0, 100) → logs.value (newest-first)
          └─ Math.min(createdAt)     → stats (count + createdDate)
```

---

## Summary

| Aspect                    | Status                                      |
|---------------------------|---------------------------------------------|
| Mount kick-off            | ✅ Implemented (`LoggingView.vue:49`)       |
| Loader (entries + stats)  | ✅ Implemented (`LoggingView.vue:26-40`)    |
| Newest-first + 100 cap    | ✅ Implemented (`.reverse().slice(0, 100)`) |
| Stats line                | ✅ Implemented (`log-stats`, `:74`)         |
| Persistence (logs.json)   | ✅ Implemented (`JsonLogRepository`)        |
| 200-entry file cap        | ✅ Implemented (`MAX_ENTRIES`, `JsonLogRepository.ts:6`) |
| Empty state               | ✅ Implemented ("No logs yet.", `:81`)      |
| Table (sort/search/paging)| ✅ Implemented (`DataTable`, `:82-96`)      |
| Unit tests                | ✅ Implemented (`LoggingView.test.ts`, `LogService.test.ts`) |

**Conclusion:** The "Load Logging page" workflow is complete on the frontend.
The page composes existing generic commands — `read_text_file` for the read,
with `write_text_file` (append/clear) and `get_app_mode` (producer mode) as the
surrounding generic commands — through `JsonLogRepository` / `AppLogger`, so no
dedicated Rust command is required. The loader is defensive (empty list on
failure) and the JSON-absent → `[]` semantics power the empty state.

**Optional future work (not required for correctness):**

- There is no `busy` ref on this page: while `load()` runs, the body briefly
  shows "No logs yet." before the table paints. A `busy` state could suppress
  the empty state during the initial read (the Task page has the same flash
  pattern for its parallel loads).
- The header stats "Loading..." fallback (`:75`) and the body empty state are
  separate indicators; if the log grows large, consider showing a skeleton
  table instead.
- The view displays the newest 100 while the file holds up to 200 — no UI hint
  exists that older entries are hidden. Consider a "showing newest N of M"
  note when `entries.length > 100`.

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/DataTable-Workflow.md` — The reusable `DataTable` component this page adopts (column contract, sort/search/paging, testid-preservation)
- `docs/Task--Load-Task-Page-Workflow.md` — Parallel-load page-mount flow (same `read_text_file`/repository pattern)
- `docs/Scripts--Refresh-Button-Workflow.md` — Scripts-page load (same `read_text_file` pattern)
- `docs/Home--Fresh-Start-App-Workflow.md` — First-run boot path that provisions the data dir
