<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DataTableColumn } from './DataTableColumn'

interface Props {
  rows: any[]
  columns: DataTableColumn<any>[]
  /** Master switch for the search box. Default true. */
  searchable?: boolean
  searchPlaceholder?: string
  /** Initial page size. Default 10. */
  pageSize?: number
  /** Options in the rows-per-page dropdown. Default [10, 25, 50, 100]. */
  pageSizeOptions?: number[]
  /** Zebra striping on the table. Default true. */
  zebra?: boolean
  emptyMessage?: string
  /** Optional column key to sort by on first render. Defaults to the first sortable column. */
  initialSortKey?: string
  /** Stable key per row (e.g. `(row) => row.id`). Falls back to row index. */
  rowKey?: (row: any) => string
  /** data-testid on the <table>. Defaults to "data-table". */
  tableTestid?: string
  /** data-testid on each <tr>. Defaults to "data-table-row". */
  rowTestid?: (row: any) => string
  /** Initial sort direction. Default 'asc'. */
  initialSortDir?: 'asc' | 'desc'
}

const props = withDefaults(defineProps<Props>(), {
  searchable: true,
  searchPlaceholder: 'Search…',
  pageSize: 10,
  pageSizeOptions: () => [10, 25, 50, 100],
  zebra: true,
  emptyMessage: 'No records found.',
  initialSortKey: '',
  rowKey: undefined,
  tableTestid: 'data-table',
  rowTestid: undefined,
  initialSortDir: 'asc',
})

const emit = defineEmits<{ 'update:pageSize': [value: number] }>()

const search = ref('')
const page = ref(1)
const pageSize = ref(props.pageSize)
const sortKey = ref(props.initialSortKey || (props.columns.find((c) => c.sortable)?.key ?? ''))
const sortDir = ref<'asc' | 'desc'>(props.initialSortDir)

watch(
  () => props.pageSize,
  (v) => {
    pageSize.value = v
  },
)

function cellValue(row: any, col: DataTableColumn<any>): unknown {
  return col.value ? col.value(row) : row[col.key]
}

function searchText(row: any, col: DataTableColumn<any>): string {
  if (col.searchValue) return col.searchValue(row)
  const v = cellValue(row, col)
  return v == null ? '' : String(v)
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.rows
  const searchCols = props.columns.filter((c) => c.searchable !== false)
  return props.rows.filter((row) => searchCols.some((col) => searchText(row, col).toLowerCase().includes(q)))
})

const sorted = computed(() => {
  const key = sortKey.value
  const col = props.columns.find((c) => c.key === key)
  if (!key || !col) return filtered.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...filtered.value].sort((a, b) => {
    const av = col.sortValue ? col.sortValue(a) : cellValue(a, col)
    const bv = col.sortValue ? col.sortValue(b) : cellValue(b, col)
    return compare(av, bv) * dir
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(sorted.value.length / pageSize.value)))

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return sorted.value.slice(start, start + pageSize.value)
})

const rangeStart = computed(() => (sorted.value.length === 0 ? 0 : (page.value - 1) * pageSize.value + 1))
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, sorted.value.length))

watch([sorted, pageSize], () => {
  if (page.value > totalPages.value) page.value = totalPages.value
})

watch(search, () => {
  page.value = 1
})

function toggleSort(col: DataTableColumn<any>) {
  if (sortKey.value === col.key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = col.key
    sortDir.value = 'asc'
  }
  page.value = 1
}

function sortIndicator(col: DataTableColumn<any>): string {
  if (sortKey.value !== col.key) return ''
  return sortDir.value === 'asc' ? '▲' : '▼'
}

function onPageSizeChange(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  pageSize.value = value
  page.value = 1
  emit('update:pageSize', value)
}

function formatCell(value: unknown): string {
  return value == null ? '' : String(value)
}

function rowKeyOf(row: any, index: number): string {
  return props.rowKey ? props.rowKey(row) : String(index)
}
</script>

<template>
  <div class="data-table w-full">
    <div v-if="searchable" class="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div class="relative">
        <input
          v-model="search"
          type="search"
          data-testid="data-table-search"
          class="input input-bordered input-sm pl-8"
          :placeholder="searchPlaceholder"
        />
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          class="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 stroke-current opacity-50 pointer-events-none"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M21 21l-4.35-4.35m1.35-5.4a6.75 6.75 0 11-13.5 0 6.75 6.75 0 0113.5 0z"
          />
        </svg>
      </div>
      <label class="flex items-center gap-2 text-sm text-base-content/60">
        <span>rows</span>
        <select
          class="select select-bordered select-sm"
          data-testid="data-table-page-size"
          :value="pageSize"
          @change="onPageSizeChange"
        >
          <option v-for="n in pageSizeOptions" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
    </div>

    <div class="overflow-x-auto">
      <table class="table w-full" :class="{ 'table-zebra': zebra }" :data-testid="tableTestid">
        <thead>
          <tr>
            <th v-for="col in columns" :key="col.key" :class="col.headerClass">
              <button
                type="button"
                class="btn btn-ghost btn-sm gap-1 normal-case text-sm"
                :class="!col.sortable ? 'disabled:text-neutral-950' : ''"
                :disabled="!col.sortable"
                :data-testid="col.sortable ? `data-table-sort-${col.key}` : undefined"
                @click="toggleSort(col)"
              >
                {{ col.label }}
                <span v-if="col.sortable" class="sort-indicator" aria-hidden="true">{{ sortIndicator(col) }}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="paged.length === 0">
            <td :colspan="columns.length" class="text-center py-6 text-base-content/60" data-testid="data-table-empty">
              {{ emptyMessage }}
            </td>
          </tr>
          <tr v-for="(row, index) in paged" :key="rowKeyOf(row, index)" :data-testid="rowTestid ? rowTestid(row) : 'data-table-row'">
            <td
              v-for="col in columns"
              :key="col.key"
              :class="col.cellClass"
              :title="col.cellTitle ? col.cellTitle(row) : undefined"
            >
              <slot :name="col.key" :row="row" :value="cellValue(row, col)">
                {{ formatCell(cellValue(row, col)) }}
              </slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="sorted.length > 0"
      class="flex flex-wrap items-center justify-between gap-3 mt-3 text-sm text-base-content/60"
    >
      <span data-testid="data-table-summary">Showing {{ rangeStart }}–{{ rangeEnd }} of {{ sorted.length }}</span>
      <div class="join" data-testid="data-table-pagination">
        <button
          class="btn btn-sm join-item"
          :disabled="page === 1"
          data-testid="data-table-prev"
          @click="page--"
          aria-label="Previous page"
        >
          «
        </button>
        <button
          v-for="p in totalPages"
          :key="p"
          class="btn btn-sm join-item"
          :class="{ 'btn-active': p === page }"
          :disabled="p === page"
          :data-testid="`data-table-page-${p}`"
          @click="page = p"
        >
          {{ p }}
        </button>
        <button
          class="btn btn-sm join-item"
          :disabled="page === totalPages"
          data-testid="data-table-next"
          @click="page++"
          aria-label="Next page"
        >
          »
        </button>
      </div>
    </div>
  </div>
</template>
