# New-Task-Button Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-26  
**Status:** ✅ Implemented — frontend orchestration over existing Rust commands (venv + Task Scheduler COM); script executes via the venv interpreter + bundled launcher (no cmd.exe)

---

## Overview

When a user clicks the **New Task** button on the Task page, the following occurs:

1. **Vue UI** (`TaskView.vue`) calls `openCreate()` — resets the form, refreshes the script list, pre-fills the interpreter from the startup runtime check, and opens the task-details modal.
2. **Persistence** (`JsonTaskRepository`) validates the input against the script repository, generates a UUID + status, and writes the task to `tasks.json` via `TauriFileStorage`.
3. **Scheduler** (`TauriTaskScheduler`) ensures the script folder's venv exists and deps are synced, resolves the venv `python.exe`, then invokes `create_scheduled_task`.
4. **Rust backend** maps the schedule payload and registers a native Windows scheduled task through the Task Scheduler COM API (`windows_scheduler.rs`). The task's exec action runs the script directly with the venv `python.exe` through a bundled launcher (`run_script.py`, written to the app data dir) that captures stdout/stderr to per-task files — no `cmd.exe` involved.

The entire "New Task" path is orchestrated on the frontend; the Rust side provides the generic venv commands and the Task Scheduler COM registration command — no new Rust command was required for this feature.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── views/
│   └── TaskView.vue                     ← Step 1: button + openCreate + save + modal
├── services/
│   ├── task/
│   │   ├── TaskRepository.ts            ← port (interface)
│   │   ├── JsonTaskRepository.ts        ← JSON adapter (tasks.json)
│   │   ├── TaskScheduler.ts             ← Step 4: venv + deps + create_scheduled_task
│   │   └── TaskReconciler.ts            ← post-save refresh / repair (load())
│   └── shared/
│       ├── FileStorage.ts               ← port (interface)
│       └── TauriFileStorage.ts          ← persistence adapter (invoke read/write)
├── composables/
│   └── useAppContext.ts                 ← DI wiring (taskRepository, taskScheduler)
└── models/
    ├── Task.ts                          ← Task/TaskInput/Schedule model + createTask
    └── Script.ts                        ← Script model (referenced by scriptId)
```

**Present and wired:**

| File | Role |
|------|------|
| `src/views/TaskView.vue` | Button + `openCreate()` + `save()` + task-details modal |
| `src/services/task/TaskRepository.ts` / `JsonTaskRepository.ts` | port + JSON adapter |
| `src/services/task/TaskScheduler.ts` | `TauriTaskScheduler` — venv orchestration + scheduled-task creation |
| `src/services/task/TaskReconciler.ts` | `load()` reconcile of registered vs. persisted tasks |
| `src/services/shared/FileStorage.ts` / `TauriFileStorage.ts` | port + invoke-based adapter |
| `src/models/Task.ts` | `Task`, `TaskInput`, `Schedule` union, `createTask()`, `taskWindowsName()` |
| `src/composables/useAppContext.ts` | production DI wiring |

---

### Rust Backend

```rust
src-tauri/
└── src/
    ├── lib.rs                           ← command registrations + create_scheduled_task (writes launcher)
    ├── windows_scheduler.rs             ← COM Task Scheduler (create/delete/set_enabled) + embedded launcher
    └── venv.rs                          ← ensure_venv / sync_deps / venv_python_path
