"""Guided Plaid onboarding: paste-anything key extraction, credential probing
with specific error messages, and the /onboard + /link wizard pages.

Same tier as test_logic.py — fakes only, no network, no live database.
"""
import json

import plaid
import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException

import api
import plaid_client
import vault
from tests.fakes import FakeSupabase

USER = "00000000-0000-0000-0000-000000000001"
CLIENT_ID = "a" * 24
PROD_SECRET = "b" * 30
SANDBOX_SECRET = "c" * 30

# Roughly what selecting-all on the dashboard API-keys page yields.
KEYS_PAGE = f"""
API keys
client_id
{CLIENT_ID}
Sandbox secret
{SANDBOX_SECRET}
Production secret
{PROD_SECRET}
"""


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.setenv("CREDENTIALS_ENC_KEY", Fernet.generate_key().decode())
    monkeypatch.delenv("PLAID_CLIENT_ID", raising=False)
    monkeypatch.delenv("PLAID_SECRET", raising=False)
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()
    yield
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()


def _wire(monkeypatch, db, probe):
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda t: USER)
    monkeypatch.setattr(api, "_probe", probe)


# ── 1. Key extraction ────────────────────────────────────────────────────────

def test_extract_finds_client_id_and_all_secret_candidates():
    client_ids, secrets = api._extract_plaid_keys(KEYS_PAGE)
    assert client_ids == [CLIENT_ID]
    assert secrets == [SANDBOX_SECRET, PROD_SECRET]


def test_extract_never_matches_inside_longer_hex_runs():
    # A 30-char secret must not also yield a phantom 24-char client_id.
    client_ids, secrets = api._extract_plaid_keys(f"secret: {PROD_SECRET}")
    assert client_ids == []
    assert secrets == [PROD_SECRET]


def test_extract_dedupes_repeated_keys():
    client_ids, secrets = api._extract_plaid_keys(f"{CLIENT_ID} {CLIENT_ID} {PROD_SECRET} {PROD_SECRET}")
    assert client_ids == [CLIENT_ID]
    assert secrets == [PROD_SECRET]


# ── 2. Saving credentials from a raw paste ───────────────────────────────────

def test_save_raw_probes_candidates_and_keeps_working_secret(monkeypatch):
    db = FakeSupabase(tables={"plaid_credentials": [], "plaid_items": []})
    probes = []

    def probe(cid, secret, env):
        probes.append((cid, secret, env))
        return None if secret == PROD_SECRET else ("INVALID_API_KEYS", "")

    _wire(monkeypatch, db, probe)
    status = api.save_credentials(payload={"raw": KEYS_PAGE, "env": "production"},
                                  authorization="t")

    assert status["configured"] is True
    row = db.one("plaid_credentials", user_id=USER)
    assert row["plaid_client_id"] == CLIENT_ID
    assert vault.decrypt(row["plaid_secret_enc"]) == PROD_SECRET  # sandbox candidate rejected
    assert (CLIENT_ID, SANDBOX_SECRET, "production") in probes


def test_save_raw_without_client_id_says_so(monkeypatch):
    _wire(monkeypatch, FakeSupabase(), lambda *a: None)
    with pytest.raises(HTTPException) as exc:
        api.save_credentials(payload={"raw": f"only a secret {PROD_SECRET}"}, authorization="t")
    assert exc.value.status_code == 400
    assert "client ID" in exc.value.detail


def test_save_raw_without_secret_says_so(monkeypatch):
    _wire(monkeypatch, FakeSupabase(), lambda *a: None)
    with pytest.raises(HTTPException) as exc:
        api.save_credentials(payload={"raw": f"just an id {CLIENT_ID}"}, authorization="t")
    assert exc.value.status_code == 400
    assert "secret" in exc.value.detail


def test_save_wrong_env_secret_gets_specific_error(monkeypatch):
    def probe(cid, secret, env):
        return None if env == "sandbox" else ("INVALID_API_KEYS", "")

    _wire(monkeypatch, FakeSupabase(), probe)
    with pytest.raises(HTTPException) as exc:
        api.save_credentials(payload={"raw": f"{CLIENT_ID} {SANDBOX_SECRET}",
                                      "env": "production"}, authorization="t")
    assert exc.value.status_code == 400
    assert "sandbox" in exc.value.detail
    assert "Production" in exc.value.detail


def test_save_bad_creds_everywhere_gets_recheck_message(monkeypatch):
    _wire(monkeypatch, FakeSupabase(), lambda *a: ("INVALID_API_KEYS", ""))
    with pytest.raises(HTTPException) as exc:
        api.save_credentials(payload={"client_id": CLIENT_ID, "secret": PROD_SECRET},
                             authorization="t")
    assert "did not recognize" in exc.value.detail


def test_save_other_plaid_error_passes_code_through(monkeypatch):
    _wire(monkeypatch, FakeSupabase(),
          lambda *a: ("INSTITUTION_NOT_ENABLED", "product not enabled"))
    with pytest.raises(HTTPException) as exc:
        api.save_credentials(payload={"client_id": CLIENT_ID, "secret": PROD_SECRET},
                             authorization="t")
    assert "INSTITUTION_NOT_ENABLED" in exc.value.detail
    assert "product not enabled" in exc.value.detail


def test_save_legacy_two_field_payload_still_works(monkeypatch):
    db = FakeSupabase(tables={"plaid_credentials": [], "plaid_items": []})
    _wire(monkeypatch, db, lambda *a: None)
    status = api.save_credentials(payload={"client_id": CLIENT_ID, "secret": PROD_SECRET},
                                  authorization="t")
    assert status["configured"] is True
    assert vault.decrypt(db.one("plaid_credentials", user_id=USER)["plaid_secret_enc"]) == PROD_SECRET


