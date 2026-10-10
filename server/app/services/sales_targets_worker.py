"""
"יעד הושג" even when nobody looks at the board: the sales targets' own background pass
(app/services/sales_targets.py `evaluate_due`), every minute.

Its own job, on its own switch (`SALES_TARGETS_WORKER_ENABLED`, default on) — never tied to stock:
neither `STOCK_LOCATIONS_ENABLED` nor `STOCK_RESET_WORKER_ENABLED` stops it. It is the one source of
`target_reached` (an event's target included, feat/event-followups), so silencing it would silence
every target alert.

Several API instances: each runs the loop; a pass first takes a Postgres advisory lock (a session
lock on a connection of its own, released at the end), so one instance evaluates per minute and the
others skip. Idempotent anyway: a hit is unique per target and period (`sales_target_hits`), and its
exceptions-log entry per hit — two passes at once still record one alert. SQLite (the tests) has no
advisory locks: there the pass simply runs.
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

INTERVAL_SECONDS = 60.0
#: pg advisory lock key of the pass (any constant shared by every instance).
LOCK_KEY = 0x5A1E5_7A6E7  # "sales target"
ENV_SWITCH = "SALES_TARGETS_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def try_lock(conn) -> bool:
    """This instance's turn: the pass's advisory lock taken on [conn] (Postgres); always True elsewhere."""
    if conn.dialect.name != "postgresql":
        return True
    return bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar())


def unlock(conn) -> None:
    if conn.dialect.name == "postgresql":
        conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})


def run_once(session_factory: Callable[[], Session], *, now: Optional[datetime] = None) -> Optional[int]:
    """
    One pass: every shop that has a target, its targets in play now, each reached one recorded once.
    Returns how many targets are reached, or None when another instance holds the pass.
    """
    from app.services import sales_targets

    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not try_lock(lock_conn):
                return None
        return sales_targets.evaluate_due(db, now=now)
    finally:
        db.close()
        if lock_conn is not None:
            try:
                unlock(lock_conn)
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("sales targets pass: unlock failed")
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
                logger.exception("sales targets pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="sales-targets", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
