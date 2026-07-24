import datetime
import json
import logging
import traceback

from plaid.exceptions import ApiException
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest

import vault
from categorizer import apply_learned, load_guess_context
from investments import sync_investment_transactions
from plaid_client import fetch_institution_metadata, get_plaid_for_item
from supabase_client import get_supabase, now_iso
from transfers import detect_transfers, unlink_groups

logger = logging.getLogger('sync')

STATS_KEYS = (
    'transactions_added', 'transactions_modified',
    'transactions_removed', 'accounts_updated',
)
BALANCE_FRESH_SECONDS = 6 * 3600   # F16: skip accounts_get on txn-only webhooks if balances younger than this
LOCK_STALE_MINUTES = 15            # F7: matches the migration comment


def _new_stats() -> dict:
    return {k: 0 for k in STATS_KEYS}


# ── Plaid-owned columns (single source of truth) ─────────────────────
# The columns the sync pipeline owns on a transactions row and may overwrite
# freely; everything else (category_id, notes, hidden, exclude_from_totals,
# transfer_*, tags, splits) is user-owned and must never be written by sync
# or the reconciler. The added path, the modified path, and reconcile.py all
# consume this projection — one truth, no field-list drift.
PLAID_OWNED = ('date', 'authorized_date', 'amount', 'merchant_name',
               'description', 'plaid_category', 'plaid_category_detail',
               'pending', 'merchant_city', 'merchant_region', 'merchant_country',
               'merchant_postal_code', 'merchant_store_number', 'merchant_lat',
               'merchant_lon', 'iso_currency_code')


def plaid_txn_fields(txn: dict) -> dict:
    """A Plaid transaction projected onto the PLAID_OWNED columns, in DB
    representation."""
    pfc = txn.get('personal_finance_category') or {}
    loc = txn.get('location') or {}
    return {
        'date': str(txn['date']),
        'authorized_date': str(txn['authorized_date']) if txn.get('authorized_date') else None,
        'amount': float(txn['amount']),
        'merchant_name': txn.get('merchant_name'),
        'description': txn.get('name'),
        'plaid_category': pfc.get('primary'),
        'plaid_category_detail': pfc.get('detailed'),
        'pending': txn['pending'],
        # Merchant location (Plaid `location`); each field is independently
        # optional — Plaid populates whatever it resolved for the merchant.
        'merchant_city': loc.get('city'),
        'merchant_region': loc.get('region'),
        'merchant_country': loc.get('country'),
        'merchant_postal_code': loc.get('postal_code'),
        'merchant_store_number': loc.get('store_number'),
        'merchant_lat': loc.get('lat'),
        'merchant_lon': loc.get('lon'),
        # Settlement currency. Prefer the ISO code; fall back to the
        # unofficial code Plaid uses for crypto / non-ISO currencies.
        'iso_currency_code': txn.get('iso_currency_code') or txn.get('unofficial_currency_code'),
    }


def txn_sync_request(access_token, cursor=None) -> TransactionsSyncRequest:
    # Don't pass the cursor kwarg at all on a fresh start — the SDK treats
    # absent vs None differently.
    if cursor:
        return TransactionsSyncRequest(access_token=access_token,
                                       cursor=cursor, count=500)
    return TransactionsSyncRequest(access_token=access_token, count=500)


def _fill_user_owned_defaults(rows: list) -> list:
    """Fill user-owned NOT NULL columns on brand-new transaction rows before the
    batch upsert.

    `is_reimbursement` is user-owned and NOT NULL (default false); the
    categorizer only ever sets it to True, leaving the key absent otherwise. An
    explicit None must never reach the insert — one 23502 (null in NOT NULL)
    fails the *whole* batch upsert, which stalls a fresh item's initial
    sync/backfill (see rudra's Bilt item, POC). Coalesce defensively so no
    upstream path can reintroduce that crash."""
    for r in rows:
        if r.get('is_reimbursement') is None:
            r['is_reimbursement'] = False
    return rows