```

The launcher (`run_script.py`) is not a source file: its source is embedded as
`RUN_SCRIPT_LAUNCHER` in `windows_scheduler.rs:146` and written to
`<app data>\run_script.py` by `ensure_launcher` (`windows_scheduler.rs:222`)
on every create/update (idempotent, keeps the file in sync with the binary).

**Relevant commands (registered in `invoke_handler`, `src-tauri/src/lib.rs:508`):**

- `read_folder_requirements` — reads `requirements.txt` lines from the script folder (`lib.rs:442`)
- `ensure_script_venv` — creates `<script folder>/.venv` via uv if unhealthy (`lib.rs:399`)
- `sync_script_deps` — `uv pip install --requirement` inside the venv (`lib.rs:417`)
- `get_venv_python_path` — returns `<folder>/.venv/Scripts/python.exe` (`lib.rs:386`)
- `get_log_directory` — app data `logs\` dir (`lib.rs:46`)
- `create_scheduled_task` — COM registration + launcher write (`lib.rs:232`)
- `delete_scheduled_task` / `set_scheduled_task_enabled` — used by edit/toggle/delete (`lib.rs:317`, `lib.rs:327`)

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
const storage = new TauriFileStorage()
const scriptRepository = overrides.scriptRepository ?? new JsonScriptRepository(storage, 'scripts.json')
const taskRepository = overrides.taskRepository ?? new JsonTaskRepository(storage, 'tasks.json', scriptRepository)
// ...
taskScheduler: overrides.taskScheduler ?? new TauriTaskScheduler(),
```

`TaskView.vue` consumes them at the same boundary (`useAppContext.ts:16`):

```ts
const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger, taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult } = useAppContext()
```

Tests supply fakes at the same boundary (`useAppContext` overrides).

---

## Execution Flow

### Step 1 — Vue UI Layer

**Location:** `src/views/TaskView.vue` (button at line 501, handler at lines 235–241)

```vue
<button class="btn btn-primary" data-testid="new-task-btn" @click="openCreate">New Task</button>
```

```ts
async function openCreate() {
  editingId.value = null
  await loadScripts()
  form.value = emptyForm()
  error.value = ''
  isEditing.value = true
  prefillInterpreterFromSystemInfo()
}
```

`emptyForm()` (lines 84–93) seeds the defaults — first selectable script, `python` interpreter, a daily schedule starting today 08:00, enabled:

```ts
function emptyForm(): TaskInput {
  return {
    name: '',
    scriptId: selectableScripts.value[0]?.id ?? '',
    interpreter: 'python',
    arguments: [],
    schedule: { type: 'daily', startAt: `${todayDateString()}T08:00:00` },
    enabled: true,
  }
}
```

`prefillInterpreterFromSystemInfo()` (lines 274–279) replaces the bare `python` default with the Python path resolved once at startup, so tasks never silently fall back to a PATH-first `python.exe` that differs from the detected runtime.

User click → `openCreate()` → `loadScripts()` → `emptyForm()` → open modal.

### Step 1b — Task Details Modal

**Location:** `src/views/TaskView.vue` (lines 594–648, `data-testid="task-dialog"`, fieldset `task-details-fieldset` at line 596)

The modal (fieldset `task-details-fieldset`) contains:

- **Name** — `task-name-input`
- **Script** — `script-select`, options from `selectableScripts` (missing-path scripts filtered out; a missing script renders a disabled placeholder option)
- **Python interpreter** — `interpreter-input` (pre-filled with the resolved runtime path)
- **Arguments** — `arguments-input`, whitespace-split into `form.arguments`
- **Schedule** — `schedule-type-select`: `once` | `daily` | `weekly` | `interval`, with conditional fields (`run-at-input`, `start-datetime-input`, `day-of-week-select`, `interval-every-input` + `interval-unit-select`)

Switching schedule type reseeds per-type defaults in `updateScheduleType()` (lines 251–256):

```ts
function updateScheduleType(type: Schedule['type']) {
  if (type === 'once') form.value.schedule = { type, runAt: `${todayDateString()}T08:00:00` }
  if (type === 'daily') form.value.schedule = { type, startAt: `${todayDateString()}T08:00:00` }
  if (type === 'weekly') form.value.schedule = { type, startAt: `${todayDateString()}T08:00:00`, dayOfWeek: 1 }
  if (type === 'interval') form.value.schedule = { type, startAt: `${todayDateString()}T08:00:00`, every: 1, unit: 'hours' }
}
```

Actions: **Save** (`save-task-btn` → `save()`) and **Cancel** (`cancel-task-btn` → `closeForm()`).

