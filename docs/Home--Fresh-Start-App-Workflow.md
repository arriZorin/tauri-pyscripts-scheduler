# Fresh-Start-App Workflow

**Project:** `tauri-pyscripts-scheduler`  
**Date:** 2026-08-24  
**Status:** ✅ Implemented — frontend boot orchestration over existing Rust commands (no dedicated fresh-start command required)

---

## Overview

When the app launches on a machine with no prior state (or with an empty data directory), the following occurs:

1. **Vue entry** (`src/main.ts`) mounts `App.vue`, which builds the app context (DI wiring) and the sidebar shell.
2. **App.vue boot** (`onMounted`) records an `app startup` log entry, then runs the **one-shot runtime check**: locate `uv` (managed install dir first, then PATH), cache the `RequirementCheckResult` in a reactive ref shared by all views.
3. **Rust setup** creates the app-local data directory (`%LOCALAPPDATA%\com.pyscriptscheduler.app`) and manages it as Tauri state; the `logs\` subdirectory is created lazily by `get_log_directory`.
4. **Home view** (`HomeView.vue`) loads stats in parallel (scripts, tasks, runs, host health), computes the dashboard, and shows the runtime requirement panel — with a **Resolve** button that bootstraps uv **winget-first** (silent `astral-sh.uv` install), falling back to a pinned portable zip download when winget fails or uv cannot be located, when the check is `notMet`.
5. **Empty state** — missing JSON files (`scripts.json`, `tasks.json`, `task-runs.json`, `logs.json`) read as `null` → every repository returns `[]`, so each view shows its first-run empty state ("No scripts yet.", "No tasks yet.", "No runs yet.", "No executions yet.").

The entire fresh-start path is frontend orchestration over the existing generic Rust commands (file I/O, PATH scan, registry query, download/extract, process runner). No dedicated fresh-start command was required.

---

## File Structure

### Frontend (TypeScript / Vue)

```
src/
├── main.ts                              ← Step 1: createApp(App).mount('#app')
├── App.vue                              ← Step 2: context + shell + one-shot runtime check
├── views/
│   ├── HomeView.vue                     ← Step 4: dashboard + runtime panel + Resolve
│   ├── ScriptsListView.vue              ← empty state ("No scripts yet.")
│   ├── TaskView.vue                     ← empty state ("No tasks yet.")
│   └── LoggingView.vue                  ← empty run/log states
├── composables/
│   ├── useAppContext.ts                 ← DI wiring (repos, runtimeRequirement, runtimeCheckResult)
│   └── useNavigation.ts                 ← sidebar nav items, activeView defaults to 'home'
├── services/
│   ├── runtimeCheck/
│   │   ├── createRuntimeRequirement.ts  ← composes the uv requirement with Tauri adapters
│   │   ├── pythonRuntimeCheck.ts        ← check()/resolve() logic (uv-only)
│   │   ├── uvBootstrapper.ts            ← winget-first bootstrap + pinned zip fallback
│   │   ├── environmentQuery.ts          ← PATH scan / registry / install-dir adapters
│   │   ├── processRunner.ts             ← run_process adapter
│   │   ├── fileDownloader.ts            ← download/extract/delete adapters
│   │   ├── versionRequirement.ts        ← version constraint parsing (unused at boot)
│   │   └── types.ts                     ← RequirementCheckResult / RuntimeRequirement
│   ├── home/
│   │   ├── hostHealth.ts                ← host-env probes (COM/winget/writable/disk/python; winget only while uv unresolved)
│   │   └── dashboardStats.ts            ← pure stats aggregation
│   ├── script/JsonScriptRepository.ts   ← reads scripts.json (missing → [])
│   ├── task/JsonTaskRepository.ts       ← reads tasks.json (missing → [])
│   ├── task/JsonTaskRunRepository.ts    ← reads task-runs.json (missing → [])
│   └── shared/TauriFileStorage.ts       ← invoke read_text_file / write_text_file
└── models/
    ├── Script.ts / Task.ts / TaskRun.ts / LogEntry.ts