def _is_product_not_ready(exc: Exception) -> bool:
    """True if a Plaid call failed with PRODUCT_NOT_READY — the item exists but
    Plaid hasn't finished preparing its transactions yet. Expected right after
    linking (and on an immediate backfill); Plaid fires the HISTORICAL_UPDATE
    webhook once ready, which re-drives the sync, so this is a soft skip, not an
    error."""
    if not isinstance(exc, ApiException):
        return False
    body = exc.body or '{}'
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        return False
    # A well-formed but non-object body (JSON string/array) has no error_code.
    return isinstance(parsed, dict) and parsed.get('error_code') == 'PRODUCT_NOT_READY'


def amounts_equal(a, b) -> bool:
    """Compare in cents: the DB column is decimal(12,2) while Plaid amounts are
    raw floats that can carry sub-cent precision (FX, pro-rated) — raw float
    equality against the rounded stored value never converges."""
    return round(float(a) * 100) == round(float(b) * 100)


# ── sync_log helpers (shared by cron + webhook, F13) ─────────────────
def _log_start(supabase, user_id=None) -> str:
    row = {'status': 'running'}
    if user_id:
        row['user_id'] = user_id   # cron full-run leaves it null (global row)
    return supabase.table('sync_log').insert(row).execute().data[0]['id']


def _log_end(supabase, log_id, status, stats=None, error=None):
    supabase.table('sync_log').update({
        'finished_at': now_iso(),
        'status': status,
        **(stats or {}),
        **({'error_message': error} if error else {}),
    }).eq('id', log_id).execute()


# ── per-item lock (F7) ───────────────────────────────────────────────
def _acquire_item_lock(supabase, item_id) -> bool:
    """Claim the item via a conditional update; skip if another sync holds it.
    ponytail: flag + 15-min stale timeout, not pg_advisory_lock — advisory locks
    leak across PostgREST's pooled connections. Timeout frees a crashed sync."""
    stale = (datetime.datetime.now(datetime.UTC)
             - datetime.timedelta(minutes=LOCK_STALE_MINUTES)).isoformat()
    res = supabase.table('plaid_items').update({
        'is_syncing': True, 'sync_started_at': now_iso(),
    }).eq('id', item_id).or_(f'is_syncing.eq.false,sync_started_at.lt.{stale}').execute()
    return len(res.data) == 1


def _release_item_lock(supabase, item_id):
    supabase.table('plaid_items').update({'is_syncing': False}).eq('id', item_id).execute()


def _is_demo_item(item: dict) -> bool:
    """Seeded demo items (seed_demo_user.py: plaid_item_id 'demo-…') carry a
    fake access token and exist only to showcase data — never call Plaid for
    them, and don't count them as sync failures."""
    return (item.get('plaid_item_id') or '').startswith('demo-')


def _balances_stale(item: dict) -> bool:
    last = item.get('last_synced_at')
    if not last:
        return True
    try:
        last_dt = datetime.datetime.fromisoformat(last.replace('Z', '+00:00'))
    except ValueError:
        return True
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=datetime.UTC)
    age = datetime.datetime.now(datetime.UTC) - last_dt
    return age.total_seconds() > BALANCE_FRESH_SECONDS


def is_liability(account_type) -> bool:
    """Credit/loan balances count against net worth; everything else is an asset."""
    return account_type in ('credit', 'loan')


