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
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

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
    EMPTY_Z,
    EMPTY_Z_MESSAGE,
    Z_MODE_CLOUD,
    Z_MODE_TILL,
    ZBuildRefused,
    build_z,
    unreported_shifts,
)
from app.services.z_runs import Z_RUN_TTL_HOURS, _initiator
from app.services.z_sequence import (
    claim_machine_z_number,
    last_machine_z_number,
    lock_machine_z_sequence,
    machine_z_number_holder,
)

logger = logging.getLogger(__name__)

Z_MODES = (Z_MODE_CLOUD, Z_MODE_TILL)

#: Same lifetime as a Z run: a till off overnight still gets it, and one back days later
#: does not produce a Z nobody is waiting for any more.
TILL_Z_REQUEST_TTL_HOURS = Z_RUN_TTL_HOURS

#: A request answered "no Z on nothing": why, as the request keeps it.
EMPTY_Z_REQUEST_TEXT = "אין מסמכים — אין צורך ב-Z"


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


def waiting_shifts_all_empty(db: Session, machine: POSMachine) -> Optional[List[Shift]]:
    """
    The till's closed shifts no Z has taken, oldest first — when **every one of them is
    empty**, else None.

    Empty is what the builder refuses a Z for ("אל תאפשר לסגור Z על 0", `empty_z`): no
    document of any kind on the cloud, no money, no cash moved between shifts
    (`shifts_show_activity`) — and nothing on its way from the till either (its last report
    of documents not delivered yet is zero). Such shifts need no Z of the mode they were
    closed in: there is nothing to report, so none was ever made for them, and none may be
    (no Z number is drawn for nothing). A switch of the till's Z mode carries them into the
    first Z of the new mode — "a later Z with activity takes them along (they add nothing)",
    as for any empty shift — so the till's run of shifts still has no gap, and the switch
    records which they were (`z_mode_history[].emptyShiftsCarried`). A single shift with
    activity, or documents still pending on the till: None — that Z has to be made first.
    """
    from app.services.close_progress import documents_on_cloud
    from app.services.z_builder import shift_order_key, shifts_show_activity

    shifts = sorted(
        db.query(Shift)
        .filter(
            Shift.machine_id == machine.id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.z_report_id.is_(None),
        )
        .all(),
        key=shift_order_key,
    )
    if not shifts:
        return []
    # Known empty only from the till's own accepted close: a shift the cloud closed for a dead
    # till (or built for waiting documents) may still have documents on that till.
    if any(s.reconstructed or s.close_accepted_at is None for s in shifts):
        return None
    pending = machine.pending_documents if machine.pending_documents is not None else machine.pending_count
    if pending is not None and pending > 0:
        return None
    if any(documents_on_cloud(db, [s.id for s in shifts]).values()):
        return None
    by_shop: Dict[Any, List[Shift]] = {}
    for s in shifts:
        by_shop.setdefault(s.shop_id, []).append(s)
    if shifts_show_activity(db, list(by_shop.values())):
        return None
    return shifts


# ── The setting (§5.1) ────────────────────────────────────────────────────────


