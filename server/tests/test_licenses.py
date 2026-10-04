"""
Customer licenses ("לקוח קבוע / זמני"): the super admin sets a temporary customer's end
date on an organization, company or shop; a till keeps the earliest end above it.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.user import UserRole
from app.services import licenses as L
from shift_world import make_world

ADMIN = SimpleNamespace(role=UserRole.SUPER_ADMIN)
DISTRIBUTOR = SimpleNamespace(role=UserRole.DISTRIBUTOR)


@pytest.fixture
def w():
    return make_world()


class TestSettingIt:
    def test_only_the_super_admin(self, w):
        with pytest.raises(HTTPException) as refused:
            L.apply_license(DISTRIBUTOR, w.shop, {"license_type": "temporary", "license_expires_on": date(2026, 12, 31)})
        assert refused.value.status_code == 403

    def test_a_temporary_customer_needs_an_end_date(self, w):
        with pytest.raises(HTTPException) as refused:
            L.apply_license(ADMIN, w.shop, {"license_type": "temporary"})
        assert refused.value.detail == "license_date_required"

    def test_permanent_clears_the_date_and_the_fields_leave_the_update(self, w):
        updates = {"name": "x", "license_type": "temporary", "license_expires_on": date(2026, 12, 31)}
        L.apply_license(ADMIN, w.shop, updates)
        assert updates == {"name": "x"}
        assert (w.shop.license_type, w.shop.license_expires_on) == ("temporary", date(2026, 12, 31))
        L.apply_license(ADMIN, w.shop, {"license_type": "permanent"})
        assert (w.shop.license_type, w.shop.license_expires_on) == ("permanent", None)

    def test_nothing_sent_on_create_is_not_a_change(self, w):
        L.apply_license(DISTRIBUTOR, w.shop, {"license_type": None, "license_expires_on": None}, creating=True)
        assert w.shop.license_type in (None, "permanent")


class TestTheTillsLicense:
    def test_permanent_by_default(self, w):
        assert L.effective_license(w.db, w.tills[0])["type"] == "permanent"

    def test_the_shops_end(self, w):
        L.apply_license(ADMIN, w.shop, {"license_type": "temporary", "license_expires_on": date(2026, 11, 1)})
        w.db.flush()
        out = L.effective_license(w.db, w.tills[0])
        assert out["type"] == "temporary" and out["expiresOn"] == "2026-11-01" and out["source"] == "shop"

    def test_the_earliest_end_above_the_till_wins(self, w):
        L.apply_license(ADMIN, w.shop, {"license_type": "temporary", "license_expires_on": date(2026, 11, 1)})
        L.apply_license(ADMIN, w.company, {"license_type": "temporary", "license_expires_on": date(2026, 10, 20)})
        L.apply_license(ADMIN, w.tenant, {"license_type": "temporary", "license_expires_on": date(2027, 1, 1)})
        w.db.flush()
        out = L.effective_license(w.db, w.tills[0])
        assert (out["expiresOn"], out["source"]) == ("2026-10-20", "company")

    def test_a_parent_companys_end_reaches_the_shops_of_its_subsidiaries(self, w):
        group = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Group")
        w.db.add(group)
        w.db.flush()
        w.company.parent_company_id = group.id
        L.apply_license(ADMIN, group, {"license_type": "temporary", "license_expires_on": date(2026, 10, 10)})
        w.db.flush()
        out = L.effective_license(w.db, w.tills[0])
        assert (out["expiresOn"], out["source"], out["name"]) == ("2026-10-10", "company", "Group")


class TestOneTill:
    """A till lent to an event out of a permanent shop: its own date, the other tills untouched."""

    def test_its_own_end_locks_it_alone(self, w):
        L.apply_license(ADMIN, w.tills[0], {"license_type": "temporary", "license_expires_on": date(2026, 10, 15)})
        w.db.flush()
        out = L.effective_license(w.db, w.tills[0])
        assert (out["type"], out["expiresOn"], out["source"]) == ("temporary", "2026-10-15", "machine")
        assert L.effective_license(w.db, w.tills[1])["type"] == "permanent"

    def test_an_earlier_shop_end_still_wins(self, w):
        L.apply_license(ADMIN, w.tills[0], {"license_type": "temporary", "license_expires_on": date(2026, 12, 1)})
        L.apply_license(ADMIN, w.shop, {"license_type": "temporary", "license_expires_on": date(2026, 11, 1)})
        w.db.flush()
        assert L.effective_license(w.db, w.tills[0])["source"] == "shop"

    def test_only_the_super_admin(self, w):
        with pytest.raises(HTTPException) as refused:
            L.apply_license(DISTRIBUTOR, w.tills[0], {"license_type": "temporary", "license_expires_on": date(2026, 12, 31)})
        assert refused.value.status_code == 403
