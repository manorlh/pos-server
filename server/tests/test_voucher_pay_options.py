"""The production voucher ("שובר הפקה") on the till's payment screen, and voucher-only tills.

Two flat setting keys beside the five payment options (whose parity table in
tests/test_payment_options.py is unchanged): `payVoucherEnabled` — scanning the voucher —
and `payVoucherManualEnabled` — "שובר ידני", typing its code by hand. Both on when unset,
set at every level (tenant → company → shop → point of sale → till) and merged like the
`pay*Enabled` switches, and always sent to the till resolved, as real bools.

The rule they change: a layer may switch every cash and card option off while a voucher
switch stays on (a voucher-only till, "קופת שוברים בלבד"); a write is refused (422
`no_payment_option_allowed`) only when nothing at all is left. The Android till reads
these keys by name. Style matches the rest of tests/: no database; handlers on mocks.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.routers.settings import (
    NO_PAYMENT_OPTION_DETAIL,
    get_machine_settings,
    get_shop_settings,
    patch_area_settings,
    patch_machine_settings,
    patch_shop_settings,
    patch_tenant_settings,
)
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.payment_options import (
    DEFAULT_PAY_ORDER,
    PAYMENT_OPTION_SETTING_KEYS,
    PAYMENT_OPTIONS,
    VOUCHER_SETTING_KEYS,
    any_allowed,
    resolve_payment_options,
    resolve_voucher_options,
    voucher_allowed,
)
from app.services.settings_merge import (
    MANAGED_SETTING_KEYS,
    merge_all_settings_layers,
    patch_to_camel_dict,
)

SCAN = "payVoucherEnabled"
MANUAL = "payVoucherManualEnabled"

#: Every cash and card option off (manual card is off unless switched on; said anyway).
CASH_CARD_OFF = {o.allowed_key: False for o in PAYMENT_OPTIONS}
VOUCHER_OFF = {SCAN: False, MANUAL: False}
NOTHING_LEFT = {**CASH_CARD_OFF, **VOUCHER_OFF}


def _ts() -> datetime:
    return datetime(2026, 10, 11, 12, 0, 0, tzinfo=timezone.utc)


def _user(role: UserRole, shop_id=None) -> User:
    u = MagicMock(spec=User)
    u.role = role
    u.shop_id = shop_id
    return u


def _world(tenant_s=None, company_s=None, shop_s=None, area_s=None, machine_s=None):
    """tenant → company → shop → area → till, each layer's settings as given."""
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = tenant_s if tenant_s is not None else {}
    tenant.settings_updated_at = _ts()
    tenant.updated_at = _ts()

    company = MagicMock()
    company.id = uuid.uuid4()
    company.tenant_id = tenant.id
    company.settings = company_s if company_s is not None else {}
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
    shop.settings = shop_s if shop_s is not None else {}
    shop.settings_updated_at = _ts()
    shop.updated_at = _ts()
    shop.branch_id = None
    shop.address = None
    shop.city = None
    shop.training_mode = False

    area = MagicMock()
    area.id = uuid.uuid4()
    area.shop_id = shop.id
    area.tenant_id = tenant.id
    area.settings = area_s if area_s is not None else {}
    area.settings_updated_at = None

    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = shop.id
    machine.area_id = area.id
    machine.tenant_id = tenant.id
    machine.is_active = True
    machine.settings = machine_s if machine_s is not None else {}
    machine.settings_updated_at = None

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        q.filter.return_value.first.return_value = {
            "Shop": shop,
            "Company": company,
            "Tenant": tenant,
            "ShopArea": area,
        }.get(model.__name__)
        return q

    db.query.side_effect = query_side
    return tenant, company, shop, area, machine, db


def _sync(machine, db, area):
    with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
        "app.routers.sync.machine_area_for_sync", return_value=(None, [])
    ), patch("app.routers.sync.get_area", return_value=area):
        return get_settings_sync(machine_id=str(machine.id), since=None, machine=machine, db=db)


