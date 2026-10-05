"""
Who may reach a till's Z and a till's sync paths (review S1, S2).

* **S1** — shop access admits any distributor to any shop of the tenant, so one could
  produce a Z over another distributor's tills, or read their candidates. A distributor
  now acts only on their own terminals (the per-till rule of a remote close) in
  candidates, create, get, proceed and cancel; a shop with no tenant is refused outright.
* **S2** — a dashboard (user) token on `/sync/{machineId}/…` skipped every tenant check.
  The till's shift writes (open, close, ack, last-closed) now take a machine token only;
  the other sync paths still accept a user token, bounded by the machine's tenant and,
  for a distributor, by ownership.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.middleware import auth as auth_mw
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.models.z_run import ZRunStatus
from app.routers import z_runs as router
from app.schemas.z_run import ZRunCreateIn, ZRunProceedIn
from app.services import ably_notify
from app.services.auth import create_machine_token
from shift_world import accept_str_uuids, make_world

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    world.dist_a = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=world.tenant.id, email="a@d", username="dist-a")
    world.dist_b = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=world.tenant.id, email="b@d", username="dist-b")
    world.db.add_all([world.dist_a, world.dist_b])
    world.db.flush()
    for till in world.tills:
        till.distributor_id = world.dist_a.id
    world.db.flush()
    return world


def _create(w, user, till):
    return router.post_z_run(
        ZRunCreateIn.model_validate({"shopId": str(w.shop.id), "machines": [{"machineId": str(till.id)}]}),
        current_user=user, active_tenant_id=w.tenant.id, db=w.db,
    )


def _waiting_run(w):
    w.shift(w.tills[0], 1, status=ShiftStatus.OPEN)
    w.db.commit()
    return _create(w, w.dist_a, w.tills[0])


class TestADistributorActsOnlyOnTheirOwnTills:
    def test_candidates_list_only_their_tills(self, w):
        w.shift(w.tills[0], 1)
        w.db.commit()

        mine = router.get_z_candidates(w.shop.id, current_user=w.dist_a, active_tenant_id=w.tenant.id, db=w.db)
        theirs = router.get_z_candidates(w.shop.id, current_user=w.dist_b, active_tenant_id=w.tenant.id, db=w.db)

        assert {m.machine_id for m in mine.machines} == {t.id for t in w.tills}
        assert theirs.machines == []

    def test_a_z_over_another_distributors_till_is_403(self, w):
        w.shift(w.tills[0], 1)
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            _create(w, w.dist_b, w.tills[0])
        assert e.value.status_code == 403

    def test_an_unknown_till_is_403_for_a_distributor(self, w):
        with pytest.raises(HTTPException) as e:
            router.post_z_run(
                ZRunCreateIn.model_validate({"shopId": str(w.shop.id), "machines": [{"machineId": str(uuid.uuid4())}]}),
                current_user=w.dist_b, active_tenant_id=w.tenant.id, db=w.db,
            )
        assert e.value.status_code == 403

    def test_the_owner_may(self, w):
        w.shift(w.tills[0], 1)
        w.db.commit()
        assert _create(w, w.dist_a, w.tills[0])["status"] == ZRunStatus.COMPLETED

    @pytest.mark.parametrize("call", ["get", "proceed", "cancel"])
    def test_another_distributors_run_is_403(self, w, call):
        created = _waiting_run(w)
        kw = dict(current_user=w.dist_b, active_tenant_id=w.tenant.id, db=w.db)
        with pytest.raises(HTTPException) as e:
            if call == "get":
                router.get_z_run(created["id"], **kw)
            elif call == "proceed":
                router.post_z_run_proceed(created["id"], ZRunProceedIn(), **kw)
            else:
                router.post_z_run_cancel(created["id"], **kw)
        assert e.value.status_code == 403

    def test_a_shop_with_no_tenant_is_refused_even_to_a_super_admin(self, w):
        orphan = Shop(id=uuid.uuid4(), tenant_id=None, company_id=w.company.id, name="Nowhere", settings={})
        w.db.add(orphan)
        w.db.flush()
        with pytest.raises(HTTPException) as e:
            router.get_z_candidates(orphan.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert (e.value.status_code, e.value.detail) == (403, "tenant_forbidden")


def _deps(path, method):
    from app.main import app

    for route in app.routes:
        if getattr(route, "path", None) == path and method in getattr(route, "methods", set()):
            found = set()

            def walk(d):
                for sub in d.dependencies:
                    found.add(sub.call)
                    walk(sub)

            walk(route.dependant)
            return found
    raise AssertionError(path)


class TestTheTillsShiftWritesTakeAMachineTokenOnly:
    @pytest.mark.parametrize(
        "path,method",
        [
            ("/api/v1/sync/{machine_id}/shifts", "POST"),
            ("/api/v1/sync/{machine_id}/shifts/last-closed", "GET"),
            ("/api/v1/sync/{machine_id}/shifts/{shift_id}/close", "POST"),
            ("/api/v1/sync/{machine_id}/shift-close/ack", "POST"),
        ],
    )
    def test_the_route_requires_the_machine_token(self, path, method):
        assert auth_mw.get_pos_machine_from_sync_machine_token in _deps(path, method)

    def test_a_user_token_is_refused(self, w):
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="a-dashboard-token")
        with pytest.raises(HTTPException) as e:
            auth_mw.get_pos_machine_from_sync_machine_token(str(w.tills[0].id), creds, w.db)
        assert (e.value.status_code, e.value.detail) == (403, "machine_token_required")

    def test_the_tills_own_token_passes_and_another_tills_does_not(self, w):
        till, other = w.tills
        token = create_machine_token(str(till.id), token_version=till.token_version or 1)
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

        assert auth_mw.get_pos_machine_from_sync_machine_token(str(till.id), creds, w.db) is till
        with pytest.raises(HTTPException) as e:
            auth_mw.get_pos_machine_from_sync_machine_token(str(other.id), creds, w.db)
        assert e.value.status_code == 403


class TestAUserTokenOnOtherSyncPathsStaysInItsTenant:
    def _member(self, w, role, tenant_id):
        u = User(id=uuid.uuid4(), role=role, email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:8])
        w.db.add(u)
        w.db.flush()
        if tenant_id is not None:
            w.db.add(TenantMembership(id=uuid.uuid4(), tenant_id=tenant_id, user_id=u.id, role=TenantMembershipRole.TENANT_ADMIN))
            w.db.flush()
        return u

    def test_a_distributor_needs_to_own_the_till(self, w):
        auth_mw._check_sync_user_tenancy(w.db, w.dist_a, w.tills[0])
        with pytest.raises(HTTPException) as e:
            auth_mw._check_sync_user_tenancy(w.db, w.dist_b, w.tills[0])
        assert e.value.status_code == 403

    def test_a_member_of_the_tenant_passes_and_an_outsider_does_not(self, w):
        insider = self._member(w, UserRole.COMPANY_MANAGER, w.tenant.id)
        outsider = self._member(w, UserRole.COMPANY_MANAGER, None)
        auth_mw._check_sync_user_tenancy(w.db, insider, w.tills[0])
        with pytest.raises(HTTPException) as e:
            auth_mw._check_sync_user_tenancy(w.db, outsider, w.tills[0])
        assert (e.value.status_code, e.value.detail) == (403, "tenant_forbidden")

    def test_a_till_with_no_tenant_admits_only_a_super_admin_or_its_distributor(self, w):
        till = w.tills[0]
        till.tenant_id = None
        insider = self._member(w, UserRole.COMPANY_MANAGER, w.tenant.id)
        auth_mw._check_sync_user_tenancy(w.db, w.admin, till)
        auth_mw._check_sync_user_tenancy(w.db, w.dist_a, till)
        with pytest.raises(HTTPException):
            auth_mw._check_sync_user_tenancy(w.db, insider, till)

    def test_the_sync_dependency_applies_it(self):
        import inspect

        assert "_check_sync_user_tenancy(" in inspect.getsource(auth_mw.get_pos_machine_for_sync_path)
