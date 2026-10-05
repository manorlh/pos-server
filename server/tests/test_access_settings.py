"""
"הרשאות": the super admin narrows, per role, the dashboard entries a role sees and the device
actions it may take — enforced by the routes for the device actions; never the super admin.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.platform_setting import PlatformSetting
from app.models.user import UserRole
from app.routers import system_access as R
from app.services import access
from shift_world import make_world

ADMIN = SimpleNamespace(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN)
DIST = SimpleNamespace(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR)
MANAGER = SimpleNamespace(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER)


@pytest.fixture
def db():
    return make_world().db


def test_nothing_is_hidden_until_the_super_admin_says(db):
    out = R.get_access(current_user=MANAGER, db=db)
    assert out["hiddenNav"] == {} and out["deniedFeatures"] == {}
    assert "pairDevices" in out["features"] and "super_admin" not in out["roles"]
    assert access.feature_allowed(db, DIST, access.PAIR_DEVICES)


def test_the_super_admin_hides_entries_and_takes_device_actions(db):
    body = R.AccessIn(
        hiddenNav={"company_manager": ["/dashboard/machines", "/dashboard/machines"], "nobody": ["/x"]},
        deniedFeatures={"distributor": ["pairDevices", "flying"], "company_manager": ["moveDevices"]},
    )
    out = R.put_access(body, current_user=ADMIN, db=db)
    # Cleaned: no unknown role, no unknown feature, no duplicates.
    assert out["hiddenNav"] == {"company_manager": ["/dashboard/machines"]}
    assert out["deniedFeatures"] == {"company_manager": ["moveDevices"], "distributor": ["pairDevices"]}
    with pytest.raises(HTTPException) as e:
        access.require_feature(db, DIST, access.PAIR_DEVICES)
    assert e.value.status_code == 403 and e.value.detail["code"] == "feature_not_allowed"
    # Never the super admin.
    access.require_feature(db, ADMIN, access.PAIR_DEVICES)
    assert db.get(PlatformSetting, "access") is not None


def test_only_the_super_admin_may_change_it(db):
    with pytest.raises(HTTPException) as e:
        R.put_access(R.AccessIn(), current_user=DIST, db=db)
    assert e.value.status_code == 403
