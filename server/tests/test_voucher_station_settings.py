"""Closing on their own and the voucher station — the owner's spec of 11.10.2026
(P:/specs/voucher-station-and-autoclose.md §1–§3).

`voucherAutoClose` ("on" | "off", unset = "on": today's behaviour) and `voucherStation` ("off" | "on",
unset = "off"): flat keys set at every level and merged like `voucherRedeemFlow`; always sent to the
till resolved; a value outside the enum is a 422; `null` resets a layer; each change is logged; the
dashboard's preview has the inherited value and its source. And the lookup carries what the station's
"תנאי המימוש" panel reads.

The setting half is mock-based like tests/test_voucher_redeem_flow_settings.py.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.models.till_parameter import TillParameterChange
from app.models.user import UserRole
from app.routers.settings import get_machine_settings, get_shop_settings
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers, patch_to_camel_dict
from app.services.voucher_station_settings import (
    AUTO_CLOSE_VALUES,
    DEFAULT_AUTO_CLOSE,
    DEFAULT_STATION,
    STATION_VALUES,
    VOUCHER_STATION_SETTING_KEYS,
    resolve_voucher_station,
)
from test_prepaid_voucher_kinds import codes, lookup, make, w  # noqa: F401 — `w` is the fixture
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

AUTO_CLOSE = "voucherAutoClose"
STATION = "voucherStation"


def _audit_rows(db):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], TillParameterChange)]


def test_the_keys_values_and_defaults_are_the_contract_with_the_till() -> None:
    assert VOUCHER_STATION_SETTING_KEYS == (AUTO_CLOSE, STATION)
    assert AUTO_CLOSE_VALUES == ("on", "off") and DEFAULT_AUTO_CLOSE == "on"
    assert STATION_VALUES == ("off", "on") and DEFAULT_STATION == "off"
    for key in VOUCHER_STATION_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS


@pytest.mark.parametrize("junk", ["ON", "true", "", 1, True, None, [], {}])
def test_unset_or_unknown_is_todays_behaviour(junk) -> None:
    assert resolve_voucher_station({}) == {AUTO_CLOSE: "on", STATION: "off"}
    assert resolve_voucher_station({AUTO_CLOSE: junk, STATION: junk}) == {AUTO_CLOSE: "on", STATION: "off"}


@pytest.mark.parametrize("auto_close,station", [("on", "off"), ("off", "on"), ("off", "off"), ("on", "on")])
def test_the_patch_takes_each_value(auto_close, station) -> None:
    body = {AUTO_CLOSE: auto_close, STATION: station}
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate(body)) == body


@pytest.mark.parametrize("bad", ["ON", "auto", "", 1, True, ["on"]])
def test_a_value_outside_the_enum_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({AUTO_CLOSE: bad})
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({STATION: bad})


def test_the_endpoint_answers_422_for_a_value_outside_the_enum() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.middleware.auth import get_active_tenant_id, get_current_machine_admin
    from app.routers import settings as S

    app = FastAPI()
    app.include_router(S.router)
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_machine_admin] = lambda: _user(UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_active_tenant_id] = lambda: None
    client = TestClient(app)
    assert client.patch("/machines/m1/settings", json={AUTO_CLOSE: "auto"}).status_code == 422
    assert client.patch("/machines/m1/settings", json={STATION: "yes"}).status_code == 422


def test_sync_sends_both_resolved_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    settings = _sync(machine, db, area).settings
    assert (settings[AUTO_CLOSE], settings[STATION]) == ("on", "off")


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    _, _, _, area, machine, db = _world({AUTO_CLOSE: "off"}, {STATION: "on"}, {AUTO_CLOSE: "on"})
    settings = _sync(machine, db, area).settings
    assert (settings[AUTO_CLOSE], settings[STATION]) == ("on", "on")  # the shop's, the company's
    _, _, _, area, machine, db = _world({}, {STATION: "on"}, {}, {AUTO_CLOSE: "off"}, {STATION: "off"})
    settings = _sync(machine, db, area).settings
    assert (settings[AUTO_CLOSE], settings[STATION]) == ("off", "off")  # the point of sale's, the till's


def test_every_level_takes_and_resets_both_keys() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {AUTO_CLOSE: "off"})
    _patch_shop(shop, db, {STATION: "on"})
    _patch_area(area, shop, db, {AUTO_CLOSE: "on"})
    _patch_machine(machine, area, db, {STATION: "off"})
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert resolve_voucher_station(merged) == {AUTO_CLOSE: "on", STATION: "off"}
    _patch_machine(machine, area, db, {STATION: None})
    _patch_area(area, shop, db, {AUTO_CLOSE: None})
    assert (machine.settings, area.settings) == ({}, {})
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert resolve_voucher_station(merged) == {AUTO_CLOSE: "off", STATION: "on"}
    assert _sync(machine, db, area).settings[STATION] == "on"


def test_the_dashboard_preview_shows_the_effective_value_and_its_source() -> None:
    _, _, shop, _, _, db = _world({STATION: "on"}, {AUTO_CLOSE: "off"}, {})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[AUTO_CLOSE], res.effective[STATION]) == ("off", "on")
    assert (res.effective_sources[AUTO_CLOSE], res.effective_sources[STATION]) == ("company", "tenant")


def test_a_tills_preview_shows_the_defaults_when_no_level_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert (res.effective[AUTO_CLOSE], res.effective[STATION]) == ("on", "off")
    assert AUTO_CLOSE not in (res.effective_sources or {}) and STATION not in (res.effective_sources or {})


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    _, _, _, area, machine, db = _world({}, {}, {}, {}, {STATION: "on"})
    _patch_machine(machine, area, db, {STATION: None, AUTO_CLOSE: "off"})
    rows = sorted(_audit_rows(db), key=lambda r: r.parameter_key)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (AUTO_CLOSE, "machine", "set", None, "off"),
        (STATION, "machine", "clear", "on", None),
    ]


def test_the_payment_rule_is_untouched_by_these_keys() -> None:
    _, _, shop, _, _, db = _world()
    res = _patch_shop(shop, db, {AUTO_CLOSE: "off", STATION: "on"})
    assert res.settings == {AUTO_CLOSE: "off", STATION: "on"}


# ── What the station's "תנאי המימוש" panel reads from the lookup ─────────────


def test_the_lookup_carries_the_terms_the_station_shows(w):
    from datetime import datetime, timezone

    b = make(w, kind="items", count=1, splitAllowed=False, includeExtras=True, maxVouchersPerSale=3,
             shopIds=[w.shop.id, w.other_shop.id], validFrom="2026-10-01T06:00:00Z", validUntil="2099-10-20T21:00:00Z")
    out = lookup(w, codes(w, b)[0])
    assert datetime.fromisoformat(out["validFrom"].replace("Z", "+00:00")) == datetime(2026, 10, 1, 6, tzinfo=timezone.utc)
    assert datetime.fromisoformat(out["validUntil"].replace("Z", "+00:00")) == datetime(2099, 10, 20, 21, tzinfo=timezone.utc)
    assert (out["stacking"], out["maxVouchersPerSale"]) == ("unlimited", 3)
    assert (out["splitAllowed"], out["wholeAtOnce"], out["includeExtras"]) == (False, True, True)
    assert (out["quotaUnit"], out["quota"], out["used"], out["remaining"]) == ("units", 1, 0, 1)
    assert "pricing" in out and "tillValueAgorot" in out and "allowTopUp" in out
    assert "validTimes" not in out and "maxUnitsPerSale" not in out  # no such restriction on goods
    # "תקף בסניפים: …": the named shops by name; null when the batch is for every shop.
    assert out["validShops"] == [{"id": str(w.shop.id), "name": "Center"}, {"id": str(w.other_shop.id), "name": "North"}]
    every = lookup(w, codes(w, make(w, kind="items", count=1))[0])
    assert "validShops" not in every  # only when the voucher is limited to shops


def test_a_discount_vouchers_per_sale_terms(w):
    out = lookup(w, codes(w, make(w, "order_discount", count=1, usesPerVoucher=4, maxUsesPerSale=2))[0])
    assert (out["maxUsesPerSale"], out["quotaUnit"], out["quota"]) == (2, "uses", 4)
    assert out["benefit"]["discountType"] == "fixed"
    assert "maxUnitsPerSale" not in out  # an order discount counts no units


def test_an_item_discounts_most_units_in_one_sale(w):
    out = lookup(w, codes(w, make(w, "item_discount", count=1, usesPerVoucher=4, maxUsesPerSale=2, maxUnits=3))[0])
    assert out["maxUnitsPerSale"] == 6  # 3 units a use, 2 uses a sale
    assert out["benefit"]["maxUnits"] == 3
