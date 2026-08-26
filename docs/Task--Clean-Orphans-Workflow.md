# Clean-Orphans Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-22  
**Status:** ✅ Implemented — frontend orchestration over existing Rust commands (no dedicated Rust command required)

---

## Overview

When the Task page detects Windows scheduled-task registrations in the app namespace that have no matching JSON task, it shows a reconcile banner with a **Clean Orphans** button. Clicking it deletes each orphaned registration through the existing scheduler delete path:

1. **Vue UI** (`TaskView.vue`) loads the registered task names at mount/refresh and computes the reconcile result; the banner renders with counts for unregistered tasks, orphaned registrations, and script-missing tasks.
2. **Reconcile logic** (`TaskReconciler.ts`) — `reconcileTasks()` flags names under `PyscriptScheduler\` with no matching JSON task as orphaned; `removeOrphanedRegistrations()` deletes each one via the scheduler port.
3. **Scheduler adapter** (`TauriTaskScheduler`) maps the task id back to the full Windows task name and invokes the generic `delete_scheduled_task` Rust command.
4. **Rust backend** (`lib.rs`) delegates to the Task Scheduler COM delete (`windows_scheduler.rs`).

The entire path is frontend orchestration over the existing generic Task Scheduler commands — no new Rust command was required.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── TaskView.vue                     ← Step 1: reconcile banner + Clean Orphans button + cleanOrphans()
├── services/
│   └── task/
│       ├── TaskReconciler.ts            ← Step 2: reconcileTasks() + removeOrphanedRegistrations()
│       ├── TaskScheduler.ts             ← Step 3: TauriTaskScheduler.delete() → delete_scheduled_task
│       └── TaskRepository.ts            ← JSON task source (tasks.json)
├── composables/
│   └── useAppContext.ts                 ← DI wiring (taskScheduler, taskRepository)
└── models/
    └── Task.ts                          ← taskWindowsName() / taskIdFromWindowsName() / TASK_WINDOWS_NAMESPACE
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/TaskView.vue` | Reconcile banner (`reconcile-banner`), `Clean Orphans` button (`clean-orphans-btn`), `cleanOrphans()` handler |
| `src/services/task/TaskReconciler.ts` | `reconcileTasks()` orphan detection + `removeOrphanedRegistrations()` deletion |
| `src/services/task/TaskScheduler.ts` | `TauriTaskScheduler.delete()` — Tauri invoke adapter |
| `src/models/Task.ts` | `TASK_WINDOWS_NAMESPACE`, `taskWindowsName()`, `taskIdFromWindowsName()` |
| `src/composables/useAppContext.ts` | production DI wiring of `taskScheduler` |

---

### Rust Backend

```
src-tauri/
└── src/
    ├── lib.rs                           ← delete_scheduled_task command
    └── windows_scheduler.rs             ← COM Task Scheduler delete
```

**Relevant command (registered in `invoke_handler`, `src-tauri/src/lib.rs:508`):**

- `delete_scheduled_task` — deletes a registered task by name (`lib.rs:317`); deleting a never-registered name is success semantics (`TaskScheduler.ts:49-53`)

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts:65`:

```ts
taskScheduler: overrides.taskScheduler ?? new TauriTaskScheduler(),
```

`TaskView.vue` consumes the scheduler at the same boundary (`useAppContext.ts:16`):

```ts
const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger, taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult } = useAppContext()
```

Tests supply fakes at the same boundary (`useAppContext` overrides) — `TaskView.test.ts` wraps a `FakeTaskScheduler` whose `delete()` removes the name from the stateful registration list, and `TaskReconciler.test.ts` drives `removeOrphanedRegistrations()` with a fake scheduler that records `delete(taskId)` calls.

---

## Execution Flow

### Step 1 — Reconcile Banner + Clean Orphans Button

**Location:** `src/views/TaskView.vue` (banner at line 469, button at line 476)

```vue
<div v-if="reconcile.missing.length > 0 || reconcile.orphaned.length > 0 || brokenTasks().length > 0" class="alert alert-warning mb-3" data-testid="reconcile-banner" role="alert">
  <AlertIcon kind="warning" />
  <div class="flex flex-row items-center justify-between w-full gap-2">
    <span>{{ reconcile.missing.length }} task(s) unregistered{{ reconcile.orphaned.length > 0 ? `, ${reconcile.orphaned.length} orphaned registration(s)` : '' }}{{ brokenTasks().length > 0 ? `, ${brokenTasks().length} script_missing` : '' }}</span>
    <div class="flex gap-2">
      <button v-if="brokenTasks().length > 0" class="btn btn-xs btn-error" data-testid="remove-broken-btn" @click="removeBrokenConfirm = true">Remove Broken</button>
      <button v-if="reconcile.missing.length > 0" class="btn btn-xs btn-warning" :disabled="repairing" data-testid="repair-tasks-btn" @click="repairTasks">{{ repairing ? 'Repairing...' : 'Repair All' }}</button>
      <button v-if="reconcile.orphaned.length > 0" class="btn btn-xs btn-warning" :disabled="cleaningOrphans" data-testid="clean-orphans-btn" @click="cleanOrphans">{{ cleaningOrphans ? 'Cleaning...' : 'Clean Orphans' }}</button>
    </div>
  </div>
