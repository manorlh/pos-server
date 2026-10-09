"""
Production vouchers — settlement with the production and its external invoices (the spec's §14,
the contract's helper section). The module prepares what the external invoice is made from and keeps
the invoice's references; it never issues an invoice, and never changes a redemption.

**Agreement** (`prepaid_settlement_agreements`): a company's agreement with a production for an
event. Its batches: an explicit list, or every batch of the company whose production (the batch's
`customer_name` until the Production entity) and event (`event_name`, or the report event's name)
match. Test batches ("שוברי בדיקה") never count. A batch belongs to one active agreement at most.

**What is charged** — vouchers, never units: a meal of three items is one voucher (§5, §19.14).

* `redemption` (the default) — a voucher whose first valid redemption (not reversed) falls in the
  period; a voucher redeemed in parts counts once, when first redeemed.
* `delivery` — a voucher in a *chargeable* delivery ("מסירה", `prepaid_voucher_deliveries`) made in
  the period, whatever is redeemed.

**Cancelled and replaced vouchers** (documented per agreement, the defaults first):

* `cancelledPolicy` `exclude` — a voucher cancelled and never redeemed is not charged (by delivery
  too: it is taken off the delivered count); `charge` — it is charged anyway (by redemption: when
  cancelled, inside the period).
* `replacementPolicy` `free` — a replacement and its original are one voucher: charged once, by the
  original's delivery or by whichever of them was redeemed first ("אינו יוצר חיוב נוסף"); `charge` —
  the replacement is a voucher of its own (by delivery: handed over when issued; by redemption: when
  redeemed), and the original keeps its own delivery / redemption.
* A voucher redeemed and then cancelled stays charged (it was redeemed).

**Amount** = Σ per batch, each chargeable voucher at the production price it was issued at (agorot, ₪
only): the batch's price, or — after "ערוך סדרה" changed it — the core's history by serial
(`prepaid_voucher_edit.production_price_of`); a replacement and its original at the original's. Invoices
take a batch's chargeable vouchers first in, first out (serial order), each line at their own prices.
The redemptions' value at the till (`redemption_rows`) is shown beside it, never added to it.

**Invoices** (`prepaid_settlement_invoices` + lines per batch): partial invoices and several per
agreement; a line never takes more vouchers of a batch than are charged and not yet invoiced (every
non-voided invoice of the tenant counted, the agreement row locked) — `prepaid_settlement_over_invoiced`.
An invoice is voided, never deleted. **Gap**: each invoice's own amount against its lines (quantity ×
price), and the agreement's invoices against the report, with an explanation field on both.
**Corrections** ("דוח תיקונים", §16): batches invoiced beyond what is charged now, and vouchers cancelled
after their batch was invoiced — the invoice itself stays as it was.

Prices and amounts are shown only with `prepaid_voucher_prices` (else null); the screen itself needs
`prepaid_voucher_settlement`.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherRedemption,
)
from app.models.prepaid_voucher_extras import (
    AGREEMENT_STATUSES,
    CANCELLED_POLICIES,
    REPLACEMENT_POLICIES,
    SETTLEMENT_BASES,
    PrepaidSettlementAgreement,
    PrepaidSettlementInvoice,
    PrepaidSettlementInvoiceFile,
    PrepaidSettlementInvoiceLine,
    PrepaidVoucherDelivery,
    PrepaidVoucherReplacement,
)
from app.models.user import User
from app.services import prepaid_voucher_extras_access as ACC

# ── 4xx details ───────────────────────────────────────────────────────────────
NOT_FOUND = "prepaid_settlement_not_found"
INVOICE_NOT_FOUND = "prepaid_settlement_invoice_not_found"
BAD_VALUE = "prepaid_settlement_bad_value"
SCOPE_REQUIRED = "prepaid_settlement_scope_required"
OVERLAP = "prepaid_settlement_overlap"
CURRENCY = "prepaid_settlement_currency"
PERIOD = "prepaid_settlement_bad_period"
OVER_INVOICED = "prepaid_settlement_over_invoiced"
BATCH_NOT_IN_AGREEMENT = "prepaid_settlement_batch_not_in_agreement"
DUPLICATE_INVOICE = "prepaid_settlement_invoice_duplicate"
INVOICE_VOIDED = "prepaid_settlement_invoice_voided"
CLOSED = "prepaid_settlement_closed"
#: The basis, period, policies or batches of an agreement with a live invoice: what the invoice covered
#: would change under it. Void the invoices first (or make a new agreement).
HAS_INVOICES = "prepaid_settlement_has_invoices"
REASON_REQUIRED = "prepaid_settlement_reason_required"
PRICES_REQUIRED = "prepaid_settlement_prices_required"
FILE_TOO_BIG = "prepaid_settlement_file_too_big"
FILE_TYPE = "prepaid_settlement_file_type"
NO_FILE = "prepaid_settlement_no_file"
DELIVERY_NOT_FOUND = "prepaid_voucher_delivery_not_found"
DELIVERY_RANGE = "prepaid_voucher_delivery_bad_range"
DELIVERY_OVERLAP = "prepaid_voucher_delivery_overlap"
DELIVERY_FUTURE = "prepaid_voucher_delivery_in_future"

FILE_MAX = 10 * 1024 * 1024
FILE_TYPES = ("application/pdf", "image/png", "image/jpeg", "image/webp")

#: The words the screen shows under the figures: how this agreement charges.
BASIS_TEXT = {
    "redemption": "לפי מימוש: שוברים שמומשו באופן תקין (נטו, בלי מימושים שבוטלו) בתקופה; שובר שמומש בחלקים נספר פעם אחת.",
    "delivery": "לפי מסירה: שוברים שנמסרו להפקה בתקופה וסומנו כחייבים, בלי קשר למימוש.",
}
CANCELLED_TEXT = {
    "exclude": "שובר שבוטל ולא מומש אינו מחויב.",
    "charge": "שובר שבוטל ולא מומש מחויב בכל זאת.",
}
REPLACEMENT_TEXT = {
    "free": "שובר חלופי והשובר המקורי נספרים כשובר אחד (ללא חיוב נוסף).",
    "charge": "שובר חלופי מחויב כשובר נפרד.",
}
PACKAGE_TEXT = "שובר חבילה נספר כשובר אחד; מחיר ההפקה אינו מוכפל ברכיבים."


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _pva():
    from app.services import prepaid_voucher_analytics as PVA

    return PVA


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def _agorot(value: Decimal) -> int:
    return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _choice(value: Optional[str], allowed: Sequence[str]) -> str:
    if value not in allowed:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_VALUE)
    return value


# ── Access ────────────────────────────────────────────────────────────────────


def _require(db: Session, user: User, level: str = "view") -> None:
    _pv()._require_role(user)
    ACC.require(db, user, ACC.SETTLEMENT_SECTION, level, ACC.SETTLEMENT_FORBIDDEN)


def get_agreement(db: Session, user: User, tenant_id, agreement_id, *, lock: bool = False) -> PrepaidSettlementAgreement:
    q = db.query(PrepaidSettlementAgreement).filter(
        PrepaidSettlementAgreement.id == (ACC.as_uuid(agreement_id) or uuid.uuid4()),
        PrepaidSettlementAgreement.tenant_id == tenant_id,
    )
    if lock:
        q = q.with_for_update()
    a = q.first()
    if a is None or not _pv()._covers_company(db, user, a.company_id):
        raise ACC.http(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return a


# ── The agreement's batches ───────────────────────────────────────────────────


def _event_name(db: Session, agreement) -> Optional[str]:
    name = (agreement.event_name or "").strip() or None
    if name is None and agreement.report_event_id is not None:
        from app.models.report_event import ReportEvent

        name = db.query(ReportEvent.name).filter(ReportEvent.id == agreement.report_event_id).scalar()
    return name


def _linked(q, B, link_col, link_id, name_col, name: Optional[str]):
    """[q] narrowed to the batches linked to [link_id] and, of those with no link of their own, named [name];
    with no [link_id], to every batch named [name]."""
    if link_id is None and not name:
        return q
    if link_col is None:  # a core without the link: the name alone
        return q.filter(func.trim(name_col) == name) if name else q
    if link_id is None:
        # Named only (an event typed as text): every batch of that name, linked or not.
        return q.filter(func.trim(name_col) == name.strip())
    conds = [link_col == link_id]
    if name:
        conds.append((link_col.is_(None)) & (func.trim(name_col) == name.strip()))
    return q.filter(or_(*conds))


def matching_batches(
    db: Session, tenant_id, company_id, *, production_name=None, production_id=None, event_name=None,
    report_event_id=None, batch_ids=None, skip_tests: bool = True,
) -> List[PrepaidVoucherBatch]:
    """The batches an agreement with these terms covers (test batches left out)."""
    from app.services.prepaid_voucher_controls import test_batch_ids

    B = PrepaidVoucherBatch
    q = db.query(B).filter(B.tenant_id == tenant_id, B.company_id == company_id)
    ids = [ACC.as_uuid(b) for b in (batch_ids or [])]
    ids = [i for i in ids if i is not None]
    if batch_ids:
        q = q.filter(B.id.in_(ids or [uuid.uuid4()]))
    else:
        if not (production_name or production_id or event_name or report_event_id):
            return []
        # Keyed by the core's links (§13): the batch's production (`production_id`) and event
        # (`report_event_id`). A name matches only a batch that has no link of its own — one made before
        # productions / events (its `customer_name` / `event_name` text).
        q = _linked(q, B, getattr(B, "production_id", None), production_id, B.customer_name, production_name)
        q = _linked(q, B, getattr(B, "report_event_id", None), report_event_id, B.event_name, event_name)
    batches = q.order_by(B.created_at).all()
    if skip_tests:
        tests = test_batch_ids(db, tenant_id)
        batches = [b for b in batches if str(b.id) not in tests]
    return batches


def agreement_batches(db: Session, agreement: PrepaidSettlementAgreement) -> List[PrepaidVoucherBatch]:
    return matching_batches(
        db, agreement.tenant_id, agreement.company_id,
        production_name=(agreement.production_name or "").strip() or None,
        production_id=agreement.production_id,
        event_name=_event_name(db, agreement),
        report_event_id=agreement.report_event_id,
        batch_ids=agreement.batch_ids,
    )


def _overlaps(db: Session, agreement: PrepaidSettlementAgreement, batches: Sequence[PrepaidVoucherBatch]) -> List[Dict[str, Any]]:
    """The other active agreements that cover one of [batches]."""
    mine = {str(b.id) for b in batches}
    if not mine:
        return []
    out = []
    others = db.query(PrepaidSettlementAgreement).filter(
        PrepaidSettlementAgreement.tenant_id == agreement.tenant_id,
        PrepaidSettlementAgreement.status == "active",
        PrepaidSettlementAgreement.id != agreement.id,
    )
    for other in others:
        shared = mine & {str(b.id) for b in agreement_batches(db, other)}
        if shared:
            out.append({"agreementId": str(other.id), "name": other.name, "batchIds": sorted(shared)})
    return out


# ── The computation ───────────────────────────────────────────────────────────


@dataclass
class _V:
    id: str
    serial: int
    status: str
    created_at: Optional[datetime]
    cancelled_at: Optional[datetime]
    first_redeemed: Optional[datetime] = None
    delivered_at: Optional[datetime] = None
    delivered_free: bool = False


@dataclass
class BatchFigures:
    batch: PrepaidVoucherBatch
    issued: int = 0
    replacements: int = 0
    delivered: int = 0
    delivered_free: int = 0
    redeemed: int = 0
    cancelled: int = 0
    cancelled_charged: int = 0
    replacements_charged: int = 0
    chargeable: int = 0
    units: Decimal = Decimal(0)
    till_value: int = 0
    redemptions: int = 0
    invoiced: int = 0
    invoiced_amount: int = 0
    chargeable_ids: List[str] = field(default_factory=list)
    #: The serial each chargeable voucher is priced by (a chain: its original's), then their prices in
    #: serial order — what the invoices take, first in first out.
    chargeable_serials: List[int] = field(default_factory=list)
    prices: List[Optional[int]] = field(default_factory=list)

    def amount(self, start: int = 0, count: Optional[int] = None) -> Optional[int]:
        """Agorot of the chargeable vouchers [start, start + count) in serial order; None: one has no price."""
        part = self.prices[start:] if count is None else self.prices[start:start + count]
        if any(p is None for p in part):
            return None
        return sum(int(p) for p in part)

    def uniform_price(self, start: int = 0, count: Optional[int] = None) -> Optional[int]:
        part = self.prices[start:] if count is None else self.prices[start:start + count]
        seen = {p for p in part}
        if not part:
            return self.batch.production_price
        return next(iter(seen)) if len(seen) == 1 else None


def _in(moment: Optional[datetime], start: Optional[datetime], end: Optional[datetime]) -> bool:
    m = _utc(moment)
    if m is None:
        return False
    return (start is None or m >= start) and (end is None or m < end)


def _deliveries(db: Session, batch_ids: Sequence[uuid.UUID]) -> Dict[str, List[PrepaidVoucherDelivery]]:
    out: Dict[str, List[PrepaidVoucherDelivery]] = defaultdict(list)
    if not batch_ids:
        return out
    for d in db.query(PrepaidVoucherDelivery).filter(
        PrepaidVoucherDelivery.batch_id.in_(batch_ids), PrepaidVoucherDelivery.voided_at.is_(None)
    ).order_by(PrepaidVoucherDelivery.delivered_at):
        out[str(d.batch_id)].append(d)
    return out


def invoiced_by_batch(db: Session, tenant_id, batch_ids: Sequence[uuid.UUID], agreement_id=None) -> Dict[str, Tuple[int, int]]:
    """
    batch id → (vouchers, agorot) on the non-voided invoices of [agreement_id] — or, without it, on every
    non-voided invoice of the tenant (the guard against the same vouchers on two agreements' invoices).
    """
    if not batch_ids:
        return {}
    L, I = PrepaidSettlementInvoiceLine, PrepaidSettlementInvoice
    q = (
        db.query(L.batch_id, func.sum(L.quantity), func.sum(L.amount))
        .join(I, I.id == L.invoice_id)
        .filter(I.tenant_id == tenant_id, I.voided_at.is_(None), L.batch_id.in_(batch_ids))
    )
    if agreement_id is not None:
        q = q.filter(I.agreement_id == agreement_id)
    return {str(b): (int(n or 0), int(a or 0)) for b, n, a in q.group_by(L.batch_id).all()}


def batch_figures(
    db: Session, agreement: PrepaidSettlementAgreement, batches: Sequence[PrepaidVoucherBatch], *, zone=None,
) -> List[BatchFigures]:
    """Every batch's counts and chargeable vouchers under [agreement]'s basis, period and policies."""
    PVA = _pva()
    zone = zone or PVA.zone_of(db, agreement.tenant_id)
    start, end = PVA._range(agreement.period_from, agreement.period_to, zone)
    basis = agreement.billing_basis or "redemption"
    charge_cancelled = (agreement.cancelled_policy or "exclude") == "charge"
    charge_replacements = (agreement.replacement_policy or "free") == "charge"
    ids = [b.id for b in batches]
    deliveries = _deliveries(db, ids)
    invoiced = invoiced_by_batch(db, agreement.tenant_id, ids, getattr(agreement, "id", None))
    R = PrepaidVoucherRedemption
    out: List[BatchFigures] = []
    for b in batches:
        vs: Dict[str, _V] = {
            str(v.id): _V(str(v.id), int(v.serial), v.status, _utc(v.created_at), _utc(v.cancelled_at))
            for v in db.query(PrepaidVoucher.id, PrepaidVoucher.serial, PrepaidVoucher.status,
                              PrepaidVoucher.created_at, PrepaidVoucher.cancelled_at).filter(PrepaidVoucher.batch_id == b.id)
        }
        for vid, first in (
            db.query(R.voucher_id, func.min(R.redeemed_at))
            .filter(R.batch_id == b.id, R.reversed_at.is_(None))
            .group_by(R.voucher_id)
        ):
            if str(vid) in vs:
                vs[str(vid)].first_redeemed = _utc(first)
        repl_ids = {str(r.replacement_voucher_id) for r in db.query(PrepaidVoucherReplacement.replacement_voucher_id)
                    .filter(PrepaidVoucherReplacement.batch_id == b.id)}
        # Replacements are handed over when issued, never in a delivery.
        by_serial = {v.serial: v for v in vs.values() if v.id not in repl_ids}
        for d in deliveries.get(str(b.id), []):
            for s in range(int(d.serial_from), int(d.serial_to) + 1):
                v = by_serial.get(s)
                if v is None or v.delivered_at is not None or v.delivered_free:
                    continue
                if d.chargeable:
                    v.delivered_at = _utc(d.delivered_at)
                else:
                    v.delivered_free = True
        repl_of: Dict[str, str] = {}
        orig_of: Dict[str, str] = {}
        for r in db.query(PrepaidVoucherReplacement).filter(PrepaidVoucherReplacement.batch_id == b.id):
            repl_of[str(r.original_voucher_id)] = str(r.replacement_voucher_id)
            orig_of[str(r.replacement_voucher_id)] = str(r.original_voucher_id)

        f = BatchFigures(batch=b)
        f.replacements = len(orig_of)
        f.issued = len(vs) - f.replacements
        f.delivered = sum(1 for v in vs.values() if v.delivered_at is not None and _in(v.delivered_at, start, end))
        f.delivered_free = sum(1 for v in vs.values() if v.delivered_free)
        f.redeemed = sum(1 for v in vs.values() if _in(v.first_redeemed, start, end))

        def chain(root: str) -> List[_V]:
            members, cur, seen = [], root, set()
            while cur is not None and cur not in seen and cur in vs:
                seen.add(cur)
                members.append(vs[cur])
                cur = repl_of.get(cur)
            return members

        roots = [vid for vid in vs if vid not in orig_of]
        for root in roots:
            members = chain(root)
            current = members[-1]
            redeemed_any = [m.first_redeemed for m in members if m.first_redeemed is not None]
            dead = current.status == "cancelled" and not redeemed_any
            if dead:
                f.cancelled += 1
            if not charge_replacements:
                # One voucher for the whole chain.
                if basis == "redemption":
                    when = min(redeemed_any) if redeemed_any else (current.cancelled_at if dead and charge_cancelled else None)
                    hit = _in(when, start, end)
                else:
                    delivered = [m.delivered_at for m in members if m.delivered_at is not None]
                    hit = bool(delivered) and _in(min(delivered), start, end) and (not dead or charge_cancelled)
                if hit:
                    f.chargeable += 1
                    f.chargeable_ids.append(root)
                    f.chargeable_serials.append(members[0].serial)
                    if dead:
                        f.cancelled_charged += 1
                continue
            # Every voucher of the chain on its own.
            for n, m in enumerate(members):
                is_repl = n > 0
                last = n == len(members) - 1
                m_dead = last and m.status == "cancelled" and m.first_redeemed is None
                if basis == "redemption":
                    when = m.first_redeemed or (m.cancelled_at if m_dead and charge_cancelled else None)
                    hit = _in(when, start, end)
                else:
                    when = m.created_at if is_repl else m.delivered_at
                    hit = _in(when, start, end) and (not m_dead or charge_cancelled)
                if hit:
                    f.chargeable += 1
                    f.chargeable_ids.append(m.id)
                    f.chargeable_serials.append(m.serial)
                    if is_repl:
                        f.replacements_charged += 1
                    if m_dead:
                        f.cancelled_charged += 1
        f.invoiced, f.invoiced_amount = invoiced.get(str(b.id), (0, 0))
        f.chargeable_serials.sort()
        f.prices = [price_at_issue(b, s) for s in f.chargeable_serials]
        out.append(f)

    # The redemptions' value at the till and the units — the analytics' own rows, the same period.
    scope = PVA.Scope(date_from=agreement.period_from, date_to=agreement.period_to)
    by_batch = {str(f.batch.id): f for f in out}
    for row in PVA.redemption_rows(db, list(batches), scope, zone):
        f = by_batch.get(row.batch_id)
        if f is not None:
            f.units += row.units
            f.till_value += int(row.value)
            f.redemptions += 1
    return out


def price_at_issue(batch: PrepaidVoucherBatch, serial: int) -> Optional[int]:
    """The production price (agorot) the voucher [serial] of [batch] was issued at — the core's history by
    serial when the price was edited after issue ("ערוך סדרה"), else the batch's."""
    try:
        from app.services.prepaid_voucher_edit import production_price_of
    except Exception:  # noqa: BLE001 — a core without price history: the batch's price
        return batch.production_price
    return production_price_of(batch, serial)


def _qty(d: Decimal):
    return int(d) if d == d.to_integral_value() else float(d)


def _batch_row(f: BatchFigures, prices: bool) -> Dict[str, Any]:
    b = f.batch
    # One price for every chargeable voucher, else null (`pricesMixed`): the amount is their sum, each at
    # the price it was issued at.
    price = f.uniform_price() if prices else None
    amount = f.amount() if prices else None
    left = f.chargeable - f.invoiced
    mixed = len({p for p in f.prices}) > 1
    return {
        "batchId": str(b.id),
        "batchName": b.name,
        "typeId": str(b.type_id) if getattr(b, "type_id", None) else None,
        "typeName": b.type_name,
        "eventName": b.event_name,
        "productionName": b.customer_name,
        "kind": b.kind or "items",
        "status": b.status,
        "issued": f.issued,
        "replacements": f.replacements,
        "delivered": f.delivered,
        "deliveredFree": f.delivered_free,
        "redeemed": f.redeemed,
        "cancelled": f.cancelled,
        "cancelledCharged": f.cancelled_charged,
        "replacementsCharged": f.replacements_charged,
        "chargeable": f.chargeable,
        "redemptions": f.redemptions,
        "units": _qty(f.units),
        "tillValueAgorot": f.till_value,
        "productionPriceAgorot": price,
        "amountAgorot": amount,
        "missingPrice": (any(p is None for p in f.prices) if f.prices else b.production_price is None),
        "pricesMixed": mixed if prices else None,
        "invoiced": f.invoiced,
        "invoicedAmountAgorot": f.invoiced_amount if prices else None,
        "uninvoiced": left,
        # First in, first out: the vouchers not yet invoiced are the later ones in serial order.
        "uninvoicedAmountAgorot": (f.amount(max(0, f.invoiced), max(0, left)) if prices else None),
        "overInvoiced": max(0, -left),
    }


def _sum(rows: Iterable[Dict[str, Any]], key: str) -> Optional[int]:
    total = 0
    for r in rows:
        v = r.get(key)
        if v is None:
            return None
        total += v
    return total


_SUMMED = (
    "issued", "replacements", "delivered", "deliveredFree", "redeemed", "cancelled", "cancelledCharged",
    "replacementsCharged", "chargeable", "redemptions", "tillValueAgorot", "amountAgorot", "invoiced",
    "invoicedAmountAgorot", "uninvoiced", "uninvoicedAmountAgorot", "overInvoiced",
)


def _totals(rows: Sequence[Dict[str, Any]], prices: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {k: _sum(rows, k) if rows else 0 for k in _SUMMED}
    out["units"] = _qty(sum((Decimal(str(r["units"])) for r in rows), Decimal(0)))
    if not prices:
        for k in ("amountAgorot", "invoicedAmountAgorot", "uninvoicedAmountAgorot"):
            out[k] = None
    return out


def _by_type(rows: Sequence[Dict[str, Any]], prices: bool) -> List[Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    names: Dict[str, Optional[str]] = {}
    for r in rows:
        key = r["typeId"] or f"batch:{r['batchId']}"
        groups[key].append(r)
        names.setdefault(key, r["typeName"] or r["batchName"])
    out = []
    for key, rs in groups.items():
        prices_seen = {r["productionPriceAgorot"] for r in rs}
        out.append({
            "typeId": None if key.startswith("batch:") else key,
            "typeName": names[key],
            "batches": len(rs),
            # One price when every batch of the type has the same; else null (see the batch rows).
            "productionPriceAgorot": next(iter(prices_seen)) if len(prices_seen) == 1 and prices else None,
            **_totals(rs, prices),
        })
    out.sort(key=lambda x: (x["typeName"] or ""))
    return out


def invoice_out(db: Session, inv: PrepaidSettlementInvoice, prices: bool, batch_names: Dict[str, str]) -> Dict[str, Any]:
    PV = _pv()
    lines = db.query(PrepaidSettlementInvoiceLine).filter(PrepaidSettlementInvoiceLine.invoice_id == inv.id).all()
    lines_amount = None
    if prices and all(ln.amount is not None for ln in lines):
        lines_amount = sum(int(ln.amount) for ln in lines)
    return {
        "id": str(inv.id),
        "agreementId": str(inv.agreement_id),
        "number": inv.number,
        "invoiceDate": inv.invoice_date.isoformat() if inv.invoice_date else None,
        "system": inv.system,
        "amountAgorot": int(inv.amount) if prices else None,
        "currency": inv.currency,
        "note": inv.note,
        "gapNote": inv.gap_note,
        "file": {"name": inv.file_name, "type": inv.file_type, "size": inv.file_size} if inv.file_name else None,
        "lines": [
            {
                "batchId": str(ln.batch_id),
                "batchName": batch_names.get(str(ln.batch_id)),
                "quantity": int(ln.quantity),
                "unitPriceAgorot": ln.unit_price if prices else None,
                "amountAgorot": ln.amount if prices else None,
            }
            for ln in lines
        ],
        "quantity": sum(int(ln.quantity) for ln in lines),
        "linesAmountAgorot": lines_amount,
        # The invoice's own amount against what its quantities come to (the gap).
        "gapAgorot": (int(inv.amount) - lines_amount) if (prices and lines_amount is not None) else None,
        "voided": inv.voided_at is not None,
        "voidedAt": PV._iso(inv.voided_at),
        "voidedBy": inv.voided_by_name,
        "voidReason": inv.void_reason,
        "createdAt": PV._iso(inv.created_at),
        "createdBy": inv.created_by_name,
    }


def _corrections(db: Session, agreement, figures: Sequence[BatchFigures], invoices: Sequence[PrepaidSettlementInvoice]) -> List[Dict[str, Any]]:
    """Invoiced beyond what is charged now, and vouchers cancelled after their batch was invoiced (§16)."""
    PV = _pv()
    out: List[Dict[str, Any]] = []
    first_invoiced: Dict[str, datetime] = {}
    live = [i for i in invoices if i.voided_at is None]
    if live:
        for ln, inv in (
            db.query(PrepaidSettlementInvoiceLine, PrepaidSettlementInvoice)
            .join(PrepaidSettlementInvoice, PrepaidSettlementInvoice.id == PrepaidSettlementInvoiceLine.invoice_id)
            .filter(PrepaidSettlementInvoice.id.in_([i.id for i in live]))
        ):
            at = _utc(inv.created_at)
            key = str(ln.batch_id)
            if at is not None and (key not in first_invoiced or at < first_invoiced[key]):
                first_invoiced[key] = at
    for f in figures:
        if f.invoiced > f.chargeable:
            out.append({"kind": "over_invoiced", "batchId": str(f.batch.id), "batchName": f.batch.name,
                        "quantity": f.invoiced - f.chargeable})
        since = first_invoiced.get(str(f.batch.id))
        if since is None:
            continue
        for v in db.query(PrepaidVoucher).filter(
            PrepaidVoucher.batch_id == f.batch.id, PrepaidVoucher.status == "cancelled",
            PrepaidVoucher.cancelled_at.isnot(None),
        ):
            if _utc(v.cancelled_at) and _utc(v.cancelled_at) > since:
                out.append({"kind": "cancelled_after_invoice", "batchId": str(f.batch.id), "batchName": f.batch.name,
                            "voucherId": str(v.id), "serial": int(v.serial), "cancelledAt": PV._iso(v.cancelled_at)})
    for inv in invoices:
        if inv.voided_at is not None:
            out.append({"kind": "invoice_voided", "invoiceId": str(inv.id), "number": inv.number,
                        "voidedAt": PV._iso(inv.voided_at), "reason": inv.void_reason})
    return out


def _cap_by_other_invoices(db: Session, a, batches, figures: Sequence[BatchFigures], rows: List[Dict[str, Any]]) -> None:
    """
    A batch another agreement already invoiced (a closed month, say): what this agreement may still invoice
    is also capped by what the batch was charged over all time less every live invoice of it — the very
    rule `add_invoice` enforces — so the balance shown is the balance the invoice form takes.
    """
    everywhere = invoiced_by_batch(db, a.tenant_id, [b.id for b in batches])
    elsewhere = {k: n - next((f.invoiced for f in figures if str(f.batch.id) == k), 0) for k, (n, _amt) in everywhere.items()}
    touched = [b for b in batches if elsewhere.get(str(b.id), 0) > 0]
    if not touched:
        return
    ever = {str(f.batch.id): f for f in batch_figures(db, _all_time(a), touched)}
    for r in rows:
        key = r["batchId"]
        if key not in ever:
            continue
        overall = ever[key].chargeable - everywhere.get(key, (0, 0))[0]
        left = min(r["uninvoiced"], max(0, overall))
        r["invoicedElsewhere"] = elsewhere[key]
        if left != r["uninvoiced"]:
            r["uninvoiced"] = left
            f = next(x for x in figures if str(x.batch.id) == key)
            if r["uninvoicedAmountAgorot"] is not None or r["productionPriceAgorot"] is not None:
                r["uninvoicedAmountAgorot"] = f.amount(len(f.prices) - left, left)


def agreement_out(db: Session, user: User, a: PrepaidSettlementAgreement, *, full: bool = True) -> Dict[str, Any]:
    PV = _pv()
    prices = ACC.prices_visible(db, user)
    batches = agreement_batches(db, a)
    figures = batch_figures(db, a, batches)
    rows = [_batch_row(f, prices) for f in figures]
    _cap_by_other_invoices(db, a, batches, figures, rows)
    totals = _totals(rows, prices)
    invoices = (
        db.query(PrepaidSettlementInvoice)
        .filter(PrepaidSettlementInvoice.agreement_id == a.id)
        .order_by(PrepaidSettlementInvoice.invoice_date, PrepaidSettlementInvoice.created_at)
        .all()
    )
    live = [i for i in invoices if i.voided_at is None]
    invoices_amount = sum(int(i.amount) for i in live) if prices else None
    report_amount = totals.get("amountAgorot")
    out: Dict[str, Any] = {
        "id": str(a.id),
        "name": a.name,
        "companyId": str(a.company_id),
        "productionName": a.production_name,
        "productionId": str(a.production_id) if a.production_id else None,
        "eventName": a.event_name,
        "reportEventId": str(a.report_event_id) if a.report_event_id else None,
        "batchIds": list(a.batch_ids) if a.batch_ids else None,
        "billingBasis": a.billing_basis,
        "periodFrom": a.period_from.isoformat() if a.period_from else None,
        "periodTo": a.period_to.isoformat() if a.period_to else None,
        "currency": a.currency,
        "cancelledPolicy": a.cancelled_policy,
        "replacementPolicy": a.replacement_policy,
        "status": a.status,
        "notes": a.notes,
        "gapNote": a.gap_note,
        "createdAt": PV._iso(a.created_at),
        "createdBy": a.created_by_name,
        "pricesVisible": prices,
        "editable": ACC.allows(db, user, ACC.SETTLEMENT_SECTION, "edit"),
        "rules": [
            BASIS_TEXT.get(a.billing_basis, ""), PACKAGE_TEXT,
            CANCELLED_TEXT.get(a.cancelled_policy, ""), REPLACEMENT_TEXT.get(a.replacement_policy, ""),
        ],
        "totals": {
            **totals,
            "invoicesAmountAgorot": invoices_amount,
            # The invoices against the report: + invoiced more than the report says.
            "gapAgorot": (invoices_amount - report_amount) if (invoices_amount is not None and report_amount is not None) else None,
            "invoices": len(live),
        },
    }
    if not full:
        return out
    names = {str(b.id): b.name for b in batches}
    missing = {
        str(ln.batch_id) for i in invoices for ln in db.query(PrepaidSettlementInvoiceLine.batch_id).filter(
            PrepaidSettlementInvoiceLine.invoice_id == i.id)
    } - set(names)
    if missing:
        names.update({str(i): n for i, n in db.query(PrepaidVoucherBatch.id, PrepaidVoucherBatch.name).filter(
            PrepaidVoucherBatch.id.in_([uuid.UUID(m) for m in missing]))})
    out.update({
        "batches": rows,
        "types": _by_type(rows, prices),
        "invoices": [invoice_out(db, i, prices, names) for i in invoices],
        "corrections": _corrections(db, a, figures, invoices),
        "warnings": [{"kind": "overlap", **o} for o in _overlaps(db, a, batches)]
        + [{"kind": "missing_price", "batchId": r["batchId"], "batchName": r["batchName"]} for r in rows if r["missingPrice"]],
    })
    return out


# ── Agreements ────────────────────────────────────────────────────────────────


def list_agreements(db: Session, user: User, tenant_id, *, company_id=None, status_filter: Optional[str] = None) -> Dict[str, Any]:
    _require(db, user, "view")
    PV = _pv()
    q = db.query(PrepaidSettlementAgreement).filter(PrepaidSettlementAgreement.tenant_id == tenant_id)
    if company_id:
        q = q.filter(PrepaidSettlementAgreement.company_id == (ACC.as_uuid(company_id) or uuid.uuid4()))
    if status_filter in AGREEMENT_STATUSES:
        q = q.filter(PrepaidSettlementAgreement.status == status_filter)
    rows = [a for a in q.order_by(PrepaidSettlementAgreement.created_at.desc()).all() if PV._covers_company(db, user, a.company_id)]
    return {
        "items": [agreement_out(db, user, a, full=False) for a in rows],
        "pricesVisible": ACC.prices_visible(db, user),
        "editable": ACC.allows(db, user, ACC.SETTLEMENT_SECTION, "edit"),
    }


def _state(a: PrepaidSettlementAgreement) -> Dict[str, Any]:
    return {
        "name": a.name, "productionName": a.production_name, "eventName": a.event_name,
        "reportEventId": str(a.report_event_id) if a.report_event_id else None,
        "batchIds": list(a.batch_ids) if a.batch_ids else None, "billingBasis": a.billing_basis,
        "periodFrom": a.period_from.isoformat() if a.period_from else None,
        "periodTo": a.period_to.isoformat() if a.period_to else None,
        "cancelledPolicy": a.cancelled_policy, "replacementPolicy": a.replacement_policy, "status": a.status,
        "notes": a.notes, "gapNote": a.gap_note,
    }


def _validate(db: Session, user: User, a: PrepaidSettlementAgreement) -> None:
    _choice(a.billing_basis, SETTLEMENT_BASES)
    _choice(a.cancelled_policy, CANCELLED_POLICIES)
    _choice(a.replacement_policy, REPLACEMENT_POLICIES)
    _choice(a.status, AGREEMENT_STATUSES)
    if a.currency != "ILS":
        raise ACC.http(status.HTTP_400_BAD_REQUEST, CURRENCY)
    if a.period_from and a.period_to and a.period_to < a.period_from:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, PERIOD)
    if not (a.batch_ids or (a.production_name or "").strip() or a.production_id or (a.event_name or "").strip()
            or a.report_event_id):
        raise ACC.http(status.HTTP_400_BAD_REQUEST, SCOPE_REQUIRED)
    if a.report_event_id is not None:
        # The core's own rule for a batch's event: the tenant's, of a shop of a related company the user sees.
        try:
            from app.services.prepaid_productions import event_for_batch
        except Exception:  # noqa: BLE001 — a core without productions: the tenant's event
            from app.models.report_event import ReportEvent

            if db.query(ReportEvent.id).filter(ReportEvent.id == a.report_event_id,
                                               ReportEvent.tenant_id == a.tenant_id).first() is None:
                raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_VALUE)
        else:
            try:
                event_for_batch(db, a.tenant_id, a.report_event_id, a.company_id, user)
            except Exception:
                raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_VALUE)
    if a.batch_ids:
        PV = _pv()
        clean = []
        for bid in a.batch_ids:
            b = PV.get_batch(db, user, a.tenant_id, bid)
            if str(b.company_id) != str(a.company_id):
                raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_VALUE)
            if str(b.id) not in clean:
                clean.append(str(b.id))
        a.batch_ids = clean
    if a.status == "active":
        clash = _overlaps(db, a, agreement_batches(db, a))
        if clash:
            raise ACC.http(status.HTTP_409_CONFLICT, f"{OVERLAP}:{clash[0]['agreementId']}")


