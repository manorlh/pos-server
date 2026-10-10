"""
The control board's "שוברים" card (`GET /reports/prepaid-vouchers`): how many prepaid
vouchers were redeemed in the scope over a period, by voucher name, against another period.

What it must never get wrong:

* the scope — the overview's: a shop manager counts their shop's redemptions only, asking
  for another shop counts nothing, another organization's are never seen;
* a reversed redemption (the payment was abandoned, the goods went back) counts nowhere;
* the grouping — one row per voucher name, distinct vouchers (a voucher used in parts once),
  redemptions, units, and the value: a discount's ₪, goods at their sale document's price.

The rows are built straight in the voucher tables (read-only for the board), on the world
of tests/test_shop_areas.py (NOW = 27.09.2026 18:00 UTC).
"""
from __future__ import annotations

import itertools
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.models.category import Category
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption
from app.models.product import CatalogLevel, Product
from app.models.transaction_item import TransactionItem
from app.routers import reports as reports_router
from app.services import voucher_board as VB
from app.services.dashboard_sections import rule_for
from shift_world import NOW, TODAY
from test_shop_areas import _ctx, create, members, w  # noqa: F401

YESTERDAY = TODAY - timedelta(days=1)
_codes = itertools.count(1)


def batch(w, name, kind="items", tenant_id=None, company=None, type_name=None):
    """A batch of its own type (the vouchers core: every batch has one) — named like the batch unless told."""
    from app.models.prepaid_voucher import PrepaidVoucherType

    tenant = tenant_id or w.tenant.id
    owner = (company or w.company).id
    vtype = PrepaidVoucherType(id=uuid.uuid4(), tenant_id=tenant, company_id=owner, name=type_name or name, kind=kind)
    w.db.add(vtype)
    w.db.flush()
    b = PrepaidVoucherBatch(
        id=uuid.uuid4(), tenant_id=tenant, company_id=owner, name=name, kind=kind,
        type_id=vtype.id, type_name=vtype.name,
    )
    w.db.add(b)
    w.db.flush()
    return b


def voucher(w, b):
    n = next(_codes)
    v = PrepaidVoucher(
        id=uuid.uuid4(), tenant_id=b.tenant_id, batch_id=b.id, serial=n, code=f"CODE{n:06d}", remaining={},
    )
    w.db.add(v)
    w.db.flush()
    return v


def redemption(w, v, till, *, items=(), uses=None, discount=None, when=NOW, reversed_=False, sale=None):
    r = PrepaidVoucherRedemption(
        id=uuid.uuid4(), tenant_id=v.tenant_id, voucher_id=v.id, batch_id=v.batch_id,
        machine_id=till.id if till is not None else None, shop_id=till.shop_id if till is not None else None,
        client_request_id=str(uuid.uuid4()),
        items=[{"productId": pid, "name": "x", "quantity": q} for pid, q in items],
        uses=uses, discount_amount=discount, redeemed_at=when,
        reversed_at=when if reversed_ else None,
        transaction_id=str(sale.id) if sale is not None else None,
    )
    w.db.add(r)
    w.db.flush()
    return r


def sold(w, tx, product, unit_price):
    w.db.add(
        TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_id=product.id, quantity=Decimal("1"),
            unit_price=Decimal(unit_price), total_price=Decimal(unit_price), product_name=product.name,
        )
    )
    w.db.flush()


def board(w, user=None, *, frm=TODAY, to=TODAY, cmp_from=None, cmp_to=None, **extra):
    args = dict(
        from_date=frm, to_date=to, cmp_from=cmp_from, cmp_to=cmp_to, tz="Asia/Jerusalem",
        company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, cmp_event_id=None,
    )
    args.update(extra)
    return reports_router.get_voucher_board_report(**args, **_ctx(w, user))


@pytest.fixture
def festival(w):
    """Two names in the center, one in the north; a reversal, yesterday's and a foreign one."""
    cat = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Food")
    w.db.add(cat)
    w.db.flush()

    def product(name, price):
        p = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, category_id=cat.id,
            catalog_level=CatalogLevel.GLOBAL, name=name, price=price, sku=f"sku-{name}",
        )
        w.db.add(p)
        w.db.flush()
        return p

    hotdog, drink = product("hotdog", 12), product("drink", 8)
    global HOTDOG, DRINK
    HOTDOG, DRINK = str(hotdog.id), str(drink.id)
    t1, t2 = w.tills
    staff = batch(w, "צוות הפקה")
    discount = batch(w, "הנחת אמנים", kind="order_discount")
    a, b = voucher(w, staff), voucher(w, staff)
    # Voucher a in two parts (counts once), b once; one of a's is reversed (counts nowhere).
    # Only a's first part has its sale document in the cloud: its goods at that document's price.
    sale = w.doc(t1, None, "30.00")
    sold(w, sale, hotdog, "12.00")
    sold(w, sale, drink, "8.00")
    redemption(w, a, t1, items=[(HOTDOG, 1), (DRINK, 1)], sale=sale)
    redemption(w, a, t2, items=[(DRINK, 1)])
    redemption(w, a, t2, items=[(HOTDOG, 5)], reversed_=True)
    redemption(w, b, t1, items=[(HOTDOG, 2)])
    # A discount voucher: 2 uses, 12.50 off.
    redemption(w, voucher(w, discount), t1, uses=2, discount=1250)
    # The north: one staff voucher.
    redemption(w, voucher(w, staff), w.other_till, items=[(DRINK, 3)])
    # Yesterday: one staff voucher in the center.
    redemption(w, voucher(w, staff), t1, items=[(HOTDOG, 1)], when=NOW - timedelta(days=1))
    w.db.commit()
    return dict(staff=staff, discount=discount)


