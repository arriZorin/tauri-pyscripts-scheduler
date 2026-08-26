# Integration Testing Guide — tauri-pyscripts-scheduler

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-22
**Scope:** What integration testing means for this Tauri v2 + Vue 3 + Bun + Rust app,
what the current suite covers, the seams it is blind to, and a 4-level ladder of
integration tests with concrete implementation guidance.

---

## 1. Why this document exists

The repo's unit + component test suites (261 bun tests, 92 cargo tests) verify that
each layer is *internally* correct, but they replace every cross-layer boundary with
a fake. This guide maps exactly what those fakes hide, and lays out, cheapest-first,
how to actually test across the boundaries.

Key file references used throughout (verified 2026-08-22):

| File | Relevance |
|------|-----------|
| `src-tauri/src/lib.rs` | `generate_handler![...]` at `:429`, `delete_scheduled_task` fn at `:262` / registered at `:437` |
| `src/services/task/TaskScheduler.ts` | `invoke('delete_scheduled_task', …)` at `:50` — 5 invoke call sites in this file |
| `src/services/shared/TauriFileStorage.ts` | `invoke('read_text_file')` / `invoke('write_text_file')` — the whole file |
| `src/composables/useAppContext.ts` | The DI composition root — `overrides.X ?? new RealX()` at `:52-75` |
| `src/views/ScriptsListView.test.ts` | 17 component tests, all fake-injected via `createAppContext` |
| `src/views/TaskView.test.ts` | Component tests incl. delete flow (`:412`, `:528`) |
| `package.json` | `"test": "vitest run"`, no e2e deps (no wdio / playwright / tauri-driver) |
| `src-tauri/Cargo.toml` | Rust deps; no dev-test harness beyond `cargo test` in-module `#[cfg(test)]` |

---

## 2. Current testing inventory (what exists today)

### 2.1 Frontend — `bun run test` (vitest, 261 tests)

- **Component tests** (`src/views/*.test.ts`): mount the real Vue component via
  `createApp(...)` + `createAppContext({ …fakes })`, click real DOM elements, assert
  on rendered DOM and fake-internal state.
- **Service/unit tests** (`src/services/**/*.test.ts`): test the TS services against
  fake `FileStorage` / mocked `invoke` implementations.
- **Harness pattern** (`ScriptsListView.test.ts:105`): `mountView()` builds a real
  component, injects `FakeScriptRepository` / `FakeScriptPicker` / `FakeFileScanner`
  / `FakeTaskScheduler` / `FakeVenvSync`, mounts into a real `<div>`.

### 2.2 Rust — `cargo test` (92 tests)

- In-module `#[cfg(test)]` tests inside `src-tauri/src/lib.rs` and `windows_scheduler.rs`.
- Cover Rust-side logic: file-path validation, venv commands, command-building,
  scheduler helper logic.
- Run against the real Rust code — **but not** through the Tauri IPC bridge and
  **not** against the real OS Task Scheduler COM.

### 2.3 Type-check + build

- `vue-tsc --noEmit` + `vite build` (wired in `package.json` `"build"`).
- Catches TS contract drift *within* the type system (the interfaces), but is blind
  to runtime string contracts (command names, IPC payload shapes).

### 2.4 What is NOT tested anywhere today

- The **IPC string contract**: every `invoke('cmd', …)` call site vs the Rust
  `generate_handler![...]` registration list.
- Real **JSON-on-disk** round-trips (serialize/parse through real file I/O).
- Real **venv** ensure/sync against actual Python.
- Real **COM** Task Scheduler create/list/delete against the OS.
- A true **end-to-end** path (frontend → IPC → Rust → COM → filesystem in one run).

---

## 3. The integration seams — what the fakes hide

| # | Seam | Fake that hides it | Failure invisible to the current suite |
|---|------|--------------------|----------------------------------------|
| S1 | IPC contract (`invoke('cmd')` ↔ `generate_handler![...]`) | fakes never call `invoke` | a renamed/missing Rust command: all tests green, app crashes on first click |
| S2 | JSON file round-trip (write → read → parse) | `FakeScriptRepository` / fake `FileStorage` | corrupt JSON, BOM, unicode paths, `MAX_RUNS=200` cap against real writes |
| S3 | Real OS backend (venv + COM) | `FakeVenvSync`, `FakeTaskScheduler`, `FakeTaskRepository` | venv creation failing, COM registration not actually appearing |
| S4 | Full stack in one click | everything above | wiring error anywhere between DOM and OS |

