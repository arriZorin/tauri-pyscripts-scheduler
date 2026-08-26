# Delete Button Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-22
**Status:** ✅ Implemented — dedicated Rust command `delete_scheduled_task` (registered in `invoke_handler` at `src-tauri/src/lib.rs:508`)

---

## Overview

When the user clicks the **Delete** button on a task row in the Task page, the
following occurs:

1. **Vue UI** (`TaskView.vue`) — the row's Delete button calls
   `requestDelete(task)`, which opens a confirmation modal; confirming calls
   `confirmDelete()`.
2. **TS services** (`src/services/task/`) — `JsonTaskRepository.delete()`
   removes the task from `tasks.json`, then `TauriTaskScheduler.delete()`
   unregisters the Windows Scheduled Task via the COM command
   `delete_scheduled_task`.
3. **Rust backend** (`src-tauri/src/lib.rs`) — the `delete_scheduled_task`
   command delegates to `windows_scheduler::delete_task`, which calls the COM
   `ITaskFolder::DeleteTask` on the `PyscriptScheduler\` namespace.
4. **Reload** — `confirmDelete()` calls `load()`, which re-reads `tasks.json`
   and re-runs the COM reconcile, so the row disappears and the reconcile
   banner re-evaluates.

Unlike Add File (frontend-only), Delete has a dedicated Rust command
(`delete_scheduled_task`) — the Windows registration is a real COM deletion.
Note two verified side-behaviours: run-history rows in `task-runs.json` are
**not** removed by delete (only capped at 200 by `JsonTaskRunRepository`), and
a COM-delete failure is silently swallowed by `TauriTaskScheduler` — the
registration then surfaces in the reconcile banner as *orphaned* after the
reload.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── TaskView.vue                      ← Step 1: Delete buttons + requestDelete / confirmDelete + confirm modal
├── composables/
│   └── useAppContext.ts                  ← DI: wires taskRepository + taskScheduler
├── services/
│   ├── task/
│   │   ├── TaskRepository.ts             ← port (interface) — delete()
│   │   ├── JsonTaskRepository.ts         ← Step 2: tasks.json adapter (delete)
│   │   ├── TaskScheduler.ts              ← Step 3: TauriTaskScheduler.delete (COM)
│   │   └── JsonTaskRunRepository.ts      ← untouched: run history survives delete (200 cap)
│   └── shared/
│       ├── FileStorage.ts                ← port (interface)
│       └── TauriFileStorage.ts           ← invoke read/write adapter
└── models/
    └── Task.ts                           ← taskWindowsName / TASK_WINDOWS_NAMESPACE
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/TaskView.vue` | Delete buttons (`:493`/`:497`/`:503`), `requestDelete()` (`:410`), `confirmDelete()` (`:418`), confirm modal (`:602`) |
| `src/composables/useAppContext.ts` | DI: `taskRepository` + `taskScheduler` |
| `src/services/task/TaskRepository.ts` | port — `delete(id)` |
| `src/services/task/JsonTaskRepository.ts` | `delete()` tasks.json adapter |
| `src/services/task/TaskScheduler.ts` | `TauriTaskScheduler.delete()` → `invoke('delete_scheduled_task')` |
| `src/services/task/JsonTaskRunRepository.ts` | run history untouched by delete (`MAX_RUNS = 200`) |
| `src/services/shared/FileStorage.ts` / `TauriFileStorage.ts` | port + invoke-based adapter |
| `src/models/Task.ts` | `taskWindowsName` (`PyscriptScheduler\<id>`) |

### Rust Backend

