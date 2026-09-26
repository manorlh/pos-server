"""Sell-screen tools a till shows: search (sellSearchEnabled) and scan (sellScanEnabled).

Both are on unless a layer switches them off. The till reads the same rule in
Kotlin (posSettingsOf), so "unset or not a bool -> shown" is the contract with it.
Style matches the rest of tests/: no database, no client; handlers are called
directly with mocked sessions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.user import User, UserRole
from app.routers.settings import (
    _build_patch,
    get_shop_settings,
    patch_company_settings,
    patch_shop_settings,
    patch_tenant_settings,
)
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.sell_screen import SELL_SCREEN_SETTING_KEYS, resolve_sell_screen
from app.services.settings_merge import (
    MANAGED_SETTING_KEYS,
    merge_all_settings_layers,
    merge_settings,
)

SEARCH = "sellSearchEnabled"
SCAN = "sellScanEnabled"


def _ts() -> datetime:
    return datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)


def _user(role: UserRole) -> User:
    u = MagicMock(spec=User)
    u.role = role
    return u


def _hierarchy(tenant_settings, company_settings, shop_settings):
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = tenant_settings
    tenant.settings_updated_at = _ts()
    tenant.updated_at = _ts()

    company = MagicMock()
    company.id = uuid.uuid4()
    company.tenant_id = tenant.id if tenant_settings is not None else None
    company.settings = company_settings
    company.settings_updated_at = _ts()
    company.updated_at = _ts()
    company.name = "Co"
    company.vat_number = "1"
    company.address = "A"
    company.city = "C"

    shop = MagicMock()
    shop.id = uuid.uuid4()
    shop.company_id = company.id
    shop.tenant_id = tenant.id
    shop.settings = shop_settings
    shop.settings_updated_at = _ts()
    shop.updated_at = _ts()
    shop.branch_id = None
    shop.address = None
    shop.city = None

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        q.filter.return_value.first.return_value = {
            "Shop": shop,
            "Company": company,
            "Tenant": tenant if tenant_settings is not None else None,
        }.get(model.__name__)
        return q

    db.query.side_effect = query_side
    return tenant, company, shop, db


def _sync(company_settings: dict, shop_settings: dict, tenant_settings=None):
    _, _, shop, db = _hierarchy(tenant_settings, company_settings, shop_settings)
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = shop.id
    with patch("app.routers.sync.update_machine_sync_timestamp"):
        return get_settings_sync(machine_id=str(machine.id), since=None, machine=machine, db=db)


# ── Keys, schema, merge ──────────────────────────────────────────────────────

def test_the_keys_are_the_wire_names_the_till_and_dashboard_read() -> None:
    assert SELL_SCREEN_SETTING_KEYS == (SEARCH, SCAN)


def test_both_keys_are_managed_and_therefore_synced() -> None:
    for key in SELL_SCREEN_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS
    company = MagicMock()
    company.settings = {SEARCH: False, SCAN: True}
    assert merge_settings(company) == {SEARCH: False, SCAN: True}


def test_patch_schema_accepts_both_keys_and_leaves_unsent_ones_unset() -> None:
    data = PosSettingsV1Patch.model_validate({SEARCH: False})
    dumped = data.model_dump(exclude_unset=True, by_alias=True)
    assert dumped == {SEARCH: False}


def test_patch_schema_refuses_a_non_bool() -> None:
    with pytest.raises(Exception):
        PosSettingsV1Patch.model_validate({SCAN: "maybe"})


# ── Resolution ───────────────────────────────────────────────────────────────

def test_unset_resolves_to_shown() -> None:
    assert resolve_sell_screen({}) == {SEARCH: True, SCAN: True}


def test_false_resolves_to_hidden() -> None:
    assert resolve_sell_screen({SEARCH: False, SCAN: False}) == {SEARCH: False, SCAN: False}
    assert resolve_sell_screen({SEARCH: False}) == {SEARCH: False, SCAN: True}
    assert resolve_sell_screen({SCAN: False}) == {SEARCH: True, SCAN: False}


@pytest.mark.parametrize("junk", ["false", "False", 0, 1, None, "", [], {}])
def test_a_non_bool_value_counts_as_unset(junk) -> None:
    resolved = resolve_sell_screen({SEARCH: junk, SCAN: junk})
    assert resolved == {SEARCH: True, SCAN: True}
    for value in resolved.values():
        assert value is True


def test_resolving_does_not_mutate_the_merged_dict() -> None:
    merged = {SEARCH: "false"}
    resolve_sell_screen(merged)
    assert merged == {SEARCH: "false"}


# ── Sync to the till ─────────────────────────────────────────────────────────

def test_sync_carries_both_keys_as_true_when_nothing_is_set() -> None:
    resp = _sync({}, {})
    assert resp.settings[SEARCH] is True
    assert resp.settings[SCAN] is True


def test_sync_carries_false_when_a_layer_sets_it() -> None:
    resp = _sync({SEARCH: False}, {SCAN: False}, {})
    assert resp.settings[SEARCH] is False
    assert resp.settings[SCAN] is False


def test_sync_counts_a_stored_string_as_unset() -> None:
    # "false" is not a bool. Coercing it would need the till to coerce identically.
    resp = _sync({SEARCH: "false", SCAN: 0}, {})
    assert resp.settings[SEARCH] is True
    assert resp.settings[SCAN] is True


def test_a_non_bool_at_the_shop_does_not_hide_what_the_company_shows() -> None:
    # The shop's junk wins the merge as a value, and then reads as unset: shown.
    # It does not fall through to a parent's False either — unset means the default.
    resp = _sync({SEARCH: True}, {SEARCH: "no"})
    assert resp.settings[SEARCH] is True


def test_shop_overrides_company_in_both_directions() -> None:
    hidden_above = _sync({SEARCH: False, SCAN: False}, {SEARCH: True, SCAN: True})
    assert hidden_above.settings[SEARCH] is True
    assert hidden_above.settings[SCAN] is True

    shown_above = _sync({SEARCH: True, SCAN: True}, {SEARCH: False, SCAN: False})
    assert shown_above.settings[SEARCH] is False
    assert shown_above.settings[SCAN] is False


def test_company_overrides_tenant_and_tenant_reaches_the_till() -> None:
    assert _sync({}, {}, {SCAN: False}).settings[SCAN] is False
    assert _sync({SCAN: True}, {}, {SCAN: False}).settings[SCAN] is True


def test_sync_never_writes_resolved_values_back_to_any_layer() -> None:
    tenant = {"language": "he"}
    company = {SEARCH: False}
    shop = {}
    _sync(company, shop, tenant)
    assert tenant == {"language": "he"}
    assert company == {SEARCH: False}
    assert shop == {}


# ── Dashboard: shop preview resolved, the shop's own settings raw ─────────────

def test_shop_inherited_preview_is_resolved_and_shop_settings_stay_raw() -> None:
    _, _, shop, db = _hierarchy({}, {SCAN: False}, {"receiptPrinterName": "BB"})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id),
            include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert res.effective[SEARCH] is True  # unset above: shown
    assert res.effective[SCAN] is False
    # The shop set neither, so the dashboard must still see neither — that is how it
    # tells "inherited" from "overridden".
    assert res.settings == {"receiptPrinterName": "BB"}


# ── Reset to inherited: an explicit null removes the key from the layer ──────

def _patch_shop(shop, db, body: dict):
    with patch("app.routers.settings._check_shop_settings_write"), patch(
        "app.routers.settings.notify_machines_for_shop_settings"
    ):
        return patch_shop_settings(
            shop_id=str(shop.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )


def test_build_patch_keeps_an_explicit_null_for_both_keys() -> None:
    data = PosSettingsV1Patch.model_validate({SEARCH: None, SCAN: None, "language": None})
    # language is not a switch: its null is still dropped, as before.
    assert _build_patch(data, _user(UserRole.SHOP_MANAGER)) == {SEARCH: None, SCAN: None}


def test_null_resets_the_shop_so_it_inherits_again() -> None:
    _, company, shop, db = _hierarchy({}, {SEARCH: False, SCAN: False}, {})

    _patch_shop(shop, db, {SEARCH: True, SCAN: True})
    assert shop.settings == {SEARCH: True, SCAN: True}
    assert resolve_sell_screen(merge_all_settings_layers(company, shop)) == {
        SEARCH: True,
        SCAN: True,
    }

    res = _patch_shop(shop, db, {SEARCH: None})
    # Gone from the shop's own JSON: not stored as null, not stored as True or False.
    assert SEARCH not in shop.settings
    assert res.settings == {SCAN: True}
    resolved = resolve_sell_screen(merge_all_settings_layers(company, shop))
    assert resolved[SEARCH] is False  # the company's again
    assert resolved[SCAN] is True  # untouched override

    _patch_shop(shop, db, {SCAN: None})
    assert shop.settings == {}


def test_null_for_an_unset_key_changes_nothing() -> None:
    _, _, shop, db = _hierarchy({}, {}, {"receiptPrinterName": "BB"})
    res = _patch_shop(shop, db, {SCAN: None})
    assert res.settings == {"receiptPrinterName": "BB"}


def test_null_resets_at_the_company_and_the_tenant_too() -> None:
    tenant, company, _, db = _hierarchy({SEARCH: False}, {SCAN: False}, {})

    with patch("app.routers.settings._check_company_access"), patch(
        "app.routers.settings._check_company_settings_write"
    ), patch("app.routers.settings.notify_machines_for_company_settings"):
        patch_company_settings(
            company_id=str(company.id),
            data=PosSettingsV1Patch.model_validate({SCAN: None}),
            current_user=_user(UserRole.COMPANY_MANAGER),
            active_tenant_id=company.tenant_id,
            db=db,
        )
    assert SCAN not in company.settings

    with patch("app.routers.settings._can_manage_tenant", return_value=True), patch(
        "app.routers.settings.notify_machines_for_tenant_settings"
    ):
        patch_tenant_settings(
            tenant_id=str(tenant.id),
            data=PosSettingsV1Patch.model_validate({SEARCH: None}),
            current_user=_user(UserRole.DISTRIBUTOR),
            db=db,
        )
    assert SEARCH not in tenant.settings
