// CSV export — the outbound counterpart to the CSV importer (lib/csv.ts).
// The serialization is pure + unit-tested; downloadCsv is the only browser side effect.
// A file exported here re-imports cleanly through the CSV importer (lib/csv.ts) with its
// default settings (Date/Amount/Merchant column names + "spending shown as negative"), so
// export→edit→import round-trips.

import type { Transaction, UUID } from '@/types/domain'
import { displayName } from '@/types/domain'

/** RFC-4180 field escaping: wrap in double quotes and double any internal quote when the
 *  value contains a comma, quote, CR or LF. Plain values pass through unchanged. */
export function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Serialize a header row + data rows to RFC-4180 CSV text (CRLF line endings). Pure. */
export function rowsToCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const line = (cells: Array<string | number>) => cells.map((c) => escapeCsvField(String(c))).join(',')
  return [line(headers), ...rows.map(line)].join('\r\n')
}

const TXN_HEADERS = ['Date', 'Merchant', 'Category', 'Amount', 'Account', 'Notes'] as const

/** Build a transactions CSV. Amount is written spend-negative / income-positive — the natural
 *  bank-statement sign and the inverse of our DB convention (positive = spend) — so the file
 *  re-imports through the importer's default "spending shown as negative" setting. Category
 *  comes from the embedded relation; Account is resolved from `accountsById` when supplied. */
export function transactionsToCsv(
  txns: Transaction[],
  accountsById?: Map<UUID, { name: string }>,
): string {
  const rows = txns.map((t) => [
    t.effective_date,
    displayName(t),
    t.categories?.name ?? '',
    (-t.amount).toFixed(2),
    accountsById?.get(t.account_id)?.name ?? '',
    t.notes ?? '',
  ])
  return rowsToCsv([...TXN_HEADERS], rows)
}

/** Trigger a client-side download of `content` as `filename` (Blob + object URL). */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