### Step 2 — save(): Validation → Repository → Scheduler

**Location:** `src/views/TaskView.vue` (lines 349–381)

```ts
async function save() {
  error.value = ''
  const started = performance.now()
  try {
    if (!form.value.name.trim()) throw new Error('Task name is required')
    if (!form.value.scriptId) throw new Error('Script is required')
    if (missingPathScriptIds.value.includes(form.value.scriptId)) throw new Error('Script is missing — select a replacement')
    if (!form.value.interpreter.trim()) throw new Error('Python interpreter is required')
    const script = scripts.value.find(script => script.id === form.value.scriptId)
    if (!script) throw new Error('Script is required')
    let task: Task
    if (editingId.value) {
      task = await taskRepository.update(editingId.value, form.value)
    } else {
      task = await taskRepository.create(form.value)
    }
    const afterRepo = performance.now()
    if (editingId.value) {
      await taskScheduler.update(task, script)
    } else {
      await taskScheduler.create(task, script)
    }
    const afterScheduler = performance.now()
    await load()
    // ...
    closeForm()
  } catch (cause) {
    error.value = errorText(cause, 'Failed to save task.')
    // ...
  }
}
```

**Behaviour:**

1. Validate required fields (name, script, interpreter) plus the missing-script guard.
2. Persist via `taskRepository.create(form.value)` → returns the full `Task` (UUID + status + timestamps).
3. Register with the Windows Task Scheduler via `taskScheduler.create(task, script)`.
4. `load()` refreshes the table and re-runs reconciliation (`loadReconcile` → `listRegisteredTasks`).
5. Log `task.create` timing via `logger.record`, then `closeForm()`.
6. Any failure sets the inline `error` alert inside the modal and logs `task.create ... failed`.

**Note:** because `taskScheduler.create()` (not `update`) is used on the create path and `TaskScheduler.update()` internally deletes then recreates, the modal is shared by both New Task and Edit.

### Step 3 — Persistence Path

**Location:** `src/services/task/JsonTaskRepository.ts` (create at lines 38–45)

```ts
async create(input: TaskInput): Promise<Task> {
  await this.validate(input)
  const tasks = await this.readTasks()
  const task = createTask(input)
  tasks.push(task)
  await this.writeTasks(tasks)
  return task
}
```

- `validate()` checks the script exists via `scriptRepository.get(scriptId)` + `validateTaskInput` (`src/models/Task.ts:64`).
- `createTask()` (`src/models/Task.ts:71`) assigns `id: crypto.randomUUID()`, status `'scheduled'` when enabled / `'disabled'` otherwise, and ISO timestamps.
- `tasks.json` is read/written through `TauriFileStorage` → `invoke('read_text_file' / 'write_text_file')`.

```
TaskView.save()
  → TaskRepository.create(input)            // port
    → JsonTaskRepository.create(input)      // validate → createTask → write
      → TauriFileStorage
        → invoke('read_text_file' / 'write_text_file')   // tasks.json
```

### Step 4 — Scheduler Orchestration

**Location:** `src/services/task/TaskScheduler.ts` (create at lines 14–40)

```ts
async create(task: Task, script: Script): Promise<void> {
  const workingDir = scriptDir(script.path)

  // Read requirements.txt from script folder (or empty if not found)
  const requirements = await invoke<string[]>('read_folder_requirements', { dirPath: workingDir })

  // Ensure venv exists in the script folder and deps are synced (idempotent — hash cache skips if unchanged)
  const pythonVersion = script.pythonVersion ?? '3.11'
  await invoke('ensure_script_venv', { dirPath: workingDir, pythonVersion })
  if (requirements.length > 0) {
    await invoke('sync_script_deps', { dirPath: workingDir, requirements })
  }

  // Get the venv's python.exe path
  const venvPythonPath = await invoke<string>('get_venv_python_path', { dirPath: workingDir })

  const logDirectory = await invoke<string>('get_log_directory')
  await invoke('create_scheduled_task', {
    taskName: taskWindowsName(task.id),
    venvPythonPath,
    scriptPath: script.path,
    arguments: task.arguments,
    workingDirectory: workingDir,
    logDirectory,
    schedule: schedulePayload(task.schedule),
  })
}
```

