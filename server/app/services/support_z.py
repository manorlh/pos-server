"""
"הפקת Z מהענן ע״י התמיכה" — support produces a dead till's Z from the cloud
(docs/SPEC_OFFLINE_TILL_Z.md §4.6).

The owner: "אין הקלדה ידנית, וברוב המוחלט הקופה עבדה עם אינטרנט — תאפשר לייצר Z מהענן
ע״י התמיכה כדי שיושלמו הנתונים". A till destroyed, lost or permanently broken can never
close its shift or produce its Z. Support — the super admin — does it from the cloud, from
the data the cloud already holds. Nobody types a number or a figure:

* **The shifts** — every open one is closed from the cloud's documents
  (`close_shift_administratively`: reconstructed, unattended, uncounted).
* **The Z** — per-till Z mode: the till's Z over all its shifts no Z has taken, built with
  the same builder as any Z, numbered after the highest of the cloud's run and the last
  number the till itself reported on its heartbeat. The numbers between are Zs the device
  printed with no connection and never sent: recorded, never reused — never a duplicate
  paper. Shop Z mode: no Z here — the shop's Z (a cloud run, or the main till in local
  mode, which is handed the section) takes the closed shifts as any other.
* **The document counters** — the till's last reported counter per series; a replacement
  device starts after them, and any gap against the cloud is recorded.
* **The machine is marked** (`support_z`): the till, if it ever comes back, is told on its
  next contact, keeps its data read-only for that period and produces nothing for it; the
  documents it still uploads are late documents of support's Z, noted in the record.
* **Audited** — one exception (`support_z_produced`) holds who, when, why, the basis, the
  ranges and the gaps, and what arrived later.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.user import User, UserRole
from app.models.z_report import ZOrigin, ZReport
from app.services.machine_status import is_online
from app.services.shift_totals import CENT, compute_totals

logger = logging.getLogger(__name__)

#: Why support produces a till's Z — the dashboard's short list. A note may add to it.
REASONS: Dict[str, str] = {
    "destroyed": "המכשיר הושמד",
    "lost": "המכשיר אבד",
    "permanent_failure": "תקלה קבועה",
}

EXCEPTION_TYPE = "support_z_produced"
#: The words the record uses for numbers the device printed and the cloud never saw.
LOST_NUMBERS_LABEL = "הודפסו במכשיר ללא חיבור ולא הגיעו לענן"
SERIES = ("320", "330", "400")


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    m = _aware(moment)
    return m.isoformat() if m is not None else None


def _money(value) -> Optional[str]:
    return None if value is None else str(Decimal(value).quantize(CENT))


def _who(user: User) -> str:
    return user.username or user.email or str(user.id)


def check_permission(user: User) -> None:
    """Support alone — the super admin. Never a shop or company manager."""
    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")


# ── What it would do ──────────────────────────────────────────────────────────


def _unreported(db: Session, machine: POSMachine) -> List[Shift]:
    from app.services.z_builder import shift_order_key

    rows = db.query(Shift).filter(Shift.machine_id == machine.id, Shift.z_report_id.is_(None)).all()
    return sorted(rows, key=shift_order_key)


def skipped_numbers(cloud_last: int, reported_last: Optional[int]) -> List[int]:
    """The numbers the device printed with no connection and never sent. Pure."""
    if reported_last is None or reported_last <= cloud_last:
        return []
    return list(range(cloud_last + 1, reported_last + 1))


def counter_gaps(cloud: Dict[str, int], reported: Optional[Dict[str, Any]]) -> List[dict]:
    """
    Per series, the document numbers the device used and the cloud never received — its
    last reported counter above the cloud's highest. Pure.
    """
    out = []
    for series in SERIES:
        try:
            mine = int((reported or {}).get(series)) if (reported or {}).get(series) is not None else None
        except (TypeError, ValueError):
            mine = None
        held = int(cloud.get(series) or 0)
        if mine is not None and mine > held:
            out.append({"series": series, "cloudMax": held, "reported": mine, "from": held + 1, "to": mine,
                        "count": mine - held})
    return out


def _shop_mode(db: Session, machine: POSMachine) -> dict:
    from app.services import till_z

    if till_z.z_mode_of(machine) == till_z.Z_MODE_TILL:
        return {"kind": "till"}
    local = False
    if machine.shop is not None:
        try:
            from app.services.local_shop_z import local_mode_of_shop

            local = bool(local_mode_of_shop(db, machine.shop))
        except Exception:  # noqa: BLE001 - unknown is "cloud"; nothing is decided by it here
            local = False
    return {"kind": "shop", "local": local}


def preview(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> dict:
    """What producing the till's Z from the cloud would close, number, skip and record."""
    from app.services.shifts import highest_transaction_numbers
    from app.services.z_sequence import last_machine_z_number

    now = _now(now)
    shifts = _unreported(db, machine)
    totals = compute_totals(db, [s.id for s in shifts]) if shifts else None
    mode = _shop_mode(db, machine)
    cloud_last = last_machine_z_number(db, machine.id)
    reported_last = getattr(machine, "offline_till_z_last_number", None)
    skipped = skipped_numbers(cloud_last, reported_last) if mode["kind"] == "till" else []
    number = (max(cloud_last, reported_last or 0) + 1) if mode["kind"] == "till" and shifts else None
    cloud_counters = highest_transaction_numbers(db, machine.id)
    return {
        "machineId": str(machine.id),
        "machineName": machine.name,
        "posNumber": machine.pos_number,
        "zMode": mode,
        "online": is_online(machine.last_heartbeat_at, now=now),
        "lastHeartbeatAt": _iso(machine.last_heartbeat_at),
        "shifts": [
            {
                "id": str(s.id),
                "sequenceNumber": s.sequence_number,
                "status": s.status.value if hasattr(s.status, "value") else s.status,
                "openedAt": _iso(s.opened_at),
                "closedAt": _iso(s.closed_at),
                "willClose": s.status == ShiftStatus.OPEN,
                "businessDate": s.business_date.isoformat() if s.business_date else None,
            }
            for s in shifts
        ],
        "documents": None if totals is None else {
            "count": totals.transactions_count,
            "firstDocumentNumber": totals.first_transaction_number,
            "lastDocumentNumber": totals.last_transaction_number,
            "totalSales": _money(totals.total_sales),
            "totalRefunds": _money(totals.total_refunds),
            "totalCash": _money(totals.total_cash),
            "totalCard": _money(totals.total_card),
            "vatTotal": _money(totals.vat_total),
        },
        "zNumber": number,
        "cloudLastZNumber": cloud_last,
        "reportedLastZNumber": reported_last,
        "reportedPendingZs": getattr(machine, "offline_till_z_pending", None),
        "reportedAt": _iso(getattr(machine, "offline_till_z_reported_at", None)),
        "skippedNumbers": skipped,
        "skippedLabel": LOST_NUMBERS_LABEL if skipped else None,
        "documentCounters": {
            "cloud": cloud_counters,
            "reported": getattr(machine, "reported_document_counters", None),
            "reportedAt": _iso(getattr(machine, "document_counters_reported_at", None)),
            "gaps": counter_gaps(cloud_counters, getattr(machine, "reported_document_counters", None)),
        },
        "lastReportedPendingDocuments": (
            machine.pending_documents if machine.pending_documents is not None else machine.pending_count
        ),
        "alreadyProduced": getattr(machine, "support_z", None),
        "reasons": REASONS,
    }


