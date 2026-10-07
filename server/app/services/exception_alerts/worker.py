"""
The background pass of the exception alerts: every minute, the digests of the rules that
held messages back (rate limit / quiet hours) and may send again (engine.flush_digests).
Safe across API processes: the rule row is locked while its digest is decided, and a
digest's dispatch rows are unique per (rule, batch, recipient).
"""
from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 60.0

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def run_once(session_factory: Callable[[], Session]) -> int:
    from app.services.exception_alerts import engine as E
    from app.services.exception_alerts.hooks import SKIP

    db = session_factory()
    db.info[SKIP] = True
    try:
        return E.flush_digests(db)
    finally:
        db.close()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = INTERVAL_SECONDS) -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return

    def loop() -> None:
        while not _stop.wait(interval):
            try:
                run_once(session_factory)
            except Exception:  # noqa: BLE001 - keep the loop alive
                logger.exception("exception alerts digest pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="exception-alerts-digests", daemon=True)
    _thread.start()


def stop_background_worker() -> None:
    _stop.set()
