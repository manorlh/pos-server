"""
Prepaid voucher ("שוברי הפקה") filters, search and the till report: one filter model for every
voucher view — the batch list, "כל השוברים", the voucher table inside a batch and "מימושים לפי
קופה" (the overview and the comparisons will read it too).

**The filter model** (`Scope`, the same query parameters on every endpoint, and the dashboard
keeps them in the URL):

* the batch — for whom (`customer`: the production; until the Production entity, the batch's
  customer), `event`, voucher type (`typeId`) or kind (`kind`: goods / discount), `batchId`,
  `shopId`, `companyId`, `accounting` (`discount` / `payment` / `zero`), `pricing` (`fixed` /
  `cover`), `override` (a policy other than honour, yes / no), `offline` (offline redemption
  allowed, yes / no), the voucher value range (`valueMin` / `valueMax`, ₪), the production
  price range (`priceMin` / `priceMax`, ₪ — only for whoever may see prices; ignored for
  anyone else), `createdBy`, the issue dates (`issuedFrom` / `issuedTo`), `validOn` (a day the
  batch is valid on) and `batchStatus` (`active` / `not_started` / `expired` / `cancelled` /
  `fully_redeemed` / `has_open`);
* the redemption — the days (`from` / `to`, the tenant's days), the till (`machineId`), the
  employee (`employee`: the till user's id, or their name when the till sent none);
* the voucher — its state (`state`: `open` / `partial` / `redeemed` / `cancelled` /
  `expired`), its group (`group`) and `q` (a service number or the code, or part of it).

On a list of batches or vouchers a redemption filter means "has a redemption that matches"
(the batch list's "מומש בקופה X"); on a report it selects the redemptions themselves.

**Money.** A redemption's value: a discount voucher — what it took off; goods — the voucher's
fixed value pro rata to the units taken (`pricing` fixed), else the goods at their list prices
(`valueBasis`). Each is filed under its batch's `redemption_accounting` — a deduction
("קיזוז"), a payment ("שווי באמצעי תשלום") or memo value ("שווי ₪0") — never as a discount. Top-ups,
overrides, refusals and offline redemptions are not recorded yet (reserve → confirm, the
override audit and offline sync come later): those figures are `None`, never a made-up 0.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import status
from sqlalchemy import exists, func, or_
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherRedemption,
    PrepaidVoucherType,
)
from app.models.product import Product
from app.models.shop import Shop
from app.models.user import User
from app.services import prepaid_vouchers as PV

STATES = ("open", "partial", "redeemed", "cancelled", "expired")
BATCH_STATUSES = ("active", "not_started", "expired", "cancelled", "fully_redeemed", "has_open")
SORTS = ("newest", "customer", "event", "redeemed")
ACCOUNTING = ("discount", "payment", "zero")
PRICINGS = ("fixed", "cover")
BUCKETS = ("hour", "day")
SEARCH_LIMIT = 10
#: Rows a voucher / redemption page holds at most.
PAGE_MAX = 5000

BAD_FILTER = "prepaid_voucher_bad_filter"
NO_UNIT_PRICE = Decimal(0)


# ── The filter model ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Scope:
    customers: Tuple[str, ...] = ()
    events: Tuple[str, ...] = ()
    type_ids: Tuple[str, ...] = ()
    kind: Optional[str] = None
    batch_ids: Tuple[str, ...] = ()
    shop_ids: Tuple[str, ...] = ()
    company_id: Optional[str] = None
    accounting: Optional[str] = None
    pricing: Optional[str] = None
    override: Optional[bool] = None
    offline: Optional[bool] = None
    value_min: Optional[Decimal] = None
    value_max: Optional[Decimal] = None
    price_min: Optional[Decimal] = None
    price_max: Optional[Decimal] = None
    created_by: Optional[str] = None
    issued_from: Optional[date] = None
    issued_to: Optional[date] = None
    valid_on: Optional[date] = None
    batch_status: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    machine_ids: Tuple[str, ...] = ()
    employees: Tuple[str, ...] = ()
    state: Optional[str] = None
    group: Optional[int] = None
    q: Optional[str] = None

    @property
    def has_redemption_filter(self) -> bool:
        return bool(self.date_from or self.date_to or self.machine_ids or self.employees)


def _clean(values: Optional[Iterable[str]]) -> Tuple[str, ...]:
    out: List[str] = []
    for v in values or ():
        for part in str(v).split(","):
            part = part.strip()
            if part and part not in out:
                out.append(part)
    return tuple(out[:50])


def _choice(value: Optional[str], allowed: Sequence[str], name: str) -> Optional[str]:
    if value is None or value == "" or value == "all":
        return None
    if value not in allowed:
        raise PV._http(status.HTTP_400_BAD_REQUEST, f"{BAD_FILTER}:{name}")
    return value


def _yes_no(value: Optional[str], name: str) -> Optional[bool]:
    if value is None or value == "" or value == "all":
        return None
    if value in ("yes", "true", "1"):
        return True
    if value in ("no", "false", "0"):
        return False
    raise PV._http(status.HTTP_400_BAD_REQUEST, f"{BAD_FILTER}:{name}")


def _money(value: Optional[str], name: str) -> Optional[Decimal]:
    if value is None or str(value).strip() == "":
        return None
    try:
        d = Decimal(str(value).replace(",", ".").strip())
    except Exception:  # noqa: BLE001 — anything unreadable is the caller's mistake
        raise PV._http(status.HTTP_400_BAD_REQUEST, f"{BAD_FILTER}:{name}")
    if d < 0:
        raise PV._http(status.HTTP_400_BAD_REQUEST, f"{BAD_FILTER}:{name}")
    return d


def _day(value: Optional[str], name: str) -> Optional[date]:
    if value is None or str(value).strip() == "":
        return None
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        raise PV._http(status.HTTP_400_BAD_REQUEST, f"{BAD_FILTER}:{name}")


def make_scope(
    *,
    customer: Optional[Iterable[str]] = None,
    event: Optional[Iterable[str]] = None,
    type_id: Optional[Iterable[str]] = None,
    kind: Optional[str] = None,
    batch_id: Optional[Iterable[str]] = None,
    shop_id: Optional[Iterable[str]] = None,
    company_id: Optional[str] = None,
    accounting: Optional[str] = None,
    pricing: Optional[str] = None,
    override: Optional[str] = None,
    offline: Optional[str] = None,
    value_min: Optional[str] = None,
    value_max: Optional[str] = None,
    price_min: Optional[str] = None,
    price_max: Optional[str] = None,
    created_by: Optional[str] = None,
    issued_from: Optional[str] = None,
    issued_to: Optional[str] = None,
    valid_on: Optional[str] = None,
    batch_status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    machine_id: Optional[Iterable[str]] = None,
    employee: Optional[Iterable[str]] = None,
    state: Optional[str] = None,
    group: Optional[int] = None,
    q: Optional[str] = None,
) -> Scope:
    """The query parameters, checked: an unknown choice is a 400 `prepaid_voucher_bad_filter:<name>`."""
    scope = Scope(
        customers=_clean(customer),
        events=_clean(event),
        type_ids=_clean(type_id),
        kind=_choice(kind, ("items", "discount", "order_discount", "item_discount"), "kind"),
        batch_ids=_clean(batch_id),
        shop_ids=_clean(shop_id),
        company_id=(company_id or "").strip() or None,
        accounting=_choice(accounting, ACCOUNTING, "accounting"),
        pricing=_choice(pricing, PRICINGS, "pricing"),
        override=_yes_no(override, "override"),
        offline=_yes_no(offline, "offline"),
        value_min=_money(value_min, "valueMin"),
        value_max=_money(value_max, "valueMax"),
        price_min=_money(price_min, "priceMin"),
        price_max=_money(price_max, "priceMax"),
        created_by=(created_by or "").strip() or None,
        issued_from=_day(issued_from, "issuedFrom"),
        issued_to=_day(issued_to, "issuedTo"),
        valid_on=_day(valid_on, "validOn"),
        batch_status=_choice(batch_status, BATCH_STATUSES, "batchStatus"),
        date_from=_day(date_from, "from"),
        date_to=_day(date_to, "to"),
        machine_ids=_clean(machine_id),
        employees=_clean(employee),
        state=_choice(state, STATES, "state"),
        group=group if group and group > 0 else None,
        q=(q or "").strip() or None,
    )
    for lo, hi, name in (
        (scope.issued_from, scope.issued_to, "issuedTo"),
        (scope.date_from, scope.date_to, "to"),
        (scope.value_min, scope.value_max, "valueMax"),
        (scope.price_min, scope.price_max, "priceMax"),
    ):
        if lo is not None and hi is not None and hi < lo:
            raise PV._http(status.HTTP_400_BAD_REQUEST, f"{BAD_FILTER}:{name}")
    return scope


# ── Time ──────────────────────────────────────────────────────────────────────


def zone_of(db: Session, tenant_id):
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    return _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))


def day_start(day: date, zone) -> datetime:
    """The tenant's local midnight of [day], in UTC."""
    return datetime.combine(day, time(0, 0), tzinfo=zone).astimezone(timezone.utc)


