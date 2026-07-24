// Client-side CSV parsing for the transaction importer (WEB-12). No FastAPI — the file is
// parsed in the browser and rows are inserted straight into Supabase (see
// data/transactions.ts importTransactions). Small hand-rolled RFC-4180-ish parser so we
// don't pull in a dependency for one page.

export interface ParsedCsv {
  headers: string[]
  /** Data rows (header row excluded), each aligned to `headers` by index. */
  rows: string[][]
}

/** Parse CSV text into headers + rows. Handles quoted fields, embedded commas/newlines,
 *  "" escapes, CRLF or LF, a UTF-8 BOM, and a trailing newline. Ragged rows are padded /
 *  truncated to the header width so `rows[i][col]` is always safe. */
export function parseCsv(text: string): ParsedCsv {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0
  const n = stripped.length

  const endField = () => {
    record.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    records.push(record)
    record = []
  }

  while (i < n) {
    const c = stripped[i]
    if (inQuotes) {
      if (c === '"') {
        if (stripped[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (c === ',') {
      endField()
      i += 1
      continue
    }
    if (c === '\r') {
      // swallow CR; the following LF (if any) closes the record
      if (stripped[i + 1] === '\n') i += 1
      endRecord()
      i += 1
      continue
    }
    if (c === '\n') {
      endRecord()
      i += 1
      continue
    }
    field += c
    i += 1
  }
  // flush trailing field/record if the file didn't end with a newline
  if (field !== '' || record.length > 0) endRecord()

  // Drop a fully-empty trailing record (from a final newline).
  while (records.length > 0) {
    const last = records[records.length - 1]
    if (last.length === 1 && last[0] === '') records.pop()
    else break
  }

  if (records.length === 0) return { headers: [], rows: [] }
  const headers = records[0].map((h) => h.trim())
  const width = headers.length
  const rows = records.slice(1).map((r) => {
    const out = r.slice(0, width)
    while (out.length < width) out.push('')
    return out
  })
  return { headers, rows }
}

/** Parse a money string to a number. Strips currency symbols, thousands separators and
 *  whitespace; treats parentheses as negative (accounting format). Returns NaN if there's
 *  no numeric value. Sign here is the FILE's sign — the importer normalizes to the DB
 *  convention (positive = spend) separately. */
export function parseAmount(raw: string): number {
  let s = raw.trim()
  if (s === '') return NaN
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[$£€,\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  if (s === '' || !/^\d*\.?\d+$/.test(s)) return NaN
  const value = Number(s)
  if (Number.isNaN(value)) return NaN
  return negative ? -value : value
}

/** Parse a date cell to `yyyy-MM-dd`, or null if unrecognized. Accepts ISO (yyyy-MM-dd),
 *  US (M/d/yyyy or M/d/yy), and yyyy/MM/dd. Two-digit years map to 2000-2099. Ambiguous
 *  d/m vs m/d is resolved as US (m/d) unless the first part is > 12. */
export function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (s === '') return null

  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (iso) {
    const [, y, m, d] = iso
    return buildDate(Number(y), Number(m), Number(d))
  }

  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (slash) {
    const [, a, b, y] = slash
    let year = Number(y)
    if (year < 100) year += 2000
    let month = Number(a)
    let day = Number(b)
    // If the first component can't be a month but the second can, it's d/m/y.
    if (month > 12 && day <= 12) {
      ;[month, day] = [day, month]
    }
    return buildDate(year, month, day)
  }

  return null
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

/** Best-guess a header name to a role, so the mapping selects sensible defaults. Returns
 *  the matched header or '' if none looks right. */
export function guessColumn(headers: string[], role: 'date' | 'amount' | 'merchant'): string {
  const patterns: Record<typeof role, RegExp[]> = {
    date: [/^(transaction\s*)?date$/i, /posted/i, /date/i],
    amount: [/^amount$/i, /^amt$/i, /debit/i, /value/i, /amount/i],
    merchant: [/^(description|merchant|name|payee|memo)$/i, /description/i, /merchant/i, /name/i],
  }
  for (const pat of patterns[role]) {
    const hit = headers.find((h) => pat.test(h))
    if (hit) return hit
  }
  return ''
}
