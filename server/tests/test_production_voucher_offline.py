"""
Redemption without the internet (the production vouchers contract §7): a batch assigned to a till
(or its shop's LAN host), refused everywhere else meanwhile; the device's download (code hashes,
never codes) and its sync (idempotent, over-use flagged never refused, a reversal gives back);
release only once everything synced, or by force with a reason.
"""
from __future__ import annotations

import hashlib
import importlib.util
import io
import pathlib
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherEvent, PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidOfflineAssignIn,
    PrepaidOfflineReleaseIn,
    PrepaidOfflineSyncIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherLookupIn,
)
from app.services import prepaid_voucher_offline as PVO
from test_prepaid_vouchers import _ctx, vouchers, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]


def batch(w, offline=True, count=2):
    body = PrepaidVoucherBatchCreate(
        name="פסטיבל", companyId=w.company.id, count=count, offlineAllowed=offline, redemptionAccounting="payment",
        items=[{"productId": w.hotdog.id, "quantity": 2}], splitAllowed=True,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def assign(w, b, till=None, target="machine"):
    till = till or w.tills[0]
    return R.assign_prepaid_batch_offline(
        b["id"], PrepaidOfflineAssignIn(target=target, machineId=str(till.id)), **_ctx(w))


def look(w, code, till):
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, features=["accounting"]), machine=till, db=w.db)


def sync(w, till, redemptions, pending=0):
    return R.sync_prepaid_offline(str(till.id), PrepaidOfflineSyncIn(pending=pending, redemptions=redemptions), machine=till, db=w.db)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


class TestAssign:
    def test_only_when_allowed_and_once(self, w):
        assert refused(assign, w, batch(w, offline=False)).detail == PVO.OFFLINE_NOT_ALLOWED
        b = batch(w)
        first = assign(w, b)
        assert (first["target"], first["status"], first["machineName"]) == ("machine", "active", "Till 1")
        assert assign(w, b)["id"] == first["id"]  # the same target again
        assert refused(assign, w, b, till=w.tills[1]).detail == PVO.OFFLINE_ASSIGNED
        assert refused(assign, w, b, target="lan_host").detail in (PVO.OFFLINE_ASSIGNED, PVO.NO_MAIN_TILL)

    def test_only_a_till_of_the_batchs_shops(self, w):
        b = batch(w)
        R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(shopIds=[w.shop.id]), **_ctx(w))
        assert refused(assign, w, b, till=w.other_till).detail == PVO.WRONG_SHOP
        out = R.prepaid_batch_offline_targets(b["id"], **_ctx(w))
        assert out["offlineAllowed"] is True
        (shop,) = out["shops"]
        assert (shop["shopId"], [m["name"] for m in shop["machines"]]) == (str(w.shop.id), ["Till 1", "Till 2"])
        assert assign(w, b)["machineName"] == "Till 1"

    def test_refused_everywhere_else_meanwhile(self, w):
        b = batch(w)
        code = vouchers(w, b)[0]["code"]
        assign(w, b)
        other = look(w, code, w.tills[1])
        assert (other["redeemable"], other["reason"], other["message"]) == (
            False, PVO.ASSIGNED_OFFLINE, "השובר משויך לעבודה ללא אינטרנט בTill 1")
        # The device itself redeems the batch from its local copy only (review 09.10): never twice.
        own = look(w, code, w.tills[0])
        assert (own["redeemable"], own["reason"], own["message"]) == (
            False, PVO.ASSIGNED_OFFLINE, PVO.ASSIGNED_HERE_TEXT)

    def test_the_switch_cannot_go_off_while_assigned(self, w):
        b = batch(w)
        assign(w, b)
        e = refused(R.update_prepaid_voucher_batch, b["id"], PrepaidVoucherBatchUpdate(offlineAllowed=False), **_ctx(w))
        assert e.detail == PVO.OFFLINE_ASSIGNED


