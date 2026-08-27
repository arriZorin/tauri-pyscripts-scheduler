# DataTable Table Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-27
**Status:** ✅ Implemented — the reusable `DataTable` component (search, sort,
rows-per-page, pagination) is now used by the Scripts page, the Task page (task
table + execution-history table), and the Logging page; **no dedicated Rust
command required** (the DataTable makes no `invoke()` calls — it
filters/sorts/paginates the already-loaded row arrays entirely in memory, so no
new entries appear in `invoke_handler` at `src-tauri/src/lib.rs`).

## Overview

1. **Generic component** (`src/components/DataTable.vue`) — owns search, sort,
   page-size, and pagination state; renders the DaisyUI
   `input`/`select`/`table`/`join` primitives. It treats `rows`/`columns` as
   opaque and only calls the `value` / `sortValue` / `searchValue` / `cellTitle`
   accessors supplied by the consumer.
2. **Column contract** (`src/components/DataTableColumn.ts:7-29`) — typed
   column descriptor so consumers stay strongly typed while the component stays
   generic.
3. **Consumers** — each page defines a typed `DataTableColumn<T>[]` and named
   per-column slots:
   - Scripts: `src/views/ScriptsListView.vue` (columns `:205-218`, table `:37-63`)
   - Task — task table: `src/views/TaskView.vue` (`taskColumns` `:481-487`,
     table `:544-579`)
   - Task — execution history: `src/views/TaskView.vue` (`runColumns` `:489-495`,
     table `:595-609`)
   - Logging: `src/views/LoggingView.vue` (`logColumns` `:17-24`, table `:82-96`)

Architectural fact: the entire DataTable path is **frontend-only**. Search,
sort, and pagination are pure client-side transforms over already-loaded arrays
(`scripts`, `tasks`, `filteredRuns()`, `logs`) — they never re-query a
repository. Page data still flows through each page's existing
load/repository chain (see the Related docs at the bottom).

## File Structure

```text
src/
├─ components/
│  ├─ DataTable.vue            ← generic sortable/searchable/paginated DaisyUI table
│  ├─ DataTableColumn.ts       ← typed column contract (DataTableColumn<T>)
│  ├─ DataTable.test.ts        ← 19 unit tests (RED→GREEN)
│  └─ icons/…
├─ views/
│  ├─ ScriptsListView.vue      ← consumer 1: script library table
│  ├─ TaskView.vue             ← consumer 2: task table + execution-history table
│  └─ LoggingView.vue          ← consumer 3: activity log table
└─ services/                   ← data sources (unchanged, per page)
```

## Component behaviour (`src/components/DataTable.vue`)

**Location:** props `:5-28` · defaults `:30-42` · state `:46-50` · computed
pipeline `:77-101` · watchers `:106-112` · handlers `:114-138` · template `:145-262`

State:

```ts
const search = ref('')
const page = ref(1)
const pageSize = ref(props.pageSize)
const sortKey = ref(props.initialSortKey || (props.columns.find((c) => c.sortable)?.key ?? ''))
const sortDir = ref<'asc' | 'desc'>(props.initialSortDir)
```

Computed pipeline (filter → sort → slice):

```ts
const filtered = computed(() => { /* case-insensitive search over searchable columns */ })
const sorted = computed(() => { /* stable sort via sortValue/value + compare() */ })
const totalPages = computed(() => Math.max(1, Math.ceil(sorted.value.length / pageSize.value)))
const paged = computed(() => sorted.value.slice((page.value - 1) * pageSize.value, (page.value) * pageSize.value))
```

**Behaviour:**
1. Default sort = `initialSortKey` (or the first `sortable` column) ascending
   (`DataTable.vue:49-50`) — this reproduces each page's previous ordering, so
   tables render identically on mount.
