// Create / rename / recolor / re-icon / delete categories — the web counterpart of iOS
// CategoryEditSheet + CategoryListView, in the inline-row style of ManageTagsDialog.
// Rename saves on blur or Enter; the color swatch cycles the palette; clicking the icon
// tile expands an icon grid for that row. Deleting cascades budgets/ZBB/split rows and
// leaves the category's transactions uncategorized, so it confirms first.

import { useRef, useState } from 'react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CategoryIcon } from './CategoryIcon'
import { IconPicker } from './IconPicker'
import {
  useCategories,
  useDeleteCategory,
  useReorderCategories,
  useUpsertCategory,
  useUpsertTag,
} from '@/data/hooks'
import { categoryHasSplits } from '@/data/categories'
import { TAG_PALETTE } from '@/lib/tagColors'
import type { Category } from '@/types/domain'

/** Move the item at `from` to `to` in a fresh copy (drag / keyboard reorder). */
function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

// Same input/focus recipe as ManageTagsDialog (search-input focus ring).
const inputClass =
  'flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'

const roundButtonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none'

export function ManageCategoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data: categories = [] } = useCategories()
  const upsert = useUpsertCategory()
  const upsertTag = useUpsertTag()
  const del = useDeleteCategory()
  const reorder = useReorderCategories()
  const [newName, setNewName] = useState('')
  // The add-row can create a category (name + color + icon) or a free-form tag (name +
  // color only), mirroring the Category/Tag toggle on iOS's budget new-category modal.
  const [addMode, setAddMode] = useState<'category' | 'tag'>('category')
  const [iconPickerFor, setIconPickerFor] = useState<string | null>(null)

  // Drag/keyboard reorder keeps only the ORDER (a list of ids) as local state; the rows
  // themselves are always derived fresh from `categories`, so a rename/recolor shows
  // immediately and there's no derived-state sync effect to loop. Ids the local order
  // hasn't seen yet (a just-added category) fall in at the end.
  const [order, setOrder] = useState<string[]>([])
  const dragId = useRef<string | null>(null)

  const byId = new Map(categories.map((c) => [c.id, c]))
  const orderedIds = [
    ...order.filter((id) => byId.has(id)),
    ...categories.filter((c) => !order.includes(c.id)).map((c) => c.id),
  ]
  const items = orderedIds.map((id) => byId.get(id)!)

  function persist(ids: string[]) {
    const serverIds = categories.map((c) => c.id)
    if (ids.some((id, i) => id !== serverIds[i])) reorder.mutate(ids.map((id) => byId.get(id)!))
  }

  function reorderDuringDrag(overId: string) {
    const id = dragId.current
    if (!id || id === overId) return
    const from = orderedIds.indexOf(id)
    const to = orderedIds.indexOf(overId)
    if (from === -1 || to === -1 || from === to) return
    setOrder(moveItem(orderedIds, from, to))
  }

  function moveByKeyboard(id: string, dir: -1 | 1) {
    const from = orderedIds.indexOf(id)
    const to = from + dir
    if (from === -1 || to < 0 || to >= orderedIds.length) return
    const next = moveItem(orderedIds, from, to)
    setOrder(next)
    persist(next)
  }

  function save(cat: Category, patch: Partial<Category>) {
    upsert.mutate({ id: cat.id, name: cat.name, color: cat.color, icon: cat.icon, ...patch })
  }

  function rename(cat: Category, name: string) {
    const trimmed = name.trim()
    if (!trimmed || trimmed === cat.name) return
    save(cat, { name: trimmed })
  }

  function cycleColor(cat: Category) {
    const i = TAG_PALETTE.indexOf(cat.color)
    save(cat, { color: TAG_PALETTE[(i + 1) % TAG_PALETTE.length] })
  }

  function addCategory() {
    const name = newName.trim()
    if (!name) return
    const color = TAG_PALETTE[categories.length % TAG_PALETTE.length]
    if (addMode === 'tag') {
      // Tags are name + color only — no icon, no budget, no sort order.
      upsertTag.mutate(
        { name, color },
        { onError: () => toast.error(`Couldn't create tag "${name}". Please try again.`) },
      )
    } else {
      upsert.mutate({ name, color, icon: 'tag.fill', sort_order: categories.length })
    }
    setNewName('')
  }

  async function remove(cat: Category) {
    // A category used by a split leg can't be deleted: the cascade drops one leg and
    // the deferred split_sum_balanced trigger rolls the whole delete back at COMMIT.
    // Block it up front with an actionable message instead of failing silently.
    let hasSplits = false
    try {
      hasSplits = await categoryHasSplits(cat.id)
    } catch {
      toast.error(`Couldn't check "${cat.name}" before deleting. Please try again.`)
      return
    }
    if (hasSplits) {
      toast.error(
        `Can't delete "${cat.name}" — it's used in split transactions. Edit those splits first.`,
      )
      return
    }
    if (
      window.confirm(
        `Delete "${cat.name}"? Its transactions become uncategorized and its budgets are removed. This can't be undone.`,
      )
    )
      del.mutate(cat.id, {
        onError: () => toast.error(`Couldn't delete "${cat.name}". Please try again.`),
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            Manage categories
          </DialogTitle>
        </DialogHeader>

        {/* Scrollable category list — grows to fill available space, never pushes the footer off screen */}
        <div className="min-w-0 flex-1 overflow-y-auto space-y-2 pr-1">
          {categories.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">No categories yet.</p>
          )}
          {items.map((c) => (
            <div
              key={c.id}
              onDragOver={(e) => {
                if (dragId.current) {
                  e.preventDefault()
                  reorderDuringDrag(c.id)
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                dragId.current = null
                persist(orderedIds)
              }}
            >
              <div className="flex items-center gap-2 rounded-lg p-1">
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    dragId.current = c.id
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    dragId.current = null
                    persist(orderedIds)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      moveByKeyboard(c.id, -1)
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      moveByKeyboard(c.id, 1)
                    }
                  }}
                  className={`${roundButtonClass} cursor-grab text-muted-foreground hover:bg-surface-variant active:cursor-grabbing`}
                  aria-label={`Reorder ${c.name}. Use arrow up and down to move.`}
                >
                  <GripVertical aria-hidden className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setIconPickerFor(iconPickerFor === c.id ? null : c.id)}
                  className={`${roundButtonClass} hover:bg-surface-variant`}
                  aria-label={`Change ${c.name} icon`}
                >
                  <CategoryIcon category={c} size={28} />
                </button>
                <button
                  type="button"
                  onClick={() => cycleColor(c)}
                  className={`${roundButtonClass} hover:bg-surface-variant`}
                  aria-label={`Change ${c.name} color`}
                >
                  <span
                    aria-hidden
                    className="h-5 w-5 rounded-full border border-outline-variant/60"
                    style={{ backgroundColor: c.color }}
                  />
                </button>
                <input
                  defaultValue={c.name}
                  onBlur={(e) => rename(c, e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => void remove(c)}
                  className={`${roundButtonClass} text-muted-foreground hover:bg-error-container hover:text-destructive`}
                  aria-label={`Delete ${c.name}`}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                </button>
              </div>
              {iconPickerFor === c.id && (
                <div className="mt-2">
                  <IconPicker
                    value={c.icon}
                    color={c.color}
                    onSelect={(symbol) => {
                      save(c, { icon: symbol })
                      setIconPickerFor(null)
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Pinned footer — always visible, never scrolls away */}
        <div className="shrink-0 space-y-2 border-t border-border/40 pt-3">
          {/* Category / Tag toggle — tags are name + color only (no icon, no budget). */}
          <div className="inline-flex gap-1 rounded-full bg-surface-container p-1">
            {(['category', 'tag'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setAddMode(m)}
                aria-pressed={addMode === m}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none ${
                  addMode === m
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCategory()}
              placeholder={addMode === 'tag' ? 'New tag…' : 'New category…'}
              className={inputClass}
            />
            <button
              type="button"
              onClick={addCategory}
              disabled={!newName.trim()}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50 motion-reduce:transition-none"
            >
              <Plus aria-hidden className="h-4 w-4" /> Add
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