def _settlement_lock(db: Session, tenant_id) -> None:
    """A transaction lock per tenant (Postgres) for agreement and invoice writes: two managers never both
    pass the overlap or duplicate-number check."""
    import hashlib

    from sqlalchemy import text

    try:
        if db.get_bind().dialect.name != "postgresql":
            return
    except Exception:  # noqa: BLE001
        return
    key = int.from_bytes(hashlib.sha256(f"pv-settlement:{tenant_id}".encode()).digest()[:8], "big", signed=True)
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


def _production_of(db: Session, tenant_id, company_id, production_id=None, name: Optional[str] = None):
    """The core's Production (`prepaid_productions`) an agreement names — by id, else by its name in the company."""
    try:
        from app.models.prepaid_voucher import PrepaidProduction
    except Exception:  # noqa: BLE001 — a core without productions
        return None
    q = db.query(PrepaidProduction).filter(PrepaidProduction.tenant_id == tenant_id,
                                           PrepaidProduction.company_id == company_id)
    if production_id is not None:
        return q.filter(PrepaidProduction.id == production_id).first()
    if (name or "").strip():
        return q.filter(PrepaidProduction.name == name.strip()).first()
    return None


def create_agreement(db: Session, user: User, tenant_id, body) -> PrepaidSettlementAgreement:
    _require(db, user, "edit")
    _settlement_lock(db, tenant_id)
    PV = _pv()
    if not PV._covers_company(db, user, body.company_id):
        raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
    production = _production_of(db, tenant_id, body.company_id, body.production_id, body.production_name)
    if body.production_id is not None and production is None:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_VALUE)
    basis = body.billing_basis or "redemption"
    if production is not None and "billing_basis" not in body.model_fields_set:
        # The production says how it is billed (the core's §13): the agreement starts from it.
        basis = production.billing_basis or "redemption"
    a = PrepaidSettlementAgreement(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=body.company_id, name=body.name.strip(),
        production_name=body.production_name or (production.name if production is not None else None),
        production_id=production.id if production is not None else None, event_name=body.event_name,
        report_event_id=body.report_event_id, batch_ids=[str(b) for b in body.batch_ids] if body.batch_ids else None,
        billing_basis=basis, period_from=body.period_from, period_to=body.period_to,
        currency=(body.currency or "ILS").upper(), cancelled_policy=body.cancelled_policy or "exclude",
        replacement_policy=body.replacement_policy or "free", status="active", notes=body.notes,
        created_by=user.id, created_by_name=ACC.user_name(user),
    )
    _validate(db, user, a)
    db.add(a)
    db.flush()
    ACC.audit(db, tenant_id, "agreement_create", user, ref_id=a.id, details={"after": _state(a)})
    db.flush()
    return a


