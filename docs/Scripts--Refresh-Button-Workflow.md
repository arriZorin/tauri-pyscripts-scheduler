# Refresh Button Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-22
**Status:** ✅ Implemented — no dedicated Rust command required (verified against `invoke_handler`)

---

## Overview

When a user clicks the **Refresh** button on the Scripts List page, the following occurs:

1. **Vue UI** (`ScriptsListView.vue`) calls `handleRefresh()`.
2. **Handler** (`ScriptsListView.vue`) → `loadAndReconcile()` → `load()` + `findMissingScriptIds()`.
3. **Composable** (`useScripts.ts`) → `repository.list()` — reloads all scripts into reactive state.
4. **TS services** (`JsonScriptRepository` → `TauriFileStorage`) — read `scripts.json` via the generic Rust I/O command `read_text_file`.
5. **Reconciliation** (`scriptPathChecker.ts`) — parallel `path_exists` checks flag scripts whose files are gone (renders "Missing" badge + Repair action).

The entire "Refresh" path is implemented on the frontend. Persistence re-uses the existing `JsonScriptRepository` + `TauriFileStorage` layer, and the missing-file check re-uses the generic `path_exists` command — no dedicated Rust command is registered for refresh.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── ScriptsListView.vue              ← Step 1: button + handleRefresh/loadAndReconcile
├── composables/
│   └── useAppContext.ts                 ← DI: wires repository + scriptPathChecker
├── services/
│   ├── script/
│   │   ├── import/
│   │   │   └── useScripts.ts            ← Step 3: composable (load)
│   │   ├── ScriptRepository.ts          ← port (interface)
│   │   ├── JsonScriptRepository.ts      ← Step 4: JSON adapter (list)
│   │   ├── scriptPathChecker.ts         ← Step 5: exists() → invoke('path_exists')
│   │   └── scriptReconciliation.ts      ← findMissingScriptIds helper
│   └── shared/
│       ├── FileStorage.ts               ← port (interface)
│       └── TauriFileStorage.ts          ← Step 5: invoke read/write adapter
└── models/
    └── Script.ts                        ← data model
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/ScriptsListView.vue` | Button + `handleRefresh()` + `loadAndReconcile()` |
| `src/composables/useAppContext.ts` | DI: builds `JsonScriptRepository` + `tauriScriptPathChecker` |
| `src/services/script/import/useScripts.ts` | `load()` composable |
| `src/services/script/JsonScriptRepository.ts` | `list()` JSON adapter |
| `src/services/script/scriptPathChecker.ts` | `exists()` → `invoke('path_exists')` |
| `src/services/script/scriptReconciliation.ts` | `findMissingScriptIds()` helper |
| `src/services/shared/FileStorage.ts` / `TauriFileStorage.ts` | port + invoke-based adapter |
| `src/models/Script.ts` | Script model |

---

### Rust Backend

```
src-tauri/
└── src/
    └── lib.rs                           ← registers generic I/O + existence commands
```

**Relevant existing commands (already registered in `invoke_handler`, `src-tauri/src/lib.rs:508-541`):**

- `read_text_file` — used by `TauriFileStorage.read()` for scripts.json
- `write_text_file` — used by `TauriFileStorage.write()` (other flows; refresh is read-only)
- `path_exists` — used by `scriptPathChecker.exists()` during reconciliation

No refresh-specific command exists; the flow composes these generic commands.

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const storage = new TauriFileStorage()
const scriptRepository = overrides.scriptRepository ?? new JsonScriptRepository(storage, 'scripts.json')
// ...
scriptPathChecker: overrides.scriptPathChecker ?? tauriScriptPathChecker,
```

`ScriptsListView.vue` consumes them and hands them to the composable:

```ts
const { scriptRepository: repository, picker, scanner, taskRepository, taskScheduler, scriptPathChecker, venvSync } = useAppContext();
const { scripts, error, busy, addScriptFile, addScriptFolder, load } = useScripts({ repository, picker, scanner });
```

Tests supply fakes at the same boundary (`useAppContext` overrides / direct `useScripts` deps, e.g. `FakeScriptRepository` in `ScriptsListView.test.ts`).

---

## Execution Flow

### Step 1 — Vue UI Layer

**Location:** `src/views/ScriptsListView.vue:8` (button), `:391-393` (handler)

```vue
<button @click="handleRefresh" class="btn btn-ghost px-3 py-2 rounded bg-gray-600 text-white hover:bg-gray-500" data-testid="refresh-btn">Refresh</button>
```

```ts
async function handleRefresh() {
  await loadAndReconcile();
}
```

User click → `handleRefresh()` → `loadAndReconcile()`.

---

### Step 2 — Handler & Reconciliation

**Location:** `src/views/ScriptsListView.vue:194-197`