# ── Doing it ──────────────────────────────────────────────────────────────────


def produce(
    db: Session,
    user: User,
    machine: POSMachine,
    *,
    reason: str,
    note: Optional[str] = None,
    now: Optional[datetime] = None,
) -> dict:
    """
    Close the till's shifts and produce its Z from the cloud (per-till Z mode), mark the
    machine and record it all. The caller commits. Refused for anyone but support, for a
    reason not on the list, and for a till that is online now (it can close itself).
    """
    from app.services import till_z
    from app.services.administrative_close import close_shift_administratively
    from app.services.z_builder import (
        ZBuildRefused,
        build_z,
        figures_show_activity,
        z_cash_summary,
    )
    from app.services.z_sequence import claim_machine_z_number_after_device, lock_machine_z_sequence

    check_permission(user)
    if reason not in REASONS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_reason")
    now = _now(now)
    who = _who(user)
    # The till's counter first, as every till Z takes it: nothing of this till interleaves.
    lock_machine_z_sequence(db, machine.id)
    if is_online(machine.last_heartbeat_at, now=now):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "terminal_is_online",
                "message": "הקופה מחוברת כעת — היא יכולה לסגור את המשמרת ולהפיק את ה-Z בעצמה.",
            },
        )
    before = preview(db, machine, now=now)
    label = f"הפקת Z מהענן ע״י התמיכה — {REASONS[reason]}" + (f": {note}" if note else "")

    closed: List[str] = []
    for shift in _unreported(db, machine):
        if shift.status == ShiftStatus.OPEN:
            close_shift_administratively(db, machine, shift, user, force=True, note=label[:500], now=now)
            closed.append(str(shift.id))

    mode = before["zMode"]
    z: Optional[ZReport] = None
    skipped = before["skippedNumbers"]
    included = [s for s in _unreported(db, machine) if s.status == ShiftStatus.CLOSED]
    if mode["kind"] == "till" and included:
        shop_id = included[-1].shop_id or machine.shop_id
        included = [s for s in included if s.shop_id == shop_id]
        totals = compute_totals(db, [s.id for s in included])
        between = z_cash_summary([included])["between_shifts"]
        if figures_show_activity(totals, between):
            number = int(before["zNumber"])
            claim_machine_z_number_after_device(db, machine.id, number)
            try:
                z = build_z(
                    db,
                    tenant_id=machine.tenant_id,
                    shop_id=shop_id,
                    selections=[(machine, included[-1].id)],
                    created_by_user_id=user.id,
                    created_by_name=f"תמיכה — {who}",
                    unattended=True,
                    origin=ZOrigin.TILL,
                    now=now,
                    machine_sequence_number=number,
                )
            except ZBuildRefused as refused:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=refused.code)
            z.header = {
                **(z.header or {}),
                "producedBySupport": {
                    "by": who, "byUserId": str(user.id), "at": now.isoformat(),
                    "reason": reason, "reasonText": REASONS[reason], "note": note,
                    "skippedNumbers": skipped,
                },
            }
            till_z._complete_requests(db, machine, z, None, now)

    record = {
        "at": now.isoformat(),
        "by": who,
        "byUserId": str(user.id),
        "reason": reason,
        "reasonText": REASONS[reason],
        "note": note,
        "zMode": mode,
        "zReportId": str(z.id) if z is not None else None,
        "zNumber": z.machine_sequence_number if z is not None else None,
        "shiftIds": [str(s.id) for s in included] if mode["kind"] == "till" else list(closed),
        "closedShiftIds": closed,
        "lastShiftSequence": max((s.sequence_number or 0 for s in included), default=None) if included else None,
        "skippedNumbers": skipped,
        "skippedLabel": LOST_NUMBERS_LABEL if skipped else None,
        "basis": {
            "lastHeartbeatAt": before["lastHeartbeatAt"],
            "documentsOnCloud": (before["documents"] or {}).get("count", 0),
            "lastReportedPendingDocuments": before["lastReportedPendingDocuments"],
            "cloudLastZNumber": before["cloudLastZNumber"],
            "reportedLastZNumber": before["reportedLastZNumber"],
            "reportedPendingZs": before["reportedPendingZs"],
            "reportedAt": before["reportedAt"],
        },
        "documentCounters": before["documentCounters"],
        "previous": getattr(machine, "support_z", None),
    }
    machine.support_z = record
    machine.support_z_at = now
    # What the device said it held is accounted for above; it is gone.
    machine.offline_till_z_pending = 0
    machine.offline_till_z_conflict = False
    db.flush()
    exception_id = _record(db, machine, record, user)
    logger.warning("support produced the Z of machine %s: %s", machine.id, record)
    return {**record, "exceptionId": exception_id, "preview": before}