def _range(scope_from: Optional[date], scope_to: Optional[date], zone) -> Tuple[Optional[datetime], Optional[datetime]]:
    """[from, to] local days → [start, end) instants."""
    start = day_start(scope_from, zone) if scope_from else None
    end = day_start(scope_to + timedelta(days=1), zone) if scope_to else None
    return start, end


def _local(moment: Optional[datetime], zone) -> Optional[datetime]:
    m = PV._utc(moment)
    return m.astimezone(zone) if m else None


# ── Batches in scope ──────────────────────────────────────────────────────────


def _agorot(value: Optional[Decimal]) -> Optional[int]:
    return None if value is None else int((value * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def batch_state(batch: PrepaidVoucherBatch, stats: Dict[str, int], now: datetime) -> Dict[str, bool]:
    """Every batch status the list filters by, at once (a batch may be both expired and fully redeemed)."""
    cancelled = batch.status == "cancelled"
    start = PV._utc(batch.valid_from)
    end = PV._utc(batch.valid_until)
    not_started = not cancelled and start is not None and now < start
    expired = not cancelled and end is not None and now > end
    live = stats.get("total", 0) - stats.get("cancelled", 0)
    open_ = stats.get("active", 0) + stats.get("partiallyUsed", 0)
    return {
        "cancelled": cancelled,
        "not_started": not_started,
        "expired": expired,
        "active": not cancelled and not not_started and not expired,
        "fully_redeemed": live > 0 and stats.get("used", 0) >= live,
        "has_open": not cancelled and not expired and open_ > 0,
    }


def _shop_company(db: Session, shop_ids: Sequence[str]) -> Dict[str, str]:
    ids = [PV._as_uuid(s) for s in shop_ids]
    ids = [i for i in ids if i is not None]
    if not ids:
        return {}
    return {str(i): str(c) for i, c in db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(ids))}


def _covers_shop(db: Session, batch: PrepaidVoucherBatch, shop_id: str, shop_company: Dict[str, str], groups: Dict[str, set]) -> bool:
    """A batch for named shops names it; a company-wide one covers every shop of its company group."""
    if batch.shop_ids:
        return shop_id in {str(s) for s in batch.shop_ids}
    company = shop_company.get(shop_id)
    if company is None:
        return False
    key = str(batch.company_id)
    if key not in groups:
        groups[key] = PV._company_group(db, batch.company_id)
    return company in groups[key]


def scoped_batches(
    db: Session,
    user: User,
    tenant_id,
    scope: Scope,
    *,
    now: Optional[datetime] = None,
    zone=None,
    by_redemption: bool = True,
) -> List[PrepaidVoucherBatch]:
    """
    The batches [user] manages that [scope]'s batch filters keep. With [by_redemption] a
    redemption filter keeps a batch only when one of its redemptions matches it (the lists);
    the reports pass False and filter the redemptions instead.
    """
    from app.services import prepaid_voucher_types as PVT

    PV._require_role(user)
    now = now or PV._now()
    zone = zone or zone_of(db, tenant_id)
    q = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == tenant_id)
    # For whom / the event: a production's or a report event's id (§13), or the legacy text.
    if scope.customers:
        ids = [i for i in (PV._as_uuid(c) for c in scope.customers) if i is not None]
        cond = PrepaidVoucherBatch.customer_name.in_(scope.customers)
        q = q.filter(or_(cond, PrepaidVoucherBatch.production_id.in_(ids)) if ids else cond)
    if scope.events:
        ids = [i for i in (PV._as_uuid(e) for e in scope.events) if i is not None]
        cond = PrepaidVoucherBatch.event_name.in_(scope.events)
        q = q.filter(or_(cond, PrepaidVoucherBatch.report_event_id.in_(ids)) if ids else cond)
    if scope.type_ids:
        ids = [PV._as_uuid(t) for t in scope.type_ids]
        q = q.filter(PrepaidVoucherBatch.type_id.in_([i for i in ids if i is not None] or [uuid.uuid4()]))
    if scope.kind == "items":
        q = q.filter(PrepaidVoucherBatch.kind == "items")
    elif scope.kind == "discount":
        q = q.filter(PrepaidVoucherBatch.kind != "items")
    elif scope.kind:
        q = q.filter(PrepaidVoucherBatch.kind == scope.kind)
    if scope.batch_ids:
        ids = [PV._as_uuid(b) for b in scope.batch_ids]
        q = q.filter(PrepaidVoucherBatch.id.in_([i for i in ids if i is not None] or [uuid.uuid4()]))
    if scope.company_id:
        q = q.filter(PrepaidVoucherBatch.company_id == PV._as_uuid(scope.company_id))
    if scope.accounting:
        q = q.filter(PrepaidVoucherBatch.redemption_accounting == scope.accounting)
    if scope.pricing:
        q = q.filter(PrepaidVoucherBatch.pricing == scope.pricing)
    if scope.override is True:
        q = q.filter(PrepaidVoucherBatch.discount_block_policy != "honour")
    elif scope.override is False:
        q = q.filter(PrepaidVoucherBatch.discount_block_policy == "honour")
    if scope.offline is not None:
        q = q.filter(PrepaidVoucherBatch.offline_allowed.is_(scope.offline))
    if scope.value_min is not None:
        q = q.filter(PrepaidVoucherBatch.till_value >= _agorot(scope.value_min))
    if scope.value_max is not None:
        q = q.filter(PrepaidVoucherBatch.till_value <= _agorot(scope.value_max))
    if (scope.price_min is not None or scope.price_max is not None) and PVT.prices_visible(db, user):
        if scope.price_min is not None:
            q = q.filter(PrepaidVoucherBatch.production_price >= _agorot(scope.price_min))
        if scope.price_max is not None:
            q = q.filter(PrepaidVoucherBatch.production_price <= _agorot(scope.price_max))
    if scope.created_by:
        q = q.filter(PrepaidVoucherBatch.created_by == PV._as_uuid(scope.created_by))
    start, end = _range(scope.issued_from, scope.issued_to, zone)
    if start is not None:
        q = q.filter(PrepaidVoucherBatch.created_at >= start)
    if end is not None:
        q = q.filter(PrepaidVoucherBatch.created_at < end)
    if scope.valid_on is not None:
        a, b = _range(scope.valid_on, scope.valid_on, zone)
        q = q.filter(or_(PrepaidVoucherBatch.valid_from.is_(None), PrepaidVoucherBatch.valid_from < b))
        q = q.filter(or_(PrepaidVoucherBatch.valid_until.is_(None), PrepaidVoucherBatch.valid_until >= a))
    batches = [b for b in q.order_by(PrepaidVoucherBatch.created_at.desc()).all() if PV.may_manage(db, user, tenant_id, b)]
    if scope.shop_ids:
        shop_company = _shop_company(db, scope.shop_ids)
        groups: Dict[str, set] = {}
        batches = [b for b in batches if any(_covers_shop(db, b, s, shop_company, groups) for s in scope.shop_ids)]
    if scope.batch_status and batches:
        stats = PV._stats(db, [b.id for b in batches])
        batches = [
            b for b in batches
            if batch_state(b, stats.get(str(b.id)) or PV._empty_counts(), now)[scope.batch_status]
        ]
    if by_redemption and scope.has_redemption_filter and batches:
        r = _redemption_filter(
            db.query(PrepaidVoucherRedemption.batch_id).filter(
                PrepaidVoucherRedemption.batch_id.in_([b.id for b in batches])
            ),
            scope, zone,
        )
        hit = {str(x) for (x,) in r.distinct()}
        batches = [b for b in batches if str(b.id) in hit]
    return batches


