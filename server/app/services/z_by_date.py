"""
Zs by the date they were produced ("תאריך הפקת Z") — a reading of the Zs, never a figure of them.

The owner: "If a Z was produced on 1.10, I want to see on 1.10 all the tills, areas and shops
whose Z was produced that day, with totals." The date is the Z's own production moment
(`z_reports.closed_at` — when it was built, or, for a Z closed offline at the till, when the
till closed it), on the local calendar of the shop's timezone (the tenant's configured zone,
else Israel: shops have no zone of their own). The night of 30.9 closed by a Z at 02:00 on 1.10
is a Z of 1.10 here, while its business date stays 30.9.

What this module adds over `GET /z-reports?dateBasis=production` (the list, by page):

* **The summary** of every Z the filters match (`build_summary`): the count, the grand totals
  (sales, refunds, net, VAT, cash, card, tips, documents), and the same per shop, per area, per
  kind of Z and per day — plus one line per Z (who, which number, what kind, when it was produced,
  which business day it covers and its totals), so a CSV of the whole list needs no paging.
* **The month** (`with_document_months`): the same over one production month, and on each Z the
  split of its documents by the month each document is dated in ("₪X מסמכי ספטמבר · ₪Y מסמכי
  אוקטובר"). VAT reporting and the uniform file (מבנה אחיד) go by the document's date, never by
  the Z's: the split is there to say so, and the uniform-file export is not touched.

Everything here is read from what each Z froze at build (`z_reports` totals) — the same numbers
as the list, the Z's page and the consolidated table. The document-month split is read from the
Z's documents as the cloud holds them now, with the same rules as the Z's own figures
(`app.services.shift_totals`): a sale counts what was collected, a credit note is negative, a
cancelled document or a duplicate copy does not count.
"""
from __future__ import annotations

import uuid
from collections import OrderedDict
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, case, false, func, or_, true
from sqlalchemy.orm import Session

from app.models.shift import Shift
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.services import z_table

ZERO = Decimal("0")
CENT = Decimal("0.01")

#: The kind of a Z as the list shows it: `z_table`'s types, with a shop Z run for an area apart.
KIND_AREA = "area"
KINDS = (z_table.Z_TYPE_SHOP, KIND_AREA, z_table.Z_TYPE_TILL, z_table.Z_TYPE_INDEPENDENT,
         z_table.Z_TYPE_KIOSK, z_table.Z_TYPE_LEGACY)

#: The money totals of a Z, as on every line and every sum (decimal strings on the wire).
MONEY_KEYS = ("totalSales", "totalRefunds", "netSales", "vatTotal", "cashSales", "cardSales", "totalTips")

#: Zs per chunk in an `IN (...)` of the document-month split.
_CHUNK = 500


# ── Small readers ────────────────────────────────────────────────────────────


