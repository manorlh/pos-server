"""
The integration merge of the vouchers core (fix/voucher-print) into integration/fri: a production
voucher's deduction ("קיזוז שוברי הפקה") is taken out of "discounts" exactly once on every surface
the merged branches share — never left in, never taken out twice.

The core's sale (tests/test_production_voucher_deductions.py): ₪50 of goods, a ₪5 regular
discount and a ₪40 deduction, ₪5 cash. Every surface must say discounts ₪5 — ₪45 would be the
deduction left in, ₪0 / −₪35 the deduction taken out twice:

* the cashier report and the report center (the core's `_sales_buckets` rows);
* the cashier insights (`load_cashiers`, then `service.cashiers` takes the promotions out) — also
  in an event's scope (its tills and window, from feat/event-live's insights hook);
* the events report (`make_doc`, through `load_docs`);
* the exceptions' discount rule (the deduction is no cashier's discount).
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

from app.models.report_event import ReportEvent
from app.routers import reports as reports_router
from app.services import exceptions as EX
from app.services.insights import data as D
from app.services.shift_totals import production_deductions_of
from shift_world import NOW
from test_prepaid_voucher_kinds import _ctx, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_deductions import booked, report_args  # noqa: F401 — `booked` is a fixture


def _tx(w):
    from app.models.transaction import Transaction

    return w.db.query(Transaction).filter(Transaction.id == uuid.UUID(str(w.booked_id))).one()


def test_the_reports_take_it_out_once(booked):
    w = booked
    out = reports_router.get_cashier_sales_report(**report_args(area_id=None), **_ctx(w)).totals
    assert (out.discounts, out.production_voucher_deductions) == (5.0, 40.0)


def test_the_cashier_insights_take_it_out_once_also_in_an_events_scope(booked):
    from app.services.insights.analytics import BusinessClock

    w = booked
    till = w.tills[0]
    clock = BusinessClock(tz_name="Asia/Jerusalem", day_start_hour=4, now=NOW)
    start, end = NOW - timedelta(hours=2), NOW + timedelta(hours=2)
    scopes = {
        "shop": D.InsightScope(user=w.admin, tenant_id=w.tenant.id, shop_id=w.shop.id),
        "event": D.InsightScope(user=w.admin, tenant_id=w.tenant.id, shop_id=w.shop.id, machine_ids=(till.id,),
                                window_start=NOW - timedelta(hours=1), window_end=NOW + timedelta(hours=1)),
    }
    for name, scope in scopes.items():
        aggs = D.load_cashiers(w.db, scope, clock, start, end)
        assert len(aggs) == 1, name
        (agg,) = aggs.values()
        # In agorot: gross ₪10 (the ₪40 the voucher covered is no sale), the cashier's discount ₪5.
        assert (agg.gross, max(0, agg.document_discounts - agg.promotions)) == (1000, 500), name


def test_the_events_report_takes_it_out_once(booked):
    from app.services.report_events.report import load_docs

    w = booked
    till = w.tills[0]
    event = ReportEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                        name="במה", starts_at=NOW - timedelta(hours=1), ends_at=NOW + timedelta(hours=1),
                        timezone="Asia/Jerusalem", status="draft")
    w.db.add(event)
    w.db.flush()
    (doc,) = load_docs(w.db, event, [till.id])
    assert (doc.gross, doc.discount) == (Decimal("10.00"), Decimal("5.00"))


def test_the_discount_exception_counts_only_the_cashiers_discount(booked):
    w = booked
    tx = _tx(w)
    deduction = production_deductions_of(w.db, [tx.id])[tx.id]
    assert deduction == Decimal("40.00")
    # ₪5 of ₪50 is 10%: a 10% rule raises it, an 11% rule does not — with the ₪40 left in (90%)
    # both would, with it taken out twice (−70%) neither.
    rule = lambda pct: {"discount": EX.EffectiveRule(type="discount", enabled=True, params={"minPercent": pct})}  # noqa: E731
    assert [f.type for f in EX.detect_transaction(tx, rule(10), None, deduction)] == ["discount"]
    assert [f.type for f in EX.detect_transaction(tx, rule(11), None, deduction)] == []