def _patch_tenant(tenant, db, body):
    with patch("app.routers.settings._can_manage_tenant", return_value=True), patch(
        "app.routers.settings.notify_machines_for_tenant_settings"
    ):
        return patch_tenant_settings(
            tenant_id=str(tenant.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.DISTRIBUTOR),
            db=db,
        )


def _patch_shop(shop, db, body):
    with patch("app.routers.settings._check_shop_settings_write"), patch(
        "app.routers.settings.notify_machines_for_shop_settings"
    ):
        return patch_shop_settings(
            shop_id=str(shop.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id,
            db=db,
        )


def _patch_area(area, shop, db, body):
    with patch("app.routers.settings.get_area", return_value=area), patch(
        "app.routers.settings.notify_machines_for_area_settings"
    ):
        return patch_area_settings(
            area_id=str(area.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=area.tenant_id,
            db=db,
        )


def _patch_machine(machine, area, db, body):
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ), patch("app.routers.settings.notify_machine_settings"):
        return patch_machine_settings(
            machine_id=str(machine.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=machine.tenant_id,
            db=db,
        )


def _assert_refused(exc_info) -> None:
    assert exc_info.value.status_code == 422
    # The same detail, the same shape: the dashboard matches on the code.
    assert exc_info.value.detail == NO_PAYMENT_OPTION_DETAIL
    assert set(exc_info.value.detail) == {"code", "msg"}
    assert exc_info.value.detail["code"] == "no_payment_option_allowed"


# ── The keys ─────────────────────────────────────────────────────────────────


def test_the_voucher_keys_are_the_contract() -> None:
    # The till reads these by name.
    assert VOUCHER_SETTING_KEYS == ("payVoucherEnabled", "payVoucherManualEnabled")


def test_the_voucher_keys_are_managed_and_therefore_synced() -> None:
    for key in VOUCHER_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS


def test_the_voucher_keys_are_a_rule_of_their_own_beside_the_five_options() -> None:
    # The five-option table (and its parity with the till) is untouched.
    assert not set(VOUCHER_SETTING_KEYS) & set(PAYMENT_OPTION_SETTING_KEYS)
    assert resolve_payment_options(VOUCHER_OFF) == resolve_payment_options({})
    assert set(resolve_payment_options(VOUCHER_OFF)) == set(PAYMENT_OPTION_SETTING_KEYS)


def test_the_pay_order_keeps_one_voucher_row() -> None:
    # Scanned or typed, it is the one "שובר" row on the payment screen.
    assert "voucher" in DEFAULT_PAY_ORDER
    assert not any(i.startswith("voucher") and i != "voucher" for i in DEFAULT_PAY_ORDER)


def test_patch_schema_accepts_both_keys_and_leaves_unsent_ones_unset() -> None:
    body = {SCAN: False, MANUAL: True}
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate(body)) == body
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({MANUAL: False})) == {MANUAL: False}


# ── Defaults ─────────────────────────────────────────────────────────────────


def test_both_are_on_when_nothing_sets_them() -> None:
    assert resolve_voucher_options({}) == {SCAN: True, MANUAL: True}
    assert voucher_allowed({}) is True


def test_each_switches_off_on_its_own() -> None:
    assert resolve_voucher_options({SCAN: False}) == {SCAN: False, MANUAL: True}
    assert resolve_voucher_options({MANUAL: False}) == {SCAN: True, MANUAL: False}
    assert resolve_voucher_options(VOUCHER_OFF) == {SCAN: False, MANUAL: False}
    assert voucher_allowed(VOUCHER_OFF) is False


@pytest.mark.parametrize("junk", ["false", "true", 0, 1, None, [], {}])
def test_a_non_bool_counts_as_unset(junk) -> None:
    # As for the five options: only a real JSON bool is a value (the till matches this).
    assert resolve_voucher_options({SCAN: junk, MANUAL: junk}) == {SCAN: True, MANUAL: True}


def test_resolving_does_not_mutate_the_merged_dict() -> None:
    merged = {SCAN: False}
    resolve_voucher_options(merged)
    assert merged == {SCAN: False}


