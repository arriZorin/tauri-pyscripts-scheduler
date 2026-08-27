# Logging DataTable Table Workflow

**Project:** `tauri-pyscripts-scheduler`
**Date:** 2026-08-27
**Status:** ✅ Implemented — the Activity Log page table is now rendered by the
reusable `DataTable` component with search, sort, rows-per-page, and
pagination; **no dedicated Rust command required** (the DataTable makes no
`invoke()` calls — it filters/sorts/paginates the already-loaded `logs` array
entirely in memory, so no new entries appear in `invoke_handler` at
`src-tauri/src/lib.rs`).

## Overview

1. **Vue View** (`src/views/LoggingView.vue`) — renders one `<DataTable>`
   (`LoggingView.vue:82-96`) with a typed column array
   (`logColumns: DataTableColumn<LogEntry>[]`, `LoggingView.vue:17-24`) and
   named slots for the Mode and Level badges.
2. **Generic component** (`src/components/DataTable.vue`) — owns search, sort,
   page-size, and pagination state (documented in
   `Scripts--DataTable-Table-Workflow.md`). This migration uses the `rowTestid`
   and `initialSortDir` props added for the Task migration
   (see `Task--DataTable-Table-Workflow.md`).

Architectural fact: the whole DataTable path is **frontend-only**. The log
table sorts/paginates the already-loaded `logs` ref (capped at 100 newest
entries by `load()`, `LoggingView.vue:15-29`); it never re-queries the
repository.

## Column contract (`src/views/LoggingView.vue:17-24`)

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

Notes:
- `time` and `duration` sort on raw numbers (`Date.parse` / `durationMs`) while
  displaying formatted text — the `sortValue` override pattern.
- `duration`'s sortValue maps `null` to `-1` so unfinished (null-duration)
  entries always sort first in ascending, keeping the display `-` stable.

## Wiring (`src/views/LoggingView.vue:82-96`)

```html
<DataTable
  v-else
  :rows="logs"
  :columns="logColumns"
  table-testid="log-table"
  :row-key="(l) => l.id"
  :row-testid="(l) => `log-row-${l.id}`"
  initial-sort-key="time"
  initial-sort-dir="desc"
  search-placeholder="Search logs…"
  empty-message="No log entries match your search."
>
  <template #mode="{ row: l }"><span class="badge" :class="l.mode === 'prod' ? 'badge-success' : 'badge-info'" data-testid="log-mode-badge">{{ l.mode }}</span></template>
  <template #level="{ row: l }"><span class="badge" :class="l.level === 'error' ? 'badge-error' : 'badge-ghost'">{{ l.level }}</span></template>
</DataTable>
```

**Behaviour:**
1. `initial-sort-key="time"` + `initial-sort-dir="desc"` opens the table
   newest-first, matching the old `[...entries].reverse()` ordering in
   `load()` (`LoggingView.vue:18`).
2. `#mode` and `#level` slots preserve the badge styling and the
   `log-mode-badge` testid (`LoggingView.vue:94-95`).
3. `v-if="logs.length === 0"` empty-state alert (`log-empty-state`) and the
   Clear/Refresh header buttons are untouched (`LoggingView.vue:81,69-70`).

## Data source

`logs` ref — loaded by `load()` via `logRepository.list()`, reversed, and capped
at 100 (`LoggingView.vue:15-29`). `stats` (entry count + earliest date) is
computed independently in the same `load()` and shown in the header — it is
unaffected by the DataTable.

## Summary

| Aspect | Status |
|--------|--------|
| Log table via DataTable | ✅ `LoggingView.vue:82-96` — search + sort + pagination |
| Typed columns | ✅ `LoggingView.vue:17-24` |
| Row testids preserved | ✅ `log-row-${id}` via `rowTestid` prop |
| Badge testid preserved | ✅ `log-mode-badge` (`LoggingView.vue:94`) |
| Empty state preserved | ✅ `log-empty-state` (`LoggingView.vue:81`) |
| Tests | ✅ `src/components/DataTable.test.ts` (19) — full suite 297 green |
| Rust backend | ✅ none — zero `invoke()` calls; no new `invoke_handler` entries |

**Conclusion:** The Activity Log table now reuses the generic `DataTable`,
gaining sortable Time/Duration columns and a search box while defaulting to the
same newest-first view. Every pre-existing testid and the empty-state alert
survived, so the 6-test LoggingView test file needed no changes.

**Related docs:** `docs/Scripts--DataTable-Table-Workflow.md` (component +
props), `docs/Task--DataTable-Table-Workflow.md` (Task migration).
