// Category icon in a tinted circular well, colored by the category's DB hex (mirrors iOS).

import { iconForSymbol } from '@/lib/iconMap'
import { categoryTint } from '@/lib/categoryColors'
import type { Category } from '@/types/domain'
import { cn } from '@/lib/utils'

export function CategoryIcon({
  category,
  size = 36,
  className,
}: {
  category?: Category | null
  size?: number
  className?: string
}) {
  const Icon = iconForSymbol(category?.icon)
  const color = category?.color ?? '#98989D'
  return (
    <div
      className={cn('flex items-center justify-center rounded-full', className)}
      style={{ width: size, height: size, backgroundColor: categoryTint(color), color }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </div>
  )
}