def _finalize_user(supabase, user_id, full, backfill=False, item_errors=None, since=None):
    """Post-sync per-user aggregates: link transfers, materialize recurring
    contributions, refresh today's net-worth snapshot.

    Also reconstruct/fill net-worth history when either:
      • `full` — initial link / historical update: the transaction window just
        widened to its max, so a brand-new user gets history instead of an empty
        "Not enough history yet" trend; or
      • `backfill` — an app-triggered refresh (pull-to-refresh / the Balances
        refresh button). An already-linked user's items carry cursors, so their
        manual sync is incremental (`full` is False), but they still expect a
        refresh to surface history — so fill it here too.
    Cron's routine incremental sweep passes neither and stays cheap. The
    backfill only fills missing days, so it's a no-op once history exists."""
    detect_transfers(supabase, user_id, full=full)
    materialize_recurring_contributions(supabase, user_id)
    write_net_worth_snapshot(supabase, user_id)
    if full or backfill:
        # Lazy import: backfill_net_worth imports is_liability from this module.
        from backfill_net_worth import DEFAULT_DAYS, backfill_user
        try:
            res = backfill_user(supabase, user_id, days=DEFAULT_DAYS,
                                today=datetime.date.today(), dry_run=False)
        except Exception:
            # Today's snapshot already wrote above; a history backfill is a nice-
            # to-have, so its failure must not fail the sync or, in the cron
            # sweep, block the remaining users' finalize.
            logger.exception('net-worth backfill failed', extra={'user_id': user_id})
        else:
            if not res['skipped'] and res['filled']:
                logger.info('backfilled net-worth history', extra={
                    'user_id': user_id, 'days_filled': res['filled'],
                    'flat_accounts': [name for name, _ in res['flagged']]})

    # Best-effort alert evaluation: insert notifications for budget /
    # large-charge / low-balance / sync-failure rules. Alerts are a nice-to-have
    # bolted onto the sync — a failure here must never break or fail the sync, so
    # it's isolated. Lazy import keeps alerts.py out of sync.py's import graph.
    try:
        from alerts import evaluate_user_alerts
        evaluate_user_alerts(supabase, user_id, item_errors=item_errors, since=since)
    except Exception:
        logger.exception('alert evaluation failed', extra={'user_id': user_id})


def _ensure_institution_branding(plaid, supabase, item):
    """Self-heal missing Plaid branding (logo/color/url) on existing items —
    covers items linked before branding shipped and link-time fetch failures.
    ponytail: institutions with no metadata at all re-fetch every sync (the
    best-effort {} result leaves no marker); any stored url/logo stops it."""
    if item.get('institution_logo') or item.get('institution_url') \
            or not item.get('institution_id'):
        return
    meta = fetch_institution_metadata(plaid, item['institution_id'])
    if meta:
        supabase.table('plaid_items').update(meta).eq('id', item['id']).execute()
        logger.info('backfilled institution branding',
                    extra={'institution': item.get('institution_name')})


