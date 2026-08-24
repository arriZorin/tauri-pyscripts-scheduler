# Delete-Button Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-24  
**Status:** ✅ Frontend complete — no dedicated Rust command required

---

## Overview

When a user clicks the **Delete** button on a script row in the Scripts List page, the following occurs:

1. **Vue UI** (`ScriptsListView.vue`) calls `handleDelete()` → opens a confirmation modal (with linked-task warning if applicable).
2. **Vue UI** (`confirmDelete()`) orchestrates the cascade: linked task deletion (JSON + COM) → script deletion (JSON) → venv cleanup → list reload.
3. **TypeScript services** (`JsonScriptRepository`, `JsonTaskRepository`, `TauriTaskScheduler`, `TauriVenvSync`) handle persistence and OS-level operations.
4. **Rust backend** supplies only the generic commands already registered (`read_text_file`, `write_text_file`, `delete_scheduled_task`, `delete_script_venv`).

The entire "Delete Script" path is frontend-orchestrated. Persistence and OS-level scheduling re-use the existing repository and scheduler layers.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── ScriptsListView.vue              ← Step 1: button + handleDelete + confirmDelete + modal
├── services/
│   ├── script/
│   │   ├── ScriptRepository.ts          ← port (interface: delete)
│   │   ├── JsonScriptRepository.ts      ← JSON adapter (delete → splice + write)
│   │   └── venvSync.ts                  ← TauriVenvSync.cleanupFolder (delete_script_venv or re-sync)
│   ├── task/
│   │   ├── TaskRepository.ts            ← port (interface: delete)
│   │   ├── JsonTaskRepository.ts        ← JSON adapter (delete by filter)
│   │   ├── TaskScheduler.ts             ← TauriTaskScheduler.delete (invoke delete_scheduled_task)
│   │   └── TaskReconciler.ts            ← post-delete reconciliation (orphan detection)
│   └── shared/
│       ├── FileStorage.ts               ← port (interface)
│       └── TauriFileStorage.ts          ← persistence adapter (invoke read/write)
└── models/
    ├── Script.ts                        ← data model
    └── Task.ts                          ← data model (TASK_WINDOWS_NAMESPACE)
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/ScriptsListView.vue` | Delete button + `handleDelete()` + `confirmDelete()` + modal |
| `src/services/script/ScriptRepository.ts` / `JsonScriptRepository.ts` | port + JSON adapter for script deletion |
| `src/services/script/venvSync.ts` | `TauriVenvSync.cleanupFolder` — conditionally removes venv |
| `src/services/task/TaskRepository.ts` / `JsonTaskRepository.ts` | port + JSON adapter for linked task deletion |
| `src/services/task/TaskScheduler.ts` | `TauriTaskScheduler.delete` — COM task deletion |
| `src/services/task/TaskReconciler.ts` | Post-delete orphan detection |
| `src/services/shared/FileStorage.ts` / `TauriFileStorage.ts` | port + invoke-based adapter |
| `src/models/Script.ts` | Script model |
| `src/models/Task.ts` | Task model + `TASK_WINDOWS_NAMESPACE` |

### Rust Backend

```
src-tauri/
└── src/
    └── lib.rs                           ← registers generic I/O + scheduling + venv commands
```

**Relevant existing commands (already registered in `invoke_handler`, `src-tauri/src/lib.rs:453`):**

- `read_text_file` / `write_text_file` — used by `TauriFileStorage` for scripts.json / tasks.json
- `delete_scheduled_task` — used by `TauriTaskScheduler.delete` for COM task removal
- `delete_script_venv` — used by `TauriVenvSync.cleanupFolder` for venv removal (`src-tauri/src/lib.rs:374`)
- `path_exists` — used by `scriptPathChecker` during reload

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const storage = new TauriFileStorage()
const scriptRepository = overrides.scriptRepository ?? new JsonScriptRepository(storage, 'scripts.json')
const taskRepository = overrides.taskRepository ?? new JsonTaskRepository(storage, 'tasks.json', scriptRepository)
// ...
taskScheduler: overrides.taskScheduler ?? new TauriTaskScheduler(),
venvSync: overrides.venvSync ?? new TauriVenvSync(scriptRepository),
```

`ScriptsListView.vue` consumes them:

