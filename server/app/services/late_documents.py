"""
Late documents — into the next Z (docs/SPEC_OFFLINE_TILL_Z.md §4.6.3).

The owner: every document is in exactly one Z ("כשהקופה תדלק היא תיסגר? מה קורה אם יש נתונים
שלא עלו לענן ויש פער?"). A document that arrives (or is moved) into a shift a Z already took —
support's Z of a dead till (§4.6), a shift support closed, or any ordinary Z — finds that Z's
figures frozen: on its own it would be in no Z, a fiscal gap. So:

* **Carried.** Such documents are moved into a *carry shift* of the same till: closed,
  accepted, built by the cloud, marked `reconstruction_basis.kind = "late_documents"` with
  where they come from. One per till and source Z, until a Z takes it; later arrivals join
  it, or a new one after. A document a local shop Z names in its manifest is that Z's even
  when it arrives after it (SPEC_INDEPENDENT_TILL §8.12) — never carried.
* **In the next Z, by itself.** A carry shift is an ordinary closed shift no Z has taken:
  the till's next Z (per-till / independent), or the shop's next Z (a cloud run; the local
  main till takes its part from the shop Z history, `lateDocuments`) includes it — once,
  as every shift. The Z lists it in its own section: "מסמכים מאוחרים מתקופה קודמת (קופה N,
  הופקו לפני Z מס׳ X שהופק ע״י התמיכה)" with counts, ranges and totals (`header.lateFromEarlier`).
* **Kept where it was put.** A re-push naming the old shift never moves a document back, and
  the old shift's close never asks for it (`is_carry_shift`).
* **Linked.** Support's record (`support_z_produced`) names the carry shifts and, when a Z
  takes one, that Z.

Numbering is untouched: the next Z is the next number of its run, as always.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction
from app.models.z_report import ZReport

logger = logging.getLogger(__name__)

KIND = "late_documents"


#: Where late documents come from: support's Z, a shift support closed (shop Z mode), any Z.
SUPPORT_Z, SUPPORT_CLOSED, ORDINARY = "support_z", "support_closed", "z"


def label(till: Optional[str], z_number: Optional[int], source: str = SUPPORT_Z) -> str:
    """The section's title, in the owner's words."""
    number = z_number if z_number is not None else "—"
    if source == SUPPORT_Z:
        return f"מסמכים מאוחרים מתקופה קודמת (קופה {till or '—'}, הופקו לפני Z מס׳ {number} שהופק ע״י התמיכה)"
    if source == SUPPORT_CLOSED:
        return f"מסמכים מאוחרים מתקופה קודמת (קופה {till or '—'}, הגיעו אחרי Z מס׳ {number}; המשמרת נסגרה ע״י התמיכה)"
    return f"מסמכים מאוחרים מתקופה קודמת (קופה {till or '—'}, הגיעו אחרי Z מס׳ {number})"


def closed_by_support(db: Session, shift: Shift) -> bool:
    """Whether support closed `shift` from the cloud (or its Z took it), now or before (§4.6)."""
    machine = db.get(POSMachine, shift.machine_id)
    record = getattr(machine, "support_z", None) if machine is not None else None
    seen = 0
    while isinstance(record, dict) and seen < 50:
        if str(shift.id) in (record.get("closedShiftIds") or []) or str(shift.id) in (record.get("shiftIds") or []):
            return True
        record = record.get("previous")
        seen += 1
    return False


def source_of(db: Session, shift: Shift, z: ZReport) -> str:
    """Where late documents of `shift` (in `z`) come from — for the title and the records."""
    if (z.header or {}).get("producedBySupport"):
        return SUPPORT_Z
    return SUPPORT_CLOSED if closed_by_support(db, shift) else ORDINARY


def named_in(z: ZReport) -> set:
    """Documents a local shop Z names in its manifests (§8.12): that Z's, whenever they arrive."""
    report = z.offline_report if isinstance(z.offline_report, dict) else {}
    out = set()
    for till in report.get("tills") or []:
        manifest = till.get("manifest") if isinstance(till, dict) else None
        for raw in (manifest or {}).get("documentIds") or []:
            out.add(str(raw).lower())
    return out


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _money(value) -> Optional[str]:
    return None if value is None else str(Decimal(value).quantize(Decimal("0.01")))


def basis_of(shift: Optional[Shift]) -> Dict[str, Any]:
    basis = getattr(shift, "reconstruction_basis", None) if shift is not None else None
    return basis if isinstance(basis, dict) and basis.get("kind") == KIND else {}