def _redemption_filter(q, scope: Scope, zone):
    """The redemption filters on a query of `prepaid_voucher_redemptions` (reversed ones never match)."""
    q = q.filter(PrepaidVoucherRedemption.reversed_at.is_(None))
    start, end = _range(scope.date_from, scope.date_to, zone)
    if start is not None:
        q = q.filter(PrepaidVoucherRedemption.redeemed_at >= start)
    if end is not None:
        q = q.filter(PrepaidVoucherRedemption.redeemed_at < end)
    if scope.machine_ids:
        ids = [PV._as_uuid(m) for m in scope.machine_ids]
        q = q.filter(PrepaidVoucherRedemption.machine_id.in_([i for i in ids if i is not None] or [uuid.uuid4()]))
    if scope.employees:
        q = q.filter(or_(
            PrepaidVoucherRedemption.pos_user_id.in_(scope.employees),
            PrepaidVoucherRedemption.pos_user_name.in_(scope.employees),
        ))
    return q


# ── The batch list ────────────────────────────────────────────────────────────


def _batch_text_match(batch: PrepaidVoucherBatch, words: List[str]) -> bool:
    hay = " ".join(
        str(x) for x in (batch.name, batch.event_name, batch.customer_name, batch.order_ref, batch.free_text, batch.type_name)
        if x
    ).lower()
    return all(w in hay for w in words)


