"""Server-side scheduler entry points: POST /internal/sync and /internal/daily.

Supabase pg_cron calls these (via pg_net) with a shared secret. Fakes only —
no network, no live database.
"""
import pytest
from fastapi.testclient import TestClient

import api

SECRET = "s3cret-" * 6


@pytest.fixture()
def client():
    return TestClient(api.app, raise_server_exceptions=False)


@pytest.fixture()
def calls(monkeypatch):
    """Record which background job each endpoint enqueues, without running it."""
    seen = []
    monkeypatch.setattr(api, "run_sync", lambda: seen.append("sync"))
    monkeypatch.setattr(api, "run_daily_maintenance", lambda: seen.append("daily"))
    return seen


def test_internal_endpoints_503_when_secret_unset(monkeypatch, client, calls):
    """A missing TRIGGER_SECRET must be loud (503), never a silent no-op or an
    open endpoint."""
    monkeypatch.setattr(api, "TRIGGER_SECRET", None)
    for path in ("/internal/sync", "/internal/daily"):
        resp = client.post(path, headers={"X-Trigger-Secret": "anything"})
        assert resp.status_code == 503, path
    assert calls == []


@pytest.mark.parametrize("header", [{}, {"X-Trigger-Secret": "wrong"}])
def test_internal_endpoints_401_on_bad_or_missing_secret(monkeypatch, client, calls, header):
    monkeypatch.setattr(api, "TRIGGER_SECRET", SECRET)
    for path in ("/internal/sync", "/internal/daily"):
        resp = client.post(path, headers=header)
        assert resp.status_code == 401, path
    assert calls == []


def test_internal_sync_enqueues_full_sync(monkeypatch, client, calls):
    monkeypatch.setattr(api, "TRIGGER_SECRET", SECRET)
    resp = client.post("/internal/sync", headers={"X-Trigger-Secret": SECRET})
    assert resp.status_code == 202
    assert resp.json() == {"status": "queued", "job": "sync"}
    # TestClient runs BackgroundTasks before returning.
    assert calls == ["sync"]


def test_internal_daily_enqueues_maintenance(monkeypatch, client, calls):
    monkeypatch.setattr(api, "TRIGGER_SECRET", SECRET)
    resp = client.post("/internal/daily", headers={"X-Trigger-Secret": SECRET})
    assert resp.status_code == 202
    assert resp.json() == {"status": "queued", "job": "daily"}
    assert calls == ["daily"]


def test_daily_maintenance_isolates_failures_and_gates_digests(monkeypatch):
    """A reconcile crash must not suppress digests; digests only emit on the
    morning-ET run."""
    import datetime

    import digests
    import reconcile

    events = []

    def boom():
        events.append("reconcile")
        raise RuntimeError("plaid down")
    monkeypatch.setattr(reconcile, "run_reconcile", boom)
    monkeypatch.setattr(digests, "run_digests", lambda sb, *, today: events.append(("digests", today)))
    monkeypatch.setattr(api, "get_supabase", lambda: object())

    class Morning(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.datetime(2026, 9, 19, 9, 20, tzinfo=datetime.UTC)  # 05:20 EDT
    monkeypatch.setattr(api.datetime, "datetime", Morning)

    api.run_daily_maintenance()
    assert events[0] == "reconcile"
    assert events[1] == ("digests", datetime.date(2026, 9, 19))

    events.clear()

    class Evening(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.datetime(2026, 9, 19, 21, 0, tzinfo=datetime.UTC)  # 17:00 EDT
    monkeypatch.setattr(api.datetime, "datetime", Evening)

    api.run_daily_maintenance()
    assert events == ["reconcile"], "afternoon run reconciles but never emits digests"