```

**Present and wired:**

| File | Role |
|------|------|
| `src/main.ts` | Vue bootstrap |
| `src/App.vue` | Context creation, sidebar shell, startup log + runtime check |
| `src/composables/useAppContext.ts` | Production DI wiring + `runtimeCheckResult` ref |
| `src/composables/useNavigation.ts` | Nav items; default view `home` |
| `src/views/HomeView.vue` | Dashboard stats, Host Health, runtime panel, Resolve button |
| `src/services/runtimeCheck/pythonRuntimeCheck.ts` | uv locate → `met` / `notMet`; `resolve()` bootstraps |
| `src/services/runtimeCheck/uvBootstrapper.ts` | winget-first uv bootstrap (pinned zip fallback) |
| `src/services/runtimeCheck/environmentQuery.ts` / `processRunner.ts` / `fileDownloader.ts` | Tauri invoke adapters |
| `src/services/home/hostHealth.ts` / `dashboardStats.ts` | Host-health probes + stats |
| `src/services/shared/TauriFileStorage.ts` | `read_text_file` → `null` when file absent |

---

### Rust Backend

```
src-tauri/
└── src/
    ├── lib.rs                           ← setup: app data dir + AppDataDir state; command registration
    └── systeminfo.rs                    ← run_process / PATH scan / registry / download / extract
```

**Relevant commands (registered in `invoke_handler`, `src-tauri/src/lib.rs:429`):**

- `path_exists` — used by `fileExists` (`environmentQuery.ts:33`)
- `find_all_in_path_command` — PATH scan for `uv.exe` (`systeminfo.rs:219`)
- `query_python_registry` — HKCU/HKLM `PythonCore` InstallPath (`systeminfo.rs:232`)
- `default_uv_install_dir` — `%LOCALAPPDATA%\Programs\uv` (`systeminfo.rs:237`)
- `run_process` — spawn + capture + timeout kill (`systeminfo.rs:208`)
- `download_to_file` / `extract_zip` / `delete_file` — uv bootstrap I/O (`systeminfo.rs:244`, `:251`, `:258`)
- `get_app_mode` — `dev`/`prod` (`lib.rs:28`)

---

## Dependency Wiring

Production implementations are built once in `src/composables/useAppContext.ts:50`:

```ts
export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const storage = new TauriFileStorage()
  const scriptRepository = overrides.scriptRepository ?? new JsonScriptRepository(storage, 'scripts.json')
  const taskRepository = overrides.taskRepository ?? new JsonTaskRepository(storage, 'tasks.json', scriptRepository)
  const taskRunRepository = overrides.taskRunRepository ?? new JsonTaskRunRepository(storage, 'task-runs.json')
  const logRepository = overrides.logRepository ?? new JsonLogRepository(storage, 'logs.json')
  const logger = overrides.logger ?? new AppLogger(logRepository)
  // ...
  runtimeRequirement: overrides.runtimeRequirement ?? createRuntimeRequirement(),
  runtimeCheckResult: isRef(overrides.runtimeCheckResult)
    ? overrides.runtimeCheckResult
    : ref(overrides.runtimeCheckResult ?? null),
}
```

`App.vue` creates and provides it before any view mounts (`App.vue:31-32`); views read the cached runtime result from the reactive ref instead of re-probing (`HomeView.vue:53`). Tests supply fakes at the same boundary (`useAppContext` overrides).

---

## Execution Flow

### Step 1 — Vue Bootstrap

**Location:** `src/main.ts:5`

```ts
createApp(App).mount("#app");
```

`App.vue` then builds the DI context and the shell (`App.vue:31-34`):

```ts
const appContext = createAppContext(props);
provideAppContext(appContext);

