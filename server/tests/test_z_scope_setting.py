"""
The tenant's `zScope` setting, as the dashboard's tenant settings dialog writes it.

It decides whether the Z wizard may put several tills in one Z, so what is pinned is the
path the dashboard uses: it is stored at the tenant level by whoever may change the
tenant's other settings, refused anywhere else, and read back by the Z runs.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.user import User, UserRole
from app.routers.settings import _refuse_tenant_only_keys, patch_tenant_settings
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.z_runs import z_scope_of


def _tenant(settings=None):
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = settings if settings is not None else {}
    tenant.settings_updated_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = tenant
    return tenant, db


def _user(role: UserRole) -> User:
    u = MagicMock(spec=User)
    u.role = role
    return u


def _patch(tenant, db, body, *, may_manage=True, role=UserRole.COMPANY_MANAGER):
    with patch("app.routers.settings._can_manage_tenant", return_value=may_manage), patch(
        "app.routers.settings.notify_machines_for_tenant_settings"
    ):
        return patch_tenant_settings(
            tenant_id=str(tenant.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(role),
            db=db,
        )


def test_a_tenant_admin_switches_to_one_till_per_z_and_back() -> None:
    tenant, db = _tenant({"receiptPrinterName": "P1"})

    res = _patch(tenant, db, {"zScope": "machine"})

    assert res.settings == {"receiptPrinterName": "P1", "zScope": "machine"}
    assert z_scope_of(tenant) == "machine"

    _patch(tenant, db, {"zScope": "shop"})
    assert z_scope_of(tenant) == "shop"


def test_the_same_guard_as_the_other_tenant_settings() -> None:
    tenant, db = _tenant()

    with pytest.raises(HTTPException) as e:
        _patch(tenant, db, {"zScope": "machine"}, may_manage=False)

    assert e.value.status_code == 403
    assert z_scope_of(tenant) == "shop"


def test_it_has_no_company_or_shop_layer() -> None:
    with pytest.raises(HTTPException) as e:
        _refuse_tenant_only_keys(PosSettingsV1Patch.model_validate({"zScope": "machine"}))
    assert e.value.status_code == 400

    # A company or shop save without it still goes through.
    _refuse_tenant_only_keys(PosSettingsV1Patch.model_validate({"receiptPrinterName": "P"}))


def test_only_the_two_values_are_accepted() -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({"zScope": "company"})
