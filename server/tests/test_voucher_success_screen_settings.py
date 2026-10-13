"""The green success screen after a voucher redemption — the owner's addition of 12.10.2026.

`voucherSuccessScreen` ("always" | "auto_close" | "off", unset = "always": "מסך הצלחה במימוש שובר" — a
large green screen after every sale that redeemed a voucher, only when the voucher closed the sale by
itself, or never) and `voucherSuccessSeconds` (an integer 1–10, unset = 3: "משך מסך ההצלחה (שניות)"):
flat keys set at every level (tenant, company, shop, point of sale, till) and merged like
`voucherAutoApply`; always sent to the till resolved (the seconds as an int); a value outside the enum
or the range is a 422; `null` resets a layer; each change is logged with its level; the dashboard's
preview has the inherited value and its source.

Mock-based like tests/test_voucher_auto_apply_settings.py.
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
    DEFAULT_SUCCESS_SCREEN,
    DEFAULT_SUCCESS_SECONDS,
    SUCCESS_SCREEN_VALUES,
    SUCCESS_SECONDS_MAX,
    SUCCESS_SECONDS_MIN,
    VOUCHER_SUCCESS_SCREEN_KEY,
    VOUCHER_SUCCESS_SECONDS_KEY,
    VOUCHER_SUCCESS_SETTING_KEYS,
    resolve_auto_apply,
    resolve_show_entitlement,
    resolve_voucher_sounds,
    resolve_voucher_station,
    resolve_voucher_success,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

SCREEN = "voucherSuccessScreen"
SECS = "voucherSuccessSeconds"


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


def _resolved(merged):
    r = resolve_voucher_success(merged)
    return r[SCREEN], r[SECS]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_keys_their_values_and_defaults_are_the_contract_with_the_till() -> None:
    assert (VOUCHER_SUCCESS_SCREEN_KEY, VOUCHER_SUCCESS_SECONDS_KEY) == (SCREEN, SECS)
    assert VOUCHER_SUCCESS_SETTING_KEYS == (SCREEN, SECS)
    assert SUCCESS_SCREEN_VALUES == ("always", "auto_close", "off") and DEFAULT_SUCCESS_SCREEN == "always"
    assert (SUCCESS_SECONDS_MIN, SUCCESS_SECONDS_MAX, DEFAULT_SUCCESS_SECONDS) == (1, 10, 3)
    for key in (SCREEN, SECS):
        assert key in MANAGED_SETTING_KEYS  # merged per layer and synced
        assert key in _audited_keys()  # every change is logged


def test_unset_is_always_for_3_seconds() -> None:
    assert resolve_voucher_success({}) == {SCREEN: "always", SECS: 3}


@pytest.mark.parametrize("junk", ["ALWAYS", "Off", "on", "auto-close", "", 1, 0, True, False, None, [], {}])
def test_an_unknown_screen_is_always(junk) -> None:
    assert _resolved({SCREEN: junk}) == ("always", 3)


@pytest.mark.parametrize("value", ["always", "auto_close", "off"])
def test_a_known_screen_resolves_to_itself(value) -> None:
    assert _resolved({SCREEN: value}) == (value, 3)


@pytest.mark.parametrize("junk", [0, 11, -1, 100, 3.0, 2.5, "5", "", True, False, None, [], {}])
def test_junk_out_of_range_or_non_integer_seconds_are_3(junk) -> None:
    assert _resolved({SECS: junk}) == ("always", 3)


@pytest.mark.parametrize("value", range(1, 11))
def test_every_second_in_range_resolves_to_itself_as_an_int(value) -> None:
    secs = _resolved({SECS: value})[1]
    assert secs == value and type(secs) is int


def test_they_stand_apart_from_the_other_voucher_keys() -> None:
    merged = {SCREEN: "off", SECS: 7}
    for other in (resolve_voucher_station, resolve_show_entitlement, resolve_auto_apply, resolve_voucher_sounds):
        assert SCREEN not in other(merged) and SECS not in other(merged)
    resolve_voucher_success(merged)
    assert merged == {SCREEN: "off", SECS: 7}  # a view: nothing written back


# ── Validation: 422 outside the enum / the range ─────────────────────────────


@pytest.mark.parametrize("value", ["always", "auto_close", "off"])
def test_the_patch_takes_each_screen(value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({SCREEN: value})) == {SCREEN: value}


@pytest.mark.parametrize("value", [1, 3, 10])
def test_the_patch_takes_seconds_in_range(value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({SECS: value})) == {SECS: value}


@pytest.mark.parametrize("bad", ["ALWAYS", "on", "auto-close", "", 1, True, ["off"], {"v": "off"}])
def test_a_screen_outside_the_enum_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({SCREEN: bad})


@pytest.mark.parametrize("bad", [0, 11, -3, 2.5, "abc", [3], {"v": 3}])
def test_seconds_outside_the_range_or_not_an_integer_are_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({SECS: bad})


@pytest.mark.parametrize(
    "path",
    ["/tenants/t1/settings", "/companies/c1/settings", "/shops/s1/settings", "/areas/a1/settings", "/machines/m1/settings"],
)
@pytest.mark.parametrize("body", [{SCREEN: "sometimes"}, {SECS: 0}, {SECS: 11}])
def test_every_levels_endpoint_answers_422_for_a_value_outside_the_rules(path, body) -> None:
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
    assert client.patch(path, json=body).status_code == 422


# ── Every level: set, inherit, reset; the sync payload ───────────────────────


def test_sync_sends_the_defaults_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    settings = _sync(machine, db, area).settings
    assert (settings[SCREEN], settings[SECS]) == ("always", 3)
    assert type(settings[SECS]) is int


@pytest.mark.parametrize("level", range(5))
def test_a_value_at_any_one_level_reaches_the_till(level) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = {SCREEN: "auto_close", SECS: 8}
    _, _, _, area, machine, db = _world(*layers)
    settings = _sync(machine, db, area).settings
    assert (settings[SCREEN], settings[SECS]) == ("auto_close", 8)


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    cases = [
        (({SCREEN: "off", SECS: 5}, {}, {}, {}, {}), ("off", 5)),  # the tenant's
        (({SCREEN: "off", SECS: 5}, {SCREEN: "auto_close"}, {}, {}, {}), ("auto_close", 5)),  # the company's
        (({}, {SCREEN: "always"}, {SCREEN: "off", SECS: 1}, {}, {}), ("off", 1)),  # the shop's
        (({}, {}, {SCREEN: "off", SECS: 1}, {SCREEN: "always", SECS: 10}, {}), ("always", 10)),  # the point of sale's
        (({SECS: 2}, {}, {SECS: 4}, {SECS: 6}, {SCREEN: "auto_close", SECS: 9}), ("auto_close", 9)),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        settings = _sync(machine, db, area).settings
        assert (settings[SCREEN], settings[SECS]) == expected, layers


@pytest.mark.parametrize(
    "junk", [{SCREEN: "maybe"}, {SECS: 0}, {SECS: 11}, {SECS: "5"}, {SECS: 2.5}, {SECS: True}, {SCREEN: None, SECS: None}]
)
def test_sync_sends_a_junk_value_as_the_default(junk) -> None:
    _, _, _, area, machine, db = _world({}, {}, junk)
    settings = _sync(machine, db, area).settings
    assert (settings[SCREEN], settings[SECS]) == ("always", 3)


def test_every_level_takes_and_resets_them() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {SCREEN: "off", SECS: 2})
    _patch_company(company, db, {SCREEN: "auto_close", SECS: 4})
    _patch_shop(shop, db, {SCREEN: "off", SECS: 6})
    _patch_area(area, shop, db, {SCREEN: "always", SECS: 8})
    _patch_machine(machine, area, db, {SCREEN: "auto_close", SECS: 10})
    layers = (tenant, company, shop, area, machine)
    assert [e.settings for e in layers] == [
        {SCREEN: s, SECS: n} for s, n in (("off", 2), ("auto_close", 4), ("off", 6), ("always", 8), ("auto_close", 10))
    ]
    assert _resolved(merge_all_settings_layers(company, shop, tenant, machine, area)) == ("auto_close", 10)  # the till's
    _patch_machine(machine, area, db, {SCREEN: None, SECS: None})
    assert machine.settings == {}
    assert _resolved(merge_all_settings_layers(company, shop, tenant, machine, area)) == ("always", 8)  # the point of sale's
    _patch_area(area, shop, db, {SCREEN: None, SECS: None})
    _patch_shop(shop, db, {SCREEN: None, SECS: None})
    _patch_company(company, db, {SCREEN: None, SECS: None})
    settings = _sync(machine, db, area).settings
    assert (settings[SCREEN], settings[SECS]) == ("off", 2)  # back to the tenant's
    _patch_tenant(tenant, db, {SCREEN: None, SECS: None})
    assert tenant.settings == {}
    settings = _sync(machine, db, area).settings
    assert (settings[SCREEN], settings[SECS]) == ("always", 3)  # the defaults


def test_a_patch_of_one_leaves_the_other_alone() -> None:
    _, _, shop, _, _, db = _world({}, {}, {SCREEN: "off", "voucherAutoApply": "off"})
    _patch_shop(shop, db, {SECS: 5})
    assert shop.settings == {SCREEN: "off", "voucherAutoApply": "off", SECS: 5}
    _patch_shop(shop, db, {SCREEN: None})
    assert shop.settings == {"voucherAutoApply": "off", SECS: 5}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_shops_preview_shows_the_effective_values_and_their_source() -> None:
    _, _, shop, _, _, db = _world({SCREEN: "off", SECS: 2}, {SCREEN: "auto_close"}, {SCREEN: "always", SECS: 9})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[SCREEN], res.effective_sources[SCREEN]) == ("auto_close", "company")  # not its own value
    assert (res.effective[SECS], res.effective_sources[SECS]) == (2, "tenant")
    assert res.settings == {SCREEN: "always", SECS: 9}  # its own layer, raw


def test_a_tills_preview_shows_the_defaults_when_no_level_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert (res.effective[SCREEN], res.effective[SECS]) == ("always", 3)
    assert SCREEN not in (res.effective_sources or {}) and SECS not in (res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {}, {SCREEN: "off", SECS: 7})
    _patch_tenant(tenant, db, {SCREEN: "off"})
    _patch_company(company, db, {SECS: 4})
    _patch_shop(shop, db, {SCREEN: "auto_close"})
    _patch_area(area, shop, db, {SECS: 10})
    _patch_machine(machine, area, db, {SCREEN: None, SECS: None})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (SCREEN, "tenant", "set", None, "off"),
        (SECS, "company", "set", None, 4),
        (SCREEN, "shop", "set", None, "auto_close"),
        (SECS, "area", "set", None, 10),
        (SCREEN, "machine", "clear", "off", None),
        (SECS, "machine", "clear", 7, None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, shop, area, machine, machine)]


def test_an_unchanged_value_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {SCREEN: "off", SECS: 5})
    _patch_shop(shop, db, {SCREEN: "off", SECS: 5})
    assert _audit_rows(db) == []
    _patch_shop(shop, db, {SECS: 6})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.action, r.old_value, r.new_value) for r in rows] == [(SECS, "set", 5, 6)]
