// Circular icon well for budget rows — uses the category's own color tint,
// matching CategoryIcon (components/finance) and the iOS design.

import { createElement } from 'react'
import { iconForSymbol } from '@/lib/iconMap'
import type { Category } from '@/types/domain'
import { categorySeriesColor, categoryTint } from '@/lib/categoryColors'
import { cn } from '@/lib/utils'

export function CategoryIconWell({
  category,
  className,
}: {
  category: Category
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
        className,
      )}
      style={{
        backgroundColor: categoryTint(category.color),
        color: categorySeriesColor(category),
      }}
    >
      {createElement(iconForSymbol(category.icon), { className: 'h-5 w-5' })}
    </div>
  )
}
