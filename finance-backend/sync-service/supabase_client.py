import datetime
import os
import threading

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()


def now_iso() -> str:
    """Current UTC time as ISO-8601, for timestamp columns."""
    return datetime.datetime.now(datetime.UTC).isoformat()


# ponytail: per-thread client, not a shared singleton. postgrest forces
# httpx(http2=True), so one client multiplexes every request over a single TCP
# connection. That connection's state is not safe to touch from two threads at
# once — and the /webhook/plaid handler runs its sync via FastAPI background
# tasks in a threadpool, so a burst of webhooks corrupted the shared connection
# (httpx.ReadError: [Errno 11] Resource temporarily unavailable) and dropped
# real-time syncs. A client-per-thread never shares a connection; threadpool
# threads are reused, so their clients are reused too (no per-request handshake).
_local = threading.local()


def get_supabase() -> Client:
    client = getattr(_local, 'client', None)
    if client is None:
        client = create_client(
            os.environ['SUPABASE_URL'],
            os.environ['SUPABASE_SERVICE_ROLE_KEY']
        )
        _local.client = client
    return client
