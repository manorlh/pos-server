"""
"ניהול קטלוג מהקופה" — the cloud side of specs/till-catalog-management.md §6.

What each part pins, and how it could look fine while doing damage:

* **Parameters (§6.1)** — the four built-ins exist with their defaults and resolve by level like
  any other; a value at a lower level wins.
* **`catalogAdminView`** — worked out by the cloud and sent in the parameters pull: a till in a
  point of sale with a menu sees the menu; without one, the shop's catalog; a till with no
  point of sale, the shop's; `shop` ignores menus; `till` shows only the till's own; an
  inactive menu does not count. A view that followed the wrong level would show the manager
  products this till does not sell — or hide the ones it does.
* **Permissions (§6.2)** — the defaults per built-in role; a role saved with `CATALOG_WRITE`
  reads the four writes at that level (stored rows untouched); a legacy `catalog:write` grant
  answers for all four; each till endpoint asks for its own scope, and a product update for
  exactly what it changes.
* **Menu clear and parameter reset (§6.3)** — only that level, logged, the level inherits again.

Runs on the in-memory SQLite world of tests/shift_world.py (the menus world of
tests/test_catalog_menus.py).
"""
from __future__ import annotations

import inspect
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.middleware import auth as A
from app.models.catalog_menu import CatalogMenuAssignment, CatalogMenuFallback
from app.models.pos_user import PosUser, PosUserRole
from app.models.till_parameter import TillParameterChange, TillParameterValue
from app.routers import catalog_menus as R
from app.routers import sync as sync_router
from app.routers import till_parameters as TPR
from app.schemas.product import ProductUpdate
from app.services import catalog_admin as CA
from app.services import till_parameters as TP
from app.services import till_permissions as PERM
from app.services.permissions import CATALOG_WRITE_COVERS, Scope, parse_scopes, till_grantable_scopes
from app.models.user import UserRole
from test_catalog_menus import assign, create, mw  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401

KEYS = ("catalogAdminEnabled", "catalogAdminScope", "catalogCreateFromTill", "catalogWithoutShift")


def params_of(w, till):
    return TP.till_parameters_for_machine(w.db, till).parameters


def put_level(w, level, ident, **values):
    body = TPR.CatalogAdminValuesIn(level=level, id=ident, values=values)
    return TPR.put_catalog_admin_parameters(body, BackgroundTasks(), _admin=w.admin, db=w.db)


def view(w, till):
    w.db.expire_all()
    return CA.view_for_machine(w.db, till)


# ── §6.1 The parameters ──────────────────────────────────────────────────────


def test_the_four_are_built_ins_with_the_contract_defaults(mw):
    specs = {s.key: s for s in TP.BUILTIN_PARAMETERS if s.key in KEYS}
    assert set(specs) == set(KEYS)
    assert specs["catalogAdminEnabled"].default_value is True
    assert specs["catalogAdminScope"].enum_options == ("auto", "area", "shop", "till")
    assert specs["catalogAdminScope"].default_value == "auto"
    assert specs["catalogCreateFromTill"].default_value is True
    assert specs["catalogWithoutShift"].enum_options == ("manager", "never")
    assert specs["catalogWithoutShift"].default_value == "manager"
    assert all(specs[k].label and specs[k].description for k in KEYS)
    assert specs["catalogAdminEnabled"].label == "ניהול קטלוג מהקופה"
    got = params_of(mw, mw.t1)
    assert {k: got[k] for k in KEYS} == {
        "catalogAdminEnabled": True, "catalogAdminScope": "auto",
        "catalogCreateFromTill": True, "catalogWithoutShift": "manager",
    }


