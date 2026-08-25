# Load Task Page Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-22
**Status:** ✅ Implemented — no dedicated Rust command required (verified against `invoke_handler`)

---

## Overview

When the user opens the **Task** page, the view mounts and fires two parallel
loads that populate the three regions: the task table, the reconciliation
banner, and the execution-history panel.

1. **Vue UI** (`TaskView.vue`) — `onMounted` fires `load()` + `loadRuns()`
   fire-and-forget (not awaited, so they run concurrently).
2. **View loaders** (`TaskView.vue`) — `load()` → `loadScripts()` +
   `taskRepository.list()` + `loadReconcile()`; `loadRuns()` →
   `finalizePending()` + `taskRunRepository.list()`.
3. **TS services** (`src/services/task/`) — `JsonTaskRepository.list()`
   (tasks.json), `JsonTaskRunRepository.list()` (task-runs.json), and
   `TaskReconciler` (`listRegisteredTasks` → `reconcileTasks`) for the
   Windows-registration diff.
4. **Rust backend** supplies only the generic commands already registered —
   `read_text_file` (JSON + log reads), `path_exists` (script-missing check),
   `list_scheduled_tasks` (registration diff), `get_scheduled_task_status` /
   `get_task_run_result` (finalizing stale running runs).

The entire "Load Task page" path is implemented on the frontend. Persistence
re-uses `JsonTaskRepository` + `JsonTaskRunRepository` over `TauriFileStorage`,
and reconciliation re-uses the generic Task Scheduler COM command
`list_scheduled_tasks` — no dedicated load command is registered.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── TaskView.vue                      ← Step 1-2: onMounted + load/loadRuns loaders
├── composables/
│   └── useAppContext.ts                  ← DI: wires repositories + recorder + checker
├── services/
│   ├── task/
│   │   ├── TaskRepository.ts             ← port (interface)
│   │   ├── JsonTaskRepository.ts         ← Step 5: tasks.json adapter (list)
│   │   ├── TaskRunRepository.ts          ← port (interface)
│   │   ├── JsonTaskRunRepository.ts      ← Step 5: task-runs.json adapter (list)
│   │   ├── TaskRunRecorder.ts            ← Step 4: finalizePending/finalize
│   │   └── TaskReconciler.ts             ← Step 3: listRegisteredTasks + reconcileTasks
│   ├── script/
│   │   ├── scriptReconciliation.ts       ← findMissingScriptIds helper
│   │   └── scriptPathChecker.ts          ← exists() → invoke('path_exists')
│   └── shared/
│       ├── FileStorage.ts                ← port (interface)
│       └── TauriFileStorage.ts           ← Step 5: invoke read/write adapter
└── models/
    ├── Task.ts                           ← taskWindowsName, TASK_WINDOWS_NAMESPACE
    └── TaskRun.ts                        ← TaskRun model + runsFromJson
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/TaskView.vue` | `onMounted` + `load()`/`loadScripts()`/`loadReconcile()`/`loadRuns()` |
| `src/composables/useAppContext.ts` | DI: builds repositories, recorder, checker |
| `src/services/task/JsonTaskRepository.ts` | `list()` tasks.json adapter |
| `src/services/task/JsonTaskRunRepository.ts` | `list()` task-runs.json adapter (200 cap) |
| `src/services/task/TaskRunRecorder.ts` | `finalizePending()` + `finalize()` |
| `src/services/task/TaskReconciler.ts` | `listRegisteredTasks()` + `reconcileTasks()` |
| `src/services/script/scriptReconciliation.ts` | `findMissingScriptIds()` |
| `src/services/script/scriptPathChecker.ts` | `exists()` → `invoke('path_exists')` |
| `src/services/shared/FileStorage.ts` / `TauriFileStorage.ts` | port + invoke-based adapter |
| `src/models/Task.ts` | `taskWindowsName` (`PyscriptScheduler\<id>`) |
| `src/models/TaskRun.ts` | TaskRun model |

---

### Rust Backend

```
src-tauri/
└── src/
    └── lib.rs                           ← registers generic I/O + Task Scheduler COM commands
```

**Relevant existing commands (already registered in `invoke_handler`, `src-tauri/src/lib.rs:429-459`):**

- `read_text_file` — `TauriFileStorage.read()` for tasks.json, task-runs.json, and per-task stdout/stderr logs
- `write_text_file` — `TauriFileStorage.write()` (used by other flows; load is read-only)
- `path_exists` — `scriptPathChecker.exists()` during script-missing reconciliation
- `list_scheduled_tasks` — `TaskReconciler.listRegisteredTasks()` (COM namespace scan)
- `get_scheduled_task_status` / `get_task_run_result` — `TaskRunRecorder.finalize()` for stale running runs

No load-specific command exists; the page composes these generic commands.

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const storage = new TauriFileStorage()
const scriptRepository = overrides.scriptRepository ?? new JsonScriptRepository(storage, 'scripts.json')
const taskRepository = overrides.taskRepository ?? new JsonTaskRepository(storage, 'tasks.json', scriptRepository)
const taskRunRepository = overrides.taskRunRepository ?? new JsonTaskRunRepository(storage, 'task-runs.json')
// ...
taskRunRecorder: overrides.taskRunRecorder ?? new TaskRunRecorder(taskRunRepository),
scriptPathChecker: overrides.scriptPathChecker ?? tauriScriptPathChecker,
```