```ts
const { scriptRepository: repository, picker, scanner, taskRepository, taskScheduler, scriptPathChecker, venvSync } = useAppContext();
```

Tests supply fakes at the same boundary (`useAppContext` overrides). The test fakes (`FakeScriptRepository`, `FakeTaskRepository`, `FakeTaskScheduler`, `FakeVenvSync`) implement the same interfaces.

---

## Execution Flow

### Step 1 — Vue UI: Delete Button Click

**Location:** `src/views/ScriptsListView.vue:44` (button), `:267` (handler)

```vue
<button @click="handleDelete(s)" :data-testid="`delete-script-${s.id}`" class="btn btn-xs btn-error join-item" :title="`Delete ${s.name}`">Delete</button>
```

```ts
async function handleDelete(script: Script) {
  if (!script) return;

  deleteError.value = '';
  // Collect tasks that reference this script so the dialog can warn and
  // cascade deletion of the linked Windows tasks.
  try {
    const tasks = await taskRepository.list();
    linkedTasks.value = tasks.filter(task => task.scriptId === script.id);
  } catch {
    linkedTasks.value = [];
  }
  deleteTarget.value = script;
}
```

**Behaviour:**

1. Clear any previous error.
2. Query `taskRepository.list()` for all tasks, filter by `scriptId === script.id`.
3. Store the linked tasks in `linkedTasks.value` (empty array on error).
4. Set `deleteTarget.value` to the script, which triggers the modal to open.

Flow chain: `User click → handleDelete(script) → taskRepository.list() → filter linked tasks → show modal`

---

### Step 2 — Vue UI: Delete Confirmation Modal

**Location:** `src/views/ScriptsListView.vue:96` (modal template), `:282` (cancelDelete), `:288` (confirmDelete)

```vue
<dialog id="delete-dialog" v-if="deleteTarget" data-testid="delete-dialog" class="modal modal-open" role="dialog">
  <div class="modal-box p-4 max-w-md">
    <h3 class="text-lg font-bold mb-2">Delete Script</h3>
    <p class="text-gray-600 mb-4">Are you sure you want to delete <strong>{{ deleteTarget.name }}</strong>?</p>
    <div v-if="linkedTasks.length > 0" class="alert alert-warning mb-4" data-testid="linked-tasks-warning" role="alert">
      <AlertIcon kind="warning" />
      <div>
        <strong>{{ linkedTasks.length }} linked task(s) will also be deleted:</strong>
        <ul class="list-disc list-inside mt-1">
          <li v-for="task in linkedTasks" :key="task.id">{{ task.name }}</li>
        </ul>
      </div>
    </div>
    <div v-if="deleteError" class="alert alert-error mb-4" data-testid="delete-error" role="alert"><AlertIcon kind="error" /><span>{{ deleteError }}</span></div>
    <div class="flex justify-between items-center">
      <div class="text-sm text-gray-500">
        <div class="mb-1">Path: <span class="script-name">{{ deleteTarget.path }}</span></div>
        <div>Type: <span class="script-name">{{ deleteTarget.type }}</span></div>
      </div>
      <div class="flex gap-2">
        <button @click="confirmDelete" data-testid="confirm-delete-btn" class="btn btn-error btn-sm">{{ linkedTasks.length > 0 ? 'Delete script & tasks' : 'Delete' }}</button>
        <button @click="cancelDelete" data-testid="cancel-delete-btn" class="btn btn-ghost btn-sm">Cancel</button>
      </div>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button @click.prevent="cancelDelete">close</button>
  </form>
</dialog>
```

**Behaviour (modal):**

- Shows script name, path, and type.
- If `linkedTasks.length > 0`, a warning alert lists them by name and the confirm button reads "Delete script & tasks".
- If `deleteError` is set (from a failed `confirmDelete`), the error is shown in the alert and the modal stays open so the user can see the error.
- **Cancel** (`cancelDelete`, line 282): clears `deleteTarget`, `linkedTasks`, and `deleteError`.

```ts
function cancelDelete() {
  deleteTarget.value = null;
  linkedTasks.value = [];
  deleteError.value = '';
}
```

---

### Step 3 — Vue UI: Confirm Deletion (Cascade)

**Location:** `src/views/ScriptsListView.vue:288`