**Behaviour:**

1. Derive the script folder from the script path.
2. Read `requirements.txt` (empty if absent).
3. `ensure_script_venv` — idempotent: health check (`python.exe` + `pyvenv.cfg` + version match); recreates from scratch when unhealthy (and clears the deps hash cache so sync won't skip).
4. `sync_script_deps` — `uv pip install --requirement` (resolves transitive deps; AppData hash cache decides skip-vs-install).
5. Resolve the venv interpreter path and the app log directory.
6. Invoke `create_scheduled_task` with the Windows task name `PyscriptScheduler\\<taskId>` (`taskWindowsName`, `src/models/Task.ts:107`; namespace constant `TASK_WINDOWS_NAMESPACE` at `Task.ts:105`).

The schedule is mapped to the Rust payload in `schedulePayload()` (lines 67–77):

```ts
switch (schedule.type) {
  case 'once':
    return { schedule_type: 'once', value: schedule.runAt }
  case 'daily':
    return { schedule_type: 'daily', value: '', start_at: schedule.startAt }
  case 'weekly':
    return { schedule_type: 'weekly', value: '', day_of_week: schedule.dayOfWeek, start_at: schedule.startAt }
  case 'interval':
    return { schedule_type: 'interval', value: '', every: schedule.every, unit: schedule.unit, start_at: schedule.startAt }
}
```

### Step 5 — Rust Command Layer

**Location:** `src-tauri/src/lib.rs:232` (registered in `invoke_handler` at line 508)

```rust
#[tauri::command]
fn create_scheduled_task(
    state: tauri::State<'_, AppDataDir>,
    task_name: String,
    venv_python_path: String,
    script_path: String,
    arguments: Vec<String>,
    working_directory: String,
    log_directory: String,
    schedule: SchedulePayload,
) -> Result<String, String> {
    let schedule = schedule_from_payload(schedule)?;
    #[cfg(windows)]
    {
        // Write the embedded launcher into app data (idempotent) so the task
        // can run the venv interpreter directly instead of through cmd.exe.
        let launcher_path = windows_scheduler::ensure_launcher(&state.0)?
            .to_string_lossy()
            .to_string();
        return windows_scheduler::create_task(&windows_scheduler::CreateTaskSpec {
            task_name,
            venv_python_path,
            launcher_path,
            script_path,
            arguments,
            working_directory,
            log_directory,
            schedule,
        });
    }
    // non-Windows: schtasks-based fallback
}
```

`schedule_from_payload` (`lib.rs:210`) parses `schedule_type` into `scheduler::ScheduleSpec::{Once, Daily, Weekly, Interval}`. Venv commands (`ensure_script_venv`, `sync_script_deps`, `get_venv_python_path`, `read_folder_requirements`) delegate to `venv.rs` and are keyed by `dir_path` directly (no folder-hash indirection). The `state` argument is a Tauri-managed `AppDataDir` (server-injected — invisible to the JS `invoke` payload) used to write the launcher into app data.

### Step 6 — Windows Task Scheduler (COM registration)

**Location:** `src-tauri/src/windows_scheduler.rs:714`

```rust
pub fn create_task(spec: &CreateTaskSpec) -> Result<String, String> {
    // validate_text on every field (including launcher_path) ...
    // Build the python.exe + launcher action up front (pure): stdout/stderr
    // are redirected into per-task log files by the launcher script inside
    // the log directory.
    let (action_path, action_arguments) = exec_action_parts(
        &spec.venv_python_path,
        &spec.launcher_path,
        &spec.script_path,
        &spec.arguments,
        &spec.log_directory,
        &spec.task_name,
    )?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;
    // NewTask → author "PyscriptScheduler"
    // Settings: StartWhenAvailable + DisallowStartIfOnBatteries(0) + StopIfGoingOnBatteries(0)
    // Trigger from build_trigger(&spec.schedule)
    // Exec action: Path/Arguments/WorkingDirectory (venv python + launcher, no shell)
    (*folder).RegisterTaskDefinition(
        task_name_wide.as_ptr() as *mut u16,
        task,
        TASK_CREATE_OR_UPDATE as i32,
        empty, empty,
        TASK_LOGON_INTERACTIVE_TOKEN,
        empty,
        &mut registered,
    )
    // ...
    Ok(format!("registered {}", spec.task_name))
}
```

**Behaviour:**

1. Validate all text inputs (including `launcher_path`).
2. `exec_action_parts` (`windows_scheduler.rs:107`) builds the action with the **venv interpreter as the program** (`put_Path` = `venv_python_path`, not `cmd.exe`) and arguments pointing at the launcher: `<launcher> --script <script> --stdout-log <out> --stderr-log <err> [-- <script args>]`. The launcher (`run_script.py`, source embedded at `windows_scheduler.rs:146`) opens the two log files (truncating, matching the old `cmd` `1>`/`2>` behavior) and spawns the real script with `subprocess` using the same interpreter, then propagates its exit code so the Task Scheduler records the real `LastResult`.
3. Register via the COM Task Scheduler API: author `PyscriptScheduler`, `StartWhenAvailable`, battery-friendly settings (runs on battery — laptop-safe by design), a trigger built from the schedule spec, and the exec action.
4. `RegisterTaskDefinition` with `TASK_CREATE_OR_UPDATE` and `TASK_LOGON_INTERACTIVE_TOKEN` — the task runs as the current interactive user, no elevation.

Why no shell: Task Scheduler's exec action starts any executable directly — `cmd.exe` existed only to perform the `1>`/`2>` log redirection. The launcher performs the same redirection in-process, so the action now spawns `python.exe` straight (removes the extra process and any shell quoting); script arguments sit after a `--` separator so they can never be misread as launcher flags.

---

## Summary

| Aspect | Status |
|--------|--------|
| New Task button (`new-task-btn`) | ✅ Implemented (`TaskView.vue:501`) |
| Form reset + script reload (`openCreate`) | ✅ Implemented (`TaskView.vue:235`) |
| Interpreter pre-fill from runtime check | ✅ Implemented (`TaskView.vue:274`) |
| Schedule type switching + defaults | ✅ Implemented (`TaskView.vue:287`) |
| Validation (name/script/interpreter/missing) | ✅ Implemented (`TaskView.vue:349`) |
| Persistence (`tasks.json` via `JsonTaskRepository`) | ✅ Implemented |
| Venv ensure + deps sync before registration | ✅ Implemented (`TaskScheduler.ts:14`) |
| Windows scheduled-task registration (COM) | ✅ Implemented (`windows_scheduler.rs:714`) |
| Direct python.exe exec via bundled launcher (no cmd) | ✅ Implemented (`windows_scheduler.rs:107`, launcher at `:146`) |
| Unit tests | ✅ Implemented (`TaskView.test.ts`, `TaskScheduler.test.ts`) |

**Conclusion:** The "New Task" flow is fully implemented end-to-end: the Vue view builds and validates a `TaskInput`, `JsonTaskRepository` persists it to `tasks.json`, and `TauriTaskScheduler` guarantees a healthy venv with synced dependencies before registering a native Windows scheduled task via COM. No new Rust command was required — the flow composes the existing venv and scheduler commands.

**Optional future work (not required for correctness):**

- Surface a success toast/confirmation after save (currently the row appearing in the table is the only feedback, plus the `task.create` log entry).
- Show `nextRunAt` computation per schedule type in the table (the field exists on the model but is only filled by the run recorder path).
- Add an E2E test that stubs the scheduler invokes and asserts `tasks.json` contents after save.

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Scripts--Add-File-Button-Workflow.md` — the Add File flow (venv creation details shared with this flow)
