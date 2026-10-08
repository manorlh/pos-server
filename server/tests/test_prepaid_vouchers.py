"""
Prepaid vouchers ("שוברי הפקה"): batches made on the dashboard, redeemed at the tills by QR.

What each class pins:

* **Batches** — a batch issues `count` vouchers with serials 1..n and unique,
  unguessable codes; only global products of the tenant; shops must be the company's;
  a shop manager only for their own shop; more vouchers continue the serials.
* **Redemption** — full; in parts when the batch allows it; a partial one refused when
  it does not, unless the rest is explicitly forfeited; never more than is left.
* **Safety** — a second redemption of a used voucher is refused; a retry with the same
  `clientRequestId` returns the first answer and takes nothing more; the voucher's row
  is locked (`FOR UPDATE`) for the redemption.
* **Where and when** — expired / not yet valid, another shop or company, another tenant
  (404), cancelled voucher or batch.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherAddIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherLookupIn,
    PrepaidVoucherRedeemIn,
)
from app.services import prepaid_vouchers as PV
from shift_world import accept_str_uuids, make_world


# ── World ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    db = world.db
    cat = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Food")
    db.add(cat)
    db.flush()

    def product(name, price, **kw):
        p = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
            category_id=cat.id, catalog_level=CatalogLevel.GLOBAL, name=name, price=price,
            sku=f"sku-{name}", **kw,
        )
        db.add(p)
        return p

    world.hotdog = product("נקניקייה", 25)
    world.drink = product("שתייה", 12)
    world.general = product("כללי", 0, is_general=True)
    db.flush()
    for p in (world.hotdog, world.drink):
        db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=p.id, is_listed=True))
    world.manager = User(
        id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world.tenant.id,
        email="m@x", username="manager", shop_id=world.shop.id,
    )
    world.cashier = User(
        id=uuid.uuid4(), role=UserRole.CASHIER, tenant_id=world.tenant.id,
        email="c@x", username="cashier", shop_id=world.shop.id,
    )
    db.add_all([world.manager, world.cashier])
    db.commit()
    return world


def _ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def make_batch(w, *, count=3, split=False, user=None, shops=None, valid_from=None, valid_until=None, items=None):
    body = PrepaidVoucherBatchCreate(
        name="הפקה — פסטיבל",
        companyId=w.company.id,
        shopIds=shops,
        eventName="פסטיבל הקיץ",
        freeText="בתוקף 12–14.8",
        validFrom=valid_from,
        validUntil=valid_until,
        splitAllowed=split,
        items=items or [
            {"productId": w.hotdog.id, "quantity": 1},
            {"productId": w.drink.id, "quantity": 2},
        ],
        count=count,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w, user))


def vouchers(w, batch):
    return R.list_prepaid_vouchers(
        batch["id"], status_filter=None, serial=None, limit=5000, offset=0, **_ctx(w)
    )["items"]


def first_code(w, batch, n=0):
    return vouchers(w, batch)[n]["code"]


def lookup(w, code, till=None):
    till = till or w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code), machine=till, db=w.db)


def redeem(w, code, items, *, till=None, request_id=None, forfeit=False):
    till = till or w.tills[0]
    body = PrepaidVoucherRedeemIn(
        code=code,
        items=[{"productId": str(p.id if hasattr(p, "id") else p), "quantity": q} for p, q in items],
        clientRequestId=request_id or str(uuid.uuid4()),
        forfeitRest=forfeit,
        posUserId=7,
        posUserName="דנה",
    )
    return R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def remaining(out):
    return {i["name"]: i["remaining"] for i in out["voucher"]["items"]}


# ── Batches ───────────────────────────────────────────────────────────────────


class TestBatches:
    def test_a_batch_issues_numbered_vouchers_with_unique_codes(self, w):
        batch = make_batch(w, count=50)
        rows = vouchers(w, batch)
        assert [v["serial"] for v in rows] == list(range(1, 51))
        codes = [v["code"] for v in rows]
        assert len(set(codes)) == 50
        assert all(len(c) == PV.CODE_LENGTH and set(c) <= set(PV.CODE_ALPHABET) for c in codes)
        assert rows[0]["qrPayload"] == "PV:" + codes[0]
        assert rows[0]["displayCode"].count("-") == 3
        assert batch["stats"] == {"total": 50, "active": 50, "partiallyUsed": 0, "used": 0, "cancelled": 0}
        assert [i["quantity"] for i in batch["items"]] == [1, 2]
        assert batch["items"][0]["name"] == "נקניקייה"

    def test_more_vouchers_continue_the_serials(self, w):
        batch = make_batch(w, count=2)
        out = R.add_prepaid_vouchers(batch["id"], PrepaidVoucherAddIn(count=3), **_ctx(w))
        assert out["stats"]["total"] == 5
        assert [v["serial"] for v in vouchers(w, batch)] == [1, 2, 3, 4, 5]

    def test_codes_are_normalized_from_what_was_scanned_or_typed(self):
        assert PV.normalize_code(" pv:abcd-efgh 2345-6789 ") == "ABCDEFGH23456789"
        assert PV.format_code("ABCDEFGH23456789") == "ABCD-EFGH-2345-6789"

    def test_only_products_of_the_tenant_and_never_the_general_item(self, w):
        # The general item has no identity: refused with why (docs/SPEC_VOUCHER_PRODUCTION.md §7.14).
        assert refused(make_batch, w, items=[{"productId": w.general.id, "quantity": 1}]).detail == \
            PV.product_refusal(PV.BLOCK_GENERAL) == "prepaid_voucher_product_general"
        assert refused(make_batch, w, items=[{"productId": uuid.uuid4(), "quantity": 1}]).detail == PV.PRODUCT_INVALID

    def test_the_picker_shows_what_a_batch_may_carry_and_why_not(self, w):
        # 07.10.2026: the picker listed every company's products and the save refused one of
        # another company as "אינו מתאים"; then it hid what it could not take. Now (the owner,
        # "תוודא ששוברי הפקה תומכים בכל סוגי המוצרים") it shows each with whether it can go on
        # and why not — the save's own rule.
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="חברה אחרת")
        w.db.add(other)
        w.db.flush()
        foreign = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, category_id=w.hotdog.category_id,
            catalog_level=CatalogLevel.GLOBAL, name="של חברה אחרת", price=5, sku="sku-foreign",
        )
        w.db.add(foreign)
        w.db.commit()

        def offered(search=None):
            out = R.list_prepaid_voucher_products(company_id=str(w.company.id), search=search, limit=50, **_ctx(w))
            return [(p["name"], p["blocked"]["goods"]) for p in out["items"]]

        # The usable ones first; the general item with its reason; another company's only when searched for.
        assert offered() == [("נקניקייה", None), ("שתייה", None), ("כללי", "general")]
        assert offered("שתי") == [("שתייה", None)]
        assert offered("חברה") == [("של חברה אחרת", "other_company")]
        # …and what the picker marks is what the save refuses; what it does not, it takes.
        assert refused(make_batch, w, items=[{"productId": foreign.id, "quantity": 1}]).detail == \
            PV.product_refusal(PV.BLOCK_OTHER_COMPANY)
        assert make_batch(w, items=[{"productId": w.drink.id, "quantity": 1}])["items"][0]["name"] == "שתייה"

    def test_the_form_is_validated(self, w):
        with pytest.raises(ValidationError):
            PrepaidVoucherBatchCreate(name=" ", companyId=w.company.id, items=[{"productId": w.hotdog.id, "quantity": 1}], count=1)
        with pytest.raises(ValidationError):  # the same product twice
            PrepaidVoucherBatchCreate(
                name="x", companyId=w.company.id, count=1,
                items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.hotdog.id, "quantity": 1}],
            )
        with pytest.raises(ValidationError):
            PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, items=[], count=1)

    def test_a_shop_manager_only_for_their_own_shop(self, w):
        assert refused(make_batch, w, user=w.manager).status_code == 403
        assert refused(make_batch, w, user=w.manager, shops=[w.other_shop.id]).status_code == 403
        batch = make_batch(w, user=w.manager, shops=[w.shop.id])
        assert [b["id"] for b in R.list_prepaid_voucher_batches(True, **_ctx(w, w.manager))["items"]] == [batch["id"]]
        assert refused(make_batch, w, user=w.cashier, shops=[w.shop.id]).status_code == 403

    def test_a_shop_of_another_company_is_refused(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="2")
        w.db.add(other)
        w.db.flush()
        far = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="Far", settings={})
        w.db.add(far)
        w.db.commit()
        assert refused(make_batch, w, shops=[far.id]).detail == PV.SHOP_INVALID


# ── Redemption ────────────────────────────────────────────────────────────────


class TestRedemption:
    def test_lookup_shows_the_goods_with_the_tills_ids(self, w):
        batch = make_batch(w)
        out = lookup(w, "pv:" + PV.format_code(first_code(w, batch)).lower())
        assert out["redeemable"] is True and out["reason"] is None
        assert out["eventName"] == "פסטיבל הקיץ" and out["serial"] == 1
        assert [(i["tillProductId"], i["remaining"], i["price"]) for i in out["items"]] == [
            (str(w.hotdog.id), 1, 25.0), (str(w.drink.id), 2, 12.0),
        ]

    def test_the_tills_local_copy_id_is_used_and_understood(self, w):
        till = w.tills[0]
        local = Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, category_id=w.hotdog.category_id,
            catalog_level=CatalogLevel.LOCAL, global_product_id=w.hotdog.id, pos_machine_id=till.id,
            name="נקניקייה", price=25, sku="local-hd",
        )
        w.db.add(local)
        w.db.commit()
        batch = make_batch(w, split=True)
        code = first_code(w, batch)
        assert lookup(w, code)["items"][0]["tillProductId"] == str(local.id)
        out = redeem(w, code, [(local.id, 1)])
        assert remaining(out) == {"נקניקייה": 0, "שתייה": 2}
        assert out["redeemed"][0]["tillProductId"] == str(local.id)

    def test_full_redemption_uses_the_voucher_up(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        assert out["ok"] and not out["replayed"]
        assert out["voucher"]["status"] == "used" and out["voucher"]["redeemable"] is False
        assert remaining(out) == {"נקניקייה": 0, "שתייה": 0}
        assert out["forfeited"] == []
        row = w.db.query(PrepaidVoucherRedemption).one()
        assert row.pos_user_id == "7" and row.machine_id == w.tills[0].id and row.shop_id == w.shop.id

    def test_partial_redemption_when_the_batch_allows_it(self, w):
        batch = make_batch(w, split=True)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1)])
        assert out["voucher"]["status"] == "partially_used"
        assert remaining(out) == {"נקניקייה": 0, "שתייה": 2}
        out = redeem(w, code, [(w.drink, 1)], till=w.tills[1])
        assert remaining(out) == {"נקניקייה": 0, "שתייה": 1}
        out = redeem(w, code, [(w.drink, 1)])
        assert out["voucher"]["status"] == "used"
        detail = R.get_prepaid_voucher(out["voucher"]["id"], **_ctx(w))
        assert len(detail["redemptions"]) == 3
        assert detail["redemptions"][1]["machineName"] == "Till 2"
        stats = R.get_prepaid_voucher_batch(batch["id"], **_ctx(w))["stats"]
        assert (stats["used"], stats["active"]) == (1, 2)

    def test_partial_redemption_is_refused_when_the_batch_does_not_allow_it(self, w):
        batch = make_batch(w, split=False)
        code = first_code(w, batch)
        assert refused(redeem, w, code, [(w.hotdog, 1)]).detail == PV.PARTIAL_NOT_ALLOWED
        assert lookup(w, code)["status"] == "active"
        assert w.db.query(PrepaidVoucherRedemption).count() == 0

    def test_a_one_time_voucher_can_be_taken_in_part_by_forfeiting_the_rest(self, w):
        batch = make_batch(w, split=False)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1)], forfeit=True)
        assert out["voucher"]["status"] == "used"
        assert remaining(out) == {"נקניקייה": 0, "שתייה": 0}
        assert [(f["name"], f["quantity"]) for f in out["forfeited"]] == [("שתייה", 2)]

    def test_never_more_than_is_left_or_what_is_not_on_it(self, w):
        batch = make_batch(w, split=True)
        code = first_code(w, batch)
        assert refused(redeem, w, code, [(w.drink, 3)]).detail == PV.INSUFFICIENT
        assert refused(redeem, w, code, [(w.drink, 2), (w.drink, 1)]).detail == PV.INSUFFICIENT
        assert refused(redeem, w, code, [(w.general, 1)]).detail == PV.ITEM_NOT_ON_VOUCHER


class TestSafety:
    def test_a_used_voucher_cannot_be_redeemed_again(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        e = refused(redeem, w, code, [(w.hotdog, 1), (w.drink, 2)], till=w.tills[1])
        assert (e.status_code, e.detail) == (409, PV.USED)
        assert lookup(w, code)["reason"] == PV.USED

    def test_a_retry_returns_the_first_answer_and_takes_nothing_more(self, w):
        batch = make_batch(w, split=True)
        code = first_code(w, batch)
        first = redeem(w, code, [(w.drink, 1)], request_id="req-1")
        again = redeem(w, code, [(w.drink, 1)], request_id="req-1")
        assert again["replayed"] is True and again["redemptionId"] == first["redemptionId"]
        assert remaining(again) == {"נקניקייה": 1, "שתייה": 1}
        assert w.db.query(PrepaidVoucherRedemption).count() == 1

    def test_a_retry_after_the_voucher_was_used_up_still_answers(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        first = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)], request_id="req-9")
        again = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)], request_id="req-9")
        assert again["replayed"] and again["redemptionId"] == first["redemptionId"]

    def test_the_same_request_id_for_another_voucher_is_a_conflict(self, w):
        batch = make_batch(w, split=True)
        redeem(w, first_code(w, batch, 0), [(w.drink, 1)], request_id="req-2")
        assert refused(redeem, w, first_code(w, batch, 1), [(w.drink, 1)], request_id="req-2").detail == PV.REQUEST_CONFLICT

    def test_the_voucher_row_is_locked_for_the_redemption(self, w):
        captured = []
        original = PV._locate

        def spy(db, machine, raw, *, lock):
            q = db.query(PrepaidVoucher).filter(PrepaidVoucher.code == PV.normalize_code(raw))
            if lock:
                q = q.with_for_update()
            captured.append(str(q.statement.compile(dialect=postgresql.dialect())))
            return original(db, machine, raw, lock=lock)

        PV._locate = spy
        try:
            batch = make_batch(w)
            redeem(w, first_code(w, batch), [(w.hotdog, 1), (w.drink, 2)])
        finally:
            PV._locate = original
        assert "FOR UPDATE" in captured[0]


class TestWhereAndWhen:
    def test_expired_and_not_yet_valid(self, w):
        now = datetime.now(timezone.utc)
        old = make_batch(w, valid_from=now - timedelta(days=3), valid_until=now - timedelta(days=1))
        e = refused(redeem, w, first_code(w, old), [(w.hotdog, 1), (w.drink, 2)])
        assert (e.status_code, e.detail) == (409, PV.EXPIRED)
        assert lookup(w, first_code(w, old))["reason"] == PV.EXPIRED
        later = make_batch(w, valid_from=now + timedelta(days=1))
        assert refused(redeem, w, first_code(w, later), [(w.hotdog, 1), (w.drink, 2)]).detail == PV.NOT_YET_VALID

    def test_another_shop_than_the_batch_names(self, w):
        batch = make_batch(w, shops=[w.shop.id])
        code = first_code(w, batch)
        assert lookup(w, code, till=w.other_till)["reason"] == PV.WRONG_SHOP
        assert refused(redeem, w, code, [(w.hotdog, 1), (w.drink, 2)], till=w.other_till).detail == PV.WRONG_SHOP
        assert redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])["ok"]

    def test_a_company_wide_batch_reaches_every_shop_of_the_company(self, w):
        batch = make_batch(w)
        assert redeem(w, first_code(w, batch), [(w.hotdog, 1), (w.drink, 2)], till=w.other_till)["ok"]

    def test_another_tenants_till_learns_nothing(self, w):
        t2 = Tenant(id=uuid.uuid4(), name="T2", slug="t2", timezone="Asia/Jerusalem")
        w.db.add(t2)
        w.db.flush()
        c2 = Company(id=uuid.uuid4(), tenant_id=t2.id, name="C2", vat_number="3")
        w.db.add(c2)
        w.db.flush()
        s2 = Shop(id=uuid.uuid4(), tenant_id=t2.id, company_id=c2.id, name="S2", settings={})
        w.db.add(s2)
        w.db.flush()
        till = POSMachine(
            id=uuid.uuid4(), tenant_id=t2.id, shop_id=s2.id, distributor_id=w.admin.id, name="X",
            machine_code="M-x", pos_number="99", is_active=True, pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add(till)
        w.db.commit()
        code = first_code(w, make_batch(w))
        assert refused(lookup, w, code, till=till).status_code == 404
        assert refused(redeem, w, code, [(w.hotdog, 1)], till=till).status_code == 404
        assert refused(lookup, w, "PV:NOPE").detail == PV.NOT_FOUND

    def test_a_cancelled_voucher_and_a_cancelled_batch(self, w):
        batch = make_batch(w, count=3, split=True)
        rows = vouchers(w, batch)
        R.cancel_prepaid_voucher(rows[0]["id"], **_ctx(w))
        assert refused(redeem, w, rows[0]["code"], [(w.hotdog, 1)]).detail == PV.CANCELLED
        redeem(w, rows[1]["code"], [(w.hotdog, 1)])
        out = R.cancel_prepaid_voucher_batch(batch["id"], **_ctx(w))
        assert out["status"] == "cancelled" and out["stats"]["cancelled"] == 3
        assert refused(redeem, w, rows[2]["code"], [(w.hotdog, 1)]).detail == PV.CANCELLED
        assert lookup(w, rows[1]["code"])["reason"] == PV.CANCELLED
        assert refused(R.add_prepaid_vouchers, batch["id"], PrepaidVoucherAddIn(count=1), **_ctx(w)).detail == PV.BATCH_CANCELLED


def test_the_till_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    assert ("POST", "/api/v1/sync/{machine_id}/prepaid-vouchers/lookup") in mounted
    assert ("POST", "/api/v1/sync/{machine_id}/prepaid-vouchers/redeem") in mounted
    assert ("POST", "/api/v1/prepaid-vouchers/batches") in mounted
    assert ("GET", "/api/v1/prepaid-vouchers/products") in mounted


class TestReverse:
    """A payment that used a voucher and was then abandoned gives the goods back."""

    def test_reversing_puts_the_goods_back_once(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        assert lookup(w, code)["reason"] == PV.USED
        till = w.tills[0]
        R.reverse_prepaid_redemption(str(till.id), out["redemptionId"], machine=till, db=w.db)
        after = lookup(w, code)
        assert after["redeemable"] is True
        assert {i["name"]: i["remaining"] for i in after["items"]} == {"נקניקייה": 1, "שתייה": 2}
        # Twice is the same as once.
        R.reverse_prepaid_redemption(str(till.id), out["redemptionId"], machine=till, db=w.db)
        assert {i["name"]: i["remaining"] for i in lookup(w, code)["items"]} == {"נקניקייה": 1, "שתייה": 2}
        # And it can be redeemed again.
        redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])

    def test_forfeited_goods_come_back_too(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1)], forfeit=True)
        till = w.tills[0]
        R.reverse_prepaid_redemption(str(till.id), out["redemptionId"], machine=till, db=w.db)
        assert {i["name"]: i["remaining"] for i in lookup(w, code)["items"]} == {"נקניקייה": 1, "שתייה": 2}

    def test_another_tills_redemption_cannot_be_reversed(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        other = w.tills[1]
        e = refused(R.reverse_prepaid_redemption, str(other.id), out["redemptionId"], machine=other, db=w.db)
        assert e.status_code == 404

    def test_the_document_is_attached(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        till = w.tills[0]
        R.attach_prepaid_redemption_transaction(
            str(till.id), out["redemptionId"], {"transactionId": "tx-1"}, machine=till, db=w.db
        )
        from app.models.prepaid_voucher import PrepaidVoucherRedemption

        row = w.db.query(PrepaidVoucherRedemption).first()
        assert row.transaction_id == "tx-1"
