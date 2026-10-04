"""
Three follow-ups to the cloud Z, each a way a filed document could quietly drift:

* **The Z header is frozen.** A Z says who issued it; built from live settings at read
  time, a rename or a new address would rewrite every Z the shop ever filed.
* **A late document is never lost, and never silent.** A document can reach the cloud
  after its shift closed. Before a Z the shift's X is recomputed to include it; after a
  Z it is stored all the same and the shift and the Z are flagged, since the Z's
  figures are fixed.
* **The till learns the Z number of older shifts** (`recentShiftZs` on the heartbeat),
  so a reprint of an X can carry it.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.models.shift import Shift, ShiftStatus
from app.models.z_report import ZReport
from app.schemas.transaction import TransactionIn
from app.services import ably_notify
from app.services import z_runs as ZR
from app.services.shifts import recent_shift_zs
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY, accept_str_uuids, make_world
from test_z_run import closed_shift, run, sel, z_of

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    return world


def _doc(shift_id, total="30.00", number=None, updated=NOW):
    return TransactionIn.model_validate({
        "id": str(uuid.uuid4()), "transactionNumber": number or str(uuid.uuid4().int)[:8],
        "status": "completed", "totalAmount": total, "paymentMethod": "cash", "reprintCount": 0,
        "createdAt": NOW.isoformat(), "updatedAt": updated.isoformat(),
        "shiftId": str(shift_id), "businessDate": str(TODAY),
    })


# ── The frozen header ────────────────────────────────────────────────────────


class TestTheZHeaderIsFrozen:
    def test_the_header_is_taken_at_build(self, w):
        closed_shift(w, w.tills[0], 1, [])
        z = z_of(w, run(w, sel(w.tills[0])))

        assert z.header["businessName"] == "Acme"
        assert z.header["vatNumber"] == "515151515"
        assert z.header["companyId"] == str(w.company.id)
        assert z.header["shopName"] == "Center"
        assert z.header["capturedAt"]

    def test_a_later_rename_does_not_rewrite_a_filed_z(self, w):
        from app.routers import z_reports as zr_router

        closed_shift(w, w.tills[0], 1, [])
        z = z_of(w, run(w, sel(w.tills[0])))
        w.company.name = "Acme Renamed Ltd"
        w.company.vat_number = "999999999"
        w.shop.name = "Somewhere Else"
        w.shop.settings = {"businessInfo": {"companyName": "Override"}}
        w.db.commit()

        out = zr_router.get_z_report(z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert out.business.business_name == "Acme"
        assert out.business.vat_number == "515151515"
        assert out.business.shop_name == "Center"

    def test_the_tenant_business_info_layer_is_honoured(self, w):
        w.tenant.settings = {"businessInfo": {"companyName": "Tenant Name", "companyCity": "Haifa"}}
        w.shop.settings = {"businessInfo": {"companyName": "Shop Name"}}
        closed_shift(w, w.tills[0], 1, [])

        header = z_of(w, run(w, sel(w.tills[0]))).header

        assert header["businessName"] == "Shop Name"  # shop overrides tenant
        assert header["city"] == "Haifa"

    def test_a_z_without_a_header_serves_none_rather_than_live_settings(self, w):
        from app.routers import z_reports as zr_router

        closed_shift(w, w.tills[0], 1, [])
        z = z_of(w, run(w, sel(w.tills[0])))
        z.header = None
        w.db.commit()

        out = zr_router.get_z_report(z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        assert out.business is None


# ── Late documents ───────────────────────────────────────────────────────────


class TestALateDocumentBeforeAZ:
    def test_the_x_is_recomputed_and_the_shift_flagged(self, w):
        till = w.tills[0]
        shift = closed_shift(w, till, 1, [dict(total="10.00")])
        assert shift.total_sales == Decimal("10.00")

        results = upsert_transactions(w.db, till, [_doc(shift.id, "30.00")])

        assert [r.status for r in results] == ["accepted"]
        stored = w.db.get(Shift, shift.id)
        assert stored.total_sales == Decimal("40.00")
        assert stored.transactions_count == 2
        assert stored.late_documents == 1
        assert stored.status == ShiftStatus.CLOSED

    def test_the_next_z_includes_it(self, w):
        till = w.tills[0]
        shift = closed_shift(w, till, 1, [dict(total="10.00")])
        upsert_transactions(w.db, till, [_doc(shift.id, "30.00")])

        z = z_of(w, run(w, sel(till)))

        assert z.total_sales == Decimal("40.00")
        assert z.late_documents == 0

    def test_a_repush_of_a_known_document_is_not_late(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _doc(shift.id)
        upsert_transactions(w.db, till, [doc])
        shift.status = ShiftStatus.CLOSED
        w.db.flush()

        doc.updated_at = (NOW + timedelta(minutes=1)).replace(tzinfo=None)  # SQLite reads back naive
        upsert_transactions(w.db, till, [doc])

        assert w.db.get(Shift, shift.id).late_documents == 0

    def test_an_open_shift_is_the_ordinary_case_and_not_flagged(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)

        upsert_transactions(w.db, till, [_doc(shift.id)])

        assert w.db.get(Shift, shift.id).late_documents == 0

    def test_it_is_visible_in_the_z_candidates_and_the_shift_list(self, w):
        from app.routers import shifts as shifts_router
        from app.routers import z_runs as zr_router

        till = w.tills[0]
        shift = closed_shift(w, till, 1, [])
        upsert_transactions(w.db, till, [_doc(shift.id)])
        w.db.commit()

        cands = zr_router.get_z_candidates(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        listed = shifts_router.list_shifts(
            shop_id=None, machine_id=till.id, status_=None, awaiting_z=None, from_date=None,
            to_date=None, page=1, page_size=50, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        detail = shifts_router.get_shift(shift.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

        mine = next(m for m in cands.machines if m.machine_id == till.id)
        assert mine.closed_shifts[0].late_documents == 1
        assert listed.items[0].late_documents == 1
        assert detail.late_documents == 1
        assert detail.model_dump(by_alias=True)["lateDocuments"] == 1


class TestALateDocumentAfterTheZ:
    def test_it_is_stored_and_both_the_shift_and_the_z_are_flagged(self, w):
        from app.models.transaction import Transaction

        till = w.tills[0]
        shift = closed_shift(w, till, 1, [dict(total="10.00")])
        z = z_of(w, run(w, sel(till)))
        late = _doc(shift.id, "30.00")

        results = upsert_transactions(w.db, till, [late])

        assert [r.status for r in results] == ["accepted"]
        assert w.db.get(Transaction, late.id).shift_id == shift.id
        stored_shift = w.db.get(Shift, shift.id)
        assert stored_shift.late_documents == 1
        assert w.db.get(ZReport, z.id).late_documents == 1

    def test_the_zs_figures_and_the_shifts_x_are_not_rewritten(self, w):
        till = w.tills[0]
        shift = closed_shift(w, till, 1, [dict(total="10.00")])
        z = z_of(w, run(w, sel(till)))

        upsert_transactions(w.db, till, [_doc(shift.id, "30.00")])

        assert w.db.get(ZReport, z.id).total_sales == Decimal("10.00")
        assert w.db.get(Shift, shift.id).total_sales == Decimal("10.00")

    def test_the_z_list_says_so(self, w):
        from app.routers import z_reports as zr_router

        till = w.tills[0]
        shift = closed_shift(w, till, 1, [])
        z_of(w, run(w, sel(till)))
        upsert_transactions(w.db, till, [_doc(shift.id)])
        w.db.commit()

        out = zr_router.list_z_reports(
            machine_id=None, machine_ids=None, shop_id=w.shop.id, from_date=None, to_date=None,
            closed_from=None, closed_to=None, area_id=None, date_basis="business", tz=None,
            page=1, page_size=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

        assert out.items[0].late_documents == 1
        assert out.model_dump(by_alias=True)["items"][0]["lateDocuments"] == 1


# ── Z numbers of older shifts, on the heartbeat ──────────────────────────────


class TestRecentShiftZs:
    def test_the_heartbeat_lists_this_tills_shifts_in_recent_zs_newest_first(self, w):
        from app.routers import machines as machines_router
        from app.schemas.pos_machine import MachineHeartbeatBody

        till = w.tills[0]
        a = closed_shift(w, till, 1, [])
        first = z_of(w, run(w, sel(till)))
        first.closed_at = NOW - timedelta(days=2)
        b = closed_shift(w, till, 2, [])
        c = closed_shift(w, till, 3, [])
        second = z_of(w, run(w, sel(till)))
        second.closed_at = NOW - timedelta(hours=1)
        closed_shift(w, w.tills[1], 1, [])
        z_of(w, run(w, sel(w.tills[1])))  # another till's Z is not listed
        w.db.flush()

        response = machines_router.post_my_heartbeat(
            body=MachineHeartbeatBody.model_validate({}), machine=till, db=w.db
        )

        assert response["zReportedThroughSequence"] == 3
        assert response["recentShiftZs"] == [
            {"shiftId": str(c.id), "zReportId": str(second.id), "zNumber": second.shop_sequence_number},
            {"shiftId": str(b.id), "zReportId": str(second.id), "zNumber": second.shop_sequence_number},
            {"shiftId": str(a.id), "zReportId": str(first.id), "zNumber": first.shop_sequence_number},
        ]

    def test_only_the_last_30_days_and_at_most_50(self, w):
        till = w.tills[0]
        old = closed_shift(w, till, 1, [])
        z = z_of(w, run(w, sel(till)))
        z.closed_at = NOW - timedelta(days=31)
        w.db.flush()

        assert recent_shift_zs(w.db, till.id, now=NOW) == []
        assert recent_shift_zs(w.db, till.id, now=NOW, days=40)[0]["shiftId"] == str(old.id)

        for seq in range(2, 60):
            w.shift(till, seq).z_report_id = z.id
        z.closed_at = NOW
        w.db.flush()
        assert len(recent_shift_zs(w.db, till.id, now=NOW)) == 50

    def test_empty_for_a_till_with_no_z(self, w):
        assert recent_shift_zs(w.db, w.tills[0].id, now=NOW) == []
