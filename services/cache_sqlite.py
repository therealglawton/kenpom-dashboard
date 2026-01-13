import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Optional, Tuple

DEFAULT_DB_PATH = os.getenv("CACHE_DB_PATH", "cache.sqlite3")

_inflight: dict[str, threading.Lock] = {}
_inflight_guard = threading.Lock()

def _now() -> int:
    return int(time.time())

@contextmanager
def _db(db_path: str = DEFAULT_DB_PATH):
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        yield conn
        conn.commit()
    finally:
        conn.close()

def init_cache(db_path: str = DEFAULT_DB_PATH):
    with _db(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS http_cache (
              cache_key    TEXT PRIMARY KEY,
              status_code   INTEGER NOT NULL,
              payload_json  TEXT NOT NULL,
              fetched_at    INTEGER NOT NULL,
              expires_at    INTEGER NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_http_cache_expires ON http_cache(expires_at);")

def get_cached(cache_key: str, db_path: str = DEFAULT_DB_PATH) -> Optional[Tuple[int, Any, int, int]]:
    with _db(db_path) as conn:
        row = conn.execute(
            "SELECT status_code, payload_json, fetched_at, expires_at FROM http_cache WHERE cache_key=?",
            (cache_key,),
        ).fetchone()
    if not row:
        return None
    status_code, payload_json, fetched_at, expires_at = row
    try:
        payload = json.loads(payload_json)
    except Exception:
        return None
    return status_code, payload, fetched_at, expires_at

def set_cached(cache_key: str, status_code: int, payload: Any, ttl_seconds: int, db_path: str = DEFAULT_DB_PATH):
    now = _now()
    expires_at = now + max(1, int(ttl_seconds))
    payload_json = json.dumps(payload, separators=(",", ":"))
    with _db(db_path) as conn:
        conn.execute(
            """
            INSERT INTO http_cache(cache_key, status_code, payload_json, fetched_at, expires_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(cache_key) DO UPDATE SET
              status_code=excluded.status_code,
              payload_json=excluded.payload_json,
              fetched_at=excluded.fetched_at,
              expires_at=excluded.expires_at;
            """,
            (cache_key, status_code, payload_json, now, expires_at),
        )

def purge_expired(limit: int = 5000, db_path: str = DEFAULT_DB_PATH):
    now = _now()
    with _db(db_path) as conn:
        conn.execute("DELETE FROM http_cache WHERE expires_at < ? LIMIT ?", (now, limit))

def _lock_for_key(cache_key: str) -> threading.Lock:
    with _inflight_guard:
        lock = _inflight.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _inflight[cache_key] = lock
        return lock

def cached_call(cache_key: str, ttl_seconds: int, fetch_fn, *, db_path: str = DEFAULT_DB_PATH):
    """
    fetch_fn must return: (status_code:int, payload:any)
    Only caches successful fetches; caller decides what "successful" means.
    """
    cached = get_cached(cache_key, db_path)
    now = _now()
    if cached:
        sc, payload, fetched_at, expires_at = cached
        if expires_at >= now:
            return sc, payload, "cache"

    lock = _lock_for_key(cache_key)
    with lock:
        # Re-check inside lock (another request may have refreshed it)
        cached2 = get_cached(cache_key, db_path)
        now2 = _now()
        if cached2:
            sc2, payload2, _, expires_at2 = cached2
            if expires_at2 >= now2:
                return sc2, payload2, "cache"

        sc, payload = fetch_fn()
        # caller can decide to only call set_cached on good responses,
        # but typical usage: do it here only for sc==200 (caller checks)
        if sc == 200:
            set_cached(cache_key, sc, payload, ttl_seconds, db_path=db_path)
        return sc, payload, "origin"
