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

import pytest

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


def test_nit_a_device_sale_past_the_stacking_rule_is_flagged(w):
    from app.schemas.prepaid_voucher import PrepaidVoucherBatchUpdate

    b = batch(w)
    R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(stacking="single"), **_ctx(w))
    a = assign(w, b)
    v1, v2 = vouchers(w, b)[:2]
    first = red(a, v1, "dev-1", w, quantity=1)
    second = red(a, v2, "dev-2", w, quantity=1)
    first["saleRef"] = second["saleRef"] = "sale-7"
    sync(w, w.tills[0], [first])
    out = sync(w, w.tills[0], [second])
    assert "stacking" in out["results"][0]["flags"]


def test_nit_the_migration_indexes_and_legacy_discounts():
    import importlib.util
    import io
    import pathlib

    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions" / "c5d2a8e4f913_prepaid_voucher_review_fixes.py"
    spec = importlib.util.spec_from_file_location("migration_c5d2a8e4f913", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "a7d4e9c2b158"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE prepaid_voucher_redemptions (id CHAR(32) PRIMARY KEY, tenant_id CHAR(32), "
                             "machine_id CHAR(32), client_redemption_id VARCHAR(100))"))
        conn.execute(sa.text("CREATE UNIQUE INDEX ux_prepaid_voucher_redemptions_client ON prepaid_voucher_redemptions "
                             "(tenant_id, client_redemption_id)"))
        conn.execute(sa.text("CREATE TABLE prepaid_voucher_offline_assignments (id CHAR(32) PRIMARY KEY, batch_id CHAR(32), status VARCHAR(16))"))
        for table in ("prepaid_voucher_batches", "prepaid_voucher_types"):
            conn.execute(sa.text(f"CREATE TABLE {table} (id CHAR(32) PRIMARY KEY, kind VARCHAR(16), redemption_accounting VARCHAR(16))"))
            conn.execute(sa.text(f"INSERT INTO {table} VALUES ('a', 'items', 'zero'), ('b', 'order_discount', 'zero')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        names = {i["name"] for i in sa.inspect(conn).get_indexes("prepaid_voucher_redemptions")}
        assert "ux_prepaid_voucher_redemptions_device_client" in names and "ux_prepaid_voucher_redemptions_client" not in names
        conn.execute(sa.text("INSERT INTO prepaid_voucher_redemptions VALUES ('1', 't', 'm1', 'dev-1'), ('2', 't', 'm2', 'dev-1')"))
        conn.execute(sa.text("INSERT INTO prepaid_voucher_offline_assignments VALUES ('1', 'b', 'released'), ('2', 'b', 'active')"))
        with pytest.raises(sa.exc.IntegrityError):
            conn.execute(sa.text("INSERT INTO prepaid_voucher_offline_assignments VALUES ('3', 'b', 'releasing')"))
        assert dict(conn.execute(sa.text("SELECT id, redemption_accounting FROM prepaid_voucher_batches")).all()) == {
            "a": "zero", "b": "discount"}
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    sql = buf.getvalue()
    assert "SET LOCAL lock_timeout" in sql and "WHERE status IN ('active', 'releasing')" in sql