def list_batches(db: Session, user: User, tenant_id, scope: Scope, sort: str = "newest") -> Dict[str, Any]:
    """The batch list under [scope], with each batch's figures ("עבור מי", issued, redeemed, open)."""
    sort = _choice(sort, SORTS, "sort") or "newest"
    now = PV._now()
    batches = scoped_batches(db, user, tenant_id, scope, now=now)
    if scope.q:
        words = scope.q.lower().split()
        batches = [b for b in batches if _batch_text_match(b, words)]
    stats = PV._stats(db, [b.id for b in batches])
    rows = []
    for b in batches:
        s = stats.get(str(b.id)) or PV._empty_counts()
        out = PV.batch_out(db, b, s, user=user)
        out["figures"] = batch_figures(s)
        out["state"] = batch_state(b, s, now)
        rows.append(out)
    if sort == "customer":
        rows.sort(key=lambda r: ((r.get("customerName") or "￿").lower(), r["createdAt"] or ""))
    elif sort == "event":
        rows.sort(key=lambda r: ((r.get("eventName") or "￿").lower(), r["createdAt"] or ""))
    elif sort == "redeemed":
        rows.sort(key=lambda r: (-r["figures"]["redeemed"], -(r["figures"]["rate"] or 0)))
    return {"items": rows, "total": len(rows)}


def batch_figures(stats: Dict[str, int]) -> Dict[str, Any]:
    """Issued, redeemed (in full or in part), open, and the redemption rate of the vouchers not cancelled."""
    issued = int(stats.get("total", 0))
    live = issued - int(stats.get("cancelled", 0))
    redeemed = int(stats.get("used", 0)) + int(stats.get("partiallyUsed", 0))
    return {
        "issued": issued,
        "redeemed": redeemed,
        "fullyRedeemed": int(stats.get("used", 0)),
        "open": int(stats.get("active", 0)) + int(stats.get("partiallyUsed", 0)),
        "cancelled": int(stats.get("cancelled", 0)),
        "rate": ratio(redeemed, live),
    }


def ratio(part: float, whole: float) -> Optional[float]:
    """part / whole, or None when there is nothing to divide by."""
    if not whole:
        return None
    return round(float(part) / float(whole), 4)


# ── Vouchers ──────────────────────────────────────────────────────────────────


def voucher_state(voucher: PrepaidVoucher, batch: PrepaidVoucherBatch, now: datetime) -> str:
    if voucher.status == "cancelled" or batch.status == "cancelled":
        return "cancelled"
    if voucher.status == "used":
        return "redeemed"
    end = PV._utc(batch.valid_until)
    if end is not None and now > end:
        return "expired"
    return "partial" if voucher.status == "partially_used" else "open"


def _state_filter(q, state: Optional[str], now: datetime):
    B, V = PrepaidVoucherBatch, PrepaidVoucher
    live = or_(B.valid_until.is_(None), B.valid_until >= now)
    if state == "cancelled":
        return q.filter(or_(V.status == "cancelled", B.status == "cancelled"))
    if state is None:
        return q
    q = q.filter(V.status != "cancelled", B.status != "cancelled")
    if state == "redeemed":
        return q.filter(V.status == "used")
    if state == "expired":
        return q.filter(V.status.in_(("active", "partially_used")), B.valid_until.isnot(None), B.valid_until < now)
    if state == "partial":
        return q.filter(V.status == "partially_used", live)
    return q.filter(V.status == "active", live)  # open


