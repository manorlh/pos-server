"""
"שולחן מתעכב" for the assigned waiter (P:/specs/table-waiter-assignment.md §5): the background pass of
app/services/table_notices.py `overdue_pass`, every `INTERVAL_SECONDS`.

Its own job, on its own switch (`TABLE_NOTICES_WORKER_ENABLED`, default on). Several API instances: each
runs the loop; a pass first takes a Postgres advisory lock (a session lock on a connection of its own,
released at the end), so one instance runs per pass and the others skip. Idempotent anyway: a notice is
one per waiter per quiet spell (`table_notices.dedupe_key`). SQLite (the tests) has no advisory locks:
there the pass simply runs. A pass reads the shops that assign someone now (one query); only those with an
open table of the cloud's quiet for 5 minutes or more read their parameters (`tableAssignmentNotify`).

The LAN mode and the single till are not the cloud's: their tills tell their own waiters.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Any, Callable, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 30.0
#: pg advisory lock key of the pass (any constant shared by every instance).
LOCK_KEY = 0x7AB1_E0D0E5  # "table notices"
ENV_SWITCH = "TABLE_NOTICES_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def run_once(session_factory: Callable[[], Session], *, now: Optional[datetime] = None) -> Optional[List[Any]]:
    """One pass: the notices it made (committed), or None when another instance holds the pass."""
    from app.services import table_notices

    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not bool(lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar()):
                return None
        made = table_notices.overdue_pass(db, now=now)
        db.commit()
        return made
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        if lock_conn is not None:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("table notices pass: unlock failed")
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
                logger.exception("table notices pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="table-notices", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
