"""
The small gaps of the "נקודת מכירה" audit (P:/specs/area-coverage-audit.md), closed on the server:

* the alerts log / push feed — and so who is pushed (`exception_alerts/push.owner_may_see` uses the same
  query) — a manager of some points of sale sees their own points of sale and devices only;
* OPENFRMT (a shop's or a company's tax file) — never for a manager of some points of sale;
* tips — `areaId` (the shift's stamp), and a manager of points of sale sees their devices' tips only;
* the device's work configuration card — only their devices;
* remote approvals — an employee of other points of sale is not an approver for this till;
* dashboard permissions — a manager of points of sale grants only inside their own;
* the app-update rollout list — only their devices;
* the discounts / preset-discounts reports take `areaId`.

Runs on the world of tests/test_area_management.py (SQLite).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.exception_alerts import ExceptionLogEntry
from app.models.pos_user import PosUser
from app.services import area_scope
from test_area_management import _ctx, _forbidden, a  # noqa: F401
from test_main_till import w  # noqa: F401


def _entry(w, machine, kind="refund"):
    e = ExceptionLogEntry(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
        area_id=machine.area_id, machine_id=machine.id, kind=kind, source="test", dedupe_key=f"t:{uuid.uuid4()}",
        short_code=uuid.uuid4().hex[:10], occurred_at=datetime.now(timezone.utc),
    )
    w.db.add(e)
    w.db.flush()
    return e


class TestAlerts:
    def test_a_manager_of_the_bar_sees_and_is_pushed_the_bar_only(self, a):
        from app.routers.exception_log import scoped

        bar = _entry(a, a.t1)
        kitchen = _entry(a, a.t2)
        a.db.commit()
        area_scope.forget(a.db)
        seen = {e.id for e in scoped(a.db, a.ahmash, a.tenant.id).all()}
        assert bar.id in seen and kitchen.id not in seen
        area_scope.forget(a.db)
        everything = {e.id for e in scoped(a.db, a.manager, a.tenant.id).all()}
        assert {bar.id, kitchen.id} <= everything


class TestTaxFile:
    def test_never_for_a_manager_of_some_points_of_sale(self, a):
        from app.routers.tax_reports import _resolve_scope_entities

        area_scope.forget(a.db)
        e = _forbidden(
            _resolve_scope_entities, a.db, "shop", shop_id=str(a.shop.id), company_id=None,
            active_tenant_id=a.tenant.id, current_user=a.ahmash,
        )
        assert e.detail == "needs_whole_shop_scope"
        area_scope.forget(a.db)
        company, shop, _, sid = _resolve_scope_entities(
            a.db, "shop", shop_id=str(a.shop.id), company_id=None, active_tenant_id=a.tenant.id, current_user=a.manager,
        )
        assert sid == a.shop.id


class TestTips:
    def test_area_filter_and_reach(self, a):
        from app.routers import tips as R

        # The whole shop, by the shop manager; a point of sale of theirs, by the bar's manager.
        R.get_tips_report(str(a.shop.id), from_date=datetime.now().date(), to_date=None, shift_id=None,
                          area_id=None, **_ctx(a, a.manager))
        R.get_tips_report(str(a.shop.id), from_date=datetime.now().date(), to_date=None, shift_id=None,
                          area_id=str(a.bar.id), **_ctx(a, a.ahmash))
        _forbidden(R.get_tips_report, str(a.shop.id), from_date=datetime.now().date(), to_date=None, shift_id=None,
                   area_id=str(a.kitchen.id), **_ctx(a, a.ahmash))

    def test_the_service_narrows_to_the_devices(self, a):
        from app.services import tips as T

        out = T.build_tips_report(a.db, a.shop, from_date=datetime.now().date(), machine_ids={a.t1.id}, area_filter=a.bar.id)
        assert out is not None


class TestWorkConfig:
    def test_only_their_devices(self, a):
        from app.routers import work_config as R

        area_scope.forget(a.db)
        assert R._machine(a.db, a.t1.id, a.ahmash, a.tenant.id).id == a.t1.id
        area_scope.forget(a.db)
        _forbidden(R._machine, a.db, a.t2.id, a.ahmash, a.tenant.id)


class TestApprovals:
    def test_an_employee_of_other_points_of_sale_is_not_an_approver_here(self, a):
        from app.services.remote_approvals.eligibility import _employee_in_area

        pu = PosUser(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.shop.id, first_name="דנה", area_ids=[str(a.kitchen.id)])
        assert _employee_in_area(pu, a.t2) is True
        assert _employee_in_area(pu, a.t1) is False
        pu.area_ids = None
        assert _employee_in_area(pu, a.t1) is True
        # A till in no point of sale: anyone of the shop.
        assert _employee_in_area(SimpleNamespace(area_ids=[str(a.kitchen.id)]), SimpleNamespace(area_id=None)) is True


class TestGrants:
    def _values(self, **over):
        base = {"full_access": False, "sections": {}, "org_wide": False, "company_ids": [], "shop_ids": [],
                "area_ids": None, "machine_ids": None}
        base.update(over)
        return base

    def test_a_manager_of_the_bar_grants_the_bar_only(self, a):
        from app.routers.dashboard_access import check_grant

        area_scope.forget(a.db)
        check_grant(a.db, a.ahmash, self._values(area_ids=[str(a.bar.id)]), current=None)
        with pytest.raises(HTTPException) as e:
            check_grant(a.db, a.ahmash, self._values(area_ids=[str(a.kitchen.id)]), current=None)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            check_grant(a.db, a.ahmash, self._values(area_ids=[], machine_ids=[]), current=None)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException):
            check_grant(a.db, a.ahmash, self._values(machine_ids=[str(a.t2.id)]), current=None)


class TestRollout:
    def test_the_update_list_is_their_devices(self, a):
        from app.routers.app_releases import _rollout_machines

        area_scope.forget(a.db)
        ids = {m.id for m in _rollout_machines(a.db, a.ahmash, a.tenant.id).all()}
        assert a.t1.id in ids and a.t2.id not in ids
        area_scope.forget(a.db)
        ids = {m.id for m in _rollout_machines(a.db, a.manager, a.tenant.id).all()}
        assert {a.t1.id, a.t2.id} <= ids


class TestDiscountReports:
    def test_they_take_the_area(self, a):
        from app.routers import promotions as R

        today = datetime.now().date()
        common = dict(from_date=today, to_date=today, from_hour=None, to_hour=None, tz=None, shop_id=a.shop.id, machine_id=None)
        R.get_discounts_report(**common, area_id=str(a.bar.id), **_ctx(a, a.manager))
        R.get_preset_discounts_report(**common, preset_id=None, cashier_id=None, person=None, area_id=str(a.bar.id), **_ctx(a, a.manager))
        with pytest.raises(HTTPException) as e:
            R.get_discounts_report(**common, area_id="not-an-area", **_ctx(a, a.manager))
        assert e.value.status_code == 422