const { navItems, activeView, setView } = useNavigation();
```

The sidebar (`navItems`, `useNavigation.ts:11-17`) renders **Home / Scripts List / Task / Logging / Setting**; `activeView` defaults to `'home'`, so the fresh start always lands on the Home dashboard.

### Step 1b — Rust Setup (app data dir)

**Location:** `src-tauri/src/lib.rs:460-465`

```rust
.setup(|app| {
    let dir = app.path().app_local_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    app.manage(AppDataDir(dir));
    Ok(())
})
```

The app-local data directory (e.g. `%LOCALAPPDATA%\com.pyscriptscheduler.app`) is created at boot and managed as `AppDataDir` state — the root for all JSON persistence (`scripts.json`, `tasks.json`, `task-runs.json`, `logs.json`) and the `logs\` folder (`log_dir`, `lib.rs:39-43`).

### Step 2 — Startup Runtime Check (one-shot)

**Location:** `src/App.vue:61-83`

```ts
onMounted(async () => {
  appContext.logger.record('app', 'startup');
  // Run the Python runtime check ONCE at startup. The result is cached in the
  // reactive runtimeCheckResult ref so views read it without re-probing.
  try {
    const result = await appContext.runtimeRequirement.check();
    appContext.runtimeCheckResult.value = result;
    if (result.status === 'met' && result.resolvedPath) {
      await appContext.logger.record('runtime.check', `Python resolved at startup: ${result.resolvedPath} [${result.message}]`, 'info');
    } else {
      await appContext.logger.record('runtime.check', `${result.message}`, 'info');
    }
  } catch (error) {
    appContext.runtimeCheckResult.value = { status: 'failed', requirementName: 'Python runtime', /* ... */ };
    await appContext.logger.record('runtime.check', 'Startup runtime check threw an unexpected error.', 'error');
  }
});
```

**Behaviour:**

1. Record an `app startup` log entry.
2. `runtimeRequirement.check()` — cached: the second call returns the same result (`pythonRuntimeCheck.ts:25-31`).
3. Store the result in the shared reactive `runtimeCheckResult` ref; views (Home, TaskView interpreter pre-fill) read it without re-probing.
4. Log the outcome (`runtime.check`).

### Step 2a — The uv Check Cascade

**Location:** `src/services/runtimeCheck/pythonRuntimeCheck.ts:33-51` (check) and `:75-86` (locate)

```ts
private async performCheck(): Promise<RequirementCheckResult> {
  const uvPath = await this.locateUv()
  if (uvPath !== null) {
    return { status: 'met', requirementName: REQUIREMENT_NAME,
             message: `uv is available at ${uvPath}.`,
             detail: 'Python versions and venvs are managed via uv.',
             resolvedPath: uvPath }
  }
  return { status: 'notMet', requirementName: REQUIREMENT_NAME,
           message: 'uv is not installed.',
           detail: 'Resolve will download uv automatically.',
           resolvedPath: null }
}

