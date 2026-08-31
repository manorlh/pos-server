"""Cover for PUT /categories/reorder.

Reordering used to be N separate PUTs. The three things that can go wrong with the
replacement are: it renumbers another tenant's rows, it is not actually atomic, or it
does not tell the tills — a reorder nobody publishes is invisible until the next full
sync. One test each, plus the route-order trap.

Style matches the rest of tests/: no database, no client. The handler is called directly
with a scripted session.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.user import User, UserRole
from app.routers import categories as categories_router
from app.schemas.category import CategoryReorderRequest


class _FakeQuery:
    def __init__(self, rows, recorder):
        self._rows = rows
        self._recorder = recorder

    def filter(self, *criteria):
        self._recorder["filters"].extend(str(c) for c in criteria)
        return self

    def all(self):
        return self._rows


class _FakeSession:
    def __init__(self, rows):
        self.info: dict = {}
        self._rows = rows
        self.commits = 0
        self.recorder: dict = {"filters": []}
        #: sort_order values at the moment commit() was called
        self.state_at_commit = None

    def query(self, *_entities):
        return _FakeQuery(self._rows, self.recorder)

    def commit(self):
        self.commits += 1
        self.state_at_commit = [(r.id, r.sort_order) for r in self._rows]


def _category(tenant_id, *, sort_order: int, company_id=None, machine_id=None):
    row = MagicMock()
    row.id = uuid.uuid4()
    row.tenant_id = tenant_id
    row.company_id = company_id
    row.shop_id = None
    row.pos_machine_id = machine_id
    row.sort_order = sort_order
    return row


def _user(role: UserRole, **kw) -> User:
    u = MagicMock(spec=User)
    u.role = role
    for k, v in kw.items():
        setattr(u, k, v)
    return u


def _body(rows_and_positions):
    return CategoryReorderRequest.model_validate(
        {"order": [{"id": str(r.id), "sortOrder": p} for r, p in rows_and_positions]}
    )


# ── Request shape ────────────────────────────────────────────────────────────

def test_an_empty_order_is_rejected() -> None:
    with pytest.raises(ValidationError):
        CategoryReorderRequest.model_validate({"order": []})


def test_two_positions_for_one_category_are_rejected() -> None:
    # Applying the last one silently would make the result depend on list order.
    cid = str(uuid.uuid4())
    with pytest.raises(ValidationError):
        CategoryReorderRequest.model_validate(
            {"order": [{"id": cid, "sortOrder": 0}, {"id": cid, "sortOrder": 1}]}
        )


# ── Guards ───────────────────────────────────────────────────────────────────

def test_a_cashier_cannot_reorder_the_menu() -> None:
    tenant = uuid.uuid4()
    row = _category(tenant, sort_order=0)
    with pytest.raises(HTTPException) as e:
        categories_router.reorder_categories(
            _body([(row, 1)]), _user(UserRole.CASHIER, shop_id=None), tenant, _FakeSession([row])
        )
    assert e.value.status_code == 403


def test_the_role_gate_is_the_same_one_the_other_category_writes_use() -> None:
    src = inspect.getsource(categories_router.reorder_categories)
    assert "_CATALOG_ROLES" in src
    assert "_check_access(" in src


def test_an_id_outside_the_active_tenant_is_a_404_not_a_renumber() -> None:
    # The tenant filter is in the lookup, so a foreign id never comes back and the
    # count check turns it into "not found" — no renumbering, and no way to probe
    # whether the id exists in someone else's tenant.
    tenant = uuid.uuid4()
    mine = _category(tenant, sort_order=0)
    stranger = _category(uuid.uuid4(), sort_order=0)
    db = _FakeSession([mine])  # the foreign row is not returned by the query

    with pytest.raises(HTTPException) as e:
        categories_router.reorder_categories(
            _body([(mine, 0), (stranger, 1)]),
            _user(UserRole.SUPER_ADMIN),
            tenant,
            db,
        )
    assert e.value.status_code == 404
    assert db.commits == 0
    assert any("tenant_id" in f for f in db.recorder["filters"])


def test_nothing_is_written_when_one_id_is_unknown() -> None:
    tenant = uuid.uuid4()
    mine = _category(tenant, sort_order=7)
    ghost = _category(tenant, sort_order=0)
    db = _FakeSession([mine])

    with pytest.raises(HTTPException):
        categories_router.reorder_categories(
            _body([(mine, 0), (ghost, 1)]), _user(UserRole.SUPER_ADMIN), tenant, db
        )
    assert mine.sort_order == 7, "a rejected reorder must not have moved anything"


# ── Atomicity and the notify ─────────────────────────────────────────────────

def test_every_position_lands_in_a_single_commit(monkeypatch) -> None:
    tenant = uuid.uuid4()
    a = _category(tenant, sort_order=0)
    b = _category(tenant, sort_order=1)
    c = _category(tenant, sort_order=2)
    db = _FakeSession([a, b, c])
    monkeypatch.setattr(categories_router, "_trigger_catalog_notify_batch", lambda *a, **k: None)

    result = categories_router.reorder_categories(
        _body([(a, 2), (b, 0), (c, 1)]), _user(UserRole.SUPER_ADMIN), tenant, db
    )

    assert result.updated == 3
    assert db.commits == 1
    # One commit, and every new position was already set when it happened: the reorder
    # cannot be observed half-applied.
    assert db.state_at_commit == [(a.id, 2), (b.id, 0), (c.id, 1)]


def test_the_tills_are_told(monkeypatch) -> None:
    tenant = uuid.uuid4()
    a = _category(tenant, sort_order=0)
    b = _category(tenant, sort_order=1)
    db = _FakeSession([a, b])
    notified: list = []
    monkeypatch.setattr(
        categories_router,
        "_trigger_catalog_notify_batch",
        lambda _db, rows: notified.extend(rows),
    )

    categories_router.reorder_categories(
        _body([(a, 1), (b, 0)]), _user(UserRole.SUPER_ADMIN), tenant, db
    )
    # Without this the new order exists on the server and nowhere else until the next
    # full sync.
    assert {r.id for r in notified} == {a.id, b.id}


def test_a_no_op_reorder_does_not_wake_every_till(monkeypatch) -> None:
    tenant = uuid.uuid4()
    a = _category(tenant, sort_order=0)
    db = _FakeSession([a])
    calls: list = []
    monkeypatch.setattr(
        categories_router, "_trigger_catalog_notify_batch", lambda *args: calls.append(args)
    )

    result = categories_router.reorder_categories(
        _body([(a, 0)]), _user(UserRole.SUPER_ADMIN), tenant, db
    )
    # Re-sending the current order is valid and answers for every id asked about, but
    # there is nothing for the tills to pull.
    assert result.updated == 1
    assert calls == []


def test_the_batch_notify_does_not_fan_out_once_per_row(monkeypatch) -> None:
    tenant = uuid.uuid4()
    rows = [_category(tenant, sort_order=i) for i in range(5)]
    tenant_wide: list = []
    monkeypatch.setattr(
        categories_router,
        "notify_all_machines_for_tenant",
        lambda _db, tid, reason: tenant_wide.append((tid, reason)),
    )
    categories_router._trigger_catalog_notify_batch(MagicMock(), rows)
    assert tenant_wide == [(str(tenant), "category_change")]


def test_a_machine_local_category_notifies_only_its_machine(monkeypatch) -> None:
    tenant = uuid.uuid4()
    machine = uuid.uuid4()
    per_machine: list = []
    tenant_wide: list = []
    monkeypatch.setattr(
        categories_router,
        "notify_machine_catalog_changed",
        lambda tid, mid, reason: per_machine.append((tid, mid, reason)),
    )
    monkeypatch.setattr(
        categories_router,
        "notify_all_machines_for_tenant",
        lambda _db, tid, reason: tenant_wide.append(tid),
    )
    categories_router._trigger_catalog_notify_batch(
        MagicMock(), [_category(tenant, sort_order=0, machine_id=machine)]
    )
    assert per_machine == [(str(tenant), str(machine), "category_change")]
    assert tenant_wide == []


# ── The route-order trap ─────────────────────────────────────────────────────

def test_reorder_is_declared_before_the_category_id_route() -> None:
    # Routes match in declaration order. Below PUT /categories/{category_id}, the
    # literal path is swallowed as a category id and the endpoint is unreachable.
    paths = [
        (r.path, sorted(r.methods))
        for r in categories_router.router.routes
        if "PUT" in r.methods
    ]
    put_paths = [p for p, _ in paths]
    assert "/categories/reorder" in put_paths
    assert put_paths.index("/categories/reorder") < put_paths.index("/categories/{category_id}")