`TaskView.vue` consumes them in `setup`:

```ts
const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger, taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult } = useAppContext()
```

Tests supply fakes at the same boundary (`useAppContext` overrides / direct
deps, e.g. `FakeTaskRepository` / `FakeTaskRunRepository` in
`TaskView.test.ts`).

---

## Execution Flow

### Step 1 — Mount & Kick-off

**Location:** `src/views/TaskView.vue:479-481`

```ts
onMounted(() => {
  load()
  loadRuns()
})
```

**Behaviour:**

1. `onMounted` fires `load()` and `loadRuns()` — neither is awaited, so both
   proceed concurrently and the view paints immediately with empty state
   ("No tasks yet." / "No runs yet.") while data loads.
2. `load()` populates the scripts list, tasks table, and reconcile banner.
3. `loadRuns()` populates the Execution History panel.

**Flow chain:**
Page mount → `load()` + `loadRuns()` (parallel)

---

### Step 2 — Task/Script Loaders

**Location:** `src/views/TaskView.vue:66-103`

```ts
async function loadScripts() {
  if (!scriptRepository) return
  try {
    scripts.value = await scriptRepository.list()
  } catch {
    scripts.value = []
  }
  void refreshMissingScriptPaths()
}

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

1. `loadScripts()` is called fire-and-forget (not awaited) — the scripts list
   loads in parallel with the tasks list.
2. `taskRepository.list()` reads tasks.json and populates `tasks.value`; on
   failure the list is emptied defensively (view still renders).
3. After tasks resolve, `loadReconcile()` runs the Windows-registration diff
   (Step 3).
4. `refreshMissingScriptPaths()` (fired as `void` inside `loadScripts`) checks
   every script path via `scriptPathChecker.exists` → `invoke('path_exists')`;
   missing paths populate `missingPathScriptIds` and drive the
   `script_missing` badges and the Remove Broken action.

---

### Step 3 — Reconciliation (JSON vs Windows Task Scheduler)

**Location:** `src/views/TaskView.vue:105-112` → `src/services/task/TaskReconciler.ts:15-27`

```ts
async function loadReconcile() {
  try {
    registeredTasks.value = await listRegisteredTasks()
    reconcile.value = reconcileTasks(tasks.value, registeredTasks.value)
  } catch {
    reconcile.value = { missing: [], orphaned: [] }
  }
}
```

```ts
export async function listRegisteredTasks(): Promise<string[]> {
  return invoke<string[]>('list_scheduled_tasks')
}

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

1. `listRegisteredTasks()` invokes the Rust command `list_scheduled_tasks`,
   returning Windows Task Scheduler registration names from the app namespace.
2. `reconcileTasks()` diffs the two sources:
   - **missing** — JSON tasks whose `taskWindowsName(id)` (`PyscriptScheduler\<uuid>`,
     `src/models/Task.ts:105-109`) has no matching registration → "unregistered"
     badge + Repair action.
   - **orphaned** — registrations under `PyscriptScheduler\` with no matching
     JSON task → Clean Orphans action.
3. The result drives the reconcile banner (`TaskView.vue:514`) with counts
   and the Repair All / Clean Orphans / Remove Broken buttons. A failure leaves
   an empty `{ missing: [], orphaned: [] }` — no banner, no crash.

---

### Step 4 — Run History Loader

**Location:** `src/views/TaskView.vue:196-203` → `src/services/task/TaskRunRecorder.ts:56-100`

```ts
async function loadRuns() {
  await taskRunRecorder.finalizePending()
  try {
    runs.value = await taskRunRepository.list()
  } catch {
    runs.value = []
  }
}
```

```ts
async finalizePending(): Promise<void> {
  try {
    const runs = await this.repository.list()
    for (const run of runs) {
      if (run.status !== 'running') continue
      try {
        await this.finalize(run)
      } catch {
        // Leave the run as running; retried on the next refresh.
      }
    }
  } catch {
    // History must never break the task view.
  }
}

