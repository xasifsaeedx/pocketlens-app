// Settings — signed-in email, linked banks, add bank (Plaid), manual sync, sign out.
// Mirrors PocketLens/Views/Settings/SettingsView.swift + AccountLinking.swift.
// Terracotta/sage redesign.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ChevronRight,
  History,
  LogOut,
  Monitor,
  Moon,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Sun,
  Tags,
  Trash2,
  UserX,
  Wand2,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InstitutionLogo } from '@/components/finance/InstitutionLogo'
import { ManageRulesDialog } from '@/components/finance/ManageRulesDialog'
import { ManageTagsDialog } from '@/components/finance/ManageTagsDialog'
import { PlaidCredentialsCard } from '@/components/finance/PlaidCredentialsCard'
import { NotificationPreferencesCard } from '@/components/finance/NotificationPreferencesCard'
import { ZbbSettingsCard } from '@/components/finance/ZbbSettingsCard'
import { BackfillPromptDialog } from '@/components/finance/BackfillPromptDialog'
import ConfirmDialog from '@/components/ConfirmDialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/auth'
import { usePlaidItems, useBackfillAll, useSyncInProgress, useDeletePlaidItem, useMyProfile, useUpdateMyProfile, useDeleteMyAccount } from '@/data/hooks'
import { plaidLinkUrl, plaidReconnectUrl, requestBackfill } from '@/data/sync'
import { openWarmTab, isTrustedMessageOrigin } from '@/data/backend'
import { formatShortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card'

/** Settings list row: 40px icon well + 18px label + trailing chevron. */
function SettingsRow({
  icon,
  label,
  meta,
  onClick,
  destructive = false,
}: {
  icon: ReactNode
  label: string
  meta?: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-4 rounded-lg p-4 text-left transition-colors motion-reduce:transition-none',
        destructive ? 'hover:bg-error-container' : 'hover:bg-surface-variant',
        focusRing,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container transition-colors motion-reduce:transition-none',
          destructive
            ? 'text-destructive group-hover:bg-destructive group-hover:text-destructive-foreground'
            : 'text-primary group-hover:bg-primary-container group-hover:text-on-primary-container',
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          'flex-1 text-lg leading-7',
          destructive ? 'text-destructive' : 'text-foreground',
        )}
      >
        {label}
      </span>
      {meta && <span className="text-xs font-semibold text-muted-foreground">{meta}</span>}
      {!destructive && <ChevronRight aria-hidden className="h-5 w-5 shrink-0 text-outline" />}
    </button>
  )
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const

const emptySubscribe = () => () => {}

