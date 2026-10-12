"""The strong approve / reject sounds of a voucher redemption — the owner's request of 12.10.2026
("תוסיף צליל אישור חזק וצליל סירוב חזק, אפשר לבטל אותם בפרמטרים — לגבי השוברים במימוש").

`voucherSoundApprove` and `voucherSoundReject` ("on" | "off", unset = "on"): flat keys set at every
level (tenant, company, shop, point of sale, till) and merged like `voucherShowEntitlement`; always
sent to the till resolved; a value outside the enum is a 422; `null` resets a layer; each change is
logged with its level; the dashboard's preview has the inherited value and its source.

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
    DEFAULT_SOUND_APPROVE,
    DEFAULT_SOUND_REJECT,
    SOUND_VALUES,
    VOUCHER_SOUND_APPROVE_KEY,
    VOUCHER_SOUND_REJECT_KEY,
    VOUCHER_SOUND_SETTING_KEYS,
    resolve_show_entitlement,
    resolve_station_paid_items,
    resolve_voucher_sounds,
    resolve_voucher_station,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

APPROVE = "voucherSoundApprove"
REJECT = "voucherSoundReject"
BOTH = (APPROVE, REJECT)


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


def _resolved(merged, key) -> str:
    return resolve_voucher_sounds(merged)[key]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_keys_their_values_and_defaults_are_the_contract_with_the_till() -> None:
    assert (VOUCHER_SOUND_APPROVE_KEY, VOUCHER_SOUND_REJECT_KEY) == BOTH
    assert VOUCHER_SOUND_SETTING_KEYS == BOTH
    assert SOUND_VALUES == ("on", "off")
    assert DEFAULT_SOUND_APPROVE == "on" and DEFAULT_SOUND_REJECT == "on"
    for key in BOTH:
        assert key in MANAGED_SETTING_KEYS  # merged per layer and synced
        assert key in _audited_keys()  # every change is logged


@pytest.mark.parametrize("junk", ["ON", "Off", "true", "", 1, 0, True, False, None, [], {}])
def test_unset_or_unknown_is_on(junk) -> None:
    assert resolve_voucher_sounds({}) == {APPROVE: "on", REJECT: "on"}
    assert resolve_voucher_sounds({APPROVE: junk, REJECT: junk}) == {APPROVE: "on", REJECT: "on"}


@pytest.mark.parametrize("approve", ["off", "on"])
@pytest.mark.parametrize("reject", ["off", "on"])
def test_each_key_resolves_on_its_own(approve, reject) -> None:
    assert resolve_voucher_sounds({APPROVE: approve, REJECT: reject}) == {APPROVE: approve, REJECT: reject}
    assert resolve_voucher_sounds({APPROVE: approve}) == {APPROVE: approve, REJECT: "on"}
    assert resolve_voucher_sounds({REJECT: reject}) == {APPROVE: "on", REJECT: reject}


def test_they_stand_apart_from_the_other_voucher_keys() -> None:
    merged = {APPROVE: "off", REJECT: "off"}
    for other in (resolve_voucher_station, resolve_station_paid_items, resolve_show_entitlement):
        assert not set(other(merged)) & set(BOTH)
    resolve_voucher_sounds(merged)
    assert merged == {APPROVE: "off", REJECT: "off"}  # a view: nothing written back


# ── Validation: 422 outside the enum ─────────────────────────────────────────


@pytest.mark.parametrize("key", BOTH)
@pytest.mark.parametrize("value", ["off", "on"])
def test_the_patch_takes_each_value(key, value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({key: value})) == {key: value}


@pytest.mark.parametrize("key", BOTH)
@pytest.mark.parametrize("bad", ["ON", "yes", "true", "", 1, True, ["on"], {"v": "on"}])
def test_a_value_outside_the_enum_is_refused(key, bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({key: bad})


@pytest.mark.parametrize("key", BOTH)
@pytest.mark.parametrize(
    "path",
    ["/tenants/t1/settings", "/companies/c1/settings", "/shops/s1/settings", "/areas/a1/settings", "/machines/m1/settings"],
)
def test_every_levels_endpoint_answers_422_for_a_value_outside_the_enum(key, path) -> None:
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
    assert client.patch(path, json={key: "loud"}).status_code == 422


# ── Every level: set, inherit, reset; the sync payload ───────────────────────


def test_sync_sends_both_on_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    settings = _sync(machine, db, area).settings
    assert (settings[APPROVE], settings[REJECT]) == ("on", "on")


@pytest.mark.parametrize("key", BOTH)
@pytest.mark.parametrize("level", range(5))
def test_off_at_any_one_level_reaches_the_till(key, level) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = {key: "off"}
    _, _, _, area, machine, db = _world(*layers)
    settings = _sync(machine, db, area).settings
    other = REJECT if key == APPROVE else APPROVE
    assert (settings[key], settings[other]) == ("off", "on")


@pytest.mark.parametrize("key", BOTH)
def test_sync_carries_each_level_down_and_the_deepest_wins(key) -> None:
    cases = [
        (({key: "off"}, {}, {}, {}, {}), "off"),  # the tenant's
        (({key: "off"}, {key: "on"}, {}, {}, {}), "on"),  # the company's over the tenant's
        (({}, {key: "on"}, {key: "off"}, {}, {}), "off"),  # the shop's
        (({}, {}, {key: "off"}, {key: "on"}, {}), "on"),  # the point of sale's
        (({key: "on"}, {}, {key: "on"}, {key: "on"}, {key: "off"}), "off"),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        assert _sync(machine, db, area).settings[key] == expected, layers


def test_sync_sends_a_junk_value_as_on() -> None:
    _, _, _, area, machine, db = _world({}, {}, {APPROVE: "maybe", REJECT: 0})
    settings = _sync(machine, db, area).settings
    assert (settings[APPROVE], settings[REJECT]) == ("on", "on")


@pytest.mark.parametrize("key", BOTH)
def test_every_level_takes_and_resets_it(key) -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {key: "off"})
    _patch_company(company, db, {key: "on"})
    _patch_shop(shop, db, {key: "off"})
    _patch_area(area, shop, db, {key: "on"})
    _patch_machine(machine, area, db, {key: "off"})
    layers = (tenant, company, shop, area, machine)
    assert [e.settings for e in layers] == [{key: v} for v in ("off", "on", "off", "on", "off")]
    assert _resolved(merge_all_settings_layers(company, shop, tenant, machine, area), key) == "off"  # the till's
    _patch_machine(machine, area, db, {key: None})
    assert machine.settings == {}
    assert _resolved(merge_all_settings_layers(company, shop, tenant, machine, area), key) == "on"  # the point of sale's
    _patch_area(area, shop, db, {key: None})
    _patch_shop(shop, db, {key: None})
    _patch_company(company, db, {key: None})
    assert _sync(machine, db, area).settings[key] == "off"  # back to the tenant's
    _patch_tenant(tenant, db, {key: None})
    assert tenant.settings == {}
    assert _sync(machine, db, area).settings[key] == "on"  # the default


def test_one_patch_sets_both_and_leaves_the_other_keys_alone() -> None:
    _, _, shop, _, _, db = _world({}, {}, {"voucherShowEntitlement": "off"})
    _patch_shop(shop, db, {APPROVE: "off", REJECT: "off"})
    assert shop.settings == {"voucherShowEntitlement": "off", APPROVE: "off", REJECT: "off"}
    _patch_shop(shop, db, {REJECT: None})
    assert shop.settings == {"voucherShowEntitlement": "off", APPROVE: "off"}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_shops_preview_shows_the_effective_value_and_its_source() -> None:
    _, _, shop, _, _, db = _world({APPROVE: "on"}, {APPROVE: "off", REJECT: "off"}, {APPROVE: "on"})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[APPROVE], res.effective_sources[APPROVE]) == ("off", "company")  # not its own value
    assert (res.effective[REJECT], res.effective_sources[REJECT]) == ("off", "company")
    assert res.settings == {APPROVE: "on"}  # its own layer, raw


def test_a_tills_preview_shows_the_default_when_no_level_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    for key in BOTH:
        assert res.effective[key] == "on"
        assert key not in (res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


@pytest.mark.parametrize("key", BOTH)
def test_each_change_is_logged_with_its_level_and_old_and_new_value(key) -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {}, {key: "off"})
    _patch_tenant(tenant, db, {key: "off"})
    _patch_company(company, db, {key: "on"})
    _patch_shop(shop, db, {key: "off"})
    _patch_area(area, shop, db, {key: "on"})
    _patch_machine(machine, area, db, {key: None})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (key, "tenant", "set", None, "off"),
        (key, "company", "set", None, "on"),
        (key, "shop", "set", None, "off"),
        (key, "area", "set", None, "on"),
        (key, "machine", "clear", "off", None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, shop, area, machine)]


def test_an_unchanged_value_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {APPROVE: "off"})
    _patch_shop(shop, db, {APPROVE: "off"})
    assert _audit_rows(db) == []
    _patch_shop(shop, db, {APPROVE: "on", REJECT: "off"})
    rows = _audit_rows(db)
    assert sorted((r.parameter_key, r.action, r.old_value, r.new_value) for r in rows) == [
        (APPROVE, "set", "off", "on"),
        (REJECT, "set", None, "off"),
    ]
