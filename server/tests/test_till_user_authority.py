"""Cover for till users carrying their own authority.

A shop manager signed in at their own till used to be asked to approve themselves:
the till recognised the roles `"admin"` and `"manager"`, which `PosUserRole` has never
contained, and every catalog write demanded a grant typed by a cloud account. This
file covers what replaced that, and each test names a way it could look like it
worked while protecting nothing:

* a till role nobody classified, silently getting nothing — or everything;
* a username matching somebody in a *different* shop who happens to share it;
* a till user's PIN guessable without limit through the approval prompt;
* a till-user grant that survives the person being deactivated, demoted or moved;
* a till naming a cashier, or another shop's manager, and writing on their authority;
* a category rename from one till changing the button on every till in the tenant;
* a rename that lands in the database but never reaches the till's delta pull.

Most of the suite scripts its sessions, which cannot tell whether a query filtered at
all. The shop boundary here *is* a filter, so `_FakeDb` evaluates the handful of
SQLAlchemy expression shapes these queries use against in-memory rows. Drop
`PosUser.shop_id == machine.shop_id` from a query and a test below fails.
"""
from __future__ import annotations

import enum
import inspect
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import (
    BinaryExpression,
    BindParameter,
    BooleanClauseList,
    False_,
    Grouping,
    Null,
    True_,
)
from sqlalchemy.sql.functions import Function

from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.elevated_session import ElevatedSession
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop import Shop
from app.models.shop_category_override import ShopCategoryOverride
from app.models.user import UserRole
from app.services import elevation
from app.services.auth import get_password_hash
from app.services.permissions import Scope, pos_user_till_scopes, till_grantable_scopes


def _now():
    return datetime.now(timezone.utc)


# ── A session that actually applies its filters ───────────────────────────────


def _norm(value):
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value


def _value(expr, row):
    if isinstance(expr, BindParameter):
        return expr.value
    if isinstance(expr, (True_,)):
        return True
    if isinstance(expr, (False_,)):
        return False
    if isinstance(expr, Null):
        return None
    if isinstance(expr, Grouping):
        return _value(expr.element, row)
    if isinstance(expr, Function):
        args = [_value(a, row) for a in expr.clauses]
        if expr.name.lower() == "lower":
            return None if args[0] is None else str(args[0]).lower()
        raise NotImplementedError(expr.name)
    key = getattr(expr, "key", None)
    if key is not None and getattr(expr, "table", None) is not None:
        return getattr(row, key)
    raise NotImplementedError(type(expr))


def _matches(clause, row) -> bool:
    if isinstance(clause, BooleanClauseList):
        results = [_matches(c, row) for c in clause.clauses]
        return any(results) if clause.operator is operators.or_ else all(results)
    if isinstance(clause, Grouping):
        return _matches(clause.element, row)
    if isinstance(clause, BinaryExpression):
        op = clause.operator
        left = _norm(_value(clause.left, row))
        if op is operators.in_op:
            right = [_norm(v) for v in clause.right.value] if isinstance(
                clause.right, BindParameter
            ) else [_norm(_value(v, row)) for v in clause.right.element.clauses]
            return left in right
        right = _norm(_value(clause.right, row))
        if op is operators.eq:
            return left == right
        if op is operators.ne:
            return left != right
        if op is operators.is_:
            return left is right or left == right
        if op is operators.is_not:
            return not (left is right or left == right)
        if op is operators.gt:
            return left is not None and right is not None and left > right
        raise NotImplementedError(op)
    raise NotImplementedError(type(clause))


class _Query:
    def __init__(self, rows):
        self._rows = list(rows)
        self._clauses = []

    def filter(self, *clauses):
        self._clauses.extend(clauses)
        return self

    def order_by(self, *_):
        return self

    def _hits(self):
        return [r for r in self._rows if all(_matches(c, r) for c in self._clauses)]

    def first(self):
        hits = self._hits()
        return hits[0] if hits else None

    def all(self):
        return self._hits()

    def __iter__(self):
        return iter(self._hits())


