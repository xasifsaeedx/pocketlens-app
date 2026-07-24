// Mirrors iOS fetchCategories() + CategoryRulesView category_rules CRUD +
// CategoryEditSheet upserts. Direct PostgREST via supabase-js.

import { supabase } from '@/lib/supabase'
import type { Category, CategoryRule, RuleDirection, UUID } from '@/types/domain'
import { logAddRule, logDeleteRule } from './activity'

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error) throw error
  return (data ?? []) as Category[]
}

/** Resolve a category's display name for activity-log summaries. Cached briefly
 *  (names are used only for historical summary text, so mild staleness is fine);
 *  on a cache miss the list is refetched once. */
let nameCache: { at: number; byId: Map<UUID, string> } | null = null
export async function categoryNameById(id: UUID): Promise<string> {
  const fresh = () => nameCache && Date.now() - nameCache.at < 60_000
  if (!fresh()) {
    const cats = await fetchCategories()
    nameCache = { at: Date.now(), byId: new Map(cats.map((c) => [c.id, c.name])) }
  }
  let name = nameCache!.byId.get(id)
  if (name == null) {
    // Miss (e.g. a just-created category) — refetch once before giving up.
    const cats = await fetchCategories()
    nameCache = { at: Date.now(), byId: new Map(cats.map((c) => [c.id, c.name])) }
    name = nameCache.byId.get(id)
  }
  return name ?? 'Unknown'
}

export async function upsertCategory(
  cat: Partial<Category> & { name: string; color: string; icon: string },
): Promise<Category> {
  const { data, error } = await supabase
    .from('categories')
    .upsert(cat)
    .select()
    .single()
  if (error) throw error
  return data as Category
}

export async function deleteCategory(id: UUID): Promise<void> {
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw error
}

/** Whether a category is referenced by any split leg. Deleting such a category
 *  cascade-removes a single leg, and the deferred split_sum_balanced trigger then
 *  rolls the whole delete back at COMMIT — a silent failure — so callers block it
 *  up front with an actionable message. */
export async function categoryHasSplits(id: UUID): Promise<boolean> {
  const { data, error } = await supabase
    .from('transaction_splits')
    .select('id')
    .eq('category_id', id)
    .limit(1)
  if (error) throw error
  return (data?.length ?? 0) > 0
}

/** Persist new sort order (drag-to-reorder). */
export async function reorderCategories(ordered: Category[]): Promise<void> {
  await Promise.all(
    ordered.map((c, i) =>
      supabase.from('categories').update({ sort_order: i }).eq('id', c.id),
    ),
  )
}

// ── keyword rules (category_rules) ─────────────────────────────────────────

export async function fetchRules(): Promise<CategoryRule[]> {
  const { data, error } = await supabase.from('category_rules').select('*')
  if (error) throw error
  return (data ?? []) as CategoryRule[]
}

/** A rule to create. Conditions default to "any" and no reimbursement, so a plain
 *  keyword→category rule is `{ keyword, categoryId }`. At least one action
 *  (a category or set_reimbursement) is required — the UI enforces it and the DB
 *  has a matching CHECK. */
export interface NewRule {
  keyword: string
  categoryId: UUID | null
  direction?: RuleDirection | null
  minAmount?: number | null
  maxAmount?: number | null
  setReimbursement?: boolean
}

export async function addRule(input: NewRule, opts: { log?: boolean } = {}): Promise<void> {
  const { data, error } = await supabase
    .from('category_rules')
    .insert({
      keyword: input.keyword,
      category_id: input.categoryId,
      direction: input.direction ?? null,
      min_amount: input.minAmount ?? null,
      max_amount: input.maxAmount ?? null,
      set_reimbursement: input.setReimbursement ?? false,
    })
    .select('id')
    .single()
  if (error) throw error
  // The activity feed's rule entries are keyword→category; a reimbursement-only rule
  // (no category) has nothing to name there, so it's simply not logged.
  if (opts.log !== false && input.categoryId)
    void logAddRule((data as { id: UUID }).id, input.keyword, input.categoryId)
}

export async function deleteRule(id: UUID, opts: { log?: boolean } = {}): Promise<void> {
  // Capture keyword+category before the row is gone so the entry can re-create it on undo.
  const { data: existing } = opts.log === false
    ? { data: null }
    : await supabase.from('category_rules').select('keyword, category_id').eq('id', id).single()
  const { error } = await supabase.from('category_rules').delete().eq('id', id)
  if (error) throw error
  if (opts.log !== false && existing) {
    const r = existing as { keyword: string; category_id: UUID | null }
    if (r.category_id) void logDeleteRule(r.keyword, r.category_id)
  }
}
