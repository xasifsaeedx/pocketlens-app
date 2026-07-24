// Day-grouped transaction list used by Dashboard + Transactions. Rows are tappable to
// categorize. Terracotta/sage list-row recipe: circular icon well (terracotta for spend,
// sage for income), merchant + muted meta line, right-aligned signed amount.
// Mirrors iOS TransactionRowView + day grouping.

import { useMemo } from 'react'
import { ArrowLeftRight, EyeOff, Split, Undo2, type LucideIcon } from 'lucide-react'
import { CategoryBadge } from '@/components/finance/CategoryBadge'
import { TagChip } from '@/components/finance/TagChip'
import { Amount } from '@/components/finance/Amount'
import { iconForSymbol } from '@/lib/iconMap'
import { categoryTint } from '@/lib/categoryColors'
import { cn } from '@/lib/utils'
import { dayKey, formatDayHeader } from '@/lib/dates'
import {
  displayName,
  hasSplits,
  isReimbursement,
  isTransfer,
  txnSplits,
  txnTags,
  type Account,
  type Transaction,
  type UUID,
} from '@/types/domain'

export function groupByDay(txns: Transaction[]): [string, Transaction[]][] {
  const groups = new Map<string, Transaction[]>()
  for (const t of txns) {
    const k = dayKey(t.effective_date)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(t)
  }
  // txns arrive newest-first; Map preserves insertion order.
  return [...groups.entries()]
}

function rowIcon(t: Transaction): LucideIcon {
  if (isReimbursement(t)) return Undo2
  if (isTransfer(t)) return ArrowLeftRight
  if (t.hidden) return EyeOff
  if (hasSplits(t)) return Split
  return iconForSymbol(t.categories?.icon)
}

export function TransactionList({
  transactions,
  accounts,
  onSelect,
}: {
  transactions: Transaction[]
  /** Optional lookup map for rendering the account name under each row. */
  accounts?: Map<UUID, Account>
  onSelect?: (t: Transaction) => void
}) {
  const groups = useMemo(() => groupByDay(transactions), [transactions])
  return (
    <div className="space-y-6">
      {groups.map(([day, rows]) => (
        <section key={day}>
          <h2 className="mb-3 text-xl font-medium text-foreground">{formatDayHeader(day)}</h2>
          <div className="overflow-hidden card-surface border border-border">
            {rows.map((t) => {
              // A reimbursement is a credit, but treat it as a contra-expense (not income):
              // no income-toned well, and a distinct badge below.
              const income = t.amount < 0 && !isReimbursement(t)
              const Icon = rowIcon(t)
              const account = accounts?.get(t.account_id)
              const accountLabel = account ? account.name : null
              // Color-code the icon well with the category's own stored hue when the row
              // shows its category icon. Special rows (transfer/reimbursement/hidden/split)
              // keep their neutral/income treatment since their glyph isn't category-derived.
              const special =
                isReimbursement(t) || isTransfer(t) || t.hidden || hasSplits(t)
              const tintColor = !special ? t.categories?.color : null
              return (
                <button
                  key={t.id}
                  onClick={() => onSelect?.(t)}
                  className="group flex w-full items-center gap-4 border-b border-border p-4 text-left transition-colors last:border-b-0 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  <span
                    aria-hidden="true"
                    style={
                      tintColor
                        ? { backgroundColor: categoryTint(tintColor), color: tintColor }
                        : undefined
                    }
                    className={cn(
                      'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
                      !tintColor &&
                        (income
                          ? 'bg-secondary-container text-on-secondary-container'
                          : 'bg-surface-container-low text-primary'),
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
                      {displayName(t)}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                      {isReimbursement(t) ? (
                        <span>
                          Reimbursement
                          {t.categories?.name ? ` · ${t.categories.name}` : ''}
                        </span>
                      ) : isTransfer(t) ? (
                        <span>Transfer</span>
                      ) : t.hidden ? (
                        <span>Hidden</span>
                      ) : hasSplits(t) ? (
                        <>
                          <span>Split</span>
                          {txnSplits(t).map((s) => (
                            <CategoryBadge key={s.id} category={s.categories} />
                          ))}
                        </>
                      ) : (
                        <span className="truncate">{t.categories?.name ?? 'Uncategorized'}</span>
                      )}
                      {txnTags(t).map((tag) => (
                        <TagChip key={tag.id} tag={tag} />
                      ))}
                      {t.pending && (
                        <span className="font-semibold text-warning">Pending</span>
                      )}
                    </div>
                    {accountLabel && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground/60">
                        {accountLabel}
                      </p>
                    )}
                  </div>
                  <Amount value={t.amount} className="shrink-0 text-xl font-semibold" />
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