def run_sync(user_id: str = None):
    """Full sync. user_id=None (cron) syncs every user's items; a user_id
    (app-triggered) syncs only that user's items."""
    supabase = get_supabase()

    log_id = _log_start(supabase, user_id)
    stats = _new_stats()
    # Bounds large_charge alerts to rows written this run (created_at >= this).
    run_started_at = now_iso()

    try:
        q = supabase.table('plaid_items').select('*').eq('is_active', True)
        if user_id:
            q = q.eq('user_id', user_id)
        items = q.execute().data

        # One bad credential set (e.g. a user's trial account got closed) must
        # not take down everyone else's cron sync — isolate failures per item.
        item_errors = []
        # Per-user errored items for the sync_failed alert; parallel to
        # item_errors (which is a human-readable blob for the sync_log).
        item_errors_by_user = {}
        ctx_by_user = {}
        for item in items:
            uid = item['user_id']
            if _is_demo_item(item):
                logger.info('skipping demo item (fake token, showcase data)', extra={
                    'institution': item['institution_name'],
                    'plaid_item_id': item['plaid_item_id'], 'user_id': uid,
                })
                continue
            if uid not in ctx_by_user:
                ctx_by_user[uid] = load_guess_context(uid)
            logger.info('syncing item', extra={
                'institution': item['institution_name'], 'user_id': uid,
            })
            try:
                plaid = get_plaid_for_item(supabase, item)
                _ensure_institution_branding(plaid, supabase, item)
                sync_item(plaid, supabase, item, ctx_by_user[uid], stats, uid, refresh_balances=True)
            except Exception:
                err = traceback.format_exc()
                item_errors.append(f"{item.get('institution_name')} ({item.get('plaid_item_id')}):\n{err}")
                item_errors_by_user.setdefault(uid, []).append({
                    'item_id': item['id'],
                    'plaid_item_id': item.get('plaid_item_id'),
                    'institution_name': item.get('institution_name'),
                })
                logger.exception('item sync failed', extra={
                    'institution': item.get('institution_name'),
                    'plaid_item_id': item.get('plaid_item_id'), 'user_id': uid,
                })

        # Per-user aggregates (net worth mixes users if computed globally).
        # Transfers detect per-user, after every item synced, so a pair whose
        # legs live at two institutions (checking at Chase, card at Amex) links.
        # A first-ever item sync (no cursor) ingests full history, so detection
        # must scan full history too, not just the incremental lookback.
        first_history = {i['user_id'] for i in items
                         if not i.get('cursor') or i.get('backfill_requested')}
        if user_id:
            user_ids = {user_id}
        else:
            # Cron sweep. Finalize every user with Plaid items, PLUS users whose only
            # data is manual: a recurring contribution must materialize on schedule
            # even when the user has no Plaid item to drive a sync, so the item-derived
            # set alone skipped manual-only users entirely. Union in the owners
            # of active recurring flows (service role → all users; RLS is bypassed).
            user_ids = {i['user_id'] for i in items}
            manual_flow_users = supabase.table('recurring_contributions') \
                .select('user_id') \
                .eq('is_active', True) \
                .execute().data
            user_ids |= {r['user_id'] for r in manual_flow_users}
        # A single user_id means this run was app-triggered (Balances refresh /
        # pull-to-refresh) — fill net-worth history too; None is the cron sweep.
        for uid in user_ids:
            _finalize_user(supabase, uid, full=uid in first_history,
                           backfill=bool(user_id),
                           item_errors=item_errors_by_user.get(uid),
                           since=run_started_at)

        if item_errors:
            _log_end(supabase, log_id, 'error', stats, error='\n\n'.join(item_errors))
            logger.warning('sync finished with failed items',
                           extra={'failed_items': len(item_errors), **stats})
        else:
            _log_end(supabase, log_id, 'success', stats)
            logger.info('sync complete', extra=stats)

    except Exception:
        error_msg = traceback.format_exc()
        logger.exception('sync run failed', extra={'user_id': user_id})
        _log_end(supabase, log_id, 'error', error=error_msg)


def sync_item(plaid, supabase, item: dict, ctx: dict, stats: dict, user_id: str, refresh_balances: bool = True):
    item_id = item['id']
    if not _acquire_item_lock(supabase, item_id):
        logger.info('skipping item, sync already in progress',
                    extra={'institution': item.get('institution_name')})
        return
    try:
        # Re-read cursor under the lock: another sync may have advanced it
        # between our select and acquiring the lock.
        fresh = supabase.table('plaid_items') \
            .select('cursor, last_synced_at, backfill_requested') \
            .eq('id', item_id).single().execute().data
        item = {**item, **fresh}

        # If a backfill was requested (POST /backfill/{item_id}) while another
        # sync held the lock, that sync may have saved a cursor after the
        # backfill cleared it. Honour the flag: reset cursor to None so this
        # run fetches full history, then clear the flag atomically.
        if item.get('backfill_requested'):
            item['cursor'] = None
            supabase.table('plaid_items').update({
                'cursor': None,
                'backfill_requested': False,
            }).eq('id', item_id).execute()

        _sync_item_locked(plaid, supabase, item, ctx, stats, user_id, refresh_balances)
    except ApiException as exc:
        # A just-linked (or just-backfilled) item whose history Plaid hasn't
        # finished preparing. Not a failure: skip quietly and let the
        # HISTORICAL_UPDATE webhook re-drive the sync when Plaid is ready, so
        # we don't log an error or fire a spurious sync_failed alert.
        if _is_product_not_ready(exc):
            logger.info('item not ready yet (Plaid still preparing history); '
                        'will sync on the HISTORICAL_UPDATE webhook',
                        extra={'institution': item.get('institution_name'),
                               'item_id': item_id})
            return
        raise
    finally:
        _release_item_lock(supabase, item_id)


