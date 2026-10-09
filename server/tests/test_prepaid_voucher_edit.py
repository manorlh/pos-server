"""
"ערוך סדרה" (app/services/prepaid_voucher_edit.py): every setting of a batch after it was set up,
by category — free (no warning), validity, where, the rules of use and the accounting (redemptions
from now on), the contents (unredeemed vouchers; partly redeemed ones only when asked), the quantity
(more is issued, never fewer) and the production price (prices section, vouchers issued from now on).
Codes, serials, the kind and the company never change. Every edit is one logged "update", before → after.
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherEvent,
    PrepaidVoucherOfflineAssignment,
    PrepaidVoucherRedemption,
)
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidOfflineAssignIn, PrepaidVoucherBatchCreate, PrepaidVoucherBatchUpdate
from app.services import prepaid_voucher_edit as PVE
from app.services import prepaid_voucher_offline as PVO
from app.services import prepaid_voucher_types as PVT
from app.services import prepaid_vouchers as PV
from test_prepaid_vouchers import _ctx, make_batch, redeem, vouchers, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def edit(w, b, user=None, **body):
    return R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(**body), **_ctx(w, user))


def preview(w, b, user=None, **body):
    return R.preview_prepaid_voucher_batch_edit(b["id"], PrepaidVoucherBatchUpdate(**body), **_ctx(w, user))


def by_field(plan):
    return {c["field"]: c for c in plan["changes"]}


def rows(w, b):
    return sorted(w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(b["id"])), key=lambda v: v.serial)


def updates(w, b):
    return [e for e in R.prepaid_voucher_events(b["id"], **_ctx(w))["items"] if e["action"] == "update"]


def discount_batch(w, count=3, **terms):
    body = {"name": "שובר הנחה", "companyId": w.company.id, "count": count, "kind": "order_discount",
            "discountType": "fixed", "discountValue": 30, **terms}
    return R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(**body), **_ctx(w))


class TestFree:
    def test_texts_and_print_settings_need_no_confirmation_and_keep_the_codes(self, w):
        b = make_batch(w, count=2)
        before = [(v.serial, v.code) for v in rows(w, b)]
        plan = preview(w, b, name="פסטיבל החורף", customerName="הפקות כהן", eventName="חורף", orderRef="PO-1",
                       freeText="שורה", showItems=False, showCredit=False, barcodeType="code128")
        assert plan["confirm"] is False and set(plan["effects"]) == {"free"}
        assert by_field(plan)["name"] == {"field": "name", "category": "free", "before": "הפקה — פסטיבל", "after": "פסטיבל החורף"}
        out = edit(w, b, name="פסטיבל החורף", customerName="הפקות כהן", showItems=False)
        assert (out["name"], out["customerName"], out["showItems"]) == ("פסטיבל החורף", "הפקות כהן", False)
        # A reprint keeps the same codes and serials.
        assert [(v.serial, v.code) for v in rows(w, b)] == before
        (line,) = updates(w, b)
        assert line["details"]["fields"] == ["customer_name", "name", "show_items"]
        assert {c["field"]: (c["before"], c["after"]) for c in line["details"]["changes"]}["customerName"] == (None, "הפקות כהן")
        assert line["userName"]

    def test_nothing_changed_is_no_log_line(self, w):
        b = make_batch(w, count=1)
        assert preview(w, b, name="הפקה — פסטיבל")["changes"] == []
        edit(w, b, name="הפקה — פסטיבל", showCredit=None)
        assert updates(w, b) == []

    def test_the_preview_writes_nothing(self, w):
        b = make_batch(w, count=2)
        preview(w, b, name="אחר", count=5, items=[{"productId": w.hotdog.id, "quantity": 3}])
        row = w.db.query(PrepaidVoucherBatch).one()
        assert (row.name, row.next_serial, len(rows(w, b))) == ("הפקה — פסטיבל", 3, 2)
        assert rows(w, b)[0].remaining == {str(w.hotdog.id): 1, str(w.drink.id): 2}


class TestValidity:
    def test_the_dates_touch_every_open_voucher(self, w):
        b = make_batch(w, count=3, split=True)
        redeem(w, rows(w, b)[0].code, [(w.hotdog, 1), (w.drink, 2)])  # used
        redeem(w, rows(w, b)[1].code, [(w.hotdog, 1)])  # partly
        until = datetime(2026, 12, 31, 21, 59, tzinfo=timezone.utc)
        plan = preview(w, b, validUntil=until)
        assert plan["confirm"] is True
        assert plan["effects"]["validity"] == {"vouchers": 2}
        assert by_field(plan)["validUntil"]["after"] == until.isoformat()
        assert edit(w, b, validUntil=until)["validUntil"] == until.isoformat()
        # Cleared: no validity limit.
        assert edit(w, b, validUntil=None)["validUntil"] is None

    def test_until_must_be_after_from(self, w):
        now = datetime.now(timezone.utc)
        b = make_batch(w, count=1, valid_from=now)
        assert refused(edit, w, b, validUntil=now - timedelta(days=1)).status_code == 400


class TestWhere:
    def test_the_shops_are_the_companys_and_a_shop_manager_cannot_widen_them(self, w):
        b = make_batch(w, count=1, shops=[w.shop.id], user=w.manager)
        assert edit(w, b, shopIds=[w.shop.id])["shopIds"] == [str(w.shop.id)]
        assert refused(edit, w, b, user=w.manager, shopIds=None).status_code == 403
        assert refused(edit, w, b, shopIds=[uuid.uuid4()]).detail == PV.SHOP_INVALID
        plan = preview(w, b, shopIds=[w.shop.id, w.other_shop.id])
        assert plan["effects"]["where"] == {"vouchers": 1}
        assert by_field(plan)["shopIds"]["after"] == sorted([str(w.shop.id), str(w.other_shop.id)])

    def test_an_assigned_batch_keeps_its_device_and_the_device_downloads_again(self, w):
        body = PrepaidVoucherBatchCreate(name="אופליין", companyId=w.company.id, count=2, offlineAllowed=True,
                                         redemptionAccounting="payment", items=[{"productId": w.hotdog.id, "quantity": 1}])
        b = R.create_prepaid_voucher_batch(body, **_ctx(w))
        R.assign_prepaid_batch_offline(b["id"], PrepaidOfflineAssignIn(target="machine", machineId=str(w.tills[0].id)), **_ctx(w))
        assert refused(edit, w, b, shopIds=[w.other_shop.id]).detail == PVE.OFFLINE_SHOP
        assert refused(edit, w, b, offlineAllowed=False).detail == PVO.OFFLINE_ASSIGNED
        assert preview(w, b, stacking="single")["effects"]["rules"] == {"vouchers": 2}
        edit(w, b, stacking="single")
        assert w.db.query(PrepaidVoucherOfflineAssignment).one().version == 2
        # A free change is no reason to download again.
        edit(w, b, name="אופליין 2")
        assert w.db.query(PrepaidVoucherOfflineAssignment).one().version == 2


class TestFromNowOn:
    def test_accounting_and_pricing_apply_to_redemptions_from_now_on(self, w):
        b = make_batch(w, count=2, split=True)
        redeem(w, rows(w, b)[0].code, [(w.hotdog, 1)])
        plan = preview(w, b, redemptionAccounting="discount", pricing="fixed", tillValue=40)
        assert plan["effects"]["accounting"] == {"vouchers": 2}
        assert {c["field"] for c in plan["changes"]} == {"redemptionAccounting", "pricing", "tillValue", "allowTopUp"}
        out = edit(w, b, redemptionAccounting="discount", pricing="fixed", tillValue=40)
        assert (out["redemptionAccounting"], out["pricing"], out["tillValue"], out["allowTopUp"]) == ("discount", "fixed", 40.0, False)
        # The redemption made before keeps how it was booked.
        assert w.db.query(PrepaidVoucherRedemption).one().redemption_accounting == "payment"

    def test_a_fixed_value_needs_its_value(self, w):
        b = make_batch(w, count=1)
        assert refused(edit, w, b, pricing="fixed").status_code == 422

    def test_vouchers_per_sale(self, w):
        b = make_batch(w, count=1)
        plan = preview(w, b, stacking="unlimited", maxVouchersPerSale=3)
        assert plan["effects"]["rules"] == {"vouchers": 1}
        assert edit(w, b, stacking="unlimited", maxVouchersPerSale=3)["maxVouchersPerSale"] == 3


class TestContents:
    def test_goods_reach_the_unredeemed_and_the_partly_redeemed_only_when_asked(self, w):
        b = make_batch(w, count=3, split=True)  # hot dog ×1, drink ×2
        redeem(w, rows(w, b)[1].code, [(w.hotdog, 1)])  # partly: hot dog used
        new_items = [{"productId": w.hotdog.id, "quantity": 2}, {"productId": w.drink.id, "quantity": 1}]
        plan = preview(w, b, items=new_items)
        assert plan["effects"]["contents"] == {"unredeemed": 2, "partial": 1, "applyToPartial": False, "vouchers": 2}
        assert [i["quantity"] for i in by_field(plan)["items"]["after"]] == [2, 1]
        edit(w, b, items=new_items)
        h, d = str(w.hotdog.id), str(w.drink.id)
        v = rows(w, b)
        assert v[0].remaining == {h: 2, d: 1} and v[2].remaining == {h: 2, d: 1}
        assert (v[1].remaining, v[1].status) == ({h: 0, d: 2}, "partially_used")
        # "החל גם על שוברים במימוש חלקי": the new contents less what it already used.
        plan = preview(w, b, items=[{"productId": w.hotdog.id, "quantity": 3}, {"productId": w.drink.id, "quantity": 1}],
                       applyToPartial=True)
        assert plan["effects"]["contents"]["vouchers"] == 3
        edit(w, b, items=[{"productId": w.hotdog.id, "quantity": 3}, {"productId": w.drink.id, "quantity": 1}], applyToPartial=True)
        v = rows(w, b)
        assert v[1].remaining == {h: 2, d: 1} and v[0].remaining == {h: 3, d: 1}
        (line, _first) = updates(w, b)
        assert line["details"]["applyToPartial"] is True and line["details"]["refit"] == {"unredeemed": 2, "partial": 1}

    def test_less_than_was_used_leaves_nothing_and_the_voucher_is_used(self, w):
        b = make_batch(w, count=1, split=True)
        redeem(w, rows(w, b)[0].code, [(w.drink, 2)])
        edit(w, b, items=[{"productId": w.drink.id, "quantity": 1}], applyToPartial=True)
        (v,) = rows(w, b)
        assert (v.remaining, v.status) == ({str(w.drink.id): 0}, "used")

    def test_a_used_or_cancelled_voucher_is_never_touched(self, w):
        b = make_batch(w, count=2)
        redeem(w, rows(w, b)[0].code, [(w.hotdog, 1), (w.drink, 2)])
        R.cancel_prepaid_voucher(str(rows(w, b)[1].id), None, **_ctx(w))
        edit(w, b, items=[{"productId": w.hotdog.id, "quantity": 5}], applyToPartial=True)
        used, cancelled = rows(w, b)
        assert (used.status, used.remaining) == ("used", {str(w.hotdog.id): 0, str(w.drink.id): 0})
        assert (cancelled.status, cancelled.remaining) == ("cancelled", {str(w.hotdog.id): 1, str(w.drink.id): 2})

    def test_a_discounts_uses_and_value(self, w):
        b = discount_batch(w, count=2, usesPerVoucher=3)
        partly = rows(w, b)[1]
        # Two of its three uses taken (as confirm records them).
        w.db.add(PrepaidVoucherRedemption(id=uuid.uuid4(), tenant_id=w.tenant.id, voucher_id=partly.id, batch_id=partly.batch_id,
                                          client_request_id="r-1", items=[], uses=2))
        partly.uses_left, partly.status = 1, "partially_used"
        w.db.commit()
        plan = preview(w, b, usesPerVoucher=5, discountValue=40)
        assert {c["field"] for c in plan["changes"]} == {"usesPerVoucher", "discountValue"}
        edit(w, b, usesPerVoucher=5, discountValue=40)
        v = rows(w, b)
        assert (v[0].uses_left, v[1].uses_left) == (5, 1)
        edit(w, b, usesPerVoucher=4, applyToPartial=True)
        assert [x.uses_left for x in rows(w, b)] == [4, 2]  # 2 used (its redemptions say so): 4 − 2 left

    def test_the_kind_never_changes(self, w):
        b = make_batch(w, count=1)
        assert refused(edit, w, b, kind="order_discount").detail == PVE.KIND_FIXED
        assert edit(w, b, kind="items")["kind"] == "items"

    def test_a_product_that_became_unusable_blocks_only_an_edit_of_the_goods(self, w):
        b = make_batch(w, count=1)
        w.hotdog.is_open_price = True  # since the batch was made: an open price has no value for a goods voucher
        w.db.commit()
        assert edit(w, b, stacking="unlimited", redemptionAccounting="discount")["stacking"] == "unlimited"
        assert refused(edit, w, b, items=[{"productId": w.hotdog.id, "quantity": 2}]).status_code in (400, 422)

    def test_the_goods_are_checked_as_at_setup(self, w):
        b = make_batch(w, count=1)
        assert refused(edit, w, b, items=[{"productId": w.general.id, "quantity": 1}]).status_code in (400, 422)
        assert refused(edit, w, b, items=[]).status_code == 422


class TestQuantity:
    def test_more_is_issued_with_the_next_serials_never_fewer(self, w):
        b = make_batch(w, count=3)
        plan = preview(w, b, count=5)
        assert plan["effects"]["quantity"] == {"issued": 3, "issue": 2}
        out = edit(w, b, count=5)
        assert (out["issuedCount"], [v.serial for v in rows(w, b)]) == (5, [1, 2, 3, 4, 5])
        assert len({v.code for v in rows(w, b)}) == 5
        assert refused(edit, w, b, count=4).detail == PVE.COUNT_BELOW_ISSUED
        assert preview(w, b, count=5)["changes"] == []
        actions = [e["action"] for e in R.prepaid_voucher_events(b["id"], **_ctx(w))["items"]]
        assert actions[:2] == ["add", "update"] or actions[:2] == ["update", "add"]


class TestProductionPrice:
    def test_from_the_next_serial_on_and_only_with_the_prices_section(self, w, monkeypatch):
        b = make_batch(w, count=2)
        edit(w, b, productionPrice=10)
        plan = preview(w, b, productionPrice=12, count=4)
        assert plan["effects"]["price"] == {"fromSerial": 3, "issued": 2}
        edit(w, b, productionPrice=12, count=4)
        batch = w.db.query(PrepaidVoucherBatch).one()
        # Serials 1–2 were issued with no price: the new one is for the vouchers issued from now on.
        assert [PVE.production_price_of(batch, s) for s in (1, 2, 3, 4)] == [None, None, 1200, 1200]
        # Changed twice before serial 3 was issued: the last word stands.
        assert [(h["fromSerial"], h["priceAgorot"]) for h in batch.production_price_history] == [(1, None), (3, 1200)]
        edit(w, b, productionPrice=15, count=5)
        batch = w.db.query(PrepaidVoucherBatch).one()
        assert [PVE.production_price_of(batch, s) for s in (2, 4, 5)] == [None, 1200, 1500]
        # Without the section: no price in the plan or the log, and no changing it.
        monkeypatch.setattr(PVT, "prices_visible", lambda db, user, level="view": False)
        assert refused(edit, w, b, productionPrice=15).detail == PVT.PRICES_FORBIDDEN
        assert "productionPrice" not in {c["field"] for c in preview(w, b, name="x")["changes"]}
        hidden = [c for e in updates(w, b) for c in e["details"]["changes"] if c["field"] == "productionPrice"]
        assert hidden and all("before" not in c and "after" not in c for c in hidden)


class TestCancelled:
    def test_only_free_changes_on_a_cancelled_batch(self, w):
        b = make_batch(w, count=1)
        R.cancel_prepaid_voucher_batch(b["id"], None, **_ctx(w))
        assert edit(w, b, name="בוטלה")["name"] == "בוטלה"
        assert refused(edit, w, b, count=3).detail == PV.BATCH_CANCELLED


def test_the_migration():
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = ROOT / "alembic" / "versions" / "f3a9c1d7e520_prepaid_batch_edit.py"
    spec = importlib.util.spec_from_file_location("migration_f3a9c1d7e520", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "e2b6d9f41c83"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY)"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        assert "production_price_history" in {c["name"] for c in sa.inspect(conn).get_columns("prepaid_voucher_batches")}
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    assert "ALTER TABLE prepaid_voucher_batches ADD COLUMN production_price_history JSON" in buf.getvalue()