def _dec(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _money(value: Optional[Decimal]) -> Optional[str]:
    return str(value.quantize(CENT)) if value is not None else None


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    """A stored instant; a naive one is UTC (how it is stored)."""
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def production_moment_local(z: ZReport, tzinfo) -> Optional[datetime]:
    """When the Z was produced, on the shop's clock."""
    moment = _aware(z.closed_at)
    return moment.astimezone(tzinfo) if moment is not None else None


def production_date_of(z: ZReport, tzinfo) -> Optional[date]:
    """The local calendar date the Z was produced — the date it is listed under here."""
    local = production_moment_local(z, tzinfo)
    return local.date() if local is not None else None


def month_key(moment: datetime, tzinfo) -> str:
    """`YYYY-MM` of an instant on the shop's clock (DST-correct: zoneinfo, never a fixed offset)."""
    local = _aware(moment).astimezone(tzinfo)
    return f"{local.year:04d}-{local.month:02d}"


def kind_of(z: ZReport, z_type: str) -> str:
    """`area` for a shop Z started for an area, else the Z's type (`z_table.z_type_of`)."""
    if z_type == z_table.Z_TYPE_SHOP and z.area_id is not None:
        return KIND_AREA
    return z_type


def z_figures(z: ZReport) -> Dict[str, Any]:
    """The Z's totals as frozen at build: money as Decimals (None = not stored), documents an int."""
    sales = _dec(z.total_sales)
    refunds = _dec(z.total_refunds)
    return {
        "totalSales": sales,
        "totalRefunds": refunds,
        "netSales": (sales - (refunds or ZERO)) if sales is not None else None,
        "vatTotal": _dec(z.vat_total),
        "cashSales": _dec(z.total_cash_sales),
        "cardSales": _dec(z.total_card_sales),
        "totalTips": _dec(z.total_tips),
        "documents": int(z.transactions_count or 0),
    }


class Totals:
    """A running sum of Z figures. A money total no Z of the group stored stays None."""

    def __init__(self) -> None:
        self.count = 0
        self.documents = 0
        self.money: Dict[str, Optional[Decimal]] = {k: None for k in MONEY_KEYS}
        #: Zs whose VAT is not known (a Z built over a document that declared none).
        self.vat_unknown = 0

    def add(self, figures: Dict[str, Any]) -> None:
        self.count += 1
        self.documents += int(figures.get("documents") or 0)
        for key in MONEY_KEYS:
            value = figures.get(key)
            if value is None:
                if key == "vatTotal":
                    self.vat_unknown += 1
                continue
            self.money[key] = (self.money[key] or ZERO) + value

    def out(self) -> Dict[str, Any]:
        return {
            "count": self.count,
            **{k: _money(v) for k, v in self.money.items()},
            "documents": self.documents,
            "vatUnknownCount": self.vat_unknown,
        }


# ── Areas ────────────────────────────────────────────────────────────────────


def areas_of(db: Session, zs: Sequence[ZReport], kinds: Dict[uuid.UUID, str]) -> Dict[uuid.UUID, Tuple[Optional[str], Optional[str], str]]:
    """
    The area each Z is listed under: `(areaId, areaName, source)`.

    * A Z started for an area (`z_reports.area_id`): that area, by the name frozen on the Z.
    * A till's own Z (till / independent / kiosk): the area its shifts were stamped with
      (`shifts.area_id`, how every report reads a till's area), when they all share one.
    * Anything else — a whole-shop Z, a till Z over shifts of several areas or none: no area.
    """
    out: Dict[uuid.UUID, Tuple[Optional[str], Optional[str], str]] = {}
    till_ids: List[uuid.UUID] = []
    for z in zs:
        if z.area_id is not None:
            out[z.id] = (str(z.area_id), (z.header or {}).get("areaName") if isinstance(z.header, dict) else None, "z")
        elif kinds.get(z.id) in (z_table.Z_TYPE_TILL, z_table.Z_TYPE_INDEPENDENT, z_table.Z_TYPE_KIOSK):
            till_ids.append(z.id)
    if till_ids:
        stamped: Dict[uuid.UUID, set] = {}
        for start in range(0, len(till_ids), _CHUNK):
            chunk = till_ids[start:start + _CHUNK]
            for z_id, area_id in (
                db.query(Shift.z_report_id, Shift.area_id)
                .filter(Shift.z_report_id.in_(chunk))
                .distinct()
                .all()
            ):
                stamped.setdefault(z_id, set()).add(area_id)
        single = {z_id: next(iter(a)) for z_id, a in stamped.items() if len(a) == 1 and None not in a}
        names = {}
        if single:
            names = {
                row.id: row.name
                for row in db.query(ShopArea.id, ShopArea.name).filter(ShopArea.id.in_(list(set(single.values())))).all()
            }
        for z_id, area_id in single.items():
            out[z_id] = (str(area_id), names.get(area_id), "shifts")
    return out


# ── The document months ──────────────────────────────────────────────────────


def _counted_documents():
    """The documents a Z's figures count (`shift_totals._totals_of`), as SQL conditions."""
    from app.services.dashboard_stats import SALE_STATUSES

    return (
        Transaction.shift_id == Shift.id,
        # Only the shift's own till's documents (`compute_totals`).
        Transaction.machine_id == Shift.machine_id,
        Transaction.status.in_(list(SALE_STATUSES)),
        Transaction.duplicate_copy == false(),
        # ₪0 memo lines only: no document for the Z (`voucher_memo_documents`).
        ~and_(Transaction.voucher_memo == true(), Transaction.total_amount == 0, Transaction.tip_amount == 0),
    )


def _signed_columns():
    from app.services.tenders import CREDIT_DOCUMENT_TYPES

    refund = or_(
        Transaction.document_type.in_(list(CREDIT_DOCUMENT_TYPES)),
        Transaction.refund_of_transaction_id.isnot(None),
    )
    # A sale contributes what was collected (total less its document discount); a credit note
    # its total, negative — `tenders.expected_tender_total` with the Z's sign.
    amount = case(
        (refund, -Transaction.total_amount),
        else_=Transaction.total_amount - func.coalesce(Transaction.document_discount, 0),
    )
    vat = case((refund, -func.coalesce(Transaction.vat_amount, 0)), else_=func.coalesce(Transaction.vat_amount, 0))
    vat_missing = case((Transaction.vat_amount.is_(None), 1), else_=0)
    # The document's date: when the till produced it, else when it was created (the uniform
    # file's record date, `open_format._document_moment`).
    moment = func.coalesce(Transaction.document_production_date, Transaction.created_at)
    return moment, amount, vat, vat_missing


class _Month:
    __slots__ = ("net", "vat", "vat_missing", "documents")

    def __init__(self) -> None:
        self.net = ZERO
        self.vat = ZERO
        self.vat_missing = 0
        self.documents = 0

    def add(self, net, vat, vat_missing, documents) -> None:
        self.net += _dec(net) or ZERO
        self.vat += _dec(vat) or ZERO
        self.vat_missing += int(vat_missing or 0)
        self.documents += int(documents or 0)

    def out(self, month: str) -> Dict[str, Any]:
        return {
            "month": month,
            "netSales": _money(self.net),
            # Unknown, not understated, when a document of it declared no VAT.
            "vatTotal": _money(self.vat) if self.vat_missing == 0 else None,
            "documents": self.documents,
        }


def document_months(db: Session, zs: Sequence[ZReport], tzinfo) -> Dict[uuid.UUID, List[Dict[str, Any]]]:
    """
    Each Z's documents by the local month they are dated in: `[{month, netSales, vatTotal,
    documents}]`, oldest month first. A Z with no shifts (a legacy till-issued row) has none.

    One grouped query finds each Z's first and last document date; only a Z whose documents
    span more than one month is read document by document. Months are cut on the shop's clock
    with zoneinfo, so a document at 00:30 on 1.10 (21:30 UTC on 30.9) is October's.
    """
    ids = [z.id for z in zs]
    out: Dict[uuid.UUID, List[Dict[str, Any]]] = {}
    if not ids:
        return out
    moment, amount, vat, vat_missing = _signed_columns()
    conditions = _counted_documents()
    spanning: List[uuid.UUID] = []
    for start in range(0, len(ids), _CHUNK):
        chunk = ids[start:start + _CHUNK]
        rows = (
            db.query(
                Shift.z_report_id,
                func.min(moment),
                func.max(moment),
                func.count(Transaction.id),
                func.sum(amount),
                func.sum(vat),
                func.sum(vat_missing),
            )
            .filter(Shift.z_report_id.in_(chunk), *conditions)
            .group_by(Shift.z_report_id)
            .all()
        )
        for z_id, first, last, count, net, vat_sum, missing in rows:
            if first is None or last is None:
                continue
            m_first, m_last = month_key(first, tzinfo), month_key(last, tzinfo)
            if m_first != m_last:
                spanning.append(z_id)
                continue
            acc = _Month()
            acc.add(net, vat_sum, missing, count)
            out[z_id] = [acc.out(m_first)]
    for start in range(0, len(spanning), _CHUNK):
        chunk = spanning[start:start + _CHUNK]
        months: Dict[uuid.UUID, Dict[str, _Month]] = {}
        for z_id, when, net, vat_value, missing in (
            db.query(Shift.z_report_id, moment, amount, vat, vat_missing)
            .filter(Shift.z_report_id.in_(chunk), *conditions)
            .all()
        ):
            if when is None:
                continue
            months.setdefault(z_id, {}).setdefault(month_key(when, tzinfo), _Month()).add(net, vat_value, missing, 1)
        for z_id, by_month in months.items():
            out[z_id] = [by_month[m].out(m) for m in sorted(by_month)]
    return out


# ── The summary ──────────────────────────────────────────────────────────────


def _tills_of(z: ZReport, out_item) -> List[Dict[str, Any]]:
    sections = [s for s in (z.per_machine or []) if isinstance(s, dict)]
    if sections:
        return [{"posNumber": s.get("posNumber"), "machineName": s.get("machineName")} for s in sections]
    if out_item.machine_name or out_item.pos_number:
        return [{"posNumber": out_item.pos_number, "machineName": out_item.machine_name}]
    return []


def z_line(
    z: ZReport,
    z_type: str,
    out_item,
    tzinfo,
    area: Optional[Tuple[Optional[str], Optional[str], str]],
    months: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """One Z of the summary: who, which, what kind, when, which business day, its totals."""
    figures = z_figures(z)
    local = production_moment_local(z, tzinfo)
    production_month = f"{local.year:04d}-{local.month:02d}" if local is not None else None
    line = {
        "id": str(z.id),
        "zNumber": z.z_number,
        "zType": z_type,
        "kind": kind_of(z, z_type),
        "origin": z.origin or "cloud",
        "shopId": str(z.shop_id) if z.shop_id else None,
        "shopName": out_item.shop_name,
        "shopNumber": out_item.shop_number,
        "branchCode": out_item.branch_code,
        "areaId": area[0] if area else None,
        "areaName": area[1] if area else None,
        "areaSource": area[2] if area else None,
        "machineId": str(z.machine_id) if z.machine_id else None,
        "machineName": out_item.machine_name,
        "posNumber": out_item.pos_number,
        "machineSequenceEpoch": out_item.machine_sequence_epoch,
        "tills": _tills_of(z, out_item),
        "machineCount": z.machine_count,
        "shiftCount": z.shift_count,
        "producedAt": _aware(z.closed_at).isoformat() if z.closed_at else None,
        "productionDate": local.date().isoformat() if local is not None else None,
        "productionTime": local.strftime("%H:%M") if local is not None else None,
        "businessDate": z.business_date.isoformat() if z.business_date else None,
        "periodStart": _aware(z.period_start).isoformat() if z.period_start else None,
        "periodEnd": _aware(z.period_end).isoformat() if z.period_end else None,
        "builtOffline": bool(z.built_offline),
        "uploadedAt": _aware(z.uploaded_at).isoformat() if z.uploaded_at else None,
        **{k: _money(figures[k]) for k in MONEY_KEYS},
        "documents": figures["documents"],
    }
    if months is not None:
        line["documentMonths"] = months
        line["otherMonthDocuments"] = any(m["month"] != production_month for m in months)
        # The split reads the documents now; a Z keeps the figures it was built with. Said, not hidden.
        split = sum((_dec(m["netSales"]) or ZERO for m in months), ZERO)
        line["documentsMatchZ"] = figures["netSales"] is None or split == figures["netSales"].quantize(CENT)
    return line


def build_summary(
    db: Session,
    zs: Sequence[ZReport],
    tzinfo,
    *,
    date_basis: str = "production",
    with_document_months: bool = False,
) -> Dict[str, Any]:
    """
    The Zs [zs] (filtered and ordered by the caller): their lines, the grand totals and the same
    by shop, by area, by kind and by day (the production day, or the business day on that basis).
    """
    from app.routers.z_reports import z_to_out

    kiosks = z_table.kiosk_machine_ids(db, {z.machine_id for z in zs if z.machine_id is not None})
    types = {z.id: z_table.z_type_of(z, kiosks) for z in zs}
    areas = areas_of(db, zs, types)
    months = document_months(db, zs, tzinfo) if with_document_months else {}

    grand = Totals()
    by_shop: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
    by_area: "OrderedDict[Tuple[str, str], Dict[str, Any]]" = OrderedDict()
    by_kind: Dict[str, Totals] = {}
    by_day: Dict[str, Totals] = {}
    month_totals: Dict[str, _Month] = {}
    lines: List[Dict[str, Any]] = []
    for z in zs:
        out_item = z_to_out(z, tzinfo=tzinfo)
        line = z_line(z, types[z.id], out_item, tzinfo, areas.get(z.id),
                      months.get(z.id, []) if with_document_months else None)
        lines.append(line)
        figures = z_figures(z)
        grand.add(figures)

        shop_key = line["shopId"] or ""
        shop = by_shop.setdefault(shop_key, {
            "shopId": line["shopId"], "shopName": line["shopName"], "shopNumber": line["shopNumber"],
            "totals": Totals(),
        })
        shop["totals"].add(figures)

        area_key = (shop_key, line["areaId"] or "")
        area = by_area.setdefault(area_key, {
            "shopId": line["shopId"], "shopName": line["shopName"], "shopNumber": line["shopNumber"],
            "areaId": line["areaId"], "areaName": line["areaName"], "totals": Totals(),
        })
        area["totals"].add(figures)

        by_kind.setdefault(line["kind"], Totals()).add(figures)
        day = line["productionDate"] if date_basis == "production" else line["businessDate"]
        by_day.setdefault(day or "", Totals()).add(figures)
        for m in line.get("documentMonths") or []:
            month_totals.setdefault(m["month"], _Month()).add(
                m["netSales"], m["vatTotal"] or 0, 0 if m["vatTotal"] is not None else 1, m["documents"],
            )

    def _rows(groups: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [{**{k: v for k, v in g.items() if k != "totals"}, **g["totals"].out()} for g in groups]

    shops = sorted(by_shop.values(), key=lambda g: (g["shopNumber"] is None, g["shopNumber"] or 0, g["shopName"] or ""))
    area_rows = sorted(
        by_area.values(),
        key=lambda g: (g["shopNumber"] is None, g["shopNumber"] or 0, g["shopName"] or "", g["areaId"] is None,
                       g["areaName"] or ""),
    )
    out = {
        "count": grand.count,
        "totals": grand.out(),
        "byShop": _rows(shops),
        "byArea": _rows(area_rows),
        "byKind": [{"kind": k, **by_kind[k].out()} for k in KINDS if k in by_kind],
        "byDay": [{"date": d or None, **by_day[d].out()} for d in sorted(by_day)],
        "zs": lines,
    }
    if with_document_months:
        out["documentMonths"] = [month_totals[m].out(m) for m in sorted(month_totals)]
    return out
