"""
"מצב בדיקה" for a production voucher batch (P:/specs/voucher-test-mode.md;
app/services/prepaid_voucher_test_mode.py) — the spec's acceptance 1–6, server side:

1. **Five test scans** — the voucher's balance and status never move; the board, the batch report, the
   tills report, "כמה מתוך כמה" and the settlement count 0; "יומן בדיקות" holds 5 lines (who, where,
   which voucher, what would have been covered and left). Every reply says `testMode: true` and a "test-…" id.
2. **No sale recorded** — no redemption, no hold (what quotas and "in use" read); a document naming a
   test scan is ignored for voucher accounting.
3. **Never mixed** — a test-mode voucher in a sale with a real one, either way round (or reported by the
   till): 409 `prepaid_voucher_test_mixed` with its Hebrew.
4. **End of test** — off: the next scan is real and counted; a hold made before the flag went on stays real.
5. **An invalid voucher** — cancelled / expired: the same reason in test mode as for real.
6. **Audit** — on / off on the batch's own trail (who, when), at creation, and per batch in a bulk edit.

Plus: an idempotent retry, a discount voucher's hold, test stacking, no test offline, the batch list's
filter, and the migration (idempotent, offline, on the single head).
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
    PrepaidVoucherTestRedemption,
    TransactionVoucherDiscount,
)
from app.routers import prepaid_voucher_extras as X
from app.routers import prepaid_vouchers as R
from app.routers import reports as reports_router
from app.schemas.prepaid_voucher import (
    PrepaidBatchBulkEditIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherConfirmIn,
    PrepaidVoucherLookupIn,
    PrepaidVoucherRedeemIn,
    PrepaidVoucherReserveIn,
)
from app.schemas.prepaid_voucher_extras import SettlementAgreementIn
from app.services import prepaid_voucher_test_mode as TM
from app.services import prepaid_vouchers as PV
from test_prepaid_vouchers import _ctx, refused, vouchers, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]
GOODS_FEATURES = ["accounting", "groups", "reserve_goods", "override"]
KINDS = ["items", "order_discount", "item_discount"]


# ── Helpers ───────────────────────────────────────────────────────────────────


def batch(w, *, count=3, test=True, name="ארוחות", split=False, **extra):
    """Goods redeemed at once (a hot dog and two drinks), the `payment` tender: today's tills' `/redeem`."""
    body = PrepaidVoucherBatchCreate(
        name=name, companyId=w.company.id, customerName="קייטרינג אלון", eventName="פסטיבל הקיץ", count=count,
        items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        redemptionAccounting="payment", splitAllowed=split, startInTestMode=test, **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def discount_batch(w, *, test=True, count=2):
    body = PrepaidVoucherBatchCreate(
        name="הנחה", companyId=w.company.id, count=count, kind="order_discount", discountType="fixed",
        discountValue=30, startInTestMode=test,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def codes(w, b):
    return [v["code"] for v in vouchers(w, b)]


def row(w, code) -> PrepaidVoucher:
    w.db.expire_all()
    return w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()


def look(w, code, till=None):
    till = till or w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, supportedKinds=KINDS),
                                    machine=till, db=w.db)


def redeem(w, code, *, till=None, request_id=None, sale=None, items=None, aware=True):
    """[aware]: the till says `testModeAware: true` (a test-mode client); False — an older one, no field at all."""
    till = till or w.tills[0]
    body = PrepaidVoucherRedeemIn(
        code=code, clientRequestId=request_id or str(uuid.uuid4()), saleRef=sale, posUserId=7, posUserName="דנה",
        items=[{"productId": str(p.id), "quantity": q} for p, q in (items or [(w.hotdog, 1), (w.drink, 2)])],
        **({"testModeAware": True} if aware else {}),
    )
    out = R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)
    return out


def _unit(product, price, ref):
    return {"ref": ref, "productId": str(product.id), "productName": product.name, "groupKey": None, "quantity": 1,
            "listPriceAgorot": price, "listValueAgorot": price, "categoryIds": [str(product.category_id)],
            "noDiscount": False}


def hold(w, code, *, till=None, request_id=None, sale=None, others=(), aware=True):
    """A goods hold for the whole voucher (reserve), the sale still open."""
    till = till or w.tills[0]
    return R.reserve_prepaid_voucher(str(till.id), PrepaidVoucherReserveIn(
        code=code, clientRequestId=request_id or str(uuid.uuid4()), saleRef=sale or str(uuid.uuid4()),
        units=[_unit(w.hotdog, 2500, "a"), _unit(w.drink, 1200, "b"), _unit(w.drink, 1200, "c")],
        features=GOODS_FEATURES, otherVouchers=list(others), posUserId=7, posUserName="דנה",
        **({"testModeAware": True} if aware else {})), machine=till, db=w.db)


def discount_hold(w, code, *, till=None, request_id=None, sale="sale-1", aware=True):
    till = till or w.tills[0]
    body = PrepaidVoucherReserveIn(
        code=code, clientRequestId=request_id or str(uuid.uuid4()), saleRef=sale, supportedKinds=KINDS,
        lines=[{"id": "L1", "productIds": [str(w.hotdog.id)], "categoryIds": [str(w.hotdog.category_id)],
                "quantity": 2, "grossAgorot": 5000}],
        posUserId=7, posUserName="דנה", **({"testModeAware": True} if aware else {}),
    )
    return R.reserve_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def confirm(w, reservation_id, *, till=None, tx=None, amount=0):
    till = till or w.tills[0]
    out = R.confirm_prepaid_reservation(str(till.id), reservation_id, PrepaidVoucherConfirmIn(
        transactionId=tx or str(uuid.uuid4()), amountAgorot=amount), machine=till, db=w.db)
    w.db.commit()
    return out


def set_test(w, b, on: bool):
    return R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(testMode=on), **_ctx(w))


def log(w, b):
    return R.prepaid_voucher_test_redemptions(b["id"], limit=500, **_ctx(w))


def counted(w, b) -> dict:
    """Everything that counts a redemption: the board, the batch report, the tills report, the settlement."""
    today = datetime.now(timezone.utc).date()
    board = reports_router.get_voucher_board_report(
        from_date=today, to_date=today, cmp_from=None, cmp_to=None, tz="UTC", company_id=None, shop_id=None,
        area_id=None, machine_id=None, event_id=None, cmp_event_id=None, **_ctx(w),
    )
    report = R.prepaid_voucher_batch_report(b["id"], tz=None, **_ctx(w))
    tills = R.prepaid_voucher_tills_report(bucket="day", scope=None, **_ctx(w))
    agreement = X.create_settlement_agreement(SettlementAgreementIn(
        name=f"הסכם {uuid.uuid4().hex[:6]}", companyId=w.company.id, batchIds=[b["id"]]), **_ctx(w))
    return {
        "redemptions": w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.batch_id == uuid.UUID(b["id"])).count(),
        "holds": w.db.query(PrepaidVoucherReservation).filter(PrepaidVoucherReservation.batch_id == uuid.UUID(b["id"])).count(),
        "board": board.totals.redemptions,
        "boardUsedEver": board.used_ever,
        "report": report["totals"]["redemptions"],
        "reportUsed": report["vouchers"]["used"] + report["vouchers"]["partiallyUsed"],
        "tills": tills["totals"]["redemptions"],
        "settlement": agreement["totals"]["redeemed"],
    }


def _mixed(e):
    return (e.status_code, e.detail) == (409, {"code": TM.MIXED, "message": TM.MIXED_MESSAGE})


# ── 1–2. Five test scans: nothing taken, nothing counted, five log lines ──────


class TestFiveScans:
    def test_five_scans_leave_the_voucher_and_every_count_alone(self, w):
        b = batch(w, count=2)
        assert (b["testMode"], b["testModeBy"]) == (True, PV._user_name(w.admin)) and b["testModeSince"]
        code = codes(w, b)[0]
        before = row(w, code)
        remaining, status = dict(before.remaining), before.status
        seen = look(w, code)
        assert (seen["testMode"], seen["redeemable"], seen["reason"]) == (True, True, None)

        replies = [redeem(w, code), redeem(w, code, till=w.tills[1])]  # the whole one-time voucher, twice
        held = hold(w, code)
        replies.append(confirm(w, held["reservationId"], amount=held["coveredAgorot"]))
        replies.append(redeem(w, code))
        held = hold(w, code, till=w.tills[1])
        replies.append(R.release_prepaid_reservation(str(w.tills[1].id), held["reservationId"], machine=w.tills[1], db=w.db))
        w.db.commit()

        for out in replies:
            assert out["testMode"] is True
        assert all(r["redemptionId"].startswith("test-") for r in replies[:2] + replies[3:4])
        assert replies[2]["redemptionId"].startswith("test-") and replies[2]["status"] == "confirmed"
        assert replies[4]["status"] == "released"
        # The till still sees the voucher as new: every scan is.
        assert replies[0]["voucher"]["testMode"] is True
        assert {i["name"]: i["remaining"] for i in replies[0]["voucher"]["items"]} == {"נקניקייה": 1, "שתייה": 2}

        after = row(w, code)
        assert (after.remaining, after.status, after.first_redeemed_at, after.uses_left) == (remaining, status, None, None)
        c = counted(w, b)
        assert c == {"redemptions": 0, "holds": 0, "board": 0, "boardUsedEver": 0, "report": 0, "reportUsed": 0,
                     "tills": 0, "settlement": 0}
        assert w.db.query(TransactionVoucherDiscount).count() == 0

        out = log(w, b)
        assert (out["total"], len(out["items"]), out["testMode"]) == (5, 5, True)
        line = out["items"][-1]  # the first scan
        assert (line["operation"], line["status"], line["posUserName"], line["serial"]) == ("redeem", "done", "דנה", 1)
        assert line["machineName"] == w.tills[0].name and line["shopName"] == w.shop.name
        assert line["covered"] == 49.0 and line["value"] == 49.0  # 25 + 2 × 12 at the till's prices
        assert {(r["name"], r["quantity"]) for r in line["remainingAfter"]} == {("נקניקייה", 0), ("שתייה", 0)}
        statuses = sorted(i["status"] for i in out["items"])
        assert statuses == ["confirmed", "done", "done", "done", "released"]

    def test_a_retry_is_the_same_scan(self, w):
        b = batch(w)
        code = codes(w, b)[0]
        first = redeem(w, code, request_id="r-1")
        again = redeem(w, code, request_id="r-1")
        assert (again["redemptionId"], again["replayed"], first["replayed"]) == (first["redemptionId"], True, False)
        held = hold(w, code, request_id="h-1", sale="s-1")
        renewed = hold(w, code, request_id="h-1", sale="s-1")
        assert (renewed["reservationId"], renewed["replayed"]) == (held["reservationId"], True)
        done = confirm(w, held["reservationId"], tx="t-1")
        assert confirm(w, held["reservationId"], tx="t-1") == {**done, "replayed": True}
        assert refused(confirm, w, held["reservationId"], tx="t-2").detail == PV.RESERVATION_CONFLICT
        w.db.commit()
        assert w.db.query(PrepaidVoucherTestRedemption).count() == 2
        # Another till never sees this till's test scan.
        assert refused(confirm, w, held["reservationId"], till=w.tills[1]).status_code == 404

    def test_a_discount_voucher_held_in_test(self, w):
        b = discount_batch(w)
        code = codes(w, b)[0]
        held = discount_hold(w, code)
        assert (held["testMode"], held["amountAgorot"], held["uses"]) == (True, 3000, 1)
        assert held["reservationId"].startswith("test-") and held["shares"] == {"L1": 3000}
        assert confirm(w, held["reservationId"], amount=3000)["amountAgorot"] == 3000
        v = row(w, code)
        assert (v.uses_left, v.status) == (1, "active")
        assert w.db.query(PrepaidVoucherReservation).count() == 0
        line = log(w, b)["items"][0]
        assert (line["discount"], line["uses"], line["status"]) == (30.0, 1, "confirmed")
        assert line["remainingAfter"] == [{"key": "uses", "name": None, "quantity": 0}]

    def test_a_document_naming_a_test_scan_is_no_voucher_accounting(self, w):
        from app.models.shift import ShiftStatus
        from app.schemas.transaction import TransactionIn
        from app.services.transactions import upsert_transactions
        from shift_world import NOW, TODAY

        b = batch(w)
        code = codes(w, b)[0]
        held = hold(w, code)
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = TransactionIn.model_validate({
            "id": str(uuid.uuid4()), "transactionNumber": "9001", "status": "completed", "documentType": 320,
            "totalAmount": "49.00", "documentDiscount": "49.00", "paymentMethod": "cash",
            "payments": [{"id": str(uuid.uuid4()), "method": "production_voucher", "amount": "0.00",
                          "reservationId": held["reservationId"]}],
            "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "shiftId": str(shift.id),
            "businessDate": str(TODAY),
            "items": [{"id": str(uuid.uuid4()), "productName": "נקניקייה", "quantity": 1, "unitPrice": "49.00",
                       "totalPrice": "49.00", "prepaidDeduction": "49.00", "voucherRedemptionId": held["reservationId"]}],
            "voucherDiscounts": [{"reservationId": held["reservationId"], "redemptionId": held["reservationId"],
                                  "batchId": b["id"], "kind": "production_voucher", "amount": "49.00"}],
        })
        upsert_transactions(w.db, till, [doc])
        w.db.commit()
        assert w.db.query(TransactionVoucherDiscount).count() == 0
        assert w.db.query(PrepaidVoucherRedemption).count() == 0
        assert w.db.query(PrepaidVoucherTestRedemption).one().status == "held"  # never confirmed by a document
        assert row(w, code).status == "active"


# ── Older clients: refused, nothing written ───────────────────────────────────


def _unsupported(e):
    return (e.status_code, e.detail) == (409, {"code": TM.UNSUPPORTED, "message": TM.UNSUPPORTED_MESSAGE})


class TestOlderClients:
    """A client that does not say `testModeAware: true` (an older till, the web / Windows kiosk) would sell for real."""

    def test_refused_on_redeem_and_on_reserve_and_nothing_logged(self, w):
        b = batch(w)
        d = discount_batch(w)
        code = codes(w, b)[0]
        before = dict(row(w, code).remaining)
        assert _unsupported(refused(redeem, w, code, aware=False))
        assert _unsupported(refused(hold, w, code, aware=False))
        assert _unsupported(refused(discount_hold, w, codes(w, d)[0], aware=False))
        w.db.commit()
        assert w.db.query(PrepaidVoucherTestRedemption).count() == 0
        assert w.db.query(PrepaidVoucherRedemption).count() == w.db.query(PrepaidVoucherReservation).count() == 0
        v = row(w, code)
        assert (v.remaining, v.status) == (before, "active")
        assert row(w, codes(w, d)[0]).uses_left == 1
        # Lookup / the balance check stay open to it: read only, the flag in the voucher.
        out = look(w, code)
        assert (out["testMode"], out["redeemable"]) == (True, True)

    def test_an_aware_client_tests_as_ever(self, w):
        b = batch(w)
        code = codes(w, b)[0]
        assert redeem(w, code)["testMode"] is True
        held = hold(w, code)
        assert held["testMode"] is True and held["reservationId"].startswith("test-")
        assert log(w, b)["total"] == 2

    @pytest.mark.parametrize("aware", [False, True])
    def test_a_real_batch_is_unaffected_either_way(self, w, aware):
        b = batch(w, test=False, count=2)
        cs = codes(w, b)
        out = redeem(w, cs[0], aware=aware)
        held = hold(w, cs[1], aware=aware)
        confirm(w, held["reservationId"], amount=held["coveredAgorot"])
        assert "testMode" not in out and not out["redemptionId"].startswith("test-")
        assert (row(w, cs[0]).status, row(w, cs[1]).status) == ("used", "used")
        assert w.db.query(PrepaidVoucherRedemption).count() == 2
        assert w.db.query(PrepaidVoucherTestRedemption).count() == 0


# ── 3. Never mixed with a real sale ───────────────────────────────────────────


class TestMixed:
    def test_a_test_voucher_in_a_sale_with_a_real_one(self, w):
        real, test = batch(w, test=False, name="אמיתי"), batch(w, name="בבדיקה")
        redeem(w, codes(w, real)[0], sale="S")
        w.db.commit()
        e = refused(redeem, w, codes(w, test)[0], sale="S")
        assert _mixed(e)
        assert _mixed(refused(hold, w, codes(w, test)[0], sale="S"))
        assert w.db.query(PrepaidVoucherTestRedemption).count() == 0

    def test_a_real_voucher_in_a_sale_with_a_test_one(self, w):
        real, test = batch(w, test=False, name="אמיתי"), batch(w, name="בבדיקה")
        hold(w, codes(w, test)[0], sale="S")
        w.db.commit()
        assert _mixed(refused(redeem, w, codes(w, real)[0], sale="S"))
        assert _mixed(refused(hold, w, codes(w, real)[0], sale="S"))
        assert w.db.query(PrepaidVoucherRedemption).count() == 0
        # Another sale is a sale of its own.
        assert redeem(w, codes(w, real)[0], sale="T")["redemptionId"]

    def test_reported_by_the_till(self, w):
        real, test = batch(w, test=False, name="אמיתי"), batch(w, name="בבדיקה")
        rv = vouchers(w, real)[0]
        tv = vouchers(w, test)[0]
        other_real = {"voucherId": rv["id"], "batchId": real["id"], "kind": "items", "stacking": "unlimited"}
        other_test = {"voucherId": tv["id"], "batchId": test["id"], "kind": "items", "stacking": "unlimited"}
        assert _mixed(refused(hold, w, tv["code"], others=[other_real]))
        assert _mixed(refused(hold, w, rv["code"], others=[other_test]))

    def test_two_test_vouchers_stack_as_real_ones_would(self, w):
        single = batch(w, name="יחיד", stacking="single")
        a, b_ = codes(w, single)[:2]
        hold(w, a, sale="S")
        w.db.commit()
        e = refused(hold, w, b_, sale="S")
        assert e.detail == PV.NOT_STACKABLE  # as for real: "שובר אחד בעסקה"


# ── 4. End of test: real from the next scan ───────────────────────────────────


class TestEndOfTest:
    def test_off_makes_the_next_scan_real_and_counted(self, w):
        b = batch(w)
        code = codes(w, b)[0]
        redeem(w, code)
        out = set_test(w, b, False)
        assert (out["testMode"], out["testModeSince"], out["testModeBy"]) == (False, None, None)
        real = redeem(w, code)
        w.db.commit()
        assert not real["redemptionId"].startswith("test-") and "testMode" not in real
        assert real["voucher"]["testMode"] is False
        assert row(w, code).status == "used"
        c = counted(w, b)
        assert c == {"redemptions": 1, "holds": 0, "board": 1, "boardUsedEver": 1, "report": 1, "reportUsed": 1,
                     "tills": 1, "settlement": 1}
        assert log(w, b)["total"] == 1  # the test scan stays in the log, counted nowhere

    def test_a_hold_made_before_the_flag_stays_real(self, w):
        b = batch(w, test=False)
        code = codes(w, b)[0]
        held = hold(w, code, request_id="h-1", sale="S")
        w.db.commit()
        set_test(w, b, True)
        # Its renewal and its confirm go on as they began: real.
        renewed = hold(w, code, request_id="h-1", sale="S")
        assert renewed["reservationId"] == held["reservationId"] and "testMode" not in renewed
        done = confirm(w, held["reservationId"], amount=held["coveredAgorot"])
        assert "testMode" not in done
        assert row(w, code).status == "used"
        assert w.db.query(PrepaidVoucherRedemption).count() == 1
        assert log(w, b)["total"] == 0


# ── 5. An invalid voucher: the same reason in test mode ───────────────────────


class TestInvalid:
    @pytest.mark.parametrize("test", [False, True])
    def test_cancelled(self, w, test):
        b = batch(w, test=test)
        R.cancel_prepaid_voucher_batch(b["id"], None, **_ctx(w))
        code = codes(w, b)[0]
        assert (look(w, code)["reason"], look(w, code)["message"]) == (PV.CANCELLED, "השובר בוטל")
        assert refused(redeem, w, code).detail == PV.CANCELLED
        assert refused(hold, w, code).detail == {"code": PV.CANCELLED, "message": "השובר בוטל"}
        assert w.db.query(PrepaidVoucherTestRedemption).count() == 0

    @pytest.mark.parametrize("test", [False, True])
    def test_expired(self, w, test):
        now = datetime.now(timezone.utc)
        b = batch(w, test=test, validFrom=now - timedelta(days=3), validUntil=now - timedelta(days=1))
        code = codes(w, b)[0]
        out = look(w, code)
        assert out["reason"] == PV.EXPIRED and out["message"].startswith("תוקף השובר הסתיים ב-")
        assert out["testMode"] is test
        assert refused(redeem, w, code).detail == PV.EXPIRED
        assert w.db.query(PrepaidVoucherTestRedemption).count() == 0

    def test_a_pause_and_a_quota_apply_and_test_scans_never_take_a_place(self, w):
        from app.schemas.prepaid_voucher_extras import PauseIn, QuotaIn, ResumeIn

        b = batch(w, count=3)
        X.create_prepaid_voucher_quota(QuotaIn(scopeKind="batch", scopeValue=b["id"], maxRedemptions=1), **_ctx(w))
        cs = codes(w, b)
        for code in cs:  # three vouchers, a quota of one: every test scan passes, none takes the place
            redeem(w, code)
            hold(w, code)
        w.db.commit()
        p = X.create_prepaid_voucher_pause(PauseIn(scopeKind="batch", scopeValue=b["id"], reason="בדיקה"), **_ctx(w))
        assert refused(redeem, w, cs[0]).detail == "prepaid_voucher_paused"
        X.resume_prepaid_voucher_pause(p["id"], ResumeIn(note=None), **_ctx(w))
        set_test(w, b, False)
        redeem(w, cs[0])  # the first real one takes the quota's only place
        w.db.commit()
        assert refused(redeem, w, cs[1]).detail == "prepaid_voucher_quota_reached"

    def test_a_used_voucher_is_used_in_test_too(self, w):
        b = batch(w, test=False)
        code = codes(w, b)[0]
        redeem(w, code)
        w.db.commit()
        set_test(w, b, True)
        assert look(w, code)["reason"] == PV.USED
        assert refused(redeem, w, code).detail == PV.USED


# ── 6. Audit ──────────────────────────────────────────────────────────────────


def _actions(w, b):
    w.db.expire_all()
    return [(e.action, e.user_name, (e.details or {}).get("bulk") is not None)
            for e in w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.batch_id == uuid.UUID(b["id"]))
            .order_by(PrepaidVoucherEvent.created_at)]


class TestAudit:
    def test_on_and_off_are_logged_with_who_and_when(self, w):
        b = batch(w, test=False)
        on = set_test(w, b, True)
        assert on["testMode"] is True and on["testModeSince"] and on["testModeBy"] == PV._user_name(w.admin)
        set_test(w, b, False)
        set_test(w, b, False)  # already off: nothing logged
        assert [a for a, _, _ in _actions(w, b)] == ["create", "test_mode_on", "test_mode_off"]
        events = R.prepaid_voucher_events(b["id"], **_ctx(w))["items"]
        assert {e["action"] for e in events} >= {"test_mode_on", "test_mode_off"}
        assert all(e["userName"] for e in events)

    def test_at_creation(self, w):
        b = batch(w, test=True)
        assert [a for a, _, _ in _actions(w, b)] == ["create", "test_mode_on"]
        assert batch(w, test=False)["testMode"] is False  # off by default

    def test_a_bulk_edit_logs_each_batch(self, w):
        one, two, other = batch(w, test=False, name="א"), batch(w, test=False, name="ב"), batch(w, test=False, name="ג")
        out = R.bulk_edit_prepaid_voucher_batches(PrepaidBatchBulkEditIn(
            batchIds=[one["id"], two["id"]], changes={"testMode": True}, clientRequestId=str(uuid.uuid4())), **_ctx(w))
        assert out["summary"]["applied"] == 2
        for b in (one, two):
            assert _actions(w, b)[-1] == ("test_mode_on", PV._user_name(w.admin), True)
            assert R.get_prepaid_voucher_batch(b["id"], **_ctx(w))["testMode"] is True
        assert R.get_prepaid_voucher_batch(other["id"], **_ctx(w))["testMode"] is False
        R.bulk_edit_prepaid_voucher_batches(PrepaidBatchBulkEditIn(
            batchIds=[one["id"], two["id"]], changes={"testMode": False}, clientRequestId=str(uuid.uuid4())), **_ctx(w))
        assert [a for a, _, bulk in _actions(w, one)] == ["create", "test_mode_on", "test_mode_off"]

    def test_the_edit_preview_lists_it(self, w):
        b = batch(w, test=False)
        plan = R.preview_prepaid_voucher_batch_edit(b["id"], PrepaidVoucherBatchUpdate(testMode=True), **_ctx(w))
        assert plan["changes"] == [{"field": "testMode", "category": "test", "before": False, "after": True}]
        assert plan["effects"]["test"]["on"] is True and plan["confirm"] is True

    def test_only_who_may_edit_the_batch(self, w):
        b = batch(w, test=False)
        e = refused(R.update_prepaid_voucher_batch, b["id"], PrepaidVoucherBatchUpdate(testMode=True), **_ctx(w, w.cashier))
        assert e.status_code == 403
        assert refused(R.prepaid_voucher_test_redemptions, b["id"], limit=10, **_ctx(w, w.cashier)).status_code == 403


# ── The batch list, offline ───────────────────────────────────────────────────


class TestListAndOffline:
    def test_the_list_shows_and_filters_it(self, w):
        on, off = batch(w, name="בבדיקה"), batch(w, test=False, name="אמיתי")
        from app.services import prepaid_voucher_analytics as PVA

        rows = R.list_prepaid_voucher_batches(include_cancelled=True, sort="newest", scope=PVA.make_scope(test_mode="yes"),
                                              **_ctx(w))["items"]
        assert [r["id"] for r in rows] == [on["id"]] and rows[0]["testMode"] is True
        rows = R.list_prepaid_voucher_batches(include_cancelled=True, sort="newest", scope=PVA.make_scope(test_mode="no"),
                                              **_ctx(w))["items"]
        assert [r["id"] for r in rows] == [off["id"]]

    def test_no_test_offline(self, w):
        from app.schemas.prepaid_voucher import PrepaidOfflineAssignIn

        b = batch(w, offlineAllowed=True)
        e = refused(R.assign_prepaid_batch_offline, b["id"], PrepaidOfflineAssignIn(target="machine", machineId=str(w.tills[0].id)),
                    **_ctx(w))
        assert (e.status_code, e.detail) == (409, TM.TEST_MODE_OFFLINE)
        set_test(w, b, False)
        R.assign_prepaid_batch_offline(b["id"], PrepaidOfflineAssignIn(target="machine", machineId=str(w.tills[0].id)), **_ctx(w))
        e = refused(set_test, w, b, True)
        assert (e.status_code, e.detail) == (409, TM.TEST_MODE_OFFLINE)


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self):
        path = ROOT / "alembic" / "versions" / "c7e4a2f9d1b6_prepaid_voucher_test_mode.py"
        spec = importlib.util.spec_from_file_location("migration_c7e4a2f9d1b6", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_and_offline(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert (module.revision, module.down_revision) == ("c7e4a2f9d1b6", "b5e2c8a417d3")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("tenants", "pos_machines", "shops", "prepaid_vouchers"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY, name VARCHAR(200))"))
            conn.execute(sa.text("INSERT INTO prepaid_voucher_batches (id, name) VALUES ('a', 'x')"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            insp = sa.inspect(conn)
            cols = {c["name"] for c in insp.get_columns("prepaid_voucher_batches")}
            assert {"test_mode", "test_mode_since", "test_mode_by"} <= cols
            assert conn.execute(sa.text("SELECT test_mode FROM prepaid_voucher_batches")).scalar() in (0, False)
            assert insp.has_table("prepaid_voucher_test_redemptions")
            assert {n for n, _ in module.INDEXES} <= {i["name"] for i in insp.get_indexes("prepaid_voucher_test_redemptions")}
        # A table the API's create_all made first (from the model): only what is missing is added.
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("tenants", "pos_machines", "shops", "prepaid_vouchers"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY)"))
            PrepaidVoucherTestRedemption.__table__.create(conn)
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert sql.count("ALTER TABLE prepaid_voucher_batches ADD COLUMN") == 3
        assert "CREATE TABLE prepaid_voucher_test_redemptions" in sql

    def test_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
        heads = script.get_heads()
        assert len(heads) == 1
        assert "c7e4a2f9d1b6" in {r.revision for r in script.iterate_revisions(heads[0], "base")}