def _record(db: Session, machine: POSMachine, record: dict, user: User) -> Optional[str]:
    """The one exception that holds it all, for the audit and the dashboard."""
    from app.services.exceptions import record_z_exception

    key = f"{EXCEPTION_TYPE}:{machine.id}:{record['at']}"
    parts = [f"הופק ע״י {record['by']} — {record['reasonText']}"]
    if record.get("zNumber"):
        parts.append(f"Z מס׳ {record['zNumber']}")
    if record.get("skippedNumbers"):
        parts.append(f"{LOST_NUMBERS_LABEL}: {', '.join(str(n) for n in record['skippedNumbers'])}")
    gaps = (record.get("documentCounters") or {}).get("gaps") or []
    for gap in gaps:
        parts.append(f"מסמכים {gap['series']}: {gap['from']}–{gap['to']} לא הגיעו לענן")
    try:
        record_z_exception(
            db, machine,
            exception_type=EXCEPTION_TYPE,
            key=key,
            occurred_at=datetime.fromisoformat(record["at"]),
            details={**record, "summary": " · ".join(parts), "lateDocuments": 0},
        )
    except Exception:  # noqa: BLE001 - the Z is what matters; the log keeps the rest
        logger.exception("could not record the support Z of machine %s", machine.id)
        return None
    row = db.query(AuditException).filter(AuditException.dedupe_key == key[:200]).first()
    return str(row.id) if row is not None else None


# ── Shop Z in local mode: the main till is handed the section ─────────────────


