// Category chip (icon + name in the category color @ ~12% bg), mirrors iOS CategoryBadge.

import { iconForSymbol } from '@/lib/iconMap'
import { categoryTint } from '@/lib/categoryColors'
import type { Category } from '@/types/domain'

export function CategoryBadge({ category }: { category?: Category | null }) {
  if (!category) {
    return (
      <span className="inline-flex items-center rounded-full bg-surface-container-high px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Uncategorized
      </span>
    )
  }
  const Icon = iconForSymbol(category.icon)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: categoryTint(category.color), color: category.color }}
    >
      <Icon className="h-3 w-3" />
      {category.name}
    </span>
  )
}
