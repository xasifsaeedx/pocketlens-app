import { cn } from '@/lib/utils'

/** The one progress-track recipe: h-2 rounded-full track +
 *  clamped fill. Change bar styling here, nowhere else. `value` is 0–100 and
 *  is clamped so an over-budget value can never overflow the track. */
export function ProgressBar({
  value,
  fillClassName = 'bg-primary',
  trackClassName = 'bg-surface-container-high',
  label,
}: {
  value: number
  /** Fill color class, e.g. bg-primary / bg-secondary / bg-destructive. */
  fillClassName?: string
  trackClassName?: string
  /** Accessible name; when set the bar exposes role="progressbar" + aria values.
   *  Omit for purely decorative bars next to a visible percentage. */
  label?: string
}) {
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full', trackClassName)}
      {...(label
        ? {
            role: 'progressbar',
            'aria-label': label,
            'aria-valuenow': Math.round(pct),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          }
        : { 'aria-hidden': true })}
    >
      <div
        className={cn(
          // Rounded ends + a subtle top-down sheen (background-image over the semantic
          // background-color, so the fill hue is unchanged — no new accent).
          'h-full rounded-full bg-gradient-to-b from-white/20 to-transparent',
          'transition-[width] duration-500 ease-out motion-reduce:transition-none',
          fillClassName,
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
