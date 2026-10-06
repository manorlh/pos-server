"""
"תשלום בקופה" — kiosk orders paid at the till (app/services/kiosk_open_orders.py,
docs/SPEC_KIOSK.md §23):

* the kiosk posts an OPEN order and writes no tax document for it; the shop's tills list it;
* one till locks it ("בטיפול בקופה X" for the others), pays it with its own document and marks
  it paid — idempotent; a second document for it is refused; a stale lock lets another till in;
* unpaid within the kiosk's `payment.cashAtTillExpiryMin` it expires (never under a till
  holding it), and its vouchers go back — as they do when a till cancels it with a reason;
* a prepaid voucher redeemed on the kiosk pays part of it (pending), the till takes the rest;
  a redemption is never on two orders, never another machine's, never one given back;
* the config: card / voucher / cash_at_till, a voucher never alone, bare cash still refused,
  "איך תרצו לשלם?" always the last step.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.models.category import Category
from app.models.kiosk import KioskOrder
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption
from app.models.product import CatalogLevel, Product
from app.models.shop_product_override import ShopProductOverride
from app.models.transaction import Transaction
from app.routers import kiosk_open_orders as R
from app.routers import kiosks as KR
from app.routers import prepaid_vouchers as PVR
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn
from app.schemas.kiosk_open_orders import KioskOpenOrdersIn, OpenOrderCancelIn, OpenOrderPaidIn, TillActorIn
from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate, PrepaidVoucherRedeemIn
from app.services import ably_notify
from app.services import kiosk_config as C
from app.services import kiosk_open_orders as S
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

T0 = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.woken = []
    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant, machine, event, body: world.woken.append((machine, event, body.get("reason"))),
    )
    for name in ("publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.kiosk, world.till = world.tills
    world.till2 = POSMachine(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
        name="קופה 2", machine_code=f"X-{uuid.uuid4().hex[:8]}", pos_number="9", is_active=True,
        pairing_status=PairingStatus.ASSIGNED,
    )
    world.db.add(world.till2)
    world.till.name = "קופה 1"
    KR.create_kiosk(
        body=KioskCreateIn(machineId=world.kiosk.id, name="קיוסק רויאל"),
        current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )
    cat = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Food")
    world.db.add(cat)
    world.db.flush()

    def product(name, price):
        p = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, category_id=cat.id,
            catalog_level=CatalogLevel.GLOBAL, name=name, price=price, sku=f"sku-{name}",
        )
        world.db.add(p)
        world.db.flush()
        world.db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=p.id, is_listed=True))
        return p

    world.hotdog = product("נקניקייה", 25)
    world.drink = product("שתייה", 12)
    world.db.commit()
    return world


def body(json_text: object) -> dict:
    """A router answer: a dict, or a JSONResponse (a refusal) as {status, detail…}."""
    if isinstance(json_text, dict):
        return json_text
    return {"status": json_text.status_code, **json.loads(json_text.body)}


def order(local_id="o-1", *, total=6200, tip=0, vouchers=(), created=T0, **extra):
    voucher_sum = sum(v["amountAgorot"] for v in vouchers)
    return {
        "localId": local_id, "pickupNumber": 17, "pickupLabel": "A-17", "businessDate": "2026-10-07",
        "serviceType": "take_away", "fulfillmentMode": "BON", "customerName": "דנה", "itemCount": 3,
        "totalAgorot": total, "tipAgorot": tip, "voucherAgorot": voucher_sum, "dueAgorot": total + tip - voucher_sum,
        "createdAt": created.isoformat(),
        "lines": [{"name": "נקניקייה", "quantity": 1, "totalAgorot": 2500}, {"name": "שתייה", "quantity": 2, "totalAgorot": 3700}],
        "cart": {"cartId": "c1", "lines": []},
        "vouchers": list(vouchers),
        **extra,
    }


def post(w, *orders, now=T0):
    out = S.upsert_from_kiosk(w.db, w.kiosk, list(orders), now=now)
    w.db.commit()
    return out


def listed(w, till=None, now=T0):
    out = S.list_for_till(w.db, till or w.till, now=now)
    w.db.commit()
    return out


def lock(w, till, ref, now=T0, user="דנה"):
    try:
        out = S.lock(w.db, till, ref, pos_user_name=user, now=now)
    except S.OpenOrderRefused as refused:
        w.db.commit()
        return {"status": refused.status_code, **refused.body}
    w.db.commit()
    return out


def paid(w, till, ref, tx="tx-1", now=T0):
    try:
        out = S.mark_paid(w.db, till, ref, transaction_id=tx, transaction_number="20000057", pos_user_name="דנה", now=now)
    except S.OpenOrderRefused as refused:
        w.db.commit()
        return {"status": refused.status_code, **refused.body}
    w.db.commit()
    return out


def cancel(w, till, ref, reason="הלקוח עזב", now=T0):
    try:
        out = S.cancel(w.db, till, ref, reason=reason, pos_user_name="דנה", now=now)
    except S.OpenOrderRefused as refused:
        w.db.commit()
        return {"status": refused.status_code, **refused.body}
    w.db.commit()
    return out


def row(w, local_id="o-1") -> KioskOrder:
    return w.db.query(KioskOrder).filter(KioskOrder.local_id == local_id).one()


# ── The life of an open order ─────────────────────────────────────────────────


def test_the_kiosk_writes_no_document_and_the_shops_tills_list_the_order(w):
    before = w.db.query(Transaction).count()
    out = post(w, order())
    assert out["accepted"] == ["o-1"] and out["rejected"] == []
    assert out["states"]["o-1"]["state"] == "open"
    r = row(w)
    assert r.pay_at_till and r.open_state == "open" and r.status == "open"
    # No tax document until a till takes the money: no transaction, no paid_at, no number.
    assert r.paid_at is None and r.transaction_id is None and r.transaction_number is None
    assert w.db.query(Transaction).count() == before
    # The shop's tills hear of it at once (never the kiosk itself).
    woken = {m for m, event, _ in w.woken if event == S.WAKE_EVENT}
    assert str(w.till.id) in woken and str(w.till2.id) in woken and str(w.kiosk.id) not in woken
    orders = listed(w)
    assert [o["localId"] for o in orders] == ["o-1"]
    o = orders[0]
    assert o["kioskName"] == "קיוסק רויאל" and o["pickupLabel"] == "A-17" and o["customerName"] == "דנה"
    assert o["dueAgorot"] == 6200 and o["lockedBy"] is None and o["cart"] == {"cartId": "c1", "lines": []}
    assert o["expiresAt"] == (T0 + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    # Another shop's till sees nothing of it.
    assert listed(w, w.other_till) == []


def test_one_till_locks_it_the_others_see_who_and_cannot_take_it(w):
    post(w, order())
    got = lock(w, w.till, "o-1")
    assert got["lockedByMe"] is True and got["lockedBy"] == "קופה 1 · דנה"
    other = listed(w, w.till2)[0]
    assert other["lockedBy"] == "קופה 1 · דנה" and other["lockedByMe"] is False
    refused = lock(w, w.till2, "o-1")
    assert refused["status"] == 409 and refused["detail"] == S.LOCKED and refused["lockedBy"] == "קופה 1 · דנה"
    assert cancel(w, w.till2, "o-1")["detail"] == S.LOCKED
    # Locking again is the same till coming back: fine, and the hold is refreshed.
    assert lock(w, w.till, "o-1", now=T0 + timedelta(minutes=5))["lockedByMe"] is True
    # The cashier put it back: anyone may open it.
    S.release(w.db, w.till, "o-1", now=T0 + timedelta(minutes=6))
    w.db.commit()
    assert lock(w, w.till2, "o-1", now=T0 + timedelta(minutes=6))["lockedBy"] == "קופה 2 · דנה"


def test_a_stale_lock_lets_another_till_in(w):
    post(w, order())
    lock(w, w.till, "o-1")
    later = T0 + timedelta(minutes=S.LOCK_STALE_MIN + 1)
    assert listed(w, w.till2, now=later)[0]["lockedBy"] is None
    assert lock(w, w.till2, "o-1", now=later)["lockedByMe"] is True


def test_paying_it_marks_it_paid_once(w):
    post(w, order())
    lock(w, w.till, "o-1")
    out = paid(w, w.till, "o-1", tx="tx-1", now=T0 + timedelta(minutes=3))
    assert out["state"] == "paid" and out["paidBy"] == "קופה 1 · דנה" and out["transactionNumber"] == "20000057"
    r = row(w)
    assert r.status == "paid_at_till" and r.transaction_id == "tx-1" and r.paid_by_machine_id == w.till.id
    assert r.paid_at is not None and r.locked_by_machine_id is None
    # The same document again: the same answer. Another document: refused, never paid twice.
    assert paid(w, w.till, "o-1", tx="tx-1")["state"] == "paid"
    again = paid(w, w.till2, "o-1", tx="tx-2")
    assert again["status"] == 409 and again["detail"] == S.CLOSED and again["state"] == "paid"
    assert lock(w, w.till2, "o-1")["detail"] == S.CLOSED
    # The tills see it go, then it is gone from the list.
    assert listed(w, now=T0 + timedelta(minutes=4))[0]["state"] == "paid"
    assert listed(w, now=T0 + timedelta(minutes=10)) == []


def test_the_slips_barcode_finds_it(w):
    post(w, order("4f1c2a9e-0000-4000-8000-000000000001"))
    got = lock(w, w.till, "KO:4f1c2a9e-0000-4000-8000-000000000001")
    assert got["localId"] == "4f1c2a9e-0000-4000-8000-000000000001"
    # Its cloud id works as well; an unknown one is not found.
    assert lock(w, w.till, got["id"])["lockedByMe"] is True
    assert lock(w, w.till, "KO:nothing")["detail"] == S.NOT_FOUND
    # Another shop's till: not found, whatever it scans.
    assert lock(w, w.other_till, got["id"])["detail"] == S.NOT_FOUND


def test_a_kiosk_never_pays_orders_and_a_till_never_posts_them(w):
    post(w, order())
    with pytest.raises(S.OpenOrderRefused) as caught:
        S.list_for_till(w.db, w.kiosk, now=T0)
    assert caught.value.code == S.NOT_A_TILL
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        R.post_open_orders(machine_id=str(w.till.id), body=KioskOpenOrdersIn(orders=[order("x")]), machine=w.till, db=w.db)
    assert e.value.status_code == 403


def test_money_that_does_not_add_up_is_refused_alone(w):
    bad = order("bad")
    bad["dueAgorot"] = 100
    out = post(w, bad, order("good"))
    assert out["accepted"] == ["good"]
    assert out["rejected"][0]["localId"] == "bad" and out["rejected"][0]["reason"].startswith("invalid")


def test_posting_again_changes_nothing_of_the_snapshot(w):
    post(w, order())
    changed = order(total=9900)
    out = post(w, changed, now=T0 + timedelta(minutes=1))
    assert out["accepted"] == ["o-1"]
    assert row(w).total_agorot == 6200 and row(w).due_agorot == 6200


# ── Expiry and cancel ─────────────────────────────────────────────────────────


def test_unpaid_it_expires_and_disappears(w):
    post(w, order())
    assert listed(w, now=T0 + timedelta(minutes=29))[0]["state"] == "open"
    out = listed(w, now=T0 + timedelta(minutes=30))
    assert out[0]["state"] == "expired"
    r = row(w)
    assert r.open_state == "expired" and r.status == "expired" and r.close_reason == "expired"
    assert r.paid_at is None and r.transaction_id is None
    assert listed(w, now=T0 + timedelta(minutes=40)) == []
    assert lock(w, w.till, "o-1", now=T0 + timedelta(minutes=40))["detail"] == S.CLOSED


def test_the_expiry_is_the_kiosks_setting_and_never_under_a_till_paying_it(w):
    KR.put_settings(
        body=KioskSettingsIn(overrides={"payment": {"methods": ["card", "cash_at_till"], "cashAtTillExpiryMin": 10}}),
        level="machine", scope_id=w.kiosk.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    w.db.commit()
    post(w, order())
    assert row(w).expires_at.replace(tzinfo=timezone.utc) == T0 + timedelta(minutes=10)
    lock(w, w.till, "o-1", now=T0 + timedelta(minutes=8))
    # Held by a till: not expired at its time…
    assert listed(w, w.till2, now=T0 + timedelta(minutes=12))[0]["state"] == "open"
    assert paid(w, w.till, "o-1", now=T0 + timedelta(minutes=12))["state"] == "paid"


def test_an_order_uploaded_after_its_time_is_expired_at_once(w):
    out = post(w, order(created=T0), now=T0 + timedelta(hours=2))
    assert out["states"]["o-1"]["state"] == "expired"


def test_a_cancel_needs_a_reason_and_is_logged_on_the_order(w):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        OpenOrderCancelIn(reason="")
    post(w, order())
    out = cancel(w, w.till, "o-1", reason="הלקוח ויתר")
    assert out["state"] == "cancelled" and out["closeReason"] == "הלקוח ויתר"
    r = row(w)
    assert r.status == "cancelled" and r.closed_by_name == "קופה 1 · דנה" and r.transaction_id is None
    assert cancel(w, w.till, "o-1")["state"] == "cancelled"  # idempotent
    assert paid(w, w.till, "o-1")["state"] == "paid"  # money taken anyway: believed, and logged
    assert row(w).close_reason == "paid_after_cancelled"


def test_a_lan_paid_order_reported_by_the_kiosk_is_paid(w):
    o = order(state="paid", paidByName="קופה ראשית", paidTransactionId="tx-lan", paidTransactionNumber="20000060")
    out = post(w, o)
    assert out["states"]["o-1"]["state"] == "paid"
    r = row(w)
    assert r.transaction_id == "tx-lan" and r.paid_by_name == "קופה ראשית" and r.paid_at is not None


# ── Vouchers: part on the kiosk, the rest at the till ─────────────────────────


def _redeem_hotdog(w, *, machine=None, request="r-1"):
    """A prepaid voucher (1 hotdog + 2 drinks, in parts) of which the kiosk takes the hotdog."""
    batch = PVR.create_prepaid_voucher_batch(
        PrepaidVoucherBatchCreate(
            name="פסטיבל", companyId=w.company.id, splitAllowed=True, count=1,
            items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        ),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    voucher = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(batch["id"])).one()
    out = PVR.redeem_prepaid_voucher(
        str((machine or w.kiosk).id),
        PrepaidVoucherRedeemIn(code=voucher.code, items=[{"productId": str(w.hotdog.id), "quantity": 1}], clientRequestId=request),
        machine=machine or w.kiosk, db=w.db,
    )
    return voucher, out


def _voucher_leg(out, amount=2500):
    return {
        "redemptionId": out["redemptionId"], "serial": 1, "amountAgorot": amount, "eventName": "פסטיבל",
        "redeemed": [{"productId": r["productId"], "tillProductId": r["tillProductId"], "name": r["name"], "quantity": r["quantity"]} for r in out["redeemed"]],
    }


def test_a_voucher_pays_part_and_the_till_takes_the_rest(w):
    voucher, redeemed = _redeem_hotdog(w)
    posted = post(w, order(vouchers=[_voucher_leg(redeemed)]))
    assert posted["accepted"] == ["o-1"]
    o = listed(w)[0]
    # Agorot all the way: 62.00 − 25.00 = 37.00 left for the till.
    assert o["totalAgorot"] == 6200 and o["voucherAgorot"] == 2500 and o["dueAgorot"] == 3700
    assert o["vouchers"][0]["redemptionId"] == redeemed["redemptionId"]
    lock(w, w.till, "o-1")
    paid(w, w.till, "o-1", tx="tx-9")
    red = w.db.get(PrepaidVoucherRedemption, uuid.UUID(redeemed["redemptionId"]))
    assert red.transaction_id == "tx-9" and red.reversed_at is None
    w.db.refresh(voucher)
    assert voucher.remaining[str(w.hotdog.id)] == 0


def test_a_cancelled_or_expired_order_gives_its_voucher_back(w):
    voucher, redeemed = _redeem_hotdog(w)
    post(w, order(vouchers=[_voucher_leg(redeemed)]))
    cancel(w, w.till, "o-1")
    w.db.refresh(voucher)
    assert voucher.remaining[str(w.hotdog.id)] == 1 and voucher.status == "active"
    red = w.db.get(PrepaidVoucherRedemption, uuid.UUID(redeemed["redemptionId"]))
    assert red.reversed_at is not None


def test_an_expired_order_gives_its_voucher_back(w):
    voucher, redeemed = _redeem_hotdog(w)
    post(w, order(vouchers=[_voucher_leg(redeemed)]))
    listed(w, now=T0 + timedelta(hours=1))
    w.db.refresh(voucher)
    assert voucher.remaining[str(w.hotdog.id)] == 1


def test_a_voucher_is_never_counted_twice_nor_anothers(w):
    _voucher, redeemed = _redeem_hotdog(w)
    assert post(w, order("a", vouchers=[_voucher_leg(redeemed)]))["accepted"] == ["a"]
    twice = post(w, order("b", vouchers=[_voucher_leg(redeemed)]))
    assert twice["rejected"][0]["reason"] == "invalid:vouchers.on_another_order"
    # Another machine's redemption (a till's): not the kiosk's to claim.
    _v2, at_till = _redeem_hotdog(w, machine=w.till, request="r-2")
    foreign = post(w, order("c", vouchers=[_voucher_leg(at_till)]))
    assert foreign["rejected"][0]["reason"] == "invalid:vouchers.unknown_redemption"
    # One the kiosk already gave back: nothing to claim.
    _v3, given_back = _redeem_hotdog(w, request="r-3")
    PVR.reverse_prepaid_redemption(str(w.kiosk.id), given_back["redemptionId"], machine=w.kiosk, db=w.db)
    back = post(w, order("d", vouchers=[_voucher_leg(given_back)]))
    assert back["rejected"][0]["reason"] == "invalid:vouchers.reversed"


# ── The kiosk's config ────────────────────────────────────────────────────────


def test_the_methods_and_the_choice_step(w):
    assert C.PAYMENT_METHODS == ("card", "voucher", "cash_at_till")
    _c, errors = C.validate_layer({"payment": {"methods": ["card", "voucher", "cash_at_till"]}})
    assert errors == []
    assert C.validate_config(C.resolve({"payment": {"methods": ["cash_at_till", "voucher"]}})) == []
    # A voucher alone cannot pay what it leaves; bare "cash" is still refused (no cash hardware).
    codes = {e.path: e.code for e in C.validate_config(C.merge(C.default_config(), {"payment": {"methods": ["voucher"]}}))}
    assert codes.get("payment.methods") == "voucher_needs_method"
    codes = {e.path: e.code for e in C.validate_config(C.merge(C.default_config(), {"payment": {"methods": ["cash"]}}))}
    assert codes.get("payment.methods[0]") == "cash_not_supported"
    # repair makes what a kiosk gets valid: a voucher alone gets the card beside it.
    assert C.resolve({"payment": {"methods": ["voucher"]}})["payment"]["methods"] == ["card", "voucher"]
    # "איך תרצו לשלם?" is always last, right before the payment.
    assert C.resolve({"payment": {"checkoutSteps": ["payMethod", "details", "tip"]}})["payment"]["checkoutSteps"] == ["details", "tip", "payMethod"]
    assert C.resolve({"payment": {"checkoutSteps": ["details"]}})["payment"]["checkoutSteps"] == ["details", "payMethod"]
    # The expiry's range, the kitchen switch, the texts.
    _c, errors = C.validate_layer({"payment": {"cashAtTillExpiryMin": 1, "cashAtTillKitchenBeforePay": "yes"}})
    got = {e.path: e.code for e in errors}
    assert got["payment.cashAtTillExpiryMin"] == "out_of_range" and "payment.cashAtTillKitchenBeforePay" in got
    for key in ("payMethodTitle", "payCashLabel", "remainingToPay", "voucherOffline", "cashSlipTitle", "cashSlipFooter", "cashSlipPending", "cashDoneTitle", "stepPayMethod"):
        assert key in C.TEXT_KEYS


def test_the_dashboard_sees_where_an_order_stands_and_open_ones_are_not_sales(w):
    post(w, order("open-1"))
    post(w, order("paid-1"))
    paid(w, w.till, "paid-1")
    from app.services import kiosk_control as KC

    rows = KC.list_orders(w.db, w.admin, w.kiosk, date(2026, 10, 7))
    by = {r["localId"]: r for r in rows}
    assert by["open-1"]["payAtTill"] is True and by["open-1"]["openState"] == "open" and by["open-1"]["dueAgorot"] == 6200
    assert by["paid-1"]["openState"] == "paid" and by["paid-1"]["paidBy"] == "קופה 1 · דנה"
