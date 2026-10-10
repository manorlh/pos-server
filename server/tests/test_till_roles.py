"""
"תפקידים והרשאות" for till users (docs/SPEC_ROLES_PERMISSIONS.md): the catalogue, the
defaults matrix, the migration's promise (nobody's behaviour changes), the resolution
order, the roles API, assignment, the audit, the roster the till pulls, and elevation.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.pos_user import PosUser, PosUserRole
from app.models.till_role import TillRole, TillRoleChange
from app.models.user import User, UserRole
from app.routers import pos_users as PU
from app.routers import sync as sync_router
from app.routers import till_roles as R
from app.schemas.pos_user import PosUserCreate, PosUserUpdate
from app.services import ably_notify
from app.services import elevation
from app.services import till_permissions as TP
from app.services import till_roles as S
from app.services.permissions import Scope, pos_user_till_scopes
from shift_world import accept_str_uuids, make_world

A, P, D = TP.ALLOW, TP.APPROVAL, TP.DENY


# ── World ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.notified = []
    from app.services import pos_user_notify

    monkeypatch.setattr(
        pos_user_notify, "publish_pos_users_notify",
        lambda tenant_id, machine_id, **kw: world.notified.append((machine_id, kw.get("reason"))),
    )
    world.dana = _pos_user(world, "dana")
    world.boss = _pos_user(world, "boss", role=PosUserRole.SHOP_MANAGER)
    world.nir = _pos_user(world, "nir", shop=world.other_shop)
    world.shop_manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.supervisor = _user(world, "sup", UserRole.SHIFT_SUPERVISOR, shop=world.shop)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.company_manager = _user(world, "cm", UserRole.COMPANY_MANAGER)
    # Another company in the same tenant.
    world.company2 = Company(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Other", vat_number="2")
    world.db.add(world.company2)
    world.db.commit()
    return world


def _pos_user(w, username, role=PosUserRole.CASHIER, shop=None):
    pu = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, username=username,
        first_name=username.title(), pin_hash="x", role=role, is_active=True,
    )
    w.db.add(pu)
    w.db.flush()
    return pu


def _user(w, name, role, shop=None, company=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=(company or w.company).id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def roles(w, user=None):
    return R.list_till_roles(str(w.company.id), **ctx(w, user))


def role_by(w, key):
    return w.db.query(TillRole).filter(TillRole.company_id == w.company.id, TillRole.builtin_key == key).one()


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def roster(w, till=None):
    till = till or w.tills[0]
    out = sync_router.get_pos_users_sync(str(till.id), since=None, machine=till, db=w.db)
    return {u.username: u for u in out.users}


# ── The catalogue ─────────────────────────────────────────────────────────────


class TestCatalogue:
    def test_codes_are_unique_and_every_builtin_sets_every_code(self):
        assert len(TP.CODES) == len(set(TP.CODES))
        for key in TP.BUILTIN_BY_KEY:
            assert set(TP.DEFAULTS[key]) == set(TP.CODES), key
            assert set(TP.DEFAULTS[key].values()) <= set(TP.STATES)

    def test_the_owners_asks_are_in_it(self):
        for code in ("SELL", "TABLES.USE", "TABLES.OPEN_OTHERS", "CALCULATOR.USE", "REFUND", "DISCOUNT",
                     "PRICE_OVERRIDE", "LINE_VOID", "TABLE_CANCEL", "TABLE_VOID", "TABLE_RESTORE",
                     "TABLE_UNLOCK", "REPRINT", "OTH", "SHIFT_OPEN", "SHIFT_CLOSE", "X", "Z", "TRANSMIT",
                     "CATALOG_WRITE", "ATTENDANCE_MANAGE", "KIOSK_CONTROL", "VIEW_REPORTS",
                     "CASH_DRAWER.CASH_IN", "CASH_DRAWER.CASH_OUT", "CASH_DRAWER.DEPOSIT",
                     "CASH_DRAWER.COUNT", "CASH_DRAWER.BLIND_COUNT"):
            assert code in TP.PERMISSIONS_BY_CODE, code

    def test_every_drawer_permission_of_the_spec_is_there(self):
        spec = [
            "OPEN_ON_CASH_SALE", "OPEN_MANUALLY", "OPEN_FOR_CHANGE", "CASH_IN", "CASH_OUT", "DEPOSIT", "COUNT",
            "OPEN_FOR_TEST", "APPROVE_OPEN", "OPEN_AFTER_CLOSE", "VIEW_LOG", "VIEW_CASH_MOVEMENTS",
        ]
        for name in spec:
            assert f"CASH_DRAWER.{name}" in TP.PERMISSIONS_BY_CODE

    # The spec's §3 matrix, row by row: מלצר / קופאי / אחמ״ש / מנהל.
    @pytest.mark.parametrize("code,expected", [
        ("CASH_DRAWER.OPEN_ON_CASH_SALE", (A, A, A, A)),
        ("CASH_DRAWER.OPEN_MANUALLY", (P, P, A, A)),
        ("CASH_DRAWER.OPEN_FOR_CHANGE", (P, P, A, A)),
        ("CASH_DRAWER.CASH_OUT", (D, P, A, A)),
        ("CASH_DRAWER.DEPOSIT", (D, P, A, A)),
        ("CASH_DRAWER.COUNT", (D, P, A, A)),
        ("CASH_DRAWER.OPEN_FOR_TEST", (D, D, P, A)),
        ("CASH_DRAWER.OPEN_AFTER_CLOSE", (D, D, P, A)),
        ("CASH_DRAWER.VIEW_LOG", (D, D, A, A)),
    ])
    def test_the_spec_roles_carry_the_spec_matrix(self, code, expected):
        got = tuple(TP.DEFAULTS[k][code] for k in (TP.WAITER, TP.CASHIER, TP.SUPERVISOR, TP.MANAGER))
        assert got == expected

    def test_the_supervisor_takes_cash_out_up_to_200_alone(self):
        sup = TP.effective_permissions(template=TP.SUPERVISOR)
        assert TP.limit_covers(sup, "CASH_DRAWER.CASH_OUT", amount=200)
        assert not TP.limit_covers(sup, "CASH_DRAWER.CASH_OUT", amount=200.01)
        mgr = TP.effective_permissions(template=TP.MANAGER)
        assert TP.limit_covers(mgr, "CASH_DRAWER.CASH_OUT", amount=5000)

    def test_leaving_the_windows_app_to_the_desktop_is_a_managers(self):
        """DESKTOP_EXIT (the owner, 08.10.2026): managers yes, cashiers no — checked on the PC itself."""
        spec = TP.PERMISSIONS_BY_CODE["DESKTOP_EXIT"]
        assert spec.label == "יציאה לשולחן העבודה (Windows)"
        assert spec.group == "admin" and spec.devices == (TP.DEVICE_WINDOWS,)
        # No elevation scope: the Windows device decides offline from the roster.
        assert spec.scope is None and "DESKTOP_EXIT" not in TP.SCOPE_PERMISSIONS.values()
        states = {key: TP.DEFAULTS[key]["DESKTOP_EXIT"] for key in TP.BUILTIN_BY_KEY}
        assert states == {
            TP.WAITER: D, TP.CASHIER: D, TP.SUPERVISOR: D, TP.MANAGER: A,
            TP.LEGACY_CASHIER: D, TP.LEGACY_MANAGER: A,
        }
        # A custom role made from the manager's template gets it without a migration; from a blank one not.
        assert TP.effective_permissions(template=TP.template_of(None, TP.MANAGER)).allows("DESKTOP_EXIT")
        assert not TP.effective_permissions(template=TP.template_of(None, None)).allows("DESKTOP_EXIT")
        # The older tills' reading of a role does not move: it is not one of the senior codes.
        assert "DESKTOP_EXIT" not in TP.LEGACY_SENIOR_CODES
        assert TP.legacy_role_for(TP.DEFAULTS[TP.MANAGER]) == "shop_manager"

    def test_switching_a_kiosk_to_the_till_is_a_managers(self):
        """KIOSK_TILL_MODE ("מצב עבודה: קיוסק / קופה", P:/specs/kiosk-landscape-till-mode.md §5.3): managers only, no scope."""
        spec = TP.PERMISSIONS_BY_CODE["KIOSK_TILL_MODE"]
        assert spec.label == "מעבר למצב קופה בקיוסק" and spec.group == "admin" and spec.scope is None
        assert spec.devices == (TP.DEVICE_TILL, TP.DEVICE_TABLET, TP.DEVICE_WINDOWS)
        states = {key: TP.DEFAULTS[key]["KIOSK_TILL_MODE"] for key in TP.BUILTIN_BY_KEY}
        assert states == {
            TP.WAITER: D, TP.CASHIER: D, TP.SUPERVISOR: D, TP.MANAGER: A,
            TP.LEGACY_CASHIER: D, TP.LEGACY_MANAGER: A,
        }
        assert "KIOSK_TILL_MODE" not in TP.LEGACY_SENIOR_CODES

    def test_the_catalogue_names_the_windows_device(self):
        out = TP.catalogue_out()
        assert {"key": "windows", "label": "Windows"} in out["devices"]
        by_code = {p["code"]: p for p in out["permissions"]}
        assert by_code["DESKTOP_EXIT"]["devices"] == ["windows"]
        # Every permission that was Android's stays Android's (no Windows till yet).
        assert "windows" not in by_code["SELL"]["devices"]

    def test_scope_strings_map_onto_codes(self):
        for scope in Scope:
            if scope is Scope.DAY_CLOSE:
                assert TP.SCOPE_PERMISSIONS[scope.value] == "Z"
            else:
                assert scope.value in TP.SCOPE_PERMISSIONS, scope

    def test_validation_refuses_unknowns_and_bad_states(self):
        with pytest.raises(TP.PermissionValueError):
            TP.clean_states({"NOPE": A})
        with pytest.raises(TP.PermissionValueError):
            TP.clean_states({"SELL": "maybe"})
        with pytest.raises(TP.PermissionValueError):
            TP.clean_limits({"DISCOUNT": {"maxPercent": 101}})
        with pytest.raises(TP.PermissionValueError):
            TP.clean_limits({"SELL": {"maxAmount": 1}})
        assert TP.clean_limits({"DISCOUNT": {"maxPercent": 12.5}}) == {"DISCOUNT": {"maxPercent": 12.5}}


# ── The migration's promise: legacy roles are today's behaviour ───────────────


class TestLegacy:
    #: TillAuthority.SENIOR_MAY_ACT_ALONE before roles (OTH rode on the discount scope).
    SENIOR = {
        "REFUND", "DISCOUNT", "OTH", "CATALOG_WRITE", "TRANSMIT", "TABLE_CANCEL", "TABLE_UNLOCK", "REPRINT",
        "TABLE_VOID", "TABLE_RESTORE", "USER_SESSION_RELEASE", "KIOSK_UNLOCK", "KIOSK_CONTROL",
        "ATTENDANCE_MANAGE", "CARD_UNRESOLVED",
        # New with production vouchers (no older behaviour to keep): a senior approves an override.
        "VOUCHER_DISCOUNT_OVERRIDE",
        # Staff test vouchers (helper, §18.5): a senior redeems one, or approves it.
        "VOUCHER_TEST_REDEEM",
    }

    def test_a_legacy_cashier_needs_approval_for_exactly_what_a_cashier_did(self):
        eff = TP.legacy_effective("cashier")
        # Plus what was added after roles and asks a manager of a cashier (SELL_RESTRICTED_ITEMS:
        # "מחייב אישור מנהל במכירה", HELD_SALE_CANCEL: "ביטול מכירה מושהית" — neither existed before roles).
        assert {c for c, s in eff.states.items() if s == P} == self.SENIOR | {"SELL_RESTRICTED_ITEMS", "HELD_SALE_CANCEL"}
        # Everything else was open to everyone ("כרגע אין הרשאות, כולם יכולים לעשות הכל"),
        # except approving others, leaving the Windows kiosk and switching a kiosk to the till, which were a
        # manager's alone (the kiosk's admin opened for a manager's code only).
        assert {c for c, s in eff.states.items() if s == D} == {"CASH_DRAWER.APPROVE_OPEN", "DESKTOP_EXIT", "KIOSK_TILL_MODE"}
        assert eff.allows("SHIFT_CLOSE") and eff.allows("SELL") and eff.allows("CASH_DRAWER.OPEN_MANUALLY")

    def test_a_legacy_shop_manager_may_do_everything(self):
        eff = TP.legacy_effective(PosUserRole.SHOP_MANAGER)
        assert set(eff.states.values()) == {A}

    def test_an_unknown_role_string_is_a_cashier(self):
        assert TP.legacy_effective("admin").states == TP.legacy_effective("cashier").states

    def test_the_legacy_reading_for_older_tills(self):
        assert TP.legacy_role_for(TP.DEFAULTS[TP.LEGACY_CASHIER]) == "cashier"
        assert TP.legacy_role_for(TP.DEFAULTS[TP.LEGACY_MANAGER]) == "shop_manager"
        assert TP.legacy_role_for(TP.DEFAULTS[TP.MANAGER]) == "shop_manager"
        # A supervisor may not edit the catalog alone → an older till must not think so.
        assert TP.legacy_role_for(TP.DEFAULTS[TP.SUPERVISOR]) == "cashier"
        assert TP.legacy_role_for(TP.DEFAULTS[TP.WAITER]) == "cashier"

    def test_cloud_scopes_of_a_legacy_user_match_the_old_table(self, w):
        old_manager = pos_user_till_scopes(PosUserRole.SHOP_MANAGER)
        assert S.pos_user_scopes(w.boss) >= old_manager
        # A legacy cashier never could hold a money scope; they still cannot.
        for scope in (Scope.REFUND, Scope.DISCOUNT, Scope.CATALOG_WRITE, Scope.TRANSMIT, Scope.TABLE_CANCEL):
            assert scope not in S.pos_user_scopes(w.dana)

    def test_the_roster_of_an_untouched_company_is_todays(self, w):
        rows = roster(w)
        assert rows["dana"].role == PosUserRole.CASHIER
        assert rows["dana"].permissions == TP.DEFAULTS[TP.LEGACY_CASHIER]
        assert rows["dana"].till_role_id is None and rows["dana"].till_role_key == TP.LEGACY_CASHIER
        assert rows["boss"].role == PosUserRole.SHOP_MANAGER
        assert rows["boss"].permissions == TP.DEFAULTS[TP.LEGACY_MANAGER]
        assert "nir" not in rows  # another shop's user


# ── Resolution order ──────────────────────────────────────────────────────────


class TestResolution:
    def test_override_then_role_then_template(self):
        eff = TP.effective_permissions(
            role_states={"REFUND": A, "SELL": D},
            template=TP.CASHIER,
            overrides={"states": {"SELL": A}},
        )
        assert eff.state("SELL") == A and eff.sources["SELL"] == "override"
        assert eff.state("REFUND") == A and eff.sources["REFUND"] == "role"
        assert eff.state("DISCOUNT") == P and eff.sources["DISCOUNT"] == "template"

    def test_limits_follow_the_same_order(self):
        eff = TP.effective_permissions(
            role_limits={"CASH_DRAWER.CASH_OUT": {"maxAmount": 100}},
            template=TP.SUPERVISOR,
            overrides={"limits": {"DISCOUNT": {"maxPercent": 5}}},
        )
        assert eff.limits["CASH_DRAWER.CASH_OUT"] == {"maxAmount": 100}
        assert eff.limits["DISCOUNT"] == {"maxPercent": 5}
        assert eff.limits["CASH_DRAWER.DEPOSIT"] == {"maxAmount": 200}

    def test_unknown_codes_are_never_granted(self):
        eff = TP.effective_permissions(role_states={"GOD_MODE": A}, template=TP.WAITER)
        assert "GOD_MODE" not in eff.states
        assert eff.state("GOD_MODE") == D


# ── Roles of a company ────────────────────────────────────────────────────────


class TestCompanyRoles:
    def test_the_first_read_creates_the_builtins_once_and_keeps_everyone_as_they_were(self, w):
        before = {u: r.permissions for u, r in roster(w).items()}
        out = roles(w)
        keys = sorted(r["builtinKey"] for r in out["roles"])
        assert keys == sorted(TP.BUILTIN_BY_KEY)
        roles(w)  # idempotent
        assert w.db.query(TillRole).filter(TillRole.company_id == w.company.id).count() == 6
        w.db.refresh(w.dana)
        assert w.dana.till_role_id == role_by(w, TP.LEGACY_CASHIER).id
        assert w.boss.till_role_id == role_by(w, TP.LEGACY_MANAGER).id
        assert {u: r.permissions for u, r in roster(w).items()} == before
        counts = {r["builtinKey"]: r["users"] for r in out["roles"]}
        # Both shops are the company's: dana and nir are its cashiers.
        assert counts[TP.LEGACY_CASHIER] == 2 and counts[TP.LEGACY_MANAGER] == 1

    def test_who_may_read_and_who_may_edit(self, w):
        assert roles(w, w.company_manager)["canEdit"] is True
        assert roles(w, w.shop_manager)["canEdit"] is False
        assert roles(w, w.supervisor)["canEdit"] is False
        assert refused(roles, w, w.cashier).status_code == 403
        other_cm = _user(w, "cm2", UserRole.COMPANY_MANAGER, company=w.company2)
        assert refused(roles, w, other_cm).status_code == 403
        body = R.RoleCreateIn(name="ברמן")
        assert refused(R.create_till_role, str(w.company.id), body, **ctx(w, w.shop_manager)).status_code == 403

    def test_create_blank_from_a_template_and_duplicate(self, w):
        roles(w)
        bar = R.create_till_role(
            str(w.company.id), R.RoleCreateIn(name="ברמן", baseKey=TP.SUPERVISOR, permissions={"TABLES.USE": D}),
            **ctx(w, w.company_manager),
        )
        assert bar["builtin"] is False and bar["permissions"]["TABLES.USE"] == D
        assert bar["permissions"]["REFUND"] == A  # from the supervisor template
        copy = R.create_till_role(
            str(w.company.id), R.RoleCreateIn(name="ברמן 2", copyFromRoleId=bar["id"]), **ctx(w),
        )
        assert copy["permissions"] == bar["permissions"]
        # Editing the source later never moves the copy.
        R.update_till_role(str(w.company.id), bar["id"], R.RoleUpdateIn(permissions={"REFUND": D}), **ctx(w))
        again = {r["id"]: r for r in roles(w)["roles"]}
        assert again[copy["id"]]["permissions"]["REFUND"] == A

    def test_names_are_unique_per_company(self, w):
        roles(w)
        err = refused(R.create_till_role, str(w.company.id), R.RoleCreateIn(name=" קופאי "), **ctx(w))
        assert err.status_code == 409 and err.detail["code"] == "name_taken"

    def test_builtins_are_edited_never_deleted(self, w):
        roles(w)
        cashier = role_by(w, TP.CASHIER)
        out = R.update_till_role(str(w.company.id), str(cashier.id),
                                 R.RoleUpdateIn(name="קופאית", permissions={"REFUND": A}), **ctx(w))
        assert out["name"] == "קופאית" and out["permissions"]["REFUND"] == A
        err = refused(R.delete_till_role, str(w.company.id), str(cashier.id), reassign_to=None, **ctx(w))
        assert err.status_code == 409 and err.detail["code"] == "builtin_role"

    def test_a_role_in_use_is_deleted_only_with_somewhere_to_go(self, w):
        roles(w)
        bar = R.create_till_role(str(w.company.id), R.RoleCreateIn(name="ברמן"), **ctx(w))
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=bar["id"]), **ctx(w))
        err = refused(R.delete_till_role, str(w.company.id), bar["id"], reassign_to=None, **ctx(w))
        assert err.detail["code"] == "role_in_use"
        waiter = role_by(w, TP.WAITER)
        R.delete_till_role(str(w.company.id), bar["id"], reassign_to=waiter.id, **ctx(w))
        w.db.refresh(w.dana)
        assert w.dana.till_role_id == waiter.id
        assert all(r["id"] != bar["id"] for r in roles(w)["roles"])

    def test_the_matrix_save_restamps_users_and_tells_their_tills(self, w):
        roles(w)
        legacy = role_by(w, TP.LEGACY_CASHIER)
        stamp = w.dana.updated_at
        everything = {code: A for code in TP.CODES}
        R.save_till_role_matrix(
            str(w.company.id), R.MatrixIn(roles=[R.MatrixRoleIn(id=legacy.id, permissions=everything)]), **ctx(w),
        )
        w.db.refresh(w.dana)
        # She may now do alone all a shop manager did: older tills are told so.
        assert w.dana.role == PosUserRole.SHOP_MANAGER
        assert w.dana.updated_at != stamp
        assert any(reason == "till_roles_updated" for _, reason in w.notified)
        assert roster(w)["dana"].permissions == everything

    def test_an_invalid_matrix_is_refused_whole(self, w):
        roles(w)
        cashier, waiter = role_by(w, TP.CASHIER), role_by(w, TP.WAITER)
        body = R.MatrixIn(roles=[
            R.MatrixRoleIn(id=cashier.id, permissions={"REFUND": A}),
            R.MatrixRoleIn(id=waiter.id, permissions={"REFUND": "sometimes"}),
        ])
        assert refused(R.save_till_role_matrix, str(w.company.id), body, **ctx(w)).status_code == 422
        w.db.refresh(cashier)
        assert cashier.permissions == {}


# ── Assignment, overrides, audit ──────────────────────────────────────────────


class TestAssignment:
    def test_assigning_a_spec_role_changes_the_roster_and_the_legacy_role(self, w):
        roles(w)
        sup = role_by(w, TP.SUPERVISOR)
        out = R.assign_till_role(str(w.shop.id), str(w.boss.id), R.AssignIn(tillRoleId=sup.id), **ctx(w, w.shop_manager))
        assert out["tillRoleName"] == "אחמ״ש" and out["role"] == "cashier"
        row = roster(w)["boss"]
        assert row.till_role_key == TP.SUPERVISOR and row.permissions["CATALOG_WRITE"] == P
        assert row.limits["CASH_DRAWER.CASH_OUT"] == {"maxAmount": 200}
        audit = w.db.query(TillRoleChange).filter(TillRoleChange.action == "assign").one()
        assert audit.pos_user_id == w.boss.id and audit.user_email == "mgr@x"

    def test_the_roster_tells_the_windows_device_who_may_leave_to_the_desktop(self, w):
        """kiosk-desktop checks DESKTOP_EXIT offline, from this roster (with the user's shop)."""
        rows = roster(w)
        assert rows["boss"].permissions["DESKTOP_EXIT"] == A  # a legacy shop manager, as before
        assert rows["dana"].permissions["DESKTOP_EXIT"] == D
        assert str(rows["dana"].shop_id) == str(w.shop.id)
        roles(w)
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=role_by(w, TP.MANAGER).id), **ctx(w))
        assert roster(w)["dana"].permissions["DESKTOP_EXIT"] == A
        # A personal override takes it away from one manager only.
        R.assign_till_role(
            str(w.shop.id), str(w.dana.id),
            R.AssignIn(tillRoleId=role_by(w, TP.MANAGER).id, overrides={"states": {"DESKTOP_EXIT": D}}), **ctx(w),
        )
        assert roster(w)["dana"].permissions["DESKTOP_EXIT"] == D
        assert roster(w)["boss"].permissions["DESKTOP_EXIT"] == A

    def test_a_shop_manager_assigns_only_in_their_shop(self, w):
        roles(w)
        sup = role_by(w, TP.SUPERVISOR)
        err = refused(R.assign_till_role, str(w.other_shop.id), str(w.nir.id), R.AssignIn(tillRoleId=sup.id),
                      **ctx(w, w.shop_manager))
        assert err.status_code == 403
        err = refused(R.assign_till_role, str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=sup.id),
                      **ctx(w, w.supervisor))
        assert err.status_code == 403

    def test_a_role_of_another_company_is_refused(self, w):
        roles(w)
        R.list_till_roles(str(w.company2.id), **ctx(w))
        foreign = w.db.query(TillRole).filter(TillRole.company_id == w.company2.id).first()
        err = refused(R.assign_till_role, str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=foreign.id), **ctx(w))
        assert err.status_code == 404

    def test_overrides_win_and_can_be_cleared(self, w):
        roles(w)
        cashier = role_by(w, TP.CASHIER)
        R.assign_till_role(
            str(w.shop.id), str(w.dana.id),
            R.AssignIn(tillRoleId=cashier.id, overrides={"states": {"REFUND": A}, "limits": {"REFUND": {"maxAmount": 50}}}),
            **ctx(w),
        )
        row = roster(w)["dana"]
        assert row.permissions["REFUND"] == A and row.limits["REFUND"] == {"maxAmount": 50}
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=cashier.id, clearOverrides=True), **ctx(w))
        assert roster(w)["dana"].permissions["REFUND"] == P
        actions = [c.action for c in w.db.query(TillRoleChange).order_by(TillRoleChange.created_at).all()]
        assert actions.count("overrides") == 2

    def test_the_users_list_shows_role_and_effective(self, w):
        out = R.list_till_role_users(str(w.company.id), shop_id=None, include_inactive=False, **ctx(w, w.shop_manager))
        names = {u["username"]: u for u in out["users"]}
        assert set(names) == {"dana", "boss"}  # their own shop only
        assert names["dana"]["tillRoleName"] == "קופאי (הרשאות קודמות)"


