# Task DataTable Table Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-27
**Status:** ✅ Implemented — the Task page's two tables (Scheduled Tasks and
Execution History) are now rendered by the reusable `DataTable` component with
search, sort, rows-per-page, and pagination; **no dedicated Rust command
required** (the DataTable makes no `invoke()` calls — it filters/sorts/paginates
the already-loaded `tasks` / `filteredRuns()` arrays entirely in memory, so no
new entries appear in `invoke_handler` at `src-tauri/src/lib.rs`).

## Overview

1. **Vue View** (`src/views/TaskView.vue`) — renders two `<DataTable>` blocks:
   the task table (`TaskView.vue:544-579`) and the execution-history/runs table
   (`TaskView.vue:595-609`), each with a typed column array and named per-column
   slots for the status badge and the action buttons.
2. **Column contract** — `taskColumns: DataTableColumn<Task>[]`
   (`TaskView.vue:481-487`) and `runColumns: DataTableColumn<TaskRun>[]`
   (`TaskView.vue:489-495`), typed against the model so the component stays
   generic while the consumer stays strongly typed.
3. **Generic component** (`src/components/DataTable.vue`) — owns search, sort,
   page-size, and pagination state (documented in `Scripts--DataTable-Table-Workflow.md`).
   Two new backward-compatible props were added for this migration:
   `rowTestid` and `initialSortDir` (see below).

Architectural fact: the whole DataTable path is **frontend-only**. The task
table sorts/paginates the already-loaded `tasks` ref; the runs table sorts and
paginates `filteredRuns()` (the status-filtered, newest-first array the page
already built). Neither re-queries a repository — the same data flow documented
by `Task--Load-Task-Page-Workflow.md` feeds the tables, and the DataTable
transforms are pure client-side.

## New DataTable props (added for this migration)

**Location:** `src/components/DataTable.vue:25,27` (interface) · `:40-41`
(defaults) · `:50` (state) · `:209` (template)

```ts
// interface Props (DataTable.vue:24-27)
  /** data-testid on each <tr>. Defaults to "data-table-row". */
  rowTestid?: (row: any) => string
  /** Initial sort direction. Default 'asc'. */
  initialSortDir?: 'asc' | 'desc'
```

```ts
// withDefaults (DataTable.vue:40-41)
  rowTestid: undefined,
  initialSortDir: 'asc',
```

```ts
// sort state now honours the prop (DataTable.vue:50)
const sortDir = ref<'asc' | 'desc'>(props.initialSortDir)
```

```html
<!-- row <tr> now emits a per-row testid when supplied (DataTable.vue:209) -->
<tr v-for="(row, index) in paged" :key="rowKeyOf(row, index)" :data-testid="rowTestid ? rowTestid(row) : 'data-table-row'">
```

Both props default backward-compatibly (`data-table-row` / `asc`), so the
existing Scripts page and all prior DataTable tests are unaffected. The column
`sortValue` accessor type was widened to `string | number | null`
(`DataTableColumn.ts:19`) so a nullable sort key — e.g. a run's optional
`finishedAt` — type-checks; the component's `compare()` already treats `null`
as "sort first".

## Step 1 — Task table (`src/views/TaskView.vue:544-579`)

Columns (`TaskView.vue:481-487`):

```ts
const taskColumns: DataTableColumn<Task>[] = [
  { key: 'name', label: 'Name', sortable: true, searchable: true },
  { key: 'script', label: 'Script', sortable: true, searchable: true, value: (t) => scriptLabelOf(t.scriptId) },
  { key: 'schedule', label: 'Schedule', sortable: true, searchable: true, value: (t) => scheduleLabel(t.schedule) },
  { key: 'status', label: 'Status', sortable: false, searchable: false },
  { key: 'actions', label: 'Actions', sortable: false, searchable: false },
]
```

Wiring (`TaskView.vue:544-550`):

```html
<DataTable
  v-else
  :rows="tasks"
  :columns="taskColumns"
  table-testid="task-table"
  :row-key="(t) => t.id"
  :row-testid="(t) => `task-row-${t.id}`"
  search-placeholder="Search tasks…"
  empty-message="No tasks match your search."
>
```

**Behaviour:**
1. Default sort = Name ascending (first sortable column), reproducing the old
   row order; clicking a header toggles asc/desc.
2. `#status` slot renders the same three-way badge chain as before:
   `script-missing-badge` (error) → `scheduler-missing-badge` (warning) →
   Enabled/Disabled (`TaskView.vue:553-557`).
3. `#actions` slot reproduces the full per-row action set with every pre-existing
   testid: `edit-task-${id}`, `disable-task-${id}`, `repair-task-${id}`,
   `toggle-task-${id}`, `run-task-${id}`, `open-folder-task-${id}`,
   `delete-task-${id}` (`TaskView.vue:559-576`). The three action templates
   (script-missing / unregistered / healthy) are preserved verbatim.
