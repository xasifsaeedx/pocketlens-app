from supabase_client import get_supabase
from transfers import PFC_TRANSFER


def _merchant_key(txn: dict) -> str:
    """Normalized merchant identity. MUST match the app's Transaction.merchantKey
    (lowercased, trimmed merchant_name, falling back to description)."""
    return (txn.get('merchant_name') or txn.get('description') or '').strip().lower()


def load_guess_context(user_id: str) -> dict:
    """Everything needed to guess categories for one user:
    learned merchant memory, conditional keyword rules (longest first), and the
    Income id."""
    sb = get_supabase()

    rule_rows = sb.table('category_rules') \
        .select('keyword, category_id, direction, min_amount, max_amount, set_reimbursement') \
        .eq('user_id', user_id) \
        .execute().data or []
    # A rule needs a keyword to match on and at least one action (set a category
    # and/or flag a reimbursement). Legacy rows carry only keyword+category_id and
    # keep behaving exactly as before (direction/min/max null = "any").
    rules = [
        r for r in rule_rows
        if (r.get('keyword') or '').strip()
        and (r.get('category_id') or r.get('set_reimbursement'))
    ]
    rules.sort(key=lambda r: len(r['keyword']), reverse=True)  # specificity, not priority

    mem_rows = sb.table('merchant_categories') \
        .select('merchant_key, category_id') \
        .eq('user_id', user_id) \
        .execute().data or []
    memory = {r['merchant_key']: r['category_id'] for r in mem_rows}

    cats = sb.table('categories') \
        .select('id, name') \
        .eq('user_id', user_id) \
        .execute().data or []
    income_id = next((c['id'] for c in cats if c['name'] == 'Income'), None)

    return {'rules': rules, 'memory': memory, 'income_id': income_id}


def _rule_matches(rule: dict, txn: dict) -> bool:
    """Does a conditional rule fire on this transaction? ALL present conditions
    must pass: keyword substring (required), then optionally money direction and
    amount magnitude. Sign convention: amount POSITIVE = spend/outflow, NEGATIVE =
    money-in/inflow, so direction 'in' <=> amount < 0 and 'out' <=> amount > 0;
    the min/max bounds compare against ABS(amount) (inclusive). Mirrors
    web categorySuggester.ruleMatches + Swift CategorySuggester.ruleMatches."""
    keyword = (rule.get('keyword') or '').lower()
    if not keyword:
        return False
    hay = ((txn.get('merchant_name') or '') + ' ' + (txn.get('description') or '')).lower()
    if keyword not in hay:
        return False

    amount = txn.get('amount') or 0
    direction = rule.get('direction')
    if direction == 'in' and not amount < 0:
        return False
    if direction == 'out' and not amount > 0:
        return False

    mag = abs(amount)
    lo, hi = rule.get('min_amount'), rule.get('max_amount')
    if lo is not None and mag < lo:
        return False
    if hi is not None and mag > hi:
        return False
    return True


def _is_card_refund(txn: dict, acct_types: dict) -> bool:
    """A credit (amount < 0) on a credit/loan account that isn't a Plaid transfer
    is a refund / return / statement credit — a contra-expense that nets down
    spend, NOT income (a bank reports a card refund as negative spend). Card
    payoffs carry PFC `LOAN_PAYMENTS`, which `PFC_TRANSFER` already excludes, so
    they never get mistaken for a refund. Depository credits (real payroll, Zelle
    in) are intentionally NOT covered — only card/loan accounts."""
    if (txn.get('amount') or 0) >= 0:
        return False
    if (acct_types or {}).get(txn.get('account_id')) not in ('credit', 'loan'):
        return False
    return (txn.get('plaid_category') or '') not in PFC_TRANSFER


def apply_learned(transactions: list[dict], ctx: dict, acct_types: dict = None) -> list[dict]:
    """On sync, auto-apply only high-confidence, user-derived guesses:
    learned merchant memory → conditional keyword rules → income by amount sign.
    A matched rule can set a category and/or flag the row as a reimbursement
    (contra-expense). Plaid-category guesses are intentionally NOT auto-applied —
    they surface in the in-app review flow so the user confirms them (and thereby
    teaches memory).

    `acct_types` maps account_id (uuid) → account type, used to auto-flag credit-
    card refunds as reimbursements (see `_is_card_refund`)."""
    memory = ctx['memory']
    rules = ctx['rules']
    income_id = ctx['income_id']

    for txn in transactions:
        # The most specific (longest-keyword) rule whose conditions all pass wins;
        # `rules` is pre-sorted longest-first. It drives both actions below.
        winner = next((r for r in rules if _rule_matches(r, txn)), None)
        card_refund = _is_card_refund(txn, acct_types)

        if not txn.get('category_id'):
            key = _merchant_key(txn)
            if key and key in memory:
                txn['category_id'] = memory[key]
            elif winner and winner.get('category_id'):
                txn['category_id'] = winner['category_id']
            # positive amount = money out (spend); negative = money in (income).
            # Plaid transfer signals are exempt: a TRANSFER_IN leg is money moved,
            # not income — transfer detection will exclude it instead. A card
            # refund is exempt too: it's a contra-expense, not income (flagged
            # below), and stays uncategorized so it surfaces in the review queue.
            elif income_id and (txn.get('amount') or 0) < 0 \
                    and (txn.get('plaid_category') or '') not in PFC_TRANSFER \
                    and not card_refund:
                txn['category_id'] = income_id

        # Reimbursement is an orthogonal action: flag the credit so it nets its
        # category's spend down instead of counting as income. `is_reimbursement`
        # is user-owned, so this only ever fills it on a brand-new row (default
        # false); the Plaid projection never touches it. A rule can flag it, and a
        # credit-card refund is auto-flagged (the whole point of this pass).
        if (winner and winner.get('set_reimbursement')) or card_refund:
            txn['is_reimbursement'] = True

    return transactions
