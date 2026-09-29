"""
A document approved by a **till user** (a shop manager on the till's roster):
`approvedByPosUserId`, the elevation grant's `approverPosUserId`.

Checked like `approvedByUserId` (tests/test_document_approval.py): the till user must be
real, active, of the till's tenant, of the till's own shop, and hold what the document
needed. A claim that fails refuses the document — stripping it would pass a false
approval off as an ordinary document. Naming both kinds of approver is refused too.

Runs on the in-memory SQLite world in tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.models.pos_user import PosUser, PosUserRole
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.transaction import Transaction
from app.routers import sync as sync_router
from app.schemas.transaction import TransactionsBatchEnvelope
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)
    return world


def _pos_user(w, shop, *, role=PosUserRole.SHOP_MANAGER, active=True, tenant_id="same"):
    user = PosUser(
        id=uuid.uuid4(),
        tenant_id=w.tenant.id if tenant_id == "same" else tenant_id,
        shop_id=shop.id,
        username=f"u{uuid.uuid4().hex[:6]}",
        pin_hash="x",
        role=role,
        is_active=active,
    )
    w.db.add(user)
    w.db.flush()
    return user


def _credit(shift_id, **extra):
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 330, "totalAmount": "10.00",
        "paymentMethod": "cash", "shiftId": str(shift_id), "businessDate": str(TODAY),
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
    }
    body.update(extra)
    return body


def _push(w, doc):
    till = w.tills[0]
    response = sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=[doc]), machine=till, db=w.db,
    )
    return response.results[0]


@pytest.fixture
def shift(w):
    return w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)


class TestATillUserApprover:
    def test_a_shop_manager_of_the_tills_shop_is_stored(self, w, shift):
        manager = _pos_user(w, w.shop)
        doc = _credit(shift.id, approvedByPosUserId=str(manager.id))

        result = _push(w, doc)

        assert result.status == "accepted"
        stored = w.db.get(Transaction, uuid.UUID(doc["id"]))
        assert stored.approved_by_pos_user_id == manager.id
        assert stored.approved_by_user_id is None

    def test_a_legacy_till_user_with_no_tenant_is_read_by_its_shop(self, w, shift):
        manager = _pos_user(w, w.shop, tenant_id=None)
        assert _push(w, _credit(shift.id, approvedByPosUserId=str(manager.id))).status == "accepted"

    def test_a_cashier_cannot_approve_a_refund(self, w, shift):
        cashier = _pos_user(w, w.shop, role=PosUserRole.CASHIER)

        result = _push(w, _credit(shift.id, approvedByPosUserId=str(cashier.id)))

        assert (result.status, result.reason) == ("rejected", "approver_lacks_scope:refund")

    @pytest.mark.parametrize("case", ["unknown", "inactive", "other_tenant"])
    def test_an_unknown_inactive_or_foreign_one_is_refused(self, w, shift, case):
        if case == "unknown":
            approver = uuid.uuid4()
        elif case == "inactive":
            approver = _pos_user(w, w.shop, active=False).id
        else:
            rival = Tenant(id=uuid.uuid4(), name="R", slug="r", timezone="Asia/Jerusalem")
            w.db.add(rival)
            w.db.flush()
            rival_shop = Shop(id=uuid.uuid4(), tenant_id=rival.id, company_id=w.company.id, name="R", settings={})
            w.db.add(rival_shop)
            w.db.flush()
            approver = _pos_user(w, rival_shop, tenant_id=rival.id).id
        doc = _credit(shift.id, approvedByPosUserId=str(approver))

        result = _push(w, doc)

        assert (result.status, result.reason) == ("rejected", "approver_unknown_or_inactive")
        assert w.db.get(Transaction, uuid.UUID(doc["id"])) is None

    def test_a_manager_of_another_shop_is_not_permitted_here(self, w, shift):
        elsewhere = _pos_user(w, w.other_shop)

        result = _push(w, _credit(shift.id, approvedByPosUserId=str(elsewhere.id)))

        assert (result.status, result.reason) == ("rejected", "approver_not_permitted_at_machine")

    def test_naming_both_kinds_of_approver_is_refused(self, w, shift):
        manager = _pos_user(w, w.shop)

        result = _push(w, _credit(
            shift.id, approvedByPosUserId=str(manager.id), approvedByUserId=str(w.admin.id),
        ))

        assert (result.status, result.reason) == ("rejected", "approver_ambiguous")

    def test_an_unreadable_one_refuses_the_document(self, w, shift):
        result = _push(w, _credit(shift.id, approvedByPosUserId="dana"))

        assert result.status == "rejected"
        assert result.reason.startswith("approvedByPosUserId:")

    def test_it_comes_back_out_on_the_document(self, w, shift):
        from app.schemas.transaction import TransactionOut

        manager = _pos_user(w, w.shop)
        doc = _credit(shift.id, approvedByPosUserId=str(manager.id))
        _push(w, doc)

        out = TransactionOut.model_validate(w.db.get(Transaction, uuid.UUID(doc["id"])))
        assert out.model_dump(by_alias=True, mode="json")["approvedByPosUserId"] == str(manager.id)
