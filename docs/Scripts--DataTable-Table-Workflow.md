# DataTable Table Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-26
**Status:** ✅ Implemented — the Scripts page table is now a reusable `DataTable`
with search, sort, rows-per-page, and pagination; **no dedicated Rust command
required** (verified: zero new entries in `invoke_handler` at `src-tauri/src/lib.rs:508`;
the DataTable makes no `invoke()` calls — it filters/sorts/paginates the
already-loaded `scripts` array entirely in memory).

## Overview

1. **Vue View** (`src/views/ScriptsListView.vue:37-63`) — renders `<DataTable>`
   with `:rows="scripts"`, `:columns="columns"`, and per-column named slots
   (`#path`, `#status`, `#created`, `#actions`). The column list is a typed
   `DataTableColumn<Script>[]` at `ScriptsListView.vue:205-218`.
2. **Generic component** (`src/components/DataTable.vue`) — owns search, sort,
   page-size, and pagination state; renders the DaisyUI
   `input`/`select`/`table`/`join` primitives. It treats `rows`/`columns` as
   opaque and only calls the `value` / `sortValue` / `searchValue` / `cellTitle`
   accessors supplied by the consumer.
3. **Column contract** (`src/components/DataTableColumn.ts:7-28`) — typed
   column descriptor so consumers stay strongly typed while the component stays
   generic.
4. **Data sources** — `scripts` ref from the existing `useScripts` composable
   (`ScriptsListView.vue:202`); `missingScriptIds` from `findMissingScriptIds`
   (`ScriptsListView.vue:224`); `usedScriptIds` Set built from
   `taskRepository.list()` inside `loadAndReconcile()` (`ScriptsListView.vue:220-232`).

Architectural fact: the entire DataTable path is **frontend-only**. Search,
sort, and pagination are pure client-side transforms over the already-loaded
`scripts` array — they never re-query the repository. Script loading still
flows through the existing `useScripts` composable →
`ScriptRepository`/`TauriFileStorage` chain documented by the Add-File / Refresh
workflow docs.

## File Structure

```text
src/
├─ components/
│  ├─ DataTable.vue            ← Step 1: generic sortable/searchable/paginated DaisyUI table
│  ├─ DataTableColumn.ts       ← Step 2: typed column contract (DataTableColumn<T>)
│  ├─ DataTable.test.ts        ← Step 4: 17 unit tests (RED→GREEN)
│  └─ icons/…
├─ views/
│  └─ ScriptsListView.vue      ← Step 3: wires rows + columns + per-column slots
└─ services/
   └─ script/import/useScripts.ts  ← data source: `scripts` ref (existing, unchanged)
```

**Present and wired:**

| File | Role |
|------|------|
| `src/components/DataTable.vue` | Owns search/sort/page-size/pagination; renders DaisyUI table + toolbar |
| `src/components/DataTableColumn.ts` | Column descriptor with `value`/`sortValue`/`searchValue`/`cellTitle` accessors |
| `src/views/ScriptsListView.vue` | Passes `rows`/`columns`, defines named cell slots, preserves every existing testid |

## Dependency Wiring

