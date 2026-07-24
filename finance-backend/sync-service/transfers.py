"""Auto-detect inter-account transfers after a sync.

Two posted transactions that are the same money moving between the user's own
accounts (checking → savings, a credit-card payment) net to zero and are not
spend/income. The web app already models this as a shared transfer_group_id +
exclude_from_totals on both legs (manual linking, WEB-10); this module writes
the same shape automatically:

  - 'auto' pair: opposite/equal amounts, different accounts, within
    WINDOW_DAYS, and a Plaid transfer signal (PFC primary TRANSFER_IN /
    TRANSFER_OUT / LOAN_PAYMENTS) on at least one leg. Exact-amount only;
    ambiguous ties (two equally-good candidates) are left for the web
    suggestions UI rather than guessed at.
  - 'one_sided': a lone leg whose counterpart account isn't connected (e.g. a
    Robinhood deposit). Excluded from totals and upgraded in place to an 'auto'
    pair (same group id) if the other leg ever syncs. Gated on the PFC
    *detailed* category (ONE_SIDED_DETAILS): only unambiguous self-moves —
    investment/savings transfers and credit-card payments — plus Wealthfront
    Cash bucket moves, flagged by the CASH_CATEGORY marker in the name rather
    than a PFC detail (see CASH_CATEGORY_MARKER). Plaid tags Zelle /
    Venmo to other people, ATM cash, and cash-advance apps as TRANSFER_* too,
    and with no counterpart leg to corroborate, primary alone excluded real
    spending (user feedback 2026-07). Those now stay counted; hide is the
    per-row tool if someone doesn't want e.g. ATM cash as spend.

Rows the user pulled out of a transfer (transfer_opt_out) and hidden rows are
never touched. Idempotent: only reads unlinked / one-sided rows, so re-running
is a no-op.

The client suggestions tier (web today, iOS later) calls the suggest_transfers
RPC (migration 20260718140418_suggest_transfers.sql) instead of reimplementing
this matcher. The RPC shares the matching truth (EPS, WINDOW_DAYS,
closest-date-wins, ambiguous-tie skip) but deliberately lacks this module's
two auto-link-only rules — the PFC signal gate and the LOAN_PAYMENTS
credit-account tie-break — which are write policy for acting without user
confirmation, not matching truth. If you change the shared rules here, change
the RPC too (test_integration.py pins it; test_transfers.py pins this file).
"""
import datetime
import logging
import uuid

logger = logging.getLogger('sync')

PFC_TRANSFER = {'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'}

# PFC detailed categories that are unambiguous self-moves and safe to exclude
# WITHOUT a counterpart leg. Deliberately excludes ACCOUNT_TRANSFER (Zelle/Venmo
# P2P lands there), WITHDRAWAL/DEPOSIT (ATM cash), CASH_ADVANCES, and the
# non-credit-card LOAN_PAYMENTS_* (a mortgage is at least debatable spend).
# Rows ingested before the plaid_detail migration have a null detail and are
# never one-sided-marked — they can still pair, or be linked manually.
ONE_SIDED_DETAILS = {
    'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
    'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
    'TRANSFER_IN_SAVINGS',
    'TRANSFER_OUT_SAVINGS',
    'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
}

# Wealthfront Cash "categories" (Emergency fund, etc.) are buckets INSIDE one
# Plaid account, not separate accounts. Moving money between buckets emits a
# lone leg on that same account tagged with this literal token in the Plaid
# name (stored in `description`), e.g. "Emergency fund Withdrawal CASH_CATEGORY".
# It's an internal move, never spend/income, but its PFC detail is the generic
# TRANSFER_OUT_WITHDRAWAL (shared with real ATM/external withdrawals), so the
# token is the only safe signal. Same-account by construction, so it can never
# pair — we mark it one-sided (exclude) and keep it out of pair candidacy.
CASH_CATEGORY_MARKER = 'CASH_CATEGORY'

# Same tolerance + window as the web's manual match-candidate query
# (web/src/data/transfers.ts) so both tiers agree on what "matches" means.
EPS = 0.005
WINDOW_DAYS = 5
# Incremental runs only look this far back; counterparts of anything older
# have long since posted. full=True (backfill) scans all history.
LOOKBACK_DAYS = 30

_COLS = ('id, account_id, amount, effective_date, description, plaid_category, '
         'plaid_category_detail, transfer_group_id, transfer_kind')

