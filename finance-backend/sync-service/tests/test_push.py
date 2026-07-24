"""Logic tests for the APNs push sender (Phase C).

Fakes-only tier (no network, no Apple): drives the real production functions in
push.py against tests/fakes.FakeSupabase and a fake HTTP client. Covers:

  * the JWT header/claims (kid / alg / iss) and its cache + refresh boundary,
  * the aps / custom-key payload construction,
  * the dormant no-op when the APNS_* env is unset (nothing sent, no error),
  * token hygiene: 410 and 400/BadDeviceToken|Unregistered prune the row,
    other errors leave it and never raise,
  * a happy-path 200 send hits the right URL + headers.

Run:  pytest tests/test_push.py      (from finance-backend/sync-service)
"""

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

import push
from tests.fakes import FakeSupabase

USER = "user-1"
KEY_ID = "23VMJG82KQ"       # matches the operator's key id (value, not secret)
TEAM_ID = "TEAMID1234"


def _ec_pem() -> str:
    """A throwaway P-256 private key in PKCS8 PEM — the shape APNS_AUTH_KEY has."""
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@pytest.fixture(autouse=True)
def _clean_push_state():
    """Every test starts with cleared caches and no env leaking between cases."""
    push._reset_state()
    yield
    push._reset_state()


@pytest.fixture
def configured(monkeypatch):
    """Set the three gating env vars (+ topic) to a valid, self-generated key."""
    monkeypatch.setenv("APNS_KEY_ID", KEY_ID)
    monkeypatch.setenv("APNS_TEAM_ID", TEAM_ID)
    monkeypatch.setenv("APNS_AUTH_KEY", _ec_pem())
    monkeypatch.setenv("APNS_TOPIC", "com.example.PocketLens")
    monkeypatch.delenv("APNS_ENV", raising=False)   # default → sandbox


class _FakeResp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class _FakeHTTP:
    """Records every POST; returns queued responses (or a single default)."""

    def __init__(self, responses):
        self.calls = []
        self._responses = responses

    def post(self, url, headers=None, json=None):
        self.calls.append({"url": url, "headers": headers, "json": json})
        if isinstance(self._responses, list):
            return self._responses.pop(0)
        return self._responses


# ── JWT provider token ───────────────────────────────────────────────────────
def test_provider_token_header_and_claims(configured):
    token = push._provider_token()
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "ES256"
    assert header["kid"] == KEY_ID
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["iss"] == TEAM_ID
    assert isinstance(claims["iat"], int)


def test_provider_token_is_cached_then_refreshes(configured, monkeypatch):
    first = push._provider_token()
    assert push._provider_token() is first        # within TTL → same cached string

    # Age the cache past the refresh window → a fresh token is minted.
    push._token_cache["iat"] -= (push._TOKEN_TTL_SECONDS + 1)
    refreshed = push._provider_token()
    assert refreshed != first
    assert jwt.get_unverified_header(refreshed)["kid"] == KEY_ID


# ── payload ──────────────────────────────────────────────────────────────────
def test_build_payload_aps_and_custom_keys():
    notif = {
        "type": "large_charge",
        "title": "Large transaction",
        "body": "A charge of $250.00 posted.",
        "payload": {"transaction_id": "txn-9", "account_id": "acct-3"},
    }
    body = push._build_payload(notif, unread=4)
    assert body["aps"]["alert"] == {"title": "Large transaction",
                                    "body": "A charge of $250.00 posted."}
    assert body["aps"]["sound"] == "default"
    assert body["aps"]["badge"] == 4
    assert body["type"] == "large_charge"
    assert body["transaction_id"] == "txn-9"      # deep-link ids flattened in
    assert body["account_id"] == "acct-3"


def test_build_payload_sets_interruption_level_by_type():
    # Digests stay quiet.
    for t in ("daily_spend", "periodic_digest"):
        body = push._build_payload({"type": t, "title": "a", "body": "b"})
        assert body["aps"]["interruption-level"] == "passive"
    # Alert types use the APNs default — no time-sensitive is sent (key omitted).
    for t in ("large_charge", "low_balance", "sync_failed", "budget_threshold", "bill_due"):
        body = push._build_payload({"type": t, "title": "a", "body": "b"})
        assert "interruption-level" not in body["aps"]


def test_build_payload_omits_badge_when_unread_none():
    body = push._build_payload({"type": "sync_failed", "title": "x", "body": "y"},
                               unread=None)
    assert "badge" not in body["aps"]


# ── dormant when unconfigured ────────────────────────────────────────────────
def test_dormant_noop_when_unconfigured(monkeypatch):
    for var in ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY"):
        monkeypatch.delenv(var, raising=False)
    assert push._configured() is False

    db = FakeSupabase(tables={
        "device_tokens": [{"user_id": USER, "token": "dev-token-1"}],
    })
    http = _FakeHTTP(_FakeResp(200))

    # Neither entry point may touch the network or raise.
    push.send_push(db, USER, {"type": "daily_spend", "title": "t", "body": "b"},
                   client=http)
    push.send_push_for_rows(db, USER,
                            [{"type": "daily_spend", "title": "t", "body": "b"}],
                            client=http)

    assert http.calls == []
    assert len(db.rows("device_tokens")) == 1     # nothing pruned


