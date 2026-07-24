"""Thread-safety of get_supabase(): each thread gets its own client, and the
same thread reuses it. Guards the fix for the shared-HTTP/2-connection webhook
sync failures — a global singleton returned one client to every
FastAPI threadpool worker, corrupting the shared connection under concurrent
webhooks."""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('SUPABASE_URL', 'https://example.supabase.co')
os.environ.setdefault('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')

from supabase_client import get_supabase


def test_client_is_per_thread():
    ids_by_thread = {}
    barrier = threading.Barrier(8)

    def grab():
        barrier.wait()                      # maximize overlap
        a = get_supabase()
        b = get_supabase()                  # same thread → same client
        assert a is b
        ids_by_thread[threading.get_ident()] = id(a)

    threads = [threading.Thread(target=grab) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # One distinct client object per thread — nothing shared across threads.
    assert len(set(ids_by_thread.values())) == len(ids_by_thread) == 8


if __name__ == '__main__':
    test_client_is_per_thread()
    print('ok')