2. Every header renders as a `<button>` (`DataTable.vue:188-199`): sortable
   columns are enabled, carry the `data-table-sort-<key>` testid, and toggle
   asc→desc→asc via `toggleSort` (`DataTable.vue:114-122`); the active column
   shows `▲`/`▼` (`sortIndicator`, `DataTable.vue:124-127`). Non-sortable
   columns render as disabled buttons — unclickable and without a sort testid.
3. Search filters case-insensitively across columns where `searchable !==
   false` (`DataTable.vue:77-82`); typing resets to page 1
   (`watch(search, …)`, `DataTable.vue:110-112`).
4. Rows-per-page dropdown emits `update:pageSize` and resets to page 1
   (`onPageSizeChange`, `DataTable.vue:129-134`).
5. Pagination renders prev/page/next with `btn-active` on the current page
   (`DataTable.vue:224-260`); prev is disabled on page 1, next on the last page;
   `page` is clamped when data shrinks (`DataTable.vue:106-108`).
6. Empty state: full-width `<td>` showing `emptyMessage` when `paged.length === 0`
   (`DataTable.vue:204`).
7. Each `<tr>` carries a data-testid from the `rowTestid` prop, falling back to
   `data-table-row` (`DataTable.vue:208`) — this is how pages keep their
   `*-row-${id}` selectors.

Flow chain: `user types in search box → search.value → filtered → sorted → paged → <tbody>` · `user clicks header → toggleSort → sorted → paged`.

## Props

**Location:** interface `src/components/DataTable.vue:5-28` · defaults `:30-42`

```ts
interface Props {
  rows: any[]
  columns: DataTableColumn<any>[]
  searchable?: boolean            // master switch for search box, default true
  searchPlaceholder?: string      // default 'Search…'
  pageSize?: number               // initial page size, default 10
  pageSizeOptions?: number[]      // default [10, 25, 50, 100]
  zebra?: boolean                 // default true
  emptyMessage?: string
  initialSortKey?: string         // first-render sort column
  rowKey?: (row: any) => string   // stable per-row key, falls back to index
  tableTestid?: string            // data-testid on <table>, default 'data-table'
  rowTestid?: (row: any) => string  // data-testid on each <tr>, default 'data-table-row'
  initialSortDir?: 'asc' | 'desc'   // first-render sort direction, default 'asc'
}
```

`rowTestid` and `initialSortDir` were added for the Task/Logging migrations
(2026-08-27); both default backward-compatibly so the Scripts page and all prior
DataTable tests are unaffected. `sortValue` was widened to
`string | number | null` (`DataTableColumn.ts:19`) so a nullable sort key — e.g.
a run's optional `finishedAt` — type-checks; the component's `compare()` already
treats `null` as "sort first".

## Column contract (`src/components/DataTableColumn.ts:7-29`)

```ts
export interface DataTableColumn<T = unknown> {
  key: string
  label: string
  sortable?: boolean
  searchable?: boolean
  value?: (row: T) => unknown
  sortValue?: (row: T) => string | number | null
  searchValue?: (row: T) => string
  cellTitle?: (row: T) => string | undefined
  headerClass?: string
  cellClass?: string
}
```

**Behaviour:** `key` drives v-for keys, slot names, sort state, and the
`data-table-sort-<key>` testids. `value` reads the cell value; `sortValue`
overrides the sort key for numeric/date cells; `cellTitle` binds the native
`title` tooltip onto the `<td>` — used by the Scripts Created column so the full
ISO timestamp is hover-visible while the cell shows relative time.

## Consumer 1 — Scripts page (`src/views/ScriptsListView.vue`)

**Location:** table `:37-63` · columns `:205-218` · data load `:222-232`

```vue
<DataTable
  :rows="scripts"
  :columns="columns"
  class="text-sm"
  table-testid="script-table"
  :row-key="(s) => s.id"
  search-placeholder="Search scripts…"
  empty-message="No scripts yet. Add a .py file or folder."
>
  <template #path="{ row: s }">… Missing badge …</template>
  <template #status="{ row: s }">… Used/Unused badge …</template>
  <template #created="{ row: s }">… RelativeTime …</template>
  <template #actions="{ row: s }">… Edit/Repair/Delete buttons …</template>
</DataTable>
```

