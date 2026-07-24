// Toggle tags on one transaction + inline-create a new tag. Local attached-set so the
// UI responds instantly (the txn snapshot passed in doesn't refetch while the dialog is open).

import { useState } from 'react'
import { Plus } from 'lucide-react'
import {
  useApplyTagRuleToTransaction,
  useTagRules,
  useTags,
  useToggleTransactionTag,
  useUpsertTag,
} from '@/data/hooks'
import { TAG_PALETTE } from '@/lib/tagColors'
import { txnTags, type Transaction } from '@/types/domain'

// Caller keys this by txn.id, so the initial attached-set is seeded once per transaction.
export function TxnTagEditor({ txn }: { txn: Transaction }) {
  const { data: tags = [] } = useTags()
  const { data: tagRules = [] } = useTagRules()
  const toggle = useToggleTransactionTag()
  const applyRule = useApplyTagRuleToTransaction()
  const upsert = useUpsertTag()
  const [attached, setAttached] = useState<Set<string>>(
    () => new Set(txnTags(txn).map((t) => t.id)),
  )
  const [newName, setNewName] = useState('')

  function toggleTag(tagId: string) {
    const attach = !attached.has(tagId)
    setAttached((prev) => {
      const next = new Set(prev)
      if (attach) next.add(tagId)
      else next.delete(tagId)
      return next
    })
    toggle.mutate(
      { transactionId: txn.id, tagId, attach },
      {
        onSuccess: () => {
          // attaching a tag with a rule sets the txn's category (only on attach).
          if (!attach) return
          const rule = tagRules.find((r) => r.tag_id === tagId)
          if (rule && rule.category_id !== txn.category_id)
            applyRule.mutate({ transactionId: txn.id, categoryId: rule.category_id })
        },
      },
    )
  }

  async function createAndAttach() {
    const name = newName.trim()
    if (!name) return
    const color = TAG_PALETTE[tags.length % TAG_PALETTE.length]
    const tag = await upsert.mutateAsync({ name, color })
    setNewName('')
    toggleTag(tag.id)
  }

  return (
    <div className="mt-1 space-y-2">
      <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Tags
      </p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => {
          const on = attached.has(t.id)
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => toggleTag(t.id)}
              className="rounded-full border px-2 py-0.5 text-xs font-medium transition"
              style={
                on
                  ? { backgroundColor: `${t.color}22`, color: t.color, borderColor: t.color }
                  : { color: t.color, borderColor: 'hsl(var(--border))' }
              }
            >
              {t.name}
            </button>
          )
        })}
      </div>
      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createAndAttach()}
          placeholder="New tag…"
          className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="button"
          onClick={createAndAttach}
          disabled={!newName.trim()}
          className="flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
    </div>
  )
}
