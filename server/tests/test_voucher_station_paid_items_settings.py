"""Items paid for at the station — the owner's addition of 12.10.2026
(P:/specs/voucher-station-and-autoclose.md §5).

`voucherStationPaidItems` ("off" | "on", unset = "off": the station redeems vouchers only): a flat key
set at every level (tenant, company, shop, point of sale, till) and merged like `voucherStation`; always
sent to the till resolved; a value outside the enum is a 422 at every level; `null` resets a layer;
each change is logged with its level; the dashboard's preview has the inherited value and its source.

Mock-based like tests/test_voucher_station_settings.py.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.models.till_parameter import TillParameterChange
from app.models.user import UserRole
from app.routers.settings import (
    get_area_settings,
    get_company_settings,
    get_machine_settings,
    get_shop_settings,
    patch_company_settings,
)
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.payment_options import PAYMENT_OPTIONS
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers, patch_to_camel_dict
from app.services.voucher_redeem_settings import _audited_keys
from app.services.voucher_station_settings import (
    DEFAULT_STATION_PAID_ITEMS,
    STATION_PAID_ITEMS_VALUES,
    VOUCHER_STATION_PAID_ITEMS_KEY,
    VOUCHER_STATION_PAID_ITEMS_SETTING_KEYS,
    resolve_station_paid_items,
    resolve_voucher_station,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

PAID = "voucherStationPaidItems"
STATION = "voucherStation"


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


def _paid(merged) -> str:
    return resolve_station_paid_items(merged)[PAID]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_key_its_values_and_default_are_the_contract_with_the_till() -> None:
    assert VOUCHER_STATION_PAID_ITEMS_KEY == PAID
    assert VOUCHER_STATION_PAID_ITEMS_SETTING_KEYS == (PAID,)
    assert STATION_PAID_ITEMS_VALUES == ("off", "on") and DEFAULT_STATION_PAID_ITEMS == "off"
    assert PAID in MANAGED_SETTING_KEYS  # merged per layer and synced
    assert PAID in _audited_keys()  # every change is logged


@pytest.mark.parametrize("junk", ["ON", "Off", "true", "", 1, 0, True, False, None, [], {}])
def test_unset_or_unknown_is_off(junk) -> None:
    assert resolve_station_paid_items({}) == {PAID: "off"}
    assert resolve_station_paid_items({PAID: junk}) == {PAID: "off"}


@pytest.mark.parametrize("value", ["off", "on"])
def test_a_known_value_resolves_to_itself(value) -> None:
    assert resolve_station_paid_items({PAID: value}) == {PAID: value}


def test_it_stands_apart_from_the_station_switch() -> None:
    # The station's own resolver keeps its two keys; the paid items have their own.
    assert PAID not in resolve_voucher_station({PAID: "on"})
    assert resolve_station_paid_items({STATION: "on"}) == {PAID: "off"}
    merged = {PAID: "on"}
    resolve_station_paid_items(merged)
    assert merged == {PAID: "on"}  # a view: nothing written back


# ── Validation: 422 outside the enum ─────────────────────────────────────────


@pytest.mark.parametrize("value", ["off", "on"])
def test_the_patch_takes_each_value(value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({PAID: value})) == {PAID: value}


def test_the_patch_leaves_it_unset_when_not_sent() -> None:
    assert PAID not in PosSettingsV1Patch.model_validate({STATION: "on"}).model_dump(exclude_unset=True, by_alias=True)


@pytest.mark.parametrize("bad", ["ON", "yes", "true", "", 1, True, ["on"], {"v": "on"}])
def test_a_value_outside_the_enum_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({PAID: bad})


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
    assert client.patch(path, json={PAID: "yes"}).status_code == 422
    assert client.patch(path, json={PAID: "ON"}).status_code == 422


# ── Every level: set, inherit, reset ─────────────────────────────────────────


def test_each_level_sets_it_on_its_own_layer() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {PAID: "on"})
    _patch_company(company, db, {PAID: "off"})
    _patch_shop(shop, db, {PAID: "on"})
    _patch_area(area, shop, db, {PAID: "off"})
    _patch_machine(machine, area, db, {PAID: "on"})
    layers = (tenant, company, shop, area, machine)
    assert [e.settings for e in layers] == [{PAID: v} for v in ("on", "off", "on", "off", "on")]


@pytest.mark.parametrize("level", range(5))
@pytest.mark.parametrize("value", ["on", "off"])
def test_a_value_at_any_one_level_reaches_the_till(level, value) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = {PAID: value}
    _, _, _, area, machine, db = _world(*layers)
    assert _sync(machine, db, area).settings[PAID] == value


def test_sync_sends_it_resolved_when_nothing_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    assert _sync(machine, db, area).settings[PAID] == "off"


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    cases = [
        (({PAID: "on"}, {}, {}, {}, {}), "on"),  # the tenant's
        (({PAID: "on"}, {PAID: "off"}, {}, {}, {}), "off"),  # the company's over the tenant's
        (({}, {PAID: "off"}, {PAID: "on"}, {}, {}), "on"),  # the shop's
        (({}, {}, {PAID: "on"}, {PAID: "off"}, {}), "off"),  # the point of sale's
        (({PAID: "off"}, {}, {PAID: "off"}, {PAID: "off"}, {PAID: "on"}), "on"),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        assert _sync(machine, db, area).settings[PAID] == expected, layers


def test_sync_sends_a_junk_value_as_off() -> None:
    _, _, _, area, machine, db = _world({}, {}, {PAID: "maybe"})
    assert _sync(machine, db, area).settings[PAID] == "off"


def test_sync_sends_on_even_when_no_payment_option_is_left() -> None:
    # The till decides from pay*Enabled (also sent) to show no button; the key itself is the owner's.
    all_off = {o.allowed_key: False for o in PAYMENT_OPTIONS}
    _, _, _, area, machine, db = _world({}, {}, {**all_off, "payVoucherEnabled": True}, {}, {PAID: "on", STATION: "on"})
    settings = _sync(machine, db, area).settings
    assert (settings[PAID], settings[STATION]) == ("on", "on")
    assert not any(settings[o.allowed_key] for o in PAYMENT_OPTIONS)


def test_every_level_takes_and_resets_it() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {PAID: "on"})
    _patch_shop(shop, db, {PAID: "off"})
    _patch_area(area, shop, db, {PAID: "on"})
    _patch_machine(machine, area, db, {PAID: "off"})
    assert _paid(merge_all_settings_layers(company, shop, tenant, machine, area)) == "off"  # the till's
    _patch_machine(machine, area, db, {PAID: None})
    assert machine.settings == {}
    assert _paid(merge_all_settings_layers(company, shop, tenant, machine, area)) == "on"  # the point of sale's
    _patch_area(area, shop, db, {PAID: None})
    assert area.settings == {}
    assert _paid(merge_all_settings_layers(company, shop, tenant, machine, area)) == "off"  # the shop's
    _patch_shop(shop, db, {PAID: None})
    assert shop.settings == {}
    assert _sync(machine, db, area).settings[PAID] == "on"  # back to the tenant's
    _patch_tenant(tenant, db, {PAID: None})
    assert tenant.settings == {}
    assert _sync(machine, db, area).settings[PAID] == "off"  # the default


def test_the_company_level_resets_too() -> None:
    _, company, _, area, machine, db = _world({PAID: "off"}, {PAID: "on"})
    assert _sync(machine, db, area).settings[PAID] == "on"
    _patch_company(company, db, {PAID: None})
    assert company.settings == {}
    assert _sync(machine, db, area).settings[PAID] == "off"


def test_the_payment_rule_is_untouched_by_the_key() -> None:
    _, _, shop, _, _, db = _world()
    res = _patch_shop(shop, db, {PAID: "on"})
    assert res.settings == {PAID: "on"}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_companys_preview_shows_the_tenants_value() -> None:
    _, company, _, _, _, db = _world({PAID: "on"})
    with patch("app.routers.settings._check_company_access"), patch(
        "app.routers.settings.voucher_balance.has_active_for_company", return_value=False
    ):
        res = get_company_settings(
            company_id=str(company.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=company.tenant_id, db=db,
        )
    assert (res.effective[PAID], res.effective_sources[PAID]) == ("on", "tenant")


def test_a_shops_preview_shows_the_effective_value_and_its_source() -> None:
    _, _, shop, _, _, db = _world({PAID: "off"}, {PAID: "on"}, {PAID: "off"})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[PAID], res.effective_sources[PAID]) == ("on", "company")  # not its own value
    assert res.settings == {PAID: "off"}  # its own layer, raw


def test_a_point_of_sales_preview_shows_the_shops_value() -> None:
    _, _, shop, area, _, db = _world({}, {}, {PAID: "on"})
    with patch("app.routers.settings.get_area", return_value=area), patch("app.routers.settings._check_shop_access"):
        res = get_area_settings(
            area_id=str(area.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=area.tenant_id, db=db,
        )
    assert (res.effective[PAID], res.effective_sources[PAID]) == ("on", "shop")


def test_a_tills_preview_shows_the_point_of_sales_value() -> None:
    _, _, _, area, machine, db = _world({}, {PAID: "off"}, {}, {PAID: "on"}, {PAID: "off"})
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert (res.effective[PAID], res.effective_sources[PAID]) == ("on", "area")
    assert res.settings == {PAID: "off"}


def test_a_tills_preview_shows_the_default_when_no_level_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert res.effective[PAID] == "off"
    assert PAID not in (res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {}, {PAID: "on"})
    _patch_tenant(tenant, db, {PAID: "on"})
    _patch_company(company, db, {PAID: "off"})
    _patch_shop(shop, db, {PAID: "on"})
    _patch_area(area, shop, db, {PAID: "off"})
    _patch_machine(machine, area, db, {PAID: None})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (PAID, "tenant", "set", None, "on"),
        (PAID, "company", "set", None, "off"),
        (PAID, "shop", "set", None, "on"),
        (PAID, "area", "set", None, "off"),
        (PAID, "machine", "clear", "on", None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, shop, area, machine)]


def test_a_change_from_one_value_to_the_other_is_logged_and_an_unchanged_one_is_not() -> None:
    _, _, shop, _, _, db = _world({}, {}, {PAID: "off"})
    _patch_shop(shop, db, {PAID: "off"})
    assert _audit_rows(db) == []
    _patch_shop(shop, db, {PAID: "on"})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.action, r.old_value, r.new_value) for r in rows] == [(PAID, "set", "off", "on")]
