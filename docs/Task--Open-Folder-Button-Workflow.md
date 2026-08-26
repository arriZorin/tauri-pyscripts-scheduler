# Open Folder Button Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-25  
**Status:** ✅ Complete — dedicated Rust command (`reveal_in_explorer`) added and registered in `invoke_handler`

---

## Overview

When the user clicks the **Open Folder** button on a task row, the app opens Windows Explorer at the script's folder with the script file selected. The same change migrated the Actions column from text buttons to icon-only buttons.

1. **Vue UI** (`TaskView.vue`) renders an icon-only folder button per healthy task row and calls `openFolder(task)`.
2. **Composable layer** (`useAppContext`) supplies the `folderRevealer` port bound to the Tauri adapter.
3. **TS service** (`FolderRevealer.ts`) adapts to the native command — `TauriFolderRevealer.reveal()` invokes `reveal_in_explorer`.
4. **Rust backend** (`lib.rs`) validates the path via `explorer_select_arg`, checks it exists, and spawns `explorer.exe /select,<path>` — no blocking, the Explorer window is the feedback.

This flow is the first on the Task page to require a **dedicated, non-generic** Rust command: `reveal_in_explorer` (registered in `invoke_handler` at `src-tauri/src/lib.rs:508`). It spawns the Windows shell command and returns immediately. There is no success banner — the Explorer window opening is the success signal; failures surface through the existing `operationError` banner.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── TaskView.vue                     ← Step 1: Open Folder icon button + openFolder handler
├── services/
│   └── task/
│       └── FolderRevealer.ts            ← Step 2: port + Tauri adapter (invoke reveal_in_explorer)
├── components/
│   └── icons/
│       ├── FolderIcon.vue               ← Step 1: folder glyph (new row action)
│       ├── PencilIcon.vue               ← Step 1: edit action glyph
│       ├── PlayIcon.vue                 ← Step 1: run action glyph
│       ├── PowerIcon.vue                ← Step 1: enable/disable glyph
│       ├── TrashIcon.vue                ← Step 1: delete action glyph
│       └── WrenchIcon.vue               ← Step 1: repair action glyph
├── composables/
│   └── useAppContext.ts                 ← Step 2: DI wiring (folderRevealer)
└── models/
    └── Script.ts                        ← Task → script resolution (script.path)
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/TaskView.vue` | Open Folder icon button (`TaskView.vue:548`) + `openFolder()` handler (`TaskView.vue:433`) |
| `src/services/task/FolderRevealer.ts` | `FolderRevealer` port + `TauriFolderRevealer.reveal()` — invokes `reveal_in_explorer` |
| `src/components/icons/FolderIcon.vue` | Folder SVG glyph rendered inside the button |
| `src/composables/useAppContext.ts` | DI wiring — `folderRevealer: overrides.folderRevealer ?? new TauriFolderRevealer()` (`useAppContext.ts:70`) |
| `src/views/TaskView.test.ts` | `FakeFolderRevealer` (`:31`) + Open Folder success/error tests (`:466`, `:480`) |

### Rust Backend

```
src-tauri/
└── src/
    └── lib.rs                              ← reveal_in_explorer command + explorer_select_arg helper + unit tests
```

**Relevant commands (registered in `invoke_handler`, `src-tauri/src/lib.rs:508`):**

- `reveal_in_explorer` — **NEW dedicated command** for this flow (`lib.rs:178`, registered at `lib.rs:508`)
- `path_exists` — existing generic primitive, the model for `explorer_select_arg` validation
- `run_scheduled_task` — used by Run Now (unrelated to this flow)

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
import type { FolderRevealer } from '../services/task/FolderRevealer'
import { TauriFolderRevealer } from '../services/task/FolderRevealer'
// ...
folderRevealer: overrides.folderRevealer ?? new TauriFolderRevealer(),
```

`TaskView.vue` consumes it:

```ts
const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger,
        taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult, folderRevealer } = useAppContext()
```

Tests supply a fake at the same boundary (`TaskView.test.ts:162` — `mountView` takes a trailing `FakeFolderRevealer`, defaulting to `new TauriFolderRevealer()`).

---

## Execution Flow

### Step 1 — Vue UI Layer

**Location:** `src/views/TaskView.vue` (button at line 548, handler at line 433)

```vue
<button class="btn btn-xs btn-ghost join-item text-primary"
  :data-testid="`open-folder-task-${task.id}`"
  :title="`Open folder: ${scriptLabelOf(task.scriptId)}`"
  @click="openFolder(task)"><FolderIcon /></button>
```

The button lives in the **normal branch** of the Actions cell (script exists and is not missing). Rows with a missing script path (`script_missing`) or unregistered scheduler state (`unregistered`) do not render it.

```ts
async function openFolder(task: Task) {
  const script = scripts.value.find(s => s.id === task.scriptId)
  if (!script) return
  operationError.value = ''
  try {
    await folderRevealer.reveal(script.path)
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to open folder.')
  }
}
```

**Behaviour:**

1. Resolve the `Script` for the task's `scriptId` from the loaded script list; if missing, no-op.
2. Clear any previous `operationError`.
3. Call `folderRevealer.reveal(script.path)` — the resolved script's absolute path (e.g. `C:/scripts/backup.py`).
4. **On success:** no banner — the Explorer window opening is the user feedback.
5. **On failure:** `errorText` maps the rejection (via `errorMessage`) onto the existing `operationError` alert banner.