class _FakeDb:
    """Rows by model class; `add` files new objects under their class too."""

    def __init__(self, *rows):
        self.rows: dict = {}
        self.added: list = []
        self.commits = 0
        for row in rows:
            self._file(row)

    def _file(self, row):
        self.rows.setdefault(type(row), []).append(row)

    def query(self, model):
        return _Query(self.rows.get(model, []))

    def add(self, obj):
        self.added.append(obj)
        if obj not in self.rows.get(type(obj), []):
            self._file(obj)

    def flush(self):
        pass

    def commit(self):
        self.commits += 1

    def refresh(self, _obj):
        pass


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _pos_user(shop_id, *, role=PosUserRole.SHOP_MANAGER, username="dana", pin="4815", **kw):
    return PosUser(
        id=kw.get("id", uuid.uuid4()),
        shop_id=shop_id,
        username=username,
        first_name=kw.get("first_name", "Dana"),
        last_name=kw.get("last_name", "Levi"),
        pin_hash=get_password_hash(pin),
        role=role,
        is_active=kw.get("is_active", True),
        pin_failed_count=0,
        pin_locked_until=None,
    )


def _machine(shop_id=None, tenant_id=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        shop_id=shop_id or uuid.uuid4(),
        tenant_id=tenant_id or uuid.uuid4(),
        pairing_status="assigned",
    )


# ── The till-role map ─────────────────────────────────────────────────────────


class TestTillRoleMap:
    def test_every_till_role_has_been_decided(self):
        """
        A role added to `PosUserRole` must fail here until somebody decides what it may
        do — in `_POS_USER_SCOPES_BY_ROLE` *and* in the till's `TillAuthority`. The bug
        this replaces was exactly two tables that disagreed about who a manager is.
        """
        assert set(PosUserRole) == {PosUserRole.CASHIER, PosUserRole.SHOP_MANAGER}

    def test_a_shop_manager_holds_all_four_scopes(self):
        assert pos_user_till_scopes(PosUserRole.SHOP_MANAGER) == {
            Scope.REFUND, Scope.DISCOUNT, Scope.DAY_CLOSE, Scope.CATALOG_WRITE,
        }

    def test_a_till_shop_manager_matches_a_cloud_shop_manager(self):
        # One meaning of "shop manager", whichever table the person is in.
        assert pos_user_till_scopes(PosUserRole.SHOP_MANAGER) == till_grantable_scopes(
            UserRole.SHOP_MANAGER
        )

    def test_a_cashier_holds_nothing(self):
        assert pos_user_till_scopes(PosUserRole.CASHIER) == frozenset()

    @pytest.mark.parametrize("phantom", ["manager", "admin", "Manager", "supervisor", "", None])
    def test_strings_that_are_not_till_roles_get_nothing(self, phantom):
        # "manager" and "admin" are what the till used to look for. Neither exists.
        assert pos_user_till_scopes(phantom) == frozenset()

    def test_the_wire_string_is_accepted_as_well_as_the_enum(self):
        assert pos_user_till_scopes(" SHOP_MANAGER ") == pos_user_till_scopes(
            PosUserRole.SHOP_MANAGER
        )


# ── Approving by till username ────────────────────────────────────────────────


def _elevate(db, machine, **body):
    from app.routers.elevation import create_elevation
    from app.schemas.elevation import ElevationRequest

    body.setdefault("pin", "4815")
    body.setdefault("scopes", ["refund"])
    return create_elevation(ElevationRequest(**body), machine=machine, db=db)


