"""
"כשאין הרשאה" (P:/specs/denied-actions-ui.md): what the till does with an option the operator's role
denies — show (today), hide, or ask a manager's code. The level parameter `deniedActionUi`, the role's
`denied_ui`, the employee's `permission_overrides.deniedUi`, their precedence, the roster the till pulls,
the cloud checks of the signed-in operator that must agree with the till, and the migration.

Runs on the in-memory SQLite world of tests/shift_world.py (the migration renders offline in PostgreSQL's
dialect, whatever database the tests run on).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.models.pos_user import PosUser, PosUserRole
from app.models.till_role import TillRole, TillRoleChange
from app.routers import sync as sync_router
from app.routers import till_roles as R
from app.services import cash_drawer as CD
from app.services import till_permissions as TP
from app.services import till_roles as S
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
    world.dana = PosUser(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, username="dana",
        first_name="Dana", pin_hash="x", role=PosUserRole.CASHIER, is_active=True,
    )
    world.db.add(world.dana)
    world.db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def roles(w):
    return R.list_till_roles(str(w.company.id), **ctx(w))


def role_by(w, key) -> TillRole:
    return w.db.query(TillRole).filter(TillRole.company_id == w.company.id, TillRole.builtin_key == key).one()


def roster(w, till=None):
    till = till or w.tills[0]
    out = sync_router.get_pos_users_sync(str(till.id), since=None, machine=till, db=w.db)
    return {u.username: u for u in out.users}


def as_waiter(w):
    roles(w)
    waiter = role_by(w, TP.WAITER)
    R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=waiter.id), **ctx(w))
    return waiter


def put_level(w, scope_type, scope_id, values):
    return R.put_drawer_params(
        str(w.company.id), R.DrawerParamsIn(scopeType=scope_type, scopeId=scope_id, values=values), **ctx(w),
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


# ── The contract ──────────────────────────────────────────────────────────────


class TestContract:
    def test_the_three_answers_and_their_hebrew(self):
        assert TP.DENIED_UI_OPTIONS == ("show", "hide", "code")
        assert TP.DENIED_UI_LABELS == {"show": "להציג (כמו היום)", "hide": "להסתיר", "code": "לבקש קוד מנהל"}

    def test_cleaning(self):
        assert TP.clean_denied_ui(None) is None
        assert TP.clean_denied_ui("") is None and TP.clean_denied_ui("inherit") is None
        assert TP.clean_denied_ui(" Hide ") == "hide"
        for bad in ("sometimes", 1, True, {"x": 1}):
            with pytest.raises(TP.PermissionValueError):
                TP.clean_denied_ui(bad)

    def test_the_untouched_codes_are_catalogue_codes_and_rules_not_options(self):
        assert TP.DENIED_UI_UNTOUCHED <= set(TP.CODES)
        assert TP.DENIED_UI_UNTOUCHED == {
            "MULTI_DEVICE_LOGIN", "CASH_DRAWER.APPROVE_OPEN", "CASH_DRAWER.OPEN_ON_CASH_SALE", "DESKTOP_EXIT",
            "SELL_RESTRICTED_ITEMS",
        } | TP.REMOTE_APPROVAL_CODES
        # The options the owner named stay options (a kiosk's till mode too: the voucher station's exit).
        for code in ("REFUND", "DISCOUNT", "LINE_VOID", "TABLE_CANCEL", "Z", "CASH_DRAWER.CASH_OUT", "CALCULATOR.USE",
                     "KIOSK_TILL_MODE"):
            assert code not in TP.DENIED_UI_UNTOUCHED, code

    @pytest.mark.parametrize("state, code, mode, expected", [
        (D, "REFUND", "code", P),
        (D, "REFUND", "hide", D),
        (D, "REFUND", "show", D),
        (D, "REFUND", None, D),
        (A, "REFUND", "code", A),
        (P, "REFUND", "code", P),
        (D, "MULTI_DEVICE_LOGIN", "code", D),
        (D, "CASH_DRAWER.APPROVE_OPEN", "code", D),
    ])
    def test_code_turns_deny_into_approval_and_nothing_else(self, state, code, mode, expected):
        assert TP.denied_ui_state(state, code, mode) == expected

    def test_the_catalogue_carries_the_options_and_the_untouched_codes(self):
        out = TP.catalogue_out()["deniedUi"]
        assert [o["key"] for o in out["options"]] == ["show", "hide", "code"]
        assert set(out["untouched"]) == set(TP.DENIED_UI_UNTOUCHED)


# ── Precedence: employee → role → level → show ────────────────────────────────


class TestPrecedence:
    def test_the_employee_over_the_role_over_nothing(self):
        both = TP.effective_permissions(template=TP.WAITER, overrides={"deniedUi": "hide"}, role_denied_ui="code")
        assert (both.denied_ui, both.denied_ui_source) == ("hide", "override")
        role = TP.effective_permissions(template=TP.WAITER, role_denied_ui="code")
        assert (role.denied_ui, role.denied_ui_source) == ("code", "role")
        none = TP.effective_permissions(template=TP.WAITER)
        assert (none.denied_ui, none.denied_ui_source) == (None, None)

    def test_a_value_the_catalogue_does_not_know_is_ignored(self):
        assert TP.effective_permissions(template=TP.WAITER, role_denied_ui="maybe").denied_ui is None
        eff = TP.effective_permissions(template=TP.WAITER, overrides={"deniedUi": 7}, role_denied_ui="hide")
        assert eff.denied_ui == "hide"

    def test_never_more_than_the_role_allows(self):
        """`deniedUi` changes no state: the matrix the till gets is the same with or without it."""
        plain = TP.effective_permissions(template=TP.WAITER)
        coded = TP.effective_permissions(template=TP.WAITER, role_denied_ui="code")
        assert coded.states == plain.states and coded.limits == plain.limits

    def test_the_level_decides_where_nobody_else_did(self, w):
        as_waiter(w)
        till = w.tills[0]
        assert S.denied_ui_for(w.db, w.dana, till) == "show"  # nothing set anywhere: today
        put_level(w, "shop", w.shop.id, {CD.DENIED_ACTION_UI_KEY: "code"})
        put_level(w, "machine", w.tills[1].id, {CD.DENIED_ACTION_UI_KEY: "hide"})
        assert S.denied_ui_for(w.db, w.dana, till) == "code"
        assert S.denied_ui_for(w.db, w.dana, w.tills[1]) == "hide"
        # The role over the level, the employee over the role.
        R.update_till_role(str(w.company.id), str(role_by(w, TP.WAITER).id), R.RoleUpdateIn(deniedUi="show"), **ctx(w))
        w.db.refresh(w.dana)
        assert S.denied_ui_for(w.db, w.dana, w.tills[1]) == "show"
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(
            tillRoleId=role_by(w, TP.WAITER).id, overrides={"deniedUi": "hide"}), **ctx(w))
        assert S.denied_ui_for(w.db, w.dana, till) == "hide"


# ── The level parameter ───────────────────────────────────────────────────────


class TestLevelParameter:
    def test_built_in_on_the_roles_page_with_today_as_the_default(self):
        from app.services.till_parameters import BUILTIN_PARAMETERS

        spec = {p.key: p for p in BUILTIN_PARAMETERS}[CD.DENIED_ACTION_UI_KEY]
        assert CD.DENIED_ACTION_UI_KEY == "deniedActionUi" == S.DENIED_ACTION_UI_KEY
        assert spec.value_type == "enum" and tuple(spec.enum_options) == ("show", "hide", "code")
        assert spec.default_value == "show"
        assert spec.label and "אין הרשאה" in spec.label and spec.description
        # On the roles page's level editor, right before the older "הסתר / הצג מושבת".
        keys = list(CD.LEVEL_KEYS)
        assert keys.index(CD.DENIED_ACTION_UI_KEY) == keys.index(CD.DENIED_UI_KEY) - 1

    def test_every_till_gets_show_until_a_level_says_otherwise(self, w):
        from app.services.till_parameters import ensure_builtin_parameters, till_parameters_for_machine

        ensure_builtin_parameters(w.db)
        assert till_parameters_for_machine(w.db, w.tills[0]).parameters[CD.DENIED_ACTION_UI_KEY] == "show"
        view = put_level(w, "company", w.company.id, {CD.DENIED_ACTION_UI_KEY: "hide"})
        assert view["own"] == {CD.DENIED_ACTION_UI_KEY: "hide"}
        labels = {p["key"]: p for p in view["parameters"]}[CD.DENIED_ACTION_UI_KEY]["enumLabels"]
        assert labels["hide"] == "להסתיר" and labels["code"] == "לבקש קוד מנהל" and labels["show"].startswith("להציג")
        put_level(w, "machine", w.tills[1].id, {CD.DENIED_ACTION_UI_KEY: "code"})
        assert till_parameters_for_machine(w.db, w.tills[0]).parameters[CD.DENIED_ACTION_UI_KEY] == "hide"
        assert till_parameters_for_machine(w.db, w.tills[1]).parameters[CD.DENIED_ACTION_UI_KEY] == "code"
        put_level(w, "machine", w.tills[1].id, {CD.DENIED_ACTION_UI_KEY: None})
        assert till_parameters_for_machine(w.db, w.tills[1]).parameters[CD.DENIED_ACTION_UI_KEY] == "hide"

    def test_a_value_it_does_not_know_is_refused(self, w):
        err = refused(put_level, w, "shop", w.shop.id, {CD.DENIED_ACTION_UI_KEY: "sometimes"})
        assert err.status_code == 422

    def test_the_older_parameter_is_unchanged(self):
        from app.services.till_parameters import BUILTIN_PARAMETERS

        spec = {p.key: p for p in BUILTIN_PARAMETERS}[CD.DENIED_UI_KEY]
        assert tuple(spec.enum_options) == ("הסתר", "הצג מושבת עם הסבר") and spec.default_value == "הסתר"


# ── Per role (the matrix's first row) ─────────────────────────────────────────


class TestPerRole:
    def test_inherit_by_default(self, w):
        out = roles(w)
        assert all(r["deniedUi"] is None for r in out["roles"])
        assert w.db.query(TillRole).filter(TillRole.denied_ui.isnot(None)).count() == 0

    def test_the_matrix_save_sets_it_restamps_and_tells_the_tills(self, w):
        waiter = as_waiter(w)
        cashier = role_by(w, TP.CASHIER)
        w.db.refresh(w.dana)
        stamp = w.dana.updated_at
        w.notified.clear()
        out = R.save_till_role_matrix(str(w.company.id), R.MatrixIn(roles=[
            R.MatrixRoleIn(id=waiter.id, deniedUi="hide"),
            R.MatrixRoleIn(id=cashier.id, deniedUi="code"),
        ]), **ctx(w))
        by_key = {r["builtinKey"]: r for r in out["roles"]}
        assert by_key[TP.WAITER]["deniedUi"] == "hide" and by_key[TP.CASHIER]["deniedUi"] == "code"
        # The matrix itself did not move.
        assert by_key[TP.WAITER]["permissions"] == TP.DEFAULTS[TP.WAITER]
        w.db.refresh(w.dana)
        assert w.dana.updated_at != stamp  # the till's delta roster pull sees it
        assert any(reason == "till_roles_updated" for _, reason in w.notified)
        assert roster(w)["dana"].denied_ui == "hide"

    def test_a_save_that_omits_it_leaves_it_and_null_inherits_again(self, w):
        waiter = as_waiter(w)
        R.save_till_role_matrix(str(w.company.id), R.MatrixIn(roles=[R.MatrixRoleIn(id=waiter.id, deniedUi="code")]), **ctx(w))
        R.save_till_role_matrix(str(w.company.id), R.MatrixIn(roles=[
            R.MatrixRoleIn(id=waiter.id, permissions={"REFUND": P}),
        ]), **ctx(w))
        w.db.refresh(waiter)
        assert waiter.denied_ui == "code" and waiter.permissions == {"REFUND": P}
        R.save_till_role_matrix(str(w.company.id), R.MatrixIn(roles=[R.MatrixRoleIn(id=waiter.id, deniedUi=None)]), **ctx(w))
        w.db.refresh(waiter)
        assert waiter.denied_ui is None
        assert roster(w)["dana"].denied_ui is None

    def test_an_unknown_value_refuses_the_whole_save(self, w):
        roles(w)
        cashier, waiter = role_by(w, TP.CASHIER), role_by(w, TP.WAITER)
        body = R.MatrixIn(roles=[
            R.MatrixRoleIn(id=cashier.id, deniedUi="hide"),
            R.MatrixRoleIn(id=waiter.id, deniedUi="sometimes"),
        ])
        err = refused(R.save_till_role_matrix, str(w.company.id), body, **ctx(w))
        assert err.status_code == 422 and err.detail["code"] == "invalid_denied_ui"
        w.db.refresh(cashier)
        assert cashier.denied_ui is None

    def test_the_single_role_edit_and_the_audit(self, w):
        roles(w)
        waiter = role_by(w, TP.WAITER)
        out = R.update_till_role(str(w.company.id), str(waiter.id), R.RoleUpdateIn(deniedUi="hide"), **ctx(w))
        assert out["deniedUi"] == "hide"
        # Unchanged when the edit does not name it.
        out = R.update_till_role(str(w.company.id), str(waiter.id), R.RoleUpdateIn(name="מלצרית"), **ctx(w))
        assert out["deniedUi"] == "hide"
        rows = (
            w.db.query(TillRoleChange).filter(TillRoleChange.role_id == waiter.id, TillRoleChange.action == "update")
            .order_by(TillRoleChange.created_at).all()
        )
        assert rows[0].old_value.get("deniedUi") is None and rows[0].new_value["deniedUi"] == "hide"
        # The same value again records nothing.
        before = len(rows)
        R.update_till_role(str(w.company.id), str(waiter.id), R.RoleUpdateIn(deniedUi="hide"), **ctx(w))
        assert w.db.query(TillRoleChange).filter(
            TillRoleChange.role_id == waiter.id, TillRoleChange.action == "update").count() == before

    def test_a_new_role_and_a_duplicate(self, w):
        roles(w)
        bar = R.create_till_role(str(w.company.id), R.RoleCreateIn(name="ברמן", deniedUi="code"), **ctx(w))
        assert bar["deniedUi"] == "code"
        copy = R.create_till_role(str(w.company.id), R.RoleCreateIn(name="ברמן 2", copyFromRoleId=bar["id"]), **ctx(w))
        assert copy["deniedUi"] == "code"
        other = R.create_till_role(
            str(w.company.id), R.RoleCreateIn(name="ברמן 3", copyFromRoleId=bar["id"], deniedUi=None), **ctx(w),
        )
        assert other["deniedUi"] is None
        plain = R.create_till_role(str(w.company.id), R.RoleCreateIn(name="ברמן 4"), **ctx(w))
        assert plain["deniedUi"] is None

    def test_only_who_may_define_roles(self, w):
        from app.models.user import User, UserRole

        roles(w)
        mgr = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, company_id=w.company.id,
                   shop_id=w.shop.id, email="m@x", username="m")
        w.db.add(mgr)
        w.db.flush()
        body = R.MatrixIn(roles=[R.MatrixRoleIn(id=role_by(w, TP.WAITER).id, deniedUi="hide")])
        assert refused(R.save_till_role_matrix, str(w.company.id), body, **ctx(w, mgr)).status_code == 403

    def test_the_spec_defaults_leave_it(self, w):
        """"החל ברירות מחדל לפי האפיון" puts the matrix back; "כשאין הרשאה" is not the matrix."""
        waiter = as_waiter(w)
        R.update_till_role(str(w.company.id), str(waiter.id),
                           R.RoleUpdateIn(permissions={"REFUND": A}, deniedUi="hide"), **ctx(w))
        R.apply_spec_defaults(str(w.company.id), R.ApplyDefaultsIn(), **ctx(w))
        w.db.refresh(waiter)
        assert waiter.permissions == {} and waiter.denied_ui == "hide"


# ── Per employee (הרשאות אישיות) ──────────────────────────────────────────────


class TestPerEmployee:
    def test_an_override_wins_and_is_cleared_with_the_rest(self, w):
        waiter = as_waiter(w)
        R.update_till_role(str(w.company.id), str(waiter.id), R.RoleUpdateIn(deniedUi="hide"), **ctx(w))
        out = R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(
            tillRoleId=waiter.id, overrides={"states": {}, "deniedUi": "code"}), **ctx(w))
        assert out["deniedUi"] == "code" and out["deniedUiSource"] == "override"
        assert out["overrides"] == {"states": {}, "limits": {}, "deniedUi": "code"}
        assert roster(w)["dana"].denied_ui == "code"
        users = R.list_till_role_users(str(w.company.id), shop_id=None, include_inactive=False, **ctx(w))
        dana = {u["username"]: u for u in users["users"]}["dana"]
        assert dana["deniedUi"] == "code" and dana["deniedUiSource"] == "override"
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(tillRoleId=waiter.id, clearOverrides=True), **ctx(w))
        assert roster(w)["dana"].denied_ui == "hide"

    def test_kept_beside_states_and_the_phone_approvals(self, w):
        waiter = as_waiter(w)
        w.dana.permission_overrides = {"approvals": {"refund": {"max": 100}}}
        w.db.commit()
        R.assign_till_role(str(w.shop.id), str(w.dana.id), R.AssignIn(
            tillRoleId=waiter.id, overrides={"states": {"REFUND": A}, "deniedUi": "hide"}), **ctx(w))
        w.db.refresh(w.dana)
        assert w.dana.permission_overrides == {
            "states": {"REFUND": A}, "limits": {}, "deniedUi": "hide", "approvals": {"refund": {"max": 100}},
        }

    def test_an_unknown_value_is_refused(self, w):
        waiter = as_waiter(w)
        err = refused(R.assign_till_role, str(w.shop.id), str(w.dana.id), R.AssignIn(
            tillRoleId=waiter.id, overrides={"deniedUi": "later"}), **ctx(w))
        assert err.status_code == 422

    def test_a_user_with_no_role_yet_too(self, w):
        """An untouched company (no role rows): the legacy role, with the employee's own setting."""
        w.dana.permission_overrides = {"deniedUi": "hide"}
        w.db.commit()
        eff = S.effective_for_pos_user(w.dana)
        assert eff.role_key == TP.LEGACY_CASHIER and eff.denied_ui == "hide"


