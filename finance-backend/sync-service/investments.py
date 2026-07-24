"""Ingest Plaid **investment cash-movement** transactions into the shared
`transactions` table so brokerage transfers get real rows the transfer matcher
can pair.

Plaid's investments product exposes /investments/transactions/get — an
OFFSET-paginated endpoint, NOT the transactions_sync cursor the regular
transactions path uses. From it we keep only external cash movements
(deposits / withdrawals / contributions / distributions / transfers between the
brokerage and the outside world) and write them into `transactions` with a
*synthesized* transfer signal (plaid_category TRANSFER_IN/OUT +
plaid_category_detail TRANSFER_*_INVESTMENT_AND_RETIREMENT_FUNDS). That signal
is exactly what `transfers.detect_transfers` gates on, so an ingested leg either
auto-pairs with its outside counterpart (a checking→brokerage transfer nets to
zero) or is marked one_sided and upgraded in place if the other leg syncs later.

We deliberately DON'T ingest buys / sells / dividends / fees. A buy has
amount>0 with no transfer signal and would count as spend; treating
dividends/interest as income is a separate follow-up. Cash-movement-only bounds
the blast radius of this change to the brokerage-transfer bug it fixes.

The DB schema and the matcher are unchanged — the whole trick is synthesizing
the transfer signal at ingest time.
"""
import datetime
import json
import logging

from plaid.exceptions import ApiException
from plaid.model.investments_transactions_get_request import InvestmentsTransactionsGetRequest
from plaid.model.investments_transactions_get_request_options import InvestmentsTransactionsGetRequestOptions

logger = logging.getLogger('sync')

# Plaid investment transaction `type` values that move cash across the account boundary.
CASH_MOVEMENT_TYPES = {'cash', 'transfer'}
# Allowlisted `subtype`s that are unambiguous external cash in/out. Tunable knob.
CASH_MOVEMENT_SUBTYPES = {'deposit', 'withdrawal', 'contribution', 'distribution', 'transfer'}
INVEST_LOOKBACK_DAYS = 30            # incremental window
INVEST_FULL_DAYS = 730              # full/backfill window (matches the txn window in api.py)
_INVEST_PAGE = 500


def _is_cash_movement(itxn: dict) -> bool:
    if itxn.get('amount') is None or abs(float(itxn['amount'])) == 0:
        return False
    return (itxn.get('type') or '') in CASH_MOVEMENT_TYPES \
        and (itxn.get('subtype') or '') in CASH_MOVEMENT_SUBTYPES


def plaid_investment_txn_fields(itxn: dict) -> dict:
    """A Plaid investment cash movement projected onto the sync-owned columns,
    in DB representation. Analogous to sync.plaid_txn_fields.

    Sign convention matches the app (positive = cash OUT of account, negative =
    cash IN). We synthesize the transfer signal here so detect_transfers can act
    on it: an inflow reads as TRANSFER_IN, an outflow as TRANSFER_OUT, both with
    the INVESTMENT_AND_RETIREMENT_FUNDS detail (a member of the matcher's
    ONE_SIDED_DETAILS allowlist)."""
    amt = float(itxn['amount'])
    inflow = amt < 0
    return {
        'date': str(itxn['date']),
        'authorized_date': None,
        'amount': amt,
        'merchant_name': None,
        'description': itxn.get('name'),
        'plaid_category': 'TRANSFER_IN' if inflow else 'TRANSFER_OUT',
        'plaid_category_detail': 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS' if inflow
                                 else 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
        'pending': False,
        'merchant_city': None, 'merchant_region': None, 'merchant_country': None,
        'merchant_postal_code': None, 'merchant_store_number': None,
        'merchant_lat': None, 'merchant_lon': None,
        'iso_currency_code': itxn.get('iso_currency_code') or itxn.get('unofficial_currency_code'),
    }


def _is_investments_unavailable(exc: Exception) -> bool:
    """True if a /investments/transactions/get call failed because the item
    can't serve investment data — un-consented, not enabled, has no brokerage
    accounts, or isn't ready yet. Mirrors sync._is_product_not_ready's
    body-parsing but soft-skips a wider set of error codes: an old item linked
    without the investments product (or one the user never consented to) must
    never fail the whole sync just because we asked for its investment txns."""
    if not isinstance(exc, ApiException):
        return False
    body = exc.body or '{}'
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        return False
    # A well-formed but non-object body (JSON string/array) has no error_code.
    return isinstance(parsed, dict) and parsed.get('error_code') in {
        'PRODUCT_NOT_READY', 'PRODUCTS_NOT_SUPPORTED', 'ADDITIONAL_CONSENT_REQUIRED',
        'NO_INVESTMENT_ACCOUNTS', 'PRODUCT_NOT_ENABLED',
    }


def sync_investment_transactions(plaid, supabase, access_token, item_id, acct_map,
                                 acct_types, user_id, stats, full=False):
    """Pull this item's external investment cash movements and upsert them into
    `transactions` with a synthesized transfer signal.

    Skips items with no brokerage account (don't spend a paid Plaid call), and
    soft-skips items that can't serve investment data (see
    _is_investments_unavailable) so an un-consented/old item never fails the
    sync after its regular transactions already synced. This MUST swallow those
    errors here: sync_item's outer handler only soft-skips PRODUCT_NOT_READY and
    would otherwise fail the item."""
    if 'investment' not in acct_types.values():
        logger.debug('no investment account on item; skipping investment txn sync',
                     extra={'item_id': item_id, 'user_id': user_id})
        return

    end = datetime.date.today()
    start = end - datetime.timedelta(days=INVEST_FULL_DAYS if full else INVEST_LOOKBACK_DAYS)

    rows = []
    offset = 0
    try:
        while True:
            req = InvestmentsTransactionsGetRequest(
                access_token=access_token,
                start_date=start,
                end_date=end,
                options=InvestmentsTransactionsGetRequestOptions(count=_INVEST_PAGE, offset=offset),
            )
            resp = plaid.investments_transactions_get(req).to_dict()
            page = resp.get('investment_transactions', [])
            for itxn in page:
                if not _is_cash_movement(itxn):
                    continue
                acct_uuid = acct_map.get(itxn['account_id'])
                if acct_uuid is None:
                    continue
                rows.append({
                    'user_id': user_id,
                    'plaid_transaction_id': itxn['investment_transaction_id'],
                    'account_id': acct_uuid,
                    'category_id': None,
                    'is_reimbursement': False,
                    **plaid_investment_txn_fields(itxn),
                })
            offset += len(page)
            if offset >= resp['total_investment_transactions'] or not page:
                break
    except ApiException as exc:
        if _is_investments_unavailable(exc):
            logger.info('investment transactions unavailable for item; skipping',
                        extra={'item_id': item_id, 'user_id': user_id})
            return
        raise

    if rows:
        # DO NOTHING on conflict (same as sync.py's added path): an ingested leg
        # can replay across syncs, and the matcher may already have set its
        # transfer_group_id / exclude_from_totals — merge semantics would clobber
        # that. Don't set exclude_from_totals / transfer_group_id / transfer_kind
        # here: the matcher owns those (and the transfer_kind_matches_group CHECK
        # requires group + kind together).
        supabase.table('transactions').upsert(
            rows,
            on_conflict='plaid_transaction_id',
            ignore_duplicates=True,
        ).execute()
        # They ARE transactions; sync_log has no separate investment column.
        stats['transactions_added'] += len(rows)
        logger.info('investment cash movements ingested', extra={
            'item_id': item_id, 'user_id': user_id, 'count': len(rows),
        })