Columns (`ScriptsListView.vue:205-218`): Name (sortable/searchable, default
sort), Path (searchable), Status (display), Created (sortable, `value` = ISO
date, `cellTitle` for hover), Actions (display). `loadAndReconcile()`
(`ScriptsListView.vue:222-232`) is the single data-loading path:
`useScripts.load()` → scripts; `findMissingScriptIds` → missing;
`taskRepository.list()` → `usedScriptIds`. Every pre-existing testid is
preserved: `edit-script-${id}`, `delete-script-${id}`, `missing-script-${id}`,
`script-status-${id}`, `refresh-btn`, and `script-table` (via `table-testid`).

## Consumer 2 — Task page (`src/views/TaskView.vue`)

### Task table (`TaskView.vue:544-579`)

Columns (`taskColumns: DataTableColumn<Task>[]`, `TaskView.vue:481-487`):

```ts
const taskColumns: DataTableColumn<Task>[] = [
  { key: 'name', label: 'Name', sortable: true, searchable: true },
  { key: 'script', label: 'Script', sortable: true, searchable: true, value: (t) => scriptLabelOf(t.scriptId) },
  { key: 'schedule', label: 'Schedule', sortable: true, searchable: true, value: (t) => scheduleLabel(t.schedule) },
  { key: 'status', label: 'Status', sortable: false, searchable: false },
  { key: 'actions', label: 'Actions', sortable: false, searchable: false },
]
```

Wiring (`TaskView.vue:544-550`): `:rows="tasks"`, `table-testid="task-table"`,
`:row-key="(t) => t.id"`, `:row-testid="(t) => \`task-row-${t.id}\`"`. The
`#status` slot renders the three-way badge chain (`script-missing-badge` →
`scheduler-missing-badge` → Enabled/Disabled); the `#actions` slot reproduces
the full per-row action set with every pre-existing testid
(`edit/toggle/run/delete/repair/open-folder/disable-task-*`) across the three
state templates (script-missing / unregistered / healthy). The
`v-if="tasks.length === 0"` empty-state alert (`task-empty-state`,
`TaskView.vue:543`) is untouched.

### Execution History table (`TaskView.vue:595-609`)

Columns (`runColumns: DataTableColumn<TaskRun>[]`, `TaskView.vue:489-495`):

```ts
const runColumns: DataTableColumn<TaskRun>[] = [
  { key: 'task', label: 'Task', sortable: true, searchable: true, value: (r) => taskNameOf(r.taskId) },
  { key: 'status', label: 'Status', sortable: true, searchable: true, value: (r) => r.status },
  { key: 'started', label: 'Started', sortable: true, searchable: false, sortValue: (r) => Date.parse(r.startedAt), value: (r) => new Date(r.startedAt).toLocaleString() },
  { key: 'finished', label: 'Finished', sortable: true, searchable: false, sortValue: (r) => (r.finishedAt ? Date.parse(r.finishedAt) : null), value: (r) => (r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '-') },
  { key: 'output', label: 'Output', sortable: false, searchable: false, value: (r) => runOutput(r) },
]
```

Wiring (`TaskView.vue:595-606`): `:rows="filteredRuns()"`,
`table-testid="runs-table"`, `:row-testid="(r) => \`run-row-${r.id}\`"`,
`initial-sort-key="started"` + `initial-sort-dir="desc"` so the table opens
newest-first. `:rows="filteredRuns()"` keeps the All/Success/Failed filter
buttons driving the row set; `#status` uses `runStatusBadge()`, `#output` keeps
the `runOutput()` five-line clamp. The `runs-empty-state` alert
(`TaskView.vue:594`) and the `run-filter-*` / `runs-clear-btn` /
`runs-refresh-btn` controls are untouched.

