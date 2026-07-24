// Shared motion primitives. Both respect the user's "reduce motion" OS setting: when
// reduced, PageTransition renders its children plainly and CountUp shows the final
// value instantly — no animation, no layout shift.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

/**
 * Fades and slightly rises its children in (~250ms) on mount. Wrap each routed page
 * once (the shell does this) so navigation gets a gentle enter transition.
 * Renders a plain wrapper when the user prefers reduced motion.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion()
  if (reduce) return <>{children}</>
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Animates a number from its previous value to `value` over ~600ms ease-out.
 * Hero numbers wrap their value in <CountUp>. Shows the final value instantly when
 * the user prefers reduced motion.
 *
 * @param value   target number to animate to
 * @param format  optional formatter for display (e.g. formatCurrency); defaults to String
 * @param className passthrough class (e.g. "text-hero-number")
 */
export function CountUp({
  value,
  format = (n: number) => String(n),
  className,
}: {
  value: number
  format?: (n: number) => string
  className?: string
}) {
  const reduce = useReducedMotion()
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const frameRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (reduce) {
      setDisplay(value)
      fromRef.current = value
      return
    }
    const from = fromRef.current
    if (from === value) return
    const duration = 600
    const start = performance.now()

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(from + (value - from) * eased)
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = value
      }
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      fromRef.current = value
    }
  }, [value, reduce])

  return (
    <span className={className} aria-label={format(value)}>
      {format(display)}
    </span>
  )
}
