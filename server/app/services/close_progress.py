"""
What the dashboard can say about a till while it waits for that till to close a shift.

Shared by a Z run's items and a standalone remote close, so both progress views read
the same things the same way:

* the till's own last report of its backlog (`pendingDocuments`, `pendingAsOf`) and
  whether it is reachable (`online`) — a *last-known reading*, never a live count;
* how many documents of the shift being closed the cloud already holds — the one
  figure the cloud knows first-hand.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Dict, Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction
from app.services.machine_status import is_online


def till_backlog(machine: Optional[POSMachine], *, now: Optional[datetime] = None) -> Dict[str, object]:
    """`{online, pendingDocuments, pendingAsOf}` as the status light reads them."""
    if machine is None:
        return {"online": None, "pendingDocuments": None, "pendingAsOf": None}
    pending = machine.pending_documents
    if pending is None:
        pending = machine.pending_count
    return {
        "online": is_online(machine.last_heartbeat_at, now=now),
        "pendingDocuments": pending,
        "pendingAsOf": machine.pending_count_at,
    }


def documents_on_cloud(db: Session, shift_ids: Iterable[Optional[uuid.UUID]]) -> Dict[uuid.UUID, int]:
    """Per shift id: how many of its documents (any status) the cloud holds."""
    ids = [s for s in dict.fromkeys(shift_ids) if s is not None]
    if not ids:
        return {}
    rows = (
        db.query(Transaction.shift_id, func.count(Transaction.id))
        .filter(Transaction.shift_id.in_(ids))
        .group_by(Transaction.shift_id)
        .all()
    )
    counts = {shift_id: 0 for shift_id in ids}
    counts.update({r[0]: int(r[1]) for r in rows})
    return counts