def test_the_most_specific_level_wins(mw):
    put_level(mw, "company", mw.company.id, catalogAdminScope="shop", catalogAdminEnabled=False)
    put_level(mw, "area", mw.bar.id, catalogAdminScope="area")
    put_level(mw, "machine", mw.t1.id, catalogWithoutShift="never")
    t1, t2 = params_of(mw, mw.t1), params_of(mw, mw.t2)
    assert (t1["catalogAdminScope"], t1["catalogAdminEnabled"], t1["catalogWithoutShift"]) == ("area", False, "never")
    assert (t2["catalogAdminScope"], t2["catalogAdminEnabled"], t2["catalogWithoutShift"]) == ("shop", False, "manager")


def test_the_level_editor_shows_own_and_inherited_and_refuses_bad_values(mw):
    put_level(mw, "shop", mw.shop.id, catalogAdminScope="till")
    out = TPR.get_catalog_admin_parameters(level="area", ident=mw.bar.id, _admin=mw.admin, db=mw.db)
    assert out["own"] == {} and out["inherited"]["catalogAdminScope"] == "till"
    assert [p["key"] for p in out["parameters"]] == list(KEYS)
    with pytest.raises(HTTPException) as exc:
        put_level(mw, "area", mw.bar.id, catalogAdminScope="everything")
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        put_level(mw, "area", mw.bar.id, areaScopeLock=False)  # not one of the four
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        put_level(mw, "area", uuid.uuid4(), catalogAdminScope="shop")
    assert exc.value.status_code == 404
    # Logged like every value.
    assert mw.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == "catalogAdminScope").count() == 1


def test_the_page_routes_are_the_super_admins():
    from app.middleware.auth import get_current_super_admin

    for fn in (TPR.get_catalog_admin_parameters, TPR.put_catalog_admin_parameters, TPR.reset_till_parameters):
        assert inspect.signature(fn).parameters["_admin"].default.dependency is get_current_super_admin


# ── catalogAdminView ─────────────────────────────────────────────────────────


def test_a_till_in_a_point_of_sale_with_a_menu_sees_the_menu(mw):
    bar_menu = create(mw, name="בר")
    assign(mw, "area", mw.bar, bar_menu)
    assert view(mw, mw.t1) == {"scope": "menu", "menuId": bar_menu["id"], "label": "תפריט נקודה: בר"}


def test_a_till_in_a_point_of_sale_without_a_menu_sees_the_shop(mw):
    shop_menu = create(mw, name="סניף")
    assign(mw, "shop", mw.shop, shop_menu)  # a shop menu is not the point of sale's
    assert view(mw, mw.t1) == {"scope": "shop", "label": "קטלוג הסניף"}


def test_a_till_without_a_point_of_sale_sees_the_shop_unless_it_has_its_own_menu(mw):
    assert mw.t2.area_id is None
    assert view(mw, mw.t2) == {"scope": "shop", "label": "קטלוג הסניף"}
    own = create(mw, name="קופה 2")
    assign(mw, "machine", mw.t2, own)
    assert view(mw, mw.t2) == {"scope": "menu", "menuId": own["id"], "label": "תפריט קופה: קופה 2"}


def test_the_tills_own_menu_beats_its_point_of_sales(mw):
    bar_menu, own = create(mw, name="בר"), create(mw, name="שלי")
    assign(mw, "area", mw.bar, bar_menu)
    assign(mw, "machine", mw.t1, own)
    assert view(mw, mw.t1)["menuId"] == own["id"]


def test_scope_shop_shows_the_whole_shop_even_with_a_menu(mw):
    bar_menu = create(mw, name="בר")
    assign(mw, "area", mw.bar, bar_menu)
    put_level(mw, "machine", mw.t1.id, catalogAdminScope="shop")
    assert view(mw, mw.t1) == {"scope": "shop", "label": "קטלוג הסניף"}


def test_scope_till_shows_only_the_tills_own(mw):
    bar_menu = create(mw, name="בר")
    assign(mw, "area", mw.bar, bar_menu)
    put_level(mw, "shop", mw.shop.id, catalogAdminScope="till")
    # The point of sale's menu is not the till's own: its product list.
    assert view(mw, mw.t1) == {"scope": "till", "label": "מוצרי הקופה"}
    own = create(mw, name="שלי")
    assign(mw, "machine", mw.t1, own)
    assert view(mw, mw.t1)["menuId"] == own["id"]


