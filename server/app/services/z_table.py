"""
The Z types and the consolidated Z table (docs/SPEC_REPORTS.md §3–4).

"תאפשר לייצא טבלת זדים בצורה מרוכזת · תאפשר לסנן זדים לפי סוג, זד סניפי, עצמאי":

* **The type of a Z** (`z_type_of`, `filter_z_types` — the same rule in Python and SQL):
  - `shop`        — "Z סניפי": built by a Z run over the shop's tills (an area's Z too);
  - `independent` — "Z עצמאי": a till Z of an independent till (frozen scope
                    `independent_till`, docs/SPEC_INDEPENDENT_TILL.md §7);
  - `till`        — "Z לכל קופה": a till Z under the shop's per-till Z mode;
  - `kiosk`       — a kiosk's own Z (a till Z of a machine that is a kiosk, docs/SPEC_KIOSK.md §25);
  - `legacy`      — a till-issued row from before shifts (no sections).
* **The table** (`build_z_table`): one row per Z with its numbers (first/last document per
  series per till), counts, gross / net / VAT, every payment method, refunds, discounts, tips
  and the card transmission linked to it — and one row per till section of each Z (a shop Z's
  per-till lines). Read from what each Z froze at build, never recomputed: a Z is the document
  it was printed as. Its difference from the documents now is the reconciliation's job
  (app/services/reconciliation.py).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import String, and_, cast, false, or_, select
from sqlalchemy.orm import Session, joinedload

from app.models.z_report import ZOrigin, ZReport

Z_TYPE_SHOP = "shop"
Z_TYPE_INDEPENDENT = "independent"
Z_TYPE_TILL = "till"
Z_TYPE_KIOSK = "kiosk"
Z_TYPE_LEGACY = "legacy"
Z_TYPES = (Z_TYPE_SHOP, Z_TYPE_INDEPENDENT, Z_TYPE_TILL, Z_TYPE_KIOSK, Z_TYPE_LEGACY)

Z_TYPE_LABELS = {
    Z_TYPE_SHOP: "Z סניפי",
    Z_TYPE_INDEPENDENT: "Z עצמאי",
    Z_TYPE_TILL: "Z לכל קופה",
    Z_TYPE_KIOSK: "Z קיוסק",
    Z_TYPE_LEGACY: "Z ישן (קופה)",
}

#: Zs one table may hold; more is refused with a message, never cut short.
Z_TABLE_MAX = 5000

#: The series a Z's numbers run in, in the order a table shows them.
SERIES_LABELS = {320: "חשבונית מס קבלה", 330: "חשבונית זיכוי", 400: "קבלה"}

ZERO = Decimal("0")
CENT = Decimal("0.01")


# ── The type ─────────────────────────────────────────────────────────────────


def kiosk_machine_ids(db: Session, machine_ids: Optional[Iterable[Any]] = None) -> Set[uuid.UUID]:
    """The machines that are kiosks (of [machine_ids], or all)."""
    from app.models.kiosk import KioskDevice

    query = db.query(KioskDevice.machine_id)
    if machine_ids is not None:
        ids = [m for m in machine_ids if m is not None]
        if not ids:
            return set()
        query = query.filter(KioskDevice.machine_id.in_(ids))
    return {row[0] for row in query.all()}


def _scope_kind(z: ZReport) -> Optional[str]:
    scope = (z.header or {}).get("scope") if isinstance(z.header, dict) else None
    return scope.get("kind") if isinstance(scope, dict) else None


def z_type_of(z: ZReport, kiosk_ids: Set[uuid.UUID]) -> str:
    """The Z's type (module docstring). A kiosk's till Z is `kiosk` whatever its mode."""
    if z.per_machine is None and z.machine_id is not None:
        return Z_TYPE_LEGACY
    if (z.origin or ZOrigin.CLOUD) != ZOrigin.TILL:
        return Z_TYPE_SHOP
    if z.machine_id is not None and z.machine_id in kiosk_ids:
        return Z_TYPE_KIOSK
    if _scope_kind(z) == "independent_till":
        return Z_TYPE_INDEPENDENT
    return Z_TYPE_TILL


def parse_z_types(raw: Any) -> List[str]:
    """`zTypes` as given — repeated or comma-separated; unknown values are a 400."""
    if raw is None or not isinstance(raw, (list, tuple, str)):
        return []
    parts: List[str] = []
    for item in [raw] if isinstance(raw, str) else raw:
        if isinstance(item, str):
            parts.extend(p.strip() for p in item.split(",") if p.strip())
    bad = [p for p in parts if p not in Z_TYPES]
    if bad:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown zTypes: {', '.join(bad)} (one of {', '.join(Z_TYPES)})",
        )
    return list(dict.fromkeys(parts))


def filter_z_types(query, types: Sequence[str]):
    """`query` narrowed to Zs of any of [types] — `z_type_of` as SQL."""
    if not types:
        return query
    from app.models.kiosk import KioskDevice

    kiosks = select(KioskDevice.machine_id)
    # No sections: SQL NULL, or a JSON null written by the ORM for a Python None.
    no_sections = or_(ZReport.per_machine.is_(None), cast(ZReport.per_machine, String) == "null")
    legacy = and_(no_sections, ZReport.machine_id.isnot(None))
    not_legacy = or_(~no_sections, ZReport.machine_id.is_(None))
    till_origin = and_(ZReport.origin == ZOrigin.TILL, not_legacy)
    kind = ZReport.header["scope"]["kind"].as_string()
    is_kiosk = and_(till_origin, ZReport.machine_id.in_(kiosks))
    not_kiosk = or_(ZReport.machine_id.is_(None), ZReport.machine_id.notin_(kiosks))
    clauses = []
    for t in types:
        if t == Z_TYPE_LEGACY:
            clauses.append(legacy)
        elif t == Z_TYPE_SHOP:
            clauses.append(and_(ZReport.origin != ZOrigin.TILL, not_legacy))
        elif t == Z_TYPE_KIOSK:
            clauses.append(is_kiosk)
        elif t == Z_TYPE_INDEPENDENT:
            clauses.append(and_(till_origin, not_kiosk, kind == "independent_till"))
        elif t == Z_TYPE_TILL:
            clauses.append(and_(till_origin, not_kiosk, or_(kind.is_(None), kind != "independent_till")))
    return query.filter(or_(*clauses) if clauses else false())


# ── The query ────────────────────────────────────────────────────────────────


def filtered_z_query(
    db: Session,
    current_user,
    tenant_id,
    *,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    date_basis: str = "business",
    tzinfo=None,
    shop_ids: Sequence[uuid.UUID] = (),
    machine_ids: Sequence[uuid.UUID] = (),
    z_types: Sequence[str] = (),
    origin: Optional[str] = None,
    area_filter=None,
    closed_from: Optional[datetime] = None,
    closed_to: Optional[datetime] = None,
):
    """
    The Zs of `GET /z-reports`'s filters (the same scoping and the same rules: a Z of a till
    is one with a shift of it, or that till's own), with several shops and the Z types.
    None when the reader's role sees nothing.
    """
    from app.routers.z_reports import _local_midnight_utc, _machine_z_ids, _scope_by_user
    from app.services.areas import filter_on_column

    query = (
        db.query(ZReport)
        .options(joinedload(ZReport.machine), joinedload(ZReport.shop))
        .filter(ZReport.tenant_id == tenant_id)
    )
    query = _scope_by_user(query, current_user, db)
    if query is None:
        return None
    if machine_ids:
        wanted = list(machine_ids)
        query = query.filter(or_(ZReport.machine_id.in_(wanted), ZReport.id.in_(_machine_z_ids(wanted))))
    if shop_ids:
        query = query.filter(ZReport.shop_id.in_(list(shop_ids)))
    if area_filter is not None:
        query = filter_on_column(query, ZReport.area_id, area_filter)
    if origin in (ZOrigin.CLOUD, ZOrigin.TILL):
        query = query.filter(ZReport.origin == origin)
    query = filter_z_types(query, z_types)
    if date_basis == "production" and tzinfo is not None:
        if from_date is not None:
            query = query.filter(ZReport.closed_at >= _local_midnight_utc(from_date, tzinfo))
        if to_date is not None:
            query = query.filter(ZReport.closed_at < _local_midnight_utc(to_date + timedelta(days=1), tzinfo))
    else:
        if from_date is not None:
            query = query.filter(ZReport.business_date >= from_date)
        if to_date is not None:
            query = query.filter(ZReport.business_date <= to_date)
    # `closedFrom` / `closedTo` as the list reads them: a naive datetime is UTC.
    if closed_from is not None:
        query = query.filter(ZReport.closed_at >= (closed_from if closed_from.tzinfo else closed_from.replace(tzinfo=timezone.utc)))
    if closed_to is not None:
        query = query.filter(ZReport.closed_at <= (closed_to if closed_to.tzinfo else closed_to.replace(tzinfo=timezone.utc)))
    return query


# ── The table ────────────────────────────────────────────────────────────────


def _dec(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _money(value: Any) -> Optional[str]:
    d = _dec(value)
    return str(d.quantize(CENT)) if d is not None else None


def _sum(values: Iterable[Any]) -> Optional[str]:
    """The sum of the values that are there; None when none is."""
    got = [d for d in (_dec(v) for v in values) if d is not None]
    return str(sum(got, ZERO).quantize(CENT)) if got else None


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def _sections(z: ZReport) -> List[dict]:
    return [s for s in (z.per_machine or []) if isinstance(s, dict)]


def _number_key(number: Optional[str]) -> Tuple[int, str]:
    text = str(number or "")
    return (int(text), text) if text.isdigit() else (10**18, text)


def _ranges_of(section: dict) -> Dict[int, dict]:
    out: Dict[int, dict] = {}
    for r in section.get("documentRanges") or []:
        if isinstance(r, dict) and r.get("documentType") is not None:
            out[int(r["documentType"])] = r
    return out


def _transmission_of(sections: Sequence[dict], card_transmission: Optional[dict]) -> Dict[str, Any]:
    """The card transmission linked to a Z: its sections' frozen blocks, and the till's pre-Z batch."""
    batches: Dict[str, dict] = {}
    card_legs = transmitted = untransmitted = 0
    untransmitted_amount: List[Any] = []
    for s in sections:
        block = s.get("transmission") if isinstance(s.get("transmission"), dict) else None
        if not block:
            continue
        card_legs += int(block.get("cardLegs") or 0)
        transmitted += int(block.get("transmittedLegs") or 0)
        untransmitted += int(block.get("untransmittedLegs") or 0)
        untransmitted_amount.append(block.get("untransmittedAmount"))
        for b in block.get("batches") or []:
            if isinstance(b, dict) and b.get("id"):
                batches[b["id"]] = b
    success = [b for b in batches.values() if b.get("status") == "success"]
    carried = [b for b in success if int(b.get("legsInPeriod") or 0) > 0]
    ct = card_transmission if isinstance(card_transmission, dict) else {}
    return {
        "batchCount": len(batches),
        "successfulBatches": len(success),
        "failedBatches": sum(1 for b in batches.values() if b.get("status") == "failed"),
        "batchNumbers": [b.get("batchNumber") for b in carried if b.get("batchNumber")],
        "batchesAmount": _sum(b.get("amount") for b in carried),
        "cardLegs": card_legs,
        "transmittedLegs": transmitted,
        "untransmittedLegs": untransmitted,
        "untransmittedAmount": _sum(untransmitted_amount),
        # The till's own transmission just before this Z (a till Z).
        "zBatchOutcome": ct.get("outcome"),
        "zBatchNumber": ct.get("batchNumber"),
        "zBatchAmount": _money(ct.get("amount")),
        "zBatchCount": ct.get("transactionCount"),
    }


def _till_label(section: dict) -> str:
    pos = section.get("posNumber")
    name = section.get("machineName")
    if pos and name:
        return f"קופה {pos} ({name})"
    return f"קופה {pos}" if pos else (name or "")


def _ranges_text(sections: Sequence[dict], series: int) -> Optional[str]:
    parts = []
    for s in sections:
        r = _ranges_of(s).get(series)
        if r:
            span = r.get("first") if r.get("first") == r.get("last") else f"{r.get('first')}–{r.get('last')}"
            parts.append(f"{_till_label(s)}: {span}" if len(sections) > 1 else str(span))
    return "; ".join(parts) or None


def _series_count(sections: Sequence[dict], series: int) -> int:
    return sum(int((_ranges_of(s).get(series) or {}).get("count") or 0) for s in sections)


def _payments(breakdown: Any) -> Dict[str, str]:
    if not isinstance(breakdown, dict):
        return {}
    return {str(k): _money(v) or "0.00" for k, v in breakdown.items()}


def z_row(z: ZReport, z_type: str, out_item) -> Dict[str, Any]:
    """One Z as a table row (`out_item`: its `z_to_out`)."""
    sections = _sections(z)
    header = z.header if isinstance(z.header, dict) else {}
    net = _dec(out_item.net_sales)
    vat = _dec(z.vat_total)
    line_discounts = header.get("lineDiscountsTotal")
    promo_discounts = header.get("promotionDiscountsTotal")
    voucher_discounts = header.get("voucherDiscountsTotal")
    deductions = header.get("productionVoucherDeductionsTotal")
    return {
        "id": str(z.id),
        "zNumber": z.z_number,
        "zType": z_type,
        "zTypeLabel": Z_TYPE_LABELS.get(z_type, z_type),
        "origin": z.origin or ZOrigin.CLOUD,
        "shopId": str(z.shop_id) if z.shop_id else None,
        "shopName": out_item.shop_name,
        "shopNumber": out_item.shop_number,
        "branchCode": out_item.branch_code,
        "machineId": str(z.machine_id) if z.machine_id else None,
        "machineName": out_item.machine_name,
        "posNumber": out_item.pos_number,
        "tills": "، ".join(_till_label(s) for s in sections) or (out_item.machine_name or None),
        "areaName": out_item.area_name,
        "businessDate": z.business_date.isoformat() if z.business_date else None,
        "productionDate": out_item.production_date.isoformat() if out_item.production_date else None,
        "openedAt": _iso(z.period_start),
        "periodEnd": _iso(z.period_end),
        "closedAt": _iso(z.closed_at),
        "createdAt": _iso(z.created_at),
        "invoiceRange": _ranges_text(sections, 320),
        "creditNoteRange": _ranges_text(sections, 330),
        "receiptRange": _ranges_text(sections, 400),
        "invoiceCount": _series_count(sections, 320),
        "creditNoteDocuments": _series_count(sections, 330),
        "receiptCount": _series_count(sections, 400),
        "transactionsCount": z.transactions_count,
        "salesCount": sum(int(s.get("salesCount") or 0) for s in sections) if sections else None,
        "creditNotesCount": sum(int(s.get("creditNotesCount") or 0) for s in sections) if sections else None,
        "nonSaleDocumentsCount": sum(int(s.get("nonSaleDocumentsCount") or 0) for s in sections) if sections else None,
        "shiftCount": z.shift_count,
        "machineCount": z.machine_count,
        "grossSales": _money(out_item.gross_sales),
        # Without production vouchers' deductions (as stored, as the till's X); those apart.
        "discountsTotal": _money(z.discounts_total),
        "productionVoucherDeductionsTotal": _money(deductions),
        "lineDiscountsTotal": _money(line_discounts),
        "promotionDiscountsTotal": _money(promo_discounts),
        "voucherDiscountsTotal": _money(voucher_discounts),
        "totalSales": _money(z.total_sales),
        "totalRefunds": _money(z.total_refunds),
        "netSales": _money(net),
        "vatTotal": _money(vat),
        "netOfVat": _money(net - vat) if net is not None and vat is not None else None,
        "cashSales": _money(z.total_cash_sales),
        "cardSales": _money(z.total_card_sales),
        "payments": _payments(z.payment_breakdown),
        "totalTips": _money(z.total_tips),
        "cashTips": _money(z.total_cash_tips),
        "cardTips": _money(z.total_card_tips),
        "openingCash": _money(z.opening_cash),
        "expectedCash": _money(z.expected_cash),
        "actualCash": _money(z.actual_cash),
        "discrepancy": _money(z.discrepancy),
        "lateDocuments": z.late_documents or 0,
        "amendedDocuments": z.amended_documents or 0,
        "totalsMismatch": bool(z.totals_mismatch),
        "builtOffline": bool(z.built_offline),
        "transmission": _transmission_of(sections, z.card_transmission),
    }


def till_rows(z: ZReport, z_type: str) -> List[Dict[str, Any]]:
    """The Z's per-till lines (a shop Z: one per till it took)."""
    out = []
    for s in _sections(z):
        ranges = _ranges_of(s)
        net = _dec(s.get("netSales"))
        if net is None and _dec(s.get("totalSales")) is not None:
            net = _dec(s.get("totalSales")) - (_dec(s.get("totalRefunds")) or ZERO)
        vat = _dec(s.get("vatTotal"))
        transmission = _transmission_of([s], None)
        out.append({
            "zReportId": str(z.id),
            "zNumber": z.z_number,
            "zType": z_type,
            "zTypeLabel": Z_TYPE_LABELS.get(z_type, z_type),
            "shopName": z.shop.name if z.shop else None,
            "businessDate": z.business_date.isoformat() if z.business_date else None,
            "closedAt": _iso(z.closed_at),
            "machineId": s.get("machineId"),
            "posNumber": s.get("posNumber"),
            "machineName": s.get("machineName"),
            "shiftCount": s.get("shiftCount"),
            "firstShift": s.get("firstShiftSequence"),
            "lastShift": s.get("lastShiftSequence"),
            "invoiceFirst": (ranges.get(320) or {}).get("first"),
            "invoiceLast": (ranges.get(320) or {}).get("last"),
            "invoiceCount": (ranges.get(320) or {}).get("count"),
            "creditNoteFirst": (ranges.get(330) or {}).get("first"),
            "creditNoteLast": (ranges.get(330) or {}).get("last"),
            "receiptFirst": (ranges.get(400) or {}).get("first"),
            "receiptLast": (ranges.get(400) or {}).get("last"),
            "transactionsCount": s.get("transactionsCount"),
            "salesCount": s.get("salesCount"),
            "creditNotesCount": s.get("creditNotesCount"),
            "grossSales": _money(s.get("grossSales")),
            "discountsTotal": _money(s.get("discountsTotal")),
            "totalSales": _money(s.get("totalSales")),
            "totalRefunds": _money(s.get("totalRefunds")),
            "netSales": _money(net),
            "vatTotal": _money(vat),
            "netOfVat": _money(net - vat) if net is not None and vat is not None else None,
            "payments": _payments(s.get("paymentBreakdown")),
            "totalTips": _money(s.get("totalTips")),
            "expectedCash": _money(s.get("expectedCash")),
            "countedCash": _money(s.get("countedCash")),
            "overShort": _money(s.get("overShort")),
            "transmission": transmission,
        })
    return out


def build_z_table(db: Session, zs: Sequence[ZReport], tzinfo) -> Dict[str, Any]:
    """The rows of [zs] (already filtered and ordered) and their per-till lines."""
    from app.routers.z_reports import z_to_out

    kiosks = kiosk_machine_ids(db, {z.machine_id for z in zs if z.machine_id is not None})
    rows: List[Dict[str, Any]] = []
    tills: List[Dict[str, Any]] = []
    methods: List[str] = []
    for z in zs:
        kind = z_type_of(z, kiosks)
        row = z_row(z, kind, z_to_out(z, tzinfo=tzinfo))
        rows.append(row)
        for line in till_rows(z, kind):
            tills.append(line)
            for m in line["payments"]:
                if m not in methods:
                    methods.append(m)
        for m in row["payments"]:
            if m not in methods:
                methods.append(m)
    order = {"cash": 0, "card": 1}
    methods.sort(key=lambda m: (order.get(m, 2), m))
    return {"total": len(rows), "zs": rows, "tills": tills, "paymentMethods": methods}