def update_agreement(db: Session, user: User, tenant_id, agreement_id, body) -> PrepaidSettlementAgreement:
    _require(db, user, "edit")
    _settlement_lock(db, tenant_id)
    a = get_agreement(db, user, tenant_id, agreement_id, lock=True)
    before = _state(a)
    fields = body.model_fields_set
    terms = {"production_name", "event_name", "report_event_id", "batch_ids", "billing_basis", "period_from",
             "period_to", "cancelled_policy", "replacement_policy"}
    if fields & terms and db.query(PrepaidSettlementInvoice.id).filter(
        PrepaidSettlementInvoice.agreement_id == a.id, PrepaidSettlementInvoice.voided_at.is_(None)
    ).first():
        changed = {
            f for f in fields & terms
            if (getattr(body, f) if f != "batch_ids" else ([str(b) for b in body.batch_ids] if body.batch_ids else None))
            != (getattr(a, f) if f != "batch_ids" else (list(a.batch_ids) if a.batch_ids else None))
        }
        if changed:
            raise ACC.http(status.HTTP_409_CONFLICT, HAS_INVOICES)
    simple = {
        "name": "name", "production_name": "production_name", "event_name": "event_name",
        "report_event_id": "report_event_id", "billing_basis": "billing_basis", "period_from": "period_from",
        "period_to": "period_to", "cancelled_policy": "cancelled_policy", "replacement_policy": "replacement_policy",
        "status": "status", "notes": "notes", "gap_note": "gap_note",
    }
    for src, dst in simple.items():
        if src in fields:
            value = getattr(body, src)
            if isinstance(value, str):
                value = value.strip() or None
            if dst in ("name", "billing_basis", "cancelled_policy", "replacement_policy", "status") and value is None:
                raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_VALUE)
            setattr(a, dst, value)
    if "batch_ids" in fields:
        a.batch_ids = [str(b) for b in body.batch_ids] if body.batch_ids else None
    _validate(db, user, a)
    after = _state(a)
    if after != before:
        a.updated_at = _now()
        ACC.audit(db, tenant_id, "agreement_update", user, ref_id=a.id, details={"before": before, "after": after})
    db.flush()
    return a