# ── 3. The probe itself (Plaid error mapping) ────────────────────────────────

class _RaisingClient:
    def __init__(self, body):
        self.body = body

    def institutions_get(self, req):
        e = plaid.ApiException(status=400)
        e.body = self.body
        raise e


def test_probe_maps_plaid_error_body(monkeypatch):
    monkeypatch.setattr(api, "get_plaid_for_creds", lambda creds: _RaisingClient(
        json.dumps({"error_code": "INVALID_API_KEYS",
                    "error_message": "invalid client_id or secret provided"})))
    code, message = api._probe(CLIENT_ID, PROD_SECRET, "production")
    assert code == "INVALID_API_KEYS"
    assert message == "invalid client_id or secret provided"


def test_probe_unparseable_error_is_unknown(monkeypatch):
    monkeypatch.setattr(api, "get_plaid_for_creds",
                        lambda creds: _RaisingClient("<html>gateway error</html>"))
    assert api._probe(CLIENT_ID, PROD_SECRET, "production") == ("UNKNOWN", "")


def test_probe_success_returns_none(monkeypatch):
    class OkClient:
        def institutions_get(self, req):
            return {"institutions": []}

    monkeypatch.setattr(api, "get_plaid_for_creds", lambda creds: OkClient())
    assert api._probe(CLIENT_ID, PROD_SECRET, "production") is None


# ── 4. Wizard + link pages ───────────────────────────────────────────────────

def test_hosted_pages_never_take_a_token_in_the_url(monkeypatch):
    # the Supabase JWT must NOT be a query param on the hosted pages
    # (lands in proxy logs / history / Referer). Both GETs are static shells
    # that take no token and carry no injected token; the JS reads it from the
    # URL fragment and the shell asks the browser not to leak the URL.
    import inspect
    for handler in (api.link_page, api.onboard_page):
        assert list(inspect.signature(handler).parameters) == []

    link = api.link_page()
    assert link.headers["Referrer-Policy"] == "no-referrer"
    link_body = link.body.decode()
    assert 'name="referrer" content="no-referrer"' in link_body
    # Fragment-driven: reads location.hash, posts to /link/prepare with a header.
    assert "location.hash" in link_body and "/link/prepare" in link_body
    assert "access_token=" not in link_body.split("<script")[0]  # no token in a URL

    onboard = api.onboard_page()
    assert onboard.headers["Referrer-Policy"] == "no-referrer"
    body = onboard.body.decode()
    assert "Connect your banks" in body
    assert "__STATUS__" not in body and "__ACCESS_TOKEN__" not in body
    assert "location.hash" in body          # token read from the fragment
    assert "'/link#access_token='" in body  # onward link keeps it in the fragment


def test_link_prepare_returns_link_token_over_authenticated_post(monkeypatch):
    db = FakeSupabase(tables={"plaid_credentials": [{
        "user_id": USER, "plaid_client_id": CLIENT_ID,
        "plaid_secret_enc": vault.encrypt(PROD_SECRET), "plaid_env": "production",
        "item_limit": 10, "is_active": True,
    }], "plaid_items": []})
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda t: USER)

    class FakePlaid:
        def link_token_create(self, req):
            class R:
                def to_dict(self_):  # noqa: N805
                    return {"link_token": "link-sandbox-xyz"}
            return R()
    monkeypatch.setattr(api, "get_plaid_for_creds", lambda creds: FakePlaid())

    out = api.link_prepare(authorization="Bearer tok")
    assert out == {"status": "ok", "link_token": "link-sandbox-xyz"}


def test_link_prepare_reports_no_creds_instead_of_a_dead_end_page(monkeypatch):
    # No Plaid account yet: the shell renders a "start guided setup" prompt from
    # this status (previously a server-rendered 403 with the token in the href).
    monkeypatch.setattr(api, "get_supabase", lambda: FakeSupabase())
    monkeypatch.setattr(api, "_user_id_from_token", lambda t: USER)

    assert api.link_prepare(authorization="Bearer tok") == {"status": "no_creds"}


def test_link_prepare_propagates_auth_failures_as_status_codes(monkeypatch):
    # Dead/expired token -> 401, auth-service outage -> 503. The shell turns
    # these into a human message / retry client-side (no {"detail": ...} JSON
    # page from the server anymore).
    for code in (401, 503):
        def reject(token, _c=code):
            raise HTTPException(status_code=_c, detail="nope")
        monkeypatch.setattr(api, "_user_id_from_token", reject)
        with pytest.raises(HTTPException) as exc:
            api.link_prepare(authorization="Bearer stale")
        assert exc.value.status_code == code


def test_network_error_verifying_token_is_503_not_401(monkeypatch):
    class NoAuth:
        class auth:
            @staticmethod
            def get_user(token):
                raise ConnectionError("boom")

    monkeypatch.setattr(api, "get_supabase", lambda: NoAuth())
    with pytest.raises(HTTPException) as exc:
        api._user_id_from_token("some-token")
    assert exc.value.status_code == 503


def test_link_page_oauth_return_resumes_from_session_storage():
    # OAuth banks bounce back with only ?oauth_state_id=… — the shell detects it
    # client-side (window.location.search) and resumes Link with the token
    # stashed in sessionStorage, no access token in the URL.
    html = api.link_page().body.decode()
    assert "oauth_state_id" in html
    assert "receivedRedirectUri" in html
    assert "sessionStorage.getItem('plaid_link_token')" in html
