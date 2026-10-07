"""
The transactions search by till and the rest, and its export (docs/SPEC_REPORTS.md §1–2).

"תשדרג את חיפוש עסקאות בענן לפי קופה גם · בכל דוח תאפשר לייצא לאקסל": the list takes several
tills at once, document types, employees, statuses, an amount range and a document number —
server-side, inside the reader's tenant and scope — and the export returns EVERY document
the same filters match (not the page on screen), with the money a bookkeeper reconciles on.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.transaction import TransactionStatus
from app.models.user import User, UserRole
from app.routers import transactions as R
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    t1, t2 = world.tills
    s1 = world.shift(t1, 1)
    s2 = world.shift(t2, 1)
    world.a = world.doc(t1, s1, "100.00", discount="10.00", vat="13.08", number="1")
    world.a.cashier_id = "emp-1"
    world.b = world.doc(t2, s2, "50.00", method="card", number="2")
    world.b.cashier_id = "emp-2"
    world.c = world.doc(t2, s2, "20.00", credit_note=True, number="3")
    world.d = world.doc(world.other_till, None, "999.00", number="4")
    world.db.flush()
    return world


def _list(w, **kw):
    kw.setdefault("from_date", TODAY - timedelta(days=1))
    kw.setdefault("to_date", TODAY + timedelta(days=1))
    out = R.list_transactions(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db, page=1, page_size=200, **kw)
    return {i.transaction_number for i in out.items}


def _export(w, **kw):
    kw.setdefault("from_date", TODAY - timedelta(days=1))
    kw.setdefault("to_date", TODAY + timedelta(days=1))
    return R.export_transactions(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db, **kw)


class TestTheTillFilter:
    def test_several_tills_at_once(self, w):
        t1, t2 = w.tills
        assert _list(w, machine_ids=[t1.id, w.other_till.id]) == {"1", "4"}
        assert _list(w, machine_ids=[t2.id]) == {"2", "3"}

    def test_the_single_till_of_the_scope_still_works_and_narrows_with_the_list(self, w):
        t1, t2 = w.tills
        assert _list(w, machine_id=t1.id) == {"1"}
        assert _list(w, machine_id=t1.id, machine_ids=[t2.id]) == {"1", "2", "3"}

    def test_no_till_is_every_till(self, w):
        assert _list(w) == {"1", "2", "3", "4"}


class TestTheOtherFilters:
    def test_document_types(self, w):
        assert _list(w, document_types=[330]) == {"3"}
        assert _list(w, document_types=[320, 330], machine_ids=[w.tills[1].id]) == {"2", "3"}

    def test_employees(self, w):
        assert _list(w, cashier_ids=["emp-1", "emp-2"]) == {"1", "2"}
        assert _list(w, cashier_ids=[" "]) == {"1", "2", "3", "4"}

    def test_statuses(self, w):
        w.b.status = TransactionStatus.CANCELLED
        w.db.flush()
        assert _list(w, statuses=["cancelled"]) == {"2"}

    def test_an_amount_range(self, w):
        assert _list(w, amount_min=Decimal("20"), amount_max=Decimal("100")) == {"1", "2", "3"}
        assert _list(w, amount_min=Decimal("500")) == {"4"}

    def test_a_document_number(self, w):
        assert _list(w, document_number="3") == {"3"}

    def test_the_payment_and_card_filters_still_apply(self, w):
        assert _list(w, method="card") == {"2"}
        assert _list(w, method="refunds") == {"3"}


class TestScope:
    def test_a_shop_manager_sees_only_their_shop(self, w):
        manager = User(
            id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="m@x", username="m",
            shop_id=w.other_shop.id, company_id=w.company.id,
        )
        w.db.add(manager)
        w.db.flush()
        out = R.list_transactions(
            current_user=manager, active_tenant_id=w.tenant.id, db=w.db, page=1, page_size=50,
            machine_ids=[t.id for t in w.tills] + [w.other_till.id],
            from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1),
        )
        assert {i.transaction_number for i in out.items} == {"4"}
        assert out.total == 1

    def test_another_tenant_sees_nothing(self, w):
        out = _export(w, machine_ids=[w.tills[0].id])
        assert out["total"] == 1
        other = R.export_transactions(
            current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db,
            from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1),
        )
        assert other["total"] == 0


class TestExport:
    def test_every_matching_document_not_a_page(self, w):
        for i in range(260):
            w.doc(w.tills[0], None, "1.00", number=str(1000 + i))
        out = _export(w, machine_ids=[w.tills[0].id])
        assert out["total"] == 261 and len(out["items"]) == 261

    def test_a_row_carries_what_a_bookkeeper_reconciles_on(self, w):
        out = _export(w, machine_ids=[w.tills[0].id])
        row = out["items"][0]
        assert row["documentNumber"] == "1" or row["documentNumber"].endswith("1")
        assert row["documentType"] == 320 and row["status"] == "completed"
        assert row["totalAmount"] == "100.00" and row["documentDiscount"] == "10.00"
        assert row["collected"] == "90.00" and row["signedAmount"] == "90.00"
        assert row["vatAmount"] == "13.08" and row["netOfVat"] == "76.92"
        assert row["cash"] == "90.00" and row["card"] == "0.00"
        assert row["machineName"] == "Till 1" and row["shopName"] == "Center"
        assert row["cashierId"] == "emp-1"
        assert row["shiftNumber"] == 1 and row["zNumber"] is None

    def test_a_credit_note_is_signed_negative(self, w):
        out = _export(w, document_types=[330])
        assert out["items"][0]["signedAmount"] == "-20.00"

    def test_too_many_is_refused_with_a_message(self, w, monkeypatch):
        monkeypatch.setattr(R, "EXPORT_MAX_ROWS", 2)
        with pytest.raises(HTTPException) as e:
            _export(w)
        assert e.value.status_code == 400 and "צמצמו" in e.value.detail

    def test_the_route_is_before_the_document_route(self):
        paths = [getattr(r, "path", None) for r in R.router.routes]
        assert paths.index("/transactions/export") < paths.index("/transactions/{transaction_id}")
