// Category groups data layer — mirrors data/categories.ts in structure.
// A group is a named container; categories carry an optional group_id FK.

import { supabase } from '@/lib/supabase'
import type { Category, CategoryGroup, UUID } from '@/types/domain'

// ── Groups CRUD ─────────────────────────────────────────────────────────────

export async function fetchCategoryGroups(): Promise<CategoryGroup[]> {
  const { data, error } = await supabase
    .from('category_groups')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error) throw error
  return (data ?? []) as CategoryGroup[]
}

export async function upsertCategoryGroup(
  group: Partial<CategoryGroup> & { name: string },
): Promise<CategoryGroup> {
  if (group.id) {
    // Update existing row
    const { data, error } = await supabase
      .from('category_groups')
      .update({ name: group.name, sort_order: group.sort_order })
      .eq('id', group.id)
      .select()
      .single()
    if (error) throw error
    return data as CategoryGroup
  } else {
    // Insert new row
    const { data, error } = await supabase
      .from('category_groups')
      .insert({ name: group.name, sort_order: group.sort_order ?? 0 })
      .select()
      .single()
    if (error) throw error
    return data as CategoryGroup
  }
}

export async function deleteCategoryGroup(id: UUID): Promise<void> {
  // ON DELETE SET NULL in the migration ungroups any categories automatically.
  const { error } = await supabase.from('category_groups').delete().eq('id', id)
  if (error) throw error
}

/** Persist new sort order for groups (drag-to-reorder). */
export async function reorderCategoryGroups(ordered: CategoryGroup[]): Promise<void> {
  await Promise.all(
    ordered.map((g, i) =>
      supabase.from('category_groups').update({ sort_order: i }).eq('id', g.id),
    ),
  )
}

// ── Group membership (categories.group_id) ──────────────────────────────────

/** Assign a category to a group (or clear its group when groupId is null). */
export async function setCategoryGroup(
  categoryId: UUID,
  groupId: UUID | null,
): Promise<Category> {
  const { data, error } = await supabase
    .from('categories')
    .update({ group_id: groupId })
    .eq('id', categoryId)
    .select()
    .single()
  if (error) throw error
  return data as Category
}
