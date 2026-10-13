"""How the green "שובר מומש" screen closes — the owner's decision of 13.10.2026 (P:/specs/voucher-fast-mode.md
§0 item 11, "פיצ'ר דינמי").

`voucherSuccessDismiss` ("auto" | "confirm", unset = "auto": "סגירת מסך 'שובר מומש'" — by itself after
`voucherSuccessSeconds` or on a touch, or only on the cashier's "אישור", a new scan counting as that press):
a flat key set at every level (tenant, company, shop, point of sale, till) and merged like
`voucherSuccessScreen`; always sent to the till resolved; a value outside the enum is a 422; `null` resets a
layer; each change is logged with its level; the dashboard's preview has the inherited value and its source.

Mock-based like tests/test_voucher_success_screen_settings.py.
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
    DEFAULT_SUCCESS_DISMISS,
    SUCCESS_DISMISS_VALUES,
    VOUCHER_SUCCESS_DISMISS_KEY,
    VOUCHER_SUCCESS_DISMISS_SETTING_KEYS,
    resolve_auto_apply,
    resolve_show_entitlement,
    resolve_station_paid_items,
    resolve_voucher_fast_mode,
    resolve_voucher_sounds,
    resolve_voucher_station,
    resolve_voucher_success,
    resolve_voucher_success_dismiss,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

DISMISS = "voucherSuccessDismiss"
SCREEN = "voucherSuccessScreen"
SECS = "voucherSuccessSeconds"
LEVEL_PATHS = ["/tenants/t1/settings", "/companies/c1/settings", "/shops/s1/settings", "/areas/a1/settings", "/machines/m1/settings"]


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


def _resolved(merged) -> str:
    return resolve_voucher_success_dismiss(merged)[DISMISS]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_key_its_values_and_default_are_the_contract_with_the_till() -> None:
    assert VOUCHER_SUCCESS_DISMISS_KEY == DISMISS
    assert VOUCHER_SUCCESS_DISMISS_SETTING_KEYS == (DISMISS,)
    assert SUCCESS_DISMISS_VALUES == ("auto", "confirm") and DEFAULT_SUCCESS_DISMISS == "auto"
    assert DISMISS in MANAGED_SETTING_KEYS  # merged per layer and synced
    assert DISMISS in _audited_keys()  # every change is logged


def test_unset_is_auto() -> None:
    assert resolve_voucher_success_dismiss({}) == {DISMISS: "auto"}


@pytest.mark.parametrize("value", ["auto", "confirm"])
def test_a_known_value_resolves_to_itself(value) -> None:
    assert _resolved({DISMISS: value}) == value


@pytest.mark.parametrize("junk", ["AUTO", "Confirm", " confirm", "on", "off", "tap", "", 1, 0, True, False, None, [], {}])
def test_an_unknown_value_is_auto(junk) -> None:
    assert _resolved({DISMISS: junk}) == "auto"


def test_it_stands_apart_from_the_other_voucher_keys() -> None:
    merged = {DISMISS: "confirm", SCREEN: "off", SECS: 9}
    for other in (
        resolve_voucher_station, resolve_station_paid_items, resolve_show_entitlement, resolve_auto_apply,
        resolve_voucher_success, resolve_voucher_sounds, resolve_voucher_fast_mode,
    ):
        assert DISMISS not in other(merged)
    assert resolve_voucher_success(merged) == {SCREEN: "off", SECS: 9}  # the screen and its seconds as they were
    assert resolve_voucher_success_dismiss(merged) == {DISMISS: "confirm"}
    assert merged == {DISMISS: "confirm", SCREEN: "off", SECS: 9}  # a view: nothing written back


# ── Validation: 422 outside the enum ─────────────────────────────────────────


@pytest.mark.parametrize("value", ["auto", "confirm"])
def test_the_patch_takes_each_value(value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({DISMISS: value})) == {DISMISS: value}


@pytest.mark.parametrize("bad", ["AUTO", "confirmed", "tap", "on", "", 1, True, ["auto"], {"v": "auto"}])
def test_a_value_outside_the_enum_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({DISMISS: bad})


@pytest.mark.parametrize("path", LEVEL_PATHS)
@pytest.mark.parametrize("bad", ["manual", "CONFIRM", 3])
def test_every_levels_endpoint_answers_422_for_an_unknown_value(path, bad) -> None:
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
    assert TestClient(app).patch(path, json={DISMISS: bad}).status_code == 422


# ── Every level: set, inherit, reset; the sync payload ───────────────────────


def test_sync_sends_auto_when_nothing_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    assert _sync(machine, db, area).settings[DISMISS] == "auto"


@pytest.mark.parametrize("level", range(5))
def test_confirm_at_any_one_level_reaches_the_till(level) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = {DISMISS: "confirm"}
    _, _, _, area, machine, db = _world(*layers)
    assert _sync(machine, db, area).settings[DISMISS] == "confirm"


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    cases = [
        (({DISMISS: "confirm"}, {}, {}, {}, {}), "confirm"),  # the tenant's
        (({DISMISS: "confirm"}, {DISMISS: "auto"}, {}, {}, {}), "auto"),  # the company's
        (({}, {DISMISS: "auto"}, {DISMISS: "confirm"}, {}, {}), "confirm"),  # the shop's
        (({}, {}, {DISMISS: "confirm"}, {DISMISS: "auto"}, {}), "auto"),  # the point of sale's
        (({DISMISS: "auto"}, {}, {DISMISS: "auto"}, {DISMISS: "auto"}, {DISMISS: "confirm"}), "confirm"),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        assert _sync(machine, db, area).settings[DISMISS] == expected, layers


@pytest.mark.parametrize("junk", [{DISMISS: "manual"}, {DISMISS: True}, {DISMISS: None}, {DISMISS: ["confirm"]}])
def test_sync_sends_a_junk_value_as_auto(junk) -> None:
    _, _, _, area, machine, db = _world({}, {}, junk)
    assert _sync(machine, db, area).settings[DISMISS] == "auto"


def test_the_seconds_go_on_being_sent_with_confirm() -> None:
    _, _, _, area, machine, db = _world({}, {}, {DISMISS: "confirm", SECS: 7})
    settings = _sync(machine, db, area).settings
    assert (settings[DISMISS], settings[SCREEN], settings[SECS]) == ("confirm", "always", 7)


def test_every_level_takes_and_resets_it() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {DISMISS: "confirm"})
    _patch_company(company, db, {DISMISS: "auto"})
    _patch_shop(shop, db, {DISMISS: "confirm"})
    _patch_area(area, shop, db, {DISMISS: "auto"})
    _patch_machine(machine, area, db, {DISMISS: "confirm"})
    layers = (tenant, company, shop, area, machine)
    assert [e.settings for e in layers] == [{DISMISS: v} for v in ("confirm", "auto", "confirm", "auto", "confirm")]
    assert _resolved(merge_all_settings_layers(company, shop, tenant, machine, area)) == "confirm"  # the till's
    _patch_machine(machine, area, db, {DISMISS: None})
    assert machine.settings == {}
    assert _resolved(merge_all_settings_layers(company, shop, tenant, machine, area)) == "auto"  # the point of sale's
    _patch_area(area, shop, db, {DISMISS: None})
    assert _sync(machine, db, area).settings[DISMISS] == "confirm"  # the shop's
    _patch_shop(shop, db, {DISMISS: None})
    _patch_company(company, db, {DISMISS: None})
    assert _sync(machine, db, area).settings[DISMISS] == "confirm"  # back to the tenant's
    _patch_tenant(tenant, db, {DISMISS: None})
    assert tenant.settings == {}
    assert _sync(machine, db, area).settings[DISMISS] == "auto"  # the default


def test_a_patch_of_it_leaves_the_screen_and_its_seconds_alone() -> None:
    _, _, shop, _, _, db = _world({}, {}, {SCREEN: "auto_close", SECS: 5})
    _patch_shop(shop, db, {DISMISS: "confirm"})
    assert shop.settings == {SCREEN: "auto_close", SECS: 5, DISMISS: "confirm"}
    _patch_shop(shop, db, {SECS: None})
    assert shop.settings == {SCREEN: "auto_close", DISMISS: "confirm"}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_shops_preview_shows_the_effective_value_and_its_source() -> None:
    _, _, shop, _, _, db = _world({DISMISS: "auto"}, {DISMISS: "confirm"}, {SCREEN: "off"})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[DISMISS], res.effective_sources[DISMISS]) == ("confirm", "company")
    assert res.settings == {SCREEN: "off"}  # its own layer, raw


def test_a_tills_preview_shows_auto_when_no_level_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert res.effective[DISMISS] == "auto"
    assert DISMISS not in (res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {DISMISS: "auto"}, {DISMISS: "confirm"})
    _patch_tenant(tenant, db, {DISMISS: "confirm"})
    _patch_company(company, db, {DISMISS: "auto"})
    _patch_shop(shop, db, {DISMISS: "confirm"})
    _patch_area(area, shop, db, {DISMISS: "confirm"})
    _patch_machine(machine, area, db, {DISMISS: None})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (DISMISS, "tenant", "set", None, "confirm"),
        (DISMISS, "company", "set", None, "auto"),
        (DISMISS, "shop", "set", None, "confirm"),
        (DISMISS, "area", "set", "auto", "confirm"),
        (DISMISS, "machine", "clear", "confirm", None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, shop, area, machine)]


def test_an_unchanged_value_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {DISMISS: "confirm"})
    _patch_shop(shop, db, {DISMISS: "confirm"})
    assert _audit_rows(db) == []