def test_scope_area_counts_only_the_point_of_sales_menu(mw):
    own = create(mw, name="שלי")
    assign(mw, "machine", mw.t1, own)
    put_level(mw, "company", mw.company.id, catalogAdminScope="area")
    assert view(mw, mw.t1)["scope"] == "shop"
    bar_menu = create(mw, name="בר")
    assign(mw, "area", mw.bar, bar_menu)
    assert view(mw, mw.t1)["menuId"] == bar_menu["id"]
    assert view(mw, mw.t2)["scope"] == "shop"  # no point of sale at all


def test_an_inactive_menu_does_not_count(mw):
    bar_menu = create(mw, name="בר", isActive=False)
    assign(mw, "area", mw.bar, bar_menu)
    assert view(mw, mw.t1)["scope"] == "shop"


def test_the_pure_rule_reads_an_unknown_scope_as_auto():
    block = {"menus": [{"id": "m", "name": "בר"}], "assignments": [{"menuId": "m", "level": "area"}]}
    assert CA.resolve_view("nonsense", has_area=True, block=block)["menuId"] == "m"
    assert CA.resolve_view("area", has_area=False, block=block)["scope"] == "shop"
    assert CA.resolve_view("till", has_area=True, block=None)["scope"] == "till"


def test_the_parameters_pull_carries_the_view_and_its_etag_follows_it(mw):
    req = SimpleNamespace(headers={})
    first = sync_router.get_till_parameters_sync(str(mw.t1.id), machine=mw.t1, request=req, db=mw.db)
    import json

    body = json.loads(first.body)
    assert body["catalogAdminView"] == {"scope": "shop", "label": "קטלוג הסניף"}
    assert body["parameters"]["catalogAdminScope"] == "auto"
    assert all(not isinstance(v, (dict, list)) for v in body["parameters"].values())
    etag = first.headers["etag"]
    bar_menu = create(mw, name="בר")
    assign(mw, "area", mw.bar, bar_menu)
    mw.db.expire_all()
    again = sync_router.get_till_parameters_sync(
        str(mw.t1.id), machine=mw.t1, request=SimpleNamespace(headers={"if-none-match": etag}), db=mw.db,
    )
    assert again.status_code == 200 and again.headers["etag"] != etag
    assert json.loads(again.body)["catalogAdminView"]["menuId"] == bar_menu["id"]


# ── §6.2 Permissions ─────────────────────────────────────────────────────────

A_, P_, D_ = PERM.ALLOW, PERM.APPROVAL, PERM.DENY


def test_the_new_codes_and_their_defaults_per_built_in_role():
    expected = {
        "CATALOG_VIEW": (A_, A_, A_, A_),
        "CATALOG_AVAILABILITY": (D_, P_, A_, A_),
        "CATALOG_PRICE": (D_, D_, P_, A_),
        "CATALOG_EDIT": (D_, D_, P_, A_),
        "CATALOG_CREATE": (D_, D_, P_, A_),
    }
    roles = (PERM.WAITER, PERM.CASHIER, PERM.SUPERVISOR, PERM.MANAGER)
    for code, states in expected.items():
        assert code in PERM.PERMISSIONS_BY_CODE
        assert PERM.PERMISSIONS_BY_CODE[code].label.startswith("ניהול קטלוג")
        assert tuple(PERM.DEFAULTS[r][code] for r in roles) == states, code
        assert PERM.DEFAULTS[PERM.LEGACY_MANAGER][code] == A_
    # A legacy cashier: as CATALOG_WRITE was — a manager's code; seeing the screen is free.
    for code in PERM.CATALOG_FINE_CODES:
        assert PERM.DEFAULTS[PERM.LEGACY_CASHIER][code] == P_
    assert PERM.DEFAULTS[PERM.LEGACY_CASHIER]["CATALOG_VIEW"] == A_
    # CATALOG_WRITE stays for screen editing, printers and tables, unchanged.
    assert tuple(PERM.DEFAULTS[r]["CATALOG_WRITE"] for r in roles) == (D_, P_, P_, A_)
    assert {
        "catalog:availability": "CATALOG_AVAILABILITY", "catalog:price": "CATALOG_PRICE",
        "catalog:edit": "CATALOG_EDIT", "catalog:create": "CATALOG_CREATE",
    }.items() <= PERM.SCOPE_PERMISSIONS.items()