def _text_filter(q, text: Optional[str]):
    """A service number ("12", "#12") or the code (whole, or 4+ characters of it); a note's words too."""
    if not text:
        return q
    raw = text.strip()
    digits = raw.lstrip("#").strip()
    conds = []
    if digits.isdigit() and len(digits) <= 9:
        conds.append(PrepaidVoucher.serial == int(digits))
    code = PV.normalize_code(raw)
    if len(code) >= PV.CODE_LENGTH:
        conds.append(PrepaidVoucher.code == code[:PV.CODE_LENGTH])
    elif len(code) >= 4:
        conds.append(PrepaidVoucher.code.contains(code))
    if len(raw) >= 2:
        conds.append(func.lower(PrepaidVoucher.note).contains(raw.lower()))
    if not conds:
        return q.filter(PrepaidVoucher.id.is_(None))
    return q.filter(or_(*conds))


def voucher_query(db: Session, batches: Sequence[PrepaidVoucherBatch], scope: Scope, *, now: datetime, zone):
    q = (
        db.query(PrepaidVoucher)
        .join(PrepaidVoucherBatch, PrepaidVoucherBatch.id == PrepaidVoucher.batch_id)
        .filter(PrepaidVoucher.batch_id.in_([b.id for b in batches] or [uuid.uuid4()]))
    )
    q = _state_filter(q, scope.state, now)
    if scope.group is not None:
        q = q.filter(PrepaidVoucher.group_no == scope.group)
    q = _text_filter(q, scope.q)
    if scope.has_redemption_filter:
        sub = _redemption_filter(
            db.query(PrepaidVoucherRedemption.id).filter(PrepaidVoucherRedemption.voucher_id == PrepaidVoucher.id),
            scope, zone,
        )
        q = q.filter(sub.exists())
    return q


def _batch_ref(batch: PrepaidVoucherBatch) -> Dict[str, Any]:
    return {
        "id": str(batch.id),
        "name": batch.name,
        "eventName": batch.event_name,
        "customerName": batch.customer_name,
        "typeName": batch.type_name,
        "kind": batch.kind or "items",
        "validFrom": PV._iso(batch.valid_from),
        "validUntil": PV._iso(batch.valid_until),
        "status": batch.status,
        "redemptionAccounting": batch.redemption_accounting,
    }


def list_vouchers(
    db: Session,
    user: User,
    tenant_id,
    scope: Scope,
    *,
    limit: int = 100,
    offset: int = 0,
    with_batch: bool = True,
) -> Dict[str, Any]:
    """Vouchers under [scope] — one batch's (`batchId`) or across every batch — a page at a time."""
    limit = max(1, min(int(limit), PAGE_MAX))
    offset = max(0, int(offset))
    now = PV._now()
    zone = zone_of(db, tenant_id)
    # The voucher-level filters are this query's; the batch list's redemption rule is not.
    batches = scoped_batches(db, user, tenant_id, scope, now=now, zone=zone, by_redemption=False)
    q = voucher_query(db, batches, scope, now=now, zone=zone)
    total = q.count()
    rows = q.order_by(PrepaidVoucherBatch.created_at.desc(), PrepaidVoucher.serial).offset(offset).limit(limit).all()
    by_id = {str(b.id): b for b in batches}
    items = []
    for v in rows:
        b = by_id.get(str(v.batch_id)) or v.batch
        out = PV.voucher_out(db, v)
        out["state"] = voucher_state(v, b, now)
        if with_batch:
            out["batch"] = _batch_ref(b)
        items.append(out)
    return {"total": total, "items": items}


# ── Redemptions ───────────────────────────────────────────────────────────────


@dataclass
class Row:
    """One redemption, as the reports read it."""

    id: str
    voucher_id: str
    batch_id: str
    machine_id: Optional[str]
    shop_id: Optional[str]
    employee_id: Optional[str]
    employee_name: Optional[str]
    at: datetime
    items: List[Dict[str, Any]]
    uses: Optional[int]
    discount: Optional[int]
    flags: List[str]
    transaction_id: Optional[str]
    units: Decimal = Decimal(0)
    value: int = 0
    basis: str = "list"
    #: The accounting mode the redemption recorded (§5); None: before the record, the batch's.
    accounting: Optional[str] = None


def _units(items: Iterable[Dict[str, Any]]) -> Decimal:
    """Units taken: pieces as counted; a weighed line is one unit."""
    total = Decimal(0)
    for i in items or ():
        q = PV.qty(i.get("quantity"))
        total += q if q == q.to_integral_value() else Decimal(1)
    return total


def _voucher_units(batch: PrepaidVoucherBatch) -> Decimal:
    total = Decimal(0)
    for i in batch.items:
        q = PV.qty(i.quantity)
        total += q if q == q.to_integral_value() else Decimal(1)
    return total


