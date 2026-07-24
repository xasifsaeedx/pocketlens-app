// Small tag pill (name in the tag color @ ~13% bg). Optional onRemove shows an ✕.

import { X } from 'lucide-react'
import type { Tag } from '@/types/domain'

export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
    >
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="-mr-0.5 rounded-full hover:opacity-70"
          aria-label={`Remove ${tag.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}
