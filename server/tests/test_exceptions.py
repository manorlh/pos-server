"""
Exceptions ("חריגות"): detection per type and threshold, the rule hierarchy, idempotency,
the till's events, review, and who sees what.

What each class pins:

* **Rules** — field by field, till → area → shop → company → tenant → default; a level
  that sets only a threshold still inherits on/off, and the reverse.
* **Detection** — each type fires at its threshold and not below it, from documents,
  shift closes and till events.
* **Idempotent** — detecting again, a rescan or a re-sent event never adds a row, and
  never reopens or rewrites one a manager reviewed.
* **Review and scoping** — a cashier sees nothing; a shift supervisor sees but cannot
  review; a shop manager sees and reviews their shop only; another tenant never.
* **Rules API** — per level, written under the settings rules.

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import Response

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.pos_user import PosUser
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.transaction import TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import exceptions as R
from app.schemas.audit_exception import (
    BulkReviewIn,
    RescanIn,
    ReviewIn,
    RuleIn,
    RulesPut,
    TillEventIn,
)
from app.services import exceptions as svc
from shift_world import NOW
from test_shop_areas import _ctx, refused, w  # noqa: F401

FROM, TO = date(2026, 9, 1), date(2026, 9, 30)


# ── helpers ──────────────────────────────────────────────────────────────────


def rule(w, scope_type, scope_id, kind, enabled=None, **params):
    row = ExceptionRuleValue(
        id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type=scope_type, scope_id=scope_id,
        exception_type=kind, enabled=enabled, params=params or None,
    )
    w.db.add(row)
    w.db.commit()
    return row


def sale(w, till=None, total="100", *, lines=(), cashier=None, **kw):
    tx = w.doc(till or w.tills[0], None, total, **kw)
    for name, qty, price, discount in lines:
        w.db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_name=name, quantity=Decimal(qty),
            unit_price=Decimal(price), total_price=Decimal(price) * Decimal(qty),
            discount=Decimal(discount) if discount is not None else None,
        ))
    if cashier is not None:
        tx.cashier_id = cashier
    w.db.commit()
    return tx


def detect(w, *txs):
    d = svc.detect_transactions(w.db, [t.id for t in txs])
    w.db.commit()
    return d


def found(w, kind=None):
    q = w.db.query(AuditException)
    if kind:
        q = q.filter(AuditException.exception_type == kind)
    return q.all()


def listed(w, user=None, **filters):
    args = dict(
        from_date=FROM, to_date=TO, company_id=None, shop_id=None, area_id=None, machine_id=None,
        types=None, employee=None, statuses=None, page=1, page_size=50,
    )
    args.update(filters)
    return R.list_exceptions(**args, **_ctx(w, user))


def summary(w, user=None, **filters):
    args = dict(
        from_date=FROM, to_date=TO, company_id=None, shop_id=None, area_id=None, machine_id=None,
        types=None, employee=None,
    )
    args.update(filters)
    return R.exceptions_summary(**args, **_ctx(w, user))


def event(w, till, kind, *, amount=None, details=None, event_id=None, transaction_id=None, user="pu-1"):
    body = TillEventIn(
        id=event_id or uuid.uuid4(), type=kind, occurredAt=NOW, posUserId=user, amount=amount,
        details=details, transactionId=transaction_id,
    )
    return R.post_till_event(str(till.id), body, Response(), machine=till, db=w.db)


@pytest.fixture
def supervisor(w):
    u = User(id=uuid.uuid4(), role=UserRole.SHIFT_SUPERVISOR, tenant_id=w.tenant.id,
             email="sv@x", username="sv", shop_id=w.shop.id)
    w.db.add(u)
    w.db.commit()
    return u


# ── Rules ────────────────────────────────────────────────────────────────────


class TestRuleResolution:
    def test_defaults(self, w):
        rules = svc.rules_for_machine(w.db, w.tills[0])
        assert rules["long_order"].enabled and rules["long_order"].params == {"minutes": 10}
        assert rules["high_tip"].params == {"percent": 15}
        assert rules["discount"].enabled and rules["refund"].enabled and rules["drawer_open"].enabled
        assert not rules["high_amount"].enabled and not rules["after_hours"].enabled
        # Planned types are never on, whatever a level says.
        rule(w, "tenant", w.tenant.id, "price_override", enabled=True)
        assert not svc.rules_for_machine(w.db, w.tills[0])["price_override"].enabled

    def test_the_most_specific_level_wins_field_by_field(self, w):
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.tills[0].area_id = bar.id
        w.db.commit()
        rule(w, "tenant", w.tenant.id, "long_order", minutes=30)
        rule(w, "company", w.company.id, "long_order", minutes=20)
        rule(w, "area", bar.id, "long_order", enabled=False)
        rule(w, "machine", w.tills[0].id, "long_order", minutes=5)

        mine = svc.rules_for_machine(w.db, w.tills[0])["long_order"]
        # Off from the area, minutes from the till itself.
        assert not mine.enabled and mine.params == {"minutes": 5}
        assert mine.sources == {"enabled": "area", "minutes": "machine"}

        other = svc.rules_for_machine(w.db, w.tills[1])["long_order"]
        assert other.enabled and other.params == {"minutes": 20}
        assert other.sources == {"enabled": None, "minutes": "company"}

    def test_another_shops_value_does_not_apply(self, w):
        rule(w, "shop", w.other_shop.id, "high_tip", percent=50)
        assert svc.rules_for_machine(w.db, w.tills[0])["high_tip"].params == {"percent": 15}
        assert svc.rules_for_machine(w.db, w.other_till)["high_tip"].params == {"percent": 50}

    def test_params_are_validated(self):
        spec = svc.RULES_BY_TYPE["long_order"]
        assert svc.clean_params(spec, {"minutes": 12, }) == {"minutes": 12}
        assert svc.clean_params(spec, {"minutes": None}) == {}
        for bad in ({"minutes": 0}, {"minutes": 1.5}, {"minutes": "5"}, {"hours": 1}, {"minutes": True}):
            with pytest.raises(svc.RuleValueError):
                svc.clean_params(spec, bad)


# ── Detection ────────────────────────────────────────────────────────────────


class TestDocuments:
    def test_a_discount_any_by_default(self, w):
        tx = sale(w, total="100", discount="10", lines=[("Cola", "1", "100", "10")], cashier="pu-1")
        detect(w, tx)
        (row,) = found(w, "discount")
        assert row.amount == Decimal("10.00") and row.value == Decimal("10.00")
        assert row.transaction_id == tx.id and row.pos_user_id == "pu-1"
        assert row.shop_id == w.shop.id and row.company_id == w.company.id
        assert row.details["lineDiscounts"][0]["name"] == "Cola"

    def test_a_discount_below_the_threshold_is_not_one(self, w):
        rule(w, "shop", w.shop.id, "discount", minPercent=20)
        small = sale(w, total="100", discount="10")
        big = sale(w, total="100", discount="25")
        detect(w, small, big)
        assert [r.transaction_id for r in found(w, "discount")] == [big.id]

    def test_the_tills_own_threshold_beats_the_shops(self, w):
        rule(w, "shop", w.shop.id, "discount", minPercent=20)
        rule(w, "machine", w.tills[0].id, "discount", minPercent=5)
        detect(w, sale(w, w.tills[0], discount="10"), sale(w, w.tills[1], discount="10"))
        assert [r.machine_id for r in found(w, "discount")] == [w.tills[0].id]

    def test_an_amount_threshold(self, w):
        rule(w, "company", w.company.id, "discount", minAmount=50)
        detect(w, sale(w, total="1000", discount="40"), sale(w, total="1000", discount="60"))
        assert [r.amount for r in found(w, "discount")] == [Decimal("60.00")]

    def test_a_refund(self, w):
        rule(w, "company", w.company.id, "refund", minAmount=100)
        small = sale(w, total="50", credit_note=True)
        big = sale(w, total="150", credit_note=True)
        detect(w, small, big)
        assert [r.transaction_id for r in found(w, "refund")] == [big.id]
        # A refund is not also a discount or a high amount.
        assert found(w, "discount") == []

    def test_a_refund_type_switched_off(self, w):
        rule(w, "tenant", w.tenant.id, "refund", enabled=False)
        detect(w, sale(w, total="500", credit_note=True))
        assert found(w) == []

    def test_a_tip_above_15_percent(self, w):
        at = sale(w, total="100", tip="15", tip_method="card")
        over = sale(w, total="100", tip="16", tip_method="card")
        detect(w, at, over)
        (row,) = found(w, "high_tip")
        assert row.transaction_id == over.id and row.value == Decimal("16.00")
        assert row.threshold == Decimal("15")

    def test_a_high_amount_once_switched_on(self, w):
        tx = sale(w, total="600")
        detect(w, tx)
        assert found(w, "high_amount") == []
        rule(w, "tenant", w.tenant.id, "high_amount", enabled=True, amount=500)
        detect(w, tx)
        assert len(found(w, "high_amount")) == 1

    def test_a_sale_after_hours_in_the_tenants_timezone(self, w):
        # NOW is 18:00 UTC = 21:00 in Jerusalem (summer time).
        rule(w, "shop", w.shop.id, "after_hours", enabled=True, fromHour=20, toHour=23)
        detect(w, sale(w))
        (row,) = found(w, "after_hours")
        assert row.details["localTime"] == "21:00"

    def test_a_window_that_wraps_midnight(self):
        assert svc._hour_in_window(23, 22, 6) and svc._hour_in_window(3, 22, 6)
        assert not svc._hour_in_window(12, 22, 6) and not svc._hour_in_window(5, 5, 5)

    def test_a_cancelled_document(self, w):
        detect(w, sale(w, total="80", status=TransactionStatus.CANCELLED))
        (row,) = found(w)
        assert row.exception_type == "basket_cancel" and row.amount == Decimal("80.00")

    def test_the_employee_name_is_resolved(self, w):
        pu = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana",
                     first_name="דנה", last_name="כהן", pin_hash="x")
        w.db.add(pu)
        w.db.commit()
        detect(w, sale(w, discount="5", cashier=str(pu.id)))
        assert found(w, "discount")[0].pos_user_name == "דנה כהן"


class TestShiftClose:
    def test_a_cash_difference_at_or_over_the_threshold(self, w):
        short = w.shift(w.tills[0], 1)
        short.discrepancy = Decimal("-30")
        short.closed_by_pos_user_id = "pu-2"
        small = w.shift(w.tills[1], 1)
        small.discrepancy = Decimal("10")
        w.db.commit()
        svc.detect_shift_close(w.db, short.id)
        svc.detect_shift_close(w.db, small.id)
        w.db.commit()
        (row,) = found(w, "cash_difference")
        assert row.shift_id == short.id and row.amount == Decimal("-30.00")
        assert row.severity == "high" and row.pos_user_id == "pu-2"

    def test_an_uncounted_or_open_shift_is_not_one(self, w):
        uncounted = w.shift(w.tills[0], 1)
        still_open = w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
        still_open.discrepancy = Decimal("-100")
        w.db.commit()
        for s in (uncounted, still_open):
            svc.detect_shift_close(w.db, s.id)
        assert found(w) == []


class TestTillEvents:
    def test_a_long_order(self, w):
        tx = sale(w)
        details = {"startedAt": (NOW - timedelta(minutes=12)).isoformat(), "completedAt": NOW.isoformat()}
        out = event(w, w.tills[0], "basket_completed", amount="100", details=details)
        assert out.status == "accepted"
        (row,) = found(w, "long_order")
        assert row.value == Decimal("12.00") and row.threshold == Decimal("10")
        # The document the basket became, found by time on the same till.
        assert row.transaction_id == tx.id

    def test_a_quick_order_is_not_one(self, w):
        details = {"startedAt": (NOW - timedelta(minutes=3)).isoformat(), "completedAt": NOW.isoformat()}
        event(w, w.tills[0], "basket_completed", details=details)
        assert found(w) == []

    def test_voids_cancels_and_drawer(self, w):
        rule(w, "shop", w.shop.id, "line_void", minAmount=20)
        event(w, w.tills[0], "line_void", amount="5", details={"productName": "Gum"})
        event(w, w.tills[0], "line_void", amount="25", details={"productName": "Wine"})
        event(w, w.tills[0], "basket_cancel", amount="40", details={"lineCount": 3})
        event(w, w.tills[0], "drawer_open")
        kinds = sorted(r.exception_type for r in found(w))
        assert kinds == ["basket_cancel", "drawer_open", "line_void"]
        assert found(w, "line_void")[0].details == {"productName": "Wine"}

    def test_a_resent_event_is_a_duplicate(self, w):
        ident = uuid.uuid4()
        assert event(w, w.tills[0], "drawer_open", event_id=ident).status == "accepted"
        assert event(w, w.tills[0], "drawer_open", event_id=ident).status == "duplicate"
        assert len(found(w)) == 1

    def test_another_tills_event_id_is_refused(self, w):
        ident = uuid.uuid4()
        event(w, w.tills[0], "drawer_open", event_id=ident)
        assert refused(event, w, w.tills[1], "drawer_open", event_id=ident).status_code == 409


# ── Idempotency ──────────────────────────────────────────────────────────────


class TestIdempotency:
    def test_detecting_again_adds_nothing_and_refreshes_a_new_one(self, w):
        tx = sale(w, discount="10")
        detect(w, tx)
        tx.document_discount = Decimal("12")
        w.db.commit()
        detect(w, tx)
        (row,) = found(w, "discount")
        assert row.amount == Decimal("12.00")

    def test_a_reviewed_one_is_never_reopened_or_rewritten(self, w):
        tx = sale(w, discount="10")
        detect(w, tx)
        (row,) = found(w)
        R.review_exception(row.id, ReviewIn(status="dismissed", note="ok"), **_ctx(w))
        tx.document_discount = Decimal("30")
        w.db.commit()
        detect(w, tx)
        (row,) = found(w)
        assert row.status == "dismissed" and row.amount == Decimal("10.00")

    def test_rescan_finds_history_once(self, w):
        sale(w, discount="10")
        sale(w, total="100", tip="40")
        first = R.rescan_exceptions(RescanIn(**{"from": "2026-09-01", "to": "2026-09-30"}),
                                    shop_id=None, machine_id=None, **_ctx(w))
        assert first.created == 2
        again = R.rescan_exceptions(RescanIn(**{"from": "2026-09-01", "to": "2026-09-30"}),
                                    shop_id=None, machine_id=None, **_ctx(w))
        assert again.created == 0 and len(found(w)) == 2

    def test_a_failing_detection_never_raises(self, w):
        def boom(db):
            raise RuntimeError("x")

        svc.detect_safely(w.db, boom)  # logged, swallowed


# ── Review and scoping ───────────────────────────────────────────────────────


class TestReviewAndScoping:
    @pytest.fixture
    def rows(self, w):
        detect(w, sale(w, w.tills[0], discount="10", cashier="pu-1"),
               sale(w, w.tills[1], total="100", tip="30", cashier="pu-2"),
               sale(w, w.other_till, discount="5", cashier="pu-3"))
        return found(w)

    def test_the_list_and_its_filters(self, w, rows):
        assert listed(w).total == 3
        assert listed(w, shop_id=w.shop.id).total == 2
        assert listed(w, machine_id=w.tills[1].id).items[0].type == "high_tip"
        assert listed(w, types="discount").total == 2
        assert listed(w, employee="pu-3").items[0].machine_id == w.other_till.id
        assert listed(w, company_id=w.company.id).total == 3
        out = listed(w, shop_id=w.shop.id).items[0]
        assert out.machine_name and out.shop_name == "Center" and out.transaction_number

    def test_review_dismiss_and_back(self, w, rows):
        target = listed(w, types="high_tip").items[0]
        out = R.review_exception(target.id, ReviewIn(status="reviewed", note="spoke with her"), **_ctx(w))
        assert out.status == "reviewed" and out.review_note == "spoke with her" and out.reviewed_by == "admin"
        assert listed(w, statuses="new").total == 2
        out = R.review_exception(target.id, ReviewIn(status="new"), **_ctx(w))
        assert out.status == "new" and out.reviewed_at is None

    def test_the_summary(self, w, rows):
        R.review_exception(listed(w, types="high_tip").items[0].id, ReviewIn(status="dismissed"), **_ctx(w))
        s = summary(w)
        assert (s.total, s.new, s.dismissed) == (3, 2, 1)
        assert {r.key: r.total for r in s.by_type} == {"discount": 2, "high_tip": 1}
        assert {r.key for r in s.by_employee} == {"pu-1", "pu-2", "pu-3"}

    def test_a_shop_manager_sees_and_reviews_their_shop_only(self, w, rows):
        assert listed(w, user=w.manager).total == 2
        assert listed(w, user=w.north_manager).total == 1
        theirs = listed(w, user=w.north_manager).items[0]
        assert refused(R.review_exception, theirs.id, ReviewIn(status="reviewed"), **_ctx(w, w.manager)).status_code == 404
        mine = [i.id for i in listed(w).items]
        out = R.review_exceptions(BulkReviewIn(ids=mine, status="reviewed"), **_ctx(w, w.manager))
        assert out == {"updated": 2}

    def test_a_cashier_sees_nothing(self, w, rows):
        assert refused(listed, w, user=w.cashier).status_code == 403

    def test_a_shift_supervisor_sees_but_cannot_review(self, w, rows, supervisor):
        items = listed(w, user=supervisor).items
        assert len(items) == 2
        assert refused(R.review_exception, items[0].id, ReviewIn(status="reviewed"),
                       **_ctx(w, supervisor)).status_code == 403

    def test_another_tenant_sees_nothing(self, w, rows):
        other = dict(current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db)
        out = R.list_exceptions(
            from_date=FROM, to_date=TO, company_id=None, shop_id=None, area_id=None, machine_id=None,
            types=None, employee=None, statuses=None, page=1, page_size=50, **other,
        )
        assert out.total == 0


# ── Rules API ────────────────────────────────────────────────────────────────


class TestRulesApi:
    def test_get_shows_own_inherited_and_effective(self, w):
        rule(w, "company", w.company.id, "long_order", minutes=20)
        rule(w, "shop", w.shop.id, "long_order", enabled=False)
        out = R.get_rules(level="shop", target_id=w.shop.id, **_ctx(w))
        lo = next(r for r in out.rules if r.type == "long_order")
        assert lo.own_enabled is False and lo.own_params == {}
        assert lo.inherited_enabled is True and lo.inherited_params == {"minutes": 20}
        assert lo.inherited_sources == {"enabled": None, "minutes": "company"}
        assert lo.effective_enabled is False and lo.effective_params == {"minutes": 20}
        assert out.can_write

    def test_put_sets_and_clears(self, w):
        R.put_rules(RulesPut(rules=[RuleIn(type="high_tip", enabled=True, params={"percent": 20})]),
                    level="machine", target_id=w.tills[0].id, **_ctx(w))
        assert svc.rules_for_machine(w.db, w.tills[0])["high_tip"].params == {"percent": 20}
        R.put_rules(RulesPut(rules=[RuleIn(type="high_tip")]), level="machine", target_id=w.tills[0].id, **_ctx(w))
        assert w.db.query(ExceptionRuleValue).count() == 0

    def test_tenant_level(self, w):
        out = R.put_rules(RulesPut(rules=[RuleIn(type="high_amount", enabled=True)]),
                          level="tenant", target_id=None, **_ctx(w))
        assert next(r for r in out.rules if r.type == "high_amount").effective_enabled
        assert svc.rules_for_machine(w.db, w.other_till)["high_amount"].enabled

    def test_bad_values_are_refused(self, w):
        for item in (RuleIn(type="nope"), RuleIn(type="long_order", params={"minutes": -1})):
            assert refused(R.put_rules, RulesPut(rules=[item]), level="shop", target_id=w.shop.id,
                           **_ctx(w)).status_code == 422

    def test_who_may_write_where(self, w):
        body = RulesPut(rules=[RuleIn(type="refund", enabled=False)])
        # A shop manager: their shop and its tills, not the company, not another shop.
        R.put_rules(body, level="shop", target_id=w.shop.id, **_ctx(w, w.manager))
        R.put_rules(body, level="machine", target_id=w.tills[0].id, **_ctx(w, w.manager))
        assert refused(R.put_rules, body, level="company", target_id=w.company.id,
                       **_ctx(w, w.manager)).status_code == 403
        assert refused(R.put_rules, body, level="shop", target_id=w.other_shop.id,
                       **_ctx(w, w.manager)).status_code == 403
        assert refused(R.put_rules, body, level="tenant", target_id=None,
                       **_ctx(w, w.company_manager)).status_code == 403
        R.put_rules(body, level="company", target_id=w.company.id, **_ctx(w, w.company_manager))
        assert refused(R.get_rules, level="shop", target_id=w.shop.id, **_ctx(w, w.cashier)).status_code == 403
        # A shop manager reads the company's values through their shop's "inherited".
        assert refused(R.get_rules, level="company", target_id=w.company.id,
                       **_ctx(w, w.manager)).status_code == 403
        assert R.get_rules(level="shop", target_id=w.shop.id, **_ctx(w, w.manager)).can_write

    def test_another_tenants_shop(self, w):
        assert refused(R.get_rules, level="shop", target_id=w.foreign_shop.id, **_ctx(w)).status_code in (403, 404)
