# Run-Now Button Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-23  
**Status:** ✅ Complete — no dedicated Rust command required

---

## Overview

When the user clicks the **Run Now** button on the Task page, the following occurs:

1. **Vue UI** (`TaskView.vue`) calls `runTask(task)`.
2. **Composable layer** orchestrates: record start → invoke executor → on success: load + loadRuns + log → on failure: record failure + log.
3. **TS services** (`TauriTaskExecutor`, `TaskRunRecorder`, `JsonTaskRunRepository`) adapt to native APIs and persist run history.
4. **Rust backend** supplies only the generic COM commands already registered (`run_scheduled_task`, `read_text_file`, `write_text_file`). The `TauriTaskExecutor` invokes `run_scheduled_task` which calls COM's `IRegisteredTask::Run` — no new Rust command is needed.

The entire "Run Now" path is implemented on the frontend. Run history is persisted to `task-runs.json` via the existing `JsonTaskRunRepository` + `TauriFileStorage` layer. The Rust backend's `run_scheduled_task` command is a generic COM wrapper used by both Run Now and scheduled task execution.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── TaskView.vue                     ← Step 1: Run Now button + runTask handler
├── services/
│   ├── task/
│   │   ├── TaskExecutor.ts              ← Step 2: executor port + Tauri adapter
│   │   ├── TaskRunRecorder.ts           ← Step 3: recordStart / recordFailure
│   │   ├── TaskRunRepository.ts         ← Step 4: port (interface)
│   │   └── JsonTaskRunRepository.ts     ← Step 4: JSON adapter (task-runs.json)
│   └── shared/
│       ├── FileStorage.ts               ← port (interface)
│       └── TauriFileStorage.ts          ← persistence adapter (invoke read/write)
├── composables/
│   ├── useAppContext.ts                 ← DI wiring
│   └── useAutoDismiss.ts               ← auto-dismiss for operationResult/Error
└── models/
    ├── Task.ts                          ← Task model + taskWindowsName()
    └── TaskRun.ts                       ← TaskRun model + createTaskRun / finalizeTaskRun
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/TaskView.vue` | Run Now icon button (line 547) + `runTask()` handler (line 406) |
| `src/services/task/TaskExecutor.ts` | `TauriTaskExecutor.run()` — invokes `run_scheduled_task` |
| `src/services/task/TaskRunRecorder.ts` | `recordStart()` / `recordFailure()` / `finalizePending()` |
| `src/services/task/TaskRunRepository.ts` | Port (interface) |
| `src/services/task/JsonTaskRunRepository.ts` | JSON adapter — `list`, `append`, `update`, `clear` on `task-runs.json` |
| `src/models/TaskRun.ts` | TaskRun model + `createTaskRun` / `finalizeTaskRun` |
| `src/composables/useAppContext.ts` | DI wiring — constructs `TauriTaskExecutor`, `TaskRunRecorder`, `JsonTaskRunRepository` |

### Rust Backend

```
src-tauri/
└── src/
    ├── lib.rs                              ← registers run_scheduled_task + generic I/O commands
    └── windows_scheduler.rs                ← run_task() COM implementation
```

**Relevant existing commands (already registered in `invoke_handler`, `src-tauri/src/lib.rs:508-541`):**

- `run_scheduled_task` — generic COM task trigger used by both Run Now and scheduled execution (`lib.rs:337`)
- `get_scheduled_task_status` — used by `TaskRunRecorder.finalizePending` to check if still running
- `get_task_run_result` — used by `TaskRunRecorder.finalizePending` to obtain last result + log paths
- `read_text_file` / `write_text_file` — used by `TauriFileStorage` for `task-runs.json`
- `delete_scheduled_task` — used by `TauriTaskScheduler` (not part of Run Now flow)

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const taskRunRepository = overrides.taskRunRepository ?? new JsonTaskRunRepository(storage, 'task-runs.json')
// ...
taskExecutor: overrides.taskExecutor ?? new TauriTaskExecutor(),
taskRunRecorder: overrides.taskRunRecorder ?? new TaskRunRecorder(taskRunRepository),
```

