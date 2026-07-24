"""APNs push sender (Phase C).

Sends an Apple Push Notification for each alert `notifications` row inserted by
alerts.py (on-sync) and digests.py (on cron). It is **best-effort** and **fully
dormant when unconfigured**: if the APNS_* env vars are absent, send_push returns
immediately (logging once at debug), so shipping this before the Apple portal /
Render credentials are set up can never break a sync.

Transport
    APNs requires HTTP/2, so we use httpx.Client(http2=True) (needs the `h2`
    package — declared in requirements.txt). Endpoint per token:
        POST https://{host}/3/device/{token}

Auth
    A provider JWT (ES256) signed with the .p8 auth key, cached in-process and
    refreshed well inside APNs' limits (rejects tokens >1h, throttles refresh
    <20min) — we refresh at ~40 min.

Config — read from env at call time (never hardcoded, never in git; set in the
Render dashboard, see render.yaml):
    APNS_KEY_ID    key id of the .p8 auth key            (JWT header `kid`)
    APNS_TEAM_ID   Apple developer team id               (JWT claim `iss`)
    APNS_TOPIC     the app bundle id                     (default com.example.PocketLens)
    APNS_AUTH_KEY  the PEM contents of the .p8 (multiline private key)
    APNS_ENV       'sandbox' (default) | 'production'    → APNs host

Token hygiene
    On HTTP 410, or 400 with reason BadDeviceToken / Unregistered, the token is
    stale — we delete that device_tokens row. Any other error is logged and
    swallowed; push failure never raises into the sync/digest caller.
"""
import logging
import os
import time

logger = logging.getLogger('push')

DEFAULT_TOPIC = 'com.example.PocketLens'

# Refresh the provider JWT at 40 min: comfortably under APNs' 1h expiry ceiling
# and above its ~20min refresh-throttle floor.
_TOKEN_TTL_SECONDS = 40 * 60

# In-process caches. Reset in tests via _reset_state().
_token_cache = {'jwt': None, 'iat': 0}
_client = None
_dormant_logged = False


# ── config ───────────────────────────────────────────────────────────────────
def _configured() -> bool:
    """True only when the key id, team id, and auth key are all present.
    Everything else has a safe default, so these three gate the whole sender."""
    return bool(
        os.environ.get('APNS_KEY_ID')
        and os.environ.get('APNS_TEAM_ID')
        and os.environ.get('APNS_AUTH_KEY')
    )


def _topic() -> str:
    return os.environ.get('APNS_TOPIC') or DEFAULT_TOPIC


def _host() -> str:
    env = (os.environ.get('APNS_ENV') or 'sandbox').strip().lower()
    return 'api.push.apple.com' if env == 'production' else 'api.sandbox.push.apple.com'


def _log_dormant() -> None:
    global _dormant_logged
    if not _dormant_logged:
        logger.debug('APNs not configured (APNS_* env unset) — push disabled')
        _dormant_logged = True


# ── provider JWT (ES256) ─────────────────────────────────────────────────────
def _provider_token() -> str:
    """Cached ES256 provider JWT, re-minted when older than the refresh window."""
    now = int(time.time())
    if _token_cache['jwt'] and (now - _token_cache['iat']) < _TOKEN_TTL_SECONDS:
        return _token_cache['jwt']

    import jwt  # PyJWT (declared in requirements.txt; already used by the API)
    token = jwt.encode(
        {'iss': os.environ['APNS_TEAM_ID'], 'iat': now},
        os.environ['APNS_AUTH_KEY'],           # PEM contents of the .p8
        algorithm='ES256',
        headers={'kid': os.environ['APNS_KEY_ID']},
    )
    _token_cache['jwt'] = token
    _token_cache['iat'] = now
    return token


# ── HTTP/2 client ────────────────────────────────────────────────────────────
def _http_client():
    """Lazily-created, process-wide HTTP/2 client (kept open for reuse across the
    cron run; the process is short-lived so there's nothing to clean up)."""
    global _client
    if _client is None:
        import httpx  # http2=True needs the `h2` package (declared in requirements)
        _client = httpx.Client(http2=True, timeout=10.0)
    return _client


# ── payload ──────────────────────────────────────────────────────────────────
# Per-type APNs interruption level. Digests are `passive` (quiet — no buzz/badge).
# Alert types are intentionally left at the APNs default (`active`): the app keeps the
# `time-sensitive` entitlement wired, but we don't send time-sensitive pushes. Unmapped
# types use the default, so we only set the non-default ones.
_INTERRUPTION_LEVEL = {
    'daily_spend': 'passive',
    'periodic_digest': 'passive',
}