```
src-tauri/
└── src/
    ├── lib.rs                            ← Step 4a: delete_scheduled_task command + registration (:437)
    └── windows_scheduler.rs              ← Step 4b: delete_task (COM DeleteTask, :781)
```

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const taskRepository = overrides.taskRepository ?? new JsonTaskRepository(storage, 'tasks.json', scriptRepository)
// ...
taskScheduler: overrides.taskScheduler ?? new TauriTaskScheduler(),
```

`TaskView.vue` consumes them and calls them directly in `confirmDelete`:

```ts
const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger, taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult } = useAppContext()
```

Tests supply fakes at the same boundary (`FakeTaskRepository` /
`FakeTaskScheduler` in `TaskView.test.ts`, mocks in `TaskScheduler.test.ts`).

---

## Execution Flow

### Step 1 — Vue UI Layer

**Location:** `src/views/TaskView.vue` (buttons at :538/:542/:549, `requestDelete` at :429, modal at :648, `confirmDelete` at :448)

The Delete button appears in all three row templates — script-missing
(registered), script-missing (unregistered), and normal rows. Identical in
each, e.g. the normal row (`:549`):

```vue
<button class="btn btn-xs btn-ghost join-item text-error" :data-testid="`delete-task-${task.id}`" :title="`Delete ${task.name}`" @click="requestDelete(task)"><TrashIcon /></button>
```

`requestDelete` only stages the target; the destructive work happens after
confirmation:

```ts
function requestDelete(task: Task) {
  deleteTarget.value = task
}
```

Confirmation modal (`:602-604`) — rendered when `deleteTarget` is set:

```vue
<dialog v-if="deleteTarget" class="modal modal-open" data-testid="task-delete-dialog" role="dialog">
  <div class="modal-box"><h3 class="text-lg font-bold">Delete Task</h3><p class="py-4">Delete {{ deleteTarget.name }}?</p><div class="modal-action"><button class="btn btn-error" data-testid="confirm-task-delete-btn" @click="confirmDelete">Delete</button><button class="btn" data-testid="cancel-task-delete-btn" @click="cancelDelete">Cancel</button></div></div>
</dialog>
```

`confirmDelete` (`:418-430`) — repository first, then the Windows
registration, then reload:

```ts
async function confirmDelete() {
  if (!deleteTarget.value) return
  operationError.value = ''
  try {
    const target = deleteTarget.value
    await taskRepository.delete(target.id)
    await taskScheduler.delete(target.id)
    deleteTarget.value = null
    await load()
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to delete task.')
  }
}
```

**Behaviour:**

1. Guard: no-op when no target is staged.
2. Remove the task from `tasks.json` (`taskRepository.delete`).
3. Unregister the Windows Scheduled Task (`taskScheduler.delete`).
4. Close the modal, then `load()` refreshes the table + reconcile.
5. Any thrown error (repository layer) renders via the `task-operation-error`
   alert (`{{ operationError }}` at `:468`) with fallback text
   `'Failed to delete task.'`.

User click → `requestDelete(task)` → modal → `confirmDelete()` →
`taskRepository.delete()` → `taskScheduler.delete()` → `load()`

---

### Step 2 — Repository Layer (tasks.json)

**Location:** `src/services/task/JsonTaskRepository.ts:65`

```ts
async delete(id: string): Promise<void> {
  const tasks = await this.readTasks()
  const remaining = tasks.filter(task => task.id !== id)
  if (remaining.length !== tasks.length) await this.writeTasks(remaining)
}
```

**Behaviour:**

1. Read all tasks from `tasks.json` (`read_text_file` via `TauriFileStorage`).
2. Filter out the deleted id — an id that is not present simply yields an
   unchanged list (delete is idempotent).
3. Write back only when something actually changed, so a delete of a
   non-existent id does not rewrite the file.

The port (`src/services/task/TaskRepository.ts:8`) declares `delete(id: string): Promise<void>`.

---

### Step 3 — Scheduler Layer (COM unregister)

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

1. Invokes the Rust command `delete_scheduled_task` with the namespaced task
   name `PyscriptScheduler\<taskId>`.
2. **Swallows all errors** — deleting a task that was never registered (or a
   COM failure) is treated as success at this layer. A real COM-delete failure
   therefore leaves the registration in place, which the post-delete reload's
   reconcile then reports as an *orphaned registration* (Clean Orphans
   banner), not an error alert.

The namespace is a single source of truth in `src/models/Task.ts:105-109`:

```ts
export const TASK_WINDOWS_NAMESPACE = 'PyscriptScheduler\\'

