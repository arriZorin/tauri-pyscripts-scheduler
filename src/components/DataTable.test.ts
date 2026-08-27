import { describe, it, expect } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import DataTable from './DataTable.vue'
import type { DataTableColumn } from './DataTableColumn'

interface Row {
  id: number
  name: string
  status: string
  created: string
}

const columns: DataTableColumn<Row>[] = [
  { key: 'name', label: 'Name', sortable: true, searchable: true },
  { key: 'status', label: 'Status', sortable: true, searchable: true },
  { key: 'created', label: 'Created', sortable: true, searchable: false, value: (r) => r.created },
]

// 25 rows with ascending names/ids so pagination and sort expectations are deterministic.
const sampleRows: Row[] = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  name: `script-${String(i + 1).padStart(2, '0')}.py`,
  status: i % 3 === 0 ? 'warn' : 'ok',
  created: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
}))

interface Mounted {
  container: HTMLElement
  app: ReturnType<typeof createApp>
}

function mountTable(rows: Row[], props: Record<string, unknown> = {}, slots: Record<string, unknown> = {}): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    components: { DataTable },
    render: () => h(DataTable as any, { rows, columns, ...props }, slots as any),
  })
  app.mount(container)
  return { container, app }
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

function rowTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="data-table-row"]')).map((r) => r.textContent?.trim() ?? '')
}

