"""
Z on the till — `zMode = till` (docs/SHIFTS_API.md §5).

A till in this mode produces its own Z instead of being taken into the shop's cloud Z.
"Its own" is about who asks and how it is numbered, not about who computes it: the till
closes its shift as always (§1.3), then asks for its Z (`POST /sync/{id}/till-z`), and the
cloud builds it from the documents it holds with the **same builder** as a cloud Z
(`app.services.z_builder.build_z`, `origin = till`) — the same figures, the same per-till
section, the same frozen header. What differs:

* **Numbered per till.** A gapless counter per machine (`machine_z_sequences`), from 1,
  never reset, independent of the shop's run. Allocated by the cloud, so a till Z needs
  a connection: two Zs can never share a number, and the till cannot disagree with what
  the cloud holds.
* **Idempotent by `clientRequestId`.** The till makes the id before its first attempt
  and keeps it until it has the Z, so a timeout or a lost response is retried with the
  same id and answered with the same Z (`200 duplicate`) — never a second number. The
  counter row is locked first, so two attempts at once take turns and the second finds
  the first's Z.
* **The business day is the till's.** Opened by the first shift after the previous Z,
  closed by the Z: the Z files under its first shift's business date.
* **The cloud never builds a Z for such a till** — `build_z` refuses it for any cloud Z,
  whatever path reaches the build, and `POST /z-runs` refuses it up front.

The dashboard can ask a till for its Z (`TillZRequest`, §5.4): the `till-z` Ably event,
and `pendingTillZ` on every heartbeat while pending. It completes only from the till's
Z call (or "nothing to report"), never from an ack, and expires after 36 h like a Z run.

A till's mode changes only through `set_z_mode`, refused while shifts wait for a Z of the
old mode or a Z is under way — so a shift can never be stranded between the two.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.till_z_request import (
    PENDING_TILL_Z_STATUSES,
    TillZRequest,
    TillZRequestStatus as S,
)
from app.models.user import User
from app.models.z_report import ZOrigin, ZReport
from app.models.z_run import LIVE_ITEM_STATUSES, ZRun, ZRunItem, ZRunStatus
from app.schemas.till_z import TillZIn
from app.services.close_progress import till_backlog
from app.services.machine_status import is_online
from app.services.shifts import refuse_foreign_shift
from app.services.z_builder import (
    Z_MODE_CLOUD,
    Z_MODE_TILL,
    ZBuildRefused,
    build_z,
    unreported_shifts,
)
from app.services.z_runs import Z_RUN_TTL_HOURS, _initiator
from app.services.z_sequence import lock_machine_z_sequence

logger = logging.getLogger(__name__)

Z_MODES = (Z_MODE_CLOUD, Z_MODE_TILL)

#: Same lifetime as a Z run: a till off overnight still gets it, and one back days later
#: does not produce a Z nobody is waiting for any more.
TILL_Z_REQUEST_TTL_HOURS = Z_RUN_TTL_HOURS


class TillZRefused(Exception):
    """
    A refusal whose body carries more than `detail` (`{"detail": "unreported_shifts",
    "count": 2}`), which `HTTPException` cannot. The router answers `body` as is.

    `keep`: the refusal itself changed something worth keeping (a request completed with
    nothing to report), so the router commits instead of rolling back.
    """

    def __init__(self, status_code: int, body: dict, *, keep: bool = False):
        super().__init__(body.get("detail"))
        self.status_code = status_code
        self.body = body
        self.keep = keep


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def z_mode_of(machine: Optional[POSMachine]) -> str:
    return Z_MODE_TILL if machine is not None and machine.z_mode == Z_MODE_TILL else Z_MODE_CLOUD


# ── Holds on a till ───────────────────────────────────────────────────────────


def live_z_run_item(db: Session, machine_id: uuid.UUID) -> Optional[ZRunItem]:
    """A cloud Z run that still holds this till (`waiting_close`, `closing`, `ready`)."""
    return (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id == machine_id,
            ZRunItem.status.in_(LIVE_ITEM_STATUSES),
            ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]),
        )
        .first()
    )


def _pending_query(db: Session, machine_id: uuid.UUID):
    return db.query(TillZRequest).filter(
        TillZRequest.machine_id == machine_id,
        TillZRequest.status.in_(PENDING_TILL_Z_STATUSES),
    )


def unreported_closed_count(db: Session, machine_id: uuid.UUID) -> int:
    return (
        db.query(Shift.id)
        .filter(
            Shift.machine_id == machine_id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.z_report_id.is_(None),
        )
        .count()
    )


# ── The setting (§5.1) ────────────────────────────────────────────────────────


def set_z_mode(db: Session, machine: POSMachine, mode: str, *, now: Optional[datetime] = None) -> bool:
    """
    Switch who produces this till's Z. Returns True if it changed; the same value again
    is a no-op.

    Refused while the till has **closed** shifts no Z includes
    (`409 unreported_shifts`, with their count): each was closed expecting a Z of the old
    mode — switched, a cloud-mode till's shifts would wait for a till Z the till never
    asks for, or a till-mode till's would be taken into a shop Z with a number from the
    other run. And while a Z is under way for it (`409 z_in_progress`): a live Z run item
    or a pending till-Z request. An **open** shift does not block: it simply goes into
    the next Z of the new mode.

    Locks the till's Z counter first, the lock every till Z takes, so a switch and a till
    Z of the same till cannot interleave.
    """
    if mode not in Z_MODES:  # pragma: no cover - the schema admits only the two
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_z_mode")
    if z_mode_of(machine) == mode:
        return False
    now = _now(now)
    lock_machine_z_sequence(db, machine.id)
    expire_overdue(db, now=now)
    if live_z_run_item(db, machine.id) is not None or _pending_query(db, machine.id).first() is not None:
        raise TillZRefused(status.HTTP_409_CONFLICT, {"detail": "z_in_progress"})
    count = unreported_closed_count(db, machine.id)
    if count:
        raise TillZRefused(status.HTTP_409_CONFLICT, {"detail": "unreported_shifts", "count": count})
    logger.info("machine %s z_mode %s -> %s", machine.id, machine.z_mode, mode)
    machine.z_mode = mode
    return True


# ── The till asks for its Z (§5.2) ────────────────────────────────────────────


def _conflict(detail: str, **extra) -> TillZRefused:
    return TillZRefused(status.HTTP_409_CONFLICT, {"detail": detail, **extra})


def z_shift_ids(db: Session, z: ZReport) -> List[uuid.UUID]:
    """The shifts a Z took, oldest first (as built)."""
    from app.services.z_builder import shift_order_key

    return [s.id for s in sorted(db.query(Shift).filter(Shift.z_report_id == z.id).all(), key=shift_order_key)]


def _included(db: Session, machine: POSMachine, body: TillZIn) -> Tuple[Optional[uuid.UUID], List[Shift]]:
    """
    (shop, shifts) the Z takes: this till's shifts no Z has taken, oldest first, up to
    and including `throughShiftId` (absent: up to its newest closed one), locked.

    No gaps: a shift of this till still open before the through shift refuses the Z
    (`shift_not_closed`) — a Z skipping it would leave a hole in the till's run of
    shifts, and one containing it would contain an X nobody closed.
    """
    through: Optional[Shift] = None
    if body.through_shift_id is not None:
        # Another till's shift first, exactly as the close checks it: a 403, not a 409.
        refuse_foreign_shift(db, machine, body.through_shift_id)
        through = (
            db.query(Shift)
            .filter(Shift.id == body.through_shift_id, Shift.machine_id == machine.id)
            .first()
        )
        if through is None:
            raise _conflict("shift_unknown")
    shop_id = (through.shop_id if through is not None else None) or machine.shop_id
    shifts = unreported_shifts(db, machine.id, shop_id=shop_id, lock=True)
    ids = [s.id for s in shifts]
    if through is not None:
        if through.id not in ids:
            # Already in a Z (a retry with a new id, or the dashboard got there first).
            return shop_id, []
        included = shifts[: ids.index(through.id) + 1]
    else:
        closed_at = [i for i, s in enumerate(shifts) if s.status == ShiftStatus.CLOSED]
        included = shifts[: closed_at[-1] + 1] if closed_at else []
    not_closed = next((s for s in included if s.status != ShiftStatus.CLOSED), None)
    if not_closed is not None:
        raise _conflict("shift_not_closed", shiftId=str(not_closed.id))
    return shop_id, included


def produce_till_z(
    db: Session, machine: POSMachine, body: TillZIn, *, now: Optional[datetime] = None
) -> Tuple[ZReport, str]:
    """
    Build this till's Z in the caller's transaction. Returns `(z, "created" | "duplicate")`.

    Raises `TillZRefused` (409 / 403 bodies of §5.2). Nothing is written on a refusal,
    except that a dashboard request answered "nothing to report" is completed (`keep`).
    """
    now = _now(now)
    # The till's counter row first: everything below — the duplicate check above all —
    # then reads what an earlier attempt of this till committed.
    lock_machine_z_sequence(db, machine.id)
    expire_overdue(db, now=now)

    existing = db.query(ZReport).filter(ZReport.client_request_id == body.client_request_id).first()
    if existing is not None:
        if str(existing.machine_id) != str(machine.id):
            raise _conflict("client_request_id_conflict")
        # The same Z, whatever changed since (the till switched mode, another shift
        # closed): the request was answered, and only its answer is repeated.
        _complete_requests(db, machine, existing, body.till_z_request_id, now)
        return existing, "duplicate"

    if z_mode_of(machine) != Z_MODE_TILL:
        raise _conflict("till_z_disabled")

    shop_id, included = _included(db, machine, body)
    if not included:
        named = _find_pending_for_till(db, machine, body.till_z_request_id)
        if named is not None:
            # A till asked from the dashboard with nothing to report has answered it.
            named.status = S.COMPLETED
            named.completed_at = now
            named.received_at = named.received_at or now
            named.error_code = "nothing_to_report"
            named.error_message = "The till had no closed shift waiting for a Z"
            db.flush()
        raise TillZRefused(
            status.HTTP_409_CONFLICT, {"detail": "nothing_to_report"}, keep=named is not None
        )

    item = live_z_run_item(db, machine.id)
    if item is not None:
        raise _conflict(f"z_run_in_progress:{item.run_id}")

    named = _find_pending_for_till(db, machine, body.till_z_request_id)
    try:
        z = build_z(
            db,
            tenant_id=machine.tenant_id,
            shop_id=shop_id,
            selections=[(machine, included[-1].id)],
            # The dashboard user whose request this answers; the till user is a name.
            created_by_user_id=named.created_by_user_id if named is not None else None,
            created_by_name=body.created_by_name,
            created_by_pos_user_id=body.created_by_user_id,
            client_request_id=body.client_request_id,
            till_totals=body.till,
            unattended=body.unattended,
            origin=ZOrigin.TILL,
            now=now,
        )
    except ZBuildRefused as refused:
        # Re-checked under the same locks the checks above took, so only a race gets
        # here; the codes are the Z run's (§2.6).
        logger.warning("till Z of machine %s refused: %s (%s)", machine.id, refused.code, refused.message)
        raise _conflict(refused.code)
    if z.totals_mismatch:
        logger.warning("till Z %s of machine %s: the till's figures differ %s", z.id, machine.id, body.till)
    _complete_requests(db, machine, z, body.till_z_request_id, now)
    db.flush()
    return z, "created"


def _complete_requests(
    db: Session, machine: POSMachine, z: ZReport, named_id: Optional[uuid.UUID], now: datetime
) -> None:
    """
    The till's pending request is answered by this Z — the one it named, and also one it
    did not name: a till holds at most one, and a cashier who pressed "הפק Z" before the
    request reached the till has produced exactly what it asked for. Left pending, it
    would make the till close the shift it opens next and file a second Z.
    """
    for req in _pending_query(db, machine.id).all():
        if req.created_at is not None and _aware(req.created_at) > _aware(z.closed_at) and req.id != named_id:
            continue  # asked after this Z: it wants the next one
        req.status = S.COMPLETED
        req.completed_at = now
        req.received_at = req.received_at or now
        req.z_report_id = z.id
        req.error_code = None
        req.error_message = None


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


# ── Dashboard requests (§5.3–§5.4) ────────────────────────────────────────────


def expire_overdue(db: Session, *, now: Optional[datetime] = None) -> int:
    """Lazy, like the Z runs: called from every read and write path."""
    now = _now(now)
    rows = (
        db.query(TillZRequest)
        .filter(
            TillZRequest.status.in_(PENDING_TILL_Z_STATUSES),
            TillZRequest.expires_at < now,
        )
        .all()
    )
    for req in rows:
        req.status = S.EXPIRED
        req.error_code = "expired"
        req.error_message = "The till did not produce its Z in time"
        req.failed_at = now
    return len(rows)


def _not_till_z(machine: POSMachine) -> TillZRefused:
    return TillZRefused(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {"detail": "machine_not_till_z", "machineId": str(machine.id)},
    )


def _check_requestable(machine: POSMachine) -> None:
    if (
        machine.pairing_status != PairingStatus.ASSIGNED
        or machine.shop_id is None
        or not machine.is_active
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    if z_mode_of(machine) != Z_MODE_TILL:
        raise _not_till_z(machine)


def request_for_machine(
    db: Session, user: User, machine: POSMachine, *, now: Optional[datetime] = None
) -> Tuple[TillZRequest, bool]:
    """
    Ask one till for its Z. Returns `(request, created)`: a till that already has a
    pending request gets that one back — it is never sent a second instruction.
    """
    now = _now(now)
    expire_overdue(db, now=now)
    _check_requestable(machine)
    existing = _pending_query(db, machine.id).order_by(TillZRequest.created_at.asc()).first()
    if existing is not None:
        return existing, False
    req = TillZRequest(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        created_by_user_id=user.id,
        initiated_by=_initiator(user),
        status=S.WAITING,
        expires_at=now + timedelta(hours=TILL_Z_REQUEST_TTL_HOURS),
        created_at=now,
        updated_at=now,
    )
    db.add(req)
    db.flush()
    _send(machine, req, now)
    return req, True


def shop_till_z_machines(db: Session, shop: Shop) -> List[POSMachine]:
    """The tills "Z לכל הקופות" asks for their own Z: assigned, active, `zMode = till`."""
    return (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == shop.id,
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.z_mode == Z_MODE_TILL,
        )
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )


def request_for_shop(
    db: Session, user: User, shop: Shop, machines: Sequence[POSMachine], *, now: Optional[datetime] = None
) -> List[TillZRequest]:
    """
    One request per till (the pending one where it has one). Every till is checked
    before any request is made, so a refusal (`422 machine_not_till_z`, 409) asks nobody.
    """
    now = _now(now)
    for machine in machines:
        if str(machine.shop_id) != str(shop.id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=f"machine_not_in_shop:{machine.id}"
            )
        _check_requestable(machine)
    return [request_for_machine(db, user, machine, now=now)[0] for machine in machines]


def _send(machine: POSMachine, req: TillZRequest, now: datetime) -> None:
    from app.services.ably_notify import publish_till_z_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now):
        # Offline is a delay, not a failure: the heartbeat hands it over on the next beat.
        return
    publish_till_z_notify(str(machine.tenant_id), str(machine.id), str(req.id), req.initiated_by or "")
    req.sent_at = now


def cancel(db: Session, req: TillZRequest) -> TillZRequest:
    """
    Stop offering it. A till that already started still finishes: its Z is filed as any
    till Z is (it names a request that is no longer pending, which changes nothing).
    """
    if req.status not in PENDING_TILL_Z_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="request_not_pending")
    req.status = S.CANCELLED
    req.error_code = "cancelled"
    db.flush()
    return req


def get_request(db: Session, request_id: uuid.UUID, tenant_id) -> Optional[TillZRequest]:
    return (
        db.query(TillZRequest)
        .filter(TillZRequest.id == request_id, TillZRequest.tenant_id == tenant_id)
        .first()
    )


# ── Till side ─────────────────────────────────────────────────────────────────


def find_for_till(db: Session, machine: POSMachine, request_id: Optional[uuid.UUID]) -> Optional[TillZRequest]:
    if request_id is None:
        return None
    return (
        db.query(TillZRequest)
        .filter(
            TillZRequest.id == request_id,
            TillZRequest.machine_id == machine.id,
            TillZRequest.tenant_id == machine.tenant_id,
        )
        .first()
    )


def _find_pending_for_till(db: Session, machine: POSMachine, request_id) -> Optional[TillZRequest]:
    req = find_for_till(db, machine, request_id)
    return req if req is not None and req.status in PENDING_TILL_Z_STATUSES else None


def apply_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> TillZRequest:
    """
    `received` / `deferred` → in progress (a deferral keeps its code, e.g. `card_in_flight`,
    for the operator); `failed` → failed. `completed` changes nothing: the request
    completes from the Z itself. A `failed` ack whose code is `nothing_to_report` is
    read as the answer it is — completed, with no Z. An ended request is not changed.
    """
    now = _now(now)
    req = find_for_till(db, machine, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="till_z_request_not_found")
    expire_overdue(db, now=now)
    if req.status not in PENDING_TILL_Z_STATUSES:
        return req
    if phase in ("received", "deferred"):
        req.status = S.IN_PROGRESS
        req.received_at = req.received_at or now
        if phase == "deferred":
            req.error_code = error_code or "deferred"
            req.error_message = error_message
        else:
            req.error_code = None
            req.error_message = None
    elif phase == "failed":
        if error_code == "nothing_to_report":
            req.status = S.COMPLETED
            req.completed_at = now
            req.received_at = req.received_at or now
            req.error_code = "nothing_to_report"
            req.error_message = error_message
        else:
            req.status = S.FAILED
            req.failed_at = now
            req.error_code = error_code or "failed"
            req.error_message = error_message
    elif phase == "completed":
        pass  # informational: only the Z (§5.2) completes a request
    else:  # pragma: no cover - the schema admits only these
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid phase")
    db.flush()
    return req


def take_pending(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """`pendingTillZ` for the heartbeat while a request of this till is pending (§5.3)."""
    now = _now(now)
    expire_overdue(db, now=now)
    req = _pending_query(db, machine.id).order_by(TillZRequest.created_at.asc()).first()
    if req is None:
        return None
    if req.sent_at is None:
        req.sent_at = now
    return {
        "requestId": str(req.id),
        "initiatedBy": req.initiated_by,
        "createdAt": _aware(req.created_at).isoformat() if req.created_at else None,
    }


def pending_by_machine(db: Session, machine_ids: List[uuid.UUID]) -> Dict[uuid.UUID, uuid.UUID]:
    """Per till with a pending request: its id."""
    if not machine_ids:
        return {}
    rows = (
        db.query(TillZRequest.machine_id, TillZRequest.id)
        .filter(
            TillZRequest.machine_id.in_(machine_ids),
            TillZRequest.status.in_(PENDING_TILL_Z_STATUSES),
        )
        .order_by(TillZRequest.created_at.asc())
        .all()
    )
    out: Dict[uuid.UUID, uuid.UUID] = {}
    for machine_id, request_id in rows:
        out.setdefault(machine_id, request_id)
    return out


# ── Out ───────────────────────────────────────────────────────────────────────


def request_to_out(db: Session, req: TillZRequest, *, now: Optional[datetime] = None) -> dict:
    machine = req.machine or db.query(POSMachine).filter(POSMachine.id == req.machine_id).first()
    z = req.z_report if req.z_report_id is not None else None
    return {
        "id": req.id,
        "machineId": req.machine_id,
        "machineName": machine.name if machine is not None else None,
        "shopId": req.shop_id,
        "status": req.status,
        "errorCode": req.error_code,
        "errorMessage": req.error_message,
        "createdAt": req.created_at,
        "updatedAt": req.updated_at,
        "expiresAt": req.expires_at,
        "createdByUserId": req.created_by_user_id,
        "initiatedBy": req.initiated_by,
        "sentAt": req.sent_at,
        "receivedAt": req.received_at,
        "completedAt": req.completed_at,
        "zReportId": req.z_report_id,
        "machineSequenceNumber": z.machine_sequence_number if z is not None else None,
        **till_backlog(machine, now=now),
    }