`TaskView.vue` consumes them:

```ts
const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger,
        taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult } = useAppContext()
```

Tests supply fakes at the same boundary (`useAppContext` overrides / direct constructor injection).

---

## Execution Flow

### Step 1 — Vue UI Layer

**Location:** `src/views/TaskView.vue` (button at line 547, handler at line 406)

```vue
<button class="btn btn-xs btn-ghost join-item text-primary"
  :data-testid="`run-task-${task.id}`"
  :title="`Run ${task.name}`"
  :disabled="runningTaskId === task.id || !task.enabled"
  @click="runTask(task)">
  <span v-if="runningTaskId === task.id" class="loading loading-spinner loading-xs"></span>
  <PlayIcon v-else />
</button>
```

The button is disabled when:
- `runningTaskId === task.id` — a run is already in progress for this task
- `!task.enabled` — the task is disabled (schedule is not active)

```ts
async function runTask(task: Task) {
  runningTaskId.value = task.id
  operationResult.value = ''
  operationError.value = ''
  const started = performance.now()
  const run = await taskRunRecorder.recordStart(task.id)
  try {
    operationResult.value = await taskExecutor.run(task)
    await logger?.record('task.run', `run ${task.name}: ${operationResult.value}`, 'info',
      Math.round(performance.now() - started))
    await load()
    await loadRuns()
  } catch (cause) {
    // Run-now errors are the script's own stderr output — preserve it
    // verbatim in the run history rather than rewriting it as guidance.
    const message = rawErrorText(cause, 'Failed to run task.')
    operationError.value = message
    await taskRunRecorder.recordFailure(run, message)
    await logger?.record('task.run', `run ${task.name} failed: ${message}`, 'error',
      Math.round(performance.now() - started))
  } finally {
    runningTaskId.value = null
  }
}
```

**Behaviour:**

1. Set `runningTaskId` → disables the button, swaps the play icon for a DaisyUI spinner
2. Clear previous `operationResult` / `operationError`
3. Call `taskRunRecorder.recordStart(task.id)` — creates a TaskRun with status `'running'`, persists to `task-runs.json`
4. Call `taskExecutor.run(task)` — invokes `run_scheduled_task` Rust command via COM
5. **On success:**
   - Log the run event
   - Reload tasks (`load()`) to update status / next-run fields
   - Reload run history (`loadRuns()`) — calls `finalizePending()` to catch any newly-finished runs, then re-reads `task-runs.json`
6. **On failure:**
   - The rejection value is the script's stderr output (preserved verbatim)
   - `rawErrorText` extracts the raw error message (never wraps it in guidance text)
   - Call `taskRunRecorder.recordFailure(run, message)` — finalizes the run as `'failed'`
   - Log the failure event
7. **In either case:** clear `runningTaskId` in `finally` block

Success/failure banners auto-dismiss via `useAutoDismiss` after 3 seconds.

**Flow chain:**
```
User click → runTask(task) → TaskRunRecorder.recordStart() → TauriTaskExecutor.run()
  → invoke('run_scheduled_task') → COM IRegisteredTask::Run
  → on success: load() + loadRuns() + log
  → on failure: TaskRunRecorder.recordFailure() + log
```

### Step 2 — TaskExecutor (TS service)

**Location:** `src/services/task/TaskExecutor.ts`

```ts
import { invoke } from '@tauri-apps/api/core'
import type { Task } from '../../models/Task'

export interface TaskExecutor {
  run(task: Task): Promise<string>
}

export class TauriTaskExecutor implements TaskExecutor {
  run(task: Task): Promise<string> {
    return invoke<string>('run_scheduled_task', { taskName: `PyscriptScheduler\\${task.id}` })
  }
}
```

