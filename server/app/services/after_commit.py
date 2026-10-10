"""
Run something only once the session's transaction is committed — never before, never after a
rollback.

A realtime push to a till (a close-shift, a till Z) sent before the commit can reach the till
before the request it names is visible: the till's acknowledgement then finds nothing (404). Sent
after the commit, the till always finds it; rolled back, nothing is sent at all. Savepoints are
transparent: only the outermost commit runs the callbacks, only the outermost rollback drops them.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

from sqlalchemy import event
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_KEY = "_after_commit"
_HOOKED = "_after_commit_hooked"


def run(db: Optional[Session], fn: Callable[[], None]) -> None:
    """Call `fn` after `db` commits (at once when there is no session to wait for)."""
    if db is None:
        _call(fn)
        return
    db.info.setdefault(_KEY, []).append(fn)
    if not db.info.get(_HOOKED):
        event.listen(db, "after_commit", _on_commit)
        event.listen(db, "after_soft_rollback", _on_rollback)
        db.info[_HOOKED] = True


def _call(fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001 - a push never fails what was committed; the heartbeat carries it
        logger.exception("after-commit callback failed")


def _on_commit(session: Session) -> None:
    if session.in_nested_transaction():
        return  # a savepoint released: the outer transaction may still roll back
    for fn in session.info.pop(_KEY, []):
        _call(fn)


def _on_rollback(session: Session, previous_transaction) -> None:
    if getattr(previous_transaction, "nested", False):
        return
    session.info.pop(_KEY, None)