function typeSearch(container: HTMLElement, value: string) {
  const input = container.querySelector('[data-testid="data-table-search"]') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function clickSort(container: HTMLElement, key: string) {
  const btn = container.querySelector(`[data-testid="data-table-sort-${key}"]`) as HTMLElement
  btn.click()
}

function setPageSize(container: HTMLElement, value: number) {
  const select = container.querySelector('[data-testid="data-table-page-size"]') as HTMLSelectElement
  select.value = String(value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function summary(container: HTMLElement): string {
  return container.querySelector('[data-testid="data-table-summary"]')?.textContent?.trim() ?? ''
}

describe('DataTable', () => {
  it('renders column headers and cell values for every row', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 3))
    await nextTick()

    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent?.trim())
    expect(headers[0]).toContain('Name')
    expect(headers[1]).toContain('Status')
    expect(headers[2]).toContain('Created')
    expect(rowTexts(container)).toHaveLength(3)
    expect(rowTexts(container)[0]).toContain('script-01.py')

    app.unmount()
  })

  it('applies the zebra class by default and drops it when zebra=false', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 2))
    await nextTick()
    expect(container.querySelector('[data-testid="data-table"]')?.classList.contains('table-zebra')).toBe(true)
    app.unmount()

    const plain = mountTable(sampleRows.slice(0, 2), { zebra: false })
    await nextTick()
    expect(plain.container.querySelector('[data-testid="data-table"]')?.classList.contains('table-zebra')).toBe(false)
    plain.app.unmount()
  })

  it('defaults to ascending sort on the first sortable column', async () => {
    // Feed rows in reverse order; the table should render them sorted by name ascending.
    // Use pageSize 25 so every row is on the first page.
    const shuffled = [...sampleRows].reverse()
    const { container, app } = mountTable(shuffled, { pageSize: 25 })
    await nextTick()

    const rows = rowTexts(container)
    expect(rows[0]).toContain('script-01.py')
    expect(rows[rows.length - 1]).toContain('script-25.py')

    app.unmount()
  })

  it('sorts ascending then descending when the header is clicked', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 5))
    await nextTick()

    // Default: asc by name.
    expect(rowTexts(container)[0]).toContain('script-01.py')

    // Click once → desc.
    clickSort(container, 'name')
    await flush()
    expect(rowTexts(container)[0]).toContain('script-05.py')

    // Click again → asc.
    clickSort(container, 'name')
    await flush()
    expect(rowTexts(container)[0]).toContain('script-01.py')

    app.unmount()
  })

  it('shows the sort direction indicator on the active column', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 3))
    await nextTick()

    const sortBtn = container.querySelector('[data-testid="data-table-sort-name"]') as HTMLElement
    expect(sortBtn.textContent).toContain('▲')

    clickSort(container, 'name')
    await flush()
    expect(sortBtn.textContent).toContain('▼')

    app.unmount()
  })

  it('does not sort by a non-sortable column', async () => {
    const nonSortable: DataTableColumn<Row>[] = [
      { key: 'name', label: 'Name', sortable: false, searchable: true },
      { key: 'status', label: 'Status', sortable: true, searchable: true },
    ]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      components: { DataTable },
      render: () => h(DataTable as any, { rows: sampleRows.slice(0, 3), columns: nonSortable }),
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-testid="data-table-sort-name"]')).toBeNull()

    app.unmount()
  })

  it('filters rows with case-insensitive search across searchable columns', async () => {
    const { container, app } = mountTable(sampleRows)
    await nextTick()

    typeSearch(container, 'SCRIPT-07')
    await flush()
    expect(rowTexts(container)).toHaveLength(1)
    expect(rowTexts(container)[0]).toContain('script-07.py')

    // Non-searchable column (created) is not matched.
    typeSearch(container, '2024-01-15')
    await flush()
    expect(rowTexts(container)).toHaveLength(0)

    app.unmount()
  })

  it('resets to page 1 when a search is typed while on a later page', async () => {
    const { container, app } = mountTable(sampleRows)
    await nextTick()

    // Jump to page 3.
    ;(container.querySelector('[data-testid="data-table-page-3"]') as HTMLElement).click()
    await flush()
    expect(summary(container)).toContain('21–25')

    typeSearch(container, 'script-05')
    await flush()
    expect(summary(container)).toContain('1–1')

    app.unmount()
  })

  it('renders 10/25/50/100 page-size options', async () => {
    const { container, app } = mountTable(sampleRows)
    await nextTick()

    const options = Array.from(container.querySelectorAll('[data-testid="data-table-page-size"] option')).map(
      (o) => Number((o as HTMLOptionElement).value),
    )
    expect(options).toEqual([10, 25, 50, 100])

    app.unmount()
  })

  it('changes the number of visible rows when the page size changes', async () => {
    const { container, app } = mountTable(sampleRows)
    await nextTick()

    expect(rowTexts(container)).toHaveLength(10)

    setPageSize(container, 25)
    await flush()
    expect(rowTexts(container)).toHaveLength(25)
    // Pagination collapses to a single page.
    expect(container.querySelector('[data-testid="data-table-page-2"]')).toBeNull()

    app.unmount()
  })

  it('paginates: page 2 shows rows 11–20 and prev/next work', async () => {
    const { container, app } = mountTable(sampleRows)
    await nextTick()

    expect(summary(container)).toContain('1–10 of 25')

    ;(container.querySelector('[data-testid="data-table-next"]') as HTMLElement).click()
    await flush()
    expect(summary(container)).toContain('11–20')
    expect(rowTexts(container)[0]).toContain('script-11.py')

    ;(container.querySelector('[data-testid="data-table-prev"]') as HTMLElement).click()
    await flush()
    expect(summary(container)).toContain('1–10')

    app.unmount()
  })

  it('disables prev on the first page and next on the last page', async () => {
    const { container, app } = mountTable(sampleRows)
    await nextTick()

    const prev = container.querySelector('[data-testid="data-table-prev"]') as HTMLButtonElement
    expect(prev.disabled).toBe(true)

    ;(container.querySelector('[data-testid="data-table-page-3"]') as HTMLElement).click()
    await flush()

    const next = container.querySelector('[data-testid="data-table-next"]') as HTMLButtonElement
    expect(next.disabled).toBe(true)

    app.unmount()
  })

  it('renders custom cell content via a named column slot', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      components: { DataTable },
      render: () =>
        h(
          DataTable as any,
          { rows: sampleRows.slice(0, 2), columns },
          {
            name: (slotProps: { row: Row }) => h('span', { 'data-testid': 'custom-name' }, `SLOT:${slotProps.row.name}`),
          },
        ),
    })
    app.mount(container)
    await nextTick()

    const custom = container.querySelectorAll('[data-testid="custom-name"]')
    expect(custom).toHaveLength(2)
    expect(custom[0].textContent).toBe('SLOT:script-01.py')

    app.unmount()
  })

  it('binds a cellTitle accessor onto the td', async () => {
    const withTitle: DataTableColumn<Row>[] = [
      { key: 'name', label: 'Name', sortable: true, searchable: true },
      { key: 'created', label: 'Created', sortable: true, value: (r) => r.created, cellTitle: (r) => r.created },
    ]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      components: { DataTable },
      render: () => h(DataTable as any, { rows: sampleRows.slice(0, 1), columns: withTitle }),
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('td[title="2024-01-01"]')).toBeTruthy()

    app.unmount()
  })

  it('renders a custom table testid when provided', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 1), { tableTestid: 'my-table' })
    await nextTick()

    expect(container.querySelector('[data-testid="my-table"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="data-table"]')).toBeNull()

    app.unmount()
  })

  it('uses a custom sortValue accessor for sorting', async () => {
    const byLen: DataTableColumn<Row>[] = [
      { key: 'name', label: 'Name', sortable: true, searchable: true, sortValue: (r) => r.name.length },
    ]
    const rows: Row[] = [
      { id: 1, name: 'long-name.py', status: 'ok', created: '2024-01-01' },
      { id: 2, name: 'a.py', status: 'ok', created: '2024-01-02' },
      { id: 3, name: 'medium.py', status: 'ok', created: '2024-01-03' },
    ]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      components: { DataTable },
      render: () => h(DataTable as any, { rows, columns: byLen }),
    })
    app.mount(container)
    await nextTick()

    expect(rowTexts(container)).toEqual(['a.py', 'medium.py', 'long-name.py'])

    app.unmount()
  })

  it('shows the empty message when there are no rows and when search matches nothing', async () => {
    const { container, app } = mountTable([], { emptyMessage: 'Nothing here.' })
    await nextTick()
    expect(container.querySelector('[data-testid="data-table-empty"]')?.textContent).toContain('Nothing here.')
    app.unmount()

    const second = mountTable(sampleRows)
    await nextTick()
    typeSearch(second.container, 'zzz-no-match')
    await flush()
    expect(second.container.querySelector('[data-testid="data-table-empty"]')?.textContent).toContain('No records found.')
    second.app.unmount()
  })

  it('honours an initial sort direction of descending', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 5), { initialSortKey: 'name', initialSortDir: 'desc' })
    await nextTick()
    expect(rowTexts(container)[0]).toContain('script-05.py')
    app.unmount()
  })

  it('renders a custom row testid when provided', async () => {
    const { container, app } = mountTable(sampleRows.slice(0, 2), { rowTestid: (r: Row) => `row-${r.id}` })
    await nextTick()
    expect(container.querySelectorAll('[data-testid="row-1"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="data-table-row"]')).toHaveLength(0)
    app.unmount()
  })
})