class TestVoucherDiscountOverride:
    """
    "אישור כפיית הנחה בשובר" (production vouchers §6): a manager, a shift supervisor and a legacy
    shop manager approve an override with their own code; a cashier, a waiter and a legacy cashier
    get the manager-code prompt.
    """

    @pytest.mark.parametrize("role, state", [
        (TP.MANAGER, A), (TP.SUPERVISOR, A), (TP.LEGACY_MANAGER, A),
        (TP.CASHIER, P), (TP.WAITER, P), (TP.LEGACY_CASHIER, P),
    ])
    def test_each_built_in_role(self, role, state):
        assert TP.DEFAULTS[role]["VOUCHER_DISCOUNT_OVERRIDE"] == state

    def test_it_is_in_the_editor_with_its_hebrew_label(self):
        spec = next(p for p in TP.PERMISSIONS if p.code == "VOUCHER_DISCOUNT_OVERRIDE")
        assert spec.label == "אישור כפיית הנחה בשובר"
        out = TP.catalogue_out()
        assert any(p.get("code") == "VOUCHER_DISCOUNT_OVERRIDE" for p in out["permissions"])

    def test_the_spec_defaults_put_it_back(self, w):
        roles(w)
        cashier = role_by(w, TP.CASHIER)
        R.update_till_role(str(w.company.id), str(cashier.id),
                           R.RoleUpdateIn(permissions={"VOUCHER_DISCOUNT_OVERRIDE": A}), **ctx(w))
        R.apply_spec_defaults(str(w.company.id), R.ApplyDefaultsIn(), **ctx(w, w.company_manager))
        w.db.refresh(cashier)
        # The override is gone: the cashier is back on the spec's prompt.
        assert cashier.permissions == {}
        assert TP.DEFAULTS[TP.CASHIER]["VOUCHER_DISCOUNT_OVERRIDE"] == P


