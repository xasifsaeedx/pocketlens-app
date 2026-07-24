// Settings card for zero-sum (zero-based) budgeting: enable the mode, set monthly income, and
// choose how balances roll over. Enabling adds the "Zero-sum" tab on the Budgets page.

import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSaveZbbSettings, useZbbSettings } from '@/data/hooks'
import type { ZbbSettings } from '@/types/domain'

export function ZbbSettingsCard() {
  const { data: settings } = useZbbSettings()
  const save = useSaveZbbSettings()

  const enabled = settings?.enabled ?? false
  const income = settings?.monthly_income ?? 0
  const mode = settings?.rollover_mode ?? 'strict'

  function toggle(on: boolean) {
    const patch: Partial<ZbbSettings> = { enabled: on }
    // Anchor the first budget month when enabling, so rollover starts here rather than walking
    // all of history.
    if (on && settings?.budget_start_year == null) {
      const now = new Date()
      patch.budget_start_year = now.getFullYear()
      patch.budget_start_month = now.getMonth() + 1
    }
    save.mutate(patch)
  }

  return (
    <Card className="space-y-4 card-surface border-0 p-6">
      <h3 className="text-xl font-medium leading-7 text-foreground">Budgeting</h3>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="zbb-enabled" className="text-base font-medium text-foreground">
            Zero-sum budgeting
          </Label>
          <p className="text-xs text-muted-foreground">Give every dollar a job each month.</p>
        </div>
        <Switch id="zbb-enabled" checked={enabled} onCheckedChange={toggle} />
      </div>

      {enabled && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="zbb-income" className="text-xs text-muted-foreground">Monthly income</Label>
            <Input
              id="zbb-income"
              type="number"
              inputMode="decimal"
              defaultValue={String(income)}
              key={`income-${income}`}
              onBlur={(e) => {
                const next = parseFloat(e.target.value)
                if (!isNaN(next) && next !== income) save.mutate({ monthly_income: next })
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Rollover</Label>
            <Select
              value={mode}
              onValueChange={(v) => save.mutate({ rollover_mode: v as ZbbSettings['rollover_mode'] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strict">Strict — carry overspend inside the category</SelectItem>
                <SelectItem value="flexible">Flexible — forgive overspend, subtract from next month</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </Card>
  )
}
