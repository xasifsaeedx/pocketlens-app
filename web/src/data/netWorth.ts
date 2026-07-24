// Mirrors PocketLens/Services/NetWorthService.swift.

import { supabase } from '@/lib/supabase'
import type { NetWorthSnapshot } from '@/types/domain'

/** Snapshots ordered oldest-first; optionally only the last `months` months. */
export async function fetchSnapshots(months?: number): Promise<NetWorthSnapshot[]> {
  let q = supabase.from('net_worth_snapshots').select('*')
  if (months != null) {
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    q = q.gte('date', cutoff.toISOString().slice(0, 10))
  }
  const { data, error } = await q.order('date', { ascending: true })
  if (error) throw error
  return (data ?? []) as NetWorthSnapshot[]
}
