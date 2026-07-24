// The Bell — live notification center (Phase E). A popover inbox over the
// Phase-A hooks: unread badge, per-row mark-read + best-effort deep-link, mark-all,
// per-row delete, empty/loading states. In-app only; no browser OS push in v1.
// Styled with the Terracotta & Sage tokens.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Check, CheckCheck, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  useDeleteAllNotifications,
  useDeleteNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from '@/data/hooks'
import { formatRelativeTime } from '@/lib/dates'
import { notificationMeta } from '@/lib/notificationTypes'
import type { AppNotification } from '@/types/domain'
import { cn } from '@/lib/utils'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

// Severity → icon-well styling, using only existing semantic tokens (no new hues).
// Color is a reinforcement, never the sole signal: every row still carries a
// distinct type icon and a text title/body, so this stays legible without color.
const SEVERITY_CLASS = {
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-primary-container/50 text-primary',
  neutral: 'bg-surface-container text-muted-foreground',
} as const

// Which alert types read as urgent vs. attention vs. informational.
const SEVERITY_BY_TYPE: Record<string, keyof typeof SEVERITY_CLASS> = {
  sync_failed: 'danger',
  low_balance: 'danger',
  large_charge: 'danger',
  budget_threshold: 'info',
  bill_due: 'info',
  daily_spend: 'neutral',
  periodic_digest: 'neutral',
}

function severityClass(type: string): string {
  return SEVERITY_CLASS[SEVERITY_BY_TYPE[type] ?? 'neutral']
}

/** Best-effort route for a notification's deep-link payload. Returns null when there's
 *  nothing routable, so the row just marks read. Accepts snake_case (backend) keys. */
function deepLinkFor(payload: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const accountId = str(payload.account_id) ?? str(payload.accountId)
  if (accountId) return `/accounts/${accountId}`
  // A transaction routes to the Transactions list (per-txn deep-link isn't a route yet).
  if (str(payload.transaction_id) ?? str(payload.transactionId)) return '/transactions'
  if (str(payload.category_id) ?? str(payload.categoryId)) return '/budgets'
  return null
}

function NotificationRow({
  n,
  onNavigate,
}: {
  n: AppNotification
  onNavigate: (to: string) => void
}) {
  const markRead = useMarkNotificationRead()
  const del = useDeleteNotification()
  const meta = notificationMeta(n.type)
  const Icon = meta.icon
  const unread = n.read_at == null
  const target = deepLinkFor(n.payload ?? {})

  function activate() {
    if (unread) markRead.mutate(n.id)
    if (target) onNavigate(target)
  }

  return (
    <li className="group relative flex items-start gap-3 rounded-lg p-3 transition-colors hover:bg-surface-variant motion-reduce:transition-none">
      <button
        type="button"
        onClick={activate}
        aria-label={unread ? `${n.title} (unread)` : n.title}
        className={cn('flex flex-1 items-start gap-3 text-left', focusRing, 'rounded-md')}
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            severityClass(n.type),
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'truncate text-sm leading-5',
                unread ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
              )}
            >
              {n.title}
            </span>
            {unread && (
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-primary" />
            )}
          </span>
          {n.body && (
            <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
              {n.body}
            </span>
          )}
          <span className="mt-1 block text-[11px] font-semibold uppercase tracking-wide text-outline">
            {formatRelativeTime(n.created_at)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${n.title}`}
        onClick={() => del.mutate(n.id)}
        disabled={del.isPending}
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50 motion-reduce:transition-none',
          focusRing,
        )}
      >
        <Trash2 aria-hidden className="h-4 w-4" />
      </button>
    </li>
  )
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { data: notifications = [], isLoading } = useNotifications()
  const unread = useUnreadNotificationCount()
  const markAll = useMarkAllNotificationsRead()
  const deleteAll = useDeleteAllNotifications()

  function onNavigate(to: string) {
    setOpen(false)
    navigate(to)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className={cn(
          'relative rounded-full p-2 text-primary transition-colors hover:bg-surface-variant motion-reduce:transition-none',
          focusRing,
        )}
      >
        <Bell aria-hidden className="h-6 w-6" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[calc(100vw-2rem)] max-w-sm p-0"
        aria-label="Notifications"
      >
        <div className="flex items-center justify-between gap-2 border-b border-outline-variant/50 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary-container/40 disabled:opacity-50 motion-reduce:transition-none',
                  focusRing,
                )}
              >
                <CheckCheck aria-hidden className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={() => deleteAll.mutate()}
                disabled={deleteAll.isPending}
                aria-label="Delete all notifications"
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 motion-reduce:transition-none',
                  focusRing,
                )}
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
                Delete all
              </button>
            )}
          </div>
        </div>

        {isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span
              aria-hidden
              className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container text-outline"
            >
              <Check className="h-6 w-6" />
            </span>
            <p className="text-sm font-medium text-foreground">You're all caught up</p>
            <p className="text-xs text-muted-foreground">
              Alerts about budgets, charges, and balances show up here.
            </p>
          </div>
        ) : (
          <ul className="max-h-[min(70vh,28rem)] space-y-0.5 overflow-y-auto p-2">
            {notifications.map((n) => (
              <NotificationRow key={n.id} n={n} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