Note the asymmetry: the current suite proves "the frontend is correct *given* the
contract." It does not prove "the contract is correct against the real backend."

---

## 4. The 4-level integration ladder (cheapest → heaviest)

### Level 1 — IPC contract test (TS ↔ Rust command-name agreement)

**Covers:** seam S1. The single most dangerous silent breaker.

**What it does:** a plain vitest test (no mocks) that reads BOTH sides and asserts
agreement:

1. Scan `src/services/**/*.ts` for every `invoke('command', …)` string.
2. Parse the command names out of `tauri::generate_handler![...]` in
   `src-tauri/src/lib.rs:508` (a small regex over the file text).
3. Assert: every TS-invoked command is registered in the handler; optionally every
   registered command is used somewhere.

**Cost:** ~15 lines + one helper, runs inside the existing vitest suite. Zero new
dependencies. Red-green friendly: if any invoke string is unregistered today, the
test fails immediately — the exact red you want.

**Caveat:** validates names, not payload shapes or return types. Payload-shape drift
is still caught only by type-checking the shared boundary or by Level 4.

---

### Level 2 — Repository integration against real disk

**Covers:** seam S2 (partially — the TS side of the boundary).

**What it does:** test `JsonTaskRepository`, `JsonScriptRepository`,
`JsonTaskRunRepository` against REAL temp files using a `NodeFileStorage` that
implements the same `FileStorage` port (`src/services/shared/FileStorage.ts`) with
`node:fs` instead of `invoke`:

```ts
// tests/integration/nodeFileStorage.ts (sketch)
import { readFile, writeFile } from 'node:fs/promises'

export class NodeFileStorage implements FileStorage {
  constructor(private readonly dir: string) {}
  async read(path: string) {
    try { return await readFile(`${this.dir}/${path}`, 'utf-8') }
    catch { return null } // mirrors read_text_file Ok(None) on NotFound
  }
  async write(path: string, content: string) {
    await writeFile(`${this.dir}/${path}`, content, 'utf-8')
  }
}
```

Then the repository is constructed exactly as in production
(`new JsonTaskRepository(storage, 'tasks.json', scriptRepository)`) but backed by a
real temp directory. Cases a fake can't show you: missing file → `[]`, corrupt JSON
→ error surfaced, the 200-run cap truncating real writes, unicode paths.

**Where:** a `tests/integration/` folder with its own vitest config, or
`*.integration.test.ts` files co-located. **Cost:** low; one storage adapter reused
across all repository tests.

---

### Level 3 — Rust integration tests against the real OS (highest value here)

**Covers:** seams S2 (Rust half) + S3.

**What it does:** add a `src-tauri/tests/` directory of Rust integration tests run by
`cargo test`. Gate COM tests with `#[cfg(windows)]` so the suite stays green on
non-Windows CI.

Targets, in increasing risk:

1. **File I/O:** call `read_app_file` / `write_app_file` / `path_exists` against a
   real temp dir (these are private — expose a `#[cfg(test)]`-visible path or test
   via the command layer).
2. **Venv:** `ensure_script_venv` + `sync_script_deps` + `get_venv_python_path`
   against real Python in a temp folder.
