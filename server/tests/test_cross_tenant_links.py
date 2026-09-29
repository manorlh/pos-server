"""
A till's document can only link to its own tenant's rows (docs/SHIFTS_API.md §1.2).

Every id a document names — a line's product, an issued voucher and its product, a stock
movement's product, the customer, the refunded original, the approver — was looked up by
id alone (the customer aside), so a till could staple another merchant's rows onto its
own documents by naming a UUID. Now another tenant's id is, to the till, an unknown one:
a link is dropped with the same warning as an unknown UUID; a refunded original of
another tenant refuses the document (it decides sale or refund); another tenant's user
is an unknown approver.

Runs on the in-memory SQLite world in tests/shift_world.py, with a second tenant.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.models.category import Category
from app.models.company import Company
from app.models.customer import Customer
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.product import CatalogLevel, Product
from app.models.shift import ShiftStatus
from app.models.stock_movement import StockMovement
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.issued_voucher import IssuedVoucher
from app.models.user import User, UserRole
from app.models.voucher import Voucher
from app.routers import sync as sync_router
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import ably_notify
from app.services.approvals import _user_in_tenant
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: None)

    def catalogue(tenant_id, company_id, sku):
        category = Category(id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, name="Drinks")
        product = Product(
            id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, category_id=category.id,
            catalog_level=CatalogLevel.GLOBAL, name=f"Cola {sku}", price=Decimal("8"), sku=sku,
        )
        voucher = Voucher(id=uuid.uuid4(), tenant_id=tenant_id, name=f"Gift {sku}")
        customer = Customer(id=uuid.uuid4(), tenant_id=tenant_id, name=f"Customer {sku}")
        world.db.add(category)
        world.db.flush()
        world.db.add_all([product, voucher, customer])
        world.db.flush()
        return SimpleNamespace(product=product, voucher=voucher, customer=customer)

    other = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    world.db.add(other)
    world.db.flush()
    other_company = Company(id=uuid.uuid4(), tenant_id=other.id, name="Rival", vat_number="516161616")
    world.db.add(other_company)
    world.db.flush()
    world.own = catalogue(world.tenant.id, world.company.id, "OWN")
    world.foreign = catalogue(other.id, other_company.id, "FOREIGN")
    world.other_tenant = other
    world.db.commit()
    return world


def _push(w, docs):
    till = w.tills[0]
    return sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=docs), machine=till, db=w.db,
    )


def _doc(w, total="8.00", **extra) -> dict:
    shift = w.shift(w.tills[0], 1, status=ShiftStatus.OPEN) if not hasattr(w, "_open") else w._open
    w._open = shift
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 320, "totalAmount": total, "paymentMethod": "cash",
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "businessDate": str(TODAY),
        "shiftId": str(shift.id),
    }
    body.update(extra)
    return body


def _line(product_id, name):
    return {"id": str(uuid.uuid4()), "productId": str(product_id), "productName": name,
            "quantity": 1, "unitPrice": 8, "totalPrice": 8}


class TestLinksStayInTheTenant:
    def test_another_tenants_product_is_an_unknown_product(self, w):
        foreign, own = w.foreign.product.id, w.own.product.id
        sale = _doc(w, "16.00", items=[_line(foreign, "Theirs"), _line(own, "Ours")])

        (result,) = _push(w, [sale]).results

        assert result.status == "accepted"
        assert result.warnings == [f"items[0].productId: unknown '{foreign}', stored without the link"]
        links = {i.product_name: i.product_id for i in w.db.query(TransactionItem).all()}
        assert links == {"Theirs": None, "Ours": own}

    def test_another_tenants_voucher_and_its_product(self, w):
        def issued(voucher_id, product_id):
            return {"id": str(uuid.uuid4()), "voucherId": str(voucher_id), "productId": str(product_id),
                    "productName": "Gift", "quantity": 1, "unitValue": 50, "faceValue": 50,
                    "issuedAt": NOW.isoformat()}

        sale = _doc(w, "100.00", issuedVouchers=[
            issued(w.foreign.voucher.id, w.foreign.product.id),
            issued(w.own.voucher.id, w.own.product.id),
        ])

        (result,) = _push(w, [sale]).results

        assert result.status == "accepted", result.reason
        assert result.warnings == [
            f"issuedVouchers[0].voucherId: unknown '{w.foreign.voucher.id}', stored without the link",
            f"issuedVouchers[0].productId: unknown '{w.foreign.product.id}', stored without the link",
        ]
        rows = sorted(w.db.query(IssuedVoucher).all(), key=lambda r: r.voucher_id is None)
        assert (rows[0].voucher_id, rows[0].product_id) == (w.own.voucher.id, w.own.product.id)
        assert (rows[1].voucher_id, rows[1].product_id) == (None, None)

    def test_another_tenants_product_is_not_moved(self, w):
        def movement(product_id):
            return {"id": str(uuid.uuid4()), "productId": str(product_id), "delta": -1,
                    "reason": "sale", "occurredAt": NOW.isoformat()}

        sale = _doc(w, stockMovements=[movement(w.foreign.product.id), movement(w.own.product.id)])

        (result,) = _push(w, [sale]).results

        assert result.status == "accepted", result.reason
        assert result.warnings == [
            f"stockMovements[0].productId: unknown '{w.foreign.product.id}', movement not applied"
        ]
        assert [m.product_id for m in w.db.query(StockMovement).all()] == [w.own.product.id]

    def test_another_tenants_customer_is_not_linked(self, w):
        theirs = _doc(w, customerId=str(w.foreign.customer.id))
        ours = _doc(w, customerId=str(w.own.customer.id))

        _push(w, [theirs, ours])

        refs = {str(t.id): t.customer_ref_id for t in w.db.query(Transaction).all()}
        assert refs == {theirs["id"]: None, ours["id"]: w.own.customer.id}


class TestTheRefundedOriginal:
    def _foreign_sale(self, w) -> Transaction:
        rival_till = POSMachine(
            id=uuid.uuid4(), tenant_id=w.other_tenant.id, distributor_id=w.admin.id, name="Rival 1", machine_code="R-1",
            is_active=True, pairing_status=PairingStatus.ASSIGNED,
        )
        w.db.add(rival_till)
        w.db.flush()
        sale = Transaction(
            id=uuid.uuid4(), tenant_id=w.other_tenant.id, machine_id=rival_till.id, transaction_number="9",
            status=TransactionStatus.COMPLETED, document_type=320, payment_method="cash",
            total_amount=Decimal("50.00"), created_at=NOW, updated_at=NOW,
        )
        w.db.add(sale)
        w.db.flush()
        return sale

    def test_a_credit_note_for_another_tenants_sale_is_refused(self, w):
        theirs = self._foreign_sale(w)
        credit = _doc(w, "50.00", documentType=330, refundOfTransactionId=str(theirs.id))

        (result,) = _push(w, [credit]).results

        assert result.status == "rejected"
        assert result.reason == "refundOfTransactionId: names a document of another tenant"
        assert w.db.get(Transaction, uuid.UUID(credit["id"])) is None
        w.db.expire_all()
        assert w.db.get(Transaction, theirs.id).status == TransactionStatus.COMPLETED

    def test_a_credit_note_for_its_own_sale_is_fine(self, w):
        sale = _doc(w, "50.00")
        own = _doc(w, "20.00", documentType=330, refundOfTransactionId=sale["id"])

        results = _push(w, [sale, own]).results

        assert [r.status for r in results] == ["accepted"] * 2


class TestTheApproverIsOneOfTheTenantsPeople:
    def _user(self, w, role, *, tenant_id=None, member_of=None):
        user = User(id=uuid.uuid4(), role=role, tenant_id=tenant_id, is_active=True,
                    email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:8])
        w.db.add(user)
        w.db.flush()
        if member_of is not None:
            w.db.add(TenantMembership(id=uuid.uuid4(), tenant_id=member_of, user_id=user.id,
                                      role=TenantMembershipRole.TENANT_ADMIN))
            w.db.flush()
        return user

    def test_the_rule(self, w):
        till = w.tills[0]
        assert _user_in_tenant(w.db, w.admin, till)  # super admin, platform-wide
        assert _user_in_tenant(w.db, self._user(w, UserRole.COMPANY_MANAGER, member_of=w.tenant.id), till)
        assert _user_in_tenant(w.db, self._user(w, UserRole.SHOP_MANAGER, tenant_id=w.tenant.id), till)
        assert not _user_in_tenant(
            w.db, self._user(w, UserRole.COMPANY_MANAGER, tenant_id=w.other_tenant.id,
                             member_of=w.other_tenant.id), till,
        )
        distributor = self._user(w, UserRole.DISTRIBUTOR)
        assert not _user_in_tenant(w.db, distributor, till)
        till.distributor_id = distributor.id
        assert _user_in_tenant(w.db, distributor, till)

    def test_another_tenants_manager_cannot_approve_here(self, w):
        rival = self._user(w, UserRole.COMPANY_MANAGER, tenant_id=w.other_tenant.id,
                           member_of=w.other_tenant.id)
        sale = _doc(w, "8.00", documentDiscount="1.00", approvedByUserId=str(rival.id))

        (result,) = _push(w, [sale]).results

        assert (result.status, result.reason) == ("rejected", "approver_unknown_or_inactive")
        assert w.db.get(Transaction, uuid.UUID(sale["id"])) is None
