// Tags CRUD + transaction<->tag join, direct PostgREST. No iOS mirror yet (web-first);
// the schema (tags + transaction_tags) is shared so iOS can adopt it later unchanged.

import { supabase } from '@/lib/supabase'
import type { Tag, UUID } from '@/types/domain'

export async function fetchTags(): Promise<Tag[]> {
  const { data, error } = await supabase
    .from('tags')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as Tag[]
}

export async function upsertTag(
  tag: Partial<Tag> & { name: string; color: string },
): Promise<Tag> {
  // Tag names are unique per user (tags_user_name). On CREATE (no id), a name that
  // already exists would violate that constraint — and with no error surface the new
  // chip just silently never appeared. Instead reuse the existing tag, so typing an
  // existing name attaches that tag (idempotent, like addTagToTransaction). Renames
  // (id present) still upsert by primary key.
  if (!tag.id) {
    const { data: existing } = await supabase
      .from('tags')
      .select('*')
      .eq('name', tag.name)
      .maybeSingle()
    if (existing) return existing as Tag
  }
  const { data, error } = await supabase.from('tags').upsert(tag).select().single()
  if (error) throw error
  return data as Tag
}

export async function deleteTag(id: UUID): Promise<void> {
  const { error } = await supabase.from('tags').delete().eq('id', id)
  if (error) throw error
}

/** Attach a tag to a transaction (idempotent — PK is (transaction_id, tag_id)). */
export async function addTagToTransaction(transactionId: UUID, tagId: UUID): Promise<void> {
  const { error } = await supabase
    .from('transaction_tags')
    .upsert(
      { transaction_id: transactionId, tag_id: tagId },
      { onConflict: 'transaction_id,tag_id' },
    )
  if (error) throw error
}

export async function removeTagFromTransaction(
  transactionId: UUID,
  tagId: UUID,
): Promise<void> {
  const { error } = await supabase
    .from('transaction_tags')
    .delete()
    .eq('transaction_id', transactionId)
    .eq('tag_id', tagId)
  if (error) throw error
}