class TestApplyDefaults:
    def test_resets_the_spec_roles_and_optionally_moves_legacy_users(self, w):
        roles(w)
        cashier = role_by(w, TP.CASHIER)
        R.update_till_role(str(w.company.id), str(cashier.id), R.RoleUpdateIn(permissions={"REFUND": A}), **ctx(w))
        out = R.apply_spec_defaults(str(w.company.id), R.ApplyDefaultsIn(), **ctx(w, w.company_manager))
        assert out["applied"] == {"resetRoles": [TP.CASHIER], "movedUsers": 0}
        w.db.refresh(cashier)
        assert cashier.permissions == {}
        assert roster(w)["dana"].till_role_key == TP.LEGACY_CASHIER  # not moved
        out = R.apply_spec_defaults(
            str(w.company.id), R.ApplyDefaultsIn(resetBuiltins=False, moveLegacyUsers=True), **ctx(w),
        )
        assert out["applied"]["movedUsers"] == 3  # dana and nir (both shops), boss
        rows = roster(w)
        assert rows["dana"].till_role_key == TP.CASHIER and rows["dana"].permissions == TP.DEFAULTS[TP.CASHIER]
        assert rows["boss"].till_role_key == TP.MANAGER and rows["boss"].role == PosUserRole.SHOP_MANAGER
        assert w.db.query(TillRoleChange).filter(TillRoleChange.action == "apply_defaults").count() == 2