def _sync_item_locked(plaid, supabase, item, ctx, stats, user_id, refresh_balances):
    access_token = vault.decrypt(item['access_token'])   # legacy plaintext passes through
    item_id = item['id']

    # ── Accounts & balances ──────────────────────────────────────────
    # F16: on a txn-only webhook with fresh balances, skip the Plaid
    # accounts_get + balance rewrite and just load the id map from the DB.
    if refresh_balances:
        acct_map, acct_types = _refresh_accounts_and_balances(plaid, supabase, access_token, item_id, user_id, stats)
    else:
        acct_map, acct_types = _load_account_map(supabase, item_id)

    # ── Transactions (cursor-based, incremental) ──────────────────────
    cursor = item.get('cursor') or None  # None = full history on first run
    has_more = True

    while has_more:
        response = plaid.transactions_sync(txn_sync_request(access_token, cursor)).to_dict()

        # Added — resolve account_id from the in-memory map (F1), no per-txn query.
        new_txns = []
        for txn in response.get('added', []):
            acct_uuid = acct_map.get(txn['account_id'])
            if acct_uuid is None:
                # A brand-new account appeared in transactions but not the map
                # (skipped accounts_get, or created since). Refresh once.
                acct_map, acct_types = _refresh_accounts_and_balances(plaid, supabase, access_token, item_id, user_id, stats)
                acct_uuid = acct_map[txn['account_id']]
            new_txns.append({
                'user_id': user_id,
                'plaid_transaction_id': txn['transaction_id'],
                'account_id': acct_uuid,
                'category_id': None,
                'is_reimbursement': False,
                **plaid_txn_fields(txn),
            })

        new_txns = _fill_user_owned_defaults(apply_learned(new_txns, ctx, acct_types))

        if new_txns:
            # DO NOTHING on conflict: an added event can replay over an existing
            # row (crash-replay of a page, or a row reconcile.py healed ahead of
            # the cursor) — merge semantics would reset category_id and clobber
            # user edits. Pending→posted never needs the merge: Plaid issues a
            # new transaction_id plus a removed event for the pending one.
            supabase.table('transactions').upsert(
                new_txns,
                on_conflict='plaid_transaction_id',
                ignore_duplicates=True,
            ).execute()
            stats['transactions_added'] += len(new_txns)

        # Modified (don't overwrite user's category).
        # ponytail: per-row UPDATE — each row has distinct values; batch only if
        # a bank ever streams large modified sets.
        modified = response.get('modified', [])
        # An amount change breaks an auto-detected pair's net-zero invariant —
        # unlink so this run's detect pass re-evaluates. Manual links are the
        # user's assertion; leave them alone. One batched pre-read, not per-row.
        if modified:
            prev_by_id = {r['plaid_transaction_id']: r for r in supabase
                          .table('transactions')
                          .select('id, plaid_transaction_id, amount, transfer_group_id, transfer_kind')
                          .in_('plaid_transaction_id', [t['transaction_id'] for t in modified])
                          .execute().data}
            amount_changed = [p for t in modified
                              if (p := prev_by_id.get(t['transaction_id']))
                              and not amounts_equal(p['amount'], t['amount'])]
            broken = [p['transfer_group_id'] for p in amount_changed
                      if p.get('transfer_kind') == 'auto']
            unlink_groups(supabase, broken)
            # User-owned splits sum to the OLD amount; a changed amount leaves them
            # stale (and would trip the split_sum_balanced constraint on the next
            # edit). Clear them so the txn re-surfaces as uncategorized, mirroring
            # the auto-transfer unlink above. Sync never re-creates splits.
            changed_ids = [p['id'] for p in amount_changed]
            if changed_ids:
                supabase.table('transaction_splits').delete() \
                    .in_('transaction_id', changed_ids).execute()
        for txn in modified:
            supabase.table('transactions').update({
                **plaid_txn_fields(txn),
                'updated_at': now_iso(),
            }).eq('plaid_transaction_id', txn['transaction_id']).execute()
            stats['transactions_modified'] += 1

        # Removed — one batched delete (F4).
        removed_ids = [t['transaction_id'] for t in response.get('removed', [])]
        if removed_ids:
            # A deleted leg (usually a pending row replaced by its posted twin)
            # would orphan its transfer partner: unlink those groups after the
            # delete so survivors re-pair on this run's detect pass. Manual
            # groups too — the pair is physically gone, and unlink_groups sets
            # no opt-out, so the replacement resurfaces via suggestions.
            linked = supabase.table('transactions') \
                .select('transfer_group_id') \
                .in_('plaid_transaction_id', removed_ids) \
                .execute().data
            supabase.table('transactions') \
                .delete() \
                .in_('plaid_transaction_id', removed_ids) \
                .execute()
            unlink_groups(supabase, {r['transfer_group_id'] for r in linked})
            stats['transactions_removed'] += len(removed_ids)

        cursor = response['next_cursor']
        has_more = response['has_more']

    # ── Investment cash movements (offset-paginated, not the sync cursor) ──
    # Brokerage transfers (checking↔brokerage) live behind Plaid's investments
    # product, not transactions_sync. Ingest their cash-in/out legs into the
    # same table with a synthesized transfer signal so detect_transfers pairs
    # them. Swallows its own not-available errors (un-consented / non-brokerage
    # items) so it never fails an item after its transactions already synced.
    sync_investment_transactions(plaid, supabase, access_token, item_id,
                                 acct_map, acct_types, user_id, stats,
                                 full=(item.get('cursor') is None))

    supabase.table('plaid_items').update({
        'cursor': cursor,
        'last_synced_at': now_iso(),
    }).eq('id', item_id).execute()


