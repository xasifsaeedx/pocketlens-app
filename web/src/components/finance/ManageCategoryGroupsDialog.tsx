// Manage category groups — create, rename, delete groups, and assign/unassign
// categories to each group. Group assignment lives here (not on the category side).
//
// UX layout:
//   • Accordion-style: each group row expands to reveal a category checklist.
//   • Inline rename on blur / Enter (same pattern as ManageTagsDialog).
//   • Delete confirms first since it ungroups any assigned categories.
//   • Add-group form at the bottom.

import { useRef, useState } from 'react'
import { ChevronDown, GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CategoryIcon } from './CategoryIcon'
import {
  useCategories,
  useCategoryGroups,
  useDeleteCategoryGroup,
  useReorderCategoryGroups,
  useSetCategoryGroup,
  useUpsertCategory,
  useUpsertCategoryGroup,
} from '@/data/hooks'
import { TAG_PALETTE } from '@/lib/tagColors'
import { cn } from '@/lib/utils'
import type { CategoryGroup } from '@/types/domain'

// ── Shared styling atoms (mirrors ManageCategoriesDialog / ManageTagsDialog) ──

const inputClass =
  'flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'

const roundButtonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none'

/** Move the item at `from` to `to` in a fresh copy. */
function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function ManageCategoryGroupsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data: groups = [] } = useCategoryGroups()
  const { data: categories = [] } = useCategories()
  const upsert = useUpsertCategoryGroup()
  const del = useDeleteCategoryGroup()
  const reorder = useReorderCategoryGroups()
  const setGroup = useSetCategoryGroup()
  const upsertCategory = useUpsertCategory()

  const [newName, setNewName] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Per-group new-category input state: groupId → draft name
  const [newCatName, setNewCatName] = useState<Record<string, string>>({})

  // Local order for drag-to-reorder (same pattern as ManageCategoriesDialog).
  const [order, setOrder] = useState<string[]>([])
  const dragId = useRef<string | null>(null)

  const byId = new Map(groups.map((g) => [g.id, g]))
  const orderedIds = [
    ...order.filter((id) => byId.has(id)),
    ...groups.filter((g) => !order.includes(g.id)).map((g) => g.id),
  ]
  const items = orderedIds.map((id) => byId.get(id)!)

  function persist(ids: string[]) {
    const serverIds = groups.map((g) => g.id)
    if (ids.some((id, i) => id !== serverIds[i]))
      reorder.mutate(ids.map((id) => byId.get(id)!))
  }

  function reorderDuringDrag(overId: string) {
    const id = dragId.current
    if (!id || id === overId) return
    const from = orderedIds.indexOf(id)
    const to = orderedIds.indexOf(overId)
    if (from === -1 || to === -1 || from === to) return
    setOrder(moveItem(orderedIds, from, to))
  }

  function rename(group: CategoryGroup, name: string) {
    const trimmed = name.trim()
    if (!trimmed || trimmed === group.name) return
    upsert.mutate({ id: group.id, name: trimmed })
  }

  function addGroup() {
    const name = newName.trim()
    if (!name) return
    upsert.mutate(
      { name, sort_order: groups.length },
      {
        onSuccess: (created) => {
          setNewName('')
          setExpandedId(created.id)
        },
      },
    )
  }

  function remove(group: CategoryGroup) {
    const assigned = categories.filter((c) => c.group_id === group.id).length
    const detail =
      assigned > 0
        ? ` ${assigned} ${assigned === 1 ? 'category' : 'categories'} will become ungrouped.`
        : ''
    if (window.confirm(`Delete group "${group.name}"?${detail}`)) {
      del.mutate(group.id)
      if (expandedId === group.id) setExpandedId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] w-full max-w-md overflow-x-hidden overflow-y-auto rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            Manage category groups
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-2">
          {items.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">No groups yet.</p>
          )}

          {items.map((g) => {
            const isExpanded = expandedId === g.id
            const assigned = categories.filter((c) => c.group_id === g.id)

            return (
              <div
                key={g.id}
                onDragOver={(e) => {
                  if (dragId.current) {
                    e.preventDefault()
                    reorderDuringDrag(g.id)
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  dragId.current = null
                  persist(orderedIds)
                }}
              >
                {/* Group header row */}
                <div className="flex items-center gap-2 rounded-lg p-1">
                  {/* Drag handle */}
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      dragId.current = g.id
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      dragId.current = null
                      persist(orderedIds)
                    }}
                    className={`${roundButtonClass} cursor-grab text-muted-foreground hover:bg-surface-variant active:cursor-grabbing`}
                    aria-label={`Reorder ${g.name}`}
                  >
                    <GripVertical aria-hidden className="h-4 w-4" />
                  </button>

                  {/* Inline rename */}
                  <input
                    defaultValue={g.name}
                    key={g.name} // reset when renamed from outside
                    aria-label={`Rename group ${g.name}`}
                    onBlur={(e) => rename(g, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    className={inputClass}
                  />

                  {/* Category count badge */}
                  {assigned.length > 0 && (
                    <span
                      className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                      aria-label={`${assigned.length} ${assigned.length === 1 ? 'category' : 'categories'}`}
                    >
                      {assigned.length}
                    </span>
                  )}

                  {/* Expand / collapse toggle */}
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : g.id)}
                    className={`${roundButtonClass} text-muted-foreground hover:bg-surface-variant`}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? `Collapse ${g.name}` : `Expand ${g.name} to assign categories`}
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn('h-4 w-4 transition-transform motion-reduce:transition-none', isExpanded && 'rotate-180')}
                    />
                  </button>

                  {/* Delete */}
                  <button
                    type="button"
                    onClick={() => remove(g)}
                    className={`${roundButtonClass} text-muted-foreground hover:bg-error-container hover:text-destructive`}
                    aria-label={`Delete group ${g.name}`}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </button>
                </div>

                {/* Category checklist — shown when expanded */}
                {isExpanded && (
                  <div className="ml-11 mt-1 rounded-xl bg-surface-container p-3 space-y-1">
                    {/* New category row — always at the top so it's never buried */}
                    <div className="flex gap-2 pb-2 mb-1 border-b border-border/40">
                      <input
                        value={newCatName[g.id] ?? ''}
                        onChange={(e) =>
                          setNewCatName((prev) => ({ ...prev, [g.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const name = (newCatName[g.id] ?? '').trim()
                            if (!name) return
                            upsertCategory.mutate(
                              { name, color: TAG_PALETTE[0], icon: 'tag.fill', group_id: g.id },
                              { onSuccess: () => setNewCatName((prev) => ({ ...prev, [g.id]: '' })) },
                            )
                          }
                        }}
                        placeholder="New category…"
                        aria-label={`New category in ${g.name}`}
                        className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                      />
                      <Button
                        type="button"
                        variant="pill"
                        size="pill"
                        disabled={!(newCatName[g.id] ?? '').trim() || upsertCategory.isPending}
                        onClick={() => {
                          const name = (newCatName[g.id] ?? '').trim()
                          if (!name) return
                          upsertCategory.mutate(
                            { name, color: TAG_PALETTE[0], icon: 'tag.fill', group_id: g.id },
                            { onSuccess: () => setNewCatName((prev) => ({ ...prev, [g.id]: '' })) },
                          )
                        }}
                        className="gap-1 text-xs"
                      >
                        <Plus aria-hidden className="h-3 w-3" /> Create
                      </Button>
                    </div>

                    {/* Scrollable category list — capped so it never blows out the modal */}
                    <div className="max-h-48 overflow-y-auto space-y-0.5">
                      {categories.length === 0 ? (
                        <p className="text-xs text-muted-foreground px-2 py-1">No categories yet.</p>
                      ) : (
                        categories.map((c) => {
                          const checked = c.group_id === g.id
                          return (
                            <label
                              key={c.id}
                              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-variant motion-reduce:transition-none"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setGroup.mutate({
                                    categoryId: c.id,
                                    groupId: checked ? null : g.id,
                                  })
                                }
                                className="h-4 w-4 shrink-0 accent-primary"
                                aria-label={`${checked ? 'Remove' : 'Add'} ${c.name} ${checked ? 'from' : 'to'} ${g.name}`}
                              />
                              <CategoryIcon category={c} size={20} />
                              <span className="flex-1 text-sm text-foreground">{c.name}</span>
                              {c.group_id != null && c.group_id !== g.id && (
                                <span className="text-xs text-muted-foreground">
                                  {byId.get(c.group_id)?.name ?? 'other group'}
                                </span>
                              )}
                            </label>
                          )
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Add group */}
          <div className="flex gap-2 pt-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addGroup()}
              placeholder="New group…"
              aria-label="New group name"
              className={inputClass}
            />
            <Button
              type="button"
              variant="pill"
              size="pill"
              onClick={addGroup}
              disabled={!newName.trim()}
              className="gap-1"
            >
              <Plus aria-hidden className="h-4 w-4" /> Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