def redemption_rows(
    db: Session,
    batches: Sequence[PrepaidVoucherBatch],
    scope: Scope,
    zone,
    *,
    now: Optional[datetime] = None,
) -> List[Row]:
    """The redemptions of [batches] that [scope] keeps (not reversed), each with its units and value."""
    if not batches:
        return []
    now = now or PV._now()
    R = PrepaidVoucherRedemption
    q = db.query(
        R.id, R.voucher_id, R.batch_id, R.machine_id, R.shop_id, R.pos_user_id, R.pos_user_name, R.redeemed_at,
        R.items, R.uses, R.discount_amount, R.flags, R.transaction_id, R.value_agorot, R.redemption_accounting,
    ).filter(R.batch_id.in_([b.id for b in batches]))
    q = _redemption_filter(q, scope, zone)
    if scope.state or scope.group is not None or scope.q:
        vq = voucher_query(db, batches, replace(scope, date_from=None, date_to=None, machine_ids=(), employees=()),
                           now=now, zone=zone).with_entities(PrepaidVoucher.id)
        q = q.filter(R.voucher_id.in_(vq))
    by_id = {str(b.id): b for b in batches}
    raw = q.all()
    product_ids: Set[uuid.UUID] = set()
    for r in raw:
        for i in r.items or ():
            pid = PV._as_uuid(i.get("productId"))
            if pid is not None:
                product_ids.add(pid)
    prices = (
        {str(p): Decimal(str(price or 0)) for p, price in db.query(Product.id, Product.price).filter(Product.id.in_(product_ids))}
        if product_ids else {}
    )
    unit_cache: Dict[str, Decimal] = {}
    out: List[Row] = []
    for r in raw:
        b = by_id[str(r.batch_id)]
        row = Row(
            id=str(r.id), voucher_id=str(r.voucher_id), batch_id=str(r.batch_id),
            machine_id=str(r.machine_id) if r.machine_id else None,
            shop_id=str(r.shop_id) if r.shop_id else None,
            employee_id=r.pos_user_id, employee_name=r.pos_user_name,
            at=PV._utc(r.redeemed_at), items=list(r.items or []), uses=r.uses, discount=r.discount_amount,
            flags=list(r.flags or []), transaction_id=r.transaction_id,
        )
        row.units = _units(row.items)
        row.accounting = r.redemption_accounting
        if r.value_agorot is not None and not PV.is_discount(b):
            # The redemption's own record (§5): what it was worth when it was taken.
            row.value, row.basis = int(r.value_agorot), "recorded"
        elif PV.is_discount(b):
            row.value, row.basis = int(r.discount_amount or 0), "discount"
        elif (b.pricing or "cover") == "fixed" and b.till_value:
            per = unit_cache.get(row.batch_id)
            if per is None:
                per = unit_cache[row.batch_id] = _voucher_units(b)
            share = (Decimal(int(b.till_value)) * row.units / per) if per else Decimal(int(b.till_value))
            row.value, row.basis = int(share.quantize(Decimal(1), rounding=ROUND_HALF_UP)), "fixed"
        else:
            total = sum(
                (PV.qty(i.get("quantity")) * prices.get(str(PV._as_uuid(i.get("productId"))), NO_UNIT_PRICE) for i in row.items),
                Decimal(0),
            )
            row.value, row.basis = int((total * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)), "list"
        out.append(row)
    out.sort(key=lambda x: x.at or now)
    return out


def _values_by_mode(rows: Iterable[Row], batches: Dict[str, PrepaidVoucherBatch]) -> Dict[str, int]:
    out = {m: 0 for m in ACCOUNTING}
    for r in rows:
        b = batches[r.batch_id]
        mode = "discount" if PV.is_discount(b) else (r.accounting or b.redemption_accounting or "zero")
        out[mode if mode in out else "zero"] += r.value
    out["total"] = sum(out[m] for m in ACCOUNTING)
    return out


def _qty_number(d: Decimal):
    return int(d) if d == d.to_integral_value() else float(d)


# ── Aggregates ────────────────────────────────────────────────────────────────


def series(rows: Sequence[Row], bucket: str, zone, *, date_from: Optional[date] = None, date_to: Optional[date] = None) -> List[Dict[str, Any]]:
    """Redemptions over time: per hour of the day (0–23, the profile) or per local day (every day of the range)."""
    bucket = _choice(bucket, BUCKETS, "bucket") or "day"
    if bucket == "hour":
        hours = [{"key": h, "redemptions": 0, "vouchers": set(), "items": Decimal(0), "value": 0} for h in range(24)]
        for r in rows:
            h = hours[_local(r.at, zone).hour]
            h["redemptions"] += 1
            h["vouchers"].add(r.voucher_id)
            h["items"] += r.units
            h["value"] += r.value
        return [{**h, "vouchers": len(h["vouchers"]), "items": _qty_number(h["items"])} for h in hours]
    days: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        key = _local(r.at, zone).date().isoformat()
        d = days.setdefault(key, {"key": key, "redemptions": 0, "vouchers": set(), "items": Decimal(0), "value": 0})
        d["redemptions"] += 1
        d["vouchers"].add(r.voucher_id)
        d["items"] += r.units
        d["value"] += r.value
    if rows or (date_from and date_to):
        first = date_from or _local(rows[0].at, zone).date()
        last = date_to or _local(rows[-1].at, zone).date()
        if 0 <= (last - first).days <= 400:
            cur = first
            while cur <= last:
                days.setdefault(cur.isoformat(), {"key": cur.isoformat(), "redemptions": 0, "vouchers": set(),
                                                  "items": Decimal(0), "value": 0})
                cur += timedelta(days=1)
    return [
        {**d, "vouchers": len(d["vouchers"]), "items": _qty_number(d["items"])}
        for d in sorted(days.values(), key=lambda x: x["key"])
    ]


def _group(rows: Iterable[Row], key) -> Dict[Any, Dict[str, Any]]:
    out: Dict[Any, Dict[str, Any]] = {}
    for r in rows:
        k = key(r)
        g = out.setdefault(k, {"redemptions": 0, "vouchers": set(), "items": Decimal(0), "value": 0, "flags": 0})
        g["redemptions"] += 1
        g["vouchers"].add(r.voucher_id)
        g["items"] += r.units
        g["value"] += r.value
        g["flags"] += 1 if r.flags else 0
    return out


def _figures(g: Dict[str, Any]) -> Dict[str, Any]:
    return {"redemptions": g["redemptions"], "vouchers": len(g["vouchers"]), "items": _qty_number(g["items"]), "value": g["value"]}


