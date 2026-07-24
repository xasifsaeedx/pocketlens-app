// Saved views for the transactions list: load a named filter set, save the current one,
// or delete one. Filter state (category + tag ids) persists to Supabase via saved_views,
// so views follow the user across devices. See data/savedViews.ts.

import { useState } from 'react'
import { Bookmark, Check, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCreateSavedView, useDeleteSavedView, useSavedViews } from '@/data/hooks'
import type { SavedViewParams, UUID } from '@/types/domain'

export function SavedViewsMenu({
  categoryIds,
  tagIds,
  onApply,
}: {
  categoryIds: Set<UUID>
  tagIds: Set<UUID>
  onApply: (params: SavedViewParams) => void
}) {
  const { data: views = [] } = useSavedViews()
  const create = useCreateSavedView()
  const del = useDeleteSavedView()
  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState('')

  const activeCount = categoryIds.size + tagIds.size

  function save() {
    const trimmed = name.trim()
    if (!trimmed) return
    create.mutate(
      { name: trimmed, params: { categoryIds: [...categoryIds], tagIds: [...tagIds] } },
      {
        onSuccess: () => {
          setName('')
          setSaveOpen(false)
        },
        onError: (e: unknown) => {
          // 23505 = unique (user_id, name) violation.
          const code = (e as { code?: string })?.code
          toast.error(
            code === '23505'
              ? `A view named “${trimmed}” already exists.`
              : 'Could not save view.',
          )
        },
      },
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Saved views"
            className="flex items-center gap-2 card-surface border border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Bookmark aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">Views</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {views.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</p>
          ) : (
            views.map((v) => {
              const count =
                (v.params?.categoryIds?.length ?? 0) + (v.params?.tagIds?.length ?? 0)
              return (
                <DropdownMenuItem
                  key={v.id}
                  className="flex items-center gap-2"
                  onSelect={() =>
                    onApply({
                      categoryIds: v.params?.categoryIds ?? [],
                      tagIds: v.params?.tagIds ?? [],
                    })
                  }
                >
                  <span className="flex-1 truncate">{v.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {count === 0 ? 'All' : count}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete view ${v.name}`}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      del.mutate(v.id)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuItem>
              )
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              setSaveOpen(true)
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Save current filters
            <span className="ml-auto text-xs text-muted-foreground">
              {activeCount === 0 ? 'none' : activeCount}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {activeCount === 0
              ? 'No filters are active — this view will show everything.'
              : `Saves ${categoryIds.size} category and ${tagIds.size} tag filter${
                  tagIds.size === 1 ? '' : 's'
                }.`}
          </p>
          <div className="flex gap-2 pt-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder="View name…"
              className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={save}
              disabled={!name.trim() || create.isPending}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
            >
              <Check className="h-4 w-4" /> Save
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
