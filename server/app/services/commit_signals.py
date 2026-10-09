"""
Catalog signals sent only once the transaction that caused them has committed.

For code that changes what tills are sent from deep inside someone else's transaction — a Z
being built ("פתיחת פריטים אוטומטית אחרי Z"), a sale's stock movement — where the caller
commits, not the code that knows a signal is due. A signal sent before the commit could
wake a till that pulls the old state; one sent for a transaction that is rolled back is
noise. So the tills are collected here and signalled from the session's `after_commit`,
and dropped on a rollback.

`after_commit` cannot run SQL, so whoever asks passes the tills already read.
"""
from __future__ import annotations

import logging
from typing import Dict, Iterable, Tuple

from sqlalchemy import event
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_PENDING = "commit_signals.pending"
_INSTALLED = "commit_signals.installed"


def publish(tenant_id: str, machine_id: str, reason: str) -> None:
    """One till's catalog signal (patched in tests)."""
    from app.services.catalog_notify import notify_machine_catalog_changed

    notify_machine_catalog_changed(tenant_id, machine_id, reason=reason)


def _send(session) -> None:
    # `after_commit` also fires when a SAVEPOINT is released: only the real commit counts.
    if session.in_nested_transaction():
        return
    for (tenant_id, machine_id), why in sorted(session.info.pop(_PENDING, {}).items()):
        try:
            publish(tenant_id, machine_id, why)
        except Exception:  # pragma: no cover - a signal is best effort
            logger.warning("could not signal till %s (%s)", machine_id, why)


def _drop(session) -> None:
    # A real rollback (never a savepoint's): nothing it wrote happened.
    session.info.pop(_PENDING, None)


def catalog_signal_after_commit(db: Session, tills: Iterable[Tuple[str, str]], reason: str) -> None:
    """Signal each `(tenant id, machine id)` once the current transaction commits."""
    pending: Dict[Tuple[str, str], str] = db.info.setdefault(_PENDING, {})
    for tenant_id, machine_id in tills:
        if tenant_id and machine_id:
            pending.setdefault((str(tenant_id), str(machine_id)), reason)
    if db.info.get(_INSTALLED):
        return
    db.info[_INSTALLED] = True
    event.listen(db, "after_commit", _send)
    event.listen(db, "after_rollback", _drop)