private async locateUv(): Promise<string | null> {
  try {
    const managed = joinPath(await this.uvInstallDirValue(), 'uv.exe')
    if (await this.environmentQuery.fileExists(managed)) {
      return managed
    }
    const pathMatches = await this.environmentQuery.findAllInPath('uv')
    return pathMatches[0] ?? null
  } catch {
    return null
  }
}
```

**Behaviour (fresh machine: `notMet`):**

1. Compute the managed install dir: `%LOCALAPPDATA%\Programs\uv` (`default_uv_install_dir`).
2. `fileExists(managed uv.exe)` → false on a fresh machine.
3. `findAllInPath('uv')` — filesystem PATH scan (no `where.exe` console spawn; `systeminfo.rs:1-10` explains the release-build latency lesson).
4. No match → status `notMet`, message "uv is not installed." — surfaced on the Home runtime panel with a **Resolve** button.

The app never probes host Python directly — Python version management is delegated to uv (`pythonRuntimeCheck.ts:7-13`).

### Step 2b — Resolve: uv Bootstrap (winget-first)

**Location:** `src/views/HomeView.vue:72-91` (button) → `src/services/runtimeCheck/uvBootstrapper.ts:39-51`

```ts
async resolveRuntime() {
  runtimeResolving.value = true;
  try {
    const resolved = await runtimeRequirement.resolve();
    runtimeCheckResult.value = resolved;
    await logger?.record('runtime.resolve', /* ... */);
  } catch (error) {
    runtimeCheckResult.value = { status: 'failed', requirementName: 'Python runtime', /* ... */ };
  } finally {
    runtimeResolving.value = false;
  }
}
```

```ts
async bootstrap(installDir: string): Promise<string> {
  const managedUv = joinPath(installDir, 'uv.exe')

  // 1. Idempotent skip: an existing, runnable uv is good enough.
  if (await this.runs(managedUv)) return managedUv

  // 2. Primary: winget (silent, machine-native).
  const wingetPath = await this.tryWinget(installDir)
  if (wingetPath !== null) return wingetPath

  // 3. Fallback ("failed strategy"): pinned portable zip.
  return this.installFromZip(installDir)
}
```

**Behaviour:**

1. **Skip** — if `uv.exe --version` in the managed dir exits 0, return it immediately (re-running resolve after a success is a no-op).
2. **winget** — `winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements --disable-interactivity` (120s timeout). On success, re-locate uv in the managed dir or on PATH (`findAllInPath`), verifying each candidate runs.
3. **Zip fallback** — only when winget failed or uv is not locatable: download the **pinned** portable zip (`UV_VERSION = '0.12.5'`) from the **astral CDN mirror** (`releases.astral.sh/github/uv/...`, `UV_ZIP_URL`) with the github.com versioned URL (`UV_ZIP_URL_FALLBACK`) as backup, extract into `%LOCALAPPDATA%\Programs\uv` (path-traversal-safe extraction, `systeminfo.rs:175-205`).
4. Verify `uv.exe --version` runs with exit code 0.
5. Delete the temp zip; the result becomes `met` with `resolvedPath` = the managed `uv.exe`. If all sources fail, the throw surfaces as status `failed` ("Failed to bootstrap uv.") with the last download error as detail.

**Why winget-first:** github.com `/releases/latest/download/` URLs are non-reproducible and have 404'd on real networks (observed 2026-08-22) while astral's own CDN mirror and winget keep working — so the strategy prefers machine-native winget, then the mirror, and only touches github.com as a last resort. Version pinning makes the fallback reproducible and debuggable.

### Step 3 — Rust SystemInfo Commands (the native primitives)

**Location:** `src-tauri/src/systeminfo.rs`

- `run_process` (`:208`) → `run_process_impl` (`:30`): spawns with `CREATE_NO_WINDOW` (no console flash in the GUI app), drains stdout/stderr on worker threads, kills on timeout (default 5 min).
- `find_all_in_path_command` (`:219`) → `find_all_in_path` (`:96`): pure PATH entry scan for `<entry>\<name>.exe`.
- `query_python_registry` (`:232`) → `query_python_registry_impl` (`:126`): HKCU then HKLM `SOFTWARE\Python\PythonCore\<ver>\InstallPath`, deduped.
- `default_uv_install_dir` (`:237`) → `default_uv_install_dir_impl` (`:116`): `%LOCALAPPDATA%\Programs\uv`.
- `download_to_file` (`:244`): ureq GET with redirects, 120s timeout, streams to disk.
- `extract_zip` (`:251`): zip crate, skips absolute/traversal entries.
- `delete_file` (`:258`).

All are generic primitives — none is specific to fresh start.

### Step 4 — Home Dashboard (fresh start view)

**Location:** `src/views/HomeView.vue:56-70` (load), `:110-112` (mount)

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

onMounted(() => { loadStats(); });
```

**Behaviour:**

