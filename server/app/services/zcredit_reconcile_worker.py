"""
"התאמת אשראי מול Z-Credit" every night without anyone asking: the pass
(app/services/zcredit_reconcile.py `run_due`) every few minutes, each Z-Credit terminal reconciled
once for the previous business day once its run time (`zcreditReconcileTime`) has passed.

Its own switch (`ZCREDIT_RECONCILE_WORKER_ENABLED`, default on); the per-till parameter
`zcreditReconcileEnabled` decides per terminal. Several API instances: a pass first takes a
Postgres advisory lock (as the sales targets' worker), so one instance runs it and the others
skip; a terminal's nightly run of a day is made once anyway (`_nightly_wanted`). SQLite (the
tests) has no advisory locks: there the pass simply runs. Read-only toward Z-Credit.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Callable, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 300.0
#: pg advisory lock key of the pass (any constant shared by every instance).
LOCK_KEY = 0x2C_4EC0_7C11  # "zc recon"
ENV_SWITCH = "ZCREDIT_RECONCILE_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def try_lock(conn) -> bool:
    if conn.dialect.name != "postgresql":
        return True
    return bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar())


def unlock(conn) -> None:
    if conn.dialect.name == "postgresql":
        conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})


def run_once(session_factory: Callable[[], Session], *, now: Optional[datetime] = None, reports=None) -> Optional[int]:
    """One pass; how many runs it made, or None when another instance holds the pass."""
    from app.services import zcredit_reconcile

    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not try_lock(lock_conn):
                return None
        return zcredit_reconcile.run_due(db, now=now, reports=reports)
    finally:
        db.close()
        if lock_conn is not None:
            try:
                unlock(lock_conn)
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("zcredit recon pass: unlock failed")
            lock_conn.close()


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
                run_once(session_factory)
            except Exception:  # noqa: BLE001 - keep the loop alive
                logger.exception("zcredit recon pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="zcredit-reconcile", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