class TestDevice:
    def test_the_download_has_hashes_never_codes(self, w):
        b = batch(w)
        assign(w, b)
        till = w.tills[0]
        out = R.download_prepaid_offline(str(till.id), machine=till, db=w.db)
        (a,) = out["assignments"]
        assert (a["target"], a["snapshot"]["redemptionAccounting"], a["snapshot"]["pricing"]) == ("machine", "payment", "cover")
        first = vouchers(w, b)[0]
        want = hashlib.sha256(first["code"].encode()).hexdigest()
        assert a["vouchers"][0]["codeHash"] == want and "code" not in a["vouchers"][0]
        assert a["vouchers"][0]["unitsLeft"] == 2
        assert first["code"] not in str(out)
        assert R.download_prepaid_offline(str(w.tills[1].id), machine=w.tills[1], db=w.db)["assignments"] == []

    def test_sync_once_flag_over_use_reverse(self, w):
        b = batch(w)
        a = assign(w, b)
        till = w.tills[0]
        v = vouchers(w, b)[0]
        red = {"id": "dev-1", "assignmentId": a["id"], "voucherId": v["id"], "redeemedAt": datetime.now(timezone.utc).isoformat(),
               "saleRef": "s1", "transactionId": "tx-9", "posUserId": "7", "posUserName": "דנה",
               "units": [{"productId": str(w.hotdog.id), "productName": "נקניקייה", "quantity": 2, "valueAgorot": 5000,
                          "listValueAgorot": 5000, "coveredAgorot": 5000}],
               "coveredAgorot": 5000, "redemptionAccounting": "payment"}
        assert sync(w, till, [red])["results"] == [{"id": "dev-1", "status": "accepted"}]
        assert sync(w, till, [red])["results"] == [{"id": "dev-1", "status": "duplicate"}]
        row = w.db.query(PrepaidVoucherRedemption).one()
        assert (row.offline, row.client_redemption_id, row.covered_agorot, row.transaction_id) == (True, "dev-1", 5000, "tx-9")
        voucher = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.id == uuid.UUID(v["id"])).one()
        assert voucher.status == "used"
        # The same voucher again on the device: a fiscal fact by now — recorded, flagged.
        again = {**red, "id": "dev-2"}
        assert sync(w, till, [again])["results"] == [{"id": "dev-2", "status": "accepted", "flags": ["over_use"]}]
        # The first was undone on the device: its units come back.
        sync(w, till, [{**red, "reversedAt": datetime.now(timezone.utc).isoformat()}])
        w.db.refresh(voucher)
        assert voucher.remaining[str(w.hotdog.id)] == 2

    def test_another_devices_assignment_is_rejected(self, w):
        b = batch(w)
        a = assign(w, b)
        v = vouchers(w, b)[0]
        out = sync(w, w.tills[1], [{"id": "x", "assignmentId": a["id"], "voucherId": v["id"], "units": []}])
        assert out["results"] == [{"id": "x", "status": "rejected", "reason": "assignment_not_found"}]


class TestRelease:
    def test_by_force_with_a_reason(self, w):
        b = batch(w)
        assign(w, b)
        till = w.tills[0]
        R.download_prepaid_offline(str(till.id), machine=till, db=w.db)
        release = lambda **kw: R.release_prepaid_batch_offline(b["id"], PrepaidOfflineReleaseIn(**kw), **_ctx(w))  # noqa: E731
        sync(w, till, [], pending=3)
        assert refused(release, force=True).detail == PVO.REASON_REQUIRED
        out = release(force=True, reason="הקופה נגנבה")
        assert (out["assignment"]["status"], out["assignment"]["forced"]) == ("released", True)
        assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "offline_force_release").count() == 1

    def test_in_two_steps_the_device_acknowledges(self, w):
        """Review 09.10: the release is requested; it completes when the device acknowledges with nothing pending."""
        b = batch(w)
        a = assign(w, b)
        till = w.tills[0]
        code = vouchers(w, b)[0]["code"]
        R.download_prepaid_offline(str(till.id), machine=till, db=w.db)
        out = R.release_prepaid_batch_offline(b["id"], PrepaidOfflineReleaseIn(), **_ctx(w))
        assert out["assignment"]["status"] == "releasing"
        # Meanwhile the batch is still the device's: refused everywhere else, and the device is told.
        assert look(w, code, w.tills[1])["reason"] == PVO.ASSIGNED_OFFLINE
        (d,) = R.download_prepaid_offline(str(till.id), machine=till, db=w.db)["assignments"]
        assert d["status"] == "releasing"
        answer = R.sync_prepaid_offline(str(till.id), PrepaidOfflineSyncIn(pending=2, releaseAck=[a["id"]]), machine=till, db=w.db)
        assert answer["assignments"][0]["status"] == "releasing"  # something still pending: not yet
        answer = R.sync_prepaid_offline(str(till.id), PrepaidOfflineSyncIn(pending=0, releaseAck=[a["id"]]), machine=till, db=w.db)
        assert answer["assignments"] == []
        history = R.get_prepaid_batch_offline(b["id"], **_ctx(w))
        assert history["assignment"] is None and history["history"][0]["status"] == "released"
        assert look(w, code, w.tills[1])["redeemable"] is True

    def test_a_device_that_never_downloaded_is_released_at_once(self, w):
        b = batch(w)
        assign(w, b)
        out = R.release_prepaid_batch_offline(b["id"], PrepaidOfflineReleaseIn(), **_ctx(w))
        assert (out["assignment"]["status"], out["assignment"]["forced"]) == ("released", False)


def test_the_migration():
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    path = ROOT / "alembic" / "versions" / "c8e1f5a3b702_prepaid_voucher_offline.py"
    spec = importlib.util.spec_from_file_location("migration_c8e1f5a3b702", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "a3f7c2d9e614"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE tenants (id CHAR(32) PRIMARY KEY)"))
        conn.execute(sa.text("CREATE TABLE prepaid_voucher_redemptions (id CHAR(32) PRIMARY KEY, tenant_id CHAR(32), "
                             "client_redemption_id VARCHAR(100))"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        insp = sa.inspect(conn)
        assert insp.has_table("prepaid_voucher_offline_assignments")
        assert "ux_prepaid_voucher_redemptions_client" in {i["name"] for i in insp.get_indexes("prepaid_voucher_redemptions")}
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
    assert "CREATE TABLE prepaid_voucher_offline_assignments" in buf.getvalue()
    assert "CREATE UNIQUE INDEX ux_prepaid_voucher_redemptions_client" in buf.getvalue()