HOTDOG = DRINK = ""


class TestVoucherBoard:
    def test_per_name_vouchers_redemptions_units_and_value(self, w, festival):
        out = board(w)
        by_name = {r.name: r for r in out.rows}
        staff = by_name["צוות הפקה"].current
        # a (twice, once reversed — not counted), b, and the north's: 3 vouchers, 4 redemptions.
        assert (staff.vouchers, staff.redemptions, staff.units) == (3, 4, 8.0)
        # Goods priced on their own sale document: 12 + 8 (the other goods' sales are not synced).
        assert staff.value == 20.0
        disc = by_name["הנחת אמנים"]
        assert disc.kind == "order_discount"
        assert (disc.current.vouchers, disc.current.redemptions, disc.current.units, disc.current.value) == (1, 1, 2.0, 12.5)
        assert (out.totals.vouchers, out.totals.redemptions, out.totals.value) == (4, 5, 32.5)
        assert [r.name for r in out.rows] == ["צוות הפקה", "הנחת אמנים"]
        assert out.previous is None and out.deltas is None

    def test_a_reversed_redemption_counts_nowhere(self, w, festival):
        before = board(w).totals
        till = w.tills[0]
        redemption(w, voucher(w, festival["staff"]), till, items=[(HOTDOG, 9)], reversed_=True)
        w.db.commit()
        after = board(w).totals
        assert after == before

    def test_scoped_like_the_overview(self, w, festival):
        mine = board(w, user=w.manager)
        assert (mine.totals.vouchers, mine.totals.redemptions) == (3, 4)
        assert board(w, user=w.manager, shop_id=w.other_shop.id).rows == []
        north = board(w, user=w.north_manager)
        assert [(r.name, r.current.vouchers, r.current.units) for r in north.rows] == [("צוות הפקה", 1, 3.0)]
        assert board(w, user=w.company_manager).totals.vouchers == 4
        assert board(w, machine_id=w.tills[1].id).totals.redemptions == 1
        assert board(w, shop_id=w.foreign_shop.id).rows == []

    def test_another_organizations_redemptions_are_never_seen(self, w, festival):
        from app.models.company import Company
        from app.models.pos_machine import PairingStatus, POSMachine

        far_company = w.db.query(Company).filter(Company.tenant_id == w.foreign_shop.tenant_id).one()
        far_till = POSMachine(
            id=uuid.uuid4(), tenant_id=w.foreign_shop.tenant_id, shop_id=w.foreign_shop.id,
            distributor_id=w.admin.id, name="Far 1", machine_code="FAR-1", pos_number="1",
            is_active=True, pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add(far_till)
        far = batch(w, "זר", tenant_id=w.foreign_shop.tenant_id, company=far_company)
        v = voucher(w, far)
        redemption(w, v, far_till, items=[(DRINK, 1)])
        w.db.commit()
        assert "זר" not in {r.name for r in board(w).rows}
        assert board(w).totals.vouchers == 4

    def test_a_point_of_sale_is_its_tills(self, w, festival):
        bar = create(w, "Bar")
        members(w, bar["id"], w.tills[1])
        assert board(w, area_id=str(bar["id"])).totals.redemptions == 1

    def test_against_yesterday_with_the_change(self, w, festival):
        out = board(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        assert (out.previous.vouchers, out.previous.units) == (1, 1.0)
        assert out.deltas["vouchers"].abs == 3 and out.deltas["vouchers"].pct == 300.0
        disc = next(r for r in out.rows if r.name == "הנחת אמנים")
        # Nothing the day before: "new", never a division by zero.
        assert disc.previous.vouchers == 0 and disc.deltas["vouchers"].pct is None

    def test_a_name_used_only_in_the_compared_period_is_listed_with_zeros(self, w, festival):
        old = batch(w, "ישן")
        redemption(w, voucher(w, old), w.tills[0], items=[(DRINK, 1)], when=NOW - timedelta(days=1))
        w.db.commit()
        out = board(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        row = next(r for r in out.rows if r.name == "ישן")
        assert row.current.vouchers == 0 and row.previous.vouchers == 1
        assert row.deltas["vouchers"].pct == -100.0

    def test_nothing_redeemed_is_empty(self, w):
        out = board(w, cmp_from=YESTERDAY, cmp_to=YESTERDAY)
        assert out.rows == [] and out.totals.vouchers == 0
        assert out.deltas["value"].pct == 0.0

    def test_the_name_is_one_function(self, w):
        b = batch(w, "פסטיבל")
        assert VB.voucher_display_name(b) == "פסטיבל"

    def test_open_to_reports_or_vouchers(self):
        assert rule_for("GET", "/reports/prepaid-vouchers").describe("GET") == "reports|prepaid_vouchers|cockpit:view"


def test_the_card_follows_an_event(w, festival):
    from app.models.report_event import ReportEvent, ReportEventMachine

    # 20:00–23:00 local tonight, till 2 only: voucher a's second part.
    e = ReportEvent(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id, name="Night",
        starts_at=NOW - timedelta(hours=1), ends_at=NOW + timedelta(hours=2), timezone="Asia/Jerusalem",
    )
    w.db.add(e)
    w.db.flush()
    w.db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e.id, machine_id=w.tills[1].id))
    w.db.commit()
    out = board(w, event_id=e.id)
    assert (out.totals.vouchers, out.totals.redemptions, out.totals.units) == (1, 1, 1.0)


def test_while_the_day_runs_the_compared_day_is_cut_like_for_like(w, festival):
    from app.services.reports import resolve_report_window

    # Yesterday 23:00 local: after the point today has reached (21:00).
    redemption(w, voucher(w, festival["staff"]), w.tills[0], items=[(HOTDOG, 4)], when=NOW - timedelta(hours=22))
    w.db.commit()
    today = resolve_report_window(w.db, w.tenant.id, from_date=TODAY, to_date=TODAY, tz="Asia/Jerusalem")
    yesterday = resolve_report_window(w.db, w.tenant.id, from_date=YESTERDAY, to_date=YESTERDAY, tz="Asia/Jerusalem")
    cut = VB.build_voucher_board(w.db, w.admin, w.tenant.id, today, yesterday, now=NOW)
    assert (cut.previous.vouchers, cut.previous.units) == (1, 1.0)
    whole = VB.build_voucher_board(w.db, w.admin, w.tenant.id, today, yesterday, now=NOW + timedelta(days=2))
    assert (whole.previous.vouchers, whole.previous.units) == (2, 5.0)


def test_the_postgres_sql_expands_the_items_in_the_database():
    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from app.models.prepaid_voucher import PrepaidVoucherRedemption as R

    ids = select(R.id)
    goods = str(VB.goods_statement(True, ids).compile(dialect=postgresql.dialect()))
    assert "json_array_elements(CASE WHEN (json_typeof(" in goods
    assert "->> " in goods and "GROUP BY prepaid_voucher_redemptions.batch_id" in goods
    prices = str(VB.prices_statement(True, ids, []).compile(dialect=postgresql.dialect()))
    # One query: the sales named by the redemptions, cast to the documents' id — never a list.
    assert "CAST(prepaid_voucher_redemptions.transaction_id AS UUID)" in prices
    assert "prepaid_voucher_redemptions.transaction_id ~" in prices


def test_aggregated_in_a_fixed_number_of_queries(w, festival):
    from sqlalchemy import event

    def count():
        seen = []
        engine = w.db.get_bind()
        listener = lambda *a, **k: seen.append(1)  # noqa: E731
        event.listen(engine, "before_cursor_execute", listener)
        try:
            board(w)
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        return len(seen)

    count()
    before = count()
    for _ in range(20):
        redemption(w, voucher(w, festival["staff"]), w.tills[0], items=[(HOTDOG, 1)])
    w.db.commit()
    count()  # warm again: the commit expired the user and tenant rows
    assert count() == before


def test_the_card_names_a_voucher_by_its_type_else_by_its_batch():
    """The vouchers core's types (wired at the integration merge): the type's name the batch was
    issued as wins; a batch without one (blank) keeps its own name."""
    typed = PrepaidVoucherBatch(name="סדרה 7", type_name="שובר צוות")
    assert VB.voucher_display_name(typed) == "שובר צוות"
    assert VB.voucher_display_name(PrepaidVoucherBatch(name="סדרה 7", type_name="  ")) == "סדרה 7"
    assert VB.voucher_display_name(PrepaidVoucherBatch(name=None, type_name=None)) == "—"