private async finalize(run: TaskRun): Promise<void> {
  const taskName = taskWindowsName(run.taskId)
  const state = await invoke<string>('get_scheduled_task_status', { taskName })
  if (state === 'running' || state === 'queued') return

  const result = await invoke<TaskRunResultPayload>('get_task_run_result', { taskName })
  const stdout = result.stdout_log ? await readTextFile(result.stdout_log) : null
  const stderr = result.stderr_log ? await readTextFile(result.stderr_log) : null
  // ... finalizeTaskRun with finishedAt / status success|failed / exitCode
  await this.repository.update(finalized)
}
```

**Behaviour:**

1. `finalizePending()` sweeps runs still marked `running`: for each, it queries
   `get_scheduled_task_status`; if the Windows task is no longer running/queued
   it reads the last result (`get_task_run_result`) and the per-task stdout /
   stderr log files (`read_text_file`), then finalizes the run as
   `success`/`failed` and persists via `taskRunRepository.update`.
2. Only then is `taskRunRepository.list()` read — so the panel always reflects
   finalized state on load.
3. The runs table renders the newest 200 runs (JSON adapter caps at 200,
   `JsonTaskRunRepository.ts:6, 27`), sorted newest-first by `startedAt`
   (`filteredRuns`, `TaskView.vue:205-210`), filterable All/Success/Failed.

---

### Step 5 — Persistence Layer

**Location:** `src/services/task/JsonTaskRepository.ts:14-31`, `src/services/task/JsonTaskRunRepository.ts:14-22`

```ts
// JsonTaskRepository
private async readTasks(): Promise<Task[]> {
  const content = await this.fileStorage.read(this.tasksFilePath)
  if (content === null) return []
  return tasksFromJson(content)
}

async list(): Promise<Task[]> {
  return this.readTasks()
}
```

```ts
// JsonTaskRunRepository
async list(): Promise<TaskRun[]> {
  const content = await this.fileStorage.read(this.runsFilePath)
  if (content === null) return []
  try {
    return runsFromJson(content)
  } catch {
    return []
  }
}
```

**Behaviour:**

1. Both adapters read through `FileStorage.read()` (`TauriFileStorage` →
   `invoke('read_text_file')`).
2. `null` content (JSON file not created yet, `read_text_file` returns
   `Ok(None)` on NotFound) → `[]` — this powers both empty states:
   "No tasks yet." (`TaskView.vue:525`) and "No runs yet."
   (`TaskView.vue:569`). There is no dedicated bootstrap path.
3. `tasksFromJson`/`runsFromJson` parse and guard against non-array content;
   the runs adapter additionally swallows parse errors (`[]` fallback).

```
TaskView (onMounted)
  ├─ load()
  │   ├─ loadScripts()            → JsonScriptRepository.list() → read_text_file (scripts.json)
  │   │                            → refreshMissingScriptPaths → path_exists
  │   ├─ taskRepository.list()    → JsonTaskRepository.list()  → read_text_file (tasks.json)
  │   └─ loadReconcile()          → list_scheduled_tasks       → reconcileTasks diff
  └─ loadRuns()
      ├─ finalizePending()        → get_scheduled_task_status / get_task_run_result
      │                            → read_text_file (stdout/stderr logs)
      └─ taskRunRepository.list() → JsonTaskRunRepository.list() → read_text_file (task-runs.json)
```

---

## Summary

| Aspect                    | Status                                      |
|---------------------------|---------------------------------------------|
| Mount kick-off            | ✅ Implemented (`TaskView.vue:479`)         |
| Task/script loaders       | ✅ Implemented (`TaskView.vue:66-103`)      |
| Reconciliation diff       | ✅ Implemented (`TaskReconciler.ts:19`)     |
| Run-history finalize+load | ✅ Implemented (`TaskRunRecorder.ts:56`)    |
| Persistence (tasks/runs)  | ✅ Implemented (`JsonTaskRepository`/`JsonTaskRunRepository`) |
| Script-missing check      | ✅ Implemented (`path_exists` command)      |
| Empty states              | ✅ Implemented ("No tasks yet." / "No runs yet.") |
| Unit tests                | ✅ Implemented (`TaskView.test.ts`, `TaskReconciler.test.ts`, `TaskRunRecorder.test.ts`) |

**Conclusion:** The "Load Task page" workflow is complete on the frontend. The
page composes existing generic commands — `read_text_file`, `path_exists`,
`list_scheduled_tasks`, `get_scheduled_task_status`, `get_task_run_result` —
through the repository/recorder/reconciler services, so no dedicated Rust
command is required. All loads are defensive (empty list on failure) and the
JSON-absent → `[]` semantics power both empty states.

**Optional future work (not required for correctness):**

- `loadScripts()` is fired without `await` inside `load()` — a deliberate
  parallel load, but scripts are not guaranteed present when the task table
  renders `scriptLabelOf(scriptId)` (falls back to the raw id). A `Promise.all`
  would serialize the pair at the cost of the faster source.
- `finalizePending()` re-lists runs for every refresh; with a large history
  this is O(n) invokes of `get_scheduled_task_status`. Could be batched behind
  a single backend query if history grows.
- The runs adapter's 200-run cap (`JsonTaskRunRepository.ts:6`) silently
  truncates; consider surfacing a hint in the Execution History panel.

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Task--New-Task-Button-Workflow.md` — Create flow (same repository/scheduler services)
- `docs/Task--Clean-Orphans-Workflow.md` — Orphaned-registration cleanup (uses the same reconcile diff)
- `docs/Scripts--Refresh-Button-Workflow.md` — Scripts-page load (same `read_text_file`/`path_exists` pattern)
- `docs/Home--Fresh-Start-App-Workflow.md` — First-run boot path that provisions the data dir