# PostgREST caps a response at 1000 rows by default, so a single .execute()
# silently drops everything past the first 1000 — a user with >1000 unlinked
# transactions had the tail invisible to the matcher, so a full backfill left
# old transfers undetected (; observed at 2667 unlinked rows). Page past
# the cap.
_PAGE = 1000


def _fetch_paged(make_query):
    """Every row matching `make_query`, paging past PostgREST's 1000-row cap.
    `make_query` must build a FRESH query each call (a stable id order is applied
    per page so pages don't overlap or skip)."""
    rows, offset = [], 0
    while True:
        page = make_query().order('id').range(offset, offset + _PAGE - 1).execute().data or []
        rows.extend(page)
        if len(page) < _PAGE:
            return rows
        offset += _PAGE


def _is_pfc_transfer(row) -> bool:
    return (row.get('plaid_category') or '') in PFC_TRANSFER


def _is_cash_category(row) -> bool:
    return CASH_CATEGORY_MARKER in (row.get('description') or '')


def _is_self_move(row) -> bool:
    return (row.get('plaid_category_detail') or '') in ONE_SIDED_DETAILS \
        or _is_cash_category(row)


def _cents(amount) -> int:
    return round(abs(float(amount)) * 100)


def _days_apart(a, b) -> int:
    da = datetime.date.fromisoformat(a['effective_date'])
    db = datetime.date.fromisoformat(b['effective_date'])
    return abs((da - db).days)


