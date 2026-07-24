// Transaction amount, signed per the terracotta/sage design language: expenses render
// as neutral dark text ("-$6.50"), income as sage ("+$3,200.00"). The sign is kept so
// income/expense is never conveyed by color alone. (iOS AmountText.)

import { amountColorClass, formatAmount, isDebit } from '@/lib/money'
import { cn } from '@/lib/utils'

export function Amount({
  value,
  currency = 'USD',
  className,
}: {
  value: number
  currency?: string
  className?: string
}) {
  const sign = value === 0 ? '' : isDebit(value) ? '-' : '+'
  return (
    <span className={cn('tabular-nums', amountColorClass(value), className)}>
      {sign}
      {formatAmount(value, currency)}
    </span>
  )
}
