"""
What the cloud knows of a till before a Z is made from the cloud (docs/SPEC_OFFLINE_TILL_Z.md
§4.6.1).

The owner: "אם לא הגיע לענן Z, הענן צריך לדעת שיש משמרות או קופות שלא נסגרו — התראה לפני
ביצוע, וגם שיציג מצב, כי אין מצב שלקוח עבד בלי סנכרון הרבה זמן". Before support produces a
dead till's Z, and before the shop Z wizard starts a cloud run, the state of every till it
takes is shown — and any of these is a warning the operator must confirm explicitly
("אני מאשר שהנתונים בענן הם הנתונים הקיימים"):

* `open_shifts` — a shift the cloud holds open (or the till says it has open and the cloud
  has not seen), of a till that is not online to close it itself;
* `not_synced` — the till is off, and its last contact was before the cloud received its last
  shift's close (or it was never heard from): what it reported is older than its close;
* `unsynced_documents` — the till last reported documents (or other items) not sent yet;
* `offline_zs` — the till last reported Zs closed with no connection and not uploaded, or
  one held in a conflict.

Only a real risk warns (the owner: a till simply switched off for the night must not force
a tick every night). A till that is off, closed and fully synced at its last contact is
`status = "off_synced"` — listed as "כבוי — סונכרן במלואו", with nothing to confirm.

Read-only and pure over the machine row and its shifts.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.services.machine_status import is_online

#: The words the operator confirms when there is anything to warn about.
CONFIRMATION_TEXT = "אני מאשר שהנתונים בענן הם הנתונים הקיימים"

WARNINGS = ("open_shifts", "not_synced", "unsynced_documents", "offline_zs")


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    return (moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)).isoformat()


def reported_offline_numbers(cloud_last: int, reported_last: Optional[int], pending: Optional[int]) -> List[int]:
    """
    The Z numbers the till reported holding not uploaded: after the cloud's last, up to the
    last it said it numbered — when it said any are pending. Information only. Pure.
    """
    if not pending or reported_last is None or reported_last <= cloud_last:
        return []
    return list(range(cloud_last + 1, int(reported_last) + 1))


def till_state(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> dict:
    """One till as the cloud knows it now, with its warnings."""
    from app.services.z_sequence import last_machine_z_number

    now = now or datetime.now(timezone.utc)
    online = is_online(machine.last_heartbeat_at, now=now)
    open_shifts = (
        db.query(Shift)
        .filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.OPEN)
        .order_by(Shift.opened_at.asc())
        .all()
    )
    reported_open = getattr(machine, "reported_open_shift_id", None)
    unknown_open = (
        str(reported_open)
        if reported_open is not None and all(str(s.id) != str(reported_open) for s in open_shifts)
        and db.query(Shift.id).filter(Shift.id == reported_open, Shift.status == ShiftStatus.CLOSED).first() is None
        else None
    )
    cloud_last = last_machine_z_number(db, machine.id)
    reported_last = getattr(machine, "offline_till_z_last_number", None)
    pending_zs = int(getattr(machine, "offline_till_z_pending", None) or 0)
    conflict = bool(getattr(machine, "offline_till_z_conflict", False))
    documents = machine.pending_documents
    items = machine.pending_count

    # When the cloud received the till's last shift close: a last contact before it means what
    # the till last reported (its backlog, its Zs) predates that close.
    from sqlalchemy import func

    last_close = (
        db.query(func.max(Shift.close_accepted_at))
        .filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.CLOSED)
        .scalar()
    )
    beat = machine.last_heartbeat_at
    stale = beat is None or (
        last_close is not None
        and (beat if beat.tzinfo is not None else beat.replace(tzinfo=timezone.utc))
        < (last_close if last_close.tzinfo is not None else last_close.replace(tzinfo=timezone.utc))
    )

    warnings = []
    if (open_shifts or unknown_open) and not online:
        warnings.append("open_shifts")
    if not online and stale:
        warnings.append("not_synced")
    if (documents or 0) > 0 or (items or 0) > 0:
        warnings.append("unsynced_documents")
    if pending_zs > 0 or conflict:
        warnings.append("offline_zs")
    status = "online" if online else ("at_risk" if warnings else "off_synced")
    return {
        "machineId": str(machine.id),
        "name": machine.name,
        "posNumber": machine.pos_number,
        "online": online,
        "lastHeartbeatAt": _iso(machine.last_heartbeat_at),
        "openShifts": [
            {
                "id": str(s.id),
                "sequenceNumber": s.sequence_number,
                "openedAt": _iso(s.opened_at),
                "businessDate": s.business_date.isoformat() if s.business_date else None,
            }
            for s in open_shifts
        ],
        # A shift the till says is open and the cloud has never seen.
        "tillReportedOpenShiftId": unknown_open,
        "unsyncedDocuments": documents,
        "unsyncedItems": items,
        "unsyncedAt": _iso(getattr(machine, "pending_count_at", None)),
        "offlineZs": {
            "pending": pending_zs,
            "conflict": conflict,
            "lastNumber": reported_last,
            "cloudLastNumber": cloud_last,
            "numbers": reported_offline_numbers(cloud_last, reported_last, pending_zs),
            "reportedAt": _iso(getattr(machine, "offline_till_z_reported_at", None)),
        },
        "warnings": warnings,
        # online · off_synced ("כבוי — סונכרן במלואו") · at_risk
        "status": status,
        "lastCloseReceivedAt": _iso(last_close),
    }


def states(db: Session, machines: Iterable[POSMachine], *, now: Optional[datetime] = None) -> List[dict]:
    return [till_state(db, m, now=now) for m in machines]


def needs_confirmation(tills: Iterable[dict]) -> bool:
    """Anything to warn about: the operator has to confirm the cloud's data explicitly."""
    return any(t.get("warnings") for t in tills)
