"""
"שליחת לוגים לענן" — the nightly pass that deletes uploaded device logs older than
`DEVICE_LOGS_RETENTION_DAYS` (default 30; 0 = kept), app/services/device_logs.py `purge_expired`.

The app's background-thread pattern (app/services/stock_reset.py — the nightly "איפוס יומי" —
and app/services/sales_targets_worker.py), started at startup in app/main.py: a thread wakes every
hour and runs the purge once per local night (from 03:00 Asia/Jerusalem; a process started later
in the day runs it at its first wake-up). Several API instances: the pass takes a Postgres
advisory lock, so one instance purges and the others skip; a delete is idempotent anyway.
`DEVICE_LOGS_RETENTION_WORKER_ENABLED=false` stops it.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import date, datetime, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 3600.0
#: The local hour from which the night's pass runs.
NIGHT_HOUR = 3
ZONE = "Asia/Jerusalem"
#: pg advisory lock key of the pass (any constant shared by every instance).
LOCK_KEY = 0xDE_10_65  # "device logs"
ENV_SWITCH = "DEVICE_LOGS_RETENTION_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_last_run: Optional[date] = None


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def due(now: datetime, last_run: Optional[date]) -> bool:
    """Whether tonight's pass is due: from NIGHT_HOUR local, once per local date."""
    local = now.astimezone(ZoneInfo(ZONE))
    return local.hour >= NIGHT_HOUR and last_run != local.date()


def run_once(session_factory: Callable[[], Session], *, now: Optional[datetime] = None, days: Optional[int] = None) -> Optional[int]:
    """One purge: how many uploads were deleted, or None when another instance holds the pass."""
    from app.services import device_logs

    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not bool(lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar()):
                return None
        deleted = device_logs.purge_expired(db, days=days, now=now)
        db.commit()
        if deleted:
            logger.info("device logs retention: deleted %s upload(s)", deleted)
        return deleted
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        if lock_conn is not None:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("device logs retention: unlock failed")
            lock_conn.close()


def tick(session_factory: Callable[[], Session], *, now: Optional[datetime] = None) -> Optional[int]:
    """The hourly wake-up: the night's purge when due (remembered per process), else nothing."""
    global _last_run
    now = now or datetime.now(timezone.utc)
    if not due(now, _last_run):
        return None
    out = run_once(session_factory, now=now)
    _last_run = now.astimezone(ZoneInfo(ZONE)).date()
    return out


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = INTERVAL_SECONDS) -> bool:
    """Start the pass (once per process). Returns whether it is running."""
    global _thread
    if not enabled():
        return False
    if _thread is not None and _thread.is_alive():
        return True

    def loop() -> None:
        while not _stop.wait(interval):
            try:
                tick(session_factory)
            except Exception:  # noqa: BLE001 - keep the loop alive
                logger.exception("device logs retention pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="device-logs-retention", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