The `taskName` is constructed from the `PyscriptScheduler\` namespace prefix plus the task's UUID. This matches the naming scheme used in `create_scheduled_task` and `delete_scheduled_task`.

The return value is a success string like `"started PyscriptScheduler\<uuid>"`. On error (task not registered, COM failure), the promise rejects with the error message.

### Step 3 — TaskRunRecorder

**Location:** `src/services/task/TaskRunRecorder.ts`

```ts
async recordStart(taskId: string): Promise<TaskRun> {
  try {
    const run = createTaskRun({ taskId })
    await this.repository.append(run)
    return run
  } catch {
    return createTaskRun({ taskId })   // history must never block the run
  }
}
```

`createTaskRun({ taskId })` (in `src/models/TaskRun.ts`) generates a UUID, sets `startedAt` to `new Date().toISOString()`, and status to `'running'`.

```ts
async recordFailure(run: TaskRun, message: string): Promise<void> {
  try {
    const finalized = finalizeTaskRun(run, {
      finishedAt: new Date().toISOString(),
      status: 'failed',
      exitCode: null,
      stdout: null,
      stderr: message,
    })
    try {
      await this.repository.update(finalized)
    } catch {
      await this.repository.append(finalized)
    }
  } catch {
    // History recording must never break the run flow.
  }
}
```

**Behaviour:**

- `recordStart`: creates a TaskRun with status `'running'`, appends to `task-runs.json`. Capped at 200 entries (see `JsonTaskRunRepository`).
- `recordFailure`: uses `finalizeTaskRun` to set `finishedAt`, status `'failed'`, and the error message as `stderr`. Tries `update` first; falls back to `append` if the run was never persisted.
- Both methods are silently error-guarded — run history recording never blocks the user's run flow.

### Step 4 — Persistence (JsonTaskRunRepository)

**Location:** `src/services/task/JsonTaskRunRepository.ts`

```ts
export class JsonTaskRunRepository implements TaskRunRepository {
  constructor(
    private readonly fileStorage: FileStorage,
    private readonly runsFilePath: string,
  ) {}

  async list(): Promise<TaskRun[]> {
    const content = await this.fileStorage.read(this.runsFilePath)
    if (content === null) return []
    try { return runsFromJson(content) } catch { return [] }
  }

  async append(run: TaskRun): Promise<void> {
    const runs = await this.list()
    runs.push(run)
    const capped = runs.slice(-MAX_RUNS)  // keep newest 200
    await this.fileStorage.write(this.runsFilePath, runsToJson(capped))
  }

  async update(run: TaskRun): Promise<void> {
    const runs = await this.list()
    const index = runs.findIndex(existing => existing.id === run.id)
    if (index === -1) throw new Error(`TaskRun with id ${run.id} not found`)
    runs[index] = run
    await this.fileStorage.write(this.runsFilePath, runsToJson(runs))
  }

  async clear(): Promise<void> {
    await this.fileStorage.write(this.runsFilePath, runsToJson([]))
  }
}
```

**Capacity:** `MAX_RUNS = 200` — the newest 200 runs are kept; older entries are silently pruned on every `append`. The `clear()` method zeros the history entirely.

**Persistence path:**
```
TaskRunRecorder
  → JsonTaskRunRepository
    → TauriFileStorage
      → invoke('read_text_file' / 'write_text_file')
