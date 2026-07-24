import { describe, expect, it } from 'vitest'
import { isTransferMatch, summarizeTransferGroup } from './transfers'
import { isTransfer, type Account, type UUID } from '@/types/domain'
import { makeTxn } from '@/test/factories'

function makeAccount(p: Partial<Account> & { id: string }): Account {
  return {
    plaid_account_id: `pa-${p.id}`,
    plaid_item_id: null,
    name: p.id,
    official_name: null,
    type: 'depository',
    subtype: null,
    mask: null,
    currency: 'USD',
    is_active: true,
    display_order: 0,
    ...p,
  }
}

const ACCOUNTS = new Map<UUID, Account>(
  [
    makeAccount({ id: 'checking', name: 'Chase Checking' }),
    makeAccount({ id: 'savings', name: 'Ally Savings' }),
    makeAccount({ id: 'card', name: 'Freedom Card', type: 'credit' }),
  ].map((a) => [a.id, a]),
)

describe('isTransferMatch', () => {
  const out = makeTxn({ id: 'out', account_id: 'checking', amount: 500 }) // money leaving

  it('matches the exact opposite leg in another account', () => {
    const leg = makeTxn({ id: 'in', account_id: 'savings', amount: -500 })
    expect(isTransferMatch(out, leg)).toBe(true)
  })

  it('rejects the same account even with opposite amount', () => {
    const same = makeTxn({ id: 'x', account_id: 'checking', amount: -500 })
    expect(isTransferMatch(out, same)).toBe(false)
  })

  it('rejects a different magnitude', () => {
    const off = makeTxn({ id: 'x', account_id: 'savings', amount: -499 })
    expect(isTransferMatch(out, off)).toBe(false)
  })

  it('rejects the same sign (both outflows)', () => {
    const same = makeTxn({ id: 'x', account_id: 'savings', amount: 500 })
    expect(isTransferMatch(out, same)).toBe(false)
  })

  it('tolerates sub-cent rounding drift', () => {
    const leg = makeTxn({ id: 'in', account_id: 'savings', amount: -500.004 })
    expect(isTransferMatch(out, leg)).toBe(true)
  })
})

describe('isTransfer', () => {
  it('is false when unlinked', () => {
    expect(isTransfer(makeTxn())).toBe(false)
  })
  it('is true when a transfer_group_id is set', () => {
    expect(isTransfer(makeTxn({ transfer_group_id: 'grp-1' }))).toBe(true)
  })
})

// Suggestion pairing (closest-date-wins, ambiguous-tie skip, window/amount/account
// gates) moved server-side into the suggest_transfers RPC — pinned by
// finance-backend/sync-service/tests/test_integration.py, including a parity
// scenario against the old local pairSuggestions this file used to test.

describe('summarizeTransferGroup', () => {
  it('labels a payment into a credit account as a card payment', () => {
    const legs = [
      makeTxn({ id: 'out', account_id: 'checking', amount: 500 }),
      makeTxn({ id: 'in', account_id: 'card', amount: -500 }),
    ]
    const s = summarizeTransferGroup(legs, ACCOUNTS)
    expect(s.kind).toBe('card_payment')
    expect(s.from).toBe('Chase Checking')
    expect(s.to).toBe('Freedom Card')
    expect(s.amount).toBe(500)
  })

  it('labels an asset↔asset pair as a move', () => {
    const legs = [
      makeTxn({ id: 'out', account_id: 'checking', amount: 1000 }),
      makeTxn({ id: 'in', account_id: 'savings', amount: -1000 }),
    ]
    expect(summarizeTransferGroup(legs, ACCOUNTS).kind).toBe('move')
  })

  it('treats LOAN_PAYMENTS on a leg as a card payment even without account type', () => {
    const legs = [
      makeTxn({ id: 'out', account_id: 'checking', amount: 800, plaid_category: 'LOAN_PAYMENTS' }),
      makeTxn({ id: 'in', account_id: 'savings', amount: -800 }),
    ]
    expect(summarizeTransferGroup(legs, ACCOUNTS).kind).toBe('card_payment')
  })

  it('describes a one-sided outflow with the external label', () => {
    const legs = [
      makeTxn({
        id: 'out', account_id: 'checking', amount: 200,
        merchant_name: 'Robinhood', transfer_kind: 'one_sided', transfer_group_id: 'g',
      }),
    ]
    const s = summarizeTransferGroup(legs, ACCOUNTS)
    expect(s.kind).toBe('one_sided')
    expect(s.from).toBe('Chase Checking')
    expect(s.to).toBeNull()
    expect(s.external).toBe('Robinhood')
    expect(s.amount).toBe(200)
  })
})