3. **Scheduler round-trip:** `windows_scheduler::create_task` →
   `list_scheduled_tasks` → `get_scheduled_task_status` → `delete_task`, using a
   uniquely-named task under `PyscriptScheduler\`, with a `finally`/drop guard so a
   failed assertion cannot leak a scheduled task on the machine.

This is where the app's real risk lives (venv + COM), and the Rust layer is the
thinnest, most stable part — so these tests are cheap to write and rarely flaky.

**Caveat:** Level 3 does not cross the IPC bridge — it calls the Rust functions
directly. The `delete_scheduled_task` command at `lib.rs:317` is a thin wrapper over
`windows_scheduler::delete_task` (`windows_scheduler.rs:887`), so testing the
function covers ~all of the command's logic.

---

### Level 4 — True E2E: tauri-driver + WebdriverIO (full stack)

**Covers:** all seams S1–S4 in one run.

**What it does:** the official Tauri testing path (`tauri.app/develop/advanced/testing`):
add `tauri-driver`, `@wdio/cli`, and a `wdio.conf.ts` with `tauriOptions`, then drive
the real WebView2 webview. Example assertion for the delete flow:

- click `[data-testid="delete-task-<id>"]`
- click `[data-testid="confirm-task-delete-btn"]`
- assert the row is gone from the DOM **and** `schtasks /query /tn "PyscriptScheduler\<id>"`
  reports the task no longer exists.

This is the only option that proves the whole chain in one run — and it is exactly
the automation of the manual e2e loop you have been doing by hand (Add File →
hello_world.py → task run).

**Costs / risks:**
- Heavier setup: msedgedriver for WebView2 on Windows, `tauri-driver` binary,
  wdio config.
- Slow boot per test; the flakiest tier (timing, webview focus, real OS state).
- Needs real Python + venv tooling present in the test environment.
- A small smoke set (add script → run task → delete task) beats a sprawling suite.

---

## 5. Recommendation for this repo

Do not start at Level 4. The repo is already well covered at unit/component level;
the gaps are narrow and specific. Pragmatic order:

1. **Level 1 (IPC contract test)** — ~20 minutes, kills the most dangerous silent
   failure, no new deps. Do this first.
2. **Level 3 (Rust: venv + COM round-trip)** — the backend is the untested half of
   the app; cover it on the real OS where it actually runs.
3. **Level 2 (real-disk repositories)** — natural follow-up whenever a repository is
   next touched.
4. **Level 4 (tauri-driver E2E)** — only when the manual e2e loop needs automating;
   keep it to a smoke set.

Each level is independent — you can ship 1 and 3 without committing to 4.

---

## 6. Connection to this repo's DI design

The reason Levels 1–3 are cheap is the same DI discipline that makes the unit suite
possible (`src/composables/useAppContext.ts`):

- The `FileStorage` / `TaskRepository` / `TaskScheduler` / `ScriptRepository`
  interfaces are narrow ports.
- Production wires real implementations at one composition root
  (`createAppContext` defaults, `useAppContext.ts:52-75`).
- Tests inject fakes at the *same* boundary.

So the integration tests don't fight the architecture — they slot in at the same
boundaries:

- Level 1: inspect the same `invoke` strings the fakes bypass.
- Level 2: implement the same `FileStorage` port with `node:fs`.
- Level 3: call the same Rust functions the `invoke` handlers wrap.
- Level 4: exercise the real composition root end-to-end.

---

## 7. Test counts referenced

| Suite | Command | Count | Covers |
|-------|---------|-------|--------|
| Frontend (component + unit) | `bun run test` | 261 | Views, services, composables vs fakes |
| Rust (in-module) | `cargo test` | 92 | Rust logic: file I/O validation, venv, scheduler helpers |
| Type-check + build | `bun run build` | — | `vue-tsc` + `vite build` |
| Example component suite | `ScriptsListView.test.ts` | 17 `it()` | Header/footer, empty state, add file/folder, refresh, edit/delete, missing-path, repair |
| IPC call sites (TS) | — | ~13 | `invoke(...)` strings across `src/services/` |
| E2E tooling | — | 0 | No tauri-driver / wdio / playwright in `package.json` or `Cargo.toml` |

---

## Appendix: Related Documentation

- `docs/Task--Delete-Button-Workflow.md` — the delete flow end-to-end (the reference flow for a Level 4 smoke test)
- `docs/Task--Load-Task-Page-Workflow.md` — `load()` / `loadReconcile()` orchestration
- `docs/Home--Fresh-Start-App-Workflow.md` — boot / uv bootstrap (venv Level 3 target)
- `docs/Scripts--Refresh-Button-Workflow.md` — a simple reload flow
- `src/composables/useAppContext.ts` — the DI composition root every test overrides
- `architecture.md`, `README.md` — system architecture and setup