`DataTable` is self-contained — it imports only `vue` and the `DataTableColumn`
type. No app-context, no Tauri IPC, no repository access. `ScriptsListView` is
the only consumer today; it binds props directly:

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
```

Tests mount the component directly via `createApp` + `h(DataTable, { rows,
columns, ...props })` (`src/components/DataTable.test.ts`) — no fakes are needed
at any boundary because the component has no external dependencies.

## Execution Flow

### Step 1 — DataTable component (`src/components/DataTable.vue`)

**Location:** state `:40-44` · computed pipeline `:71-98` · watchers `:100-106` · handlers `:108-136` · template `:141-250`

State:

```ts
const search = ref('')
const page = ref(1)
const pageSize = ref(props.pageSize)
const sortKey = ref(props.initialSortKey || (props.columns.find((c) => c.sortable)?.key ?? ''))
const sortDir = ref<'asc' | 'desc'>('asc')
```

Computed pipeline (filter → sort → slice):

```ts
const filtered = computed(() => { /* case-insensitive search over searchable columns */ })
const sorted = computed(() => { /* stable sort via sortValue/value + compare() */ })
const totalPages = computed(() => Math.max(1, Math.ceil(sorted.value.length / pageSize.value)))
const paged = computed(() => sorted.value.slice((page.value - 1) * pageSize.value, (page.value) * pageSize.value))
```

**Behaviour:**
1. Default sort = first `sortable` column ascending (`DataTable.vue:43`) — this
   reproduces the previous `sortScripts` name-ascending behaviour, so the
   Scripts list renders identically on mount.
2. Clicking a sortable header toggles asc→desc→asc via `toggleSort`
   (`DataTable.vue:108-121`); the active column shows `▲`/`▼` (`sortIndicator`).
3. Search filters case-insensitively across columns where `searchable !==
   false` (`DataTable.vue:71-76`); typing resets to page 1
   (`watch(search, …)`, `DataTable.vue:104-106`).
4. Rows-per-page dropdown emits `update:pageSize` and resets to page 1
   (`onPageSizeChange`, `DataTable.vue:123-128`).
5. Pagination renders prev/page/next with `btn-active` on the current page
   (`DataTable.vue:224-250`); prev is disabled on page 1, next on the last page;
   `page` is clamped when data shrinks (`DataTable.vue:100-102`).
6. Empty state: full-width `<td>` showing `emptyMessage` when `paged.length === 0`
   (`DataTable.vue:199`).

Flow chain: `user types in search box → search.value → filtered → sorted → paged → <tbody>` · `user clicks header → toggleSort → sorted → paged`.

### Step 2 — Column contract (`src/components/DataTableColumn.ts`)

**Location:** `src/components/DataTableColumn.ts:7-28`

```ts
export interface DataTableColumn<T = unknown> {
  key: string
  label: string
  sortable?: boolean
  searchable?: boolean
  value?: (row: T) => unknown
  sortValue?: (row: T) => string | number
  searchValue?: (row: T) => string
  cellTitle?: (row: T) => string | undefined
  headerClass?: string
  cellClass?: string
}
```

**Behaviour:** `key` drives v-for keys, slot names, sort state, and the
`data-table-sort-<key>` testids. `value` reads the cell value; `sortValue`
overrides the sort key for numeric/date cells; `cellTitle` binds the native
`title` tooltip onto the `<td>` — used by the Created column so the full ISO
timestamp is hover-visible while the cell shows relative time.

### Step 3 — View wiring (`src/views/ScriptsListView.vue`)

**Location:** `ScriptsListView.vue:37-63` (template) · `:205-218` (columns) · `:222-232` (data load)

Columns:

```ts
const columns: DataTableColumn<Script>[] = [
  { key: 'name', label: 'Name', sortable: true, searchable: true },
  { key: 'path', label: 'Path', sortable: false, searchable: true },
  { key: 'status', label: 'Status', sortable: false, searchable: false },
  { key: 'created', label: 'Created', sortable: true, searchable: false, value: (s) => s.createdAt, cellTitle: (s) => s.createdAt },
  { key: 'actions', label: 'Actions', sortable: false, searchable: false },
]
```

**Behaviour:**
1. Name is the default sort column (ascending), matching the old
   `sortScripts` output.
2. Path stays searchable but not sortable; Status and Actions are display-only.
3. Per-column slots render the Missing badge (`#path`), Used/Unused badge
   (`#status`), relative time (`#created`), and Edit/Repair/Delete buttons
   (`#actions`). Every pre-existing testid is preserved: `edit-script-${id}`,
   `delete-script-${id}`, `missing-script-${id}`, `script-status-${id}`,
   `refresh-btn`, and `script-table` (via the `table-testid` prop).
4. `loadAndReconcile()` (`ScriptsListView.vue:222-232`) remains the single
   data-loading path: `useScripts.load()` → scripts;
   `findMissingScriptIds` → missing; `taskRepository.list()` → `usedScriptIds`.

### Step 4 — Data sources (`src/views/ScriptsListView.vue:200-232`)

`scripts` comes from `useScripts({ repository, picker, scanner })` (existing
composable). Search/sort/pagination never touch the repository — they transform
the in-memory `scripts` array. The Status column reads the `usedScriptIds`
`ref<Set<string>>`; the accessor closures read `usedScriptIds.value` during the
DataTable's computed evaluation, so the sort/paginate pipeline stays reactive to
task changes.

Flow chain: `DataTable` receives `scripts` → `filtered` → `sorted` → `paged` → row slots → cell content.

## Summary

| Aspect | Status |
|--------|--------|
| Sortable columns | ✅ `DataTable.vue:43,108-121` — asc/desc toggle + `▲`/`▼` indicator |
| Search filter | ✅ `DataTable.vue:71-76,104-106` — case-insensitive, resets to page 1 |
| Rows-per-page dropdown | ✅ `DataTable.vue:123-128,169` — 10/25/50/100, emits `update:pageSize` |
| Pagination | ✅ `DataTable.vue:90-98,224-250` — prev/page/next + `Showing X–Y of Z` |
| Cell slots / accessors | ✅ `DataTable.vue:53-61,203-215`; `DataTableColumn.ts:7-28` |
| Empty state | ✅ `DataTable.vue:199` — `emptyMessage` |
| Tests | ✅ `src/components/DataTable.test.ts` (17) — full suite 295 green |
| Rust backend | ✅ none — zero `invoke()` calls; no new entries in `invoke_handler` (`lib.rs:508`) |

**Conclusion:** The Scripts page table is now a reusable, dependency-free
`DataTable` (sort + search + rows-per-page + pagination) with the DaisyUI look,
while every pre-existing testid and the existing `useScripts` data path are
preserved. The component can be dropped into another table (Task runs,
Logging) with just a columns array and per-column slots.

**Optional future work:**
- Migrate the TaskView runs table and LoggingView table to `DataTable`
  (same columns + slots pattern).
- Persist the chosen rows-per-page via the emitted `update:pageSize` event.
- Window the page-number buttons once datasets exceed ~10 pages.

## Appendix: Related Documentation

- `docs/Scripts--Refresh-Button-Workflow.md` — the `loadAndReconcile()` data
  reload path that the table renders.
- `docs/Scripts--Add-File-Button-Workflow.md` — the `useScripts` composable
  data source feeding `scripts`.
- `docs/Integration-Testing-Guide.md` — repo test conventions (`bun run test`).