def candidates(db: Session, user: User, tenant_id, *, company_id, production_name=None, production_id=None,
               event_name=None, report_event_id=None, batch_ids=None) -> Dict[str, Any]:
    """The batches an agreement with these terms would cover — the form's preview."""
    _require(db, user, "view")
    PV = _pv()
    cid = ACC.as_uuid(company_id)
    if cid is None or not PV._covers_company(db, user, cid):
        raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
    ev_name = (event_name or "").strip() or None
    rid = ACC.as_uuid(report_event_id)
    if ev_name is None and rid is not None:
        from app.models.report_event import ReportEvent

        ev_name = db.query(ReportEvent.name).filter(ReportEvent.id == rid, ReportEvent.tenant_id == tenant_id).scalar()
    production = _production_of(db, tenant_id, cid, ACC.as_uuid(production_id), production_name)
    batches = matching_batches(
        db, tenant_id, cid,
        production_name=(production_name or "").strip() or (production.name if production is not None else None),
        production_id=production.id if production is not None else None,
        event_name=ev_name, report_event_id=rid, batch_ids=batch_ids,
    )
    prices = ACC.prices_visible(db, user)
    stats = PV._stats(db, [b.id for b in batches]) if batches else {}
    return {"items": [
        {"batchId": str(b.id), "name": b.name, "typeName": b.type_name, "eventName": b.event_name,
         "productionName": b.customer_name, "status": b.status,
         "issued": int((stats.get(str(b.id)) or {}).get("total", 0)),
         "productionPriceAgorot": b.production_price if prices else None}
        for b in batches
    ]}