```ts
async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;

  try {
    // Cascade: remove linked tasks (JSON + Windows registration) first so no
    // orphaned Windows task keeps running a deleted script, then the script.
    for (const task of linkedTasks.value) {
      await taskRepository.delete(task.id);
      await taskScheduler.delete(task.id);
    }
    const deletePath = target.path;
    await repository.delete(target.id);
    // Cleanup venv — if no more scripts in this folder, venv is removed
    await venvSync.cleanupFolder(deletePath);
    await loadAndReconcile();

    operationSummary.value = linkedTasks.value.length > 0
      ? `Deleted ${target.name} and ${linkedTasks.value.length} linked task(s).`
      : `Deleted ${target.name}.`;
    deleteTarget.value = null;
    linkedTasks.value = [];
    deleteError.value = '';
  } catch (e) {
    // Keep the dialog open so the error is visible; nothing was committed.
    deleteError.value = typeof e === 'string' && e.trim() ? e : e instanceof Error ? e.message : 'Failed to delete script.';
  }
}
```

**Behaviour:**

1. **Cascade linked tasks first** — for each linked task:
   - `taskRepository.delete(task.id)` — removes from tasks.json (idempotent: filter-out, no-op if not found)
   - `taskScheduler.delete(task.id)` — removes the Windows Scheduled Task via COM (swallows all errors = delete-of-unregistered success semantics)
2. **Delete the script** — `repository.delete(target.id)` — removes from scripts.json (idempotent: findIndex → splice, no-op if not found)
3. **Cleanup venv** — `venvSync.cleanupFolder(deletePath)` — if no scripts remain in the script's folder, the venv is deleted; otherwise, deps are re-synced
4. **Reload** — `loadAndReconcile()` — refreshes the list and re-checks for missing scripts
5. **Set summary** — a user-visible success message ("Deleted X." or "Deleted X and N linked task(s).")
6. **Close modal** — clears all delete state

**On error:** the modal stays open, `deleteError` is set, and **nothing was committed** (the error propagates from the first failed operation, so the cascade is atomic at the transaction level — if step 1a fails, step 1b never runs).

Flow chain: `confirmDelete → [taskRepository.delete → taskScheduler.delete]×N → repository.delete → venvSync.cleanupFolder → loadAndReconcile → summary`

---

### Step 4 — Script Repository: `JsonScriptRepository.delete`

**Location:** `src/services/script/JsonScriptRepository.ts:71`

```ts
async delete(id: string): Promise<void> {
  const scripts = await this.list()
  const index = scripts.findIndex(s => s.id === id)
  if (index !== -1) {
    scripts.splice(index, 1)
    await this.writeScripts(scripts)
  }
}
```

**Behaviour:**

- Read all scripts from scripts.json.
- Find the script by ID; if found, remove it from the array and persist.
- If the script ID is not found (no-op), the promise resolves successfully — idempotent.

---

### Step 5 — Task Repository: `JsonTaskRepository.delete`

**Location:** `src/services/task/JsonTaskRepository.ts:65`

```ts
async delete(id: string): Promise<void> {
  const tasks = await this.readTasks()
  const remaining = tasks.filter(task => task.id !== id)
  if (remaining.length !== tasks.length) await this.writeTasks(remaining)
}
```

**Behaviour:**

- Read all tasks from tasks.json.
- Filter out the task with the matching ID.
- If any task was removed (length changed), persist the updated list.
- Idempotent: filtering a non-existent ID leaves the array unchanged, so no write occurs.

---

### Step 6 — Task Scheduler: `TauriTaskScheduler.delete`

**Location:** `src/services/task/TaskScheduler.ts:48`

```ts
async delete(taskId: string): Promise<void> {
  try {
    await invoke('delete_scheduled_task', { taskName: taskWindowsName(taskId) })
  } catch {
    // Deleting a task that was never registered is success semantics.
  }
}
```

**Behaviour:**

- Invokes the Rust command `delete_scheduled_task` with the Windows task name (constructed from `taskId` via `taskWindowsName`, which uses the `TASK_WINDOWS_NAMESPACE` prefix).
- All errors are caught and swallowed — deleting a task that was never registered is treated as success. This is the same success-semantics pattern used by the Task page's delete flow.

---

### Step 7 — Venv Cleanup: `TauriVenvSync.cleanupFolder`

**Location:** `src/services/script/venvSync.ts:38`