# ── The roster ────────────────────────────────────────────────────────────────


class TestRoster:
    def test_on_the_wire_as_deniedUi(self, w):
        waiter = as_waiter(w)
        row = roster(w)["dana"]
        assert row.denied_ui is None
        assert "deniedUi" in row.model_dump(by_alias=True)
        R.update_till_role(str(w.company.id), str(waiter.id), R.RoleUpdateIn(deniedUi="code"), **ctx(w))
        assert roster(w)["dana"].model_dump(by_alias=True)["deniedUi"] == "code"

    def test_an_untouched_company_sends_nothing_new(self, w):
        row = roster(w)["dana"]
        assert row.denied_ui is None and row.permissions == TP.DEFAULTS[TP.LEGACY_CASHIER]


# ── The cloud's checks of the signed-in operator agree with the till ──────────


class TestOperatorState:
    def test_code_makes_a_denial_an_approval_for_the_operator(self, w):
        as_waiter(w)
        till = w.tills[0]
        code = "CASH_DRAWER.CASH_OUT"
        assert TP.DEFAULTS[TP.WAITER][code] == D
        assert S.operator_state(w.db, w.dana, code, till) == D
        put_level(w, "shop", w.shop.id, {CD.DENIED_ACTION_UI_KEY: "code"})
        assert S.operator_state(w.db, w.dana, code, till) == P
        # A rule is never turned: the waiter is still bound to one device.
        assert TP.DEFAULTS[TP.WAITER]["MULTI_DEVICE_LOGIN"] == D
        assert S.operator_state(w.db, w.dana, "MULTI_DEVICE_LOGIN", till) == D
        # "להסתיר" on the role: hidden on the till, refused here as ever.
        R.update_till_role(str(w.company.id), str(role_by(w, TP.WAITER).id), R.RoleUpdateIn(deniedUi="hide"), **ctx(w))
        w.db.refresh(w.dana)
        assert S.operator_state(w.db, w.dana, code, till) == D
        # Never more than the role: an approver's own `allow` is what approves.
        assert not S.pos_user_allows(w.dana, code)

    def test_a_test_voucher_follows_the_tills_code(self, w):
        """VOUCHER_TEST_REDEEM: the cloud refuses a denied operator — unless the till asked a manager's code."""
        from app.models.pos_user_session import PosUserSession
        from app.services import prepaid_voucher_controls as PVC

        waiter = as_waiter(w)
        R.update_till_role(str(w.company.id), str(waiter.id),
                           R.RoleUpdateIn(permissions={PVC.TEST_PERMISSION: D}), **ctx(w))
        now = datetime.now(timezone.utc)
        w.db.add(PosUserSession(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, pos_user_id=w.dana.id,
            machine_id=w.tills[0].id, started_at=now, last_seen_at=now,
        ))
        w.db.commit()
        w.db.refresh(w.dana)
        assert PVC._staff_denied(w.db, w.tills[0]) is True
        R.update_till_role(str(w.company.id), str(waiter.id), R.RoleUpdateIn(deniedUi="code"), **ctx(w))
        assert PVC._staff_denied(w.db, w.tills[0]) is False


