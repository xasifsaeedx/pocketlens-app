// Keyboard-driven categorize review — mirrors PocketLens/Views/Transactions/CategorizeReviewSheet.swift.
// Card stack over the uncategorized queue (snapshotted on open so it doesn't
// shrink as we advance). Arrow right = confirm guess (+learn), left = skip, tap chip = pick.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion'
import { ArrowDown, ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CategoryIcon } from '@/components/finance/CategoryIcon'
import { CategoryPickerDialog } from '@/components/finance/CategoryPickerDialog'
import { useCategories, useMerchantMemory, useRules, useSetCategory } from '@/data/hooks'
import { suggest } from '@/lib/categorySuggester'
import { categorySeriesColor, categoryTint } from '@/lib/categoryColors'
import { displayName, type Category, type Transaction, type UUID } from '@/types/domain'
import { formatAmount } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'

const FLY_OFF_X = 480

export function CategorizeReview({
  queue,
  open,
  onOpenChange,
}: {
  queue: Transaction[]
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  // Snapshot once so the stack length is stable as the index advances.
  const [cards] = useState<Transaction[]>(queue)
  const [index, setIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [overrides, setOverrides] = useState<Record<UUID, UUID | null>>({})

  const reduce = useReducedMotion()
  const { data: categories = [] } = useCategories()
  const { data: memory = {} } = useMerchantMemory()
  const { data: rules = [] } = useRules()
  const setCategory = useSetCategory()

  const current = cards[index] as Transaction | undefined

  const guess: Category | null = useMemo(() => {
    if (!current) return null
    const override = overrides[current.id]
    if (override !== undefined) {
      return categories.find((c) => c.id === override) ?? null
    }
    return suggest(current, memory, rules, categories)
  }, [current, overrides, categories, memory, rules])

  const x = useMotionValue(0)
  const rotate = useTransform(x, [-200, 200], [-12, 12])
  const confirmOpacity = useTransform(x, [30, 130], [0, 1])
  const skipOpacity = useTransform(x, [-130, -30], [1, 0])

  // Fly the current card off in `direction` (+1 right / -1 left), then swap in the next.
  // Respects reduce-motion (advances instantly) so we never strand a half-flown card.
  async function advance(direction: 1 | -1) {
    if (!reduce) {
      await new Promise<void>((resolve) => {
        animate(x, direction * FLY_OFF_X, {
          duration: 0.28,
          ease: 'easeIn',
          onComplete: resolve,
        })
      })
    }
    x.set(0)
    setIndex((i) => i + 1)
  }

  function confirm() {
    // Fire the save and let the card fly off in parallel — the network shouldn't gate the UI.
    if (current && guess) setCategory.mutate({ txn: current, categoryId: guess.id })
    void advance(1)
  }

  function skip() {
    void advance(-1)
  }

  // Arrow key navigation — only active when the picker isn't open.
  const done = index >= cards.length

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (pickerOpen || done) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (guess) confirm()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        skip()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPickerOpen(true)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickerOpen, done, guess, current],
  )

  useEffect(() => {
    if (!open) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleKeyDown])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-visible">
        {done ? (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary/10 text-secondary">
              <Check className="h-7 w-7" />
            </div>
            <p className="text-lg font-semibold">All caught up</p>
            <p className="text-sm text-muted-foreground">
              Reviewed {cards.length} transaction{cards.length === 1 ? '' : 's'}.
            </p>
            <Button className="rounded-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-5 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              {index + 1} of {cards.length}
            </p>

            <motion.div
              key={current!.id}
              style={{ x, rotate }}
              className="relative w-full rounded-xl bg-card p-6 shadow-elevated"
            >
              <motion.div
                style={{ opacity: confirmOpacity }}
                className="absolute left-4 top-4 rounded-md border-2 border-secondary px-2 py-1 text-sm font-bold text-secondary"
              >
                CONFIRM
              </motion.div>
              <motion.div
                style={{ opacity: skipOpacity }}
                className="absolute right-4 top-4 rounded-md border-2 border-destructive px-2 py-1 text-sm font-bold text-destructive"
              >
                SKIP
              </motion.div>

              <div className="flex flex-col items-center gap-1 pt-6 text-center">
                <p className="text-lg font-semibold">{displayName(current!)}</p>
                <p className="text-sm text-muted-foreground">
                  {formatShortDate(current!.effective_date)} ·{' '}
                  <span
                    className="font-semibold tabular-nums"
                    style={{ color: categorySeriesColor(guess) }}
                  >
                    {formatAmount(current!.amount)}
                  </span>
                </p>
              </div>

              <button
                onClick={() => setPickerOpen(true)}
                className="mx-auto mt-5 flex items-center gap-2 rounded-full bg-surface-container-low px-3 py-1.5 text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{
                  backgroundColor: guess ? categoryTint(guess.color) : undefined,
                  color: guess?.color,
                }}
              >
                <CategoryIcon category={guess} size={24} />
                <span className="text-sm font-medium">
                  {guess?.name ?? 'Choose category'}
                </span>
              </button>
            </motion.div>

            <div className="flex items-center gap-6">
              <Button
                variant="outline"
                size="icon"
                aria-label="Skip"
                className="h-12 w-12 rounded-full border-destructive text-destructive"
                onClick={skip}
              >
                <X className="h-5 w-5" />
              </Button>
              <Button
                size="icon"
                aria-label="Confirm"
                className="h-12 w-12 rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/90"
                onClick={confirm}
                disabled={!guess}
              >
                <Check className="h-5 w-5" />
              </Button>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>skip</span>
              <span className="mx-1 opacity-40">·</span>
              <ArrowRight className="h-3.5 w-3.5" />
              <span>confirm</span>
              <span className="mx-1 opacity-40">·</span>
              <ArrowDown className="h-3.5 w-3.5" />
              <span>change category</span>
            </p>
          </div>
        )}

        <CategoryPickerDialog
          txn={current ?? null}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={(cid) => {
            if (current) setOverrides((o) => ({ ...o, [current.id]: cid }))
            setPickerOpen(false)
          }}
          // Hidden = handled: the txn left the queue server-side; drop its card too.
          onToggleHidden={() => void advance(1)}
        />
      </DialogContent>
    </Dialog>
  )
}