def _build_payload(notification: dict, *, unread=None) -> dict:
    """The APNs body: the `aps` dict plus flat custom keys for deep-linking
    (`type` and the ids from the notification's payload)."""
    aps = {
        'alert': {
            'title': notification.get('title') or '',
            'body': notification.get('body') or '',
        },
        'sound': 'default',
    }
    level = _INTERRUPTION_LEVEL.get(notification.get('type'))
    if level:
        aps['interruption-level'] = level
    if unread is not None:
        aps['badge'] = unread

    body = {'aps': aps, 'type': notification.get('type')}
    # Merge the notification's payload (category_id / transaction_id / account_id /
    # item_id / date / …) so the client can route the tap to the right screen.
    for key, value in (notification.get('payload') or {}).items():
        body.setdefault(key, value)
    return body


def _unread_count(supabase, user_id) -> int:
    try:
        rows = supabase.table('notifications') \
            .select('id') \
            .eq('user_id', user_id) \
            .is_('read_at', 'null') \
            .execute().data
        return len(rows)
    except Exception:
        logger.debug('unread count failed; omitting badge', exc_info=True)
        return None


# ── send ─────────────────────────────────────────────────────────────────────
def _send_one(supabase, client, token_row: dict, body: dict) -> None:
    """POST one push; prune the token if APNs says it's stale. Never raises."""
    token = token_row.get('token')
    if not token:
        return
    try:
        resp = client.post(
            f"https://{_host()}/3/device/{token}",
            headers={
                'authorization': f"bearer {_provider_token()}",
                'apns-topic': _topic(),
                'apns-push-type': 'alert',
                'apns-priority': '10',
            },
            json=body,
        )
    except Exception:
        logger.warning('APNs POST failed', exc_info=True)
        return

    if resp.status_code == 200:
        return

    reason = ''
    try:
        reason = (resp.json() or {}).get('reason', '')
    except Exception:
        reason = ''

    # 410 = the device token is no longer valid; 400/BadDeviceToken and
    # 400/Unregistered are the same signal on the reject path. Delete the row so
    # we stop pushing to a dead token.
    stale = resp.status_code == 410 or (
        resp.status_code == 400 and reason in ('BadDeviceToken', 'Unregistered')
    )
    if stale:
        try:
            supabase.table('device_tokens').delete() \
                .eq('id', token_row.get('id')).execute()
            logger.info('deleted stale device token',
                        extra={'token_id': token_row.get('id'),
                               'reason': reason or resp.status_code})
        except Exception:
            logger.warning('failed to delete stale device token', exc_info=True)
    else:
        logger.warning('APNs rejected push (status=%s reason=%s)',
                       resp.status_code, reason)


def send_push(supabase, user_id, notification: dict, *, client=None) -> None:
    """Push one notification to every device the user has registered. No-op when
    unconfigured. Best-effort: any failure is logged, never raised."""
    if not _configured():
        _log_dormant()
        return
    try:
        tokens = supabase.table('device_tokens') \
            .select('id, token') \
            .eq('user_id', user_id) \
            .execute().data
    except Exception:
        logger.warning('device_tokens fetch failed', exc_info=True)
        return
    if not tokens:
        return

    body = _build_payload(notification, unread=_unread_count(supabase, user_id))
    http = client or _http_client()
    for token_row in tokens:
        _send_one(supabase, http, token_row, body)


def send_push_for_rows(supabase, user_id, rows, *, client=None) -> None:
    """Push a batch of freshly-inserted notification rows (the ones alerts._insert_new
    actually landed). No-op when unconfigured; each row is isolated so one bad
    push can't drop the rest."""
    if not rows:
        return
    if not _configured():
        _log_dormant()
        return
    for row in rows:
        try:
            send_push(supabase, user_id, row, client=client)
        except Exception:
            logger.warning('send_push failed for a notification', exc_info=True)


# ── test seam ────────────────────────────────────────────────────────────────
def _reset_state() -> None:
    """Clear the in-process caches (JWT, HTTP client, dormant-log latch).
    Tests call this between cases; production never needs it."""
    global _client, _dormant_logged
    _token_cache['jwt'] = None
    _token_cache['iat'] = 0
    _client = None
    _dormant_logged = False
