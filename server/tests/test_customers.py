"""
Customers: the sync contract, the transaction link, and who may read the table.

The three things here that a database would not catch are: whether a *deleted*
customer still reaches the till (it must, or a delta sync can never propagate a
removal), whether a till can staple another tenant's customer onto its own document
(it must not), and whether the reads are gated at all — the same hole the recent
role-guard work found on vouchers.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Query, sessionmaker

from app.middleware.auth import get_current_user
from app.models.customer import Customer
from app.models.user import User, UserRole
from app.routers import customers as customers_router
from app.services import sync as S
from app.services import transactions as T


def _ts() -> datetime:
    return datetime(2026, 8, 28, 9, 0, tzinfo=timezone.utc)


def _customer(**kw) -> MagicMock:
    c = MagicMock()
    c.id = kw.get("id", uuid.uuid4())
    c.name = kw.get("name", "מכולת השדרה בע\"מ")
    c.vat_number = kw.get("vat_number", "514328977")
    c.phone = kw.get("phone", "03-1234567")
    c.email = kw.get("email", "billing@example.co.il")
    c.address = kw.get("address", "אלנבי")
    c.address_number = kw.get("address_number", "12")
    c.city = kw.get("city", "תל אביב")
    c.postal_code = kw.get("postal_code", "6100000")
    c.country = kw.get("country", "ישראל")
    c.is_active = kw.get("is_active", True)
    c.deleted_at = kw.get("deleted_at", None)
    c.created_at = _ts()
    c.updated_at = _ts()
    return c


# ── The wire contract the Android till reads ─────────────────────────────────

def test_customer_sync_row_uses_camel_case_keys() -> None:
    row = S._serialize_customer(_customer())
    for key in (
        "id", "name", "vatNumber", "phone", "email", "address",
        "isActive", "updatedAt", "deleted",
    ):
        assert key in row, key
    assert row["vatNumber"] == "514328977"
    assert row["isActive"] is True
    assert row["deleted"] is False
    assert row["updatedAt"] == _ts().isoformat()


def test_deleted_and_inactive_are_two_different_facts() -> None:
    # Archived: still on file, must not be offered for new sales.
    archived = S._serialize_customer(_customer(is_active=False))
    assert archived["isActive"] is False
    assert archived["deleted"] is False

    # Deleted: the till drops it, but the server keeps the row so documents already
    # issued to it can still say who they were issued to.
    removed = S._serialize_customer(_customer(is_active=False, deleted_at=_ts()))
    assert removed["deleted"] is True


def test_customer_sync_ships_deleted_rows_rather_than_filtering_them_out() -> None:
    # Unlike get_vouchers_for_sync, which filters is_active in the query. A filtered
    # query cannot express a deletion at all: a row that stops being returned looks
    # exactly like a row that has not changed, so on a delta pull the till would keep
    # offering a removed customer forever.
    sql: list[str] = []

    def _all(query):
        sql.append(str(query.statement.compile(dialect=postgresql.dialect())))
        return []

    with patch.object(Query, "all", _all):
        S.get_customers_for_sync(sessionmaker()(), str(uuid.uuid4()))

    assert len(sql) == 1
    # Only the WHERE clause matters; the SELECT list names every column by design.
    where = sql[0].split("WHERE", 1)[1]
    assert "is_active" not in where
    assert "deleted_at" not in where
    assert "customers.tenant_id" in where


def test_customer_delta_sync_filters_on_updated_at() -> None:
    sql: list[str] = []

    def _all(query):
        sql.append(str(query.statement.compile(dialect=postgresql.dialect())))
        return []

    with patch.object(Query, "all", _all):
        S.get_customers_for_sync(sessionmaker()(), str(uuid.uuid4()), since=_ts())

    assert "customers.updated_at >" in sql[0]


def test_customer_sync_is_empty_without_a_tenant() -> None:
    assert S.get_customers_for_sync(MagicMock(), None) == []


def test_a_customer_change_moves_the_catalog_watermark() -> None:
    # Customers ride the catalog payload, so a customer edit has to make the till's
    # last pull look stale — otherwise the new customer does not reach the counter
    # until something unrelated changes.
    source = inspect.getsource(S.get_catalog_change_watermark_for_machine)
    assert "Customer.updated_at" in source
    assert source.count("customer_max") >= 3  # defined, and used in both branches


# ── Linking a document to a customer ─────────────────────────────────────────

def test_free_text_customer_id_resolves_to_no_link() -> None:
    # A legacy desktop wrote a name in there. It must not become an error, and it must
    # not become a link either.
    assert T._resolve_customer_ref_id(MagicMock(), "Walk-in", uuid.uuid4()) is None


def test_unknown_customer_uuid_resolves_to_no_link() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    assert T._resolve_customer_ref_id(db, str(uuid.uuid4()), uuid.uuid4()) is None


def test_known_customer_uuid_resolves() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = (uuid.uuid4(),)
    wanted = uuid.uuid4()
    assert T._resolve_customer_ref_id(db, str(wanted), uuid.uuid4()) == wanted


def test_the_lookup_is_tenant_scoped() -> None:
    # Without the tenant predicate a machine could staple another merchant's customer
    # — name and ח.פ. included — onto its own tax invoice by guessing a UUID.
    sql: list[str] = []

    def _first(query):
        sql.append(str(query.statement.compile(dialect=postgresql.dialect())))
        return None

    with patch.object(Query, "first", _first):
        T._resolve_customer_ref_id(sessionmaker()(), str(uuid.uuid4()), uuid.uuid4())

    assert "customers.tenant_id" in sql[0]


def test_no_link_is_attempted_without_a_tenant_context() -> None:
    db = MagicMock()
    assert T._resolve_customer_ref_id(db, str(uuid.uuid4()), None) is None
    db.query.assert_not_called()


# ── Role gating ──────────────────────────────────────────────────────────────

def _user(role: UserRole) -> User:
    u = MagicMock(spec=User)
    u.role = role
    return u


def _declared_dependency(func, param_name: str = "current_user"):
    return inspect.signature(func).parameters[param_name].default.dependency


_HANDLERS = (
    customers_router.list_customers,
    customers_router.get_customer,
    customers_router.create_customer,
    customers_router.update_customer,
    customers_router.delete_customer,
)


@pytest.mark.parametrize("handler", _HANDLERS)
def test_every_handler_authenticates_as_a_dashboard_user(handler) -> None:
    # get_current_user explicitly rejects a machine JWT, so a till cannot reach this
    # router at all — it receives customers through the catalog sync instead.
    assert _declared_dependency(handler) is get_current_user


@pytest.mark.parametrize("role", [UserRole.CASHIER, UserRole.MERCHANT_ADMIN])
def test_a_cashier_may_not_even_list_customers(role) -> None:
    # Reads are gated as tightly as the writes. This table is personal and commercial
    # data — names, phones, ח.פ. numbers — and it is scoped to the tenant, while a
    # cashier's every other view is scoped to one shop.
    with pytest.raises(HTTPException) as exc:
        customers_router._require_role(_user(role))
    assert exc.value.status_code == 403


@pytest.mark.parametrize(
    "role",
    [
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER,
    ],
)
def test_catalog_roles_may_manage_customers(role) -> None:
    customers_router._require_role(_user(role))


def test_gating_matches_the_voucher_router_it_was_shaped_on() -> None:
    from app.routers import vouchers as vouchers_router

    assert customers_router._CATALOG_ROLES == vouchers_router._CATALOG_ROLES


# ── Deletion is a tombstone ──────────────────────────────────────────────────

def test_delete_marks_the_row_instead_of_removing_it() -> None:
    # A till that has been offline can push a sale tomorrow for a customer deleted
    # today; the FK on transactions.customer_ref_id would refuse that write if the
    # row were gone.
    customer = Customer(id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="X", is_active=True)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = customer

    with patch.object(customers_router, "ensure_same_tenant", lambda *a, **k: None), \
         patch.object(customers_router, "_trigger_catalog_notify", lambda *a, **k: None):
        customers_router.delete_customer(
            str(customer.id), _user(UserRole.SHOP_MANAGER), customer.tenant_id, db
        )

    db.delete.assert_not_called()
    assert customer.deleted_at is not None
    assert customer.is_active is False


def test_deleting_twice_does_not_move_the_tombstone() -> None:
    already = _ts()
    customer = Customer(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="X",
        is_active=False, deleted_at=already,
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = customer

    with patch.object(customers_router, "ensure_same_tenant", lambda *a, **k: None), \
         patch.object(customers_router, "_trigger_catalog_notify", lambda *a, **k: None):
        customers_router.delete_customer(
            str(customer.id), _user(UserRole.SHOP_MANAGER), customer.tenant_id, db
        )

    assert customer.deleted_at == already
    db.commit.assert_not_called()