def _refresh_accounts_and_balances(plaid, supabase, access_token, item_id, user_id, stats) -> tuple:
    """Fetch accounts+balances from Plaid, batch-upsert both, deactivate accounts
    Plaid no longer returns (F12), and return ({plaid_account_id: uuid},
    {uuid: account_type}) (F1/F2/F3)."""
    accounts_response = plaid.accounts_get(
        AccountsGetRequest(access_token=access_token)
    ).to_dict()
    today = datetime.date.today().isoformat()

    account_rows = []
    balances_by_plaid_id = {}
    for acct in accounts_response['accounts']:
        pid = acct['account_id']
        account_rows.append({
            'user_id': user_id,
            'plaid_account_id': pid,
            'plaid_item_id': item_id,
            'name': acct['name'],
            'official_name': acct.get('official_name'),
            'type': acct['type'],
            'subtype': acct.get('subtype', ''),
            'mask': acct.get('mask'),
            'is_active': True,
        })
        balances_by_plaid_id[pid] = acct['balances']

    # F2/F3: one batch upsert; the returned rows carry the generated ids → map.
    upserted = supabase.table('accounts').upsert(
        account_rows, on_conflict='plaid_account_id'
    ).execute().data
    acct_map = {r['plaid_account_id']: r['id'] for r in upserted}
    acct_types = {r['id']: r['type'] for r in upserted}
    stats['accounts_updated'] += len(acct_map)

    # F3: batch balance-history rows.
    balance_rows = []
    for pid, balance in balances_by_plaid_id.items():
        current = balance.get('current')
        if current is None:
            continue
        available = balance.get('available')
        balance_rows.append({
            'user_id': user_id,
            'account_id': acct_map[pid],
            'date': today,
            'current_balance': float(current),
            'available_balance': float(available) if available is not None else None,
        })
    if balance_rows:
        supabase.table('account_balance_history').upsert(
            balance_rows, on_conflict='account_id,date'
        ).execute()

    # F12: deactivate this item's accounts that Plaid no longer returns.
    seen = list(acct_map.keys())
    if seen:
        supabase.table('accounts').update({'is_active': False}) \
            .eq('user_id', user_id) \
            .eq('plaid_item_id', item_id) \
            .not_.in_('plaid_account_id', seen) \
            .execute()

    return acct_map, acct_types