1. Parallel repository reads — each hits `read_text_file`; a missing file returns `null`, so each repository yields `[]`.
2. `computeDashboardStats` (`dashboardStats.ts:39`) aggregates totals — all zeros on a fresh start. It tracks `usedScripts`/`unusedScripts` by cross-referencing task `scriptId` values against script `id` values: a `usedScriptIds` set (`dashboardStats.ts:44`) collects every `task.scriptId`, then `usedScripts = scripts.filter(s => usedScriptIds.has(s.id)).length` and `unusedScripts = scripts.length - usedScripts`.
3. `hostHealth.check(runtimeResult.value)` (`hostHealth.ts:37`) probes host preconditions — Task Scheduler COM, winget on PATH (only while uv is unresolved), app-data-dir writability, disk free space (resolved via `get_app_data_dir` + `get_disk_free_space`), and the cached Python runtime (reported as "uv (Python manager)") — aggregated to an `All ok` / `Warnings` / `Failing` card (`HomeView.vue:205-233`). On a fresh machine every probe degrades gracefully (missing winget → zip-fallback note; disk query failure → "Could not query").
4. Runtime panel renders the cached `runtimeCheckResult` — on a fresh machine: badge `Not met`, message "uv is not installed.", **Resolve** button (`HomeView.vue:226-231`).
5. The first-run hint (`HomeView.vue:255-257`):

```html
<p v-if="loaded && stats.totalScripts === 0 && stats.totalTasks === 0" class="text-gray-500 mt-4">
  No scripts or tasks yet. Add a script from the Scripts List page to get started.
</p>
```

### Step 5 — Empty States Across Views

Every primary view degrades gracefully on a fresh start:

| View | Empty state |
|------|-------------|
| Home | Dashboard zeros + "No scripts or tasks yet." hint (`HomeView.vue:255`) |
| Scripts List | "No scripts yet. Add a .py file or folder." (`ScriptsListView.vue:153`) |
| Task | "No tasks yet." (`TaskView.vue:462`) |
| Task run history | "No runs yet." (`TaskView.vue:505`) |
| Home recent executions | "No executions yet." (`HomeView.vue:237`) |

Each view's `onMounted` loads its own data (ScriptsListView `loadAndReconcile` at `:424-426`, TaskView `load()` + `loadRuns()` at `:432-435`), all of which resolve to empty lists when the JSON files do not exist yet. First writes (e.g. Add File → `scripts.json`) create the files on demand through `write_text_file` (`lib.rs:127-150`).

---

## Summary

| Aspect | Status |
|--------|--------|
| Vue bootstrap (`main.ts`) | ✅ Implemented |
| DI context + shell (App.vue) | ✅ Implemented |
| App data dir creation (Rust setup) | ✅ Implemented (`lib.rs:460`) |
| Startup log entry (`app startup`) | ✅ Implemented (`App.vue:62`) |
| One-shot cached runtime check | ✅ Implemented (`pythonRuntimeCheck.ts:25`) |
| uv locate (managed dir → PATH) | ✅ Implemented (`pythonRuntimeCheck.ts:75`) |
| uv bootstrap resolve (winget-first + pinned zip fallback) | ✅ Implemented (`uvBootstrapper.ts:39`) |
| Home dashboard + Host Health + runtime panel | ✅ Implemented (`HomeView.vue:56`) |
| Empty states for all views | ✅ Implemented |
| Unit tests | ✅ Implemented (`pythonRuntimeCheck.test.ts`, `uvBootstrapper.test.ts`, `dashboardStats.test.ts`, `HomeView.test.ts`) |

**Conclusion:** The fresh-start workflow is fully implemented on the frontend: `App.vue` builds the context and performs a single cached uv runtime check while the Rust side guarantees the app data directory exists; the Home dashboard then renders zeroed stats, the Host Health checks, and a resolvable "uv is not installed" panel; every view shows a first-run empty state because missing JSON files read as empty lists. No dedicated Rust command was required — the flow composes the existing generic I/O, PATH-scan, registry, and download/extract commands.

**Optional future work (not required for correctness):**

- Auto-run `resolve()` when the startup check is `notMet` (currently requires the user to click Resolve on Home).
- Show the bootstrapped `uv.exe` path in the Settings page (SettingView is currently a placeholder).
- Add an onboarding call-to-action linking Scripts List from the Home empty hint.

---

## Appendix: Related Documentation

- `architecture.md` — Full system architecture
- `README.md` — Project overview and setup instructions
- `docs/Scripts--Add-File-Button-Workflow.md` — first content creation path after a fresh start
- `docs/Task--New-Task-Button-Workflow.md` — task creation (uses the uv-managed Python runtime resolved at startup)