class TestUsernameElevation:
    def test_a_shop_manager_approves_by_username(self):
        machine = _machine()
        dana = _pos_user(machine.shop_id)
        db = _FakeDb(dana)

        response = _elevate(db, machine, username="dana")

        assert response.scopes == ["refund"]
        assert response.user_login == "dana"
        assert response.user_email is None
        assert response.user_name == "Dana Levi"
        grant = next(o for o in db.added if isinstance(o, ElevatedSession))
        assert grant.pos_user_id == dana.id
        assert grant.user_id is None

    def test_the_username_is_not_case_sensitive(self):
        machine = _machine()
        db = _FakeDb(_pos_user(machine.shop_id, username="Dana"))
        assert _elevate(db, machine, username="  dANA ").user_login == "Dana"

    def test_a_namesake_in_another_shop_is_not_found(self):
        """
        Usernames are unique per shop, not per tenant. Without the shop filter, the
        Dizengoff till would authenticate Ramat Aviv's Dana — and grant against her role.
        """
        machine = _machine()
        db = _FakeDb(_pos_user(uuid.uuid4(), username="dana"))

        with pytest.raises(HTTPException) as exc:
            _elevate(db, machine, username="dana")
        assert exc.value.status_code == 401

    def test_a_wrong_pin_and_an_unknown_name_look_the_same(self):
        machine = _machine()
        db = _FakeDb(_pos_user(machine.shop_id))
        with pytest.raises(HTTPException) as wrong_pin:
            _elevate(db, machine, username="dana", pin="0000")
        with pytest.raises(HTTPException) as no_such:
            _elevate(db, machine, username="nobody")
        assert wrong_pin.value.status_code == no_such.value.status_code == 401
        assert wrong_pin.value.detail == no_such.value.detail

    def test_guessing_a_pin_through_the_prompt_locks_it(self):
        machine = _machine()
        db = _FakeDb(_pos_user(machine.shop_id))
        for _ in range(elevation.settings.till_pin_max_attempts):
            with pytest.raises(HTTPException) as exc:
                _elevate(db, machine, username="dana", pin="0000")
            assert exc.value.status_code == 401

        # Locked now — even the right PIN is refused until the lockout passes.
        with pytest.raises(HTTPException) as exc:
            _elevate(db, machine, username="dana", pin="4815")
        assert exc.value.status_code == 429
        assert int(exc.value.headers["Retry-After"]) > 0

    def test_an_inactive_till_user_cannot_approve(self):
        machine = _machine()
        db = _FakeDb(_pos_user(machine.shop_id, is_active=False))
        with pytest.raises(HTTPException) as exc:
            _elevate(db, machine, username="dana")
        assert exc.value.status_code == 401

    def test_a_cashier_authenticates_but_may_approve_nothing(self):
        machine = _machine()
        db = _FakeDb(_pos_user(machine.shop_id, role=PosUserRole.CASHIER, username="yossi"))
        with pytest.raises(HTTPException) as exc:
            _elevate(db, machine, username="yossi")
        assert exc.value.status_code == 403
        assert exc.value.detail == "not_permitted_here"

    @pytest.mark.parametrize(
        "body",
        [
            {"pin": "4815"},
            {"pin": "4815", "username": "dana", "email": "dana@shop.co.il"},
            {"pin": "4815", "username": "   "},
        ],
    )
    def test_exactly_one_identity_is_required(self, body):
        from app.schemas.elevation import ElevationRequest

        with pytest.raises(ValidationError):
            ElevationRequest(**body)


# ── A till-user grant, re-checked on every use ────────────────────────────────


class _TokenLookup:
    def __init__(self, row):
        self._row = row

    def query(self, _model):
        return SimpleNamespace(filter=lambda *_: SimpleNamespace(first=lambda: self._row))

    def add(self, _obj):
        pass


def _till_user_grant(pos_user, *, shop_id=None, scopes=("catalog:write",)):
    return SimpleNamespace(
        revoked_at=None,
        expires_at=_now() + timedelta(minutes=5),
        absolute_expires_at=_now() + timedelta(hours=4),
        scopes=list(scopes),
        user_id=None,
        user=None,
        pos_user_id=pos_user.id,
        pos_user=pos_user,
        shop_id=shop_id or pos_user.shop_id,
        machine_id=uuid.uuid4(),
        last_used_at=None,
        per_action_consumed_at=None,
    )