def _has_reconstructed_unreported(db: Session, machine_id: uuid.UUID) -> bool:
    return (
        db.query(Shift.id)
        .filter(
            Shift.machine_id == machine_id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.z_report_id.is_(None),
            Shift.reconstructed.is_(True),
        )
        .first()
        is not None
    )


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

    One exception, dead-till recovery (§2.9, §5): a till whose waiting shifts include one
    the cloud closed administratively may be switched **to `cloud`** with them — a dead
    till will never ask for its Z, and this is how its shifts reach one (the shop's).

    Locks the till's Z counter first, the lock every till Z takes, so a switch and a till
    Z of the same till cannot interleave.
    """
    if mode not in Z_MODES:  # pragma: no cover - the schema admits only the two
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_z_mode")
    if z_mode_of(machine) == mode:
        return False
    now = _now(now)
    # Never while the till may hold Zs the cloud has not seen (§4.4): switched, they
    # would have no run to go into, or their shifts would be taken by another Z.
    refuse_while_producing_offline(db, machine, now=now)
    lock_machine_z_sequence(db, machine.id)
    expire_overdue(db, now=now)
    if live_z_run_item(db, machine.id) is not None or _pending_query(db, machine.id).first() is not None:
        raise TillZRefused(status.HTTP_409_CONFLICT, {"detail": "z_in_progress"})
    count = unreported_closed_count(db, machine.id)
    carried: List[Shift] = []
    if count and not (mode == Z_MODE_CLOUD and _has_reconstructed_unreported(db, machine.id)):
        # Closed shifts with nothing in them need no Z of the old mode (`waiting_shifts_all_empty`).
        empty = waiting_shifts_all_empty(db, machine)
        if empty is None:
            raise TillZRefused(status.HTTP_409_CONFLICT, {"detail": "unreported_shifts", "count": count})
        carried = empty
    logger.info(
        "machine %s z_mode %s -> %s%s", machine.id, machine.z_mode, mode,
        f" (carrying {len(carried)} empty shift(s) with no Z)" if carried else "",
    )
    # Kept over time: a document goes to the Z kind its till was in when it was issued,
    # whatever the till switched to since (`document_filing.mode_at`).
    entry: Dict[str, Any] = {"at": now.isoformat(), "from": z_mode_of(machine), "to": mode}
    if carried:
        entry["emptyShiftsCarried"] = [str(s.id) for s in carried]
    machine.z_mode_history = list(getattr(machine, "z_mode_history", None) or []) + [entry]
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
    # A till Z takes only what was issued under the till's own Z (`document_filing.taken_by`):
    # late or waiting documents of a shop-Z period go to the shop's next Z.
    from app.services.document_filing import taken_by

    return shop_id, [s for s in included if taken_by(s, Z_MODE_TILL)]


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
        if body.offline is not None:
            # Printed already: never dropped, never renumbered — a conflict for support.
            raise _offline_conflict(db, machine, body, "till_z_disabled")
        raise _conflict("till_z_disabled")

    if body.offline is not None:
        return _produce_offline(db, machine, body, now)

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
            _settle_kiosk_commands(db, [named.id])
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
        # here; the codes are the Z run's (§2.6) — and "no Z on nothing" (`empty_z`).
        logger.warning("till Z of machine %s refused: %s (%s)", machine.id, refused.code, refused.message)
        if refused.code == EMPTY_Z and named is not None:
            # The dashboard's (or a controlling till's) request has its answer: nothing a Z
            # could report. Ended here, with why — the till's own ack (an older one says only
            # "http_409") changes nothing after this — and the command that asked says so.
            named.status = S.FAILED
            named.failed_at = now
            named.received_at = named.received_at or now
            named.error_code = EMPTY_Z
            named.error_message = EMPTY_Z_REQUEST_TEXT
            db.flush()
            _settle_kiosk_commands(db, [named.id])
            raise TillZRefused(
                status.HTTP_409_CONFLICT, {"detail": EMPTY_Z, "message": EMPTY_Z_MESSAGE}, keep=True,
            )
        raise _conflict(refused.code)
    if z.totals_mismatch:
        logger.warning("till Z %s of machine %s: the till's figures differ %s", z.id, machine.id, body.till)
    _note_card_transmission(db, machine, z, body)
    _complete_requests(db, machine, z, body.till_z_request_id, now)
    db.flush()
    return z, "created"


# ── A Z closed at the till with no connection (docs/SPEC_OFFLINE_TILL_Z.md) ───


#: What a refusal of an offline Z means to the till: wait and upload again, or a
#: conflict a person has to settle (the Z stays pending on the till).
OFFLINE_RETRY_DETAILS = ("shift_not_closed", "shift_unknown")

#: The till's §3.3 keys and the per-till section's key holding the same quantity.
#: `totalSales` is the till's gross (before document discounts), as on a close.
OFFLINE_COMPARED = (
    ("totalSales", "grossSales"),
    ("totalDiscounts", "discountsTotal"),
    ("totalRefunds", "totalRefunds"),
    ("totalCash", "totalCash"),
    ("totalCard", "totalCard"),
    ("totalExchange", "totalExchange"),
    ("totalTips", "totalTips"),
    ("vatTotal", "vatTotal"),
    ("transactionsCount", "transactionsCount"),
)

#: Drawer figures compared from the section the till printed, when it sent them.
OFFLINE_COMPARED_DRAWER = ("openingCash", "expectedCash", "countedCash", "overShort")

_CENT = Decimal("0.01")


def _as_decimal(value: Any) -> Optional[Decimal]:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None
    return out if out.is_finite() else None


def _differs(till_value: Any, cloud_value: Any) -> bool:
    ours, theirs = _as_decimal(cloud_value), _as_decimal(till_value)
    if theirs is None and ours is None:
        return False
    if theirs is None or ours is None:
        return True
    return abs(ours - theirs) > _CENT


def _same_document_number(till: Any, cloud: Any) -> bool:
    """
    A document number on the till's Z against the cloud's. The cloud shows it as printed,
    the prefix and the number padded to 7 digits (`20000057`, docs/SPEC_DOCUMENT_PREFIX.md);
    a till build from before the prefix sends the bare number (`57`), and one from the
    first prefix build `2-57`. Compared whole when both are in the same form, and by the
    number alone when one carries a prefix and the other does not — that is a build
    difference, not a gap.
    """
    from app.services.document_prefix import parse_document_query

    if cloud is None:
        return False
    a, b = str(till).strip(), str(cloud).strip()
    if a == b:
        return True
    qa, qb = parse_document_query(a), parse_document_query(b)
    if qa is None or qb is None:
        return False
    if qa.prefix is not None and qb.prefix is not None:
        # `2-57` (the first prefix build) against `20000057`: the same document.
        return qa.prefix == qb.prefix and qa.number == qb.number
    if qa.prefix is None and qb.prefix is None:
        return False
    return qa.number == qb.number


def offline_discrepancies(
    *,
    number: int,
    counter_before: int,
    till_totals: Optional[dict],
    till_report: Optional[dict],
    till_shift_ids: Sequence[Any],
    cloud_shift_ids: Sequence[Any],
    till_first_document: Optional[str],
    till_last_document: Optional[str],
    section: dict,
) -> List[dict]:
    """
    Where a Z closed offline differs from what the cloud built from the documents, as
    `{key, till, cloud}` — empty when it agrees. Pure.

    Compared: the number against the till's run (a jump), the shifts, the document range,
    the §3.3 figures the till sent (money to the agora), and the drawer figures of the
    section it printed. A key the till did not send is not a claim and is not compared.
    """
    out: List[dict] = []
    if number != counter_before + 1:
        out.append({"key": "machineSequenceNumber", "till": number, "cloud": counter_before + 1})
    till_ids = [str(i) for i in till_shift_ids]
    cloud_ids = [str(i) for i in cloud_shift_ids]
    if set(till_ids) != set(cloud_ids):
        out.append({"key": "shiftIds", "till": till_ids, "cloud": cloud_ids})
    for key, value in (("firstDocumentNumber", till_first_document), ("lastDocumentNumber", till_last_document)):
        cloud = section.get(key)
        if value is not None and not _same_document_number(value, cloud):
            out.append({"key": key, "till": value, "cloud": cloud})
    for till_key, section_key in OFFLINE_COMPARED:
        if not till_totals or till_key not in till_totals or till_totals[till_key] is None:
            continue
        if _differs(till_totals[till_key], section.get(section_key)):
            out.append({"key": till_key, "till": till_totals[till_key], "cloud": section.get(section_key)})
    for key in OFFLINE_COMPARED_DRAWER:
        if not till_report or key not in till_report:
            continue
        if _differs(till_report.get(key), section.get(key)):
            out.append({"key": key, "till": till_report.get(key), "cloud": section.get(key)})
    return out


def _produce_offline(db: Session, machine: POSMachine, body: TillZIn, now: datetime) -> Tuple[ZReport, str]:
    """
    A Z the till closed with no connection (§6.1), under the counter lock the caller took
    and after its duplicate and mode checks. Its number and id are the till's; its figures
    are built here from the documents, and every difference from the till's paper is
    kept and reported (`offline_z_gap`) — never silently overwritten.
    """
    off = body.offline
    number = off.machine_sequence_number
    if db.query(ZReport.id).filter(ZReport.id == off.id).first() is not None:
        raise _offline_conflict(db, machine, body, "offline_z_id_conflict", zReportId=str(off.id))
    # Strictly sequential, always (§4.2): only the exact next number of the till's run is
    # taken. A Z number, once produced and printed, is final ("אין דבר כזה זד שממוספר
    # מחדש"): anything else is a conflict for support — refused, recorded, and the till
    # keeps its Z exactly as printed. Supposed to be impossible: the till is the run's
    # only producer, and the cloud makes no Z for it while it may be producing (§4.4).
    expected = last_machine_z_number(db, machine.id) + 1
    # Numbered in another run of the till (it was made independent since, which starts its
    # Zs at 1 — docs/SPEC_INDEPENDENT_TILL.md §3.1): never filed into this one.
    from app.services.z_sequence import current_machine_epoch

    epoch_now = current_machine_epoch(db, machine.id)[0]
    if off.machine_sequence_epoch is not None and off.machine_sequence_epoch != epoch_now:
        raise _offline_conflict(
            db, machine, body, "offline_z_other_sequence",
            zNumber=number, expectedNumber=expected,
            zEpoch=off.machine_sequence_epoch, currentEpoch=epoch_now,
        )
    if number != expected:
        holder = machine_z_number_holder(db, machine.id, number)
        extra = {"takenByZReportId": str(holder.id)} if holder is not None else {}
        raise _offline_conflict(
            db, machine, body,
            "offline_z_number_taken" if holder is not None else "offline_z_out_of_sequence",
            zNumber=number,
            expectedNumber=expected,
            **extra,
        )
    taken = (
        db.query(Shift)
        .filter(Shift.id.in_(list(off.shift_ids)), Shift.z_report_id.isnot(None))
        .first()
    )
    if taken is not None:
        raise _offline_conflict(
            db, machine, body,
            "offline_z_shift_in_another_z", shiftId=str(taken.id), zReportId=str(taken.z_report_id),
        )
    shop_id, included = _included(db, machine, body.model_copy(update={"through_shift_id": off.shift_ids[-1]}))
    if not included:  # pragma: no cover - the check above found none of them taken
        raise _conflict("offline_z_shift_in_another_z", shiftId=str(off.shift_ids[-1]))
    item = live_z_run_item(db, machine.id)
    if item is not None:
        raise _conflict(f"z_run_in_progress:{item.run_id}")

    closed_at = _aware(off.closed_at)
    counter_before = claim_machine_z_number(db, machine.id, number)
    named = _find_pending_for_till(db, machine, body.till_z_request_id)
    try:
        z = build_z(
            db,
            tenant_id=machine.tenant_id,
            shop_id=shop_id,
            selections=[(machine, included[-1].id)],
            created_by_user_id=named.created_by_user_id if named is not None else None,
            created_by_name=body.created_by_name,
            created_by_pos_user_id=body.created_by_user_id,
            client_request_id=body.client_request_id,
            till_totals=body.till,
            unattended=body.unattended,
            origin=ZOrigin.TILL,
            now=closed_at,
            z_id=off.id,
            machine_sequence_number=number,
            allow_empty=True,
            # The cloud's carried late documents and the documents waiting for a shift are
            # in it too, each in its own section (§4.6.3): a till that always closes with no
            # connection would otherwise never have them in any Z. Its paper did not have
            # them, so the comparison below is with its own shifts only.
        )
    except ZBuildRefused as refused:
        logger.warning("offline till Z %s of machine %s refused: %s", off.id, machine.id, refused.code)
        raise _conflict(refused.code)
    from app.services.document_filing import is_cloud_built

    own = [s for s in included if not is_cloud_built(s)]
    added = [s for s in included if is_cloud_built(s)]
    z.built_offline = True
    z.uploaded_at = now
    z.offline_report = {
        "machineSequenceNumber": number,
        "closedAt": closed_at.isoformat(),
        "businessDate": off.business_date.isoformat() if off.business_date else None,
        "shiftIds": [str(i) for i in off.shift_ids],
        "firstDocumentNumber": off.first_document_number,
        "lastDocumentNumber": off.last_document_number,
        "report": off.report,
        "till": body.till,
    }
    section = (z.per_machine or [{}])[0]
    if added or section.get("adjustments"):
        # What the cloud added to the till's paper (§4.6.3): compared without it, and said.
        from app.services.shift_totals import compute_totals as _totals
        from app.services.z_builder import machine_section

        z.offline_report = {
            **z.offline_report,
            "cloudAdded": {
                "shiftIds": [str(s.id) for s in added],
                "documents": sum(int(s.transactions_count or 0) for s in added),
                "adjustments": (section.get("adjustments") or {}).get("count", 0),
            },
        }
        section = machine_section(machine, own, _totals(db, [s.id for s in own]))
    found = offline_discrepancies(
        number=number,
        counter_before=counter_before,
        till_totals=body.till,
        till_report=off.report,
        till_shift_ids=off.shift_ids,
        cloud_shift_ids=[s.id for s in own],
        till_first_document=off.first_document_number,
        till_last_document=off.last_document_number,
        section=section,
    )
    z.offline_discrepancies = found or None
    if found:
        logger.warning(
            "offline till Z %s (#%s) of machine %s differs from the cloud: %s", z.id, number, machine.id, found
        )
        _record_safely(
            db, machine,
            exception_type="offline_z_gap",
            key=f"offline_z_gap:{z.id}",
            occurred_at=closed_at,
            details={
                "zReportId": str(z.id),
                "zNumber": number,
                "closedAt": closed_at.isoformat(),
                "uploadedAt": now.isoformat(),
                "discrepancies": found,
                # The line the exceptions list shows.
                "summary": f"Z מס׳ {number}: " + ", ".join(
                    f"{d['key']} — קופה {_shown(d['till'])} / ענן {_shown(d['cloud'])}" for d in found[:4]
                ),
            },
            pos_user_id=body.created_by_user_id,
        )
    _note_card_transmission(db, machine, z, body)
    _complete_requests(db, machine, z, body.till_z_request_id, now)
    # One fewer on its way up; the next beat says the till's own count.
    if machine.offline_till_z_pending:
        machine.offline_till_z_pending = max(0, int(machine.offline_till_z_pending) - 1)
    db.flush()
    return z, "created"


#: How far back a till keeps its own Zs, and so what it pulls when it has none (§4.3).
TILL_Z_HISTORY_DAYS = 31
TILL_Z_HISTORY_MAX = 200


def till_z_history(
    db: Session, machine: POSMachine, *, days: int = TILL_Z_HISTORY_DAYS, now: Optional[datetime] = None
) -> List[ZReport]:
    """
    This till's own Zs of the last `days` days, oldest first — and always its newest,
    however old — for a new or reset till to hold the run it continues offline
    (docs/SPEC_OFFLINE_TILL_Z.md §4.3).
    """
    now = _now(now)
    base = db.query(ZReport).filter(ZReport.machine_id == machine.id, ZReport.origin == ZOrigin.TILL)
    # By run, then number: an independent till starts again at 1 (SPEC_INDEPENDENT_TILL §3.1).
    by_run = (ZReport.machine_sequence_epoch.desc(), ZReport.machine_sequence_number.desc())
    rows = (
        base.filter(ZReport.closed_at >= now - timedelta(days=days))
        .order_by(*by_run)
        .limit(TILL_Z_HISTORY_MAX)
        .all()
    )
    newest = base.order_by(*by_run).first()
    if newest is not None and all(z.id != newest.id for z in rows):
        rows.append(newest)
    return sorted(rows, key=lambda z: (z.machine_sequence_epoch or 0, z.machine_sequence_number or 0))


def _shown(value: Any) -> str:
    """One side of a discrepancy, short: a list of shifts by its count."""
    if isinstance(value, list):
        return f"{len(value)} משמרות"
    return "—" if value is None else str(value)


def _offline_conflict(db: Session, machine: POSMachine, body: TillZIn, detail: str, **extra) -> TillZRefused:
    """
    A Z the till closed with no connection that the cloud cannot take as it is (§4.5).
    Never renumbered, never rewritten: the till keeps it exactly as printed, held for
    support. Recorded here as an exception (`offline_z_conflict`) with everything the
    till sent, kept (`keep`) although the Z is refused. Supposed to be impossible.
    """
    off = body.offline
    logger.error(
        "offline till Z %s (#%s) of machine %s refused: %s %s",
        off.id if off else None, off.machine_sequence_number if off else None, machine.id, detail, extra,
    )
    if off is not None:
        _record_safely(
            db, machine,
            exception_type="offline_z_conflict",
            key=f"offline_z_conflict:{off.id}",
            occurred_at=_aware(off.closed_at),
            details={
                "conflict": detail,
                **{k: v for k, v in extra.items()},
                "zId": str(off.id),
                "zNumber": off.machine_sequence_number,
                "closedAt": _aware(off.closed_at).isoformat(),
                "businessDate": off.business_date.isoformat() if off.business_date else None,
                "shiftIds": [str(i) for i in off.shift_ids],
                "firstDocumentNumber": off.first_document_number,
                "lastDocumentNumber": off.last_document_number,
                "till": body.till,
                "report": off.report,
                "summary": f"Z מס׳ {off.machine_sequence_number} שנסגר ללא חיבור לא נקלט: {detail} — פנו לתמיכה",
            },
            pos_user_id=body.created_by_user_id,
        )
        machine.offline_till_z_conflict = True
        if getattr(machine, "support_z", None):
            # The till came back after support produced its Z (§4.6): noted in that record.
            from app.services.support_z import note_returned_z

            note_returned_z(db, machine, off.machine_sequence_number, detail)
    return TillZRefused(status.HTTP_409_CONFLICT, {"detail": detail, **extra}, keep=True)


# ── The till may be producing Zs offline (§4.4) ───────────────────────────────


def offline_parameter_on(db: Session, machine: POSMachine) -> bool:
    """`tillZOffline` as it resolves for this till."""
    from app.services import till_parameters as TP

    try:
        value = TP.till_parameters_for_machine(db, machine).parameters.get(TP.TILL_Z_OFFLINE_KEY)
    except Exception:  # noqa: BLE001 - unknown is "may": refused rather than risked
        return True
    return value is True or str(value).strip().lower() in ("true", "1", "yes", "on")


def may_be_producing_offline(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """
    Why this till may hold, or be making, Zs the cloud has not seen — or None.

    A till in `zMode = till` that said on its last beat it holds Zs closed with no
    connection not uploaded yet (`offline_till_z_pending`, or one held in a conflict),
    or one that may close Zs offline (`tillZOffline`) and is not seen now: until it beats
    again, nobody can say it has not. While so, nothing in the cloud may make, number
    or take the place of its Z (§4.4).
    """
    if z_mode_of(machine) != Z_MODE_TILL:
        return None
    # Support produced its Z from the cloud (§4.6) and the till has not been heard since:
    # it is gone, and what it may have printed is accounted for in support's record.
    support_at = getattr(machine, "support_z_at", None)
    if support_at is not None and (
        machine.last_heartbeat_at is None or _aware(machine.last_heartbeat_at) <= _aware(support_at)
    ):
        return None
    pending = int(getattr(machine, "offline_till_z_pending", None) or 0)
    if pending > 0 or getattr(machine, "offline_till_z_conflict", False):
        return {"reason": "pending", "pending": pending, "conflict": bool(machine.offline_till_z_conflict)}
    if offline_parameter_on(db, machine) and not is_online(machine.last_heartbeat_at, now=_now(now)):
        last = machine.last_heartbeat_at
        return {"reason": "not_seen", "lastHeartbeatAt": _aware(last).isoformat() if last else None}
    return None


def refuse_while_producing_offline(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> None:
    """`409 till_offline_zs_unsynced` while [may_be_producing_offline] says so."""
    why = may_be_producing_offline(db, machine, now=now)
    if why is None:
        return
    name = f"קופה {machine.pos_number}" if machine.pos_number else (machine.name or "הקופה")
    raise TillZRefused(
        status.HTTP_409_CONFLICT,
        {
            "detail": "till_offline_zs_unsynced",
            "machineId": str(machine.id),
            **why,
            "message": (
                f"ב{name} יש דוחות Z שנסגרו ללא חיבור וטרם סונכרנו לענן"
                if why["reason"] == "pending"
                else f"{name} יכולה לסגור Z ללא חיבור ולא נראתה לאחרונה — ייתכן שיש בה דוחות Z שטרם סונכרנו"
            ) + ". חברו את הקופה לרשת והמתינו לסנכרון, ואז נסו שוב.",
        },
    )


def apply_offline_report(machine: POSMachine, block, *, now: Optional[datetime] = None) -> None:
    """The heartbeat's `offlineTillZ` block: what the till holds that the cloud has not."""
    if block is None:
        return
    if block.pending is not None:
        machine.offline_till_z_pending = max(0, int(block.pending))
    if block.conflict is not None:
        machine.offline_till_z_conflict = bool(block.conflict)
    epoch = getattr(block, "epoch", None)
    if block.last_number is not None and epoch is not None:
        # A report of another run of the till (SPEC_INDEPENDENT_TILL §3.1) says nothing of
        # the current run's numbers.
        from sqlalchemy.orm import object_session

        from app.services.z_sequence import current_machine_epoch

        session = object_session(machine)
        if session is not None and int(epoch) != current_machine_epoch(session, machine.id)[0]:
            block = block.model_copy(update={"last_number": None})
    if block.last_number is not None:
        # Never down (§4.7): a number the device printed stays its, whatever a later
        # report says — support's Z is numbered after it (§4.6).
        machine.offline_till_z_last_number = max(
            int(block.last_number), int(getattr(machine, "offline_till_z_last_number", None) or 0)
        )
    machine.offline_till_z_reported_at = _now(now)


def _record_safely(db: Session, machine: POSMachine, **kwargs) -> None:
    """An exception about a Z; a failure to record it never refuses the Z."""
    from app.services.exceptions import record_z_exception

    try:
        record_z_exception(db, machine, **kwargs)
    except Exception:  # noqa: BLE001 - the Z is what matters; the log keeps the rest
        logger.exception("could not record %s for machine %s", kwargs.get("exception_type"), machine.id)


#: A transmission at a Z that did not go through.
TRANSMISSION_FAILED_OUTCOMES = ("failed", "unknown", "busy")


def _note_card_transmission(db: Session, machine: POSMachine, z: ZReport, body: TillZIn) -> None:
    """
    The card transmission the till ran before the Z, kept on it (§7.3). One that failed
    — closed on the cashier's confirmation, or unattended — is an exception.
    """
    report = body.card_transmission
    if not isinstance(report, dict) or not report:
        return
    z.card_transmission = report
    if str(report.get("outcome") or "").lower() in TRANSMISSION_FAILED_OUTCOMES:
        _record_safely(
            db, machine,
            exception_type="z_transmission_failed",
            key=f"z_transmission_failed:{z.id}",
            occurred_at=z.closed_at,
            details={
                "zReportId": str(z.id),
                "zNumber": z.machine_sequence_number,
                **report,
                "summary": " · ".join(
                    part for part in (
                        f"Z מס׳ {z.machine_sequence_number}",
                        str(report.get("statusMessage") or report.get("error") or report.get("outcome") or ""),
                        f"אישר: {report['confirmedByName']}" if report.get("confirmedByName") else "",
                    ) if part
                ),
            },
            amount=report.get("amount"),
            pos_user_id=body.created_by_user_id,
        )


def _complete_requests(
    db: Session, machine: POSMachine, z: ZReport, named_id: Optional[uuid.UUID], now: datetime
) -> None:
    """
    The till's pending request is answered by this Z — the one it named, and also one it
    did not name: a till holds at most one, and a cashier who pressed "הפק Z" before the
    request reached the till has produced exactly what it asked for. Left pending, it
    would make the till close the shift it opens next and file a second Z.
    """
    done = []
    for req in _pending_query(db, machine.id).all():
        if req.created_at is not None and _aware(req.created_at) > _aware(z.closed_at) and req.id != named_id:
            continue  # asked after this Z: it wants the next one
        req.status = S.COMPLETED
        req.completed_at = now
        req.received_at = req.received_at or now
        req.z_report_id = z.id
        req.error_code = None
        req.error_message = None
        done.append(req.id)
    if done:
        db.flush()
        _settle_kiosk_commands(db, done)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _settle_kiosk_commands(db: Session, request_ids: Sequence[Any]) -> None:
    """The kiosk commands (`kiosk_commands`) that made these requests take their outcome."""
    from app.services import kiosk_z

    kiosk_z.settle_commands(db, request_ids=request_ids)


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
    if rows:
        db.flush()
        _settle_kiosk_commands(db, [r.id for r in rows])
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
    db: Session, user: User, machine: POSMachine, *, force: bool = False, now: Optional[datetime] = None
) -> Tuple[TillZRequest, bool]:
    """
    Ask one till for its Z. Returns `(request, created)`: a till that already has a
    pending request gets that one back — it is never sent a second instruction, except
    that asking again with `force` ("כפה סגירה (גם באמצע מכירה)", docs/SPEC_OFFLINE_TILL_Z.md
    §9) makes the pending one forced and says so to the till again.
    """
    now = _now(now)
    expire_overdue(db, now=now)
    _check_requestable(machine)
    existing = _pending_query(db, machine.id).order_by(TillZRequest.created_at.asc()).first()
    if existing is not None:
        if force and not existing.force_close:
            existing.force_close = True
            db.flush()
            _send(machine, existing, now)
        return existing, False
    req = TillZRequest(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        created_by_user_id=user.id,
        initiated_by=_initiator(user),
        status=S.WAITING,
        force_close=bool(force),
        expires_at=now + timedelta(hours=TILL_Z_REQUEST_TTL_HOURS),
        created_at=now,
        updated_at=now,
    )
    db.add(req)
    db.flush()
    _send(machine, req, now)
    return req, True