# ── Invoices ──────────────────────────────────────────────────────────────────


class _AllTime:
    """An agreement's terms with no period and no id — what its batches are charged over all time."""

    def __init__(self, a: PrepaidSettlementAgreement):
        self.tenant_id, self.id = a.tenant_id, None
        self.billing_basis, self.cancelled_policy, self.replacement_policy = (
            a.billing_basis, a.cancelled_policy, a.replacement_policy)
        self.period_from = self.period_to = None


def _all_time(a: PrepaidSettlementAgreement) -> "_AllTime":
    return _AllTime(a)


def add_invoice(db: Session, user: User, tenant_id, agreement_id, body) -> PrepaidSettlementInvoice:
    """
    Link an external invoice. Under the agreement's lock: each line's vouchers of a batch never more
    than are charged and not yet on a (non-voided) invoice — `prepaid_settlement_over_invoiced:<batch>:<left>`.
    """
    _require(db, user, "edit")
    if not ACC.prices_visible(db, user):
        raise ACC.http(status.HTTP_403_FORBIDDEN, PRICES_REQUIRED)
    _settlement_lock(db, tenant_id)
    a = get_agreement(db, user, tenant_id, agreement_id, lock=True)
    if a.status != "active":
        raise ACC.http(status.HTTP_409_CONFLICT, CLOSED)
    if (body.currency or "ILS").upper() != "ILS":
        raise ACC.http(status.HTTP_400_BAD_REQUEST, CURRENCY)
    number = body.number.strip()
    system = (body.system or "").strip() or None
    for other in db.query(PrepaidSettlementInvoice).filter(
        PrepaidSettlementInvoice.tenant_id == tenant_id, PrepaidSettlementInvoice.voided_at.is_(None),
        PrepaidSettlementInvoice.number == number,
    ):
        if (other.system or None) == system:
            raise ACC.http(status.HTTP_409_CONFLICT, DUPLICATE_INVOICE)
    batches = {str(b.id): b for b in agreement_batches(db, a)}
    wanted: Dict[str, int] = {}
    for line in body.lines:
        key = str(line.batch_id)
        if key not in batches:
            raise ACC.http(status.HTTP_400_BAD_REQUEST, f"{BATCH_NOT_IN_AGREEMENT}:{key}")
        wanted[key] = wanted.get(key, 0) + int(line.quantity)
    if wanted:
        # Each batch's row too, in a fixed order: another agreement's invoice never races this one.
        db.query(PrepaidVoucherBatch.id).filter(
            PrepaidVoucherBatch.id.in_(sorted(batches[k].id for k in wanted))
        ).order_by(PrepaidVoucherBatch.id).with_for_update().all()
        chosen = [batches[k] for k in wanted]
        figures = {str(f.batch.id): f for f in batch_figures(db, a, chosen)}
        # The same vouchers never twice, whatever agreement (and period) invoiced them: what is charged
        # over all time, less every live invoice of the tenant for the batch.
        ever = {str(f.batch.id): f for f in batch_figures(db, _all_time(a), chosen)}
        everywhere = invoiced_by_batch(db, tenant_id, [b.id for b in chosen])
        for key, q in wanted.items():
            here = figures[key].chargeable - figures[key].invoiced
            overall = ever[key].chargeable - everywhere.get(key, (0, 0))[0]
            left = min(here, overall)
            if q > left:
                raise ACC.http(status.HTTP_409_CONFLICT, f"{OVER_INVOICED}:{key}:{max(0, left)}")
    inv = PrepaidSettlementInvoice(
        id=uuid.uuid4(), tenant_id=tenant_id, agreement_id=a.id, number=number, invoice_date=body.invoice_date,
        system=system, amount=_agorot(body.amount), currency="ILS", note=(body.note or "").strip() or None,
        gap_note=(body.gap_note or "").strip() or None, created_by=user.id, created_by_name=ACC.user_name(user),
    )
    db.add(inv)
    db.flush()
    for key, q in wanted.items():
        f = figures[key]
        # The next q chargeable vouchers of the batch (serial order), each at the price it was issued at.
        db.add(PrepaidSettlementInvoiceLine(
            id=uuid.uuid4(), invoice_id=inv.id, batch_id=batches[key].id, quantity=q,
            unit_price=f.uniform_price(f.invoiced, q), amount=f.amount(f.invoiced, q),
        ))
    ACC.audit(db, tenant_id, "invoice_add", user, ref_id=inv.id, details={
        "agreementId": str(a.id), "number": number, "system": system, "amountAgorot": inv.amount,
        "invoiceDate": body.invoice_date.isoformat(), "lines": [{"batchId": k, "quantity": q} for k, q in wanted.items()],
    })
    db.flush()
    return inv