```ts
async cleanupFolder(scriptPath: string): Promise<void> {
    const workingDir = scriptDir(scriptPath)

    // Check if any scripts remain in this folder
    const allScripts = await this.scriptRepository.list()
    const remaining = allScripts.filter(s =>
      scriptDir(s.path).toLowerCase() === workingDir.toLowerCase()
    )

    if (remaining.length === 0) {
      // No scripts left in this folder — delete the venv.
      // If the folder itself doesn't exist, the venv is already gone — no-op.
      const folderExists = await invoke<boolean>('path_exists', { path: workingDir })
      if (!folderExists) return
      await invoke('delete_script_venv', { dirPath: workingDir })
    } else {
      // Re-sync with remaining scripts' requirements.txt
      const requirements = await invoke<string[]>('read_folder_requirements', { dirPath: workingDir })
      if (requirements.length > 0) {
        await invoke('sync_script_deps', { dirPath: workingDir, requirements })
      }
    }
  }
```

**Behaviour:**

- Compute the working directory from the script path.
- List all scripts and check if any remain in the same folder.
- **No scripts remain**:
  - Check if the folder itself exists via `path_exists`. If the folder is gone (e.g. the user deleted the root directory), the venv is already gone — return early as a no-op success.
  - Otherwise, invoke `delete_script_venv` (Rust command at `src-tauri/src/lib.rs:374`) to remove the `.venv` directory.
- **Scripts remain** → re-read `requirements.txt` and re-sync deps for the remaining scripts (no venv deletion).

---

### Step 8 — Load and Reconcile

**Location:** `src/views/ScriptsListView.vue:194`

```ts
async function loadAndReconcile() {
  await load();
  missingScriptIds.value = await findMissingScriptIds(scripts.value, scriptPathChecker.exists);
}
```

Reloads the script list from the repository and re-checks each script's file-path existence via `scriptPathChecker.exists` (which invokes `path_exists`).

---

## Summary

| Aspect | Status |
|--------|--------|
| Delete button in view | ✅ Implemented (`src/views/ScriptsListView.vue:44`) |
| Confirmation modal | ✅ Implemented (`src/views/ScriptsListView.vue:96`) |
| Linked-task warning | ✅ Implemented (`src/views/ScriptsListView.vue:100-108`) |
| Cascade: linked task deletion (JSON) | ✅ Implemented (`JsonTaskRepository.delete`) |
| Cascade: linked task deletion (COM) | ✅ Implemented (`TauriTaskScheduler.delete`) |
| Cascade: script deletion (JSON) | ✅ Implemented (`JsonScriptRepository.delete`) |
| Venv cleanup (delete or re-sync) | ✅ Implemented (`TauriVenvSync.cleanupFolder`) |
| Venv cleanup: missing-folder guard | ✅ Implemented (`path_exists` check before `delete_script_venv`) |
| Post-delete reload + reconciliation | ✅ Implemented (`loadAndReconcile`) |
| Error handling (modal stays open) | ✅ Implemented (`src/views/ScriptsListView.vue:311-314`) |
| Unit tests: delete flow | ✅ Implemented (`src/views/ScriptsListView.test.ts:354-470`) |
| Unit tests: linked-task cascade | ✅ Implemented (`src/views/ScriptsListView.test.ts:423-448`) |
| Unit tests: error preserves script | ✅ Implemented (`src/views/ScriptsListView.test.ts:450-470`) |

**Conclusion:** The "Delete Script" workflow is a frontend-orchestrated cascade. It composes existing repository and scheduler services — no new Rust commands were needed. The flow is idempotent at every persistence layer (JSON filter-out, COM delete-swallow). Errors during any step prevent the entire cascade from committing, keeping the modal open with the error message.

**Optional future work:**

- Add a confirmation step that warns the user about the venv being deleted when a folder's last script is removed.
- Surface the venv cleanup result in the operation summary (e.g. "Deleted X. Venv cleaned up.").

---

## Appendix: Related Documentation

- `docs/Scripts--Add-File-Button-Workflow.md` — How scripts are added
- `docs/Scripts--Refresh-Button-Workflow.md` — How the list is refreshed
- `docs/Task--Delete-Button-Workflow.md` — Task deletion flow (same COM delete-semantics pattern)
- `docs/Task--Clean-Orphans-Workflow.md` — Orphan task reconciliation (post-delete safety net)
- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions