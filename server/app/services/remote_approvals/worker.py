"""
The approvals' background pass: every few seconds, pending requests whose time is up are
expired (the till told, the phones' notices replaced, the audit written) and those due are
escalated (service.py `sweep`). Safe across API processes: each request row is locked with
SKIP LOCKED while it is decided, so a decision in progress is never raced and two processes
never expire the same request twice.
"""
from __future__ import annotations

import logging
import threading
from typing import Callable, Dict, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 5.0

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def run_once(session_factory: Callable[[], Session]) -> Dict[str, int]:
    from app.services.exception_alerts.hooks import SKIP
    from app.services.remote_approvals.service import sweep

    db = session_factory()
    db.info[SKIP] = True
    try:
        result = sweep(db)
        db.commit()
        return result
    except Exception:  # noqa: BLE001 - keep the loop alive
        db.rollback()
        logger.exception("approvals sweep failed")
        return {"expired": 0, "escalated": 0}
    finally:
        db.close()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = INTERVAL_SECONDS) -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return

    def loop() -> None:
        while not _stop.wait(interval):
            run_once(session_factory)

    _stop.clear()
    _thread = threading.Thread(target=loop, name="remote-approvals-sweep", daemon=True)
    _thread.start()


def stop_background_worker() -> None:
    _stop.set()