# ── The migration ─────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_main():
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert "d9e4b2a7c1f8" in {r.revision for r in script.walk_revisions("base", heads[0])}
    # On main's head of 15.10 (cash stage 2), nothing else.
    assert script.get_revision("d9e4b2a7c1f8").down_revision == "e5a9c3d1f7b2"


_NO_PROXY = object()


def _render(*args, downgrade=False) -> str:
    """`alembic upgrade --sql` from this checkout's own path — `absolute()`, never `resolve()` (a subst drive such
    as P: resolves to the long path, where Windows cannot open the revisions). Always in PostgreSQL's dialect
    (production's), whatever database the tests run on; alembic's proxies and the loggers put back afterwards."""
    import io
    import logging
    from pathlib import Path

    import alembic.context
    import alembic.op
    from alembic import command
    from alembic.config import Config

    from app.config import get_settings

    here = Path(__file__).absolute().parents[1]
    buf = io.StringIO()
    cfg = Config(str(here / "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", str(here / "alembic"))
    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    settings = get_settings()
    url = settings.database_url
    proxies = {m: vars(m).get("_proxy", _NO_PROXY) for m in (alembic.context, alembic.op)}
    try:
        settings.database_url = "postgresql://render-only/offline"
        (command.downgrade if downgrade else command.upgrade)(cfg, *args, sql=True)
    finally:
        settings.database_url = url
        for module, proxy in proxies.items():
            if proxy is _NO_PROXY:
                vars(module).pop("_proxy", None)
            else:
                vars(module)["_proxy"] = proxy
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


def test_the_migration_adds_one_nullable_column_and_moves_no_row():
    sql = _render("e5a9c3d1f7b2:d9e4b2a7c1f8")
    body = sql.split("e5a9c3d1f7b2", 1)[-1]
    assert "ALTER TABLE till_roles ADD COLUMN denied_ui VARCHAR(8)" in body
    assert "NOT NULL" not in body.replace("version_num VARCHAR(32) NOT NULL", "")
    assert "UPDATE till_roles" not in body and "DROP" not in body and "CREATE TABLE" not in body


def test_the_migration_downgrade_drops_the_column():
    sql = _render("d9e4b2a7c1f8:e5a9c3d1f7b2", downgrade=True)
    assert "ALTER TABLE till_roles DROP COLUMN denied_ui" in sql
