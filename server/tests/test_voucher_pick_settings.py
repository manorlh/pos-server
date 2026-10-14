"""The "בחר פריט לשובר" order screen's three till settings — P:/specs/voucher-station-fast-flows.md §4 (13.10.2026).

- `voucherGuide` (bool, unset = true): "הסבר לעובד מה לבחור" — a guide strip on the order screen;
- `voucherPickFilter` ("eligible" | "all", unset = "eligible"): after a scan of a voucher that needs
  items, only the eligible items, or the whole menu with tags;
- `voucherAutoPickSingle` (bool, unset = true): a lone eligible item is picked by itself.

Flat keys set at every level (tenant, company, shop, point of sale, till) and merged like the other
voucher work settings; always sent to the till resolved; a value outside the enum / not a bool is a 422;
`null` resets a layer; each change is logged with its level; the dashboard's preview has the inherited
value and its source.

Mock-based like tests/test_voucher_success_dismiss_settings.py.
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
from app.services.voucher_redeem_settings import _audited_keys, resolve_voucher_flow
from app.services.voucher_station_settings import (
    DEFAULT_AUTO_PICK_SINGLE,
    DEFAULT_GUIDE,
    DEFAULT_PICK_FILTER,
    PICK_FILTER_VALUES,
    VOUCHER_AUTO_PICK_SINGLE_KEY,
    VOUCHER_GUIDE_KEY,
    VOUCHER_PICK_FILTER_KEY,
    VOUCHER_PICK_SETTING_KEYS,
    resolve_auto_apply,
    resolve_show_entitlement,
    resolve_station_paid_items,
    resolve_voucher_fast_mode,
    resolve_voucher_pick,
    resolve_voucher_sounds,
    resolve_voucher_station,
    resolve_voucher_success,
    resolve_voucher_success_dismiss,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

GUIDE = "voucherGuide"
FILTER = "voucherPickFilter"
AUTO = "voucherAutoPickSingle"
DEFAULTS = {GUIDE: True, FILTER: "eligible", AUTO: True}
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


def _picked(settings) -> dict:
    return {k: settings[k] for k in (GUIDE, FILTER, AUTO)}


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_keys_their_values_and_defaults_are_the_contract_with_the_till() -> None:
    assert (VOUCHER_GUIDE_KEY, VOUCHER_PICK_FILTER_KEY, VOUCHER_AUTO_PICK_SINGLE_KEY) == (GUIDE, FILTER, AUTO)
    assert VOUCHER_PICK_SETTING_KEYS == (GUIDE, FILTER, AUTO)
    assert PICK_FILTER_VALUES == ("eligible", "all")
    assert (DEFAULT_GUIDE, DEFAULT_PICK_FILTER, DEFAULT_AUTO_PICK_SINGLE) == (True, "eligible", True)
    for key in (GUIDE, FILTER, AUTO):
        assert key in MANAGED_SETTING_KEYS  # merged per layer and synced
        assert key in _audited_keys()  # every change is logged


def test_unset_is_the_guide_on_eligible_only_and_the_lone_item_picked() -> None:
    assert resolve_voucher_pick({}) == DEFAULTS


@pytest.mark.parametrize("guide", [True, False])
@pytest.mark.parametrize("pick_filter", ["eligible", "all"])
@pytest.mark.parametrize("auto", [True, False])
def test_known_values_resolve_to_themselves(guide, pick_filter, auto) -> None:
    merged = {GUIDE: guide, FILTER: pick_filter, AUTO: auto}
    assert resolve_voucher_pick(merged) == merged


@pytest.mark.parametrize("junk", ["false", "off", "on", 0, 1, "", None, [], {}])
def test_a_switch_that_is_not_a_real_bool_reads_as_true(junk) -> None:
    assert resolve_voucher_pick({GUIDE: junk, AUTO: junk}) == DEFAULTS


@pytest.mark.parametrize("junk", ["ALL", "Eligible", " all", "on", "off", "", 1, True, False, None, ["all"], {}])
def test_an_unknown_filter_reads_as_eligible(junk) -> None:
    assert resolve_voucher_pick({FILTER: junk})[FILTER] == "eligible"


def test_they_stand_apart_from_the_other_voucher_keys() -> None:
    merged = {GUIDE: False, FILTER: "all", AUTO: False, "voucherShowUnavailable": False}
    for other in (
        resolve_voucher_station, resolve_station_paid_items, resolve_show_entitlement, resolve_auto_apply,
        resolve_voucher_success, resolve_voucher_success_dismiss, resolve_voucher_sounds, resolve_voucher_fast_mode,
        resolve_voucher_flow,
    ):
        assert not {GUIDE, FILTER, AUTO} & set(other(merged))
    assert resolve_voucher_flow(merged)["voucherShowUnavailable"] is False  # its neighbour as it was
    assert resolve_voucher_pick(merged) == {GUIDE: False, FILTER: "all", AUTO: False}
    assert merged == {GUIDE: False, FILTER: "all", AUTO: False, "voucherShowUnavailable": False}  # a view


# ── Validation: 422 outside the enum / not a bool ────────────────────────────


@pytest.mark.parametrize("body", [
    {GUIDE: False}, {GUIDE: True}, {FILTER: "eligible"}, {FILTER: "all"}, {AUTO: False}, {AUTO: True},
    {GUIDE: False, FILTER: "all", AUTO: False},
])
def test_the_patch_takes_each_value(body) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate(body)) == body


@pytest.mark.parametrize("bad", ["ALL", "eligible_only", "on", "", 1, True, ["all"], {"v": "all"}])
def test_a_filter_outside_the_enum_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({FILTER: bad})


@pytest.mark.parametrize("key", [GUIDE, AUTO])
@pytest.mark.parametrize("bad", ["maybe", "eligible", 2, [True], {"v": True}])
def test_a_switch_that_is_not_a_bool_is_refused(key, bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({key: bad})


@pytest.mark.parametrize("path", LEVEL_PATHS)
@pytest.mark.parametrize("body", [{FILTER: "everything"}, {FILTER: 3}, {GUIDE: "maybe"}, {AUTO: [1]}])
def test_every_levels_endpoint_answers_422_for_an_unknown_value(path, body) -> None:
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
    assert TestClient(app).patch(path, json=body).status_code == 422


# ── Every level: set, inherit, reset; the sync payload ───────────────────────


def test_sync_sends_the_defaults_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    settings = _sync(machine, db, area).settings
    assert _picked(settings) == DEFAULTS
    # Real JSON booleans and a string, the shape the till reads.
    assert settings[GUIDE] is True and settings[AUTO] is True and isinstance(settings[FILTER], str)


@pytest.mark.parametrize("level", range(5))
def test_each_value_at_any_one_level_reaches_the_till(level) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = {GUIDE: False, FILTER: "all", AUTO: False}
    _, _, _, area, machine, db = _world(*layers)
    settings = _sync(machine, db, area).settings
    assert _picked(settings) == {GUIDE: False, FILTER: "all", AUTO: False}
    assert settings[GUIDE] is False and settings[AUTO] is False


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    cases = [
        (({GUIDE: False}, {}, {}, {}, {}), {GUIDE: False}),  # the tenant's
        (({GUIDE: False}, {GUIDE: True, FILTER: "all"}, {}, {}, {}), {GUIDE: True, FILTER: "all"}),  # the company's
        (({}, {FILTER: "all"}, {FILTER: "eligible", AUTO: False}, {}, {}), {FILTER: "eligible", AUTO: False}),  # the shop's
        (({}, {}, {AUTO: False}, {AUTO: True, GUIDE: False}, {}), {AUTO: True, GUIDE: False}),  # the point of sale's
        (
            ({GUIDE: True}, {FILTER: "eligible"}, {AUTO: True}, {GUIDE: True}, {GUIDE: False, FILTER: "all", AUTO: False}),
            {GUIDE: False, FILTER: "all", AUTO: False},
        ),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        assert _picked(_sync(machine, db, area).settings) == {**DEFAULTS, **expected}, layers


@pytest.mark.parametrize("junk", [
    {GUIDE: "false", FILTER: "everything", AUTO: 0},
    {GUIDE: None, FILTER: None, AUTO: None},
    {GUIDE: [False], FILTER: ["all"], AUTO: {"v": False}},
])
def test_sync_sends_a_junk_value_as_the_default(junk) -> None:
    _, _, _, area, machine, db = _world({}, {}, junk)
    assert _picked(_sync(machine, db, area).settings) == DEFAULTS


def test_junk_at_the_till_is_sent_as_the_default_never_as_junk() -> None:
    # The layers merge as JSON (the deepest wins, junk too); what goes out is resolved.
    _, _, _, area, machine, db = _world({}, {}, {FILTER: "all", GUIDE: False}, {}, {FILTER: "ALL", GUIDE: "no"})
    assert _picked(_sync(machine, db, area).settings) == DEFAULTS


def test_every_level_takes_and_resets_them() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {GUIDE: False, FILTER: "all"})
    _patch_company(company, db, {AUTO: False})
    _patch_shop(shop, db, {GUIDE: True})
    _patch_area(area, shop, db, {FILTER: "eligible"})
    _patch_machine(machine, area, db, {GUIDE: False, FILTER: "all", AUTO: True})
    assert [e.settings for e in (tenant, company, shop, area, machine)] == [
        {GUIDE: False, FILTER: "all"},
        {AUTO: False},
        {GUIDE: True},
        {FILTER: "eligible"},
        {GUIDE: False, FILTER: "all", AUTO: True},
    ]
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert resolve_voucher_pick(merged) == {GUIDE: False, FILTER: "all", AUTO: True}  # the till's
    _patch_machine(machine, area, db, {GUIDE: None, FILTER: None, AUTO: None})
    assert machine.settings == {}
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    # The shop's guide, the point of sale's filter, the company's auto pick.
    assert resolve_voucher_pick(merged) == {GUIDE: True, FILTER: "eligible", AUTO: False}
    _patch_area(area, shop, db, {FILTER: None})
    _patch_shop(shop, db, {GUIDE: None})
    _patch_company(company, db, {AUTO: None})
    assert _picked(_sync(machine, db, area).settings) == {GUIDE: False, FILTER: "all", AUTO: True}  # the tenant's
    _patch_tenant(tenant, db, {GUIDE: None, FILTER: None})
    assert tenant.settings == {}
    assert _picked(_sync(machine, db, area).settings) == DEFAULTS


def test_a_patch_of_them_leaves_the_other_voucher_keys_alone() -> None:
    _, _, shop, _, _, db = _world({}, {}, {"voucherShowUnavailable": False, "voucherStationPaidItems": "on"})
    _patch_shop(shop, db, {FILTER: "all", AUTO: False})
    assert shop.settings == {"voucherShowUnavailable": False, "voucherStationPaidItems": "on", FILTER: "all", AUTO: False}
    _patch_shop(shop, db, {AUTO: None})
    assert shop.settings == {"voucherShowUnavailable": False, "voucherStationPaidItems": "on", FILTER: "all"}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_shops_preview_shows_the_effective_values_and_their_source() -> None:
    _, _, shop, _, _, db = _world({GUIDE: True, FILTER: "all"}, {GUIDE: False}, {AUTO: False})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[GUIDE], res.effective_sources[GUIDE]) == (False, "company")
    assert (res.effective[FILTER], res.effective_sources[FILTER]) == ("all", "tenant")
    # What the shop inherits: its own value is not in it (no level above sets it — the default, no source).
    assert res.effective[AUTO] is True and AUTO not in res.effective_sources
    assert res.settings == {AUTO: False}  # its own layer, raw


def test_a_tills_preview_shows_the_defaults_when_no_level_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert _picked(res.effective) == DEFAULTS
    assert not {GUIDE, FILTER, AUTO} & set(res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {FILTER: "eligible"}, {AUTO: False})
    _patch_tenant(tenant, db, {GUIDE: False})
    _patch_company(company, db, {FILTER: "all"})
    _patch_shop(shop, db, {AUTO: True})
    _patch_area(area, shop, db, {FILTER: "all"})
    _patch_machine(machine, area, db, {AUTO: None})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (GUIDE, "tenant", "set", None, False),
        (FILTER, "company", "set", None, "all"),
        (AUTO, "shop", "set", None, True),
        (FILTER, "area", "set", "eligible", "all"),
        (AUTO, "machine", "clear", False, None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, shop, area, machine)]


def test_an_unchanged_value_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {GUIDE: False, FILTER: "all"})
    _patch_shop(shop, db, {GUIDE: False, FILTER: "all"})
    assert _audit_rows(db) == []