class TestPosUsersEndpoints:
    def test_create_with_a_role_and_without_one(self, w):
        roles(w)
        waiter = role_by(w, TP.WAITER)
        made = PU.create_pos_user(
            str(w.shop.id), PosUserCreate(username="avi", pin="2580", tillRoleId=waiter.id), **ctx(w),
        )
        assert made.till_role_id == waiter.id and made.till_role_name == "מלצר"
        # No role chosen: a NEW user starts on the spec's cashier (the owner, 08.10.2026).
        plain = PU.create_pos_user(str(w.shop.id), PosUserCreate(username="new", pin="2580"), **ctx(w))
        assert plain.till_role_id == role_by(w, TP.CASHIER).id and plain.till_role_name == "קופאי"
        assert plain.role == PosUserRole.CASHIER
        assert roster(w)["new"].permissions == TP.DEFAULTS[TP.CASHIER]

    def test_a_new_user_on_an_untouched_company_gets_the_spec_role_and_nobody_else_moves(self, w):
        # The company's roles do not exist yet: creating the user materialises them, the
        # existing till users land on the legacy role they behave as, the new one on the spec's.
        assert w.db.query(TillRole).count() == 0
        made = PU.create_pos_user(str(w.shop.id), PosUserCreate(username="new", pin="2580"), **ctx(w))
        assert made.till_role_id == role_by(w, TP.CASHIER).id
        w.db.refresh(w.dana)
        assert w.dana.till_role_id == role_by(w, TP.LEGACY_CASHIER).id
        # One assignment recorded for the new user (spec cashier), no detour via a legacy role.
        changes = w.db.query(TillRoleChange).filter(TillRoleChange.pos_user_id == made.id).all()
        assert [(c.action, (c.old_value or {}).get("roleId")) for c in changes] == [("assign", None)]
        # Created as a shop manager: the spec's manager, so the form's role holds.
        chief = PU.create_pos_user(
            str(w.shop.id), PosUserCreate(username="chief", pin="2580", role="shop_manager"), **ctx(w),
        )
        assert chief.till_role_id == role_by(w, TP.MANAGER).id and chief.role == PosUserRole.SHOP_MANAGER

    def test_an_older_dashboard_changing_role_moves_the_legacy_role(self, w):
        roles(w)
        out = PU.update_pos_user(str(w.shop.id), str(w.dana.id), PosUserUpdate(role="shop_manager"), **ctx(w))
        assert out.till_role_id == role_by(w, TP.LEGACY_MANAGER).id
        assert roster(w)["dana"].permissions == TP.DEFAULTS[TP.LEGACY_MANAGER]

    def test_update_with_a_till_role(self, w):
        roles(w)
        mgr = role_by(w, TP.MANAGER)
        out = PU.update_pos_user(str(w.shop.id), str(w.dana.id), PosUserUpdate(tillRoleId=mgr.id), **ctx(w))
        assert out.role == PosUserRole.SHOP_MANAGER and out.till_role_name == "מנהל"
        err = refused(PU.update_pos_user, str(w.shop.id), str(w.dana.id), PosUserUpdate(tillRoleId=uuid.uuid4()), **ctx(w))
        assert err.status_code == 422