</div>
```

The button renders only when `reconcile.orphaned.length > 0` and shows a `Cleaning...` disabled state while the operation runs.

**Behaviour:**

1. `load()` → `loadReconcile()` (`TaskView.vue:86-92`) fetches the registered names and recomputes the reconcile result on mount and after every task operation.
2. `reconcile.orphaned` drives both the banner text (`, N orphaned registration(s)`) and the button visibility.
3. The banner groups three independent problems — unregistered tasks (Repair All), orphaned registrations (Clean Orphans), and script-missing tasks (Remove Broken).

User sees banner → clicks **Clean Orphans** → `cleanOrphans()`.

### Step 2 — cleanOrphans() Handler

**Location:** `src/views/TaskView.vue:119-133`

```ts
async function cleanOrphans() {
  if (reconcile.value.orphaned.length === 0) return
  cleaningOrphans.value = true
  operationError.value = ''
  const count = reconcile.value.orphaned.length
  try {
    await removeOrphanedRegistrations(reconcile.value.orphaned, taskScheduler)
    await load()
    operationResult.value = `Removed ${count} orphaned registration(s).`
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to clean orphaned registrations.')
  } finally {
    cleaningOrphans.value = false
  }
}
```

**Behaviour:**

1. No-op guard when there are no orphans.
2. Capture the count **before** the delete so the success message reflects the cleaned set even after the reload.
3. `removeOrphanedRegistrations(reconcile.value.orphaned, taskScheduler)` — the orphan names come straight from the reconcile result.
4. `load()` refreshes tasks + registered names; the banner clears when the orphans are gone.
5. Success → green alert `Removed N orphaned registration(s).`; failure → red alert with the mapped error message.

### Step 3 — removeOrphanedRegistrations() (reconcile service)

**Location:** `src/services/task/TaskReconciler.ts:68-78`

```ts
export async function removeOrphanedRegistrations(
  orphaned: string[],
  scheduler: TaskScheduler,
): Promise<string[]> {
  const removed: string[] = []
  for (const name of orphaned) {
    if (!name.startsWith(TASK_WINDOWS_NAMESPACE)) continue
    await scheduler.delete(taskIdFromWindowsName(name))
    removed.push(name)
  }
  return removed
}
```

Orphan detection itself lives in `reconcileTasks()` (`TaskReconciler.ts:19-27`):

```ts
export function reconcileTasks(tasks: Task[], registeredNames: string[]): ReconcileResult {
  const registered = new Set(registeredNames)
  const missing = tasks.filter(task => !registered.has(taskWindowsName(task.id)))
  const known = new Set(tasks.map(task => taskWindowsName(task.id)))
  const orphaned = registeredNames
    .filter(name => name.startsWith('PyscriptScheduler\\'))
    .filter(name => !known.has(name))
  return { missing, orphaned }
}
```

**Behaviour:**

1. `reconcileTasks` — a registered name is orphaned when it is inside the app namespace and no JSON task maps to it (`known` is built from `taskWindowsName(task.id)`).
2. `removeOrphanedRegistrations` — defensively re-checks the namespace prefix, converts the full Windows name back to the task id via `taskIdFromWindowsName()` (`Task.ts:112`), and deletes through the scheduler port.
3. Returns the removed names (used by tests to assert exactly which registrations were cleaned).

### Step 4 — TauriTaskScheduler.delete()

**Location:** `src/services/task/TaskScheduler.ts:48-54`

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

1. Maps the task id back to the full Windows task name (`PyscriptScheduler\<id>`).
2. Invokes the generic `delete_scheduled_task` Rust command.
3. Swallows errors — deleting a never-registered name is treated as success (the same semantics the task-delete row action relies on).

### Step 5 — Rust delete_scheduled_task (COM)

**Location:** `src-tauri/src/lib.rs:317` (registered in `invoke_handler` at line 508)

```rust
#[tauri::command]
fn delete_scheduled_task(task_name: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::delete_task(&task_name);
    }
    // non-Windows fallback
}
```

`windows_scheduler::delete_task` (`windows_scheduler.rs`) removes the registered task through the Task Scheduler COM API — the same code path the task row Delete button uses.

---

## Summary

| Aspect | Status |
|--------|--------|
| Reconcile banner with orphan count | ✅ Implemented (`TaskView.vue:469`) |
| Clean Orphans button (`clean-orphans-btn`) | ✅ Implemented (`TaskView.vue:476`) |
| Orphan detection (`reconcileTasks`) | ✅ Implemented (`TaskReconciler.ts:19`) |
| Orphan deletion (`removeOrphanedRegistrations`) | ✅ Implemented (`TaskReconciler.ts:68`) |
| Scheduler delete adapter | ✅ Implemented (`TaskScheduler.ts:48`) |
| Rust `delete_scheduled_task` | ✅ Implemented (`lib.rs:317`) |
| Success/error feedback alerts | ✅ Implemented (`TaskView.vue:127-129`) |
| Unit tests | ✅ Implemented (`TaskReconciler.test.ts`, `TaskView.test.ts`) |

**Conclusion:** The "Clean Orphans" flow is fully implemented on the frontend: `TaskView.vue` renders the reconcile banner with a conditional button, `removeOrphanedRegistrations()` walks the orphaned names and deletes each through the scheduler port, and `TauriTaskScheduler` forwards to the existing `delete_scheduled_task` COM command. No new Rust command was required — the flow composes the existing Task Scheduler commands.

**Optional future work (not required for correctness):**

- Add a confirm dialog before cleaning (Remove Broken already has one; Clean Orphans currently deletes immediately).
- Surface the removed task names in the success alert (currently only the count).

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Task--New-Task-Button-Workflow.md` — task creation (the counterpart that registers tasks)
- `docs/Home--Fresh-Start-App-Workflow.md` — uv runtime bootstrap (winget-first, used before tasks can run)