def test_a_saved_role_reads_the_four_writes_at_its_catalog_write_level():
    # A manager-based role saved with CATALOG_WRITE denied: nothing opens.
    eff = PERM.effective_permissions(role_states={"CATALOG_WRITE": D_}, template=PERM.MANAGER)
    assert {c: eff.states[c] for c in PERM.CATALOG_FINE_CODES} == dict.fromkeys(PERM.CATALOG_FINE_CODES, D_)
    assert eff.states["CATALOG_VIEW"] == A_
    # A cashier-based role saved with CATALOG_WRITE allowed: nothing locks.
    eff = PERM.effective_permissions(role_states={"CATALOG_WRITE": A_}, template=PERM.CASHIER)
    assert all(eff.states[c] == A_ for c in PERM.CATALOG_FINE_CODES)
    assert eff.sources["CATALOG_PRICE"] == "role"
    # An explicit value of its own wins over the derivation.
    eff = PERM.effective_permissions(role_states={"CATALOG_WRITE": A_, "CATALOG_PRICE": D_}, template=PERM.CASHIER)
    assert (eff.states["CATALOG_PRICE"], eff.states["CATALOG_EDIT"]) == (D_, A_)
    # A user's override of CATALOG_WRITE wins over the role's own values, as any override does.
    eff = PERM.effective_permissions(
        role_states={"CATALOG_PRICE": A_}, template=PERM.MANAGER, overrides={"states": {"CATALOG_WRITE": P_}},
    )
    assert eff.states["CATALOG_PRICE"] == P_ and eff.sources["CATALOG_PRICE"] == "override"
    # No CATALOG_WRITE of its own: the template's new defaults.
    eff = PERM.effective_permissions(role_states={}, template=PERM.CASHIER)
    assert (eff.states["CATALOG_AVAILABILITY"], eff.states["CATALOG_PRICE"]) == (P_, D_)


def test_the_derivation_does_not_rewrite_the_stored_role():
    from app.services import till_roles as S

    role = SimpleNamespace(
        id=uuid.uuid4(), company_id=uuid.uuid4(), builtin_key=None, base_key=PERM.CASHIER, name="בר",
        description=None, sort_order=1, permissions={"CATALOG_WRITE": A_}, limits={}, updated_at=None,
    )
    out = S.role_out(role)
    assert out["permissions"]["CATALOG_PRICE"] == A_
    assert out["own"]["permissions"] == {"CATALOG_WRITE": A_}
    assert role.permissions == {"CATALOG_WRITE": A_}


def test_the_legacy_senior_reading_ignores_the_new_codes():
    """An older till reads `role` only: a role is a shop manager there by the codes it always knew."""
    states = dict(PERM.DEFAULTS[PERM.LEGACY_MANAGER])
    for code in PERM.CATALOG_FINE_CODES:
        states[code] = D_
    assert PERM.legacy_role_for(states) == "shop_manager"


def test_the_elevation_scopes_parse_and_managers_may_hold_them():
    assert parse_scopes(["catalog:availability", "catalog:price", "catalog:edit", "catalog:create"]) == [
        Scope.CATALOG_AVAILABILITY, Scope.CATALOG_PRICE, Scope.CATALOG_EDIT, Scope.CATALOG_CREATE,
    ]
    assert CATALOG_WRITE_COVERS <= till_grantable_scopes(UserRole.SHOP_MANAGER)
    assert not (CATALOG_WRITE_COVERS & till_grantable_scopes(UserRole.SHIFT_SUPERVISOR))