def _load_account_map(supabase, item_id) -> tuple:
    """Return ({plaid_account_id: uuid}, {uuid: account_type}) from the DB — the
    no-Plaid-call path used on txn-only webhooks with fresh balances."""
    rows = supabase.table('accounts') \
        .select('id, plaid_account_id, type') \
        .eq('plaid_item_id', item_id) \
        .eq('is_active', True) \
        .execute().data
    acct_map = {r['plaid_account_id']: r['id'] for r in rows}
    acct_types = {r['id']: r['type'] for r in rows}
    return acct_map, acct_types


def run_sync_for_item(plaid_item_id: str, webhook_code: str = None):
    """Sync a single item (called from the Plaid webhook). Cursor-based, idempotent."""
    supabase = get_supabase()

    rows = supabase.table('plaid_items') \
        .select('*') \
        .eq('plaid_item_id', plaid_item_id) \
        .eq('is_active', True) \
        .limit(1) \
        .execute().data
    if not rows:
        return
    item = rows[0]
    user_id = item['user_id']
    if _is_demo_item(item):
        logger.info('skipping demo item webhook (fake token, showcase data)', extra={
            'plaid_item_id': plaid_item_id, 'user_id': user_id,
        })
        return

    log_id = _log_start(supabase, user_id)   # F13: webhook path is now logged too
    stats = _new_stats()
    run_started_at = now_iso()
    try:
        plaid = get_plaid_for_item(supabase, item)
        # F16: only pull balances on first-history events or when they're stale.
        refresh = webhook_code in (None, 'INITIAL_UPDATE', 'HISTORICAL_UPDATE') or _balances_stale(item)
        sync_item(plaid, supabase, item, load_guess_context(user_id), stats, user_id, refresh_balances=refresh)
        # First-history events ingest transactions far beyond the incremental
        # lookback — scan full history so old transfers get linked/excluded too.
        full = webhook_code in ('INITIAL_UPDATE', 'HISTORICAL_UPDATE') or not item.get('cursor')
        _finalize_user(supabase, user_id, full=full, since=run_started_at)
        _log_end(supabase, log_id, 'success', stats)
        logger.info('webhook sync complete',
                    extra={'plaid_item_id': plaid_item_id, **stats})
    except Exception:
        error_msg = traceback.format_exc()
        logger.exception('webhook sync failed',
                         extra={'plaid_item_id': plaid_item_id, 'user_id': user_id})
        _log_end(supabase, log_id, 'error', error=error_msg)
        # The failure short-circuited before _finalize_user, so emit the
        # sync_failed alert here directly (best-effort — never re-raise).
        try:
            from alerts import evaluate_user_alerts
            evaluate_user_alerts(supabase, user_id, item_errors=[{
                'item_id': item['id'],
                'plaid_item_id': plaid_item_id,
                'institution_name': item.get('institution_name'),
            }])
        except Exception:
            logger.exception('sync_failed alert emit failed',
                             extra={'plaid_item_id': plaid_item_id})