def _fetch_matchable(supabase, user_id, lookback_days, full):
    """Posted, visible, not-opted-out rows that can still enter a pair:
    unlinked rows plus existing one-sided legs (pairable with a late
    counterpart). Deduplicated by id — the incremental unlinked set is fetched
    by two overlapping windows (see below), and one_sided legs must not double
    up with either.

    The incremental (`full=False`) unlinked scan is bounded by BOTH the
    transaction date (`effective_date`) AND the ingest time (`created_at`): a
    leg can be delivered by Plaid long after its transaction date. Investment
    cash movements arrive whenever the *investments* product readies —
    typically on an incremental (full=False) webhook fired after the
    transaction cursor is already set, carrying dates far beyond the 30-day date
    window (a backfill spans 730). Scoping by `effective_date` alone hid those
    freshly-ingested legs from the matcher, so they were neither paired nor
    excluded until some later `full=True` run happened to rescan them.
    A row that just arrived is exactly what the matcher must consider, whatever
    its transaction date — so include rows created since the cutoff too.

    The one-sided set deliberately ignores the lookback entirely: it's small,
    and a one-sided leg just past the cutoff must still upgrade when its
    counterpart (within WINDOW_DAYS of it) syncs late. `full=True` (backfill)
    scans all unlinked history and needs neither window.

    Every query is paged (see `_fetch_paged`): the unlinked sets in particular
    can exceed PostgREST's 1000-row response cap, and a truncated fetch silently
    drops matchable legs."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat()

    def _base():
        return supabase.table('transactions').select(_COLS) \
            .eq('user_id', user_id) \
            .eq('pending', False) \
            .eq('hidden', False) \
            .eq('transfer_opt_out', False)

    def _unlinked():
        return _base().is_('transfer_group_id', 'null')

    by_id = {}

    # Unlinked rows eligible to open or complete a pair.
    if full:
        makers = [_unlinked]
    else:
        # Recently dated OR recently ingested — two gte queries rather than one
        # PostgREST .or_, matching the existing two-query style and keeping the
        # in-memory test fake's simple filter surface.
        makers = [lambda: _unlinked().gte('effective_date', cutoff),
                  lambda: _unlinked().gte('created_at', cutoff)]
    for make in makers:
        for r in _fetch_paged(make):
            by_id[r['id']] = r

    # Existing one-sided legs (pairable with a late counterpart), any age.
    for r in _fetch_paged(lambda: _base().eq('transfer_kind', 'one_sided')):
        by_id.setdefault(r['id'], r)

    return list(by_id.values())


def detect_transfers(supabase, user_id, lookback_days=LOOKBACK_DAYS,
                     full=False, dry_run=False, include_one_sided=True) -> dict:
    """Pair + one-sided-mark a user's transactions. Returns
    {'linked': n_pairs, 'one_sided': n_rows} (what would be written, if dry_run).
    include_one_sided=False links pairs only — used by the history backfill,
    where bulk-excluding every lone Plaid-flagged leg (Zelle/Venmo to friends,
    ATM cash) would rewrite months of totals in one shot; ongoing syncs keep
    marking new one-sided legs, and old ones can be linked from the web UI."""
    rows = _fetch_matchable(supabase, user_id, lookback_days, full)

    acct_rows = supabase.table('accounts').select('id, type') \
        .eq('user_id', user_id).execute().data or []
    acct_type = {a['id']: a['type'] for a in acct_rows}

    # Cash-category (Wealthfront bucket) moves are internal to one account and
    # never a real cross-account leg — keep them out of pair candidacy so a
    # coincidental equal-amount leg elsewhere can't wrongly auto-link them. They
    # still get excluded below via the one-sided pass (_is_self_move).
    ins_by_cents = {}
    for r in rows:
        if float(r['amount']) < 0 and not _is_cash_category(r):
            ins_by_cents.setdefault(_cents(r['amount']), []).append(r)
    # Deterministic order → deterministic pairing (backfill is reproducible).
    outs = sorted((r for r in rows if float(r['amount']) > 0 and not _is_cash_category(r)),
                  key=lambda r: (r['effective_date'], r['id']))

    used = set()
    links = []
    for out in outs:
        if out['id'] in used:
            continue
        cands = []
        for c in ins_by_cents.get(_cents(out['amount']), []):
            if c['id'] in used or c['account_id'] == out['account_id']:
                continue
            if abs(float(c['amount']) + float(out['amount'])) >= EPS:
                continue
            dd = _days_apart(out, c)
            if dd > WINDOW_DAYS:
                continue
            # High-confidence gate: only auto-link with a Plaid transfer signal.
            if not (_is_pfc_transfer(out) or _is_pfc_transfer(c)):
                continue
            # A credit-card payment's inflow leg lands on the card: prefer a
            # credit-account candidate when either leg says LOAN_PAYMENTS.
            loan = 'LOAN_PAYMENTS' in (out.get('plaid_category'), c.get('plaid_category'))
            cc_rank = 0 if loan and acct_type.get(c['account_id']) == 'credit' else 1
            cands.append(((dd, cc_rank, c['id']), c))
        if not cands:
            continue
        cands.sort(key=lambda x: x[0])
        if len(cands) > 1 and cands[0][0][:2] == cands[1][0][:2]:
            continue  # ambiguous (e.g. two identical payments) — leave for suggestions
        best = cands[0][1]
        used.update((out['id'], best['id']))
        links.append((out, best))

    for out, inn in links:
        # Reuse a one-sided leg's group so it upgrades in place.
        group = out.get('transfer_group_id') or inn.get('transfer_group_id') or str(uuid.uuid4())
        if not dry_run:
            supabase.table('transactions').update({
                'transfer_group_id': group,
                'transfer_kind': 'auto',
                'exclude_from_totals': True,
            }).in_('id', [out['id'], inn['id']]).execute()

    one_sided = [] if not include_one_sided else \
                [r for r in rows
                 if r['id'] not in used
                 and not r.get('transfer_group_id')
                 and _is_self_move(r)]
    for r in one_sided:
        if not dry_run:
            supabase.table('transactions').update({
                'transfer_group_id': str(uuid.uuid4()),
                'transfer_kind': 'one_sided',
                'exclude_from_totals': True,
            }).eq('id', r['id']).execute()

    stats = {'linked': len(links), 'one_sided': len(one_sided)}
    if links or one_sided:
        logger.info('transfers detected', extra={
            'user_id': user_id, 'transfers_linked': stats['linked'],
            'transfers_one_sided': stats['one_sided'], 'dry_run': dry_run,
        })
    return stats


def unlink_groups(supabase, group_ids, dry_run=False):
    """System unlink (a leg was deleted/changed by Plaid): clear the group so
    the survivors can re-pair on the next detect pass. Does NOT set
    transfer_opt_out — that flag is reserved for user intent. Hidden legs stay
    excluded from totals (hiding is orthogonal to transfers)."""
    group_ids = [g for g in group_ids if g]
    if not group_ids or dry_run:
        return
    supabase.table('transactions').update({'exclude_from_totals': False}) \
        .in_('transfer_group_id', group_ids).eq('hidden', False).execute()
    supabase.table('transactions').update({
        'transfer_group_id': None, 'transfer_kind': None,
    }).in_('transfer_group_id', group_ids).execute()