def shop_till_z_machines(db: Session, shop: Shop) -> List[POSMachine]:
    """
    The tills "Z לכל הקופות" asks for their own Z: assigned, active, `zMode = till` — never
    a display device (app/services/display_devices.py), which makes no Z.
    """
    return (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == shop.id,
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.z_mode == Z_MODE_TILL,
            POSMachine.is_fiscal.is_(True),
        )
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )


def request_for_shop(
    db: Session,
    user: User,
    shop: Shop,
    machines: Sequence[POSMachine],
    *,
    force: bool = False,
    now: Optional[datetime] = None,
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
    return [request_for_machine(db, user, machine, force=force, now=now)[0] for machine in machines]


def _send(machine: POSMachine, req: TillZRequest, now: datetime) -> None:
    from app.services.ably_notify import publish_till_z_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now):
        # Offline is a delay, not a failure: the heartbeat hands it over on the next beat.
        return
    publish_till_z_notify(
        str(machine.tenant_id), str(machine.id), str(req.id), req.initiated_by or "",
        force=bool(req.force_close),
    )
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
    _settle_kiosk_commands(db, [req.id])
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
    if req.status not in PENDING_TILL_Z_STATUSES:
        # A kiosk's "הפקת Z" command follows the request it made (kiosk_z.settle_commands).
        _settle_kiosk_commands(db, [req.id])
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
    out = {
        "requestId": str(req.id),
        "initiatedBy": req.initiated_by,
        "createdAt": _aware(req.created_at).isoformat() if req.created_at else None,
    }
    if req.force_close:
        # "Even mid-sale" (docs/SPEC_OFFLINE_TILL_Z.md §9); absent = as always.
        out["force"] = True
    return out


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
        "force": bool(req.force_close),
        **till_backlog(machine, now=now),
    }