def _invoice(db: Session, user: User, tenant_id, invoice_id) -> PrepaidSettlementInvoice:
    inv = db.query(PrepaidSettlementInvoice).filter(
        PrepaidSettlementInvoice.id == (ACC.as_uuid(invoice_id) or uuid.uuid4()),
        PrepaidSettlementInvoice.tenant_id == tenant_id,
    ).first()
    if inv is None:
        raise ACC.http(status.HTTP_404_NOT_FOUND, INVOICE_NOT_FOUND)
    get_agreement(db, user, tenant_id, inv.agreement_id)  # the user's company, else 404
    return inv


def update_invoice(db: Session, user: User, tenant_id, invoice_id, body) -> PrepaidSettlementInvoice:
    """Only the notes — an invoice's number, amount and quantities are voided and linked again, never edited."""
    _require(db, user, "edit")
    inv = _invoice(db, user, tenant_id, invoice_id)
    before = {"note": inv.note, "gapNote": inv.gap_note}
    fields = body.model_fields_set
    if "note" in fields:
        inv.note = (body.note or "").strip() or None
    if "gap_note" in fields:
        inv.gap_note = (body.gap_note or "").strip() or None
    after = {"note": inv.note, "gapNote": inv.gap_note}
    if after != before:
        ACC.audit(db, tenant_id, "invoice_update", user, ref_id=inv.id, details={"before": before, "after": after})
    db.flush()
    return inv