def materialize_recurring_contributions(supabase, user_id):
    """Insert a separate_account_values delta for each elapsed period of every
    active recurring contribution, then advance last_applied_date."""
    today = datetime.date.today()

    flows = supabase.table('recurring_contributions') \
        .select('*') \
        .eq('user_id', user_id) \
        .eq('is_active', True) \
        .execute().data

    for flow in flows:
        freq = int(flow['frequency_in_days'])
        if freq <= 0:
            continue

        anchor = datetime.date.fromisoformat(flow['anchor_date'])
        last = flow.get('last_applied_date')
        last = datetime.date.fromisoformat(last) if last else None

        next_date = anchor if last is None else last + datetime.timedelta(days=freq)

        rows = []
        new_last = last
        while next_date <= today:
            rows.append({
                'user_id': user_id,
                'separate_account_id': flow['separate_account_id'],
                'recurring_contribution_id': flow['id'],
                'date': next_date.isoformat(),
                'amount': float(flow['delta_balance']),
                'note': 'Recurring contribution',
            })
            new_last = next_date
            next_date = next_date + datetime.timedelta(days=freq)

        if rows:
            # Idempotent against overlapping syncs: the unique
            # (recurring_contribution_id, date) index means a period a racing sync
            # already materialized is skipped instead of double-posted.
            supabase.table('separate_account_values').upsert(
                rows,
                on_conflict='recurring_contribution_id,date',
                ignore_duplicates=True,
            ).execute()
            supabase.table('recurring_contributions').update({
                'last_applied_date': new_last.isoformat(),
            }).eq('id', flow['id']).execute()
            logger.info('materialized recurring contributions', extra={
                'count': len(rows), 'separate_account_id': flow['separate_account_id'],
            })


def write_net_worth_snapshot(supabase, user_id):
    # The current_net_worth view mirrors this math for client reads (kept as
    # separate Python because the logic-fake test tier can't run SQL views).
    # A semantics change here must also land in the view's migration —
    # test_current_net_worth_view pins the parity.
    today = datetime.date.today().isoformat()

    # F8: latest balance PER account (not just today's), so an item that failed
    # to sync today still counts. type looked up from active accounts only.
    latest = supabase.table('latest_balances') \
        .select('account_id, current_balance') \
        .eq('user_id', user_id) \
        .execute().data
    accounts = supabase.table('accounts') \
        .select('id, type') \
        .eq('user_id', user_id) \
        .eq('is_active', True) \
        .execute().data
    type_by_id = {a['id']: a['type'] for a in accounts}

    total_assets = 0.0
    total_liabilities = 0.0

    for row in latest:
        acct_type = type_by_id.get(row['account_id'])
        if acct_type is None:
            continue  # inactive / removed account
        balance = float(row['current_balance'] or 0)
        if is_liability(acct_type):
            total_liabilities += max(balance, 0)
        else:
            total_assets += max(balance, 0)

    # Manual "separate accounts": balance = sum of signed value entries.
    sep_accounts = supabase.table('separate_accounts') \
        .select('id, type') \
        .eq('user_id', user_id) \
        .eq('is_active', True) \
        .execute().data

    if sep_accounts:
        sep_ids = [a['id'] for a in sep_accounts]
        # F5: one query for every ledger row, summed in Python.
        vals = supabase.table('separate_account_values') \
            .select('separate_account_id, amount') \
            .in_('separate_account_id', sep_ids) \
            .execute().data
        sums = {}
        for v in vals:
            sums[v['separate_account_id']] = sums.get(v['separate_account_id'], 0.0) + float(v['amount'] or 0)

        for acct in sep_accounts:
            balance = sums.get(acct['id'], 0.0)
            if is_liability(acct['type']):
                total_liabilities += max(balance, 0)
            else:
                total_assets += max(balance, 0)

    supabase.table('net_worth_snapshots').upsert({
        'user_id': user_id,
        'date': today,
        'total_assets': total_assets,
        'total_liabilities': total_liabilities,
    }, on_conflict='user_id,date').execute()

    logger.info('net worth snapshot written', extra={
        'user_id': user_id,
        'total_assets': round(total_assets, 2),
        'total_liabilities': round(total_liabilities, 2),
    })


if __name__ == '__main__':
    from logging_setup import setup_logging
    setup_logging()
    run_sync()
