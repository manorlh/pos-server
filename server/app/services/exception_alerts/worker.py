"""
The background pass of the exception alerts: every minute, the digests of the rules that
held messages back (rate limit / quiet hours) and may send again (engine.flush_digests).
Safe across API processes: the rule row is locked while its digest is decided, and a
digest's dispatch rows are unique per (rule, batch, recipient).

Then the watches (`run_watches`), each on its own session: a till offline, push retries, and the
detections of P:/specs/push-more.md §C / §B2 — the shop not opened and its sales pace
(shop_watch.py), open tables and late KDS tickets (service_watch.py), idle tills and "קופה כמעט לא
מוכרת" every 10 minutes (till_activity.py), the daily summary (daily_summary.py). Each new kind is
off until a level switches it on; their rows are unique per case, so two processes never alert twice.
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
        written = E.flush_digests(db)
    finally:
        db.close()
    run_watches(session_factory)
    return written


def run_watches(session_factory: Callable[[], Session]) -> None:
    """
    "התראות לטלפון" (feat/event-live), each pass on its own and never failing the others:
    tills that went offline (an exception row — this session records it through the hooks,
    so it is NOT marked to skip them) and push messages a dead process left queued. "יעד הושג"
    is not checked here: "יעדים ותחרות" records it (app/services/sales_targets.py `evaluate_due`,
    its own minute, app/services/sales_targets_worker.py) — the one source of `target_reached`.
    """
    from app.services.exception_alerts import push, till_watch
    from app.services.exception_alerts import daily_summary, service_watch, shop_watch, till_activity
    from app.services.exception_alerts.hooks import SKIP

    for name, job, skip in (
        ("till offline watch", lambda db: till_watch.scan(db), False),
        ("push retry", lambda db: push.retry_stale(db), True),
        # "זיהויים חדשים" (P:/specs/push-more.md §C, §B2) — each off until a level switches it on;
        # the exception rows they write reach the log and the alerts through the hooks.
        ("shop not opened watch", lambda db: shop_watch.scan_not_opened(db), False),
        ("sales pace watch", lambda db: shop_watch.scan_sales_pace(db), False),
        ("open tables watch", lambda db: service_watch.scan_tables(db), False),
        ("kds tickets watch", lambda db: service_watch.scan_kds(db), False),
        ("idle tills watch", lambda db: till_activity.scan_idle(db), False),
        # Log entries written (and sent) by the job itself: its session skips the hooks.
        ("daily summary", lambda db: daily_summary.scan(db), True),
        ("till low sales (every 10 minutes)", lambda db: till_activity.scan_low_sales(db), True),
    ):
        db = session_factory()
        if skip:
            db.info[SKIP] = True
        try:
            job(db)
            db.commit()
        except Exception:  # noqa: BLE001 - keep the loop alive
            db.rollback()
            logger.exception("exception alerts: %s failed", name)
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