## Consumer 3 — Logging page (`src/views/LoggingView.vue`)

**Location:** table `:82-96` · columns `:17-24`

Columns (`logColumns: DataTableColumn<LogEntry>[]`, `LoggingView.vue:17-24`):

```ts
const logColumns: DataTableColumn<LogEntry>[] = [
  { key: 'time', label: 'Time', sortable: true, searchable: false, sortValue: (l) => Date.parse(l.createdAt), value: (l) => new Date(l.createdAt).toLocaleString() },
  { key: 'mode', label: 'Mode', sortable: true, searchable: true, value: (l) => l.mode },
  { key: 'level', label: 'Level', sortable: true, searchable: true, value: (l) => l.level },
  { key: 'source', label: 'Source', sortable: true, searchable: true, value: (l) => l.source },
  { key: 'message', label: 'Message', sortable: false, searchable: true, value: (l) => l.message },
  { key: 'duration', label: 'Duration', sortable: true, searchable: false, sortValue: (l) => (l.durationMs === null ? -1 : l.durationMs), value: (l) => (l.durationMs === null ? '-' : `${l.durationMs} ms`) },
]
```

Wiring (`LoggingView.vue:82-96`): `:rows="logs"`, `table-testid="log-table"`,
`:row-testid="(l) => \`log-row-${l.id}\`"`, `initial-sort-key="time"` +
`initial-sort-dir="desc"` for newest-first. `#mode` / `#level` slots preserve
the badge styling and the `log-mode-badge` testid. The `log-empty-state` alert
(`LoggingView.vue:81`) and the Clear/Refresh header buttons are untouched.

## Summary

| Aspect | Status |
|--------|--------|
| Generic sortable/searchable/paginated table | ✅ `DataTable.vue:46-50,77-101,114-138,145-262` |
| Column contract + accessors | ✅ `DataTableColumn.ts:7-29` |
| Scripts table | ✅ `ScriptsListView.vue:37-63,205-218` |
| Task table | ✅ `TaskView.vue:544-579,481-487` |
| Execution-history table (newest-first) | ✅ `TaskView.vue:595-609,489-495` — `initial-sort-dir="desc"` |
| Logging table (newest-first) | ✅ `LoggingView.vue:82-96,17-24` — `initial-sort-dir="desc"` |
| Header as button (sortable enabled / non-sortable disabled) | ✅ `DataTable.vue:188-199` |
| Row testids preserved | ✅ `rowTestid` prop (`DataTable.vue:25,208`) → `script-*`/`task-row-*`/`run-row-*`/`log-row-*` |
| Empty states preserved | ✅ per-page `v-if` alerts + `emptyMessage` (`DataTable.vue:204`) |
| Tests | ✅ `src/components/DataTable.test.ts` (20) — full suite 298 green |
| Rust backend | ✅ none — zero `invoke()` calls; no new entries in `invoke_handler` (`lib.rs:508`) |

**Conclusion:** A single reusable, dependency-free `DataTable` renders every
table in the app (Scripts, Task tasks + execution history, Logging) with
search, sort, rows-per-page, and pagination, while every pre-existing testid,
empty-state alert, and per-page data path is preserved. The Task and Logging
tables additionally gained sortable columns and a search box for free.

**Optional future work:**
- Persist the chosen rows-per-page via the emitted `update:pageSize` event.
- Window the page-number buttons once datasets exceed ~10 pages.

## Related docs

- `docs/Task--Load-Task-Page-Workflow.md` — data flow feeding `tasks` / runs.
- `docs/Scripts--Refresh-Button-Workflow.md` / `docs/Scripts--Add-File-Button-Workflow.md`
  — the `useScripts` data path feeding the Scripts table.
- `docs/Integration-Testing-Guide.md` — repo test conventions (`bun run test`).