def void_invoice(db: Session, user: User, tenant_id, invoice_id, reason: Optional[str]) -> PrepaidSettlementInvoice:
    _require(db, user, "edit")
    reason = (reason or "").strip()
    if not reason:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, REASON_REQUIRED)
    inv = _invoice(db, user, tenant_id, invoice_id)
    if inv.voided_at is not None:
        return inv
    inv.voided_at = _now()
    inv.voided_by_name = ACC.user_name(user)
    inv.void_reason = reason
    ACC.audit(db, tenant_id, "invoice_void", user, ref_id=inv.id, reason=reason,
              details={"number": inv.number, "agreementId": str(inv.agreement_id)})
    db.flush()
    return inv


def put_invoice_file(db: Session, user: User, tenant_id, invoice_id, name: str, content_type: str, data: bytes) -> PrepaidSettlementInvoice:
    _require(db, user, "edit")
    inv = _invoice(db, user, tenant_id, invoice_id)
    if inv.voided_at is not None:
        raise ACC.http(status.HTTP_409_CONFLICT, INVOICE_VOIDED)
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype not in FILE_TYPES:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, FILE_TYPE)
    if not data:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, NO_FILE)
    if len(data) > FILE_MAX:
        raise ACC.http(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, FILE_TOO_BIG)
    row = db.get(PrepaidSettlementInvoiceFile, inv.id)
    if row is None:
        db.add(PrepaidSettlementInvoiceFile(invoice_id=inv.id, data=data))
    else:
        row.data = data
    before = {"name": inv.file_name, "size": inv.file_size}
    inv.file_name = (name or "invoice")[:255]
    inv.file_type = ctype
    inv.file_size = len(data)
    ACC.audit(db, tenant_id, "invoice_file", user, ref_id=inv.id,
              details={"before": before, "after": {"name": inv.file_name, "size": inv.file_size}})
    db.flush()
    return inv