def _machine_names(db: Session, ids: Iterable[str]) -> Dict[str, Tuple[str, Optional[str], Optional[str]]]:
    """machine id → (name, shop id, shop name)."""
    wanted = [PV._as_uuid(i) for i in ids]
    wanted = [i for i in wanted if i is not None]
    if not wanted:
        return {}
    rows = (
        db.query(POSMachine.id, POSMachine.name, POSMachine.shop_id, Shop.name)
        .outerjoin(Shop, Shop.id == POSMachine.shop_id)
        .filter(POSMachine.id.in_(wanted))
        .all()
    )
    return {str(i): (n, str(s) if s else None, sn) for i, n, s, sn in rows}


def _type_names(db: Session, batches: Iterable[PrepaidVoucherBatch]) -> Dict[str, str]:
    ids = {b.type_id for b in batches if getattr(b, "type_id", None)}
    if not ids:
        return {}
    return {str(i): n for i, n in db.query(PrepaidVoucherType.id, PrepaidVoucherType.name).filter(PrepaidVoucherType.id.in_(ids))}


def _type_key(b: PrepaidVoucherBatch, names: Dict[str, str]) -> Tuple[str, str]:
    if getattr(b, "type_id", None):
        return str(b.type_id), b.type_name or names.get(str(b.type_id)) or b.name
    return f"kind:{b.kind or 'items'}", b.kind or "items"


# ── "מימושים לפי קופה" ────────────────────────────────────────────────────────


def tills_report(db: Session, user: User, tenant_id, scope: Scope, bucket: str = "day") -> Dict[str, Any]:
    """One row per till: its shop, vouchers and items redeemed, the value per accounting mode."""
    now = PV._now()
    zone = zone_of(db, tenant_id)
    batches = scoped_batches(db, user, tenant_id, scope, now=now, zone=zone, by_redemption=False)
    by_id = {str(b.id): b for b in batches}
    rows = redemption_rows(db, batches, scope, zone, now=now)
    machines = _machine_names(db, {r.machine_id for r in rows if r.machine_id})
    per: Dict[Optional[str], List[Row]] = defaultdict(list)
    for r in rows:
        per[r.machine_id].append(r)
    out = []
    for mid, rs in per.items():
        name, shop_id, shop_name = machines.get(mid) or (None, None, None)
        g = _group(rs, lambda _r: 0)[0]
        out.append({
            "machineId": mid,
            "name": name,
            "shopId": shop_id or next((r.shop_id for r in rs if r.shop_id), None),
            "shopName": shop_name,
            **_figures(g),
            "value": _values_by_mode(rs, by_id),
            "flagged": g["flags"],
            # Recorded with reserve → confirm, the override audit and offline sync (later).
            "topUp": None,
            "refusals": None,
            "overrides": None,
            "offlinePending": None,
        })
    out.sort(key=lambda x: (-x["redemptions"], x["name"] or ""))
    totals = _figures(_group(rows, lambda _r: 0)[0]) if rows else {"redemptions": 0, "vouchers": 0, "items": 0, "value": 0}
    return {
        "items": out,
        "totals": {**totals, "value": _values_by_mode(rows, by_id)},
        "series": series(rows, bucket, zone, date_from=scope.date_from, date_to=scope.date_to),
        "bucket": bucket if bucket in BUCKETS else "day",
    }


