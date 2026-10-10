"""
Builders shared by the "event and owner awareness" tests (live screen, phone alerts, producer
view): an event over the shift world's tills, prepaid voucher redemptions, KDS orders.

On the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional, Sequence

from app.models.kds import KitchenOrder
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption, PrepaidVoucherType
from app.models.report_event import ReportEvent, ReportEventMachine

# 2026-09-27 is IDT (UTC+3): 18:00 local = 15:00 UTC.
START = datetime(2026, 9, 27, 15, 0, tzinfo=timezone.utc)
END = datetime(2026, 9, 27, 20, 0, tzinfo=timezone.utc)

_serials = itertools.count(1)
_codes = itertools.count(100000)


def at(minutes: float) -> datetime:
    return START + timedelta(minutes=minutes)


def make_event(w, *, name="במה ראשית", tills=None, shop=None, start=START, end=END, target=None,
               producer_name=None) -> ReportEvent:
    shop = shop or w.shop
    event = ReportEvent(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=shop.id, name=name,
        starts_at=start, ends_at=end, timezone="Asia/Jerusalem", status="draft",
        live_target=Decimal(str(target)) if target is not None else None, producer_name=producer_name,
    )
    w.db.add(event)
    w.db.flush()
    for t in (tills if tills is not None else w.tills):
        w.db.add(ReportEventMachine(id=uuid.uuid4(), event_id=event.id, machine_id=t.id))
    w.db.flush()
    return event


def sale(w, till, minutes, total, *, credit_note=False, discount="0", tip="0", method="cash"):
    tx = w.doc(till, None, total, credit_note=credit_note, discount=discount, tip=tip, method=method)
    tx.created_at = at(minutes)
    w.db.flush()
    return tx


def batch(w, name="שובר ארוחה", *, event_name=None, customer_name=None) -> PrepaidVoucherBatch:
    """A batch of its own type (the vouchers core: every batch has one)."""
    vtype = PrepaidVoucherType(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name=name)
    w.db.add(vtype)
    w.db.flush()
    b = PrepaidVoucherBatch(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name=name,
        event_name=event_name, customer_name=customer_name, type_id=vtype.id, type_name=vtype.name,
    )
    w.db.add(b)
    w.db.flush()
    return b


def voucher(w, b: PrepaidVoucherBatch) -> PrepaidVoucher:
    v = PrepaidVoucher(
        id=uuid.uuid4(), tenant_id=w.tenant.id, batch_id=b.id, serial=next(_serials),
        code=f"PV{next(_codes)}", remaining=[],
    )
    w.db.add(v)
    w.db.flush()
    return v


def redeem(w, v: PrepaidVoucher, till, minutes, *, qty=1, reversed_=False, name="המבורגר") -> PrepaidVoucherRedemption:
    r = PrepaidVoucherRedemption(
        id=uuid.uuid4(), tenant_id=w.tenant.id, voucher_id=v.id, batch_id=v.batch_id, machine_id=till.id,
        shop_id=till.shop_id, client_request_id=uuid.uuid4().hex, items=[{"productId": None, "name": name, "quantity": qty}],
        redeemed_at=at(minutes), reversed_at=at(minutes + 1) if reversed_ else None,
    )
    w.db.add(r)
    w.db.flush()
    return r


def kds_order(w, *, released_min: float, ready_min: Optional[float] = None, status: str = "open", shop=None) -> KitchenOrder:
    o = KitchenOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, source="quick",
        source_ref=uuid.uuid4().hex, status=status, first_released_at=at(released_min),
        ready_at=at(ready_min) if ready_min is not None else None,
    )
    w.db.add(o)
    w.db.flush()
    return o


def ids(rows: Sequence) -> list:
    return [r.id for r in rows]
