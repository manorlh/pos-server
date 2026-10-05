"""
Prepaid vouchers: the per-batch report and the per-voucher note.

* **Report** — voucher counts by state; per product issued / taken / forfeited /
  outstanding / void, adding up to issued; redemptions by hour and day in the tenant's
  time, by shop, till and employee; a reversed redemption counts nowhere.
* **Note** — set, cleared, shown on the dashboard and in the till's lookup; scoped
  like the voucher itself.

Runs on the world of tests/test_prepaid_vouchers.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.models.prepaid_voucher import PrepaidVoucherRedemption
from app.models.user import User, UserRole
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherNoteIn, PrepaidVoucherRedeemIn
from test_prepaid_vouchers import (  # noqa: F401
    _ctx,
    first_code,
    lookup,
    make_batch,
    redeem,
    refused,
    vouchers,
    w,
)


def report(w, batch, user=None, tz="Asia/Jerusalem"):
    return R.prepaid_voucher_batch_report(batch["id"], tz=tz, **_ctx(w, user))


def redeem_as(w, code, items, *, till, user_id, user_name):
    body = PrepaidVoucherRedeemIn(
        code=code,
        items=[{"productId": str(p.id), "quantity": q} for p, q in items],
        clientRequestId=str(uuid.uuid4()),
        posUserId=user_id,
        posUserName=user_name,
    )
    return R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


def stamp(w, redemption_id, moment):
    row = w.db.get(PrepaidVoucherRedemption, uuid.UUID(redemption_id))
    row.redeemed_at = moment
    w.db.commit()


class TestReport:
    def test_counts_goods_and_breakdowns(self, w):
        batch = make_batch(w, count=4, split=True)
        codes = [v["code"] for v in vouchers(w, batch)]
        # Voucher 1: all of it, at Till 1 by דנה, 10:15 Israel time on 12.8.
        a = redeem_as(w, codes[0], [(w.hotdog, 1), (w.drink, 2)], till=w.tills[0], user_id="7", user_name="דנה")
        stamp(w, a["redemptionId"], datetime(2026, 8, 12, 7, 15, tzinfo=timezone.utc))
        # Voucher 2: one drink at the other shop's till by יוסי, 23:30 on 12.8 (20:30 UTC).
        b = redeem_as(w, codes[1], [(w.drink, 1)], till=w.other_till, user_id="9", user_name="יוסי")
        stamp(w, b["redemptionId"], datetime(2026, 8, 12, 20, 30, tzinfo=timezone.utc))
        # …and the hot dog at 00:30 on 13.8 Israel time (21:30 UTC on 12.8).
        c = redeem_as(w, codes[1], [(w.hotdog, 1)], till=w.other_till, user_id="9", user_name="יוסי")
        stamp(w, c["redemptionId"], datetime(2026, 8, 12, 21, 30, tzinfo=timezone.utc))
        # Voucher 4: cancelled untouched.
        R.cancel_prepaid_voucher(vouchers(w, batch)[3]["id"], **_ctx(w))

        out = report(w, batch)
        assert out["vouchers"] == {"total": 4, "active": 1, "partiallyUsed": 1, "used": 1, "cancelled": 1}
        goods = {p["name"]: p for p in out["products"]}
        assert goods["נקניקייה"] == {
            **goods["נקניקייה"], "issued": 4, "taken": 2, "forfeited": 0, "outstanding": 1, "void": 1,
        }
        assert goods["שתייה"] == {
            **goods["שתייה"], "issued": 8, "taken": 3, "forfeited": 0, "outstanding": 3, "void": 2,
        }
        for p in out["products"]:
            assert p["issued"] == p["taken"] + p["forfeited"] + p["outstanding"] + p["void"]

        assert out["totals"] == {"redemptions": 3, "vouchers": 2, "units": 5}
        assert [(h["hour"], h["units"]) for h in out["byHour"]] == [(0, 1), (10, 3), (23, 1)]
        days = {d["date"]: d for d in out["byDay"]}
        assert (days["2026-08-12"]["redemptions"], days["2026-08-12"]["units"]) == (2, 4)
        assert {p["name"]: p["quantity"] for p in days["2026-08-13"]["products"]} == {"נקניקייה": 1, "שתייה": 0}
        assert [(s["name"], s["units"]) for s in out["byShop"]] == [("Center", 3), ("North", 2)]
        assert [(t["name"], t["shopName"], t["redemptions"]) for t in out["byTill"]] == [
            ("Till 1", "Center", 1), ("North 1", "North", 2),
        ]
        assert [(e["name"], e["vouchers"], e["units"]) for e in out["byEmployee"]] == [("דנה", 1, 3), ("יוסי", 1, 2)]

    def test_forfeited_goods_are_reported_as_such(self, w):
        batch = make_batch(w, count=1, split=False)
        redeem(w, first_code(w, batch), [(w.hotdog, 1)], forfeit=True)
        goods = {p["name"]: p for p in report(w, batch)["products"]}
        assert (goods["שתייה"]["taken"], goods["שתייה"]["forfeited"], goods["שתייה"]["outstanding"]) == (0, 2, 0)

    def test_a_reversed_redemption_counts_nowhere(self, w):
        batch = make_batch(w, count=2)
        code = first_code(w, batch)
        out = redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        till = w.tills[0]
        R.reverse_prepaid_redemption(str(till.id), out["redemptionId"], machine=till, db=w.db)
        rep = report(w, batch)
        assert rep["totals"] == {"redemptions": 0, "vouchers": 0, "units": 0}
        assert rep["byHour"] == [] and rep["byDay"] == [] and rep["byTill"] == [] and rep["byEmployee"] == []
        assert all(p["taken"] == 0 for p in rep["products"])
        assert rep["vouchers"]["active"] == 2
        assert {p["name"]: p["outstanding"] for p in rep["products"]} == {"נקניקייה": 2, "שתייה": 4}

    def test_an_empty_batch(self, w):
        rep = report(w, make_batch(w, count=3))
        assert rep["totals"]["redemptions"] == 0 and rep["vouchers"]["total"] == 3
        assert rep["timezone"] == "Asia/Jerusalem"

    def test_scoped_like_the_batch(self, w):
        batch = make_batch(w)
        north = User(
            id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id,
            email="n@x", username="north", shop_id=w.other_shop.id,
        )
        w.db.add(north)
        w.db.commit()
        assert refused(report, w, batch, north).status_code == 403
        assert refused(report, w, batch, w.cashier).status_code == 403


class TestNote:
    def test_set_shown_on_dashboard_and_till_and_cleared(self, w):
        batch = make_batch(w)
        v = vouchers(w, batch)[0]
        out = R.set_prepaid_voucher_note(v["id"], PrepaidVoucherNoteIn(note="  נמסר לדני — במה "), **_ctx(w))
        assert out["note"] == "נמסר לדני — במה"
        assert vouchers(w, batch)[0]["note"] == "נמסר לדני — במה"
        assert lookup(w, v["code"])["note"] == "נמסר לדני — במה"
        assert R.get_prepaid_voucher(v["id"], **_ctx(w))["note"] == "נמסר לדני — במה"
        out = R.set_prepaid_voucher_note(v["id"], PrepaidVoucherNoteIn(note="   "), **_ctx(w))
        assert out["note"] is None and lookup(w, v["code"])["note"] is None

    def test_a_used_voucher_can_still_get_a_note(self, w):
        batch = make_batch(w)
        v = vouchers(w, batch)[0]
        redeem(w, v["code"], [(w.hotdog, 1), (w.drink, 2)])
        assert R.set_prepaid_voucher_note(v["id"], PrepaidVoucherNoteIn(note="x"), **_ctx(w))["note"] == "x"

    def test_scoped_and_bounded(self, w):
        batch = make_batch(w)
        v = vouchers(w, batch)[0]
        assert refused(R.set_prepaid_voucher_note, v["id"], PrepaidVoucherNoteIn(note="x"), **_ctx(w, w.cashier)).status_code == 403
        assert refused(R.set_prepaid_voucher_note, str(uuid.uuid4()), PrepaidVoucherNoteIn(note="x"), **_ctx(w)).status_code == 404
        with pytest.raises(ValidationError):
            PrepaidVoucherNoteIn(note="x" * 1001)


def test_the_new_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    assert ("GET", "/api/v1/prepaid-vouchers/batches/{batch_id}/report") in mounted
    assert ("PUT", "/api/v1/prepaid-vouchers/vouchers/{voucher_id}/note") in mounted
