/**
 * Column definition for the generic DataTable component.
 *
 * Consumers keep a strongly-typed array (e.g. `DataTableColumn<Script>[]`);
 * the component itself treats rows/columns as opaque.
 */
export interface DataTableColumn<T = unknown> {
  /** Stable key: used for v-for keys, slot names, sort state, and testids. */
  key: string
  /** Header text. */
  label: string
  /** Clicking the header toggles asc/desc. Defaults to false. */
  sortable?: boolean
  /** Column participates in the search filter. Defaults to true. */
  searchable?: boolean
  /** Reads the cell value from a row; defaults to `row[col.key]`. */
  value?: (row: T) => unknown
  /** Overrides the value used for sorting (e.g. numeric/date for a string cell). */
  sortValue?: (row: T) => string | number | null
  /** Overrides the text searched for this column. */
  searchValue?: (row: T) => string
  /** Optional native tooltip text bound to every <td> of this column. */
  cellTitle?: (row: T) => string | undefined
  /** Extra classes on the <th>. */
  headerClass?: string
  /** Extra classes on every <td> of this column. */
  cellClass?: string
}