**Flow chain:**
```
User click → openFolder(task) → folderRevealer.reveal(script.path)
  → invoke('reveal_in_explorer', { path }) → explorer.exe /select,<path>
  → on failure: operationError banner
```

### Step 2 — FolderRevealer (TS service)

**Location:** `src/services/task/FolderRevealer.ts`

```ts
import { invoke } from '@tauri-apps/api/core'

export interface FolderRevealer {
  reveal(scriptPath: string): Promise<void>
}

export class TauriFolderRevealer implements FolderRevealer {
  reveal(scriptPath: string): Promise<void> {
    return invoke('reveal_in_explorer', { path: scriptPath })
  }
}
```

Mirrors the `TaskExecutor` port/adapter pattern: the view depends on the `FolderRevealer` interface, production uses the `TauriFolderRevealer` adapter, tests inject a fake. The adapter is a thin passthrough to the native command.

### Step 3 — Rust: `reveal_in_explorer` (dedicated command)

**Location:** `src-tauri/src/lib.rs` (command at line 178, helper at line 167, registered at line 495)

```rust
/// Builds the `explorer.exe /select,<path>` argument, normalizing forward
/// slashes to backslashes so Explorer opens the file's folder with the file
/// selected. Rejects empty and non-absolute paths.
fn explorer_select_arg(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    if !Path::new(path).is_absolute() && !is_absolute_windows_path(path) {
        return Err("path must be absolute".to_string());
    }
    Ok(format!("/select,{}", path.replace('/', "\\")))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let select_arg = explorer_select_arg(&path)?;
    if !Path::new(&path).is_file() {
        return Err("path does not exist".to_string());
    }
    #[cfg(windows)]
    {
        // explorer.exe is a shell command; spawn (don't block) and let it
        // return immediately — the Explorer window is the user feedback.
        std::process::Command::new("explorer.exe")
            .arg(select_arg)
            .spawn()
            .map_err(|e| format!("failed to open explorer: {}", e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = select_arg;
        Err("reveal in explorer is only supported on Windows".to_string())
    }
}
```

**Behaviour:**

1. `explorer_select_arg` validates the path (non-empty, absolute — reusing `is_absolute_windows_path` from `lib.rs:34`) and normalizes forward slashes to backslashes, producing `/select,C:\scripts\backup.py`.
2. The command checks the path actually resolves to a file, else errors `path does not exist`.
3. On Windows, `explorer.exe` is spawned with the `/select,<path>` argument — **spawn, not wait** — so the command returns immediately and the Explorer window is the user feedback.
4. On non-Windows builds it returns an explicit unsupported error (the app is Windows-first).

The `/select,` form makes Explorer open the script's folder **with the file highlighted** (the "reveal in Explorer" behavior), rather than just opening the bare directory.

### Step 4 — Verification (unit tests)

**Rust (`lib.rs:167-175`):** `explorer_select_arg` normalizes forward slashes, keeps backslashes, and rejects empty / relative / bare-name paths; `reveal_in_explorer` rejects relative paths (the spawn itself is not tested — it launches a GUI process).

**Frontend (`TaskView.test.ts:466`, `:480`):** clicking `open-folder-task-<id>` calls the fake revealer with the script's path (`C:/scripts/backup.py`); a rejecting revealer surfaces the raw error through the `task-operation-error` banner.

---

## Summary

| Aspect | Status |
|--------|--------|
| Open Folder icon button | ✅ Implemented (`TaskView.vue:548`) |
| `openFolder()` handler | ✅ Implemented (`TaskView.vue:433`) |
| Script-path resolution from task | ✅ Implemented (`scripts.value.find(...)` in handler) |
| Folder revealer port + Tauri adapter | ✅ Implemented (`FolderRevealer.ts`) |
| Dedicated Rust command `reveal_in_explorer` | ✅ Implemented (`lib.rs:178`, registered `lib.rs:508`) |
| Explorer `/select,<path>` reveal behavior | ✅ Implemented (`explorer_select_arg`, `lib.rs:167`) |
| Path validation (empty/relative/non-file) | ✅ Implemented (Rust, with unit tests) |
| Error banner on failure | ✅ Implemented (existing `operationError` + `errorMessage`) |
| Actions column migrated to icon-only | ✅ Implemented (6 new icon components) |
| Existing `data-testid`s preserved | ✅ Implemented (all row-action testids unchanged) |
| Unit tests | ✅ Implemented (`TaskView.test.ts` 59 tests, `lib.rs` 96 tests — all green) |

**Conclusion:** The "Open Folder" workflow is complete. Unlike Run Now / Delete (which compose generic COM commands), this flow required a **dedicated Rust command** — `reveal_in_explorer` — which validates the script path and spawns `explorer.exe /select,<path>` to reveal the file in its folder. The frontend adds a port/adapter service (`FolderRevealer`) wired through `useAppContext`, and the Task page Actions column is now icon-only with tooltips. All 278 frontend tests and 96 Rust tests pass, and the production build type-checks.

**Optional future work (not required for correctness):**

- Reuse the icon-only Actions pattern on the Scripts List page for visual consistency (currently still text buttons)
- Add the same Open Folder affordance to Scripts List rows

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Task--Run-Now-Button-Workflow.md` — Run Now flow (same Actions column, now icon-based)
- `docs/Task--Delete-Button-Workflow.md` — Task deletion flow (Delete button now icon-based)
- `docs/Task--Load-Task-Page-Workflow.md` — Page mount flow