# ── What keeps a till payable ────────────────────────────────────────────────


def test_a_voucher_only_till_is_payable() -> None:
    assert any_allowed(CASH_CARD_OFF) is True  # both voucher keys unset = on
    assert any_allowed({**CASH_CARD_OFF, MANUAL: False}) is True  # scanning only
    assert any_allowed({**CASH_CARD_OFF, SCAN: False}) is True  # "שובר ידני" only


def test_nothing_at_all_left_is_not() -> None:
    assert any_allowed(NOTHING_LEFT) is False


def test_any_cash_or_card_option_alone_still_keeps_a_till_payable() -> None:
    for option in PAYMENT_OPTIONS:
        assert any_allowed({**NOTHING_LEFT, option.allowed_key: True}) is True


# ── Inheritance ──────────────────────────────────────────────────────────────


def test_a_lower_layer_overrides_the_one_above() -> None:
    tenant, company, shop, area, machine, _ = _world(
        {SCAN: False}, {MANUAL: False}, {SCAN: True}, {MANUAL: True}, {SCAN: False}
    )
    assert resolve_voucher_options(merge_all_settings_layers(company, shop, tenant)) == {
        SCAN: True,
        MANUAL: False,
    }
    assert resolve_voucher_options(
        merge_all_settings_layers(company, shop, tenant, machine, area)
    ) == {SCAN: False, MANUAL: True}


def test_sync_sends_both_keys_resolved_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    settings = _sync(machine, db, area).settings
    assert settings[SCAN] is True
    assert settings[MANUAL] is True


def test_sync_carries_each_level_down_to_the_till() -> None:
    # The tenant switches typing off; the company scanning; the shop turns scanning back
    # on; the point of sale and the till leave both alone.
    _, _, _, area, machine, db = _world({MANUAL: False}, {SCAN: False}, {SCAN: True})
    settings = _sync(machine, db, area).settings
    assert settings[SCAN] is True
    assert settings[MANUAL] is False


def test_sync_point_of_sale_and_till_layers_win() -> None:
    _, _, _, area, machine, db = _world({}, {}, {}, {SCAN: False, MANUAL: False}, {MANUAL: True})
    settings = _sync(machine, db, area).settings
    assert settings[SCAN] is False  # the point of sale's
    assert settings[MANUAL] is True  # the till's own


def test_sync_sends_a_voucher_only_till_as_such() -> None:
    _, _, _, area, machine, db = _world({}, {}, CASH_CARD_OFF, {}, {SCAN: False})
    settings = _sync(machine, db, area).settings
    assert not any(settings[o.allowed_key] for o in PAYMENT_OPTIONS)
    assert settings[SCAN] is False
    assert settings[MANUAL] is True


def test_sync_never_writes_the_resolved_keys_back() -> None:
    tenant_s, shop_s = {"language": "he"}, {SCAN: False}
    _, _, _, area, machine, db = _world(tenant_s, {}, shop_s)
    _sync(machine, db, area)
    assert tenant_s == {"language": "he"}
    assert shop_s == {SCAN: False}


def test_the_dashboard_preview_shows_both_resolved_and_where_from() -> None:
    _, _, shop, _, _, db = _world({}, {SCAN: False}, {"receiptPrinterName": "BB"})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id),
            include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert res.effective[SCAN] is False
    assert res.effective[MANUAL] is True  # unset anywhere: the default
    assert res.effective_sources == {SCAN: "company"}
    # The shop's own settings stay raw, so the dashboard still reads them as inherited.
    assert res.settings == {"receiptPrinterName": "BB"}


def test_a_tills_preview_includes_its_point_of_sale() -> None:
    _, _, _, area, machine, db = _world({}, {}, {}, {MANUAL: False})
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id),
            include_effective=True,
            current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id,
            db=db,
        )
    assert res.effective[MANUAL] is False
    assert res.effective_sources[MANUAL] == "area"


# ── The 422: voucher-only allowed, nothing at all refused ────────────────────


