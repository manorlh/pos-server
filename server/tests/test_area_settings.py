"""A point of sale's (shop area's) own settings: the layer between the shop and its tills.

Covers the merge order tenant → company → shop → area → till, the sync to the till
(values and watermark), the dashboard's GET/PATCH on `/areas/{id}/settings` with its
permissions and notify, the inherited view with the level each key comes from (also for
a till under an area), and the `payInstallmentsMax` key (2–36, managed, `null` resets).
Style matches tests/test_machine_settings.py: no database; handlers on mocked sessions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.user import User, UserRole
from app.routers.settings import (
    TIP_RESETTABLE_KEYS,
    get_area_settings,
    get_company_settings,
    get_machine_settings,
    patch_area_settings,
)
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.settings_merge import (
    MANAGED_SETTING_KEYS,
    effective_settings_updated_at,
    merge_all_settings_layers,
    settings_sources,
)


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


def _user(role: UserRole, shop_id=None) -> User:
    u = MagicMock(spec=User)
    u.role = role
    u.shop_id = shop_id
    return u


def _world(tenant_s, company_s, shop_s, area_s, machine_s, area_stamp=None):
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = tenant_s
    tenant.settings_updated_at = _ts()
    tenant.updated_at = _ts()

    company = MagicMock()
    company.id = uuid.uuid4()
    company.tenant_id = tenant.id
    company.settings = company_s
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
    shop.settings = shop_s
    shop.settings_updated_at = _ts()
    shop.updated_at = _ts()
    shop.branch_id = None
    shop.address = None
    shop.city = None

    area = MagicMock()
    area.id = uuid.uuid4()
    area.shop_id = shop.id
    area.tenant_id = tenant.id
    area.settings = area_s
    area.settings_updated_at = area_stamp

    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = shop.id
    machine.area_id = area.id
    machine.tenant_id = tenant.id
    machine.is_active = True
    machine.settings = machine_s
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


# ── Merge order ──────────────────────────────────────────────────────────────


def test_the_area_sits_between_the_shop_and_the_till():
    tenant, company, shop, area, machine, _ = _world(
        {"payInstallmentsMax": 3}, {"payInstallmentsMax": 6}, {"payInstallmentsMax": 12},
        {"payInstallmentsMax": 18, "payCardEnabled": False}, {},
    )
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert merged["payInstallmentsMax"] == 18
    assert merged["payCardEnabled"] is False
    # The till's own value still beats its area's.
    machine.settings = {"payInstallmentsMax": 24}
    assert merge_all_settings_layers(company, shop, tenant, machine, area)["payInstallmentsMax"] == 24
    # Without the area the shop's value shows.
    assert merge_all_settings_layers(company, shop, tenant)["payInstallmentsMax"] == 12


def test_sources_name_the_level_each_key_comes_from():
    layers = [
        ("tenant", {"payCashEnabled": True, "language": "he"}),
        ("company", {"payCashEnabled": False}),
        ("shop", None),
        ("area", {"payInstallmentsMax": 6}),
    ]
    assert settings_sources(layers) == {
        "payCashEnabled": "company",
        "language": "tenant",
        "payInstallmentsMax": "area",
    }


def test_a_change_at_the_area_moves_the_watermark():
    _, company, shop, area, machine, _ = _world({}, {}, {}, {}, {}, area_stamp=_ts(40))
    assert effective_settings_updated_at(company, shop, None, machine, area) == _ts(40)
    area.settings_updated_at = None
    assert effective_settings_updated_at(company, shop, None, machine, area) == _ts()


# ── Sync to the till ─────────────────────────────────────────────────────────


def _sync(machine, db, area, since=None):
    with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
        "app.routers.sync.machine_area_for_sync", return_value=(None, [])
    ), patch("app.routers.sync.get_area", return_value=area):
        return get_settings_sync(machine_id=str(machine.id), since=since, machine=machine, db=db)


def test_sync_carries_the_areas_values():
    _, _, _, area, machine, db = _world(
        {}, {}, {"payCardEnabled": True}, {"payCardEnabled": False, "payInstallmentsMax": 6}, {}
    )
    resp = _sync(machine, db, area)
    assert resp.settings["payCardEnabled"] is False
    assert resp.settings["payInstallmentsMax"] == 6


def test_a_delta_pull_after_an_area_change_is_not_unchanged():
    _, _, _, area, machine, db = _world({}, {}, {}, {"payInstallmentsMax": 6}, {}, area_stamp=_ts(30))
    assert _sync(machine, db, area, since=_ts(10).isoformat()).sync_type == "delta"
    assert _sync(machine, db, area, since=_ts(31).isoformat()).sync_type == "unchanged"


def test_unset_installments_are_not_sent():
    _, _, _, area, machine, db = _world({}, {}, {}, {}, {})
    assert "payInstallmentsMax" not in _sync(machine, db, area).settings


# ── Dashboard: GET/PATCH /areas/{id}/settings ────────────────────────────────


def test_get_returns_the_areas_own_settings_and_what_it_inherits_from_where():
    _, _, shop, area, _, db = _world(
        {"payFastCashEnabled": False}, {"payInstallmentsMax": 12}, {"payCardTips": True},
        {"payInstallmentsMax": 6}, {},
    )
    with patch("app.routers.settings.get_area", return_value=area):
        res = get_area_settings(
            area_id=str(area.id), include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER, shop.id), active_tenant_id=area.tenant_id, db=db,
        )
    assert res.settings == {"payInstallmentsMax": 6}
    assert res.effective["payInstallmentsMax"] == 12
    assert res.effective["payFastCashEnabled"] is False
    # Resolved: an unset option shows its default.
    assert res.effective["payCashEnabled"] is True
    assert res.effective_sources == {
        "payFastCashEnabled": "tenant",
        "payInstallmentsMax": "company",
        "payCardTips": "shop",
    }


def test_a_tills_inherited_view_includes_its_area():
    _, _, _, area, machine, db = _world({}, {"payCardEnabled": True}, {}, {"payCardEnabled": False}, {})
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True,
            current_user=_user(UserRole.SUPER_ADMIN), active_tenant_id=machine.tenant_id, db=db,
        )
    assert res.effective["payCardEnabled"] is False
    assert res.effective_sources["payCardEnabled"] == "area"


def test_a_companys_inherited_view_is_its_tenant():
    tenant, company, _, _, _, db = _world({"payManualCardEnabled": True}, {}, {}, {}, {})
    with patch("app.routers.settings._check_company_access"):
        res = get_company_settings(
            company_id=str(company.id), include_effective=True,
            current_user=_user(UserRole.SUPER_ADMIN), active_tenant_id=tenant.id, db=db,
        )
    assert res.effective["payManualCardEnabled"] is True
    assert res.effective_sources == {"payManualCardEnabled": "tenant"}


def _patch_area(area, shop, db, body, user=None):
    with patch("app.routers.settings.get_area", return_value=area), patch(
        "app.routers.settings.notify_machines_for_area_settings"
    ) as notify:
        res = patch_area_settings(
            area_id=str(area.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=user or _user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=area.tenant_id,
            db=db,
        )
    return res, notify


def test_patch_writes_the_areas_layer_stamps_it_and_tells_its_tills():
    _, _, shop, area, _, db = _world({}, {}, {}, {}, {})
    res, notify = _patch_area(area, shop, db, {"payCardEnabled": False, "payInstallmentsMax": 10})
    assert area.settings == {"payCardEnabled": False, "payInstallmentsMax": 10}
    assert isinstance(area.settings_updated_at, datetime)
    assert res.settings == area.settings
    notify.assert_called_once()
    assert notify.call_args.args[1] == str(area.id)


def test_null_resets_the_area_to_inherit():
    _, _, shop, area, _, db = _world({}, {}, {}, {"payCardEnabled": False, "payInstallmentsMax": 10}, {})
    _patch_area(area, shop, db, {"payCardEnabled": None, "payInstallmentsMax": None})
    assert area.settings == {}


def test_a_cashier_and_another_shops_manager_may_not_write_an_area():
    _, _, shop, area, _, db = _world({}, {}, {}, {}, {})
    for user in (_user(UserRole.CASHIER, shop.id), _user(UserRole.SHOP_MANAGER, uuid.uuid4())):
        with pytest.raises(HTTPException) as exc:
            _patch_area(area, shop, db, {"payCardEnabled": False}, user=user)
        assert exc.value.status_code == 403
    assert area.settings == {}


def test_an_area_cannot_be_left_without_a_payment_option():
    _, _, shop, area, _, db = _world({}, {}, {}, {}, {})
    off = {k: False for k in ("payFastCashEnabled", "payCashEnabled", "payFastCardEnabled", "payCardEnabled")}
    with pytest.raises(HTTPException) as exc:
        _patch_area(area, shop, db, off)
    assert exc.value.status_code == 422


def test_zscope_is_refused_at_an_area():
    _, _, shop, area, _, db = _world({}, {}, {}, {}, {})
    with pytest.raises(HTTPException):
        _patch_area(area, shop, db, {"zScope": "machine"})


def test_an_area_of_another_tenant_is_refused():
    _, _, shop, area, _, db = _world({}, {}, {}, {}, {})
    with patch("app.routers.settings.get_area", return_value=area):
        with pytest.raises(HTTPException) as exc:
            get_area_settings(
                area_id=str(area.id), include_effective=False,
                current_user=_user(UserRole.SUPER_ADMIN), active_tenant_id=uuid.uuid4(), db=db,
            )
    assert exc.value.status_code == 403


# ── payInstallmentsMax ───────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [2, 12, 36])
def test_installments_max_accepts_2_to_36(value):
    assert PosSettingsV1Patch.model_validate({"payInstallmentsMax": value}).pay_installments_max == value


@pytest.mark.parametrize("value", [0, 1, 37, "many"])
def test_installments_max_refuses_anything_else(value):
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({"payInstallmentsMax": value})


def test_installments_max_is_managed_and_resettable():
    assert "payInstallmentsMax" in MANAGED_SETTING_KEYS
    assert "payInstallmentsMax" in TIP_RESETTABLE_KEYS
