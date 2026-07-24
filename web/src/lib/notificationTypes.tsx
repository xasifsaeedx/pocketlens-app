// Shared metadata for the alert types — one source of truth for the
// notification center (row icons) and the preferences card (labels, threshold
// controls, sensible defaults shown before a pref row exists). `type` is an open
// enum on notification_prefs/notifications; keep this list in step with the backend
// evaluator. See migration 20260725000000_alerts.sql.

import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CreditCard,
  Gauge,
  RefreshCcw,
  TrendingDown,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

/** How a type's threshold is edited in preferences (drives the control rendered). */
export type ThresholdKind = 'pct' | 'amount' | 'cadence' | 'none'

export interface NotificationTypeMeta {
  type: string
  label: string
  description: string
  icon: LucideIcon
  threshold: ThresholdKind
  /** config key the threshold value lives under (pct/amount/cadence). */
  configKey?: 'pct' | 'amount' | 'cadence'
  /** default value shown/persisted when no pref row exists yet. */
  defaultValue?: number | string
}

/** Cadence options for periodic_digest. */
export const DIGEST_CADENCES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const

/** Display order in the preferences card. */
export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  {
    type: 'budget_threshold',
    label: 'Budget threshold',
    description: 'When spending in a category crosses a share of its limit.',
    icon: Gauge,
    threshold: 'pct',
    configKey: 'pct',
    defaultValue: 90,
  },
  {
    type: 'large_charge',
    label: 'Large charge',
    description: 'When a single transaction exceeds an amount.',
    icon: CreditCard,
    threshold: 'amount',
    configKey: 'amount',
    defaultValue: 200,
  },
  {
    type: 'low_balance',
    label: 'Low balance',
    description: 'When an account balance drops below an amount.',
    icon: Wallet,
    threshold: 'amount',
    configKey: 'amount',
    defaultValue: 100,
  },
  {
    type: 'sync_failed',
    label: 'Sync failed',
    description: 'When a bank connection stops syncing.',
    icon: RefreshCcw,
    threshold: 'none',
  },
  {
    type: 'daily_spend',
    label: 'Daily spend',
    description: 'A recap of what you spent yesterday.',
    icon: TrendingDown,
    threshold: 'none',
  },
  {
    type: 'bill_due',
    label: 'Bill due',
    description: 'A reminder before a recurring bill is due.',
    icon: CalendarClock,
    threshold: 'none',
  },
  {
    type: 'periodic_digest',
    label: 'Weekly/monthly digest',
    description: 'A rolled-up summary of your spending.',
    icon: Bell,
    threshold: 'cadence',
    configKey: 'cadence',
    defaultValue: 'weekly',
  },
]

const BY_TYPE = new Map(NOTIFICATION_TYPES.map((m) => [m.type, m]))

/** Metadata for a notification/pref type, falling back to a generic bell so an
 *  unknown/future type still renders. */
export function notificationMeta(type: string): NotificationTypeMeta {
  return (
    BY_TYPE.get(type) ?? {
      type,
      label: type,
      description: '',
      icon: AlertTriangle,
      threshold: 'none',
    }
  )
}
