"""A voucher scanned over a cart applied at once — the owner's addition of 12.10.2026
("מימוש אוטומטי בסריקת שובר").

`voucherAutoApply` ("on" | "off", unset = "on": a production voucher scanned on the till with items
already in the cart is applied at once to the matching cart lines, with no redeem sheet and no
"מימוש" press, when no choice is needed; "off" opens the redeem sheet as before): a flat key set at
every level (tenant, company, shop, point of sale, till) and merged like `voucherShowEntitlement`;
always sent to the till resolved; a value outside the enum is a 422; `null` resets a layer; each
change is logged with its level; the dashboard's preview has the inherited value and its source.

Mock-based like tests/test_voucher_show_entitlement_settings.py.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.models.till_parameter import TillParameterChange
from app.models.user import UserRole
from app.routers.settings import get_machine_settings, get_shop_settings, patch_company_settings
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers, patch_to_camel_dict
from app.services.voucher_redeem_settings import _audited_keys
from app.services.voucher_station_settings import (
    AUTO_APPLY_VALUES,
    DEFAULT_AUTO_APPLY,
    VOUCHER_AUTO_APPLY_KEY,
    VOUCHER_AUTO_APPLY_SETTING_KEYS,
    resolve_auto_apply,
    resolve_show_entitlement,
    resolve_station_paid_items,
    resolve_voucher_sounds,
    resolve_voucher_station,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

AUTO = "voucherAutoApply"


def _audit_rows(db):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], TillParameterChange)]


def _patch_company(company, db, body):
    with patch("app.routers.settings._check_company_access"), patch(
        "app.routers.settings._check_company_settings_write"
    ), patch("app.routers.settings.notify_machines_for_company_settings"):
        return patch_company_settings(
            company_id=str(company.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.COMPANY_MANAGER),
            active_tenant_id=company.tenant_id,
            db=db,
        )


def _auto(merged) -> str:
    return resolve_auto_apply(merged)[AUTO]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_key_its_values_and_default_are_the_contract_with_the_till() -> None:
    assert VOUCHER_AUTO_APPLY_KEY == AUTO
    assert VOUCHER_AUTO_APPLY_SETTING_KEYS == (AUTO,)
    assert AUTO_APPLY_VALUES == ("on", "off") and DEFAULT_AUTO_APPLY == "on"
    assert AUTO in MANAGED_SETTING_KEYS  # merged per layer and synced
    assert AUTO in _audited_keys()  # every change is logged


@pytest.mark.parametrize("junk", ["ON", "Off", "true", "", 1, 0, True, False, None, [], {}])
def test_unset_or_unknown_is_on(junk) -> None:
    assert resolve_auto_apply({}) == {AUTO: "on"}
    assert resolve_auto_apply({AUTO: junk}) == {AUTO: "on"}


@pytest.mark.parametrize("value", ["off", "on"])
def test_a_known_value_resolves_to_itself(value) -> None:
    assert resolve_auto_apply({AUTO: value}) == {AUTO: value}


def test_it_stands_apart_from_the_other_voucher_keys() -> None:
    assert AUTO not in resolve_voucher_station({AUTO: "off"})
    assert AUTO not in resolve_station_paid_items({AUTO: "off"})
    assert AUTO not in resolve_show_entitlement({AUTO: "off"})
    assert AUTO not in resolve_voucher_sounds({AUTO: "off"})
    merged = {AUTO: "off"}
    resolve_auto_apply(merged)
    assert merged == {AUTO: "off"}  # a view: nothing written back


# ── Validation: 422 outside the enum ─────────────────────────────────────────


@pytest.mark.parametrize("value", ["off", "on"])
def test_the_patch_takes_each_value(value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({AUTO: value})) == {AUTO: value}


@pytest.mark.parametrize("bad", ["ON", "yes", "true", "", 1, True, ["on"], {"v": "on"}])
def test_a_value_outside_the_enum_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({AUTO: bad})


@pytest.mark.parametrize(
    "path",
    ["/tenants/t1/settings", "/companies/c1/settings", "/shops/s1/settings", "/areas/a1/settings", "/machines/m1/settings"],
)
def test_every_levels_endpoint_answers_422_for_a_value_outside_the_enum(path) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
    from app.routers import settings as S

    app = FastAPI()
    app.include_router(S.router)
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_user] = lambda: _user(UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_current_machine_admin] = lambda: _user(UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_active_tenant_id] = lambda: None
    client = TestClient(app)
    assert client.patch(path, json={AUTO: "yes"}).status_code == 422


# ── Every level: set, inherit, reset; the sync payload ───────────────────────


def test_sync_sends_on_when_nothing_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    assert _sync(machine, db, area).settings[AUTO] == "on"


@pytest.mark.parametrize("level", range(5))
def test_off_at_any_one_level_reaches_the_till(level) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = {AUTO: "off"}
    _, _, _, area, machine, db = _world(*layers)
    assert _sync(machine, db, area).settings[AUTO] == "off"


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    cases = [
        (({AUTO: "off"}, {}, {}, {}, {}), "off"),  # the tenant's
        (({AUTO: "off"}, {AUTO: "on"}, {}, {}, {}), "on"),  # the company's over the tenant's
        (({}, {AUTO: "on"}, {AUTO: "off"}, {}, {}), "off"),  # the shop's
        (({}, {}, {AUTO: "off"}, {AUTO: "on"}, {}), "on"),  # the point of sale's
        (({AUTO: "on"}, {}, {AUTO: "on"}, {AUTO: "on"}, {AUTO: "off"}), "off"),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        assert _sync(machine, db, area).settings[AUTO] == expected, layers


@pytest.mark.parametrize("junk", ["maybe", "ON", "", 1, True, None])
def test_sync_sends_a_junk_value_as_on(junk) -> None:
    _, _, _, area, machine, db = _world({}, {}, {AUTO: junk})
    assert _sync(machine, db, area).settings[AUTO] == "on"


def test_every_level_takes_and_resets_it() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {AUTO: "off"})
    _patch_company(company, db, {AUTO: "on"})
    _patch_shop(shop, db, {AUTO: "off"})
    _patch_area(area, shop, db, {AUTO: "on"})
    _patch_machine(machine, area, db, {AUTO: "off"})
    layers = (tenant, company, shop, area, machine)
    assert [e.settings for e in layers] == [{AUTO: v} for v in ("off", "on", "off", "on", "off")]
    assert _auto(merge_all_settings_layers(company, shop, tenant, machine, area)) == "off"  # the till's
    _patch_machine(machine, area, db, {AUTO: None})
    assert machine.settings == {}
    assert _auto(merge_all_settings_layers(company, shop, tenant, machine, area)) == "on"  # the point of sale's
    _patch_area(area, shop, db, {AUTO: None})
    _patch_shop(shop, db, {AUTO: None})
    _patch_company(company, db, {AUTO: None})
    assert _sync(machine, db, area).settings[AUTO] == "off"  # back to the tenant's
    _patch_tenant(tenant, db, {AUTO: None})
    assert tenant.settings == {}
    assert _sync(machine, db, area).settings[AUTO] == "on"  # the default


def test_a_patch_of_it_leaves_the_other_voucher_keys_alone() -> None:
    _, _, shop, _, _, db = _world({}, {}, {"voucherShowEntitlement": "off"})
    _patch_shop(shop, db, {AUTO: "off"})
    assert shop.settings == {"voucherShowEntitlement": "off", AUTO: "off"}
    _patch_shop(shop, db, {AUTO: None})
    assert shop.settings == {"voucherShowEntitlement": "off"}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_shops_preview_shows_the_effective_value_and_its_source() -> None:
    _, _, shop, _, _, db = _world({AUTO: "on"}, {AUTO: "off"}, {AUTO: "on"})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[AUTO], res.effective_sources[AUTO]) == ("off", "company")  # not its own value
    assert res.settings == {AUTO: "on"}  # its own layer, raw


def test_a_tills_preview_shows_the_default_when_no_level_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert res.effective[AUTO] == "on"
    assert AUTO not in (res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {}, {AUTO: "off"})
    _patch_tenant(tenant, db, {AUTO: "off"})
    _patch_company(company, db, {AUTO: "on"})
    _patch_shop(shop, db, {AUTO: "off"})
    _patch_area(area, shop, db, {AUTO: "on"})
    _patch_machine(machine, area, db, {AUTO: None})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (AUTO, "tenant", "set", None, "off"),
        (AUTO, "company", "set", None, "on"),
        (AUTO, "shop", "set", None, "off"),
        (AUTO, "area", "set", None, "on"),
        (AUTO, "machine", "clear", "off", None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, shop, area, machine)]


def test_an_unchanged_value_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {AUTO: "off"})
    _patch_shop(shop, db, {AUTO: "off"})
    assert _audit_rows(db) == []
    _patch_shop(shop, db, {AUTO: "on"})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.action, r.old_value, r.new_value) for r in rows] == [(AUTO, "set", "off", "on")]
