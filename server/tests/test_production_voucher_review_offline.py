"""
The independent review (09.10), offline findings, as the reviewer put them:

4.  An offline sync revived a cancelled voucher.
11. Device B's redemption id "dev-1" was taken for device A's — a duplicate; and a reversal gave
    back to whatever voucher the new row named.
12. Two assigns at once both passed; a batch with a live hold was handed to a device.
13. A device moved to another shop kept downloading the batch.
14. Undoing an offline over-use gave back units that were never taken.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherEvent, PrepaidVoucherOfflineAssignment, PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherReserveIn
from app.services import prepaid_voucher_offline as PVO
from test_prepaid_vouchers import _ctx, vouchers, w  # noqa: F401 — `w` is the fixture
from test_production_voucher_offline import assign, batch, refused, sync

import uuid


def red(a, v, rid, w, quantity=2, reversed_at=None):
    out = {"id": rid, "assignmentId": a["id"], "voucherId": v["id"], "redeemedAt": datetime.now(timezone.utc).isoformat(),
           "units": [{"productId": str(w.hotdog.id), "productName": "נקניקייה", "quantity": quantity, "valueAgorot": 2500 * quantity}],
           "coveredAgorot": 2500 * quantity, "redemptionAccounting": "payment"}
    if reversed_at:
        out["reversedAt"] = reversed_at
    return out


def row(w, voucher_id) -> PrepaidVoucher:
    v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.id == uuid.UUID(voucher_id)).one()
    w.db.refresh(v)
    return v


def test_4_a_cancelled_voucher_stays_cancelled_and_is_flagged(w):
    b = batch(w)
    a = assign(w, b)
    v = vouchers(w, b)[0]
    R.cancel_prepaid_voucher(v["id"], None, **_ctx(w))
    out = sync(w, w.tills[0], [red(a, v, "dev-1", w)])
    assert out["results"][0]["status"] == "accepted" and "cancelled" in out["results"][0]["flags"]
    assert row(w, v["id"]).status == "cancelled"


def test_11_the_device_id_is_per_device_and_names_one_voucher(w):
    first, second = batch(w), batch(w)
    a = assign(w, first, till=w.tills[0])
    b2 = assign(w, second, till=w.tills[1])
    v1, w1 = vouchers(w, first)[0], vouchers(w, second)[0]
    assert sync(w, w.tills[0], [red(a, v1, "dev-1", w)])["results"][0]["status"] == "accepted"
    # Another device's "dev-1" is its own redemption, not a duplicate of the first.
    assert sync(w, w.tills[1], [red(b2, w1, "dev-1", w)])["results"][0]["status"] == "accepted"
    assert w.db.query(PrepaidVoucherRedemption).count() == 2
    # The first device's "dev-1" for another voucher: refused, never applied to the stored row's.
    v2 = vouchers(w, first)[1]
    assert sync(w, w.tills[0], [red(a, v2, "dev-1", w)])["results"] == [{"id": "dev-1", "status": "rejected", "reason": "id_conflict"}]
    # Its reversal gives back to its own voucher.
    sync(w, w.tills[0], [red(a, v1, "dev-1", w, reversed_at=datetime.now(timezone.utc).isoformat())])
    assert row(w, v1["id"]).remaining[str(w.hotdog.id)] == 2 and row(w, w1["id"]).remaining[str(w.hotdog.id)] == 0


def test_12_a_live_hold_or_a_kiosk_or_an_inactive_till_is_refused(w):
    b = batch(w)
    code = vouchers(w, b)[0]["code"]
    till = w.tills[1]
    R.reserve_prepaid_voucher(str(till.id), PrepaidVoucherReserveIn(
        code=code, clientRequestId="h1", saleRef="s1", features=["accounting", "reserve_goods"],
        units=[{"productId": str(w.hotdog.id), "quantity": 1, "listPriceAgorot": 2500}]), machine=till, db=w.db)
    assert refused(assign, w, b).detail == PVO.HOLDS_LIVE
    other = batch(w)
    w.tills[1].is_active = False
    w.db.commit()
    assert refused(assign, w, other, till=w.tills[1]).detail == PVO.WRONG_SHOP
    # One live assignment per batch (the index backs the lock).
    assign(w, other)
    names = {i.name for i in PrepaidVoucherOfflineAssignment.__table__.indexes}
    assert "ux_prepaid_voucher_offline_assignments_live" in names


def test_13_a_device_moved_to_another_shop_loses_the_assignment(w):
    b = batch(w)
    assign(w, b)
    till = w.tills[0]
    till.shop_id = w.other_shop.id
    w.db.commit()
    assert R.download_prepaid_offline(str(till.id), machine=till, db=w.db)["assignments"] == []
    a = w.db.query(PrepaidVoucherOfflineAssignment).one()
    assert (a.status, a.forced) == ("released", True)
    assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "offline_force_release").count() == 1


def test_14_undoing_an_over_use_gives_back_only_what_was_taken(w):
    b = batch(w)
    a = assign(w, b)
    v = vouchers(w, b)[0]
    sync(w, w.tills[0], [red(a, v, "dev-1", w)])  # both hot dogs
    out = sync(w, w.tills[0], [red(a, v, "dev-2", w)])  # the same two again: nothing left to take
    assert out["results"][0]["flags"] == ["over_use"]
    over = w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.client_redemption_id == "dev-2").one()
    assert over.units[0]["takenQuantity"] == 0
    now = datetime.now(timezone.utc).isoformat()
    sync(w, w.tills[0], [red(a, v, "dev-2", w, reversed_at=now)])
    assert row(w, v["id"]).remaining[str(w.hotdog.id)] == 0  # it took nothing: nothing comes back
    sync(w, w.tills[0], [red(a, v, "dev-1", w, reversed_at=now)])
    assert row(w, v["id"]).remaining[str(w.hotdog.id)] == 2