4. The `v-if="tasks.length === 0"` empty-state alert (`task-empty-state`) above
   the DataTable is untouched (`TaskView.vue:543`).

## Step 2 — Execution History table (`src/views/TaskView.vue:595-609`)

Columns (`TaskView.vue:489-495`):

```ts
const runColumns: DataTableColumn<TaskRun>[] = [
  { key: 'task', label: 'Task', sortable: true, searchable: true, value: (r) => taskNameOf(r.taskId) },
  { key: 'status', label: 'Status', sortable: true, searchable: true, value: (r) => r.status },
  { key: 'started', label: 'Started', sortable: true, searchable: false, sortValue: (r) => Date.parse(r.startedAt), value: (r) => new Date(r.startedAt).toLocaleString() },
  { key: 'finished', label: 'Finished', sortable: true, searchable: false, sortValue: (r) => (r.finishedAt ? Date.parse(r.finishedAt) : null), value: (r) => (r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '-') },
  { key: 'output', label: 'Output', sortable: false, searchable: false, value: (r) => runOutput(r) },
]
```

Wiring (`TaskView.vue:595-606`) — note `initial-sort-key="started"` with
`initial-sort-dir="desc"` so the table opens newest-first, matching the old
`filteredRuns()` ordering:

```html
<DataTable
  v-else
  :rows="filteredRuns()"
  :columns="runColumns"
  table-testid="runs-table"
  :row-key="(r) => r.id"
  :row-testid="(r) => `run-row-${r.id}`"
  initial-sort-key="started"
  initial-sort-dir="desc"
  search-placeholder="Search runs…"
  empty-message="No runs match your search."
>
  <template #status="{ row: r }"><span class="badge" :class="runStatusBadge(r.status)">{{ r.status }}</span></template>
  <template #output="{ row: r }"><span class="whitespace-pre-wrap text-xs">{{ runOutput(r) }}</span></template>
</DataTable>
```

**Behaviour:**
1. `:rows="filteredRuns()"` keeps the All/Success/Failed filter buttons driving
   the row set; the DataTable then sorts/paginates whatever array is returned.
2. The `#status` slot uses the existing `runStatusBadge()` mapping
   (`TaskView.vue:607`); the `#output` slot keeps the `runOutput()` five-line
   clamp with the `whitespace-pre-wrap` styling (`TaskView.vue:608`).
3. `v-if="filteredRuns().length === 0"` empty-state alert (`runs-empty-state`)
   and the `run-filter-*` / `runs-clear-btn` / `runs-refresh-btn` controls are
   untouched (`TaskView.vue:594,585-587,590-591`).

## Data sources

- `tasks` ref — loaded by `load()` via `taskRepository.list()` on mount
  (`TaskView.vue:95-103`).
- `filteredRuns()` — the existing status-filtered, newest-first `TaskRun[]`
  (`TaskView.vue:205-210`), fed by `loadRuns()` via `taskRunRepository.list()`.
- All cell accessors (`scriptLabelOf`, `scheduleLabel`, `taskNameOf`,
  `runStatusBadge`, `runOutput`) are pre-existing view helpers.

## Summary

| Aspect | Status |
|--------|--------|
| Task table via DataTable | ✅ `TaskView.vue:544-579` — search + sort + pagination |
| Runs table via DataTable | ✅ `TaskView.vue:595-609` — newest-first default (`initial-sort-dir="desc"`) |
| Typed columns | ✅ `TaskView.vue:481-487,489-495` |
| Row testids preserved | ✅ `task-row-${id}` / `run-row-${id}` via `rowTestid` prop |
| Action/status testids preserved | ✅ `edit/toggle/run/delete/repair/open-folder/disable-task-*`, `script-missing-badge`, `scheduler-missing-badge` |
| Empty states preserved | ✅ `task-empty-state` (`TaskView.vue:543`), `runs-empty-state` (`TaskView.vue:594`) |
| Tests | ✅ `src/components/DataTable.test.ts` (19) — full suite 297 green |
| Rust backend | ✅ none — zero `invoke()` calls; no new `invoke_handler` entries |

**Conclusion:** Both Task-page tables now reuse the generic `DataTable` with
typed columns and per-column slots. The runs table gains a genuinely new
capability (sortable Started/Finished columns) while defaulting to the same
newest-first view. Every pre-existing testid and empty-state alert survived, so
the 59-task TaskView test file needed no changes.

**Related docs:** `docs/Scripts--DataTable-Table-Workflow.md` (component +
props), `docs/Logging--DataTable-Table-Workflow.md` (Logging migration),
`docs/Task--Load-Task-Page-Workflow.md` (data flow feeding `tasks`).