class _Grant:
    def __init__(self, scopes, machine_id):
        self.id = uuid.uuid4()
        self.scopes = list(scopes)
        self.per_action_consumed_at = None
        self.machine_id = machine_id
        self.user_id = uuid.uuid4()
        self.pos_user_id = None


@pytest.mark.parametrize("scope", sorted(CATALOG_WRITE_COVERS, key=lambda s: s.value))
def test_a_legacy_catalog_write_grant_answers_for_all_four(monkeypatch, scope):
    machine = SimpleNamespace(id=uuid.uuid4(), shop_id=uuid.uuid4())
    grant = _Grant(["catalog:write"], machine.id)
    monkeypatch.setattr(A, "resolve_session", lambda *_a, **_k: grant)
    actor = A.require_catalog_authority(scope)(machine=machine, elevation_token="t", operator_id=None, db=None)
    assert actor.user_id == grant.user_id


def test_a_grant_for_one_catalog_scope_is_not_another(monkeypatch):
    machine = SimpleNamespace(id=uuid.uuid4(), shop_id=uuid.uuid4())
    grant = _Grant(["catalog:availability"], machine.id)
    monkeypatch.setattr(A, "resolve_session", lambda *_a, **_k: grant)
    gate = A.require_catalog_authority
    assert gate(Scope.CATALOG_AVAILABILITY)(machine=machine, elevation_token="t", operator_id=None, db=None)
    with pytest.raises(HTTPException) as exc:
        gate(Scope.CATALOG_PRICE)(machine=machine, elevation_token="t", operator_id=None, db=None)
    assert (exc.value.status_code, exc.value.detail) == (403, "elevation_missing_scope:catalog:price")
    # Nor does a new scope stand in for the old one (screen editing, printers, tables).
    with pytest.raises(HTTPException):
        gate(Scope.CATALOG_WRITE)(machine=machine, elevation_token="t", operator_id=None, db=None)
    # A catalog:write grant from another till is still refused.
    other = _Grant(["catalog:write"], uuid.uuid4())
    monkeypatch.setattr(A, "resolve_session", lambda *_a, **_k: other)
    with pytest.raises(HTTPException) as exc:
        gate(Scope.CATALOG_PRICE)(machine=machine, elevation_token="t", operator_id=None, db=None)
    assert exc.value.detail == "elevation_wrong_machine"


def _gate_scope(handler):
    dep = inspect.signature(handler).parameters["actor"].default.dependency
    assert dep.__qualname__.startswith("require_catalog_authority.")
    return inspect.getclosurevars(dep).nonlocals["scope"]


def test_each_till_catalog_endpoint_asks_for_its_own_scope():
    assert _gate_scope(sync_router.machine_create_cloud_product) == Scope.CATALOG_CREATE
    assert _gate_scope(sync_router.machine_create_cloud_category) == Scope.CATALOG_CREATE
    assert _gate_scope(sync_router.machine_update_cloud_category) == Scope.CATALOG_EDIT
    assert _gate_scope(sync_router.machine_upload_product_image) == Scope.CATALOG_EDIT
    assert _gate_scope(sync_router.machine_remove_product_image) == Scope.CATALOG_EDIT
    assert _gate_scope(sync_router.machine_set_product_availability) == Scope.CATALOG_AVAILABILITY
    assert _gate_scope(sync_router.machine_set_category_availability) == Scope.CATALOG_AVAILABILITY
    # Decided by the body.
    assert _gate_scope(sync_router.machine_update_cloud_product) is None
    # Screen editing and the till's own list stay CATALOG_WRITE.
    assert _gate_scope(sync_router.machine_set_product_order) == Scope.CATALOG_WRITE
    assert _gate_scope(sync_router.machine_set_own_catalog) == Scope.CATALOG_WRITE


