// Postgres `date`-only columns come back as "yyyy-MM-dd" strings with NO timezone.
// `new Date("2026-06-15")` parses as UTC midnight, which renders as the *previous*
// day in timezones behind UTC — the exact bug the iOS app fixes with a custom decoder
// (PocketLens/Config/Supabase.swift:8-42). Parse these as LOCAL midnight instead.

/** Parse a "yyyy-MM-dd" (or ISO timestamp) string as a local Date. */
export function parseLocalDate(s: string): Date {
  // Date-only → construct in local time.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  }
  // Full timestamp → let the engine parse (it carries a zone / is UTC).
  return new Date(s)
}

/** Format a Date as "yyyy-MM-dd" in local time (inverse of parseLocalDate). */
export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

/** Signed whole days from `aISO` to `bISO` (local-midnight parse; rounding absorbs
 *  DST). Shared by recurring-cadence detection and transfer matching. */
export function daysBetween(aISO: string, bISO: string): number {
  const a = parseLocalDate(aISO).getTime()
  const b = parseLocalDate(bISO).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** First and last day (inclusive) of the month containing `d`, as "yyyy-MM-dd". */
export function monthBounds(d: Date): { start: string; end: string } {
  const start = new Date(d.getFullYear(), d.getMonth(), 1)
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { start: toISODate(start), end: toISODate(end) }
}

/** Stable per-day grouping key ("yyyy-MM-dd") for a date-only string. */
export function dayKey(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : dateStr
}

/** "Wednesday, June 15" style header for a day group. */
export function formatDayHeader(dateStr: string): string {
  return parseLocalDate(dateStr).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/** "Jun 15" short label. */
export function formatShortDate(dateStr: string): string {
  return parseLocalDate(dateStr).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** "June 2026" month label. */
export function formatMonthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "5 minutes ago" / "yesterday" style label for a full ISO timestamp (e.g. an
 *  activity_log created_at). Steps up through the largest fitting unit. */
export function formatRelativeTime(iso: string): string {
  const diffSec = Math.round((new Date(iso).getTime() - Date.now()) / 1000) // <0 = past
  const abs = Math.abs(diffSec)
  if (abs < 60) return relativeFmt.format(diffSec, 'second')
  if (abs < 3600) return relativeFmt.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return relativeFmt.format(Math.round(diffSec / 3600), 'hour')
  const diffDay = Math.round(diffSec / 86_400)
  if (Math.abs(diffDay) < 30) return relativeFmt.format(diffDay, 'day')
  if (Math.abs(diffDay) < 365) return relativeFmt.format(Math.round(diffDay / 30), 'month')
  return relativeFmt.format(Math.round(diffDay / 365), 'year')
}
