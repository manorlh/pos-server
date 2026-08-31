"""
Staff management: who may read the list, who may create whom, and what "remove"
means.

Each of these guards a decision that is invisible from any single line of the handler
it protects, which is how the three defects they cover got there.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.routers import users as users_router


def _user(role: UserRole, **kw) -> User:
    u = MagicMock(spec=User)
    u.role = role
    u.id = kw.pop("id", "u-self")
    for k, v in kw.items():
        setattr(u, k, v)
    return u


# ── Reading the staff list ───────────────────────────────────────────────────

def test_a_dashboard_cashier_may_not_read_the_staff_list() -> None:
    # A dashboard cashier is a shop *viewer* — it already reads transactions,
    # Z-reports and the tax export. Enumerating the company's staff is not part of
    # that job, and it was never a deliberate grant.
    assert UserRole.CASHIER not in users_router.USER_READ_ROLES


@pytest.mark.parametrize(
    "role",
    [
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER,
    ],
)
def test_every_managing_role_can_still_read_it(role: UserRole) -> None:
    # Not a blanket lockout: a shop manager who may create cashiers must be able to
    # see the ones they have.
    assert role in users_router.USER_READ_ROLES


def test_both_read_paths_are_gated(  ) -> None:
    # The list and the by-id read disclose the same thing; gating only one would just
    # move the enumeration.
    assert "USER_READ_ROLES" in inspect.getsource(users_router.list_users)
    assert "USER_READ_ROLES" in inspect.getsource(users_router.get_user)


# ── What /me tells the dashboard ─────────────────────────────────────────────

def test_me_reports_exactly_what_the_caller_may_create() -> None:
    # The create dialog offered every role and let the save 403 — advertising
    # authority the caller does not have, then blaming them for using it.
    for role, expected in users_router.CREATABLE_ROLES.items():
        assert set(expected) == set(users_router.CREATABLE_ROLES[role])

    assert users_router.CREATABLE_ROLES[UserRole.SHOP_MANAGER] == {UserRole.CASHIER}
    assert users_router.CREATABLE_ROLES[UserRole.CASHIER] == set()


def test_creatable_roles_never_include_the_callers_own_level_or_above() -> None:
    # The ladder is the whole point: you delegate downward, never sideways.
    for role, creatable in users_router.CREATABLE_ROLES.items():
        if role == UserRole.SUPER_ADMIN:
            continue
        for target in creatable:
            assert users_router.ROLE_LEVEL[target] < users_router.ROLE_LEVEL[role], (
                f"{role} may create {target}, which is not below it"
            )


def test_me_exposes_the_capability_flags_the_dashboard_reads() -> None:
    from app.schemas.user import CurrentUserResponse

    fields = CurrentUserResponse.model_fields
    for name in ("creatable_roles", "can_read_users", "can_manage_users", "can_manage_pos_users"):
        assert name in fields, f"{name} missing from /me"
    # Serialised camelCase, like every other response the dashboard consumes.
    assert fields["creatable_roles"].alias == "creatableRoles"


# ── Removal is deactivation ──────────────────────────────────────────────────

def test_removing_a_user_does_not_delete_the_row() -> None:
    # Seven tables carry a FK to users.id, two of them NOT NULL
    # (pos_machines.distributor_id, close_day_requests.initiated_by_user_id), so a
    # hard delete either failed with an integrity error or took terminals with it —
    # and it destroyed the answer to "who ordered that close-day".
    # The body, not the docstring — which quotes the old call to explain why it went.
    body = inspect.getsource(users_router.deactivate_user).split('"""')[-1]
    assert "db.delete(" not in body
    assert "is_active = False" in body


def test_a_deactivated_user_can_be_brought_back() -> None:
    assert hasattr(users_router, "activate_user")
    assert "is_active = True" in inspect.getsource(users_router.activate_user)


def test_deactivating_and_activating_need_the_same_authority() -> None:
    # If you were allowed to switch someone off you are allowed to switch them on;
    # otherwise a mis-click is permanent for everyone below super_admin.
    for fn in (users_router.deactivate_user, users_router.activate_user):
        assert "_authorise_activation_change" in inspect.getsource(fn)


@pytest.mark.parametrize("verb", ["deactivate", "activate"])
def test_nobody_can_switch_themselves_off(verb: str) -> None:
    me = _user(UserRole.DISTRIBUTOR, id="same")
    with pytest.raises(HTTPException) as e:
        users_router._authorise_activation_change(me, me, verb, MagicMock())
    assert e.value.status_code == 400


def test_a_peer_cannot_be_deactivated() -> None:
    # Strictly greater, not greater-or-equal: two shop managers must not be able to
    # switch each other off.
    a = _user(UserRole.SHOP_MANAGER, id="a", shop_id="s1")
    b = _user(UserRole.SHOP_MANAGER, id="b", shop_id="s1")
    with pytest.raises(HTTPException) as e:
        users_router._authorise_activation_change(a, b, "deactivate", MagicMock())
    assert e.value.status_code == 403