def invoice_file(db: Session, user: User, tenant_id, invoice_id) -> Tuple[PrepaidSettlementInvoice, bytes]:
    _require(db, user, "view")
    inv = _invoice(db, user, tenant_id, invoice_id)
    row = db.get(PrepaidSettlementInvoiceFile, inv.id)
    if row is None:
        raise ACC.http(status.HTTP_404_NOT_FOUND, NO_FILE)
    return inv, bytes(row.data)


# ── Deliveries ("מסירה להפקה") ────────────────────────────────────────────────


def delivery_out(d: PrepaidVoucherDelivery) -> Dict[str, Any]:
    PV = _pv()
    return {
        "id": str(d.id),
        "batchId": str(d.batch_id),
        "serialFrom": int(d.serial_from),
        "serialTo": int(d.serial_to),
        "count": int(d.count),
        "chargeable": bool(d.chargeable),
        "deliveredAt": PV._iso(d.delivered_at),
        "recipient": d.recipient,
        "note": d.note,
        "userName": d.user_name,
        "createdAt": PV._iso(d.created_at),
        "voided": d.voided_at is not None,
        "voidedAt": PV._iso(d.voided_at),
        "voidedBy": d.voided_by_name,
        "voidReason": d.void_reason,
    }


def _free_ranges(last: int, taken: Sequence[Tuple[int, int]]) -> List[Dict[str, int]]:
    out, cur = [], 1
    for a, b in sorted(taken):
        if a > cur:
            out.append({"from": cur, "to": a - 1})
        cur = max(cur, b + 1)
    if cur <= last:
        out.append({"from": cur, "to": last})
    return out


def _replacement_serials(db: Session, batch_id) -> Set[int]:
    return {
        int(s) for (s,) in db.query(PrepaidVoucher.serial).join(
            PrepaidVoucherReplacement, PrepaidVoucherReplacement.replacement_voucher_id == PrepaidVoucher.id
        ).filter(PrepaidVoucherReplacement.batch_id == batch_id)
    }


def list_deliveries(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    PV = _pv()
    _require(db, user, "view")
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    rows = (
        db.query(PrepaidVoucherDelivery)
        .filter(PrepaidVoucherDelivery.batch_id == batch.id)
        .order_by(PrepaidVoucherDelivery.serial_from, PrepaidVoucherDelivery.created_at)
        .all()
    )
    live = [d for d in rows if d.voided_at is None]
    last = int(batch.next_serial or 1) - 1
    replacement_serials = _replacement_serials(db, batch.id)
    return {
        "batchId": str(batch.id),
        "lastSerial": last,
        "delivered": sum(int(d.count) for d in live if d.chargeable),
        "deliveredFree": sum(int(d.count) for d in live if not d.chargeable),
        "undelivered": _free_ranges(last, [(int(d.serial_from), int(d.serial_to)) for d in live]
                                    + [(s, s) for s in replacement_serials]),
        # Replacements are handed over when issued; they are never part of a delivery.
        "replacementSerials": sorted(replacement_serials),
        "items": [delivery_out(d) for d in rows],
    }


def add_delivery(db: Session, user: User, tenant_id, batch_id, body) -> PrepaidVoucherDelivery:
    PV = _pv()
    _require(db, user, "edit")
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == batch.id).with_for_update().first()
    last = int(batch.next_serial or 1) - 1
    lo, hi = int(body.serial_from), int(body.serial_to)
    if lo < 1 or hi < lo or hi > last:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, DELIVERY_RANGE)
    for d in db.query(PrepaidVoucherDelivery).filter(
        PrepaidVoucherDelivery.batch_id == batch.id, PrepaidVoucherDelivery.voided_at.is_(None)
    ):
        if not (hi < int(d.serial_from) or lo > int(d.serial_to)):
            raise ACC.http(status.HTTP_409_CONFLICT, f"{DELIVERY_OVERLAP}:{int(d.serial_from)}-{int(d.serial_to)}")
    now = _now()
    when = _utc(body.delivered_at) or now
    if when > now + timedelta(minutes=10):
        raise ACC.http(status.HTTP_400_BAD_REQUEST, DELIVERY_FUTURE)
    # Replacements are handed over when issued: never part of a delivery's count.
    repl = _replacement_serials(db, batch.id)
    count = sum(
        1 for (s,) in db.query(PrepaidVoucher.serial).filter(
            PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.serial >= lo, PrepaidVoucher.serial <= hi
        ) if int(s) not in repl
    )
    d = PrepaidVoucherDelivery(
        id=uuid.uuid4(), tenant_id=batch.tenant_id, batch_id=batch.id, serial_from=lo, serial_to=hi, count=int(count),
        chargeable=bool(body.chargeable), delivered_at=when, recipient=(body.recipient or "").strip() or None,
        note=(body.note or "").strip() or None, user_id=user.id, user_name=ACC.user_name(user), created_at=now,
    )
    db.add(d)
    PV._event(db, batch, user, "deliver", count=int(count), reason=d.note,
              details={"serialFrom": lo, "serialTo": hi, "chargeable": d.chargeable, "recipient": d.recipient,
                       "deliveredAt": PV._iso(when)})
    ACC.audit(db, tenant_id, "delivery_add", user, ref_id=d.id, batch_id=batch.id,
              details={"serialFrom": lo, "serialTo": hi, "count": int(count), "chargeable": d.chargeable})
    db.flush()
    return d


def void_delivery(db: Session, user: User, tenant_id, delivery_id, reason: Optional[str]) -> PrepaidVoucherDelivery:
    PV = _pv()
    _require(db, user, "edit")
    reason = (reason or "").strip()
    if not reason:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, REASON_REQUIRED)
    d = db.query(PrepaidVoucherDelivery).filter(
        PrepaidVoucherDelivery.id == (ACC.as_uuid(delivery_id) or uuid.uuid4()),
        PrepaidVoucherDelivery.tenant_id == tenant_id,
    ).first()
    if d is None:
        raise ACC.http(status.HTTP_404_NOT_FOUND, DELIVERY_NOT_FOUND)
    batch = PV.get_batch(db, user, tenant_id, d.batch_id)
    if d.voided_at is None:
        d.voided_at = _now()
        d.voided_by_name = ACC.user_name(user)
        d.void_reason = reason
        PV._event(db, batch, user, "deliver_void", count=int(d.count), reason=reason,
                  details={"serialFrom": int(d.serial_from), "serialTo": int(d.serial_to)})
        ACC.audit(db, tenant_id, "delivery_void", user, ref_id=d.id, batch_id=batch.id, reason=reason,
                  details={"serialFrom": int(d.serial_from), "serialTo": int(d.serial_to)})
        db.flush()
    return d