def is_carry(shift: Optional[Shift]) -> bool:
    return bool(basis_of(shift))


def is_carry_shift(db: Session, shift_id) -> bool:
    """Whether `shift_id` is a carry shift — a document in it stays there."""
    if shift_id is None:
        return False
    row = db.query(Shift.reconstruction_basis).filter(Shift.id == shift_id).first()
    basis = row[0] if row is not None else None
    return isinstance(basis, dict) and basis.get("kind") == KIND


def _open_carry(db: Session, machine_id, source: ZReport) -> Optional[Shift]:
    """The carry shift of this till and support Z that no Z has taken yet, if any."""
    rows = (
        db.query(Shift)
        .filter(
            Shift.machine_id == machine_id,
            Shift.z_report_id.is_(None),
            Shift.status == ShiftStatus.CLOSED,
            Shift.reconstruction_basis.isnot(None),
        )
        .all()
    )
    for row in rows:
        basis = basis_of(row)
        if basis and basis.get("sourceZReportId") == str(source.id):
            return row
    return None


def carry(
    db: Session,
    shift: Shift,
    source: ZReport,
    *,
    doc_ids: Optional[Iterable[Any]] = None,
    now: Optional[datetime] = None,
) -> int:
    """
    Move the late documents of `shift` (in the Z `source`) into the till's carry shift, and
    recompute its X. `doc_ids`: the documents a push just wrote into it (new, or moved in);
    without them, those received after `source` was built. The number moved.
    """
    from app.services.shift_totals import compute_totals

    now = now or datetime.now(timezone.utc)
    query = db.query(Transaction).filter(Transaction.shift_id == shift.id)
    if doc_ids is not None:
        ids = list(doc_ids)
        if not ids:
            return 0
        query = query.filter(Transaction.id.in_(ids))
    else:
        cutoff = _aware(source.created_at) or _aware(source.closed_at)
        if cutoff is None:
            return 0
        query = query.filter(Transaction.server_received_at > cutoff)
    named = named_in(source)
    docs = [d for d in query.all() if str(d.id).lower() not in named]
    if not docs:
        return 0
    machine = db.get(POSMachine, shift.machine_id)
    kind = source_of(db, shift, source)
    target = _open_carry(db, shift.machine_id, source)
    if target is None:
        number = source.machine_sequence_number or source.shop_sequence_number
        till = machine.pos_number if machine is not None else None
        target = Shift(
            id=uuid.uuid4(),
            tenant_id=shift.tenant_id,
            machine_id=shift.machine_id,
            shop_id=shift.shop_id,
            area_id=getattr(shift, "area_id", None),
            business_date=shift.business_date,
            sequence_number=None,
            opened_at=now,
            closed_at=now,
            close_accepted_at=now,
            status=ShiftStatus.CLOSED,
            unattended=True,
            reconstructed=True,
            reconstructed_by="מסמכים מאוחרים",
            opened_by="מסמכים מאוחרים",
            closed_by="מסמכים מאוחרים",
            reconstruction_basis={
                "kind": KIND,
                "sourceZReportId": str(source.id),
                "sourceZNumber": number,
                "source": kind,
                "producedBySupport": kind == SUPPORT_Z,
                "shiftClosedBySupport": kind == SUPPORT_CLOSED,
                "sourceShiftIds": [],
                "posNumber": till,
                "label": label(till, number, kind),
                "carriedAt": now.isoformat(),
            },
        )
        db.add(target)
        db.flush()
    for doc in docs:
        doc.shift_id = target.id
    basis = dict(basis_of(target))
    sources = list(basis.get("sourceShiftIds") or [])
    if str(shift.id) not in sources:
        sources.append(str(shift.id))
    basis.update(sourceShiftIds=sources, documents=int(basis.get("documents") or 0) + len(docs))
    target.reconstruction_basis = basis
    db.flush()
    totals = compute_totals(db, [target.id])
    for column, value in totals.as_x().items():
        setattr(target, column, value)
    # Out of the source Z's shift: no longer "arrived after the Z and in none".
    shift.late_documents = max(0, int(shift.late_documents or 0) - len(docs))
    source.late_documents = max(0, int(source.late_documents or 0) - len(docs))
    source.header = {
        **(source.header or {}),
        "lateCarriedOut": int((source.header or {}).get("lateCarriedOut") or 0) + len(docs),
    }
    if kind != ORDINARY:
        _note_on_support(db, shift.machine_id, target, len(docs))
    logger.warning("%s late document(s) of Z %s carried into shift %s", len(docs), source.id, target.id)
    return len(docs)


