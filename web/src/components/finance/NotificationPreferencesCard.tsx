// Notification preferences (Phase E) — per-type enable toggle + threshold
// control, wired to the Phase-A prefs hooks. Rows persist on change; a type with no
// stored pref shows sensible defaults (enabled + default threshold) from
// notificationTypes. In-app alerts only in v1 (no browser OS push).

import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotificationPrefs, useUpsertNotificationPref } from '@/data/hooks'
import {
  DIGEST_CADENCES,
  NOTIFICATION_TYPES,
  type NotificationTypeMeta,
} from '@/lib/notificationTypes'
import type { NotificationPref } from '@/types/domain'
import { cn } from '@/lib/utils'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card'

/** Current threshold value for a type: the stored config value, else the meta default. */
function thresholdValue(meta: NotificationTypeMeta, pref?: NotificationPref): number | string {
  if (meta.configKey && pref?.config) {
    const v = pref.config[meta.configKey]
    if (typeof v === 'number' || typeof v === 'string') return v
  }
  return meta.defaultValue ?? ''
}

function PrefRow({ meta, pref }: { meta: NotificationTypeMeta; pref?: NotificationPref }) {
  const upsert = useUpsertNotificationPref()
  const Icon = meta.icon
  // Default to on when there's no stored row yet.
  const enabled = pref?.enabled ?? true
  const inputId = `notif-pref-${meta.type}`

  // Threshold is edited locally then persisted on blur/change, so typing doesn't
  // fire a write per keystroke. Re-seed during render (not an effect) if the server
  // value changes underneath us — React's "adjust state while rendering" pattern.
  const stored = thresholdValue(meta, pref)
  const [draft, setDraft] = useState(String(stored))
  const [seededFrom, setSeededFrom] = useState(stored)
  if (stored !== seededFrom) {
    setSeededFrom(stored)
    setDraft(String(stored))
  }

  function persist(next: { enabled?: boolean; config?: Record<string, unknown> }) {
    upsert.mutate({
      type: meta.type,
      enabled: next.enabled ?? enabled,
      config: next.config ?? pref?.config ?? {},
    })
  }

  function commitNumber() {
    if (!meta.configKey) return
    const n = Number(draft)
    const clean = Number.isFinite(n) && n > 0 ? n : Number(meta.defaultValue ?? 0)
    setDraft(String(clean))
    if (clean === stored) return
    persist({ config: { ...(pref?.config ?? {}), [meta.configKey]: clean } })
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg p-3 transition-colors hover:bg-surface-variant/60 motion-reduce:transition-none">
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary"
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <Label htmlFor={inputId} className="block text-base font-medium leading-6 text-foreground">
          {meta.label}
        </Label>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{meta.description}</p>
      </div>

      <Switch
        id={inputId}
        checked={enabled}
        onCheckedChange={(checked) => persist({ enabled: checked })}
        disabled={upsert.isPending}
        aria-label={`Enable ${meta.label} alerts`}
      />

      {meta.threshold !== 'none' && enabled && (
        <div className="ml-auto flex w-full items-center justify-end gap-2 sm:w-auto">
          {meta.threshold === 'cadence' ? (
            <Select
              value={String(draft)}
              onValueChange={(v) => {
                setDraft(v)
                persist({ config: { ...(pref?.config ?? {}), [meta.configKey!]: v } })
              }}
            >
              <SelectTrigger
                className="h-9 w-32"
                aria-label={`${meta.label} cadence`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIGEST_CADENCES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="relative">
              {meta.threshold === 'amount' && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                >
                  $
                </span>
              )}
              <Input
                type="number"
                inputMode="decimal"
                min={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitNumber}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                aria-label={
                  meta.threshold === 'pct'
                    ? `${meta.label} percent`
                    : `${meta.label} amount`
                }
                className={cn(
                  'h-9 w-24 text-right',
                  meta.threshold === 'amount' ? 'pl-6 pr-7' : 'pr-7',
                  focusRing,
                )}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
              >
                {meta.threshold === 'pct' ? '%' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function NotificationPreferencesCard() {
  const { data: prefs = [] } = useNotificationPrefs()
  const byType = new Map(prefs.map((p) => [p.type, p]))

  return (
    <section className="card-surface p-6">
      <h3 className="mb-1 text-xl font-medium leading-7 text-foreground">Notifications</h3>
      <p className="mb-4 text-sm text-muted-foreground">
        Choose which alerts land in your inbox. Delivered in-app.
      </p>
      <div className="space-y-1">
        {NOTIFICATION_TYPES.map((meta) => (
          <PrefRow key={meta.type} meta={meta} pref={byType.get(meta.type)} />
        ))}
      </div>
    </section>
  )
}

export default NotificationPreferencesCard