# ── happy path ───────────────────────────────────────────────────────────────
def test_send_hits_correct_url_and_headers(configured):
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "abc123"}],
        "notifications": [{"user_id": USER, "read_at": None}],   # 1 unread → badge
    })
    http = _FakeHTTP(_FakeResp(200))

    push.send_push(db, USER,
                   {"type": "low_balance", "title": "Low balance",
                    "body": "Below $100.", "payload": {"account_id": "a1"}},
                   client=http)

    assert len(http.calls) == 1
    call = http.calls[0]
    assert call["url"] == "https://api.sandbox.push.apple.com/3/device/abc123"
    assert call["headers"]["apns-topic"] == "com.example.PocketLens"
    assert call["headers"]["apns-push-type"] == "alert"
    assert call["headers"]["apns-priority"] == "10"
    assert call["headers"]["authorization"].startswith("bearer ")
    assert call["json"]["aps"]["badge"] == 1
    assert call["json"]["account_id"] == "a1"
    assert len(db.rows("device_tokens")) == 1     # healthy token kept


def test_production_env_selects_prod_host(configured, monkeypatch):
    monkeypatch.setenv("APNS_ENV", "production")
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "tok"}],
    })
    http = _FakeHTTP(_FakeResp(200))
    push.send_push(db, USER, {"type": "daily_spend", "title": "t", "body": "b"},
                   client=http)
    assert http.calls[0]["url"].startswith("https://api.push.apple.com/3/device/")


# ── token hygiene ────────────────────────────────────────────────────────────
def test_410_prunes_device_token(configured):
    db = FakeSupabase(tables={
        "device_tokens": [
            {"id": "dt-1", "user_id": USER, "token": "dead"},
            {"id": "dt-2", "user_id": USER, "token": "alive"},
        ],
    })
    # First token 410 (gone), second 200 (delivered).
    http = _FakeHTTP([_FakeResp(410, {"reason": "Unregistered"}), _FakeResp(200)])

    push.send_push(db, USER, {"type": "daily_spend", "title": "t", "body": "b"},
                   client=http)

    remaining = {r["id"] for r in db.rows("device_tokens")}
    assert remaining == {"dt-2"}                  # dead token pruned, alive kept


def test_400_bad_device_token_prunes(configured):
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "bad"}],
    })
    http = _FakeHTTP(_FakeResp(400, {"reason": "BadDeviceToken"}))
    push.send_push(db, USER, {"type": "daily_spend", "title": "t", "body": "b"},
                   client=http)
    assert db.rows("device_tokens") == []


def test_other_error_keeps_token_and_does_not_raise(configured):
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "tok"}],
    })
    http = _FakeHTTP(_FakeResp(429, {"reason": "TooManyRequests"}))
    # Must not raise; token stays for a later retry.
    push.send_push(db, USER, {"type": "daily_spend", "title": "t", "body": "b"},
                   client=http)
    assert len(db.rows("device_tokens")) == 1


def test_no_tokens_is_silent_noop(configured):
    db = FakeSupabase(tables={"device_tokens": []})
    http = _FakeHTTP(_FakeResp(200))
    push.send_push(db, USER, {"type": "daily_spend", "title": "t", "body": "b"},
                   client=http)
    assert http.calls == []


# ── integration with the insert path (alerts._insert_new fans out to push) ────
def test_insert_new_dispatches_push_for_landed_rows(configured, monkeypatch):
    import alerts
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "tok"}],
    })
    http = _FakeHTTP([_FakeResp(200)])
    # Route the sender's client through our fake (avoids a real httpx.Client).
    monkeypatch.setattr(push, "_http_client", lambda: http)

    inserted = alerts._insert_new(db, USER, [{
        "type": "low_balance", "title": "Low balance", "body": "Below $100.",
        "payload": {"account_id": "a1"}, "dedup_key": "low_balance:a1:today",
    }])

    assert len(inserted) == 1
    assert len(http.calls) == 1
    assert http.calls[0]["json"]["type"] == "low_balance"


def test_insert_new_push_failure_never_breaks_insert(configured, monkeypatch):
    import alerts

    def _boom():
        raise RuntimeError("client build failed")

    monkeypatch.setattr(push, "_http_client", _boom)
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "tok"}],
    })
    # Even though push blows up, the notification must still be inserted.
    inserted = alerts._insert_new(db, USER, [{
        "type": "daily_spend", "title": "t", "body": "b",
        "dedup_key": "daily_spend:user-1:today",
    }])
    assert len(inserted) == 1
    assert len(db.rows("notifications")) == 1


def test_insert_new_no_push_when_unconfigured(monkeypatch):
    """The Phase-B contract: with no APNS_* env, insert behaves exactly as before
    and no push is attempted."""
    import alerts
    for var in ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY"):
        monkeypatch.delenv(var, raising=False)

    calls = []
    monkeypatch.setattr(push, "_http_client",
                        lambda: calls.append("built") or _FakeHTTP(_FakeResp(200)))
    db = FakeSupabase(tables={
        "device_tokens": [{"id": "dt-1", "user_id": USER, "token": "tok"}],
    })
    inserted = alerts._insert_new(db, USER, [{
        "type": "daily_spend", "title": "t", "body": "b",
        "dedup_key": "daily_spend:user-1:today",
    }])
    assert len(inserted) == 1
    assert calls == []                            # never even built a client