```ts
async function loadAndReconcile() {
  await load();
  missingScriptIds.value = await findMissingScriptIds(scripts.value, scriptPathChecker.exists);
}
```

**Behaviour:**

1. `load()` reloads the script list from the repository (replaces `scripts.value`).
2. `findMissingScriptIds()` runs parallel existence checks over every script path via `scriptPathChecker.exists` (→ `invoke('path_exists')`).
3. IDs whose file no longer exists (or whose check throws) are collected into `missingScriptIds`.
4. The view renders a "Missing" badge and swaps Edit → Repair for those rows (`ScriptsListView.vue:36, 42-43`). This is housekeeping, not a user-facing error.

---

### Step 3 — Composable `load()`

**Location:** `src/services/script/import/useScripts.ts:27-39`

```ts
async function load(): Promise<void> {
  try {
    busy.value = true
    error.value = null
    scripts.value = await deps.repository.list()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    error.value = msg
    scripts.value = []
  } finally {
    busy.value = false
  }
}
```

**Behaviour:**

1. Sets `busy = true` and clears `error`.
2. Fetches all scripts via `repository.list()` into `scripts.value`.
3. On failure: sets `error` to the raw message and empties the list (defensive — the view still renders).
4. Always resets `busy = false`.

Note: the shared `busy` flag also drives the header alert at `ScriptsListView.vue:16`, which renders "Adding..." — a label inherited from the add-file flow; it flashes briefly during a refresh too.

---

### Step 4 — Repository `list()`

**Location:** `src/services/script/JsonScriptRepository.ts:32-34`

```ts
async list(): Promise<Script[]> {
  return this.readScripts();
}
```

**Behaviour:**

1. `readScripts()` reads `scripts.json` via `FileStorage.read()` (`JsonScriptRepository.ts:15-25`).
2. `null` content (file not created yet) → `[]` — powers the "No scripts yet." empty state.
3. Parses JSON and guards against non-array content.
4. Backward-compat default: `s.pythonVersion ??= '3.11'`.
5. Returns the parsed `Script[]`.

---

### Step 5 — Persistence & Existence Check

**Location:** `src/services/shared/TauriFileStorage.ts` (adapter), `src/services/script/scriptPathChecker.ts` (checker)

```ts
// TauriFileStorage.ts
read(path: string): Promise<string | null> {
  return invoke<string | null>('read_text_file', { path })
}
```

```ts
// scriptPathChecker.ts
export const tauriScriptPathChecker: ScriptPathChecker = {
  exists: (path) => invoke<boolean>('path_exists', { path }),
}
```

**Behaviour:**

1. `TauriFileStorage` is a TS adapter over the generic Rust commands `read_text_file` / `write_text_file` (registered in `invoke_handler` at `src-tauri/src/lib.rs:508-541`).
2. `scriptPathChecker.exists()` maps to `path_exists` — the same command used by the task page for path validation.
3. No refresh-specific Rust code exists; the flow composes these generic commands.

```
ScriptsListView
  → useScripts.load()
    → JsonScriptRepository.list()
      → TauriFileStorage.read()
        → invoke('read_text_file')        // generic, already registered
  → findMissingScriptIds(scripts, exists)
    → scriptPathChecker.exists()
      → invoke('path_exists')             // generic, already registered
```

---

## Summary

| Aspect                    | Status                                      |
|---------------------------|---------------------------------------------|
| Vue button + handler      | ✅ Implemented (`ScriptsListView.vue:8, 391`) |
| Reload composable (`load`) | ✅ Implemented (`useScripts.ts:27`)         |
| Missing-file reconciliation | ✅ Implemented (`scriptReconciliation.ts`)  |
| Persistence via repository | ✅ Implemented (`JsonScriptRepository.list`) |
| Existence check           | ✅ Implemented (`path_exists` command)       |
| Busy/error state          | ✅ Implemented (shared `busy`/`error` refs)  |
| Unit tests                | ✅ Implemented (`ScriptsListView.test.ts:314, 499`) |

**Conclusion:** The "Refresh" workflow is complete on the frontend. It re-reads `scripts.json` through the existing `JsonScriptRepository` + `TauriFileStorage` layer and reconciles missing files via the generic `path_exists` command — no dedicated Rust command is required.

**Optional future work (not required for correctness):**

- The busy alert text is hard-coded "Adding..." (`ScriptsListView.vue:16`) — make it context-aware ("Refreshing...") so a refresh doesn't show the add-file label.
- Add a loading spinner/disabled state on the Refresh button itself while `busy` is true.
- Debounce rapid clicks (though a click is near-instant).

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Scripts--Add-File-Button-Workflow.md` — Sibling Scripts-page flow (writes via same repository)
- `docs/Home--Fresh-Start-App-Workflow.md` — First-run boot path that provisions the data dir
- `docs/Task--New-Task-Button-Workflow.md` — Task page flow using the same `path_exists`/I/O commands