def _support_row(db: Session, machine_id):
    from app.services.support_z import _exception_of

    machine = db.get(POSMachine, machine_id) if machine_id else None
    return _exception_of(db, machine) if machine is not None else None


def _note_on_support(db: Session, machine_id, target: Shift, count: int) -> None:
    row = _support_row(db, machine_id)
    if row is None:
        return
    details = dict(row.details or {})
    details["lateDocuments"] = int(details.get("lateDocuments") or 0) + int(count)
    carried = list(details.get("lateCarriedInto") or [])
    if str(target.id) not in carried:
        carried.append(str(target.id))
    details["lateCarriedInto"] = carried
    details["lateAt"] = datetime.now(timezone.utc).isoformat()
    row.details = details


def section_of(shift: Shift) -> Dict[str, Any]:
    """One carry shift as the Z lists it: its title, counts, range and totals."""
    basis = basis_of(shift)
    return {
        "shiftId": str(shift.id),
        "machineId": str(shift.machine_id),
        "posNumber": basis.get("posNumber"),
        "label": basis.get("label") or label(basis.get("posNumber"), basis.get("sourceZNumber")),
        "sourceZReportId": basis.get("sourceZReportId"),
        "sourceZNumber": basis.get("sourceZNumber"),
        "source": basis.get("source") or (SUPPORT_Z if basis.get("producedBySupport", True) else SUPPORT_CLOSED),
        "producedBySupport": bool(basis.get("producedBySupport", True)),
        "shiftClosedBySupport": bool(basis.get("shiftClosedBySupport", False)),
        "sourceShiftIds": basis.get("sourceShiftIds") or [],
        "documents": shift.transactions_count or 0,
        "firstDocumentNumber": shift.first_transaction_number,
        "lastDocumentNumber": shift.last_transaction_number,
        "totalSales": _money(shift.total_sales),
        "totalRefunds": _money(shift.total_refunds),
        "totalCash": _money(shift.total_cash),
        "totalCard": _money(shift.total_card),
        "vatTotal": _money(shift.vat_total),
    }


def note_on_z(db: Session, z: ZReport, shifts: Iterable[Shift]) -> None:
    """
    The Z the builder is making takes carry shifts: listed in their own section
    (`header.lateFromEarlier`), and support's record links to this Z. Called by the builder.
    """
    carried = [s for s in shifts if is_carry(s)]
    if not carried:
        return
    z.header = {**(z.header or {}), "lateFromEarlier": [section_of(s) for s in carried]}
    for shift in carried:
        if basis_of(shift).get("source") == ORDINARY:
            continue
        row = _support_row(db, shift.machine_id)
        if row is None:
            continue
        details = dict(row.details or {})
        included = list(details.get("lateIncludedIn") or [])
        entry = {
            "zReportId": str(z.id),
            "zNumber": z.machine_sequence_number or z.shop_sequence_number,
            "shiftId": str(shift.id),
            "documents": shift.transactions_count or 0,
        }
        if entry not in included:
            included.append(entry)
        details["lateIncludedIn"] = included
        row.details = details


def lan_part(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """
    A participant's carry shifts no Z has taken, as a part the local main till adds to its
    next shop Z (docs/SPEC_INDEPENDENT_TILL.md §8): the section and the manifest (§8.12),
    built from the cloud's documents — the same computation the cloud verifies with.
    """
    from app.services.support_z import lan_section_of_shifts

    shifts = [
        s for s in db.query(Shift).filter(
            Shift.machine_id == machine.id, Shift.z_report_id.is_(None), Shift.status == ShiftStatus.CLOSED,
        ).all()
        if is_carry(s)
    ]
    if not shifts:
        return None
    part = lan_section_of_shifts(db, machine, shifts)
    if part is None:
        return None
    part["late"] = True
    part["lateDocuments"] = [section_of(s) for s in shifts]
    part["label"] = section_of(shifts[0])["label"]
    try:
        from app.services import shop_z_manifest as MF

        ids = [str(t[0]) for t in db.query(Transaction.id).filter(Transaction.shift_id.in_([s.id for s in shifts])).all()]
        part["manifest"] = MF.manifest_of(MF.cloud_documents(db, ids).values())
    except Exception:  # noqa: BLE001 - a part with no manifest is still linked as it arrives
        logger.exception("could not build the manifest of the late part of till %s", machine.id)
    return part