/** Light / Dark / System tiles wired to next-themes. */
function AppearanceCard() {
  const { theme, setTheme } = useTheme()
  // next-themes only knows the stored theme on the client — render selection after
  // hydration (client snapshot true, server snapshot false) to avoid a mismatch flash.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )

  return (
    <section className="card-surface p-6">
      <h3 className="mb-4 text-xl font-medium leading-7 text-foreground">Appearance</h3>
      <div className="grid grid-cols-3 gap-4" role="group" aria-label="Theme">
        {THEME_OPTIONS.map(({ value, label, Icon }) => {
          const selected = mounted && theme === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => setTheme(value)}
              className={cn(
                'flex min-h-[44px] flex-col items-center justify-center gap-2 rounded-lg border-2 p-4 transition-colors motion-reduce:transition-none',
                selected
                  ? 'border-primary bg-card text-primary'
                  : 'border-outline-variant/60 bg-surface-container-high text-muted-foreground hover:bg-surface-variant',
                focusRing,
              )}
            >
              <Icon aria-hidden className="h-6 w-6" />
              <span className="text-sm font-medium">{label}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default function SettingsPage() {
  const { user, signOut } = useAuth()
  const { data: banks = [] } = usePlaidItems()
  const [tagsOpen, setTagsOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // ?setup=1 (fresh signup, via AppLayout): spotlight the bank-setup wizard.
  const highlightSetup = searchParams.get('setup') === '1'

  const fullSync = useBackfillAll()
  const syncing = useSyncInProgress()
  const deleteItem = useDeletePlaidItem()
  // Confirm before a full sync — it's heavy and cooldown-gated (see useBackfillAll).
  const [confirmFullSync, setConfirmFullSync] = useState(false)

  // Track which item is currently being backfilled (loading state).
  const [backfillingItemId, setBackfillingItemId] = useState<string | null>(null)

  async function handleBackfill(itemId: string, bankName: string) {
    setBackfillingItemId(itemId)
    try {
      await requestBackfill(itemId)
      toast.success(`Full history sync started for ${bankName}`)
      // Invalidate relevant queries after a brief delay to allow the backend to start processing.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['sb', 'accounts'] })
        void queryClient.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      }, 2000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not request backfill')
    } finally {
      setBackfillingItemId(null)
    }
  }

  // Bank to confirm deletion — holds the full PlaidItem so we can show its name.
  const [confirmDeleteBank, setConfirmDeleteBank] = useState<{
    id: string
    name: string
  } | null>(null)

  const messageListenerRef = useRef<((e: MessageEvent) => void) | null>(null)
  const [backfillItem, setBackfillItem] = useState<{
    itemId: string
    institutionName: string
  } | null>(null)

  // Delete-account confirmation — 3-step flow (explanation → impact → slider).
  const [confirmDeleteAccountOpen, setConfirmDeleteAccountOpen] = useState(false)
  const [deleteAccountStep, setDeleteAccountStep] = useState<1 | 2 | 3>(1)

  // Clean up any dangling message listener when the component unmounts.
  useEffect(() => {
    return () => {
      if (messageListenerRef.current) {
        window.removeEventListener('message', messageListenerRef.current)
        messageListenerRef.current = null
      }
    }
  }, [])

  // Shared PLAID_LINK_SUCCESS handler for both the fresh-link (addBank) and
  // update-mode (reconnectBank) tabs. A fresh link carries `new_account` and
  // opens the backfill prompt; a reconnect has no `new_account` (the backend's
  // /link/claim already kicks the backfill), so we just refresh + toast.
  function handleLinkSuccess(e: MessageEvent) {
    // Trust PLAID_LINK_SUCCESS only from the backend-hosted /link page (its origin
    // is VITE_BACKEND_URL) or same-origin — never an arbitrary window that could
    // forge a message and trigger a spurious backfill/refresh.
    if (!isTrustedMessageOrigin(e.origin)) return
    if (e.data?.type !== 'PLAID_LINK_SUCCESS') return
    const data = e.data.data as {
      item_id: string
      institution?: string
      new_account?: unknown
    }
    if (data.new_account) {
      setBackfillItem({ itemId: data.item_id, institutionName: data.institution ?? 'New bank' })
    } else {
      // Reconnect succeeded — refresh what a repaired connection can change.
      void queryClient.invalidateQueries({ queryKey: ['sb', 'plaidItems'] })
      void queryClient.invalidateQueries({ queryKey: ['sb', 'accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      toast.success(`${data.institution ?? 'Bank'} reconnected`)
    }
    if (messageListenerRef.current) {
      window.removeEventListener('message', messageListenerRef.current)
      messageListenerRef.current = null
    }
  }

  // Register the shared success listener, replacing any previous one, then open
  // the given hosted-page tab. Mirrors the add/remove lifecycle so listeners
  // never leak (also cleaned up on unmount).
  async function openPlaidTab(resolveUrl: () => Promise<string>, errorMsg: string) {
    if (messageListenerRef.current) {
      window.removeEventListener('message', messageListenerRef.current)
    }
    messageListenerRef.current = handleLinkSuccess
    window.addEventListener('message', handleLinkSuccess)
    try {
      await openWarmTab(resolveUrl)
    } catch (e) {
      window.removeEventListener('message', handleLinkSuccess)
      messageListenerRef.current = null
      toast.error(e instanceof Error ? e.message : errorMsg)
    }
  }

  function addBank() {
    void openPlaidTab(plaidLinkUrl, 'Could not open Plaid Link')
  }

  function reconnectBank(itemId: string) {
    void openPlaidTab(() => plaidReconnectUrl(itemId), 'Could not open Plaid Link')
  }

  const { data: profile } = useMyProfile()
  const updateProfile = useUpdateMyProfile()
  const deleteMyAccount = useDeleteMyAccount()
  const email = user?.email ?? ''
  const fullName = [profile?.first_name, profile?.last_name]
    .filter((s) => s && s.trim().length > 0)
    .join(' ')
    .trim()
  // Prefer the name's first letter for the avatar; fall back to the email.
  const initial = (fullName || email).charAt(0).toUpperCase() || '?'

  const [editNameOpen, setEditNameOpen] = useState(false)
  const [editFirstName, setEditFirstName] = useState('')
  const [editLastName, setEditLastName] = useState('')

  function openEditName() {
    setEditFirstName(profile?.first_name ?? '')
    setEditLastName(profile?.last_name ?? '')
    setEditNameOpen(true)
  }

  async function saveEditName() {
    const firstName = editFirstName.trim() || null
    const lastName = editLastName.trim() || null
    await updateProfile.mutateAsync({ first_name: firstName, last_name: lastName })
    setEditNameOpen(false)
    toast.success('Name updated')
  }

  return (
    <div className="space-y-6 pt-4 md:pt-6">
      {/* Profile card */}
      <section className="flex items-center justify-between gap-4 card-surface p-6">
        <div className="flex min-w-0 items-center gap-6">
          <span
            aria-hidden
            className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-surface-container text-3xl font-semibold text-primary"
          >
            {initial}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-semibold leading-8 text-foreground">
              {fullName || email || 'Signed in'}
            </h2>
            {fullName && email && (
              <p className="truncate text-sm text-muted-foreground">{email}</p>
            )}
            {banks.length > 0 && (
              <span className="mt-1 inline-flex items-center rounded-full bg-secondary/10 px-3 py-1 text-xs font-semibold tracking-wide text-secondary">
                {banks.length} {banks.length === 1 ? 'bank' : 'banks'} linked
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Edit name"
            onClick={openEditName}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-full bg-surface-variant text-primary transition-colors hover:bg-surface-container-high motion-reduce:transition-none',
              focusRing,
            )}
          >
            <Pencil aria-hidden className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Full sync all banks"
            onClick={() => setConfirmFullSync(true)}
            disabled={fullSync.isPending || syncing}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-full bg-surface-variant px-4 text-sm font-semibold text-primary transition-colors hover:bg-surface-container-high disabled:opacity-60 motion-reduce:transition-none',
              focusRing,
            )}
          >
            <RefreshCw aria-hidden className={cn('h-4 w-4', (fullSync.isPending || syncing) && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Full sync'}
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Left column */}
        <div className="space-y-6">
          <section className="card-surface p-6">
            <h3 className="mb-4 text-xl font-medium leading-7 text-foreground">Linked Banks</h3>
            <div className="space-y-1">
              {banks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  No banks linked yet.
                </div>
              ) : (
                banks.map((b) => (
                  <div key={b.id} className="flex items-center gap-4 rounded-lg p-4">
                    {/* InstitutionLogo draws its own circular well — don't nest another. */}
                    <InstitutionLogo logo={b.institution_logo} className="h-10 w-10 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-lg leading-7 text-foreground">
                      {b.institution_name ?? 'Bank'}
                    </span>
                    {b.last_synced_at && (
                      <span className="text-xs font-semibold text-muted-foreground">
                        Synced {formatShortDate(b.last_synced_at)}
                      </span>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Sync full history for ${b.institution_name ?? 'bank'}`}
                          disabled={backfillingItemId === b.id}
                          onClick={() => void handleBackfill(b.id, b.institution_name ?? 'Bank')}
                          className={cn(
                            'ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-60 motion-reduce:transition-none',
                            focusRing,
                          )}
                        >
                          <History
                            aria-hidden
                            className={cn('h-4 w-4', backfillingItemId === b.id && 'animate-spin')}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>Sync full history</p>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Reconnect ${b.institution_name ?? 'bank'}`}
                          title="Reconnect"
                          onClick={() => reconnectBank(b.id)}
                          className={cn(
                            'ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary motion-reduce:transition-none',
                            focusRing,
                          )}
                        >
                          <Plug aria-hidden className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>Reconnect</p>
                      </TooltipContent>
                    </Tooltip>
                    <button
                      type="button"
                      aria-label={`Unlink ${b.institution_name ?? 'bank'}`}
                      onClick={() =>
                        setConfirmDeleteBank({ id: b.id, name: b.institution_name ?? 'this bank' })
                      }
                      className={cn(
                        'ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive motion-reduce:transition-none',
                        focusRing,
                      )}
                    >
                      <Trash2 aria-hidden className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
              <SettingsRow
                icon={<Plus aria-hidden className="h-5 w-5" />}
                label="Add a bank"
                onClick={addBank}
              />
            </div>
          </section>

          <PlaidCredentialsCard highlight={highlightSetup} />

          <section className="card-surface p-6">
            <h3 className="mb-4 text-xl font-medium leading-7 text-foreground">More</h3>
            <div className="space-y-1">
              <SettingsRow
                icon={<Activity aria-hidden className="h-5 w-5" />}
                label="Activity"
                onClick={() => navigate('/activity')}
              />
              <SettingsRow
                icon={<Tags aria-hidden className="h-5 w-5" />}
                label="Manage tags"
                onClick={() => setTagsOpen(true)}
              />
              <SettingsRow
                icon={<Wand2 aria-hidden className="h-5 w-5" />}
                label="Auto Classify"
                onClick={() => setRulesOpen(true)}
              />
              <SettingsRow
                icon={<LogOut aria-hidden className="h-5 w-5" />}
                label="Sign out"
                onClick={() => void signOut()}
                destructive
              />
              <SettingsRow
                icon={<UserX aria-hidden className="h-5 w-5" />}
                label="Delete account"
                onClick={() => {
                  setDeleteAccountStep(1)
                  setConfirmDeleteAccountOpen(true)
                }}
                destructive
              />
            </div>
          </section>
        </div>

        {/* Right column */}
        <div className="space-y-6">
          <AppearanceCard />

          <NotificationPreferencesCard />

          <ZbbSettingsCard />
        </div>
      </div>

      <ManageTagsDialog open={tagsOpen} onOpenChange={setTagsOpen} />
      <ManageRulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />

      {/* Edit name dialog */}
      <Dialog open={editNameOpen} onOpenChange={(o) => !updateProfile.isPending && setEditNameOpen(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit name</DialogTitle>
          </DialogHeader>
          <form
            id="edit-name-form"
            className="space-y-4 py-2"
            onSubmit={(e) => { e.preventDefault(); void saveEditName() }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="edit-first-name">First name</Label>
              <Input
                id="edit-first-name"
                value={editFirstName}
                onChange={(e) => setEditFirstName(e.target.value)}
                autoComplete="given-name"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-last-name">Last name</Label>
              <Input
                id="edit-last-name"
                value={editLastName}
                onChange={(e) => setEditLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
          </form>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditNameOpen(false)}
              disabled={updateProfile.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="edit-name-form"
              disabled={updateProfile.isPending}
            >
              {updateProfile.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {backfillItem && (
        <BackfillPromptDialog
          open={!!backfillItem}
          institutionName={backfillItem.institutionName}
          itemId={backfillItem.itemId}
          onClose={() => setBackfillItem(null)}
        />
      )}
      <ConfirmDialog
        open={confirmFullSync}
        title="Full sync all banks?"
        message={`This re-imports the full transaction history (up to 730 days) for all ${banks.length} linked ${banks.length === 1 ? 'bank' : 'banks'}. It can take a few minutes and is limited to once every couple of days.\n\nFor a quick update of recent transactions and balances, use the Sync button on the Balances tab instead.`}
        confirmLabel="Start full sync"
        onConfirm={() => {
          fullSync.mutate()
          setConfirmFullSync(false)
        }}
        onCancel={() => setConfirmFullSync(false)}
      />

      <ConfirmDialog
        open={!!confirmDeleteBank}
        title={`Unlink ${confirmDeleteBank?.name ?? 'bank'}?`}
        message={`This permanently removes your ${confirmDeleteBank?.name ?? 'bank'} connection and deletes ALL accounts and transactions imported from it — checking, savings, credit cards, and any other accounts under that login. This cannot be undone.\n\nTo hide just one account while keeping the others, use the delete button on individual accounts in the Balances tab.`}
        confirmLabel="Unlink & delete everything"
        onConfirm={() => {
          if (!confirmDeleteBank) return
          toast.promise(deleteItem.mutateAsync(confirmDeleteBank.id), {
            loading: `Unlinking ${confirmDeleteBank.name}…`,
            success: `${confirmDeleteBank.name} unlinked`,
            error: (e) => (e instanceof Error ? e.message : 'Could not unlink bank'),
          })
          setConfirmDeleteBank(null)
        }}
        onCancel={() => setConfirmDeleteBank(null)}
      />

      {/* Delete account — 3-step: explanation → impact list → drag-to-confirm slider */}
      <DeleteAccountDialog
        open={confirmDeleteAccountOpen}
        step={deleteAccountStep}
        isPending={deleteMyAccount.isPending}
        onStepChange={setDeleteAccountStep}
        onClose={() => setConfirmDeleteAccountOpen(false)}
        onConfirm={() => {
          toast.promise(
            deleteMyAccount.mutateAsync().then(() => {
              setConfirmDeleteAccountOpen(false)
              void signOut()
            }),
            {
              loading: 'Deleting account…',
              success: 'Account deleted.',
              error: (e) =>
                e instanceof Error ? e.message : 'Could not delete account',
            },
          )
        }}
      />
    </div>
  )
}

// ─── Delete Account Dialog (3-step) ────────────────────────────────────────

const IMPACT_ITEMS = [
  { icon: '↔', label: 'All transactions & splits' },
  { icon: '🏷', label: 'Tags & auto-classify rules' },
  { icon: '📊', label: 'Categories & budgets' },
  { icon: '🏦', label: 'Linked bank connections' },
  { icon: '💳', label: 'Accounts & balance history' },
  { icon: '🔁', label: 'Recurring charge tracking' },
  { icon: '↕', label: 'Transfer & reimbursement links' },
  { icon: '📈', label: 'Net worth history' },
  { icon: '⚖', label: 'Zero-sum budget data' },
  { icon: '👤', label: 'Profile & notification settings' },
]

function DeleteAccountDialog({
  open,
  step,
  isPending,
  onStepChange,
  onClose,
  onConfirm,
}: {
  open: boolean
  step: 1 | 2 | 3
  isPending: boolean
  onStepChange: (s: 1 | 2 | 3) => void
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!isPending && !o) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg overflow-hidden p-0">
        {/* Step indicator */}
        <div className="flex items-center gap-2 border-b border-border px-6 pt-5 pb-4 pr-14">
          {([1, 2, 3] as const).map((s) => (
            <div
              key={s}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                s <= step ? 'bg-destructive' : 'bg-muted',
              )}
            />
          ))}
        </div>

        {step === 1 && (
          <DeleteStep1 onNext={() => onStepChange(2)} onCancel={onClose} />
        )}
        {step === 2 && (
          <DeleteStep2 onNext={() => onStepChange(3)} onBack={() => onStepChange(1)} onCancel={onClose} />
        )}
        {step === 3 && (
          <DeleteStep3 isPending={isPending} onConfirm={onConfirm} onCancel={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeleteStep1({ onNext, onCancel }: { onNext: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-6 px-6 py-5">
      {/* Icon + headline */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
          <UserX aria-hidden className="h-9 w-9 text-destructive" />
        </div>
        <h2 className="text-xl font-bold text-foreground">Delete your account?</h2>
      </div>

      {/* Explanation rows */}
      <div className="space-y-3">
        {[
          {
            icon: <Trash2 aria-hidden className="h-5 w-5 text-destructive shrink-0 mt-0.5" />,
            title: 'Everything is permanently erased',
            body: 'Your account and all data tied to it is deleted from our servers immediately. There is no grace period and no recovery.',
          },
          {
            icon: <span aria-hidden className="text-destructive shrink-0 mt-0.5 text-base leading-5">🏦</span>,
            title: 'Bank connections are severed',
            body: 'All Plaid bank connections are removed. Your banks are not notified — this only disconnects PocketLens from reading your data.',
          },
          {
            icon: <span aria-hidden className="text-destructive shrink-0 mt-0.5 text-base leading-5">⛔</span>,
            title: 'Cannot be undone',
            body: 'Once deleted, your account cannot be restored. You would need to create a new account and re-link your banks from scratch.',
          },
        ].map(({ icon, title, body }) => (
          <div
            key={title}
            className="flex items-start gap-3 rounded-lg bg-destructive/5 px-4 py-3"
          >
            {icon}
            <div>
              <p className="text-sm font-semibold text-foreground">{title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 pb-1">
        <Button type="button" variant="destructive" className="w-full" onClick={onNext}>
          Continue
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function DeleteStep2({
  onNext,
  onBack,
  onCancel,
}: {
  onNext: () => void
  onBack: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col gap-5 px-6 py-5">
      <div className="text-center">
        <h2 className="text-xl font-bold text-foreground">What will be deleted</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every piece of data below is permanently removed.
        </p>
      </div>

      <div className="divide-y divide-border rounded-xl border border-destructive/25 overflow-hidden">
        {IMPACT_ITEMS.map(({ icon, label }) => (
          <div key={label} className="flex items-center gap-3 bg-destructive/5 px-4 py-2.5">
            <span aria-hidden className="text-base w-5 text-center shrink-0">{icon}</span>
            <span className="flex-1 text-sm text-foreground">{label}</span>
            <span aria-hidden className="text-destructive/60 text-xs font-semibold">✕</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 pb-1">
        <Button type="button" variant="destructive" className="w-full" onClick={onNext}>
          I understand — continue
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" className="flex-1" onClick={onBack}>
            Back
          </Button>
          <Button type="button" variant="ghost" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function DeleteStep3({
  isPending,
  onConfirm,
  onCancel,
}: {
  isPending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-6 px-6 py-8">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
        <span aria-hidden className="text-4xl">⚠️</span>
      </div>
      <div className="text-center">
        <h2 className="text-xl font-bold text-foreground">Last chance</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Slide all the way to the right to permanently delete your account and all data.
          <br />
          <strong className="text-foreground">This action is irreversible.</strong>
        </p>
      </div>

      {isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <span className="animate-spin">⟳</span> Deleting account…
        </div>
      ) : (
        <DeleteSlider onConfirmed={onConfirm} />
      )}

      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={onCancel}
        disabled={isPending}
      >
        Cancel
      </Button>
    </div>
  )
}

// ─── Drag-to-confirm slider ─────────────────────────────────────────────────

/** The user must drag the thumb at least 90% of the track width before releasing
 *  to fire `onConfirmed`. Releases below that snap back to start. */
function DeleteSlider({ onConfirmed }: { onConfirmed: () => void }) {
  const THUMB_W = 56
  const THRESHOLD = 0.90

  const trackRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [trackW, setTrackW] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startOffset = useRef(0)

  // Measure track width (and re-measure on resize).
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth))
    ro.observe(el)
    setTrackW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const maxOffset = Math.max(0, trackW - THUMB_W)
  const progress = maxOffset > 0 ? Math.min(offset / maxOffset, 1) : 0

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (confirmed) return
    dragging.current = true
    startX.current = e.clientX
    startOffset.current = offset
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [confirmed, offset])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || confirmed) return
    const delta = e.clientX - startX.current
    setOffset(Math.min(Math.max(0, startOffset.current + delta), maxOffset))
  }, [confirmed, maxOffset])

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    if (progress >= THRESHOLD) {
      setOffset(maxOffset)
      setConfirmed(true)
      // Small delay so the user sees the "locked" state before the action fires.
      setTimeout(onConfirmed, 300)
    } else {
      // Snap back with CSS transition (applied via class when not dragging).
      setOffset(0)
    }
  }, [progress, maxOffset, onConfirmed])

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-label="Slide to delete account"
      className="relative h-14 w-full max-w-sm select-none overflow-hidden rounded-full"
      style={{ background: `hsl(var(--destructive) / 0.12)` }}
    >
      {/* Fill */}
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: offset + THUMB_W,
          background: `hsl(var(--destructive) / ${0.2 + 0.4 * progress})`,
          transition: dragging.current ? 'none' : 'width 0.35s cubic-bezier(.4,0,.2,1)',
        }}
      />

      {/* Track label (fades out as thumb advances) */}
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-semibold text-destructive"
        style={{ opacity: Math.max(0, 0.8 - progress * 0.8) }}
      >
        Slide to delete
      </div>

      {/* Thumb */}
      <div
        className="absolute top-1 flex h-12 w-14 cursor-grab items-center justify-center rounded-full shadow-md active:cursor-grabbing"
        style={{
          left: offset,
          background: confirmed ? 'hsl(var(--destructive))' : 'hsl(var(--card))',
          transition: dragging.current ? 'none' : 'left 0.35s cubic-bezier(.4,0,.2,1), background 0.2s',
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span
          className="text-lg font-bold transition-colors"
          style={{ color: confirmed ? 'white' : 'hsl(var(--destructive))' }}
        >
          {confirmed ? '✓' : '›'}
        </span>
      </div>
    </div>
  )
}