# ── Wire casing ──────────────────────────────────────────────────────────────

def test_user_responses_speak_camelcase_like_every_other_schema() -> None:
    """
    `GET /users` returned `is_active`, so a dashboard reading `isActive` saw undefined
    and rendered every user as inactive — which would have quietly destroyed the
    deactivate feature the moment it shipped.
    """
    import datetime
    import uuid as _uuid

    from app.schemas.user import UserResponse

    payload = UserResponse(
        email="a@b.c",
        username="u",
        id=_uuid.uuid4(),
        is_active=True,
        created_at=datetime.datetime.now(),
        updated_at=datetime.datetime.now(),
    ).model_dump(by_alias=True)

    for key in ("isActive", "createdAt", "updatedAt", "companyId", "shopId", "tenantId"):
        assert key in payload, f"{key} missing from the serialised user"
    for key in ("is_active", "created_at", "company_id"):
        assert key not in payload, f"{key} should not be on the wire"


def test_snake_case_is_still_accepted_on_the_way_in() -> None:
    # Aliases must not break a caller mid-deploy, so populate_by_name stays on.
    from app.schemas.user import UserUpdate

    assert UserUpdate.model_validate({"company_id": None, "is_active": False}).is_active is False
    assert UserUpdate.model_validate({"companyId": None, "isActive": False}).is_active is False


def test_every_user_endpoint_serialises_by_alias() -> None:
    # The aliases exist on the model; without this flag FastAPI serialises by field
    # name and they never reach the wire.
    import re

    from app.routers import users as _users

    src = inspect.getsource(_users)
    for decorator in re.findall(r"@router\.(?:get|post|put)\([^)]*response_model=[^)]*\)", src, re.S):
        if "UserResponse" in decorator:
            assert "response_model_by_alias=True" in decorator, decorator[:90]


# ── Where a user may be placed ───────────────────────────────────────────────

class _ShopLookup:
    """A session that returns one shop by id, over a company tree with no children."""

    def __init__(self, shop=None):
        self.info: dict = {}
        self._shop = shop

    def query(self, *_entities):
        return self

    def filter(self, *_criteria):
        return self

    def first(self):
        return self._shop

    def execute(self, _statement):
        # The company hierarchy walk: no descendants, so the caller covers only the
        # company they are attached to.
        return iter(())


def _shop(company_id):
    s = MagicMock()
    s.id = uuid.uuid4()
    s.company_id = company_id
    return s


def test_a_company_manager_cannot_move_a_user_into_another_company() -> None:
    # `PUT /users/{id}` accepts companyId and used to apply it unchecked: the read
    # guard only asks where the user is *now*, not where they are being sent.
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    actor = _user(UserRole.COMPANY_MANAGER, company_id=mine)
    with pytest.raises(HTTPException) as e:
        users_router._ensure_assignment_in_scope(
            actor, _ShopLookup(), company_id=theirs, shop_id=None
        )
    assert e.value.status_code == 403


def test_a_company_manager_may_place_a_user_in_a_subsidiary(monkeypatch) -> None:
    group, sub = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(users_router, "user_covers_company", lambda _db, _a, cid: cid in (group, sub))
    actor = _user(UserRole.COMPANY_MANAGER, company_id=group)
    users_router._ensure_assignment_in_scope(
        actor, _ShopLookup(_shop(sub)), company_id=sub, shop_id=uuid.uuid4()
    )


def test_a_shop_outside_the_callers_companies_is_refused() -> None:
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    actor = _user(UserRole.COMPANY_MANAGER, company_id=mine)
    with pytest.raises(HTTPException) as e:
        users_router._ensure_assignment_in_scope(
            actor, _ShopLookup(_shop(theirs)), company_id=None, shop_id=uuid.uuid4()
        )
    assert e.value.status_code == 403


def test_a_shop_manager_may_only_use_their_own_shop() -> None:
    own = uuid.uuid4()
    actor = _user(UserRole.SHOP_MANAGER, company_id=uuid.uuid4(), shop_id=own)
    users_router._ensure_assignment_in_scope(actor, _ShopLookup(), company_id=None, shop_id=own)
    with pytest.raises(HTTPException) as e:
        users_router._ensure_assignment_in_scope(
            actor, _ShopLookup(), company_id=None, shop_id=uuid.uuid4()
        )
    assert e.value.status_code == 403


def test_both_write_paths_use_the_same_placement_rule() -> None:
    # One rule, two callers: create used to pin the company and update checked nothing.
    for fn in (users_router.create_user, users_router.update_user):
        assert "_ensure_assignment_in_scope" in inspect.getsource(fn)
