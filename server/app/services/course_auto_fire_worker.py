"""
"הוצאה אוטומטית של השלב הבא" in the cloud's tables (P:/specs/courses-fire-v2.md §1 "שולחנות בענן"): the
background pass of app/services/course_auto_fire.py, every `INTERVAL_SECONDS`.

Its own job, on its own switch (`COURSE_AUTO_FIRE_WORKER_ENABLED`, default on). Several API instances:
each runs the loop; a pass first takes a Postgres advisory lock (a session lock on a connection of its
own, released at the end), so one instance fires per pass and the others skip. Idempotent anyway: each
order is locked and read again before its fire, and the fire's ids are the till's (one job per printer,
one KDS release, one till event) — two passes at once still fire a course once. SQLite (the tests) has
no advisory locks: there the pass simply runs.

The LAN mode and the single till are not the cloud's: their tills fire their own tables (§1).
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

#: A course due at 20:15:00 goes by 20:15:15 — the till's countdown says "עכשיו" meanwhile.
INTERVAL_SECONDS = 15.0
#: pg advisory lock key of the pass (any constant shared by every instance).
LOCK_KEY = 0xF12E_C0A5E5  # "fire courses"
ENV_SWITCH = "COURSE_AUTO_FIRE_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def run_once(session_factory: Callable[[], Session], *, now: Optional[datetime] = None) -> Optional[List[Dict[str, Any]]]:
    """One pass: the fires it made, or None when another instance holds the pass."""
    from app.services import course_auto_fire

    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not bool(lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar()):
                return None
        return course_auto_fire.run_pass(db, now=now)
    finally:
        db.close()
        if lock_conn is not None:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("course auto-fire pass: unlock failed")
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
                logger.exception("course auto-fire pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="course-auto-fire", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
