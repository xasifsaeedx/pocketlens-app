// Tag→category rules: attaching a tag to a transaction sets that txn's category.
// The web counterpart of the keyword rules in data/categories.ts. Direct PostgREST via
// supabase-js. `user_id` defaults to auth.uid() in the DB — never sent from the client.

import { supabase } from '@/lib/supabase'
import type { TagCategoryRule, UUID } from '@/types/domain'
import { AUTO_CATEGORIZE_CHUNK, chunk, updateCategory } from './transactions'

export async function fetchTagRules(): Promise<TagCategoryRule[]> {
  const { data, error } = await supabase
    .from('tag_category_rules')
    .select('id, tag_id, category_id')
  if (error) throw error
  return (data ?? []) as TagCategoryRule[]
}

/** Create (or replace) the rule for a tag. UPSERT onConflict (user_id, tag_id) so re-adding
 *  a rule for the same tag swaps its category instead of erroring on the unique constraint. */
export async function addTagRule(
  tagId: UUID,
  categoryId: UUID,
): Promise<TagCategoryRule> {
  const { data, error } = await supabase
    .from('tag_category_rules')
    .upsert({ tag_id: tagId, category_id: categoryId }, { onConflict: 'user_id,tag_id' })
    .select('id, tag_id, category_id')
    .single()
  if (error) throw error
  return data as TagCategoryRule
}

export async function deleteTagRule(id: UUID): Promise<void> {
  const { error } = await supabase.from('tag_category_rules').delete().eq('id', id)
  if (error) throw error
}

/** How many transactions currently carry `tagId` — drives the "apply to past txns?" prompt. */
export async function countTxnsWithTag(tagId: UUID): Promise<number> {
  const { count, error } = await supabase
    .from('transaction_tags')
    .select('*', { count: 'exact', head: true })
    .eq('tag_id', tagId)
  if (error) throw error
  return count ?? 0
}

/** Backfill one rule: set every txn currently tagged `tagId` to `categoryId`. Overwrites
 *  existing categories — the rule intent is "this tag always means this category". One bulk
 *  update instead of N round-trips. Returns how many txns were updated. */
export async function applyTagRule(tagId: UUID, categoryId: UUID): Promise<number> {
  const { data, error } = await supabase
    .from('transaction_tags')
    .select('transaction_id')
    .eq('tag_id', tagId)
  if (error) throw error
  const ids = (data ?? []).map((r) => (r as { transaction_id: UUID }).transaction_id)
  if (ids.length === 0) return 0
  // Chunk the bulk update — `.in('id', …)` goes in the request URL, so a large tag would
  // blow the URL length limit (same 200-cap the auto-categorize path uses).
  for (const batch of chunk(ids, AUTO_CATEGORIZE_CHUNK)) {
    const { error: updErr } = await supabase
      .from('transactions')
      .update({ category_id: categoryId })
      .in('id', batch)
    if (updErr) throw updErr
  }
  return ids.length
}

/** "Apply now": backfill every tag rule. Returns the total txns updated across all rules. */
export async function applyAllTagRules(): Promise<number> {
  const rules = await fetchTagRules()
  let total = 0
  for (const r of rules) total += await applyTagRule(r.tag_id, r.category_id)
  return total
}

/** Apply a single tag's rule to one transaction at tag-attach time. Sets the txn's category
 *  to the rule's category when they differ (the caller resolves the rule). Plain
 *  updateCategory — no merchant-memory learning; a tag rule isn't a per-merchant choice. */
export async function applyTagRuleToTransaction(
  transactionId: UUID,
  categoryId: UUID,
): Promise<void> {
  await updateCategory(transactionId, categoryId)
}