export function taskWindowsName(id: string): string {
  return `${TASK_WINDOWS_NAMESPACE}${id}`
}
```

---

### Step 4 — Rust Backend (COM DeleteTask)

**Location:** `src-tauri/src/lib.rs:316-324` (command), `:508` (registered in `generate_handler![...]`)

```rust
#[tauri::command]
fn delete_scheduled_task(task_name: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::delete_task(&task_name);
    }
    #[cfg(not(windows))]
    scheduler::execute_command(scheduler::build_delete_command(&task_name)?)
}
```

Delegates to the COM implementation in `src-tauri/src/windows_scheduler.rs:887`:

```rust
/// Deletes a scheduled task. A missing task is reported as an error (the
/// frontend treats delete-of-missing as success semantics at its layer).
pub fn delete_task(task_name: &str) -> Result<String, String> {
    validate_text(task_name, "task_name")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let hr = unsafe { (*folder).DeleteTask(task_name_wide.as_ptr() as *mut u16, 0) };
    unsafe { (*folder).Release() };
    check_hr!(
        hr,
        format!("failed to delete scheduled task '{}'", task_name)
    );

    Ok(format!("deleted {}", task_name))
}
```

**Behaviour:**

1. Validate the task name (`validate_text`).
2. Connect to the Task Scheduler COM service and open the root folder.
3. Call `ITaskFolder::DeleteTask` with the wide (UTF-16) task name.
4. A missing task yields an HRESULT error here — which the frontend
   deliberately ignores (Step 3). Success returns `"deleted <task_name>"`.

---

### Step 5 — Post-Delete Reload + Reconcile

**Location:** `src/views/TaskView.vue:76`

```ts
async function load() {
  loadScripts()
  try {
    tasks.value = await taskRepository.list()
  } catch {
    tasks.value = []
  }
  await loadReconcile()
}
```

**Behaviour:**

1. `loadScripts()` fires un-awaited; `taskRepository.list()` re-reads
   `tasks.json` — the deleted row is gone from the table.
2. `loadReconcile()` re-lists COM registrations (`list_scheduled_tasks`) and
   diffs against the JSON tasks. If the COM delete was swallowed as a failure
   (Step 3), the old registration name now has no JSON task and is reported as
   **orphaned** — the Clean Orphans banner appears. If the COM delete
   succeeded, the banner re-evaluates cleanly.
3. `confirmDelete` does **not** call `loadRuns()` and delete does not touch
   `task-runs.json` — run-history rows for the deleted task remain (capped at
   `MAX_RUNS = 200`, `JsonTaskRunRepository.ts:6`/`:27`).

```
Delete click → requestDelete → modal confirm → confirmDelete
  → JsonTaskRepository.delete (tasks.json write)
  → TauriTaskScheduler.delete → invoke('delete_scheduled_task')
    → lib.rs:delete_scheduled_task → windows_scheduler::delete_task
      → ITaskFolder::DeleteTask (COM)
  → load() → taskRepository.list() + loadReconcile() (orphan re-check)
```

---

## Summary

| Aspect | Status |
|--------|--------|
| Delete button in all three row templates | ✅ Implemented (`TaskView.vue:538`/`:542`/`:549`) |
| Confirmation modal | ✅ Implemented (`TaskView.vue:648`) |
| `tasks.json` removal | ✅ Implemented (`JsonTaskRepository.ts:65-69`) |
| COM registration removal | ✅ Implemented (`TaskScheduler.ts:48-54` → `delete_scheduled_task`) |
| Delete-of-unregistered = success | ✅ Implemented (swallowed, `TaskScheduler.ts:51-53`) |
| Failure surface (repository errors) | ✅ Implemented (`operationError` alert, `TaskView.vue:513`) |
| Post-delete reload + reconcile | ✅ Implemented (`TaskView.vue:95`) |
| Unit tests | ✅ Implemented (`TaskView.test.ts:412`/`:528`, `TaskScheduler.test.ts:151`, `JsonTaskRepository.test.ts:88`) |

**Conclusion:** The Delete workflow is complete across all four layers — Vue
modal flow → JSON repository → TS scheduler adapter → dedicated Rust COM
command (`delete_scheduled_task` registered at `src-tauri/src/lib.rs:508`).
The frontend deliberately treats COM-delete failure as success, so the
reconcile banner (Clean Orphans) is the safety net for a registration that
survives deletion, and run history is intentionally left untouched.

**Optional future work (not required for correctness):**

- Delete the task's run-history rows in `task-runs.json` when a task is
  deleted (currently they only age out via the 200-run cap).
- Surface COM-delete failures (e.g. access denied) in the UI instead of
  silently leaving an orphaned registration for the banner.
- Add a direct unit test for `JsonTaskRepository.delete` idempotency
  (deleting a non-existent id does not rewrite the file).

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `Task--New-Task-Button-Workflow.md` — the create path (`create_scheduled_task`) that pairs with this delete path
- `Task--Load-Task-Page-Workflow.md` — `load()` / `loadReconcile()` and empty-state semantics
- `Task--Clean-Orphans-Workflow.md` — the reconcile-banner cleanup path for orphaned registrations
