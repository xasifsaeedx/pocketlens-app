// Create / rename / recolor / delete tags. Rename saves on blur or Enter; the color
// swatch cycles the palette. Deleting a tag cascades its transaction_tags rows.
// Terracotta/sage recipe.

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteTag, useTags, useUpsertTag } from '@/data/hooks'
import { TAG_PALETTE } from '@/lib/tagColors'
import type { Tag } from '@/types/domain'

const inputClass =
  'flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'

export function ManageTagsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data: tags = [] } = useTags()
  const upsert = useUpsertTag()
  const del = useDeleteTag()
  const [newName, setNewName] = useState('')

  function rename(tag: Tag, name: string) {
    const trimmed = name.trim()
    if (!trimmed || trimmed === tag.name) return
    upsert.mutate({ id: tag.id, name: trimmed, color: tag.color })
  }

  function cycleColor(tag: Tag) {
    const i = TAG_PALETTE.indexOf(tag.color)
    const color = TAG_PALETTE[(i + 1) % TAG_PALETTE.length]
    upsert.mutate({ id: tag.id, name: tag.name, color })
  }

  function addTag() {
    const name = newName.trim()
    if (!name) return
    const color = TAG_PALETTE[tags.length % TAG_PALETTE.length]
    upsert.mutate({ name, color })
    setNewName('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            Manage tags
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {tags.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">No tags yet.</p>
          )}
          {tags.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-lg p-1">
              <button
                type="button"
                onClick={() => cycleColor(t)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none"
                aria-label={`Change color of ${t.name}`}
              >
                <span
                  aria-hidden
                  className="h-5 w-5 rounded-full border border-outline-variant/60"
                  style={{ backgroundColor: t.color }}
                />
              </button>
              <input
                defaultValue={t.name}
                aria-label={`Rename ${t.name}`}
                onBlur={(e) => rename(t, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => del.mutate(t.id)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-error-container hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none"
                aria-label={`Delete ${t.name}`}
              >
                <Trash2 aria-hidden className="h-4 w-4" />
              </button>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag()}
              placeholder="New tag…"
              aria-label="New tag name"
              className={inputClass}
            />
            <Button
              type="button"
              variant="pill"
              size="pill"
              onClick={addTag}
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
