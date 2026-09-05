// BYO Plaid developer account (pilot): show connection status + item usage, or
// a form to register credentials. The secret is write-only — sent once to the
// backend, validated against Plaid, stored encrypted, never displayed again.
// Terracotta/sage card recipe.

import { useEffect, useRef, useState } from 'react'
import { KeyRound, Sparkles, Trash2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMutation } from '@/demo/demoMutation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  deletePlaidCredentials,
  getPlaidCredentialsStatus,
  savePlaidCredentials,
} from '@/data/plaidCredentials'
import { plaidOnboardUrl } from '@/data/sync'
import { openWarmTab } from '@/data/backend'
import { cn } from '@/lib/utils'

const cardClass = 'card-surface border-0 p-6'

function CardTitle() {
  return <h3 className="text-xl font-medium leading-7 text-foreground">Plaid Connection</h3>
}

export function PlaidCredentialsCard({ highlight = false }: { highlight?: boolean }) {
  const queryClient = useQueryClient()
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [showManual, setShowManual] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // Fresh-signup spotlight (?setup=1): scroll the card into view.
  useEffect(() => {
    if (highlight) cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlight])

  // Backend-hosted guided wizard (signup cheat-sheet, paste-anything keys, first
  // link). Opens in a new tab; the status here refetches on window focus.
  const openGuided = async () => {
    try {
      await openWarmTab(plaidOnboardUrl)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open guided setup')
    }
  }

  const status = useQuery({
    queryKey: ['plaid-credentials'],
    queryFn: getPlaidCredentialsStatus,
  })

  const save = useMutation({
    mutationFn: () =>
      savePlaidCredentials({ client_id: clientId.trim(), secret: secret.trim(), env: 'production' }),
    onSuccess: () => {
      setClientId('')
      setSecret('')
      queryClient.invalidateQueries({ queryKey: ['plaid-credentials'] })
      toast.success('Plaid credentials verified and saved.')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save credentials'),
  })

  const remove = useMutation({
    mutationFn: deletePlaidCredentials,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid-credentials'] })
      toast.success('Plaid credentials removed.')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not remove credentials'),
  })

  if (status.isLoading) {
    return (
      <Card className={cn(cardClass, 'space-y-4')}>
        <CardTitle />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    )
  }

  if (status.data?.configured) {
    return (
      <Card className={cn(cardClass, 'space-y-3')}>
        <CardTitle />
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary"
          >
            <KeyRound className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {status.data.client_id_masked}
            </p>
            <p className="text-xs font-semibold text-muted-foreground">
              {status.data.items_used}/{status.data.item_limit} banks · {status.data.env}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 rounded-full text-destructive hover:bg-error-container hover:text-destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <Trash2 className="h-4 w-4" />
            Remove
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Banks you link count against this Plaid account's Item limit. Unlink all banks before
          removing credentials.
        </p>
      </Card>
    )
  }

  return (
    <Card
      ref={cardRef}
      className={cn(
        cardClass,
        'space-y-3',
        highlight && 'ring-2 ring-primary shadow-card-hover',
      )}
    >
      <CardTitle />
      {highlight && (
        <p className="text-xs font-semibold text-primary">
          Start here — connect your banks in about 15 minutes.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Linking banks needs your own free Plaid developer account (10 linked banks, no card).
        Guided setup walks you through creating one and grabbing your keys — about 15 minutes.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          className="gap-1.5 rounded-full px-4 transition-colors hover:bg-primary-container motion-reduce:transition-none"
          onClick={openGuided}
        >
          <Sparkles className="h-4 w-4" />
          Guided setup
        </Button>
        <button
          type="button"
          className="rounded-md text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none"
          onClick={() => setShowManual((v) => !v)}
        >
          {showManual ? 'Hide manual entry' : 'Enter keys manually'}
        </button>
      </div>
      {showManual && (
        <>
          <p className="text-xs text-muted-foreground">
            Paste your client ID and Production secret from dashboard.plaid.com → Developers →
            API keys. The secret is verified with Plaid and stored encrypted — it can't be read
            back.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="plaid-client-id" className="text-xs">
                Client ID
              </Label>
              <Input
                id="plaid-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plaid-secret" className="text-xs">
                Secret
              </Label>
              <Input
                id="plaid-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <Button
            size="sm"
            className="rounded-full px-4 transition-colors hover:bg-primary-container motion-reduce:transition-none"
            onClick={() => save.mutate()}
            disabled={save.isPending || !clientId.trim() || !secret.trim()}
          >
            {save.isPending ? 'Verifying…' : 'Verify & save'}
          </Button>
        </>
      )}
    </Card>
  )
}
