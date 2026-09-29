"""
The till's return-flow switches: unlinkedCardCreditEnabled (a card credit for a return
with no original receipt) and refundCustomerDetailsRequired (buyer details before a
credit note). Both on unless a layer switches them off; synced to the till always as a
real bool, and editable per tenant / company / shop with "reset to inherited".
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.user import User, UserRole
from app.routers.settings import _build_patch, get_shop_settings, patch_shop_settings
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.refund_settings import REFUND_SETTING_KEYS, resolve_refund_settings
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers

CARD = "unlinkedCardCreditEnabled"
DETAILS = "refundCustomerDetailsRequired"


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



def test_the_keys_are_the_wire_names_the_till_reads() -> None:
    assert REFUND_SETTING_KEYS == (CARD, DETAILS)
    for key in REFUND_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS


def test_patch_schema_accepts_bools_and_refuses_anything_else() -> None:
    assert PosSettingsV1Patch.model_validate({CARD: False}).model_dump(
        exclude_unset=True, by_alias=True
    ) == {CARD: False}
    with pytest.raises(Exception):
        PosSettingsV1Patch.model_validate({DETAILS: "maybe"})


@pytest.mark.parametrize("junk", ["false", 0, None, "", []])
def test_unset_or_not_a_bool_is_on(junk) -> None:
    assert resolve_refund_settings({}) == {CARD: True, DETAILS: True}
    assert resolve_refund_settings({CARD: junk, DETAILS: junk}) == {CARD: True, DETAILS: True}


def test_the_till_always_gets_both_as_real_bools() -> None:
    assert {k: _sync({}, {}).settings[k] for k in REFUND_SETTING_KEYS} == {CARD: True, DETAILS: True}
    resp = _sync({CARD: False}, {DETAILS: False}, {})
    assert (resp.settings[CARD], resp.settings[DETAILS]) == (False, False)


def test_shop_overrides_company_and_company_overrides_tenant() -> None:
    assert _sync({CARD: False}, {CARD: True}).settings[CARD] is True
    assert _sync({}, {}, {DETAILS: False}).settings[DETAILS] is False
    assert _sync({DETAILS: True}, {}, {DETAILS: False}).settings[DETAILS] is True


def test_the_dashboard_preview_is_resolved_and_the_shop_stays_raw() -> None:
    _, _, shop, db = _hierarchy({}, {CARD: False}, {})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER), active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[CARD], res.effective[DETAILS]) == (False, True)
    assert res.settings == {}


def test_an_explicit_null_resets_the_shop_to_inherited() -> None:
    _, company, shop, db = _hierarchy({}, {CARD: False}, {})
    assert _build_patch(
        PosSettingsV1Patch.model_validate({CARD: None, DETAILS: None}), _user(UserRole.SHOP_MANAGER)
    ) == {CARD: None, DETAILS: None}

    def _patch_shop(body):
        with patch("app.routers.settings._check_shop_settings_write"), patch(
            "app.routers.settings.notify_machines_for_shop_settings"
        ):
            patch_shop_settings(
                shop_id=str(shop.id), data=PosSettingsV1Patch.model_validate(body),
                current_user=_user(UserRole.SHOP_MANAGER), active_tenant_id=shop.tenant_id, db=db,
            )

    _patch_shop({CARD: True})
    assert resolve_refund_settings(merge_all_settings_layers(company, shop))[CARD] is True
    _patch_shop({CARD: None})
    assert CARD not in shop.settings
    assert resolve_refund_settings(merge_all_settings_layers(company, shop))[CARD] is False