class TestTillUserGrantLifetime:
    def test_a_live_till_user_grant_resolves(self):
        dana = _pos_user(uuid.uuid4())
        row = _till_user_grant(dana)
        assert elevation.resolve_session(_TokenLookup(row), "token") is row

    def test_deactivating_the_till_user_ends_it(self):
        dana = _pos_user(uuid.uuid4())
        row = _till_user_grant(dana)
        dana.is_active = False
        assert elevation.resolve_session(_TokenLookup(row), "token") is None

    def test_demoting_the_till_user_ends_it(self):
        dana = _pos_user(uuid.uuid4())
        row = _till_user_grant(dana)
        dana.role = PosUserRole.CASHIER
        assert elevation.resolve_session(_TokenLookup(row), "token") is None

    def test_moving_the_till_user_to_another_shop_ends_it(self):
        dana = _pos_user(uuid.uuid4())
        row = _till_user_grant(dana)
        dana.shop_id = uuid.uuid4()
        assert elevation.resolve_session(_TokenLookup(row), "token") is None

    @pytest.mark.parametrize("holders", ["both", "neither"])
    def test_a_grant_has_exactly_one_holder(self, holders):
        machine = _machine()
        dana = _pos_user(machine.shop_id)
        user = MagicMock() if holders == "both" else None
        pos_user = dana if holders == "both" else None
        with pytest.raises(ValueError):
            elevation.create_session(_FakeDb(), user, machine, [Scope.REFUND], pos_user=pos_user)


# ── Catalog writes on the operator's own authority ────────────────────────────


def _catalog_authority(db, machine, *, token=None, operator_id=None):
    from app.middleware.auth import require_catalog_authority

    dependency = require_catalog_authority(Scope.CATALOG_WRITE)
    return dependency(machine=machine, elevation_token=token, operator_id=operator_id, db=db)


class TestCatalogAuthority:
    def test_a_signed_in_shop_manager_writes_with_no_grant(self):
        machine = _machine()
        dana = _pos_user(machine.shop_id)
        actor = _catalog_authority(_FakeDb(dana), machine, operator_id=str(dana.id))
        assert actor.pos_user_id == dana.id
        assert actor.user_id is None

    def test_a_signed_in_cashier_is_sent_to_find_someone(self):
        machine = _machine()
        yossi = _pos_user(machine.shop_id, role=PosUserRole.CASHIER, username="yossi")
        with pytest.raises(HTTPException) as exc:
            _catalog_authority(_FakeDb(yossi), machine, operator_id=str(yossi.id))
        # 401, not 403: the till's answer to 401 is to ask for a PIN.
        assert exc.value.status_code == 401
        assert exc.value.detail == "elevation_required"

    def test_naming_another_shops_manager_lends_no_authority(self):
        machine = _machine()
        elsewhere = _pos_user(uuid.uuid4())
        with pytest.raises(HTTPException) as exc:
            _catalog_authority(_FakeDb(elsewhere), machine, operator_id=str(elsewhere.id))
        assert exc.value.status_code == 401

    def test_a_deactivated_manager_lends_no_authority(self):
        machine = _machine()
        dana = _pos_user(machine.shop_id, is_active=False)
        with pytest.raises(HTTPException) as exc:
            _catalog_authority(_FakeDb(dana), machine, operator_id=str(dana.id))
        assert exc.value.status_code == 401

    @pytest.mark.parametrize("operator_id", [None, "", "not-a-uuid", str(uuid.uuid4())])
    def test_no_usable_operator_means_a_grant_is_required(self, operator_id):
        machine = _machine()
        with pytest.raises(HTTPException) as exc:
            _catalog_authority(_FakeDb(), machine, operator_id=operator_id)
        assert exc.value.status_code == 401

    def test_a_presented_grant_wins_over_the_operator(self, monkeypatch):
        """
        A cashier's till with a manager's grant attributes the write to the manager —
        the grant is the stronger claim and is checked exactly as before.
        """
        from app.middleware import auth

        machine = _machine()
        yossi = _pos_user(machine.shop_id, role=PosUserRole.CASHIER, username="yossi")
        manager_id = uuid.uuid4()
        grant = SimpleNamespace(user_id=manager_id, pos_user_id=None, scopes=["catalog:write"])
        seen = {}

        def _checked(db, m, token, scope):
            seen["token"] = token
            return grant

        monkeypatch.setattr(auth, "_checked_grant", _checked)
        actor = _catalog_authority(
            _FakeDb(yossi), machine, token="tok", operator_id=str(yossi.id)
        )
        assert seen["token"] == "tok"
        assert actor.user_id == manager_id
        assert actor.pos_user_id is None


