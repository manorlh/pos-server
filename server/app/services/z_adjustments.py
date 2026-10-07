"""
Corrections to documents a Z already counted — carried into the till's next Z as an
adjustment (docs/SHIFTS_API.md §1.2, "A document for a shift that is already closed").

A Z's figures are frozen when it is built. A document of one of its shifts that the till
re-pushes with other fiscal content (its money, tenders, VAT, tip, type, or whether its
status counts) is stored as sent — but the Z keeps the old figures. Counting it only in
`amended_documents` left the difference in no Z at all. Now:

* **Recorded.** The difference between the document's two versions — exactly what
  `shift_totals.compute_totals` counts, as `DocumentTotals` — is kept on its till
  (`pos_machines.pending_z_adjustments`), with the document, the Z that counted the old
  version and when.
* **Carried.** The till's next Z of that shop — a cloud run, a till Z (online or offline),
  support's Z — adds the differences to its own figures and lists them in their own
  section (`header.adjustments`: "תיקונים למסמכים שנכללו ב-Z קודם"); its per-till section
  says how much of it is adjustments (`section.adjustments`). Each correction is in exactly
  one Z. The Z that counted the old version says where the correction went
  (`header.adjustmentsCarried`).
* **Never** the drawer of an earlier period: an adjustment moves the document figures
  (sales, refunds, discounts, VAT, tips, tenders), not a count of cash made then.

A main till's local shop Z is printed on the till from its parts; the cloud cannot add to
it, so a till in a local-mode shop keeps its corrections pending for the next Z the cloud
builds of it (a support Z), and the reconciliation report lists them until then.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.services.shift_totals import DocumentTotals, document_totals

logger = logging.getLogger(__name__)

LABEL = "תיקונים למסמכים שנכללו ב-Z קודם"


def _z_number(z: Optional[ZReport]) -> Optional[int]:
    if z is None:
        return None
    return z.machine_sequence_number or z.shop_sequence_number


def record(
    db: Session, issuer: POSMachine, doc_id: Any, z_id: Any, shift_id: Any, before: DocumentTotals,
    *, now: Optional[datetime] = None,
) -> Optional[dict]:
    """The document was rewritten after Z `z_id` counted it: keep the difference for the next Z."""
    from app.services.document_prefix import document_number_of

    now = now or datetime.now(timezone.utc)
    doc = db.query(Transaction).filter(Transaction.id == doc_id).populate_existing().one_or_none()
    if doc is None:
        return None
    after = document_totals(db, doc)
    delta = DocumentTotals().add(after).add(before, -1)
    if delta.is_zero():
        return None
    z = db.get(ZReport, z_id) if z_id is not None else None
    entry = {
        "id": str(uuid.uuid4()),
        "documentId": str(doc.id),
        "documentNumber": document_number_of(doc),
        "documentType": doc.document_type,
        "shiftId": str(shift_id) if shift_id is not None else None,
        "shopId": str(doc.shop_id) if doc.shop_id is not None else None,
        "sourceZReportId": str(z_id) if z_id is not None else None,
        "sourceZNumber": _z_number(z),
        "at": now.isoformat(),
        "before": before.delta_json(),
        "after": after.delta_json(),
        "delta": delta.delta_json(),
    }
    machine = db.get(POSMachine, issuer.id)
    machine.pending_z_adjustments = list(machine.pending_z_adjustments or []) + [entry]
    if z is not None:
        carried = list((z.header or {}).get("adjustmentsCarried") or [])
        carried.append({"adjustmentId": entry["id"], "documentId": entry["documentId"], "at": entry["at"], "intoZReportId": None})
        z.header = {**(z.header or {}), "adjustmentsCarried": carried}
    db.flush()
    logger.warning("document %s changed after Z %s: the difference waits for the next Z of till %s", doc.id, z_id, issuer.id)
    return entry


def pending(machine: POSMachine, shop_id: Any = None) -> List[dict]:
    rows = [e for e in (getattr(machine, "pending_z_adjustments", None) or []) if isinstance(e, dict)]
    if shop_id is None:
        return rows
    return [e for e in rows if e.get("shopId") in (None, str(shop_id))]


def take(machine: POSMachine, shop_id: Any) -> List[dict]:
    """The till's corrections for a Z of `shop_id`, removed from its pending list."""
    taken = pending(machine, shop_id)
    if taken:
        ids = {e["id"] for e in taken}
        machine.pending_z_adjustments = [
            e for e in (machine.pending_z_adjustments or []) if not (isinstance(e, dict) and e.get("id") in ids)
        ] or None
    return taken


def delta_of(entries: Sequence[dict]) -> DocumentTotals:
    out = DocumentTotals()
    for e in entries:
        out.add(DocumentTotals.from_delta_json(e.get("delta")))
    return out


def section_block(entries: Sequence[dict]) -> Optional[dict]:
    """What a per-till section says of the adjustments in its figures."""
    if not entries:
        return None
    delta = delta_of(entries)
    return {"count": len(entries), "delta": delta.delta_json(), "documentIds": [e["documentId"] for e in entries]}


def note_on_z(db: Session, z: ZReport, entries: Sequence[dict]) -> None:
    """The Z carries these corrections: its own section, and each source Z says where they went."""
    if not entries:
        return
    shown = [{k: v for k, v in e.items() if k not in ("before", "after")} for e in entries]
    z.header = {**(z.header or {}), "adjustments": {"label": LABEL, "items": shown, "delta": delta_of(entries).delta_json()}}
    for e in entries:
        source_id = e.get("sourceZReportId")
        if not source_id:
            continue
        try:
            source = db.get(ZReport, uuid.UUID(str(source_id)))
        except (ValueError, TypeError):
            source = None
        if source is None:
            continue
        # Copies: the stored list is never mutated in place (the change must be seen).
        carried = [dict(c) for c in (source.header or {}).get("adjustmentsCarried") or []]
        for c in carried:
            if c.get("adjustmentId") == e["id"]:
                c["intoZReportId"] = str(z.id)
                c["intoZNumber"] = _z_number(z)
        source.header = {**(source.header or {}), "adjustmentsCarried": carried}
