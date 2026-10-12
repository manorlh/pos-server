"""How a till enters a production voucher's redemption — two till settings (the owner's spec of 11.10.2026 §2, §8).

`voucherRedeemFlow` ("items_first" | "voucher_first" | "both") and `voucherShowUnavailable` (bool):
flat keys set at every level (tenant → company → shop → point of sale → till) and merged like the
voucher's payment switches; unset everywhere = "items_first" / true, so every existing till keeps
today's flow; always sent to the till resolved (GET /sync/{id}/settings, `settings.<key>`); a value
outside the enum is a 422; `null` resets a layer to inherit; each change is logged (who, which level,
old → new) in the till parameters' change log. The Android till reads these keys by name.

Mock-based, like tests/test_voucher_pay_options.py (whose world and PATCH helpers are reused).
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
from app.services.voucher_redeem_settings import (
    DEFAULT_REDEEM_FLOW,
    REDEEM_FLOWS,
    VOUCHER_FLOW_SETTING_KEYS,
    resolve_voucher_flow,
)
from test_voucher_pay_options import (
    _patch_area,
    _patch_machine,
    _patch_shop,
    _patch_tenant,
    _sync,
    _user,
    _world,
)

FLOW = "voucherRedeemFlow"
SHOW = "voucherShowUnavailable"


def _audit_rows(db):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], TillParameterChange)]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_keys_and_values_are_the_contract_with_the_till() -> None:
    assert VOUCHER_FLOW_SETTING_KEYS == (FLOW, SHOW)
    assert REDEEM_FLOWS == ("items_first", "voucher_first", "both")
    assert DEFAULT_REDEEM_FLOW == "items_first"
    for key in VOUCHER_FLOW_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS


def test_unset_everywhere_is_todays_flow_and_unavailable_shown() -> None:
    assert resolve_voucher_flow({}) == {FLOW: "items_first", SHOW: True}


@pytest.mark.parametrize("junk", ["ITEMS_FIRST", "scan", "", 1, True, None, [], {}])
def test_an_unknown_stored_value_counts_as_unset(junk) -> None:
    assert resolve_voucher_flow({FLOW: junk, SHOW: "false"}) == {FLOW: "items_first", SHOW: True}


@pytest.mark.parametrize("flow", REDEEM_FLOWS)
def test_the_patch_takes_each_flow(flow) -> None:
    body = {FLOW: flow, SHOW: False}
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate(body)) == body


@pytest.mark.parametrize("bad", ["ITEMS_FIRST", "scan_first", "", 3, ["both"]])
def test_a_value_outside_the_enum_is_refused(bad) -> None:
    # FastAPI answers a body that fails the schema with a 422.
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({FLOW: bad})
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({SHOW: "maybe"})


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
    res = TestClient(app).patch("/machines/m1/settings", json={FLOW: "scan_first"})
    assert res.status_code == 422


# ── Inheritance and delivery to the till ─────────────────────────────────────


def test_sync_sends_both_resolved_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    settings = _sync(machine, db, area).settings
    assert settings[FLOW] == "items_first"
    assert settings[SHOW] is True


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    _, _, _, area, machine, db = _world({FLOW: "both"}, {SHOW: False}, {FLOW: "voucher_first"})
    settings = _sync(machine, db, area).settings
    assert (settings[FLOW], settings[SHOW]) == ("voucher_first", False)  # the shop's flow, the company's switch

    _, _, _, area, machine, db = _world({FLOW: "both"}, {}, {FLOW: "voucher_first"}, {SHOW: False}, {FLOW: "items_first"})
    settings = _sync(machine, db, area).settings
    assert (settings[FLOW], settings[SHOW]) == ("items_first", False)  # the till's own, the point of sale's


def test_a_till_override_beats_inheritance_and_a_reset_brings_the_inherited_value_back() -> None:
    _, _, shop, area, machine, db = _world({}, {}, {FLOW: "both"})
    _patch_machine(machine, area, db, {FLOW: "voucher_first"})
    assert machine.settings == {FLOW: "voucher_first"}
    assert _sync(machine, db, area).settings[FLOW] == "voucher_first"
    _patch_machine(machine, area, db, {FLOW: None})
    # Gone from the till's own JSON — not stored as null.
    assert machine.settings == {}
    assert _sync(machine, db, area).settings[FLOW] == "both"


def test_every_level_takes_and_resets_both_keys() -> None:
    tenant, company, shop, area, machine, db = _world()
    _patch_tenant(tenant, db, {FLOW: "both"})
    _patch_shop(shop, db, {SHOW: False})
    _patch_area(area, shop, db, {FLOW: "voucher_first"})
    assert (tenant.settings, shop.settings, area.settings) == ({FLOW: "both"}, {SHOW: False}, {FLOW: "voucher_first"})
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert resolve_voucher_flow(merged) == {FLOW: "voucher_first", SHOW: False}
    _patch_area(area, shop, db, {FLOW: None})
    _patch_shop(shop, db, {SHOW: None})
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert resolve_voucher_flow(merged) == {FLOW: "both", SHOW: True}


def test_the_dashboard_preview_shows_the_effective_value_and_its_source() -> None:
    _, _, shop, _, _, db = _world({SHOW: False}, {FLOW: "voucher_first"}, {})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[FLOW], res.effective[SHOW]) == ("voucher_first", False)
    assert res.effective_sources[FLOW] == "company" and res.effective_sources[SHOW] == "tenant"
    assert res.settings == {}  # the shop's own layer stays raw: still inherited


def test_a_tills_preview_shows_the_default_when_no_level_sets_it() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert (res.effective[FLOW], res.effective[SHOW]) == ("items_first", True)
    assert FLOW not in (res.effective_sources or {})  # no level: the dashboard says "ברירת מחדל"


def test_the_payment_rule_is_untouched_by_these_keys() -> None:
    # Not a way to take payment: changing them never trips (or satisfies) the 422.
    _, _, shop, _, _, db = _world()
    res = _patch_shop(shop, db, {FLOW: "voucher_first", SHOW: False})
    assert res.settings == {FLOW: "voucher_first", SHOW: False}


# ── Who changed it ───────────────────────────────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    _, _, _, area, machine, db = _world({}, {}, {}, {}, {FLOW: "both"})
    _patch_machine(machine, area, db, {FLOW: "voucher_first", SHOW: False})
    rows = sorted(_audit_rows(db), key=lambda r: r.parameter_key)
    assert [(r.parameter_key, r.scope_type, r.scope_id, r.action, r.old_value, r.new_value) for r in rows] == [
        (FLOW, "machine", machine.id, "set", "both", "voucher_first"),
        (SHOW, "machine", machine.id, "set", None, False),
    ]
    assert all(r.user_role == "shop_manager" for r in rows)
    db.add.reset_mock()
    _patch_machine(machine, area, db, {FLOW: None})
    (row,) = _audit_rows(db)
    assert (row.parameter_key, row.action, row.old_value, row.new_value) == (FLOW, "clear", "voucher_first", None)


def test_an_unchanged_key_sent_again_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {FLOW: "both"})
    _patch_shop(shop, db, {FLOW: "both", "receiptPrinterName": "BB"})
    assert _audit_rows(db) == []
