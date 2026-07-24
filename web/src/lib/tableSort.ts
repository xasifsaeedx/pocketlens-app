export type SortDir = 'asc' | 'desc'

export type ColumnSortState = { key: string; dir: SortDir }

export function cycleSort(prev: ColumnSortState | null, key: string): ColumnSortState {
  if (!prev || prev.key !== key) return { key, dir: 'asc' }
  return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
}

/** Sort rows that are plain string-keyed records (e.g. API rows). */
export function sortByColumn<T extends Record<string, unknown>>(
  rows: T[],
  sort: ColumnSortState | null,
  numericKeys: readonly string[] = [],
): T[] {
  if (!sort || rows.length === 0) return rows
  const mult = sort.dir === 'asc' ? 1 : -1
  const key = sort.key
  const isNum = numericKeys.includes(key)
  return [...rows].sort((a, b) => {
    const va = a[key]
    const vb = b[key]
    if (isNum) return (Number(va) - Number(vb)) * mult
    return (
      String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * mult
    )
  })
}

export function sortBySelector<T>(
  rows: T[],
  sort: ColumnSortState | null,
  selectors: Record<string, (row: T) => string | number>,
): T[] {
  if (!sort || rows.length === 0) return rows
  const get = selectors[sort.key]
  if (!get) return rows
  const mult = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = get(a)
    const vb = get(b)
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * mult
  })
}

/** True if every non-empty value in the column parses as a finite number. */
export function columnLooksNumeric(rows: Record<string, unknown>[], key: string): boolean {
  if (rows.length === 0) return false
  let seen = 0
  for (const r of rows) {
    const v = r[key]
    if (v === '' || v == null) continue
    seen++
    if (!Number.isFinite(Number(v))) return false
  }
  return seen > 0
}