# ── Elevation and the cloud's other approver checks ───────────────────────────


class TestElevation:
    def test_grants_follow_the_role(self, w):
        roles(w)
        sup = role_by(w, TP.SUPERVISOR)
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=sup.id), **ctx(w))
        till = w.tills[0]
        till.shop_id = w.shop.id
        asked = [Scope.REFUND, Scope.CATALOG_WRITE, Scope.TRANSMIT]
        assert elevation.grantable_scopes_for_pos_user(w.dana, till, asked) == [Scope.REFUND, Scope.TRANSMIT]
        assert elevation.grantable_scopes_for_pos_user(w.boss, till, asked) == asked

    def test_a_demotion_bites_a_live_grant(self, w):
        roles(w)
        till = w.tills[0]
        _, session = elevation.create_session(w.db, None, till, [Scope.REFUND], pos_user=w.boss)
        w.db.commit()
        waiter = role_by(w, TP.WAITER)
        R.assign_till_role(str(w.shop.id), str(w.boss.id), R.AssignIn(tillRoleId=waiter.id), **ctx(w))
        w.db.refresh(session)
        held = elevation.session_scopes(session)
        assert not held.issubset(S.pos_user_scopes(w.boss))

    def test_attendance_and_kiosk_approvers_read_the_permission(self, w):
        from app.services.kiosk_control import _allows_kiosk_control

        assert _allows_kiosk_control(w.boss) and not _allows_kiosk_control(w.dana)
        roles(w)
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=role_by(w, TP.SUPERVISOR).id), **ctx(w))
        assert _allows_kiosk_control(w.dana)
        assert S.pos_user_allows(w.dana, "ATTENDANCE_MANAGE")