def lan_section(db: Session, machine: POSMachine) -> Optional[dict]:
    """
    A shop-Z till support closed from the cloud, for the main till's local shop Z
    (docs/SPEC_INDEPENDENT_TILL.md §8): its closed shifts no Z has taken, as the section
    the main till would have had from the till over the LAN — built from the cloud's
    documents, so the main till's paper and the cloud's figures are the same. The main
    till does not wait for the dead till; it takes this as its "closed" answer. None when
    support has not produced for it, or there is nothing left to take.
    """
    from app.services.z_builder import machine_section

    if not getattr(machine, "support_z", None):
        return None
    shifts = [
        s for s in _unreported(db, machine)
        if s.status == ShiftStatus.CLOSED and (machine.shop_id is None or s.shop_id == machine.shop_id)
    ]
    if not shifts:
        return None
    totals = compute_totals(db, [s.id for s in shifts])
    report = machine_section(machine, shifts, totals)
    dates = sorted(s.business_date.isoformat() for s in shifts if s.business_date)

    def f(value) -> Optional[float]:
        return None if value is None else float(Decimal(value).quantize(CENT))

    return {
        "machineId": str(machine.id),
        "posNumber": machine.pos_number,
        "machineName": machine.name,
        "shiftIds": [str(s.id) for s in shifts],
        "firstBusinessDate": dates[0] if dates else None,
        "lastBusinessDate": dates[-1] if dates else None,
        "firstDocumentNumber": totals.first_transaction_number,
        "lastDocumentNumber": totals.last_transaction_number,
        # The §3.3 keys the cloud compares: `totalSales` gross, as a till's close says it.
        "till": {
            "totalSales": f(totals.gross_sales),
            "totalDiscounts": f(totals.discounts_total),
            "totalRefunds": f(totals.total_refunds),
            "totalCash": f(totals.total_cash),
            "totalCard": f(totals.total_card),
            "totalExchange": f(totals.total_exchange),
            "totalTips": f(totals.total_tips),
            "vatTotal": f(totals.vat_total),
            "transactionsCount": totals.transactions_count,
        },
        "report": report,
        "closedBySupport": {
            "at": (machine.support_z or {}).get("at"),
            "by": (machine.support_z or {}).get("by"),
            "reason": (machine.support_z or {}).get("reasonText"),
        },
    }


# ── The till, if it ever comes back ───────────────────────────────────────────


def heartbeat_block(machine: POSMachine) -> Optional[dict]:
    """`supportZ` on the heartbeat: what support produced, so the till makes nothing for it."""
    record = getattr(machine, "support_z", None)
    if not record:
        return None
    return {
        "at": record.get("at"),
        "by": record.get("by"),
        "reason": record.get("reasonText"),
        "zReportId": record.get("zReportId"),
        "zNumber": record.get("zNumber"),
        "skippedNumbers": record.get("skippedNumbers") or [],
        "shiftIds": record.get("shiftIds") or [],
        "lastShiftSequence": record.get("lastShiftSequence"),
    }


def _exception_of(db: Session, machine: POSMachine) -> Optional[AuditException]:
    record = getattr(machine, "support_z", None) or {}
    if not record.get("at"):
        return None
    key = f"{EXCEPTION_TYPE}:{machine.id}:{record['at']}"[:200]
    return db.query(AuditException).filter(AuditException.dedupe_key == key).first()


def note_late_documents(db: Session, z: ZReport, shift: Shift, count: int) -> None:
    """Documents of support's Z that the till uploaded after it: kept in the record."""
    machine = db.get(POSMachine, z.machine_id) if z.machine_id else None
    row = _exception_of(db, machine) if machine is not None else None
    if row is None:
        return
    details = dict(row.details or {})
    details["lateDocuments"] = int(details.get("lateDocuments") or 0) + int(count)
    shifts = list(details.get("lateShiftIds") or [])
    if str(shift.id) not in shifts:
        shifts.append(str(shift.id))
    details["lateShiftIds"] = shifts
    details["lateAt"] = datetime.now(timezone.utc).isoformat()
    row.details = details


def note_returned_z(db: Session, machine: POSMachine, number: Optional[int], detail: str) -> None:
    """A Z the till closed for that period and tried to send after it came back: noted."""
    row = _exception_of(db, machine)
    if row is None:
        return
    details = dict(row.details or {})
    returned = list(details.get("returnedZs") or [])
    entry = {"zNumber": number, "refused": detail}
    if entry not in returned:
        returned.append(entry)
    details["returnedZs"] = returned
    row.details = details