def test_a_tenant_may_leave_only_the_voucher() -> None:
    tenant, _, _, _, _, db = _world()
    res = _patch_tenant(tenant, db, CASH_CARD_OFF)
    assert res.settings == CASH_CARD_OFF
    db.commit.assert_called_once()


def test_a_tenant_leaving_nothing_at_all_is_refused() -> None:
    tenant, _, _, _, _, db = _world()
    with pytest.raises(HTTPException) as exc:
        _patch_tenant(tenant, db, NOTHING_LEFT)
    _assert_refused(exc)
    assert tenant.settings == {}
    db.commit.assert_not_called()


def test_a_shop_may_switch_off_one_voucher_way_but_not_the_last() -> None:
    _, _, shop, _, _, db = _world({}, CASH_CARD_OFF, {})
    # Scanning off: typing the code is still there.
    _patch_shop(shop, db, {SCAN: False})
    assert shop.settings == {SCAN: False}
    # Typing off too would leave the shop's tills nothing: refused on a voucher key alone.
    with pytest.raises(HTTPException) as exc:
        _patch_shop(shop, db, {MANUAL: False})
    _assert_refused(exc)
    assert shop.settings == {SCAN: False}


def test_a_shop_switching_cash_and_card_off_under_an_inherited_voucher_is_allowed() -> None:
    _, _, shop, _, _, db = _world({}, {MANUAL: False}, {})
    res = _patch_shop(shop, db, CASH_CARD_OFF)
    assert res.settings == CASH_CARD_OFF


def test_a_point_of_sale_may_be_voucher_only_but_not_left_with_nothing() -> None:
    _, _, shop, area, _, db = _world()
    res = _patch_area(area, shop, db, {**CASH_CARD_OFF, MANUAL: False})
    assert res.settings == {**CASH_CARD_OFF, MANUAL: False}
    with pytest.raises(HTTPException) as exc:
        _patch_area(area, shop, db, {SCAN: False})
    _assert_refused(exc)
    assert area.settings == {**CASH_CARD_OFF, MANUAL: False}


def test_a_till_may_be_voucher_only_but_not_left_with_nothing() -> None:
    _, _, _, area, machine, db = _world()
    res = _patch_machine(machine, area, db, {**CASH_CARD_OFF, SCAN: False})
    assert res.settings == {**CASH_CARD_OFF, SCAN: False}
    with pytest.raises(HTTPException) as exc:
        _patch_machine(machine, area, db, {MANUAL: False})
    _assert_refused(exc)
    assert machine.settings == {**CASH_CARD_OFF, SCAN: False}


def test_null_resets_a_voucher_key_so_the_layer_inherits_again() -> None:
    _, company, shop, _, _, db = _world({}, {SCAN: True}, {SCAN: False, MANUAL: False})
    res = _patch_shop(shop, db, {SCAN: None})
    # Gone from the shop's own JSON — not stored as null, not stored as False.
    assert res.settings == {MANUAL: False}
    assert resolve_voucher_options(merge_all_settings_layers(company, shop))[SCAN] is True


def test_a_reset_that_would_leave_nothing_is_refused() -> None:
    # The shop's own True is all that keeps typing on; its parents left nothing else.
    _, _, shop, _, _, db = _world(NOTHING_LEFT, {}, {MANUAL: True})
    with pytest.raises(HTTPException) as exc:
        _patch_shop(shop, db, {MANUAL: None})
    _assert_refused(exc)
    assert shop.settings == {MANUAL: True}


def test_resending_unchanged_voucher_keys_does_not_trip_the_check() -> None:
    # Emptied from above (the check never looks down): the dashboard re-sends the shop's
    # own keys with every save, which must not block saving anything else.
    _, _, shop, _, _, db = _world({**CASH_CARD_OFF, MANUAL: False}, {}, {SCAN: False})
    res = _patch_shop(shop, db, {SCAN: False, "receiptPrinterName": "BB"})
    assert res.settings == {SCAN: False, "receiptPrinterName": "BB"}
