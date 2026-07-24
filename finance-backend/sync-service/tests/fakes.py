"""In-memory stand-ins for the Supabase (PostgREST) client and the Plaid client.

The real modules under test take a `supabase` (and `plaid`) object and only ever
call it through the PostgREST fluent API. FakeSupabase implements that API against
plain dicts so tests exercise the *actual* production code paths end to end —
insert/upsert/update/delete then read the resulting rows back — with no network,
no credentials, and no live database.

Supported surface (everything sync.py / categorizer.py / transfers.py /
write_net_worth / materialize_recurring actually use):
    table(name).select(...).eq/.in_/.not_.in_/.is_/.gte/.lte/.or_/.order/.limit/.single().execute()
    table(name).insert(rows).execute()
    table(name).upsert(rows, on_conflict="a,b").execute()
    table(name).update(patch).eq(...).execute()
    table(name).delete().in_(...).execute()
"""
import datetime


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db, table):
        self.db = db
        self.table = table
        self.op = "select"
        self.payload = None
        self.on_conflict = None
        self.filters = []          # list of (kind, col, value); kind ∈ eq|in|notin
        self._single = False
        self._negate = False       # set by the `.not_` property for the next filter

    # ── op setters ──
    def select(self, *a, **k):
        self.op = "select"
        return self

    def insert(self, payload, **k):
        self.op = "insert"
        self.payload = payload
        return self

    def upsert(self, payload, on_conflict=None, ignore_duplicates=False, **k):
        self.op = "upsert"
        self.payload = payload
        self.on_conflict = on_conflict
        self.ignore_duplicates = ignore_duplicates
        return self

    def update(self, payload, **k):
        self.op = "update"
        self.payload = payload
        return self

    def delete(self, **k):
        self.op = "delete"
        return self

    # ── filters ──
    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def in_(self, col, vals):
        kind = "notin" if self._negate else "in"
        self._negate = False
        self.filters.append((kind, col, list(vals)))
        return self

    def is_(self, col, val):
        # Only the 'null' form is used ("col is null").
        assert val == "null", f"fake is_ only supports 'null', got {val!r}"
        self.filters.append(("isnull", col, None))
        return self

    def gte(self, col, val):
        self.filters.append(("gte", col, val))
        return self

    def lte(self, col, val):
        self.filters.append(("lte", col, val))
        return self

    def or_(self, expr):
        # Only used by the item-lock update; matching is handled by the eq filters,
        # so the OR is a no-op for state purposes (recorded for completeness).
        self.filters.append(("or", None, expr))
        return self

    @property
    def not_(self):
        self._negate = True
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def single(self):
        self._single = True
        return self

    # ── run ──
    def _match(self, row):
        for kind, col, val in self.filters:
            if kind == "eq" and row.get(col) != val:
                return False
            if kind == "in" and row.get(col) not in val:
                return False
            if kind == "notin" and row.get(col) in val:
                return False
            if kind == "isnull" and row.get(col) is not None:
                return False
            if kind == "gte" and not (row.get(col) is not None and row[col] >= val):
                return False
            if kind == "lte" and not (row.get(col) is not None and row[col] <= val):
                return False
        return True

    def _conflict_keys(self):
        return [c.strip() for c in (self.on_conflict or "").split(",") if c.strip()]

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        self.db.calls.append((self.table, self.op, self.filters))

        if self.op == "select":
            hits = [dict(r) for r in rows if self._match(r)]
            if hasattr(self, "_range"):
                start, end = self._range
                hits = hits[start:end + 1]
            hits = hits[: getattr(self, "_limit", len(hits))]
            if self._single:
                return _Result(hits[0] if hits else None)
            return _Result(hits)

        if self.op == "insert":
            payload = self.payload if isinstance(self.payload, list) else [self.payload]
            out = [self.db._insert(self.table, dict(r)) for r in payload]
            return _Result([dict(r) for r in out])

        if self.op == "upsert":
            payload = self.payload if isinstance(self.payload, list) else [self.payload]
            keys = self._conflict_keys()
            out = []
            for r in payload:
                r = dict(r)
                existing = None
                if keys:
                    existing = next(
                        (e for e in rows if all(e.get(k) == r.get(k) for k in keys)), None
                    )
                if existing is not None:
                    if not getattr(self, "ignore_duplicates", False):
                        existing.update(r)
                        self.db._derive(self.table, existing)
                        out.append(existing)
                    # ignore-duplicates = ON CONFLICT DO NOTHING RETURNING *:
                    # conflicted rows are absent from the response data.
                else:
                    out.append(self.db._insert(self.table, r))
            return _Result([dict(r) for r in out])

        if self.op == "update":
            changed = []
            for r in rows:
                if self._match(r):
                    r.update(self.payload)
                    self.db._derive(self.table, r)
                    changed.append(dict(r))
            return _Result(changed)

        if self.op == "delete":
            keep = [r for r in rows if not self._match(r)]
            removed = [r for r in rows if self._match(r)]
            self.db.tables[self.table] = keep
            return _Result(removed)

        raise AssertionError(f"unhandled op {self.op}")