def test_a_product_update_needs_exactly_what_it_changes():
    product = SimpleNamespace(price=Decimal("12.00"), name="cola", barcode="7290", category_id=uuid.uuid4())
    override = SimpleNamespace(price=None, is_available=None, is_listed=True)
    scopes = sync_router._product_update_scopes
    assert scopes(product, override, {"price": 13}) == [Scope.CATALOG_PRICE]
    assert scopes(product, override, {"is_available": False}) == [Scope.CATALOG_AVAILABILITY]
    assert scopes(product, override, {"name": "קולה"}) == [Scope.CATALOG_EDIT]
    assert scopes(product, override, {"kitchen_printers": {"set": []}}) == [Scope.CATALOG_EDIT]
    # The dialog sends everything back: unchanged fields ask for nothing.
    assert scopes(product, override, {"price": 12, "name": "cola", "barcode": "7290", "is_available": None}) == [
        Scope.CATALOG_EDIT
    ]
    assert scopes(product, override, {"price": "12.00", "name": "קולה"}) == [Scope.CATALOG_EDIT]
    assert scopes(product, override, {"price": 15, "name": "קולה", "is_available": True}) == [
        Scope.CATALOG_PRICE, Scope.CATALOG_AVAILABILITY, Scope.CATALOG_EDIT,
    ]
    # The shop's own price is the one compared.
    assert scopes(product, SimpleNamespace(price=Decimal("14"), is_available=None, is_listed=True), {"price": 14}) == [
        Scope.CATALOG_EDIT
    ]
    # A barcode "007" is not "7".
    assert scopes(SimpleNamespace(price=None, barcode="7"), override, {"barcode": "007"}) == [Scope.CATALOG_EDIT]


def _pos_user(w, role):
    pu = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username=f"u{uuid.uuid4().hex[:6]}",
        first_name="U", pin_hash="x", role=role, is_active=True,
    )
    w.db.add(pu)
    w.db.commit()
    return pu


def _update(w, operator, **body):
    authority = A.CatalogAuthority(db=w.db, machine=w.t1, elevation_token=None, operator_id=str(operator.id))
    return sync_router.machine_update_cloud_product(
        str(w.t1.id), str(w.cola.id), ProductUpdate.model_validate(body), machine=w.t1, actor=authority, db=w.db,
    )


def test_the_product_update_is_enforced_per_action(mw, monkeypatch):
    monkeypatch.setattr(sync_router, "notify_all_machines_for_tenant", lambda *a, **k: None)
    cashier, manager = _pos_user(mw, PosUserRole.CASHIER), _pos_user(mw, PosUserRole.SHOP_MANAGER)
    # A (legacy) cashier's own signature covers none of the writes: a manager's code is asked for.
    for body in ({"price": 99}, {"name": "קולה"}, {"isAvailable": False}):
        with pytest.raises(HTTPException) as exc:
            _update(mw, cashier, **body)
        assert exc.value.status_code == 401, body
    mw.db.rollback()
    assert mw.db.get(type(mw.cola), mw.cola.id).name == "cola"
    out = _update(mw, manager, price=13)
    assert out is not None


# ── §6.3 Menu clear ──────────────────────────────────────────────────────────