# ── The migration ─────────────────────────────────────────────────────────────


def _render(*args, downgrade=False) -> str:
    import io
    import os
    import pathlib

    from alembic import command
    from alembic.config import Config

    here = pathlib.Path(__file__).resolve().parents[1]
    buf = io.StringIO()
    cfg = Config(os.path.join(here, "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", os.path.join(here, "alembic"))
    # alembic's env.py runs fileConfig(), which disables every existing logger: put them back,
    # or a later test's caplog sees nothing (tests/test_device_management.py).
    import logging

    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    try:
        (command.downgrade if downgrade else command.upgrade)(cfg, *args, sql=True)
    finally:
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


class TestMigration:
    def test_on_the_single_head(self):
        import pathlib

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = pathlib.Path(__file__).resolve().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "e5b1c3d7f9a2" in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("e5b1c3d7f9a2").down_revision == "c7e2f4a9d1b6"

    def test_upgrade_adds_the_tables_and_the_columns_and_moves_no_data(self):
        sql = _render("c7e2f4a9d1b6:e5b1c3d7f9a2")
        assert "CREATE TABLE till_roles" in sql
        assert "CONSTRAINT uq_till_roles_company_builtin UNIQUE (company_id, builtin_key)" in sql
        assert "CREATE TABLE till_role_changes" in sql
        assert "ALTER TABLE pos_users ADD COLUMN till_role_id UUID" in sql
        assert "ALTER TABLE pos_users ADD COLUMN permission_overrides JSONB" in sql
        assert "ON DELETE SET NULL" in sql
        # Nobody is moved: every till user keeps NULL = their legacy role.
        assert "UPDATE pos_users" not in sql and "INSERT INTO" not in sql.replace("INSERT INTO alembic_version", "")

    def test_downgrade_drops_them(self):
        sql = _render("e5b1c3d7f9a2:c7e2f4a9d1b6", downgrade=True)
        assert "DROP TABLE till_roles" in sql and "DROP TABLE till_role_changes" in sql

# ── The drawer's parameters per level (spec §17) ──────────────────────────────


class TestDrawerParams:
    def test_the_spec_parameters_are_built_in_with_safe_defaults(self):
        from app.services import cash_drawer as CD
        from app.services.till_parameters import BUILTIN_PARAMETERS

        keys = {p.key: p for p in BUILTIN_PARAMETERS}
        for key in (CD.REQUIRE_REASON_KEY, CD.ALLOW_AFTER_CLOSE_KEY, CD.BLIND_COUNT_KEY, CD.MAX_MANUAL_OPENS_KEY,
                    CD.ALERT_OPENS_MINUTES_KEY, CD.CASH_OUT_ALERT_AMOUNT_KEY, CD.VARIANCE_ALERT_AMOUNT_KEY,
                    CD.DENIED_UI_KEY, CD.CARD_TIPS_FROM_DRAWER_KEY):
            assert key in keys, key
            assert key in CD.LEVEL_KEYS, key
        assert keys[CD.REQUIRE_REASON_KEY].default_value is True
        assert keys[CD.BLIND_COUNT_KEY].default_value is False
        # "טיפ באשראי משולם מהמזומן": off unless a level turns it on.
        assert keys[CD.CARD_TIPS_FROM_DRAWER_KEY].default_value is False
        assert keys[CD.CARD_TIPS_FROM_DRAWER_KEY].value_type == "boolean"
        assert keys[CD.MAX_MANUAL_OPENS_KEY].default_value == 0
        # The existing hardware switch is the editor's first row, not a duplicate.
        assert CD.LEVEL_KEYS[0] == "cashDrawer"

    def test_levels_inherit_company_shop_till(self, w):
        from app.services.till_parameters import till_parameters_for_machine

        put = lambda scope_type, scope_id, values, user=None: R.put_drawer_params(  # noqa: E731
            str(w.company.id), R.DrawerParamsIn(scopeType=scope_type, scopeId=scope_id, values=values), **ctx(w, user),
        )
        put("company", w.company.id, {"cashDrawer.maxManualOpensPerShift": 5, "cashDrawer.blindCount": True},
            w.company_manager)
        put("shop", w.shop.id, {"cashDrawer.maxManualOpensPerShift": 3}, w.shop_manager)
        view = put("machine", w.tills[0].id, {"cashDrawer.blindCount": False})
        assert view["own"] == {"cashDrawer.blindCount": False}
        assert view["inherited"]["cashDrawer.maxManualOpensPerShift"] == 3
        params = till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert params["cashDrawer.maxManualOpensPerShift"] == 3 and params["cashDrawer.blindCount"] is False
        assert till_parameters_for_machine(w.db, w.tills[1]).parameters["cashDrawer.blindCount"] is True
        # Cleared: back to inheriting.
        put("machine", w.tills[0].id, {"cashDrawer.blindCount": None})
        assert till_parameters_for_machine(w.db, w.tills[0]).parameters["cashDrawer.blindCount"] is True
        from app.models.till_parameter import TillParameterChange

        actions = [c.action for c in w.db.query(TillParameterChange).all()]
        assert actions.count("set") == 4 and actions.count("clear") == 1

    def test_card_tips_from_the_drawer_is_on_the_card_and_set_per_till(self, w):
        from app.services.till_parameters import till_parameters_for_machine

        key = "cashDrawer.cardTipsFromDrawer"
        view = R.put_drawer_params(
            str(w.company.id), R.DrawerParamsIn(scopeType="machine", scopeId=w.tills[0].id, values={key: True}),
            **ctx(w, None),
        )
        listed = {p["key"]: p for p in view["parameters"]}
        assert listed[key]["label"] == "טיפ באשראי משולם מהמזומן"
        assert listed[key]["valueType"] == "boolean" and listed[key]["defaultValue"] is False
        assert till_parameters_for_machine(w.db, w.tills[0]).parameters[key] is True
        assert till_parameters_for_machine(w.db, w.tills[1]).parameters[key] is False

    def test_who_may_set_which_level(self, w):
        body = R.DrawerParamsIn(scopeType="company", scopeId=w.company.id, values={"cashDrawer.blindCount": True})
        assert refused(R.put_drawer_params, str(w.company.id), body, **ctx(w, w.shop_manager)).status_code == 403
        other = R.DrawerParamsIn(scopeType="shop", scopeId=w.other_shop.id, values={"cashDrawer.blindCount": True})
        assert refused(R.put_drawer_params, str(w.company.id), other, **ctx(w, w.shop_manager)).status_code == 403
        assert refused(R.put_drawer_params, str(w.company.id), other, **ctx(w, w.supervisor)).status_code == 403
        foreign = R.DrawerParamsIn(scopeType="company", scopeId=w.company2.id, values={})
        assert refused(R.put_drawer_params, str(w.company.id), foreign, **ctx(w)).status_code == 404

    def test_a_bad_value_is_refused(self, w):
        body = R.DrawerParamsIn(scopeType="company", scopeId=w.company.id, values={"cashDrawer.blindCount": "yes"})
        assert refused(R.put_drawer_params, str(w.company.id), body, **ctx(w)).status_code == 422
        body = R.DrawerParamsIn(scopeType="company", scopeId=w.company.id, values={"somethingElse": 1})
        assert refused(R.put_drawer_params, str(w.company.id), body, **ctx(w)).status_code == 422

def test_the_shared_matrix_fixture_is_the_catalogue():
    """tests/fixtures/till_permissions_matrix.json — the till's PermissionServiceTest reads the same bytes."""
    import json
    import pathlib

    data = json.loads((pathlib.Path(__file__).parent / "fixtures" / "till_permissions_matrix.json").read_text("utf-8"))
    assert data["codes"] == list(TP.CODES)
    assert data["scopes"] == dict(sorted(TP.SCOPE_PERMISSIONS.items()))
    assert set(data["roles"]) == set(TP.BUILTIN_BY_KEY)
    for key in TP.BUILTIN_BY_KEY:
        assert data["roles"][key]["states"] == TP.DEFAULTS[key], key
        assert data["roles"][key]["limits"] == TP.DEFAULT_LIMITS.get(key, {}), key


# ── "מחייב אישור מנהל במכירה" (SELL_RESTRICTED_ITEMS) on every built-in role ──────────


class TestRestrictedItemsPermission:
    """
    Managers and supervisors sell a restricted product alone and their code approves it for
    others; cashiers and waiters are asked for such a code; the legacy roles as their names say.
    """

    EXPECTED = {
        TP.MANAGER: A, TP.SUPERVISOR: A, TP.CASHIER: P, TP.WAITER: P,
        TP.LEGACY_MANAGER: A, TP.LEGACY_CASHIER: P,
    }

    def test_each_built_in_role_as_the_till_pulls_it(self, w):
        roles(w)
        for key in (TP.WAITER, TP.CASHIER, TP.SUPERVISOR, TP.MANAGER, TP.LEGACY_CASHIER, TP.LEGACY_MANAGER):
            R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=role_by(w, key).id), **ctx(w))
            row = roster(w)["dana"]
            assert row.till_role_key == key
            assert row.permissions["SELL_RESTRICTED_ITEMS"] == self.EXPECTED[key], key
            # Its code approves for others exactly when it may sell alone.
            assert S.pos_user_allows(w.dana, "SELL_RESTRICTED_ITEMS") is (self.EXPECTED[key] == A), key
            assert ("sale:restricted" in S.pos_user_scope_values(w.dana)) is (self.EXPECTED[key] == A), key

    def test_users_not_moved_to_a_role_yet_keep_their_legacy_reading(self, w):
        rows = roster(w)
        assert rows["dana"].permissions["SELL_RESTRICTED_ITEMS"] == P  # a cashier: asks
        assert rows["boss"].permissions["SELL_RESTRICTED_ITEMS"] == A  # a shop manager: alone
        assert S.pos_user_allows(w.boss, "SELL_RESTRICTED_ITEMS")
        assert not S.pos_user_allows(w.dana, "SELL_RESTRICTED_ITEMS")

    def test_the_roles_editor_shows_it_in_the_sale_group_with_hebrew_words(self, w):
        catalogue = R.get_catalogue(current_user=w.admin)
        spec = {p["code"]: p for p in catalogue["permissions"]}["SELL_RESTRICTED_ITEMS"]
        assert spec["group"] == "sale" and spec["label"] == "מכירת פריט המחייב אישור מנהל"
        assert "מחייב אישור מנהל במכירה" in spec["description"]
        assert any(g["key"] == "sale" for g in catalogue["groups"])
        builtins = {r["key"]: r for r in catalogue["builtinRoles"]}
        assert {k: r["permissions"]["SELL_RESTRICTED_ITEMS"] for k, r in builtins.items()} == self.EXPECTED

    def test_a_custom_role_and_a_personal_override_toggle_it(self, w):
        roles(w)
        bar = R.create_till_role(
            str(w.company.id),
            R.RoleCreateIn(name="ברמן", baseKey=TP.CASHIER, permissions={"SELL_RESTRICTED_ITEMS": A}),
            **ctx(w, w.company_manager),
        )
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=bar["id"]), **ctx(w))
        assert roster(w)["dana"].permissions["SELL_RESTRICTED_ITEMS"] == A
        R.assign_till_role(
            str(w.shop.id), str(w.dana.id),
            R.AssignIn(tillRoleId=bar["id"], overrides={"states": {"SELL_RESTRICTED_ITEMS": D}}), **ctx(w),
        )
        assert roster(w)["dana"].permissions["SELL_RESTRICTED_ITEMS"] == D
        # A manager asked for a code on one person only.
        R.assign_till_role(
            str(w.shop.id), str(w.boss.id),
            R.AssignIn(tillRoleId=role_by(w, TP.MANAGER).id, overrides={"states": {"SELL_RESTRICTED_ITEMS": P}}),
            **ctx(w),
        )
        assert roster(w)["boss"].permissions["SELL_RESTRICTED_ITEMS"] == P
        assert not S.pos_user_allows(w.boss, "SELL_RESTRICTED_ITEMS")

    def test_apply_the_specs_defaults_puts_it_back(self, w):
        roles(w)
        manager, cashier = role_by(w, TP.MANAGER), role_by(w, TP.CASHIER)
        R.update_till_role(str(w.company.id), str(manager.id), R.RoleUpdateIn(permissions={"SELL_RESTRICTED_ITEMS": P}), **ctx(w))
        R.update_till_role(str(w.company.id), str(cashier.id), R.RoleUpdateIn(permissions={"SELL_RESTRICTED_ITEMS": A}), **ctx(w))
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=cashier.id), **ctx(w))
        R.assign_till_role(str(w.shop.id), str(w.boss.id), R.AssignIn(tillRoleId=manager.id), **ctx(w))
        assert roster(w)["dana"].permissions["SELL_RESTRICTED_ITEMS"] == A
        assert roster(w)["boss"].permissions["SELL_RESTRICTED_ITEMS"] == P
        out = R.apply_spec_defaults(str(w.company.id), R.ApplyDefaultsIn(), **ctx(w, w.company_manager))
        assert set(out["applied"]["resetRoles"]) == {TP.MANAGER, TP.CASHIER}
        rows = roster(w)
        assert rows["dana"].permissions["SELL_RESTRICTED_ITEMS"] == P
        assert rows["boss"].permissions["SELL_RESTRICTED_ITEMS"] == A
        # Legacy users moved to the spec's roles keep the same answer.
        out = R.apply_spec_defaults(
            str(w.company.id), R.ApplyDefaultsIn(resetBuiltins=False, moveLegacyUsers=True), **ctx(w),
        )
        w.db.refresh(w.nir)
        assert w.nir.till_role.builtin_key == TP.CASHIER  # the other shop's legacy cashier
        assert S.effective_for_pos_user(w.nir).state("SELL_RESTRICTED_ITEMS") == P