# ── Renaming a category from a till ───────────────────────────────────────────


def _category(tenant_id, name="Drinks"):
    return Category(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=None,
        shop_id=None,
        pos_machine_id=None,
        catalog_level=CategoryCatalogLevel.GLOBAL,
        name=name,
        description=None,
        color=None,
        image_url=None,
        parent_id=None,
        voucher_id=None,
        is_active=True,
        sort_order=0,
        created_at=_now() - timedelta(days=30),
        updated_at=_now() - timedelta(days=30),
    )


def _rename(monkeypatch, db, machine, category, **fields):
    from app.middleware.auth import CatalogActor
    from app.routers import sync as sync_router
    from app.schemas.category import CategoryUpdate

    notified = []
    monkeypatch.setattr(
        sync_router, "notify_machines_for_shop", lambda _db, shop_id, reason: notified.append(shop_id)
    )
    monkeypatch.setattr(
        sync_router,
        "notify_all_machines_for_tenant",
        lambda *a, **k: notified.append("WHOLE TENANT"),
    )
    response = sync_router.machine_update_cloud_category(
        str(machine.id),
        str(category.id),
        CategoryUpdate(**fields),
        machine=machine,
        actor=CatalogActor(pos_user_id=uuid.uuid4()),
        db=db,
    )
    return response, notified


def _shop_setup():
    machine = _machine()
    shop = Shop(id=machine.shop_id, tenant_id=machine.tenant_id, name="Dizengoff")
    category = _category(machine.tenant_id)
    return machine, shop, category


class TestCategoryRenameFromATill:
    def test_a_rename_is_this_shops_and_leaves_the_tenant_category_alone(self, monkeypatch):
        machine, shop, category = _shop_setup()
        db = _FakeDb(shop, category)

        response, notified = _rename(monkeypatch, db, machine, category, name="Cold drinks")

        assert category.name == "Drinks", "the tenant category must never be written"
        override = next(o for o in db.added if isinstance(o, ShopCategoryOverride))
        assert override.shop_id == shop.id
        assert override.name == "Cold drinks"
        assert response.name == "Cold drinks"
        # Only this shop's tills are woken; no other shop's button changed.
        assert notified == [str(shop.id)]

    def test_renaming_back_to_the_tenant_name_clears_the_override(self, monkeypatch):
        machine, shop, category = _shop_setup()
        existing = ShopCategoryOverride(
            id=uuid.uuid4(), shop_id=shop.id, category_id=category.id, name="Cold drinks",
            updated_at=_now() - timedelta(days=1),
        )
        db = _FakeDb(shop, category, existing)

        response, _ = _rename(monkeypatch, db, machine, category, name="Drinks")

        # Cleared, not copied: a copy would stop following a later dashboard rename.
        assert existing.name is None
        assert response.name == "Drinks"
        assert existing.updated_at > _now() - timedelta(minutes=1), (
            "the reset must move the timestamp, or the till's delta never sees it"
        )

    @pytest.mark.parametrize(
        "fields", [{"color": "#ff0000"}, {"sort_order": 3}, {"is_active": False}]
    )
    def test_tenant_wide_fields_stay_the_dashboards(self, monkeypatch, fields):
        machine, shop, category = _shop_setup()
        db = _FakeDb(shop, category)

        with pytest.raises(HTTPException) as exc:
            _rename(monkeypatch, db, machine, category, **fields)

        assert exc.value.status_code == 403
        assert exc.value.detail == "shared_category_readonly"
        assert not any(isinstance(o, ShopCategoryOverride) for o in db.added)

    def test_an_empty_category_is_no_longer_renamable_tenant_wide(self, monkeypatch):
        """
        The old guard — "every product in it is listed only here" — was vacuously true
        for an empty category, so a till could rename any empty chain category and it
        changed on every till. It is the exact case the override exists for.
        """
        machine, shop, category = _shop_setup()
        db = _FakeDb(shop, category)  # no products at all

        _rename(monkeypatch, db, machine, category, name="Mine now")

        assert category.name == "Drinks"