```

### Step 5 — Rust: `run_scheduled_task` (COM)

**Location:** `src-tauri/src/lib.rs:337` (registered in `invoke_handler` at line 508)

```rust
#[tauri::command]
fn run_scheduled_task(task_name: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::run_task(&task_name);
    }
}
```

**Implementation:** `src-tauri/src/windows_scheduler.rs:904`

```rust
pub fn run_task(task_name: &str) -> Result<String, String> {
    validate_text(task_name, "task_name")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let mut registered: *mut IRegisteredTask = ptr::null_mut();
    let hr = unsafe { (*folder).GetTask(task_name_wide.as_ptr() as *mut u16, &mut registered) };
    unsafe { (*folder).Release() };
    check_hr!(hr, format!("failed to open scheduled task '{}'", task_name));

    let empty: VARIANT = unsafe { std::mem::zeroed() };
    let hr = unsafe { (*registered).Run(empty, ptr::null_mut()) };
    unsafe { (*registered).Release() };
    check_hr!(hr, format!("failed to run scheduled task '{}'", task_name));

    Ok(format!("started {}", task_name))
}
```

**Behaviour:**

1. Opens a COM connection to the Task Scheduler
2. Gets the root folder for the `PyscriptScheduler\` namespace
3. Calls `IRegisteredTask::Run` with an empty VARIANT — triggers immediate execution
4. Returns `"started PyscriptScheduler\<uuid>"` on success
5. On failure (task not found, COM error), returns an error string that propagates as the `runTask` catch branch message

The task's configured command line, working directory, and log file settings are already stored in the Windows Task Scheduler registration from `create_scheduled_task` — `Run` simply triggers the registered action.

---

### Step 6 — Post-run load and reconciliation

On success, `runTask` calls `load()` then `loadRuns()`:

```ts
async function load() {
  loadScripts()                          // refresh script list
  try { tasks.value = await taskRepository.list() } catch { tasks.value = [] }
  await loadReconcile()                  // check COM registration state
}

async function loadRuns() {
  await taskRunRecorder.finalizePending()  // catch any newly-finished runs
  try { runs.value = await taskRunRepository.list() } catch { runs.value = [] }
}
```

`finalizePending()` queries `get_scheduled_task_status` and `get_task_run_result` for any runs still in `'running'` status — if the Windows task is no longer running, it reads stdout/stderr log files and finalizes the run with exit code.

---

## Summary

| Aspect | Status |
|--------|--------|
| Run Now button | ✅ Implemented (`TaskView.vue:547`) |
| `runTask()` handler | ✅ Implemented (`TaskView.vue:406`) |
| Button disabled states (running, disabled) | ✅ Implemented (`disabled` bindings) |
| Record start in run history | ✅ Implemented (`TaskRunRecorder.recordStart`) |
| Task executor (COM trigger) | ✅ Implemented (`TauriTaskExecutor.run`) |
| Record failure in run history | ✅ Implemented (`TaskRunRecorder.recordFailure`) |
| Post-run task reload (`load()`) | ✅ Implemented |
| Post-run history refresh (`loadRuns()`) | ✅ Implemented |
| Run history persistence | ✅ Implemented (`JsonTaskRunRepository`, `task-runs.json`) |
| Run history capacity (200 max) | ✅ Implemented (`MAX_RUNS`) |
| Run history filters (All/Success/Failed) | ✅ Implemented (`runFilter`) |
| Run history clear | ✅ Implemented (`confirmClearRuns`) |
| Unit tests | ✅ Implemented (`TaskView.test.ts` — 57 tests) |

**Conclusion:** The "Run Now" workflow is complete on both frontend and backend. The existing `run_scheduled_task` Rust command (a generic COM wrapper) handles the task trigger; all orchestration, history recording, and UI feedback lives in the TS/Vue layer. No new Rust commands were required — `run_scheduled_task` was already registered in `invoke_handler` as part of the scheduled task infrastructure.

**Optional future work (not required for correctness):**

- Show per-task stdout/stderr inline in the run history row (currently only finalizePending reads log files; Run Now only captures error stderr on failure)
- Surface the running task's PID or timeout status
- Add a confirmation dialog before Run Now for destructive tasks

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Task--New-Task-Button-Workflow.md` — Task creation flow (COM registration)
- `docs/Task--Delete-Button-Workflow.md` — Task deletion flow
- `docs/Task--Load-Task-Page-Workflow.md` — Page mount flow (load + finalizePending)