# ── "ביטול מכירה מושהית" (HELD_SALE_CANCEL) on every built-in role ────────────────────────────


class TestHeldSaleCancelPermission:
    """
    Cancelling a held sale at the till (a shift close or Z, app/services/held_sales_close.py): a manager
    or a supervisor alone; a cashier or a waiter on a manager's code; the legacy roles the same way.
    """

    EXPECTED = {
        TP.MANAGER: A, TP.SUPERVISOR: A, TP.CASHIER: P, TP.WAITER: P,
        TP.LEGACY_MANAGER: A, TP.LEGACY_CASHIER: P,
    }

    def test_each_built_in_role_as_the_till_pulls_it(self, w):
        roles(w)
        for key in (TP.WAITER, TP.CASHIER, TP.SUPERVISOR, TP.MANAGER, TP.LEGACY_CASHIER, TP.LEGACY_MANAGER):
            R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=role_by(w, key).id), **ctx(w))
            assert roster(w)["dana"].permissions["HELD_SALE_CANCEL"] == self.EXPECTED[key], key

    def test_users_not_moved_to_a_role_yet_keep_their_legacy_reading(self, w):
        rows = roster(w)
        assert rows["dana"].permissions["HELD_SALE_CANCEL"] == P  # a cashier: a manager's code
        assert rows["boss"].permissions["HELD_SALE_CANCEL"] == A  # a shop manager: alone

    def test_the_roles_editor_shows_it_in_the_sale_group_with_hebrew_words(self, w):
        catalogue = R.get_catalogue(current_user=w.admin)
        spec = {p["code"]: p for p in catalogue["permissions"]}["HELD_SALE_CANCEL"]
        assert spec["group"] == "sale" and spec["label"] == "ביטול מכירה מושהית"
        builtins = {r["key"]: r for r in catalogue["builtinRoles"]}
        assert {k: r["permissions"]["HELD_SALE_CANCEL"] for k, r in builtins.items()} == self.EXPECTED
        # Right after "ביטול שורה" in the catalogue (and in the shared matrix the till reads).
        codes = list(TP.CODES)
        assert codes.index("HELD_SALE_CANCEL") == codes.index("LINE_VOID") + 1
