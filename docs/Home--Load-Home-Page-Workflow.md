# Load Home Page Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-25  
**Status:** ✅ Implemented — no dedicated Rust command required (verified against `invoke_handler`)

---

## Overview

When the user opens the **Home** page (the app's landing view), the sidebar
navigation switches `activeView` to `'home'`, `App.vue` mounts `HomeView` via a
dynamic component, and the view's `onMounted` fires one parallel stats load that
populates the dashboard, the Host Health card, and the Recent Executions table.

1. **Vue UI** (`App.vue` + `HomeView.vue`) — the `views` computed resolves the
   active view; `HomeView` `onMounted` fires `loadStats()` (fire-and-forget, the
   view paints immediately with zeroed/empty state).
2. **View loader** (`HomeView.vue:56-70`) — `loadStats()` runs four parallel
   reads via `Promise.all`: scripts, tasks, runs, and the Host Health check,
   each defensively caught.
3. **TS services** (`src/services/home/` + repositories) —
   `computeDashboardStats` (pure aggregation: used/unused, next run, runs
   today, schedule/python summaries) and `checkHostHealth` (host-env probes —
   winget only while uv is unresolved) over the three `Json*Repository` adapters.
4. **Rust backend** supplies only generic commands already registered —
   `read_text_file` (JSON reads), `write_text_file` (writability probe),
   `list_scheduled_tasks` (COM probe), `find_all_in_path_command` (winget scan),
   `get_app_data_dir` + `get_disk_free_space` (disk probe).

The entire Home load path is implemented on the frontend. Persistence re-uses
`JsonScriptRepository`, `JsonTaskRepository`, and `JsonTaskRunRepository` over
`TauriFileStorage`, and the Host Health card composes the generic COM/PATH/disk
commands — no dedicated load-home command is registered.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── App.vue                              ← Step 1: views computed + <component :is> mount
├── views/
│   └── HomeView.vue                     ← Step 1-2: onMounted + loadStats + render regions
├── composables/
│   ├── useAppContext.ts                 ← DI: wires hostHealth + repos + runtimeCheckResult
│   └── useNavigation.ts                 ← activeView default 'home'; setView()
├── services/
│   ├── home/
│   │   ├── hostHealth.ts                ← Step 4: host-env probes (COM/winget/writable/disk/python; winget only while uv unresolved)
│   │   └── dashboardStats.ts            ← Step 3: pure stats aggregation
│   ├── script/JsonScriptRepository.ts   ← scripts.json adapter (list)
│   ├── task/JsonTaskRepository.ts       ← tasks.json adapter (list)
│   ├── task/JsonTaskRunRepository.ts    ← task-runs.json adapter (list, 200 cap)
│   └── shared/
│       ├── FileStorage.ts               ← port (interface)
│       └── TauriFileStorage.ts          ← invoke read/write adapter
└── models/
    ├── Script.ts / Task.ts / TaskRun.ts ← data models
```

**Present and wired:**

| File | Role |
|------|------|
| `src/App.vue` | `views` computed (36-51); mounts active view (`:108`) |
| `src/views/HomeView.vue` | `onMounted` + `loadStats()` + dashboard/Host Health/recent-executions render |
| `src/composables/useAppContext.ts` | DI: `hostHealth` (`:69`) + repositories + `runtimeCheckResult` ref (`:73-75`) |
| `src/composables/useNavigation.ts` | `activeView` defaults to `'home'` (`:9`); `setView` swaps views |
| `src/services/home/hostHealth.ts` | `checkHostHealth` — host-env probes (winget only while uv unresolved) |
| `src/services/home/dashboardStats.ts` | `computeDashboardStats` — pure metric aggregation |
| `src/services/script/JsonScriptRepository.ts` / `task/JsonTaskRepository.ts` / `task/JsonTaskRunRepository.ts` | `list()` adapters over `read_text_file` |
| `src/services/shared/TauriFileStorage.ts` | `read_text_file` → `null` when file absent |

---

### Rust Backend

```
src-tauri/
└── src/
    ├── lib.rs                           ← registers generic I/O + Task Scheduler COM commands
    └── systeminfo.rs                    ← run_process / PATH scan / disk free space
```

**Relevant existing commands (already registered in `invoke_handler`, `src-tauri/src/lib.rs:453-485`):**

- `read_text_file` — `TauriFileStorage.read()` for scripts.json, tasks.json, task-runs.json
- `write_text_file` — `checkAppDataWritable` probe marker write/cleanup
- `list_scheduled_tasks` — `checkTaskScheduler` COM probe (`hostHealth.ts:59`)
- `find_all_in_path_command` — `checkWinget` PATH scan (`hostHealth.ts:76`)
- `get_app_data_dir` — `checkDiskFreeSpace` drive source (`hostHealth.ts:147`)
- `get_disk_free_space` — `checkDiskFreeSpace` (`hostHealth.ts:148`)

No load-specific command exists; the page composes these generic commands.

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts`:

```ts
// src/composables/useAppContext.ts:69, 73-75
hostHealth: overrides.hostHealth ?? tauriHostHealthService,
runtimeCheckResult: isRef(overrides.runtimeCheckResult)
  ? overrides.runtimeCheckResult
  : ref(overrides.runtimeCheckResult ?? null),
```

`HomeView.vue` consumes them in `setup` (`src/views/HomeView.vue:18-26`):

```ts
const {
  scriptRepository,
  taskRepository,
  taskRunRepository,
  hostHealth,
  runtimeRequirement,
  runtimeCheckResult,
  logger,
} = useAppContext();
```

Tests supply fakes at the same boundary — `HomeView.test.ts` overrides the
repositories, `hostHealth.check`, `runtimeRequirement`, and
`runtimeCheckResult` through `createAppContext(overrides)` (`mountHome`,
`HomeView.test.ts:74-85`).

---

## Execution Flow

### Step 1 — Mount & Kick-off

**Location:** `src/App.vue:36-51` (views computed), `:108` (mount), `src/views/HomeView.vue:110-112` (onMounted)

```ts
// src/App.vue:36-51
const views = computed(() => {
  switch (activeView.value) {
    case 'home':
      return HomeView;
    case 'scripts-list':
      return ScriptsListView;
    case 'task':
      return TaskView;
    case 'logging':
      return LoggingView;
    case 'setting':
      return SettingView;
    default:
      return HomeView;
  }
});
```

```html
<!-- src/App.vue:108 -->
<component :is="views" :on-navigate="setView" />
```

```ts
// src/views/HomeView.vue:110-112
onMounted(() => {
  loadStats();
});
```

**Behaviour:**

1. `useNavigation` starts with `activeView = ref('home')` (`useNavigation.ts:9`), so the app lands on Home at boot; sidebar clicks call `setView` which flips `activeView` and re-resolves the `views` computed.
2. `App.vue` renders the active view with `<component :is="views" :on-navigate="setView" />` — HomeView receives `onNavigate` so its stat cards can jump to other pages.
3. `HomeView` `onMounted` fires `loadStats()` without awaiting — the view paints immediately with zeroed stats, a "Checking..." Host line, and the "No executions yet." empty table while data loads.

**Flow chain:**
Sidebar click / boot → `setView('home')` → `views` computed → `<component :is="HomeView">` → `onMounted` → `loadStats()`

---

### Step 2 — Parallel Stats Loader

**Location:** `src/views/HomeView.vue:56-70`

```ts
async function loadStats() {
  const [scripts, loadedTasks, runs, health]: [Script[], Task[], TaskRun[], HostHealthResult | null] = await Promise.all([
    scriptRepository.list().catch(() => [] as Script[]),
    taskRepository.list().catch(() => [] as Task[]),
    taskRunRepository.list().catch(() => [] as TaskRun[]),
    hostHealth.check(runtimeResult.value).catch(() => null),
  ]);
  tasks.value = loadedTasks;
  recentRuns.value = [...runs]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 5);
  stats.value = computeDashboardStats(scripts, loadedTasks, runs);
  hostHealthResult.value = health;
  loaded.value = true;
}
```

**Behaviour:**

1. Four sources read **in parallel** via `Promise.all`: scripts, tasks, runs, and the Host Health check.
2. Every read is defensively caught — a repository failure yields `[]`, a health-check failure yields `null`, so the view still renders.
3. `recentRuns` is the 5 newest runs by `startedAt` (newest-first sort, then `.slice(0, 5)`).
4. `computeDashboardStats` (Step 3) produces the aggregate card metrics.
5. The Host Health check (Step 4) receives the cached `runtimeResult` so the Python probe reflects the startup check without re-probing.

**Flow chain:**
`loadStats()` → `Promise.all` (scripts + tasks + runs + host health)

---

### Step 3 — Dashboard Stats Aggregation

**Location:** `src/services/home/dashboardStats.ts:39-105`

```ts
const usedScriptIds = new Set(tasks.map(task => task.scriptId))
const usedScripts = scripts.filter(s => usedScriptIds.has(s.id)).length
const successRuns = runs.filter(run => run.status === 'success').length
const failedRuns = runs.filter(run => run.status === 'failed').length
const totalRuns = successRuns + failedRuns
const successRate = totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 0

// Next scheduled run
const enabled = tasks.filter(t => t.enabled && t.nextRunAt)
const sorted = [...enabled].sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
const next = sorted[0] ?? null

// Last run
const lastRun = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null
```

**Behaviour:**

1. **Used/unused scripts** — a `usedScriptIds` set collects every `task.scriptId`; `usedScripts` counts scripts referenced by at least one task, `unusedScripts` is the remainder (`dashboardStats.ts:44-45, 89`).
2. **Success rate** — `successRuns`/`failedRuns`/`totalRuns` from run status; `running` runs are excluded. Rate rounds to a whole percent and is `0` when there are no completed runs (`:46-49`).
3. **Next Run** — the soonest `nextRunAt` among `enabled` tasks that have one; drives the header "Next:" line and the `stat-next-run` card (`:52-54, 96-97`).
4. **Runs Today** — runs whose `startedAt` is >= local midnight (`:61-63`).
5. **Schedule summary** — tasks grouped by `schedule.type`, sorted by count desc (e.g. `"4 daily · 2 weekly"`); **Python summary** — scripts grouped by `pythonVersion` (default `3.11`), e.g. `"3.11: 5 · 3.12: 2"` (`:66-84`). Both render as `stat-desc` captions.

The function is pure (no I/O) — that is what makes `dashboardStats.test.ts` unit-testable.

**Flow chain:**
`computeDashboardStats(scripts, tasks, runs)` → `stats` ref → stat cards + header lines

---

### Step 4 — Host Health Checks

**Location:** `src/services/home/hostHealth.ts:37-62`

```ts
export async function checkHostHealth(runtimeResult?: RequirementCheckResult | null): Promise<HostHealthResult> {
  const items: HostHealthItem[] = []

  // 1. Task Scheduler
  await checkTaskScheduler(items)
  // 2. Winget availability — only matters while uv still needs bootstrapping.
  if (!runtimeResult || runtimeResult.status !== 'met') {
    await checkWinget(items)
  }
  // 3. App data dir writable
  await checkAppDataWritable(items)
  // 4. Disk free space
  await checkDiskFreeSpace(items)
  // 5. Python runtime
  checkPythonRuntime(items, runtimeResult)

  const failing = items.filter(i => !i.ok).length
  const warnings = items.filter(i => i.ok && i.detail.includes('Warning')).length
  const status: HostHealthResult['status'] =
    failing > 0 ? 'failing' : warnings > 0 ? 'warning' : 'ok'

  return { items, status }
}
```

**Behaviour:**

1. **Task Scheduler** (`:65-80`) — invokes `list_scheduled_tasks`; an error means the COM Schedule service is down/permission-blocked → `ok: false`.
2. **Winget** (`:84-109`) — `find_all_in_path_command { name: 'winget' }` PATH scan, **only while uv is unresolved** (`checkHostHealth` gates it on `status !== 'met'`). This probe never fails the card: both "not found" and "could not check" keep `ok: true` and only note that the uv bootstrap will use the zip-download fallback. Once uv is met, the item is omitted entirely.
3. **App Data Dir** (`:112-141`) — writes `_hermes_health_marker` via `write_text_file`, reads it back, then overwrites to clean up; failure → `ok: false` ("all persistence operations will fail").
4. **Disk Space** (`:144-184`) — `get_app_data_dir` (Rust) resolves the app data dir, then `get_disk_free_space` queries the drive that holds it (where persistence + venvs live). `< 100 MB` failing, `< 500 MB` warning, else `x.x GB free`. This deliberately avoids `process.env` — it is **not** available in the Tauri webview, so the old code always fell back to "Could not query".
5. **uv / Python manager** (`:188-224`) — reads the **cached** startup `runtimeResult`. The item is labelled "uv (Python manager)" because the app delegates Python to uv; when met the detail explains "uv found — Python resolves per-venv when tasks run" plus the resolved uv path, rather than reporting a raw binary path under a "Python Runtime" heading. `notMet`/`deferred` become a `Warning` detail, `failed` → `ok: false`. This is why `loadStats` passes `runtimeResult.value` in.

Each item carries a stable `key` (`task-scheduler`, `winget`, `app-data-dir`, `disk-space`, `python-runtime`) that drives the `health-*` test ids (`HomeView.vue:218`) — independent of the user-facing label.

The card aggregates into one status badge — `All ok` / `Warnings` / `Failing` — and lists each probe with ✓/✗ (`HomeView.vue:205-233`).

**Flow chain:**
`hostHealth.check(runtimeResult)` → probes over the generic commands (COM-backed `list_scheduled_tasks`; PATH-scan `find_all_in_path_command` when uv unresolved; writability `write_text_file`/`read_text_file`; `get_app_data_dir` + `get_disk_free_space`; cached runtime result) → `{ items, status }` → `hostHealthResult` ref → Host Health card

---

### Step 5 — Recent Executions & Empty States

**Location:** `src/views/HomeView.vue:235-257`

```html
<section class="mt-6" data-testid="recent-executions">
  <h2 class="mb-3 text-lg font-semibold">Recent Executions</h2>
  <div v-if="recentRuns.length === 0" class="alert alert-info" data-testid="recent-executions-empty" role="alert">
    <span>No executions yet.</span>
  </div>
  <table v-else class="table table-zebra w-full" data-testid="recent-executions-table">
    <!-- rows: Task (taskName(run.taskId)), Status badge, Started, Finished, Exit Code -->
  </table>
</section>
<p v-if="loaded && stats.totalScripts === 0 && stats.totalTasks === 0" class="text-gray-500 mt-4">
  No scripts or tasks yet. Add a script from the Scripts List page to get started.
</p>
```

**Behaviour:**

1. `recentRuns` (5 newest, Step 2) renders as a zebra table; `taskName(run.taskId)` (`:93-95`) resolves the run's task name, falling back to the raw id.
2. Empty history shows the `recent-executions-empty` alert — "No executions yet." — because `task-runs.json` is absent on a fresh start (see Step 6).
3. The first-run hint (`:255-257`) renders only when `loaded && totalScripts === 0 && totalTasks === 0`.
4. The three stat cards are `<button>`s whose `@click` calls `onNavigate` — `stat-scripts` → Scripts List, `stat-tasks`/`stat-next-run` → Task, `stat-runs`/`stat-runs-today` → Logging.

**Flow chain:**
`recentRuns` ref → `recent-executions-table` / `recent-executions-empty` · `stats` ref → `stat-*` buttons → `onNavigate` → `setView`

---

### Step 6 — Persistence Layer & Rust Primitives

**Location:** `src/services/script/JsonScriptRepository.ts`, `src/services/task/JsonTaskRepository.ts`, `src/services/task/JsonTaskRunRepository.ts`, `src/services/shared/TauriFileStorage.ts`

```ts
// TauriFileStorage (src/services/shared/TauriFileStorage.ts:5-7)
read(path: string): Promise<string | null> {
  return invoke<string | null>('read_text_file', { path })
}
```

```ts
// JsonTaskRunRepository.list()
async list(): Promise<TaskRun[]> {
  const content = await this.fileStorage.read(this.runsFilePath)
  if (content === null) return []
  // ... runsFromJson parse (parse errors → [])
}
```

**Behaviour:**

1. Each repository reads through `FileStorage.read()` → `invoke('read_text_file')`.
2. `null` content (JSON file not created yet, `read_text_file` returns `Ok(None)` on NotFound) → `[]`. This powers the Home empty states — zeroed stats, "No executions yet.", and the first-run hint — with **no dedicated bootstrap path**.
3. The Host Health probes map to the generic commands verified in `invoke_handler` (`src-tauri/src/lib.rs:458-491`): `read_text_file`, `write_text_file`, `list_scheduled_tasks` (`:470`), `find_all_in_path_command` (`:484`), `get_app_data_dir` (`:473`), `get_disk_free_space` (`:490`). No Home-load command exists.

```
HomeView (onMounted)
  └─ loadStats()
      ├─ scriptRepository.list()     → JsonScriptRepository  → read_text_file (scripts.json)
      ├─ taskRepository.list()       → JsonTaskRepository    → read_text_file (tasks.json)
      ├─ taskRunRepository.list()    → JsonTaskRunRepository → read_text_file (task-runs.json)
      └─ hostHealth.check(runtime)   → checkHostHealth
          ├─ list_scheduled_tasks        (COM probe)
          ├─ find_all_in_path_command    (winget scan)
          ├─ write_text_file / read_text_file (writability marker)
          ├─ get_app_data_dir → get_disk_free_space (disk probe)
          └─ cached runtimeCheckResult   (Python probe)
```

---

## Summary

| Aspect                    | Status                                      |
|---------------------------|---------------------------------------------|
| View mount + kick-off     | ✅ Implemented (`App.vue:36-51`, `HomeView.vue:110`) |
| Parallel stats loader     | ✅ Implemented (`HomeView.vue:56-70`)         |
| Dashboard aggregation     | ✅ Implemented (`dashboardStats.ts:39`)       |
| Host Health probes        | ✅ Implemented (`hostHealth.ts:37`)           |
| Recent executions (top 5) | ✅ Implemented (`HomeView.vue:235`)           |
| Stat-card navigation      | ✅ Implemented (`onNavigate` → `setView`)     |
| Persistence (null → [])   | ✅ Implemented (`Json*Repository` over `TauriFileStorage`) |
| Empty states              | ✅ Implemented ("No executions yet.", first-run hint) |
| Unit tests                | ✅ Implemented (`HomeView.test.ts`, `dashboardStats.test.ts`) |

**Conclusion:** The "Load Home page" workflow is complete on the frontend. The
page composes the existing generic commands — `read_text_file`, `write_text_file`,
`list_scheduled_tasks`, `find_all_in_path_command`, `get_app_data_dir`,
`get_disk_free_space` —
through the three JSON repositories and the `hostHealth`/`dashboardStats`
services, so no dedicated Rust command is required. All loads are defensive
(empty list / `null` on failure) and the JSON-absent → `[]` semantics power the
first-run empty states.

**Optional future work (not required for correctness):**

- The Host Health check runs on every Home mount (one `list_scheduled_tasks`
  COM probe plus up to five invoke round-trips — winget scan only while uv is
  unresolved; marker write/read; `get_app_data_dir` + `get_disk_free_space`).
  It could be cached like the runtime check, or refreshed on a timer, if the
  probe cost ever matters.
- `loadStats` awaits all four sources before painting real data; the stat cards
  stay zeroed until the slowest read finishes. Rendering per-source as each
  resolves would feel snappier on a slow disk.
- The first-run hint links nowhere yet; wiring it to `onNavigate('scripts-list')`
  would complete the onboarding path.

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Home--Fresh-Start-App-Workflow.md` — Boot/first-run path: startup runtime check + Resolve bootstrap + empty-state semantics
- `docs/Task--Load-Task-Page-Workflow.md` — The parallel-mount pattern used by the Task page (same repositories)
- `docs/Scripts--Refresh-Button-Workflow.md` — Scripts-page load (same `read_text_file`/`path_exists` pattern)