def redemptions_list(db: Session, user: User, tenant_id, scope: Scope, *, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
    """The redemptions under [scope] (a till's, when `machineId` says so): time, voucher, batch, items, employee."""
    limit = max(1, min(int(limit), PAGE_MAX))
    offset = max(0, int(offset))
    now = PV._now()
    zone = zone_of(db, tenant_id)
    batches = scoped_batches(db, user, tenant_id, scope, now=now, zone=zone, by_redemption=False)
    by_id = {str(b.id): b for b in batches}
    rows = sorted(redemption_rows(db, batches, scope, zone, now=now), key=lambda r: r.at, reverse=True)
    page = rows[offset:offset + limit]
    vouchers = {
        str(v.id): v for v in db.query(PrepaidVoucher).filter(
            PrepaidVoucher.id.in_([uuid.UUID(r.voucher_id) for r in page] or [uuid.uuid4()])
        )
    }
    machines = _machine_names(db, {r.machine_id for r in page if r.machine_id})
    items = []
    for r in page:
        b = by_id[r.batch_id]
        v = vouchers.get(r.voucher_id)
        items.append({
            "id": r.id,
            "redeemedAt": PV._iso(r.at),
            "voucherId": r.voucher_id,
            "serial": int(v.serial) if v else None,
            "displayCode": PV.format_code(v.code) if v else None,
            "batch": _batch_ref(b),
            "items": r.items,
            "units": _qty_number(r.units),
            "uses": r.uses,
            "value": r.value,
            "valueBasis": r.basis,
            "accounting": "discount" if PV.is_discount(b) else (r.accounting or b.redemption_accounting or "zero"),
            "machineId": r.machine_id,
            "machineName": (machines.get(r.machine_id) or (None,))[0] if r.machine_id else None,
            "employeeId": r.employee_id,
            "employeeName": r.employee_name,
            "transactionId": r.transaction_id,
            "flags": r.flags,
        })
    return {"total": len(rows), "items": items}


# ── Facets (the dropdowns) and the wide search ────────────────────────────────


def facets(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    """The values the filters offer, from the batches [user] manages: for whom, events, types, shops, tills, employees, creators."""
    from app.services import prepaid_voucher_types as PVT

    PV._require_role(user)
    batches = [
        b for b in db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == tenant_id)
        .order_by(PrepaidVoucherBatch.created_at.desc())
        if PV.may_manage(db, user, tenant_id, b)
    ]
    customers: Dict[str, int] = defaultdict(int)
    events: Dict[str, int] = defaultdict(int)
    for b in batches:
        if b.customer_name:
            customers[b.customer_name] += 1
        if b.event_name:
            events[b.event_name] += 1
    types = _type_names(db, batches)
    type_rows: Dict[str, str] = {}
    for b in batches:
        k, n = _type_key(b, types)
        type_rows.setdefault(k, n)
    ids = [b.id for b in batches]
    R = PrepaidVoucherRedemption
    machine_ids = {str(m) for (m,) in db.query(R.machine_id).filter(R.batch_id.in_(ids or [uuid.uuid4()]), R.machine_id.isnot(None)).distinct()}
    machines = _machine_names(db, machine_ids)
    employees: Dict[str, str] = {}
    for uid, name in db.query(R.pos_user_id, R.pos_user_name).filter(R.batch_id.in_(ids or [uuid.uuid4()])).distinct():
        key = uid or name
        if key:
            employees.setdefault(str(key), name or str(key))
    creators = {str(b.created_by) for b in batches if b.created_by}
    users = {str(i): n for i, n in db.query(User.id, User.username).filter(User.id.in_([PV._as_uuid(c) for c in creators] or [uuid.uuid4()]))}
    shop_q = PV._visible_shops_query(db, user, tenant_id)
    shops = [{"id": str(s.id), "name": s.name, "companyId": str(s.company_id)} for s in (shop_q.order_by(Shop.name).all() if shop_q is not None else [])]
    return {
        "customers": [{"value": k, "batches": n} for k, n in sorted(customers.items(), key=lambda x: x[0].lower())],
        "events": [{"value": k, "batches": n} for k, n in sorted(events.items(), key=lambda x: x[0].lower())],
        "types": [{"id": k, "name": n} for k, n in sorted(type_rows.items(), key=lambda x: (x[1] or "").lower())],
        "batches": [{"id": str(b.id), "name": b.name, "customerName": b.customer_name, "eventName": b.event_name} for b in batches],
        "shops": shops,
        "tills": sorted(({"id": k, "name": v[0], "shopName": v[2]} for k, v in machines.items()), key=lambda x: (x["name"] or "")),
        "employees": [{"id": k, "name": v} for k, v in sorted(employees.items(), key=lambda x: x[1].lower())],
        "creators": [{"id": k, "name": users.get(k, k)} for k in sorted(creators, key=lambda c: users.get(c, c).lower())],
        "pricesVisible": PVT.prices_visible(db, user),
    }


def search(db: Session, user: User, tenant_id, text: str) -> Dict[str, Any]:
    """
    One box over everything: batches (name, for whom, event, order, free text, type), vouchers
    (service number, code, note), tills and employees that redeemed — grouped, a few of each.
    """
    PV._require_role(user)
    raw = (text or "").strip()
    empty = {"batches": [], "vouchers": [], "tills": [], "employees": []}
    if len(raw) < 2:
        return empty
    batches = [
        b for b in db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == tenant_id)
        .order_by(PrepaidVoucherBatch.created_at.desc())
        if PV.may_manage(db, user, tenant_id, b)
    ]
    words = raw.lower().split()
    hits = [b for b in batches if _batch_text_match(b, words)][:SEARCH_LIMIT]
    now = PV._now()
    vq = _text_filter(
        db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id.in_([b.id for b in batches] or [uuid.uuid4()])), raw,
    )
    by_id = {str(b.id): b for b in batches}
    vouchers = []
    for v in vq.order_by(PrepaidVoucher.serial).limit(SEARCH_LIMIT).all():
        b = by_id[str(v.batch_id)]
        vouchers.append({"id": str(v.id), "serial": int(v.serial), "displayCode": PV.format_code(v.code),
                         "state": voucher_state(v, b, now), "batch": _batch_ref(b)})
    R = PrepaidVoucherRedemption
    ids = [b.id for b in batches] or [uuid.uuid4()]
    needle = raw.lower()
    machine_counts = {
        str(m): n for m, n in db.query(R.machine_id, func.count(R.id))
        .filter(R.batch_id.in_(ids), R.machine_id.isnot(None), R.reversed_at.is_(None)).group_by(R.machine_id)
    }
    machines = _machine_names(db, machine_counts)
    tills = [
        {"id": k, "name": v[0], "shopName": v[2], "redemptions": machine_counts.get(k, 0)}
        for k, v in machines.items() if needle in (v[0] or "").lower()
    ][:SEARCH_LIMIT]
    employees: Dict[str, Dict[str, Any]] = {}
    for uid, name, n in (
        db.query(R.pos_user_id, R.pos_user_name, func.count(R.id))
        .filter(R.batch_id.in_(ids), R.reversed_at.is_(None), func.lower(R.pos_user_name).contains(needle))
        .group_by(R.pos_user_id, R.pos_user_name)
    ):
        key = str(uid or name)
        e = employees.setdefault(key, {"id": key, "name": name, "redemptions": 0})
        e["redemptions"] += int(n)
    return {
        "batches": [_batch_ref(b) for b in hits],
        "vouchers": vouchers,
        "tills": tills,
        "employees": list(employees.values())[:SEARCH_LIMIT],
    }