def test_clearing_a_levels_menus_leaves_the_others_and_is_logged(mw):
    bar_menu, shop_menu = create(mw, name="בר"), create(mw, name="סניף")
    assign(mw, "area", mw.bar, bar_menu, fallback="none")
    assign(mw, "shop", mw.shop, shop_menu)
    assert view(mw, mw.t1)["menuId"] == bar_menu["id"]

    out = R.clear_catalog_menu_assignments(BackgroundTasks(), level="area", target_id=mw.bar.id, **_ctx(mw))
    assert out == {"removed": 1, "fallbackRemoved": True}
    db = mw.db
    assert db.query(CatalogMenuAssignment).filter(CatalogMenuAssignment.level == "area").count() == 0
    assert db.query(CatalogMenuFallback).filter(CatalogMenuFallback.level == "area").count() == 0
    assert db.query(CatalogMenuAssignment).filter(CatalogMenuAssignment.level == "shop").count() == 1
    log = db.query(TillParameterChange).filter(TillParameterChange.parameter_key == "catalogMenus").one()
    assert (log.scope_type, log.action, log.new_value) == ("area", "clear", None)
    assert log.old_value == {"menus": [{"menuId": bar_menu["id"], "priority": 0}], "fallback": "none"}
    assert log.user_email == mw.admin.email
    # The till inherits: the point of sale has no menu now.
    assert view(mw, mw.t1)["scope"] == "shop"
    # Nothing left to clear: nothing logged.
    again = R.clear_catalog_menu_assignments(BackgroundTasks(), level="area", target_id=mw.bar.id, **_ctx(mw))
    assert again == {"removed": 0, "fallbackRemoved": False}
    assert db.query(TillParameterChange).filter(TillParameterChange.parameter_key == "catalogMenus").count() == 1


def test_clearing_needs_a_writer_who_manages_the_target(mw):
    shop_menu = create(mw, name="סניף")
    assign(mw, "shop", mw.shop, shop_menu)
    err = refused(R.clear_catalog_menu_assignments, BackgroundTasks(), level="shop", target_id=mw.shop.id, **_ctx(mw, mw.cashier))
    assert err.status_code == 403
    err = refused(R.clear_catalog_menu_assignments, BackgroundTasks(), level="shop", target_id=mw.shop.id, **_ctx(mw, mw.north_manager))
    assert err.status_code == 403
    err = refused(R.clear_catalog_menu_assignments, BackgroundTasks(), level="everywhere", target_id=mw.shop.id, **_ctx(mw))
    assert err.status_code == 422
    assert mw.db.query(CatalogMenuAssignment).count() == 1


# ── §6.3 Parameter reset ─────────────────────────────────────────────────────


def test_reset_clears_only_that_level_and_logs_each_value(mw):
    put_level(mw, "company", mw.company.id, catalogAdminScope="shop")
    put_level(mw, "area", mw.bar.id, catalogAdminScope="till", catalogCreateFromTill=False)
    before = mw.db.query(TillParameterChange).count()
    out = TPR.reset_till_parameters(
        TPR.ResetIn(level="area", id=mw.bar.id, keys=list(KEYS)), BackgroundTasks(), _admin=mw.admin, db=mw.db,
    )
    assert sorted(out["cleared"]) == ["catalogAdminScope", "catalogCreateFromTill"]
    rows = mw.db.query(TillParameterChange).order_by(TillParameterChange.created_at).all()[before:]
    assert {(r.parameter_key, r.scope_type, r.action, r.new_value) for r in rows} == {
        ("catalogAdminScope", "area", "clear", None), ("catalogCreateFromTill", "area", "clear", None),
    }
    assert mw.db.query(TillParameterValue).filter(TillParameterValue.scope_type == "area").count() == 0
    # The company's value stands; the till inherits it.
    assert params_of(mw, mw.t1)["catalogAdminScope"] == "shop"
    assert params_of(mw, mw.t1)["catalogCreateFromTill"] is True


def test_reset_refuses_unknown_keys_and_levels(mw):
    put_level(mw, "area", mw.bar.id, catalogAdminScope="till")
    with pytest.raises(HTTPException) as exc:
        TPR.reset_till_parameters(
            TPR.ResetIn(level="area", id=mw.bar.id, keys=["catalogAdminScope", "noSuchKey"]), BackgroundTasks(),
            _admin=mw.admin, db=mw.db,
        )
    assert exc.value.status_code == 422
    assert params_of(mw, mw.t1)["catalogAdminScope"] == "till"  # nothing cleared
    with pytest.raises(HTTPException) as exc:
        TPR.reset_till_parameters(
            TPR.ResetIn(level="shop", id=uuid.uuid4(), keys=["catalogAdminScope"]), BackgroundTasks(),
            _admin=mw.admin, db=mw.db,
        )
    assert exc.value.status_code == 404