# ── Each shop's tills see that shop's names ───────────────────────────────────


def _two_shops_one_category():
    tenant = uuid.uuid4()
    here, there = _machine(tenant_id=tenant), _machine(tenant_id=tenant)
    category = _category(tenant)
    renamed_at = _now() - timedelta(hours=1)
    override = ShopCategoryOverride(
        id=uuid.uuid4(), shop_id=here.shop_id, category_id=category.id,
        name="Cold drinks", updated_at=renamed_at,
    )
    machines = [
        POSMachine(id=m.id, shop_id=m.shop_id, tenant_id=tenant) for m in (here, there)
    ]
    return here, there, category, override, _FakeDb(category, override, *machines)


class TestCategorySync:
    def test_a_shop_sees_its_own_name_and_the_next_shop_sees_the_tenants(self):
        from app.services.sync import get_categories_for_sync

        here, there, category, _override, db = _two_shops_one_category()

        mine = get_categories_for_sync(db, str(here.tenant_id), str(here.id))
        theirs = get_categories_for_sync(db, str(there.tenant_id), str(there.id))

        assert [c["name"] for c in mine] == ["Cold drinks"]
        assert [c["name"] for c in theirs] == ["Drinks"]

    def test_a_rename_reaches_this_shops_delta_pull(self):
        """
        The category row is a month old; only the override moved. A delta keyed on the
        category's timestamp alone would send nothing, and the rename would sit unseen
        until the till's next full pull.
        """
        from app.services.sync import get_categories_for_sync

        here, there, category, override, db = _two_shops_one_category()
        since = override.updated_at - timedelta(minutes=5)

        mine = get_categories_for_sync(db, str(here.tenant_id), str(here.id), since=since)
        theirs = get_categories_for_sync(db, str(there.tenant_id), str(there.id), since=since)

        assert [c["name"] for c in mine] == ["Cold drinks"]
        assert theirs == [], "another shop's delta has nothing to resend"

    def test_a_delta_after_the_rename_resends_nothing(self):
        from app.services.sync import get_categories_for_sync

        here, _there, _category, override, db = _two_shops_one_category()
        since = override.updated_at + timedelta(minutes=5)
        assert get_categories_for_sync(db, str(here.tenant_id), str(here.id), since=since) == []

    def test_the_delta_filter_reads_both_timestamps(self):
        from app.services.sync import category_delta_filter

        renamed = [uuid.uuid4()]
        sql = str(
            category_delta_filter(_now(), renamed).compile(dialect=postgresql.dialect())
        )
        assert "categories.updated_at >" in sql
        assert "categories.id IN" in sql

    def test_updated_at_reports_the_later_of_the_two(self):
        from app.services.sync import _serialize_category

        _here, _there, category, override, _db = _two_shops_one_category()
        out = _serialize_category(category, override)
        assert out["updatedAt"] == override.updated_at.isoformat()