class FakeSupabase:
    def __init__(self, tables=None):
        # tables: {name: [row, ...]} initial state (rows are copied and get the
        # same derived columns/defaults as inserted rows)
        self.tables = {k: [dict(r) for r in v] for k, v in (tables or {}).items()}
        for name, rows in self.tables.items():
            for r in rows:
                self._derive(name, r)
        self.calls = []
        self._seq = 0

    def table(self, name):
        return _Query(self, name)

    # PostgREST 'from' alias, in case a code path uses it.
    from_ = table

    def _insert(self, table, row):
        if "id" not in row or row["id"] is None:
            self._seq += 1
            row["id"] = f"{table}-{self._seq}"
        self._derive(table, row)
        self.tables.setdefault(table, []).append(row)
        return row

    @staticmethod
    def _derive(table, row):
        # net_worth is a generated column in Postgres; mirror it so reads match prod.
        if table == "net_worth_snapshots" and "total_assets" in row and "total_liabilities" in row:
            row["net_worth"] = round(
                float(row["total_assets"]) - float(row["total_liabilities"]), 2
            )
        # transactions: mirror the generated effective_date and the column
        # defaults transfer detection filters on, so sync-inserted rows (whose
        # payloads omit them) behave like prod.
        # plaid_credentials: mirror the column defaults (schema migration
        # 20260708000000) so rows inserted through the API read back like prod.
        if table == "plaid_credentials":
            row.setdefault("plaid_env", "production")
            row.setdefault("item_limit", 10)
            row.setdefault("is_active", True)
        if table == "transactions":
            if "date" in row:
                row["effective_date"] = row.get("authorized_date") or row["date"]
            row.setdefault("hidden", False)
            row.setdefault("exclude_from_totals", False)
            row.setdefault("is_reimbursement", False)
            row.setdefault("transfer_opt_out", False)
            row.setdefault("transfer_group_id", None)
            row.setdefault("transfer_kind", None)
            # created_at is `default now()` in prod. Mirror it so a row inserted
            # through the sync path (which omits it) reads back as "just
            # ingested" — the incremental transfer matcher keys off it to catch
            # backdated-but-freshly-delivered legs. Rows that set their
            # own created_at (to model an older ingest) keep it.
            row.setdefault("created_at", datetime.date.today().isoformat())

    # ── test helpers ──
    def rows(self, table):
        return self.tables.get(table, [])

    def one(self, table, **eq):
        for r in self.rows(table):
            if all(r.get(k) == v for k, v in eq.items()):
                return r
        return None


class _Resp:
    def __init__(self, d):
        self._d = d

    def to_dict(self):
        return self._d


class FakePlaid:
    """Serves canned accounts_get + a queue of transactions_sync pages, plus a
    flat list of investment transactions served offset-paginated by
    investments_transactions_get (mirrors Plaid's /investments/transactions/get,
    which offset-paginates rather than using the transactions_sync cursor)."""

    def __init__(self, accounts, pages, investment_txns=None):
        self.accounts = accounts
        self.pages = pages
        # Flat, pre-filter list of canned investment transactions (any type /
        # subtype); investments_transactions_get pages through them per request.
        self.investment_txns = list(investment_txns or [])
        self.accounts_get_count = 0
        self.sync_count = 0
        self.investments_get_count = 0

    def accounts_get(self, req):
        self.accounts_get_count += 1
        return _Resp({"accounts": self.accounts})

    def transactions_sync(self, req):
        page = self.pages[self.sync_count]
        self.sync_count += 1
        return _Resp(page)

    def investments_transactions_get(self, req):
        # Page by the request options exactly as the real endpoint does: return
        # the offset..offset+count slice and the unpaged total, so the caller's
        # offset += len(page) loop terminates on total.
        self.investments_get_count += 1
        offset = req.options.offset
        count = req.options.count
        page = self.investment_txns[offset:offset + count]
        return _Resp({
            "investment_transactions": page,
            "total_investment_transactions": len(self.investment_txns),
            "securities": [],
            "accounts": [],
        })
