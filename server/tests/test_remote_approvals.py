"""
"בקשת אישור ממנהל מהנייד" (P:/specs/manager-approval-mobile.md) — the cloud side.

What could look fine while protecting nothing, and is therefore pinned here:

* **Eligibility** — one function for the list, the request, "שלח לעוד מאשר" and the decision:
  role (till role through "עובד מקושר", dashboard role), scope (the till's shop), the ceiling
  (policy, personal, the role's own — `limit_covers`), "רק במשמרת" (in the shop or the company),
  the employee card's overrides, `selfApprove`, the dashboard section, and the device rule.
* **Requests** — idempotent per till; only to eligible chosen approvers; 409/422 as §9 says.
* **Decisions** — the first wins; partial only where allowed and never above the ask; only by
  one it was sent to; never after expiry.
* **The grant** — one use, its own till, within its time, never above what was approved; also as
  an elevation token where the cloud already checks one.
* **The PIN path** — the cloud now enforces the limit when the till sends an amount; without one
  it is as before.
* **Settings** — field by field through the levels; only to a till with `remote_approval_v1`.
* **Push** — only the chosen approvers, past the rate limit, quiet hours unless asked otherwise,
  a replacing notice after the decision; and the expiry / escalation sweep.

Runs on in-memory SQLite (one connection), through the real app where the wire matters. Nothing
is sent: push is off (dispatch rows are still written), Ably is recorded.
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from shift_world import accept_str_uuids  # noqa: F401  (also JSONB on SQLite)
from app.database import Base, get_db
from app.main import app
from app.middleware import auth as auth_mw
from app.models.attendance import AttendanceShift
from app.models.company import Company
from app.models.dashboard_access import DashboardAccessProfile
from app.models.elevated_session import ElevatedSession
from app.models.exception_alerts import ExceptionAlertDispatch, ExceptionAlertRule, ExceptionLogEntry, PushSubscription
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.pos_user import PosUser, PosUserRole
from app.models.remote_approval import ApprovalPolicyValue, ApprovalRequest, DashboardUserEmployee
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.services import dashboard_access as DA
from app.services import elevation
from app.services import till_permissions as TP
from app.services import till_roles
from app.services.auth import create_access_token, create_machine_token, get_password_hash
from app.services.exception_alerts import push as PUSH
from app.services.remote_approvals import catalog as C
from app.services.remote_approvals import overrides as OV
from app.services.remote_approvals import policy as P
from app.services.remote_approvals import service as S
from app.services.remote_approvals.eligibility import Ask, eligible_approvers, evaluate

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
#: bcrypt is slow on purpose: one hash for every employee of every world.
PIN_HASH = get_password_hash("8317")


# ── The world ────────────────────────────────────────────────────────────────


class World(SimpleNamespace):
    pass


def _make_world() -> World:
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    for table in Base.metadata.sorted_tables:
        table.create(engine)
    db = sessionmaker(bind=engine)()
    w = World(db=db)
    w.tenant = Tenant(id=uuid.uuid4(), name="Royal", slug="royal", timezone="Asia/Jerusalem")
    db.add(w.tenant)
    db.flush()
    w.company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Royal Ltd")
    w.other_company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other Ltd")
    db.add_all([w.company, w.other_company])
    db.flush()
    w.shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Dizengoff", settings={})
    w.shop2 = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Ramat Aviv", settings={})
    w.shop_other = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.other_company.id, name="Elsewhere", settings={})
    db.add_all([w.shop, w.shop2, w.shop_other])
    db.flush()
    w.admin = _user(db, "admin", UserRole.SUPER_ADMIN, w.tenant)
    w.machine = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="קופה 2",
        machine_code="M-1", pos_number="2", is_active=True, pairing_status=PairingStatus.ASSIGNED,
        capabilities=["remote_approval_v1"],
    )
    w.machine2 = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="קופה 3",
        machine_code="M-2", pos_number="3", is_active=True, pairing_status=PairingStatus.ASSIGNED,
    )
    db.add_all([w.machine, w.machine2])
    db.flush()
    till_roles.ensure_company_roles(db, w.company)
    w.roles = {r.builtin_key: r for r in till_roles.roles_of(db, w.company.id) if r.builtin_key}

    # Till employees.
    w.dana = _pos_user(db, w, "dana", "Dana", TP.WAITER, w.shop)          # the waiter who asks
    w.ron_pu = _pos_user(db, w, "ron", "Ron", TP.MANAGER, w.shop)          # a manager at the shop
    w.avi_pu = _pos_user(db, w, "avi", "Avi", TP.SUPERVISOR, w.shop)       # a shift supervisor
    w.ron2_pu = _pos_user(db, w, "ron2", "Ron", TP.MANAGER, w.shop2)       # Ron at the other shop too

    # Dashboard users.
    w.ron = _user(db, "ron.d", UserRole.CASHIER, w.tenant, company=w.company)  # approves by his till role
    w.avi = _user(db, "avi.d", UserRole.CASHIER, w.tenant, company=w.company)
    w.cm = _user(db, "cm", UserRole.COMPANY_MANAGER, w.tenant, company=w.company)
    w.sm = _user(db, "sm", UserRole.SHOP_MANAGER, w.tenant, company=w.company, shop=w.shop)
    w.sm2 = _user(db, "sm2", UserRole.SHOP_MANAGER, w.tenant, company=w.company, shop=w.shop2)
    w.nosec = _user(db, "nosec", UserRole.SHOP_MANAGER, w.tenant, company=w.company, shop=w.shop)
    for u in (w.ron, w.avi):
        _profile(db, u, sections={"approvals": "edit"})
    for u in (w.cm, w.sm, w.sm2):
        _profile(db, u, full=True)
    _profile(db, w.nosec, sections={"reports": "view"})
    _link(db, w, w.ron, w.ron_pu)
    _link(db, w, w.ron, w.ron2_pu)
    _link(db, w, w.avi, w.avi_pu)
    for u in (w.ron, w.avi, w.cm, w.sm, w.sm2, w.nosec):
        _device(db, u)
    db.commit()
    return w


def _user(db, username, role, tenant, *, company=None, shop=None) -> User:
    u = User(
        id=uuid.uuid4(), username=username, email=f"{username}@example.com", role=role, tenant_id=tenant.id,
        company_id=company.id if company else None, shop_id=shop.id if shop else None, is_active=True,
    )
    db.add(u)
    db.flush()
    if role != UserRole.SUPER_ADMIN:
        db.add(TenantMembership(tenant_id=tenant.id, user_id=u.id, role=TenantMembershipRole.TENANT_MEMBER, is_default=True))
        db.flush()
    return u


def _pos_user(db, w, username, first, role_key, shop) -> PosUser:
    pu = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, username=username, first_name=first,
        pin_hash=PIN_HASH, role=PosUserRole.SHOP_MANAGER if role_key == TP.MANAGER else PosUserRole.CASHIER,
        till_role_id=w.roles[role_key].id, is_active=True,
    )
    db.add(pu)
    db.flush()
    return pu


def _profile(db, user, *, full=False, sections=None):
    db.add(DashboardAccessProfile(user_id=user.id, full_access=full, sections=dict(sections or {})))
    db.flush()
    DA.forget(db)


def _link(db, w, user, pu):
    db.add(DashboardUserEmployee(id=uuid.uuid4(), tenant_id=w.tenant.id, user_id=user.id, pos_user_id=pu.id))
    db.flush()


def _device(db, user):
    endpoint = f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}"
    db.add(PushSubscription(
        id=uuid.uuid4(), user_id=user.id, endpoint=endpoint, endpoint_hash=PUSH.endpoint_hash(endpoint),
        p256dh="p", auth="a",
    ))
    db.flush()


def _policy(db, w, level, ident, values):
    P.save_level(db, tenant_id=w.tenant.id, scope_type=level, scope_id=ident, payload=values, user_id=None, now=NOW)
    db.commit()


def _on(w, type_key="discount_basket", **fields):
    """The feature and one type on at the company, with the fields given."""
    _policy(w.db, w, "company", w.company.id, {"enabled": True, "types": {type_key: {"enabled": True, **fields}}})


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = _make_world()
    monkeypatch.setattr(auth_mw, "verify_clerk_token", lambda _token: None)
    monkeypatch.setattr(PUSH, "SEND_MODE", "off")
    world.ably = []
    from app.services import ably_notify

    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant_id, machine_id, event, body: world.ably.append((machine_id, event, body)),
    )
    monkeypatch.setattr(
        ably_notify, "publish_settings_notify",
        lambda tenant_id, machine_id, **kw: world.ably.append((machine_id, "settings", kw)),
    )

    def _db():
        yield world.db

    app.dependency_overrides[get_db] = _db
    world.client = TestClient(app, raise_server_exceptions=False)
    yield world
    app.dependency_overrides.pop(get_db, None)
    world.db.close()


def _till(w, machine=None) -> dict:
    m = machine or w.machine
    return {"Authorization": f"Bearer {create_machine_token(str(m.id), token_version=getattr(m, 'token_version', 1) or 1)}"}


def _dash(w, user) -> dict:
    return {
        "Authorization": f"Bearer {create_access_token({'sub': user.username})}",
        "X-Tenant-Id": str(w.tenant.id),
    }


def _ask(type_key="discount_basket", **kw) -> Ask:
    return Ask(type_key=type_key, **kw)


def _tp(w, type_key="discount_basket"):
    return P.for_machine(w.db, w.machine).type(type_key)


def _names(approvers):
    return {a.user.username for a in approvers}


def _body(**kw):
    base = dict(
        client_request_id=str(uuid.uuid4()), type="discount_basket", machine_id=None,
        requester_pos_user_id=None, approver_ids=None, amount=None, percent=30, reason_code="מנה לא טעימה",
        reason_text=None, note="השולחן חיכה שעה", payload={"table": {"name": "12"}, "lines": [{"name": "סלט", "qty": 2}]},
    )
    base.update(kw)
    return SimpleNamespace(**base)


# ── Settings: levels, inheritance, defaults ──────────────────────────────────


class TestPolicy:
    def test_off_by_default_with_the_spec_defaults(self, w):
        eff = P.for_machine(w.db, w.machine)
        assert eff.enabled is False
        refund = eff.type("refund")
        assert refund["enabled"] is False and refund["methods"] == ["pin", "remote"]
        assert refund["reasonMode"] == "required" and refund["allowPartial"] is True
        assert refund["reasons"] == list(C.REFUND_REASONS)
        assert eff.type("discount_basket")["reasons"] == list(C.DISCOUNT_REASONS)
        assert eff.type("drawer_open")["reasons"] == list(C.DRAWER_REASONS)
        assert eff.type("reprint")["reasonMode"] == "optional" and eff.type("reprint")["allowPartial"] is False
        assert eff.type("cash_out")["allowPartial"] is True
        for t in C.TYPE_KEYS:
            tp = eff.type(t)
            assert tp["timeoutSeconds"] == 180 and tp["selfApprove"] is True and tp["pickApprover"] == "optional"
            assert tp["quickApprove"] is False and tp["detailsInPush"] is True and tp["escalateAfterSeconds"] is None
            assert tp["approverRoles"] == ["till:manager", "till:legacy_manager", "dash:shop_manager", "dash:company_manager"]
        assert len(C.TYPES) == 33 and len(C.PHASE_1) == 16
        assert C.on_shift_only(refund, "till:supervisor") and C.on_shift_only(refund, "dash:shift_supervisor")
        assert not C.on_shift_only(refund, "till:manager")

    def test_field_by_field_most_specific_wins(self, w):
        _policy(w.db, w, "company", w.company.id, {"enabled": True, "types": {
            "discount_basket": {"enabled": True, "timeoutSeconds": 120, "reasons": ["א", "ב"]},
        }})
        _policy(w.db, w, "shop", w.shop.id, {"types": {"discount_basket": {"reasons": ["ג"]}}})
        _policy(w.db, w, "machine", w.machine.id, {"types": {"discount_basket": {"timeoutSeconds": 60}}})
        eff = P.for_machine(w.db, w.machine)
        tp = eff.type("discount_basket")
        assert eff.enabled is True and eff.enabled_source == "company"
        assert tp["enabled"] is True and tp["timeoutSeconds"] == 60 and tp["reasons"] == ["ג"]
        assert eff.sources["discount_basket"]["timeoutSeconds"] == "machine"
        assert eff.sources["discount_basket"]["reasons"] == "shop"
        assert eff.sources["discount_basket"]["enabled"] == "company"
        assert eff.sources["discount_basket"]["allowPartial"] is None
        # Another till of the shop: the shop's and the company's values, not the machine's.
        other = P.for_machine(w.db, w.machine2).type("discount_basket")
        assert other["timeoutSeconds"] == 120 and other["reasons"] == ["ג"]

    def test_a_lower_level_turns_off_what_a_higher_one_turned_on(self, w):
        _on(w)
        _policy(w.db, w, "shop", w.shop.id, {"enabled": False})
        assert P.for_machine(w.db, w.machine).enabled is False

    def test_escalation_zero_is_an_explicit_off(self, w):
        _policy(w.db, w, "company", w.company.id, {"types": {"refund": {"escalateAfterSeconds": 60}}})
        _policy(w.db, w, "shop", w.shop.id, {"types": {"refund": {"escalateAfterSeconds": 0}}})
        assert P.for_machine(w.db, w.machine).type("refund")["escalateAfterSeconds"] is None

    @pytest.mark.parametrize("bad", [
        {"types": {"nope": {"enabled": True}}},
        {"types": {"refund": {"nope": 1}}},
        {"types": {"refund": {"methods": []}}},
        {"types": {"refund": {"methods": ["sms"]}}},
        {"types": {"refund": {"timeoutSeconds": 5}}},
        {"types": {"refund": {"pickApprover": "always"}}},
        {"types": {"refund": {"approverRoles": ["manager"]}}},
        {"types": {"refund": {"limits": {"till:manager": {"maxAmount": -1}}}}},
        {"types": {"refund": {"reasons": ["x" * 61]}}},
        {"types": {"refund": {"escalateAfterSeconds": 5}}},
        {"enabled": "yes"},
        {"other": 1},
    ])
    def test_bad_values_are_refused(self, bad):
        with pytest.raises(P.PolicyValueError):
            P.clean_values(bad)

    def test_the_till_block_carries_only_enabled_types_and_their_till_fields(self, w):
        _on(w, "discount_basket", reasons=["מנה לא טעימה"])
        block = P.till_block(P.for_machine(w.db, w.machine))
        assert block["enabled"] is True and list(block["types"]) == ["discount_basket"]
        assert set(block["types"]["discount_basket"]) == set(P.TILL_FIELDS)
        assert block["types"]["discount_basket"]["timeoutSeconds"] == 180
        _policy(w.db, w, "company", w.company.id, {"enabled": False})
        assert P.till_block(P.for_machine(w.db, w.machine)) == {"enabled": False, "types": {}}

    def test_policy_endpoints_read_write_and_notify_capable_tills(self, w):
        r = w.client.put(
            f"/api/v1/approvals/policy?level=shop&id={w.shop.id}", headers=_dash(w, w.cm),
            json={"enabled": True, "types": {"refund": {"enabled": True, "timeoutSeconds": 90}}},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["own"] == {"enabled": True, "types": {"refund": {"enabled": True, "timeoutSeconds": 90}},
                               "approvalStyle": {}}
        assert body["effective"]["types"]["refund"]["timeoutSeconds"] == 90
        assert body["inherited"]["types"]["refund"]["timeoutSeconds"] == 180
        assert body["canWrite"] is True and len(body["catalog"]["types"]) == 33
        assert (str(w.machine.id), "settings", {"reason": "approval_requests"}) in w.ably
        assert not any(m == str(w.machine2.id) for m, *_ in w.ably)  # no capability: not told
        r = w.client.put(f"/api/v1/approvals/policy?level=shop&id={w.shop.id}", headers=_dash(w, w.cm),
                         json={"types": {"refund": {"timeoutSeconds": 1}}})
        assert r.status_code == 422
        # A shop manager of another shop reads nothing of this one.
        r = w.client.get(f"/api/v1/approvals/policy?level=shop&id={w.shop.id}", headers=_dash(w, w.sm2))
        assert r.status_code == 403
        # The "מאשר" template (approvals only) does not open the settings.
        r = w.client.get(f"/api/v1/approvals/policy?level=shop&id={w.shop.id}", headers=_dash(w, w.ron))
        assert r.status_code == 403


# ── Capability gating ────────────────────────────────────────────────────────


class TestCapability:
    def test_settings_sync_sends_the_block_only_to_a_capable_till(self, w):
        _on(w)
        r = w.client.get(f"/api/v1/sync/{w.machine.id}/settings", headers=_till(w))
        assert r.status_code == 200, r.text
        block = r.json()["settings"]["approvalRequests"]
        assert block["enabled"] is True and "discount_basket" in block["types"]
        r = w.client.get(f"/api/v1/sync/{w.machine2.id}/settings", headers=_till(w, w.machine2))
        assert r.status_code == 200, r.text
        assert "approvalRequests" not in r.json()["settings"]

    def test_a_policy_change_moves_the_watermark(self, w):
        r = w.client.get(f"/api/v1/sync/{w.machine.id}/settings", headers=_till(w))
        since = r.json()["settingsUpdatedAt"]
        r = w.client.get(f"/api/v1/sync/{w.machine.id}/settings", params={"since": since}, headers=_till(w))
        assert r.json()["syncType"] == "unchanged"
        later = datetime.now(timezone.utc) + timedelta(seconds=5)
        P.save_level(w.db, tenant_id=w.tenant.id, scope_type="shop", scope_id=w.shop.id,
                     payload={"enabled": True}, user_id=None, now=later)
        w.db.commit()
        r = w.client.get(f"/api/v1/sync/{w.machine.id}/settings", params={"since": since}, headers=_till(w))
        assert r.json()["syncType"] == "delta"
        assert r.json()["settings"]["approvalRequests"]["enabled"] is True

    def test_first_report_of_the_capability_tells_the_till_to_pull(self, w):
        w.machine2.capabilities = ["remote_approval_v1"]
        S.on_capabilities(w.db, w.machine2, ["training_mode_v1"])
        assert w.machine2.settings_updated_at is not None
        w.db.commit()
        assert (str(w.machine2.id), "settings", {"reason": "approval_requests"}) in w.ably
        w.ably.clear()
        S.on_capabilities(w.db, w.machine2, ["remote_approval_v1"])  # already had it
        w.db.commit()
        assert w.ably == []


# ── Eligibility ──────────────────────────────────────────────────────────────


class TestEligibility:
    def test_default_roles_and_scope(self, w):
        _on(w)
        names = _names(evaluate(w.db, w.machine, _ask(percent=30), _tp(w)))
        # Ron by his till role (manager), the company manager, the shop's own manager. Not the other
        # shop's manager (scope), not Avi (a supervisor is not among the default roles), not a user
        # without the "approvals" section.
        assert names == {"ron.d", "cm", "sm"}

    def test_role_path_details(self, w):
        _on(w)
        by = {a.user.username: a for a in evaluate(w.db, w.machine, _ask(percent=30), _tp(w))}
        assert by["ron.d"].role_key == "till:manager" and by["ron.d"].name == "Ron"
        assert by["ron.d"].pos_user_id == w.ron_pu.id
        assert by["cm"].role_key == "dash:company_manager" and by["cm"].pos_user_id is None

    def test_the_till_permission_must_allow_it(self, w):
        _on(w)
        role = w.roles[TP.MANAGER]
        role.permissions = {"APPROVE_REMOTE.discount_basket": "deny"}
        w.db.commit()
        assert "ron.d" not in _names(evaluate(w.db, w.machine, _ask(percent=30), _tp(w)))

    def test_policy_limit_per_role(self, w):
        _on(w, "refund", limits={"till:manager": {"maxAmount": 500}})
        tp = _tp(w, "refund")
        assert "ron.d" not in _names(evaluate(w.db, w.machine, _ask("refund", amount=2000), tp))
        assert "ron.d" in _names(evaluate(w.db, w.machine, _ask("refund", amount=400), tp))
        # A refund amount comes negative from some screens: the size is what counts.
        assert "ron.d" in _names(evaluate(w.db, w.machine, _ask("refund", amount=-400), tp))

    def test_the_roles_own_approve_limit(self, w):
        _on(w, "refund")
        role = w.roles[TP.MANAGER]
        role.limits = {"APPROVE_REMOTE.refund": {"maxAmount": 500}}
        w.db.commit()
        assert "ron.d" not in _names(evaluate(w.db, w.machine, _ask("refund", amount=2000), _tp(w, "refund")))

    def test_personal_limit_overrides_the_role(self, w):
        _on(w, "refund", limits={"till:manager": {"maxAmount": 500}})
        OV.write(w.ron_pu, {"types": {"refund": {"maxAmount": 3000}}})
        w.db.commit()
        assert "ron.d" in _names(evaluate(w.db, w.machine, _ask("refund", amount=2000), _tp(w, "refund")))

    def test_the_existing_limit_of_the_underlying_permission_by_default(self, w):
        # A supervisor's DISCOUNT is "up to 30%" in the spec's defaults: that is their ceiling here too.
        _on(w, approverRoles=["till:supervisor"], onShiftOnly={"till:supervisor": False})
        tp = _tp(w)
        assert "avi.d" in _names(evaluate(w.db, w.machine, _ask(percent=25), tp))
        assert "avi.d" not in _names(evaluate(w.db, w.machine, _ask(percent=35), tp))

    def test_on_shift_only_in_the_shop_or_the_company(self, w):
        _on(w, approverRoles=["till:supervisor"])
        tp = _tp(w)
        assert _names(evaluate(w.db, w.machine, _ask(percent=10), tp)) == set()  # not on shift
        shift = AttendanceShift(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop2.id, pos_user_id=w.avi_pu.id,
            clock_in_at=NOW - timedelta(hours=1), status="working",
        )
        w.db.add(shift)
        w.db.commit()
        assert _names(evaluate(w.db, w.machine, _ask(percent=10), tp)) == set()  # on shift elsewhere
        _on(w, approverRoles=["till:supervisor"], onShiftScope="company")
        on = evaluate(w.db, w.machine, _ask(percent=10), _tp(w))
        assert _names(on) == {"avi.d"} and on[0].on_shift is True
        shift.clock_out_at = NOW
        w.db.commit()
        assert _names(evaluate(w.db, w.machine, _ask(percent=10), _tp(w))) == set()

    def test_on_shift_in_this_shop(self, w):
        _on(w, approverRoles=["till:supervisor"])
        w.db.add(AttendanceShift(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, pos_user_id=w.avi_pu.id,
            clock_in_at=NOW - timedelta(hours=1), status="working",
        ))
        w.db.commit()
        assert _names(evaluate(w.db, w.machine, _ask(percent=10), _tp(w))) == {"avi.d"}

    def test_off_shift_override(self, w):
        _on(w, approverRoles=["till:supervisor"])
        OV.write(w.avi_pu, {"all": {"offShift": True}})
        w.db.commit()
        hits = evaluate(w.db, w.machine, _ask(percent=10), _tp(w))
        assert _names(hits) == {"avi.d"} and hits[0].on_shift is False

    def test_no_requests_override(self, w):
        _on(w)
        OV.write(w.ron_pu, {"types": {"discount_basket": {"noRequests": True}}})
        w.db.commit()
        assert "ron.d" not in _names(evaluate(w.db, w.machine, _ask(percent=10), _tp(w)))
        assert "ron.d" in _names(evaluate(w.db, w.machine, _ask("refund", amount=10), _tp(w, "refund")))

    def test_self_approve_on_by_default_and_off_when_set(self, w):
        _on(w)
        ask = _ask(percent=10, requester_pos_user_id=w.ron_pu.id)
        assert "ron.d" in _names(evaluate(w.db, w.machine, ask, _tp(w)))
        _on(w, selfApprove=False)
        assert "ron.d" not in _names(evaluate(w.db, w.machine, ask, _tp(w)))
        assert "cm" in _names(evaluate(w.db, w.machine, ask, _tp(w)))

    def test_dashboard_role_limits(self, w):
        _on(w, "refund", limits={"dash:company_manager": {"maxAmount": 100}})
        assert "cm" not in _names(evaluate(w.db, w.machine, _ask("refund", amount=200), _tp(w, "refund")))
        assert "cm" in _names(evaluate(w.db, w.machine, _ask("refund", amount=50), _tp(w, "refund")))

    def test_installments_are_limited_by_their_count(self, w):
        _on(w, "installments_over", limits={"dash:company_manager": {"maxCount": 6}})
        tp = _tp(w, "installments_over")
        assert "cm" not in _names(evaluate(w.db, w.machine, _ask("installments_over", amount=900, count=12), tp))
        assert "cm" in _names(evaluate(w.db, w.machine, _ask("installments_over", amount=900, count=6), tp))
        req, _ = S.create(w.db, w.machine, _body(type="installments_over", percent=None, amount=900,
                                                 payload={"installments": 12}), now=NOW)
        assert str(w.cm.id) not in S.sent_to_ids(req) and S.count_of(req) == 12

    def test_devices_are_a_flag_unless_nobody_has_one(self, w):
        _on(w)
        w.db.query(PushSubscription).filter(PushSubscription.user_id.in_([w.cm.id, w.sm.id])).delete(
            synchronize_session=False
        )
        w.db.commit()
        listed = {a.user.username: a.has_device for a in eligible_approvers(w.db, w.machine, _ask(percent=10), _tp(w))}
        assert listed == {"ron.d": True, "cm": False, "sm": False}
        w.db.query(PushSubscription).delete(synchronize_session=False)
        w.db.commit()
        assert eligible_approvers(w.db, w.machine, _ask(percent=10), _tp(w)) == []

    def test_approvers_endpoint(self, w):
        _on(w)
        r = w.client.get("/api/v1/approvals/approvers", params={"type": "discount_basket", "percent": 30,
                                                                "machineId": str(w.machine.id)}, headers=_till(w))
        assert r.status_code == 200, r.text
        assert {i["name"] for i in r.json()} >= {"Ron"}
        assert set(r.json()[0]) == {"approverId", "name", "role", "onShift", "hasDevice"}
        r = w.client.get("/api/v1/approvals/approvers", params={"type": "refund"}, headers=_till(w))
        assert r.status_code == 409 and r.json()["detail"] == "remote_disabled"
        r = w.client.get("/api/v1/approvals/approvers", params={"type": "discount_basket",
                                                                "machineId": str(w.machine2.id)}, headers=_till(w))
        assert r.status_code == 403 and r.json()["detail"] == "machine_mismatch"
        # A dashboard token is not a till.
        r = w.client.get("/api/v1/approvals/approvers", params={"type": "discount_basket"}, headers=_dash(w, w.cm))
        assert r.status_code == 401


# ── Creating ─────────────────────────────────────────────────────────────────


class TestCreate:
    def test_idempotent_per_till(self, w):
        _on(w)
        body = {"clientRequestId": "c-1", "type": "discount_basket", "machineId": str(w.machine.id),
                "requesterPosUserId": str(w.dana.id), "approverIds": None, "percent": 30,
                "reasonCode": "מנה לא טעימה", "note": "חיכו שעה", "payload": {"table": {"name": "12"}}}
        first = w.client.post("/api/v1/approvals", json=body, headers=_till(w))
        assert first.status_code == 201, first.text
        again = w.client.post("/api/v1/approvals", json={**body, "percent": 50}, headers=_till(w))
        assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
        assert w.db.query(ApprovalRequest).count() == 1
        out = first.json()
        assert out["status"] == "pending" and set(out) == {"id", "clientRequestId", "status", "sentTo", "expiresAt"}
        assert {s["name"] for s in out["sentTo"]} >= {"Ron"}
        req = w.db.get(ApprovalRequest, uuid.UUID(out["id"]))
        assert req.requester_name == "Dana" and float(req.percent) == 30
        assert S.aware(req.expires_at) - S.aware(req.created_at) == timedelta(seconds=180)
        entry = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "approval_requested").one()
        assert entry.details["requestId"] == out["id"] and entry.pos_user_name == "Dana"

    def test_a_display_device_cannot_ask(self, w):
        _on(w)
        w.machine.is_fiscal = False
        w.db.commit()
        r = w.client.post("/api/v1/approvals", headers=_till(w), json={
            "clientRequestId": "kds-1", "type": "discount_basket", "percent": 10, "reasonCode": "x",
        })
        assert r.status_code == 403 and "device_not_fiscal" in r.text

    def test_only_to_the_chosen_eligible_approvers(self, w):
        _on(w)
        req, created = S.create(w.db, w.machine, _body(approver_ids=[w.ron.id]), now=NOW)
        w.db.commit()
        assert created and S.sent_to_ids(req) == [str(w.ron.id)]
        sent = {d.user_id for d in w.db.query(ExceptionAlertDispatch).all()}
        assert sent == {w.ron.id}

    def test_a_chosen_approver_who_is_not_eligible_is_no_approver(self, w):
        _on(w)
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(approver_ids=[w.sm2.id]), now=NOW)
        assert e.value.status_code == 422 and e.value.detail == "no_approvers"

    def test_refusals(self, w):
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(), now=NOW)
        assert (e.value.status_code, e.value.detail) == (409, "remote_disabled")
        _on(w, methods=["pin"])
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(), now=NOW)
        assert e.value.detail == "remote_disabled"
        _on(w)
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(type="nope"), now=NOW)
        assert (e.value.status_code, e.value.detail) == (422, "unknown_type")
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(reason_code=None), now=NOW)
        assert e.value.detail == "reason_required"
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(requester_pos_user_id=w.ron2_pu.id), now=NOW)
        assert e.value.detail == "invalid_requester"
        _on(w, pickApprover="required")
        with pytest.raises(HTTPException) as e:
            S.create(w.db, w.machine, _body(), now=NOW)
        assert e.value.detail == "approver_required"

    def test_pick_off_sends_to_all_and_note_off_drops_it(self, w):
        _on(w, pickApprover="off", noteToManager=False, reasonMode="off")
        req, _ = S.create(w.db, w.machine, _body(approver_ids=[w.ron.id]), now=NOW)
        assert set(S.sent_to_ids(req)) == {str(w.ron.id), str(w.cm.id), str(w.sm.id)}
        assert req.note is None and req.reason_code is None

    def test_add_approvers(self, w):
        _on(w)
        req, _ = S.create(w.db, w.machine, _body(approver_ids=[w.ron.id]), now=NOW)
        added = S.add_approvers(w.db, w.machine, req, [w.cm.id], now=NOW)
        assert [a.user_id for a in added] == [w.cm.id]
        assert set(S.sent_to_ids(req)) == {str(w.ron.id), str(w.cm.id)}
        added = S.add_approvers(w.db, w.machine, req, None, now=NOW)
        assert [a.user_id for a in added] == [w.sm.id]
        with pytest.raises(HTTPException) as e:
            S.add_approvers(w.db, w.machine, req, None, now=NOW)
        assert e.value.detail == "no_approvers"

    def test_cancel(self, w):
        _on(w)
        req, _ = S.create(w.db, w.machine, _body(), now=NOW)
        w.db.commit()
        r = w.client.delete(f"/api/v1/approvals/{req.id}", headers=_till(w))
        assert r.status_code == 200 and r.json()["status"] == "cancelled"
        assert w.client.delete(f"/api/v1/approvals/{req.id}", headers=_till(w)).status_code == 200
        assert any(e == S.ABLY_EVENT and b["status"] == "cancelled" for _, e, b in w.ably)
        assert w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "approval_cancelled").count() == 1
        # Another till cannot touch it.
        assert w.client.delete(f"/api/v1/approvals/{req.id}", headers=_till(w, w.machine2)).status_code == 404


# ── Deciding ─────────────────────────────────────────────────────────────────


def _pending(w, **kw):
    _on(w, kw.get("type", "discount_basket"), **kw.pop("policy", {}))
    req, _ = S.create(w.db, w.machine, _body(**kw), now=S.utcnow())
    w.db.commit()
    return req


class TestDecide:
    def test_first_decision_wins(self, w):
        req = _pending(w)
        r = w.client.post(f"/api/v1/approvals/{req.id}/decide", headers=_dash(w, w.ron),
                          json={"decision": "approve", "message": "בסדר"})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "approved" and r.json()["decidedByName"] == "Ron"
        r = w.client.post(f"/api/v1/approvals/{req.id}/decide", headers=_dash(w, w.cm), json={"decision": "reject"})
        assert r.status_code == 409 and r.json()["detail"] == "already_decided"
        w.db.refresh(req)
        assert req.status == "approved" and req.decided_by_user_id == w.ron.id and req.message == "בסדר"
        events = [b for _, e, b in w.ably if e == S.ABLY_EVENT]
        assert len(events) == 1 and events[0]["status"] == "approved" and "grantId" not in events[0]

    def test_partial_approval(self, w):
        req = _pending(w)
        r = w.client.post(f"/api/v1/approvals/{req.id}/decide", headers=_dash(w, w.ron),
                          json={"decision": "approve", "approvedPercent": 20})
        assert r.status_code == 200, r.text
        assert r.json()["approvedPercent"] == 20
        till = w.client.get(f"/api/v1/approvals/{req.id}", headers=_till(w)).json()
        assert till["status"] == "approved" and till["approvedPercent"] == 20 and till["decidedBy"] == "Ron"
        assert till["decidedByUserId"] == str(w.ron.id) and till["decidedByPosUserId"] == str(w.ron_pu.id)
        assert till["grantId"]

    def test_partial_only_where_allowed_and_never_above(self, w):
        req = _pending(w, policy={"allowPartial": False})
        with pytest.raises(HTTPException) as e:
            S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", approved_percent=20)
        assert e.value.detail == "partial_not_allowed"
        w.db.rollback()
        with pytest.raises(HTTPException) as e:
            S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", approved_percent=40)
        assert e.value.detail == "invalid_amount"
        w.db.rollback()
        # The full amount is always fine.
        S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", approved_percent=30)
        assert req.status == "approved"

    def test_only_one_it_was_sent_to(self, w):
        req = _pending(w, approver_ids=[w.ron.id])
        r = w.client.post(f"/api/v1/approvals/{req.id}/decide", headers=_dash(w, w.cm), json={"decision": "approve"})
        assert r.status_code == 403 and r.json()["detail"] == "not_allowed"

    def test_rechecked_at_decision_time(self, w):
        req = _pending(w, approver_ids=[w.ron.id])
        OV.write(w.ron_pu, {"all": {"noRequests": True}})
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve")
        assert e.value.detail == "not_allowed"

    def test_never_after_expiry(self, w):
        req = _pending(w)
        later = S.aware(req.expires_at) + timedelta(seconds=1)
        with pytest.raises(HTTPException) as e:
            S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", now=later)
        assert (e.value.status_code, e.value.detail) == (409, "expired")
        w.db.refresh(req)
        assert req.status == "expired"

    def test_reject(self, w):
        req = _pending(w)
        S.decide(w.db, req.id, w.cm, tenant_id=w.tenant.id, decision="reject", message="לא הפעם")
        w.db.commit()
        till = w.client.get(f"/api/v1/approvals/{req.id}", headers=_till(w)).json()
        assert till["status"] == "rejected" and till["grantId"] is None and till["message"] == "לא הפעם"
        assert w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "approval_rejected").count() == 1

    def test_dashboard_list_detail_and_count(self, w):
        req = _pending(w, approver_ids=[w.ron.id])
        r = w.client.get("/api/v1/approvals/pending-count", headers=_dash(w, w.ron))
        assert r.json() == {"count": 1}
        assert w.client.get("/api/v1/approvals/pending-count", headers=_dash(w, w.cm)).json() == {"count": 0}
        r = w.client.get("/api/v1/approvals", params={"status": "pending"}, headers=_dash(w, w.ron))
        assert r.status_code == 200, r.text
        assert [i["id"] for i in r.json()["items"]] == [str(req.id)] and r.json()["items"][0]["canDecide"]
        # The company manager sees it (scope) but may not decide it (not sent to them).
        items = w.client.get("/api/v1/approvals", params={"status": "pending"}, headers=_dash(w, w.cm)).json()["items"]
        assert [i["canDecide"] for i in items] == [False]
        detail = w.client.get(f"/api/v1/approvals/{req.id}", headers=_dash(w, w.ron)).json()
        assert detail["tableLabel"] == "12" and detail["allowPartial"] is True and detail["limitUnit"] == "percent"
        assert "grantId" not in detail
        # Another shop's manager sees nothing of it.
        assert w.client.get(f"/api/v1/approvals/{req.id}", headers=_dash(w, w.sm2)).status_code == 404
        S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve")
        w.db.commit()
        hist = w.client.get("/api/v1/approvals", params={"status": "all", "outcome": "approved"},
                            headers=_dash(w, w.cm)).json()
        assert hist["total"] == 1 and hist["items"][0]["decidedByName"] == "Ron"


@pytest.mark.skipif(
    os.environ.get("RUN_PG_APPROVAL_RACES") != "1" or not os.environ.get("DATABASE_URL", "").startswith("postgresql"),
    reason="opt-in: RUN_PG_APPROVAL_RACES=1 with a scratch Postgres DATABASE_URL",
)
def test_first_decision_wins_under_a_real_race(monkeypatch):
    """Two approvers at the same instant, on Postgres: the row lock lets exactly one through."""
    from sqlalchemy import text

    from app.services import ably_notify

    monkeypatch.setattr(PUSH, "SEND_MODE", "off")
    monkeypatch.setattr(ably_notify, "publish_notify", lambda *a, **k: None)
    # A schema of its own in the scratch database, made fresh and dropped after: the tables are
    # exactly today's models, whatever an older `create_all` left in `public`.
    schema = f"approvals_race_{uuid.uuid4().hex[:8]}"
    admin = create_engine(os.environ["DATABASE_URL"])
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(os.environ["DATABASE_URL"], pool_size=5,
                           connect_args={"options": f"-csearch_path={schema}"})
    try:
        _race(engine)
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _race(engine):
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()
    tenant = Tenant(id=uuid.uuid4(), name="Race", slug=f"race-{uuid.uuid4().hex[:8]}", timezone="Asia/Jerusalem")
    db.add(tenant)
    db.flush()
    company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="Race Ltd")
    db.add(company)
    db.flush()
    shop = Shop(id=uuid.uuid4(), tenant_id=tenant.id, company_id=company.id, name="Race shop", settings={})
    db.add(shop)
    db.flush()
    users = []
    for i in range(2):
        u = User(id=uuid.uuid4(), username=f"race{i}-{uuid.uuid4().hex[:6]}", email=f"race{i}-{uuid.uuid4().hex[:6]}@x.co",
                 role=UserRole.COMPANY_MANAGER, tenant_id=tenant.id, company_id=company.id, is_active=True)
        db.add(u)
        db.flush()
        db.add(DashboardAccessProfile(user_id=u.id, full_access=True, sections={}))
        db.add(TenantMembership(tenant_id=tenant.id, user_id=u.id, role=TenantMembershipRole.TENANT_MEMBER, is_default=True))
        users.append(u)
    machine = POSMachine(id=uuid.uuid4(), tenant_id=tenant.id, shop_id=shop.id, distributor_id=users[0].id,
                         name="race till", machine_code=f"R-{uuid.uuid4().hex[:6]}", is_active=True,
                         pairing_status=PairingStatus.ASSIGNED)
    db.add(machine)
    db.flush()
    req = ApprovalRequest(
        id=uuid.uuid4(), client_request_id="race", type="discount_basket", tenant_id=tenant.id, company_id=company.id,
        shop_id=shop.id, machine_id=machine.id, percent=10,
        sent_to=[{"userId": str(u.id), "name": u.username} for u in users],
        status="pending", expires_at=datetime.now(timezone.utc) + timedelta(minutes=3),
    )
    db.add(req)
    db.add(ApprovalPolicyValue(id=uuid.uuid4(), tenant_id=tenant.id, scope_type="company", scope_id=company.id,
                               values={"enabled": True, "types": {"discount_basket": {"enabled": True}}}))
    db.commit()
    results, barrier = [], threading.Barrier(2)

    def go(user_id):
        s = Session()
        try:
            barrier.wait()
            S.decide(s, req.id, s.get(User, user_id), tenant_id=tenant.id, decision="approve")
            s.commit()
            results.append("ok")
        except HTTPException as e:
            s.rollback()
            results.append(e.detail)
        finally:
            s.close()

    threads = [threading.Thread(target=go, args=(u.id,)) for u in users]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    try:
        assert sorted(results) == ["already_decided", "ok"]
        db.expire_all()
        assert db.get(ApprovalRequest, req.id).status == "approved"
        assert db.query(ElevatedSession).filter(ElevatedSession.approval_request_id == req.id).count() == 1
    finally:
        db.close()


# ── The grant ────────────────────────────────────────────────────────────────


def _approved(w, **kw):
    approved_percent = kw.pop("approved_percent", None)
    req = _pending(w, **kw)
    S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", approved_percent=approved_percent)
    w.db.commit()
    return req, S.grant_token(req.id)


class TestGrant:
    def test_one_use(self, w):
        req, grant = _approved(w)
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": grant, "percent": 30})
        assert r.status_code == 200, r.text
        assert r.json()["approvedByUserId"] == str(w.ron.id) and r.json()["approvedByPosUserId"] == str(w.ron_pu.id)
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": grant, "percent": 30})
        assert r.status_code == 409 and r.json()["detail"] == "grant_used"
        assert S.heartbeat_items(w.db, w.machine) == []  # spent: nothing left to hand over

    def test_amount_bound(self, w):
        req, grant = _approved(w)
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": grant, "percent": 31})
        assert r.status_code == 422 and r.json()["detail"] == "grant_amount_mismatch"
        # A refused use leaves the grant unspent.
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": grant, "percent": 25})
        assert r.status_code == 200

    def test_partial_binds_the_lower_figure(self, w):
        req = _pending(w)
        S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", approved_percent=20)
        w.db.commit()
        grant = S.grant_token(req.id)
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": grant, "percent": 30})
        assert r.status_code == 422

    def test_expired_wrong_machine_and_unknown(self, w):
        req, grant = _approved(w)
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w, w.machine2), json={"grantId": grant})
        assert r.status_code == 403 and r.json()["detail"] == "grant_wrong_machine"
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": "apg_nope"})
        assert r.status_code == 404 and r.json()["detail"] == "grant_unknown"
        later = S.utcnow() + S.GRANT_TTL + timedelta(seconds=1)
        with pytest.raises(HTTPException) as e:
            S.use_grant(w.db, w.machine, req.id, grant, now=later)
        assert (e.value.status_code, e.value.detail) == (410, "grant_expired")

    def test_the_grant_is_an_elevation_token_where_the_cloud_checks_one(self, w):
        from app.middleware.auth import _checked_grant
        from app.services.permissions import Scope

        req, grant = _approved(w, type="table_cancel", percent=None, amount=120, reason_code="לקוח החזיר")
        session = _checked_grant(w.db, w.machine, grant, Scope.TABLE_CANCEL)
        assert session.user_id == w.ron.id and session.approval_request_id == req.id
        assert elevation.consume_per_action_use(w.db, session) is True
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            _checked_grant(w.db, w.machine, grant, Scope.TABLE_CANCEL)
        assert e.value.detail == "elevation_already_used"
        r = w.client.post(f"/api/v1/approvals/{req.id}/use", headers=_till(w), json={"grantId": grant})
        assert r.status_code == 409
        # Not for another till, and not for a scope the type does not carry.
        req2, grant2 = _approved(w, type="table_cancel", percent=None, amount=50, reason_code="x",
                                 client_request_id="t2")
        with pytest.raises(HTTPException):
            _checked_grant(w.db, w.machine2, grant2, Scope.TABLE_CANCEL)
        with pytest.raises(HTTPException):
            _checked_grant(w.db, w.machine, grant2, Scope.REFUND)

    def test_heartbeat_hands_over_decisions(self, w):
        req = _pending(w)
        items = S.heartbeat_items(w.db, w.machine)
        assert items == [{"id": str(req.id), "clientRequestId": req.client_request_id, "status": "pending"}]
        r = w.client.post("/api/v1/machines/me/heartbeat", headers=_till(w), json={})
        assert r.status_code == 200, r.text
        assert r.json()["pendingApprovals"][0]["id"] == str(req.id)
        S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="reject")
        w.db.commit()
        assert S.heartbeat_items(w.db, w.machine)[0]["status"] == "rejected"
        assert S.heartbeat_items(w.db, w.machine2) == []


# ── The PIN path now holds the approver to their limit ───────────────────────


class TestElevationLimits:
    def _avi(self, w):
        w.avi_pu.till_role = w.roles[TP.SUPERVISOR]
        return w.avi_pu

    def test_limit_enforced_when_the_till_sends_a_figure(self, w):
        from app.services.permissions import Scope

        avi = self._avi(w)
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.DISCOUNT], percent=25) == [Scope.DISCOUNT]
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.DISCOUNT], percent=35) == []
        # No figure: exactly as before.
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.DISCOUNT]) == [Scope.DISCOUNT]
        ron = w.ron_pu
        assert elevation.grantable_scopes_for_pos_user(ron, w.machine, [Scope.DISCOUNT], percent=90) == [Scope.DISCOUNT]

    def test_the_endpoint(self, w, monkeypatch):
        body = {"posUserId": str(w.avi_pu.id), "pin": "8317", "scopes": ["discount"], "percent": 35}
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json=body)
        assert r.status_code == 403 and r.json()["detail"] == "limit_exceeded"
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json={**body, "percent": 20})
        assert r.status_code == 200, r.text
        row = w.db.query(ElevatedSession).filter(ElevatedSession.pos_user_id == w.avi_pu.id).one()
        assert float(row.max_percent) == 20
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json={k: v for k, v in body.items() if k != "percent"})
        assert r.status_code == 200

    # "על חשבון הבית": an amount ceiling per role, none by default (P:/specs/owner-decisions-1410.md §2).

    def test_oth_has_no_ceiling_by_default_in_any_role(self, w):
        from app.services.permissions import Scope

        spec = TP.PERMISSIONS_BY_CODE["OTH"]
        assert [lim.key for lim in spec.limits] == ["maxAmount"] and spec.scope == "oth"
        assert TP.SCOPE_PERMISSIONS["oth"] == "OTH"
        for role_key, limits in TP.DEFAULT_LIMITS.items():
            assert "OTH" not in limits, role_key
        avi = self._avi(w)
        assert TP.limit_covers(TP.effective_permissions(template=TP.SUPERVISOR), "OTH", amount=1_000_000)
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.OTH], amount=99_999) == [Scope.OTH]

    def test_oth_ceiling_held_when_the_till_sends_the_amount(self, w):
        from app.services.permissions import Scope

        avi = self._avi(w)
        w.roles[TP.SUPERVISOR].limits = {**(w.roles[TP.SUPERVISOR].limits or {}), "OTH": {"maxAmount": 100}}
        w.db.flush()
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.OTH], amount=100) == [Scope.OTH]
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.OTH], amount=150) == []
        # No amount: as before. And the discount scope (what an older till asks for OTH) is not OTH's.
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.OTH]) == [Scope.OTH]
        assert elevation.grantable_scopes_for_pos_user(avi, w.machine, [Scope.DISCOUNT], amount=150) == [Scope.DISCOUNT]
        # A manager (no ceiling) covers it.
        assert elevation.grantable_scopes_for_pos_user(w.ron_pu, w.machine, [Scope.OTH], amount=150) == [Scope.OTH]

    def test_oth_ceiling_at_the_endpoint(self, w):
        w.roles[TP.SUPERVISOR].limits = {**(w.roles[TP.SUPERVISOR].limits or {}), "OTH": {"maxAmount": 100}}
        w.db.commit()
        body = {"posUserId": str(w.avi_pu.id), "pin": "8317", "scopes": ["oth"], "amount": 150}
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json=body)
        assert r.status_code == 403 and r.json()["detail"] == "limit_exceeded"
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json={**body, "amount": 80})
        assert r.status_code == 200, r.text
        assert r.json()["scopes"] == ["oth"]
        row = w.db.query(ElevatedSession).filter(ElevatedSession.pos_user_id == w.avi_pu.id).one()
        assert float(row.max_amount) == 80
        # A waiter's OTH is "approval", never "allow": not an approver at any amount.
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w),
                          json={**body, "posUserId": str(w.dana.id), "amount": 1})
        assert r.status_code == 403 and r.json()["detail"] == "not_permitted_here"


# ── Push ─────────────────────────────────────────────────────────────────────


def _dispatches(w, user):
    return w.db.query(ExceptionAlertDispatch).filter(ExceptionAlertDispatch.user_id == user.id).all()


class TestPush:
    def test_payload_has_the_details_and_no_customer(self, w):
        req = _pending(w, payload={"table": {"name": "12"}, "lines": [{"name": "סלט", "qty": 2}],
                                   "customer": {"name": "ישראל ישראלי", "phone": "0501234567"}})
        payload = S.push_payload(w.db, req, _tp(w))
        assert payload["title"] == "בקשת הנחה על החשבון 30%"
        assert "שולחן 12" in payload["body"] and "קופה 2" in payload["body"] and "״מנה לא טעימה״" in payload["body"]
        assert "סלט ×2" in payload["body"]
        assert "ישראל" not in payload["body"] and "050" not in payload["body"]
        assert payload["url"] == f"/dashboard/approvals/{req.id}" and payload["tag"] == f"approval:{req.id}"
        _on(w, detailsInPush=False, quickApprove=True)
        payload = S.push_payload(w.db, req, _tp(w))
        assert "סלט" not in payload["body"] and payload["url"].endswith("?quick=approve")

    def test_bypasses_the_rate_limit_and_respects_quiet_hours_unless_chosen(self, w):
        tz_now = S.utcnow()
        local = tz_now.astimezone(__import__("zoneinfo").ZoneInfo("Asia/Jerusalem"))
        start = (local - timedelta(hours=1)).strftime("%H:%M")
        end = (local + timedelta(hours=1)).strftime("%H:%M")
        for user, quiet in ((w.ron, True), (w.cm, False)):
            rule = PUSH.save_preferences(w.db, user, w.tenant.id, {"rateLimitMinutes": 600})
            if quiet:
                rule.quiet_from, rule.quiet_to = start, end
        w.db.commit()
        req = _pending(w, approver_ids=[w.ron.id, w.cm.id])
        assert [d.status for d in _dispatches(w, w.cm)] == ["queued"]
        assert [d.status for d in _dispatches(w, w.ron)] == [PUSH.ST_SUPPRESSED_QUIET]
        w.ron.preferences = {"approvalsInQuietHours": True}
        w.db.commit()
        S.add_approvers(w.db, w.machine, req, [w.sm.id])  # unrelated to Ron: Ron unchanged
        req2 = _pending(w, approver_ids=[w.ron.id], client_request_id="second")
        statuses = [d.status for d in _dispatches(w, w.ron) if str(req2.id) in d.dedupe_key]
        assert statuses == ["queued"]

    def test_a_user_who_turned_phone_alerts_off_gets_none(self, w):
        rule = PUSH.save_preferences(w.db, w.ron, w.tenant.id, {"enabled": False})
        w.db.commit()
        _pending(w, approver_ids=[w.ron.id])
        assert _dispatches(w, w.ron) == [] and rule.enabled is False

    def test_the_others_notice_is_replaced_after_the_decision(self, w, monkeypatch):
        seen = []
        real = PUSH.deliver_to_user

        def spy(db, **kw):
            seen.append((kw["user"].username, kw["payload"]))
            return real(db, **kw)

        monkeypatch.setattr(PUSH, "deliver_to_user", spy)
        req = _pending(w, approver_ids=[w.ron.id, w.cm.id])
        seen.clear()
        S.decide(w.db, req.id, w.ron, tenant_id=w.tenant.id, decision="approve", approved_percent=20)
        assert [u for u, _ in seen] == ["cm"]
        payload = seen[0][1]
        assert payload["tag"] == f"approval:{req.id}" and payload["renotify"] is False
        assert payload["title"] == "טופל על ידי Ron" and "אושר 20%" in payload["body"]

    def test_the_push_policy_decorates_it(self, w):
        from app.services import push_policy as PP

        # "התראות בנייד" (push_policy.decorate, as every alert in `_deliver`): a request stays on
        # screen and vibrates "urgent" by default; a "handled" notice (no category) does neither.
        out = PUSH.decorate_for_user(w.db, w.ron.id, {"title": "x", "category": "approvals", "severity": "high"})
        assert out["title"] == "x" and out["requireInteraction"] is True
        assert out["vibrate"] == PP.VIBRATE_PRESETS["urgent"]
        done = PUSH.decorate_for_user(w.db, w.ron.id, {"title": "y", "renotify": False})
        assert done["requireInteraction"] is False and "vibrate" not in done

    def test_the_approvers_phones_are_the_push_policys_reading(self, w, monkeypatch):
        from app.services import push_policy as PP
        from app.services.remote_approvals import eligibility as EL

        seen = []
        monkeypatch.setattr(PP, "health_for", lambda db, ids, **kw: seen.append(list(ids)) or {"x": 1})
        assert EL.device_health(w.db, [w.ron.id, None]) == {"x": 1}
        assert seen == [[w.ron.id]]

    def test_the_category_is_listed_but_no_rule_sends_it(self, w):
        assert "approvals" in PUSH.CATEGORY_KEYS
        assert PUSH.category_of(SimpleNamespace(kind="approval_requested", details={})) is None
        assert "approvals" in PUSH.clean({})["categories"]

    def test_the_preference_round_trips(self, w):
        r = w.client.put("/api/v1/users/me/preferences", headers=_dash(w, w.ron), json={"approvalsInQuietHours": True})
        assert r.status_code == 200, r.text
        assert r.json()["approvalsInQuietHours"] is True
        assert w.client.get("/api/v1/users/me/preferences", headers=_dash(w, w.ron)).json()["approvalsInQuietHours"] is True


class TestSettingsPageApprovers:
    def test_who_could_receive_and_who_has_no_phone(self, w):
        _on(w, approverRoles=["till:supervisor", "dash:shop_manager"])
        w.db.query(PushSubscription).filter(PushSubscription.user_id == w.avi.id).delete(synchronize_session=False)
        w.db.commit()
        r = w.client.get("/api/v1/approvals/policy/approvers", params={"level": "shop", "id": str(w.shop.id)},
                         headers=_dash(w, w.cm))
        assert r.status_code == 200, r.text
        body = r.json()
        # Avi (a supervisor, on shift or not) could receive it, and has no phone: the page warns.
        assert body["withoutDevice"] == ["Avi"]
        by = {i["name"]: i for i in body["items"]}
        assert set(by) == {"Avi", "sm"} and by["Avi"]["health"]["tone"] == "red" and by["sm"]["hasDevice"]
        assert by["Avi"]["types"] == ["discount_basket"]
        # Company level: every shop of the company.
        r = w.client.get("/api/v1/approvals/policy/approvers", params={"level": "company", "id": str(w.company.id)},
                         headers=_dash(w, w.cm))
        assert {i["name"] for i in r.json()["items"]} == {"Avi", "sm", "sm2"}
        # Off: nobody.
        _policy(w.db, w, "company", w.company.id, {"enabled": False})
        r = w.client.get("/api/v1/approvals/policy/approvers", params={"level": "shop", "id": str(w.shop.id)},
                         headers=_dash(w, w.cm))
        assert r.json() == {"items": [], "withoutDevice": []}


# ── The sweep ────────────────────────────────────────────────────────────────


class TestSweep:
    def test_expiry(self, w):
        req = _pending(w)
        assert S.sweep(w.db, now=S.utcnow()) == {"expired": 0, "escalated": 0}
        later = S.aware(req.expires_at) + timedelta(seconds=1)
        assert S.sweep(w.db, now=later) == {"expired": 1, "escalated": 0}
        w.db.commit()
        assert req.status == "expired"
        assert any(e == S.ABLY_EVENT and b["status"] == "expired" for _, e, b in w.ably)
        assert w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "approval_expired").count() == 1
        assert S.sweep(w.db, now=later) == {"expired": 0, "escalated": 0}

    def test_a_read_past_the_time_expires_it(self, w):
        req = _pending(w)
        req.expires_at = S.utcnow() - timedelta(seconds=1)
        w.db.commit()
        assert w.client.get(f"/api/v1/approvals/{req.id}", headers=_till(w)).json()["status"] == "expired"
        w.db.refresh(req)
        assert req.status == "expired"

    def test_escalation(self, w):
        req = _pending(w, policy={
            "approverRoles": ["dash:shop_manager"], "escalateAfterSeconds": 60,
            "escalationRoles": ["dash:company_manager"],
        })
        assert set(S.sent_to_ids(req)) == {str(w.sm.id)}
        start = S.aware(req.created_at)
        assert S.sweep(w.db, now=start + timedelta(seconds=30))["escalated"] == 0
        assert S.sweep(w.db, now=start + timedelta(seconds=61))["escalated"] == 1
        assert set(S.sent_to_ids(req)) == {str(w.sm.id), str(w.cm.id)}
        assert S.sweep(w.db, now=start + timedelta(seconds=90))["escalated"] == 0  # once
        w.db.commit()
        # The escalated approver may decide.
        S.decide(w.db, req.id, w.cm, tenant_id=w.tenant.id, decision="approve")
        assert req.status == "approved"

    def test_no_escalation_by_default(self, w):
        req = _pending(w)
        assert S.escalate(w.db, req, S.aware(req.created_at) + timedelta(seconds=170)) == 0


# ── Overrides, links ─────────────────────────────────────────────────────────


class TestOverridesAndLinks:
    def test_the_role_editor_keeps_the_approval_overrides(self, w):
        OV.write(w.ron_pu, {"all": {"offShift": True}})
        w.db.commit()
        till_roles.set_overrides(w.db, w.company, w.ron_pu, {"states": {"REFUND": "deny"}}, user=None)
        assert w.ron_pu.permission_overrides["approvals"] == {"all": {"offShift": True}}
        assert w.ron_pu.permission_overrides["states"] == {"REFUND": "deny"}
        till_roles.set_overrides(w.db, w.company, w.ron_pu, None, user=None)
        assert OV.read(w.ron_pu) == {"all": {"offShift": True}}

    def test_override_endpoints(self, w):
        url = f"/api/v1/shops/{w.shop.id}/pos-users/{w.avi_pu.id}/approval-overrides"
        r = w.client.put(url, headers=_dash(w, w.sm), json={"all": {"offShift": True}, "types": {"refund": {"maxAmount": 300}}})
        assert r.status_code == 200, r.text
        assert r.json() == {"all": {"offShift": True}, "types": {"refund": {"maxAmount": 300}}}
        assert w.client.put(url, headers=_dash(w, w.sm), json={"all": {"bogus": 1}}).status_code == 422
        assert w.client.get(url, headers=_dash(w, w.sm2)).status_code == 403

    def test_linked_employees(self, w):
        url = f"/api/v1/users/{w.avi.id}/linked-employees"
        r = w.client.get(url, headers=_dash(w, w.cm))
        assert r.status_code == 200, r.text
        assert [i["posUserId"] for i in r.json()["items"]] == [str(w.avi_pu.id)]
        r = w.client.put(url, headers=_dash(w, w.cm), json={"posUserIds": [str(w.avi_pu.id), str(w.dana.id)]})
        assert r.status_code == 200, r.text
        assert {i["name"] for i in r.json()["items"]} == {"Avi", "Dana"}
        # Moving an employee to another user takes them off the first.
        r = w.client.put(f"/api/v1/users/{w.ron.id}/linked-employees", headers=_dash(w, w.cm),
                         json={"posUserIds": [str(w.dana.id)]})
        assert {i["name"] for i in r.json()["items"]} == {"Dana"}
        assert {i["name"] for i in w.client.get(url, headers=_dash(w, w.cm)).json()["items"]} == {"Avi"}
        c = w.client.get("/api/v1/users/linked-employees/candidates", params={"q": "av"}, headers=_dash(w, w.cm))
        assert [i["linkedUserId"] for i in c.json()["items"]] == [str(w.avi.id)]
        # A shop manager may not re-link a company manager.
        r = w.client.put(f"/api/v1/users/{w.cm.id}/linked-employees", headers=_dash(w, w.sm), json={"posUserIds": []})
        assert r.status_code == 403
        # A manager links their own employee; a cashier may not make themselves a manager's employee.
        r = w.client.put(f"/api/v1/users/{w.sm.id}/linked-employees", headers=_dash(w, w.sm),
                         json={"posUserIds": [str(w.ron_pu.id)]})
        assert r.status_code == 200, r.text
        r = w.client.put(f"/api/v1/users/{w.avi.id}/linked-employees", headers=_dash(w, w.avi),
                         json={"posUserIds": [str(w.ron_pu.id)]})
        assert r.status_code == 403


# ── "סגנון האישור" (P:/specs/table-restore-payments.md §4) ───────────────────


class TestApprovalStyle:
    def test_both_by_default_for_every_permission_but_the_approvers_own(self, w):
        eff = P.for_machine(w.db, w.machine)
        assert eff.style("REFUND") == "both" and eff.style("TABLE_RESTORE") == "both"
        assert "APPROVE_REMOTE.refund" not in eff.styles
        assert set(eff.styles) == set(C.style_codes())

    def test_per_permission_and_level(self, w):
        _policy(w.db, w, "company", w.company.id, {"approvalStyle": {"*": "approve", "REFUND": "takeover"}})
        _policy(w.db, w, "shop", w.shop.id, {"approvalStyle": {"DISCOUNT": "both"}})
        eff = P.for_machine(w.db, w.machine)
        assert eff.style("REFUND") == "takeover" and eff.style_sources["REFUND"] == "company"
        assert eff.style("DISCOUNT") == "both" and eff.style_sources["DISCOUNT"] == "shop"
        assert eff.style("TABLE_CANCEL") == "approve" and eff.style_sources["TABLE_CANCEL"] == "company"
        # A till's own "*" is the nearest word for everything.
        _policy(w.db, w, "machine", w.machine.id, {"approvalStyle": {"*": "takeover"}})
        eff = P.for_machine(w.db, w.machine)
        assert eff.style("DISCOUNT") == "takeover" and eff.style("REFUND") == "takeover"
        assert P.for_machine(w.db, w.machine2).style("DISCOUNT") == "both"

    @pytest.mark.parametrize("bad", [
        {"approvalStyle": {"REFUND": "sometimes"}},
        {"approvalStyle": {"NOPE": "both"}},
        {"approvalStyle": {"APPROVE_REMOTE.refund": "both"}},
        {"approvalStyle": "both"},
    ])
    def test_bad_styles_are_refused(self, bad):
        with pytest.raises(P.PolicyValueError):
            P.clean_values(bad)

    def test_every_till_gets_the_styles_in_its_settings(self, w):
        _policy(w.db, w, "shop", w.shop.id, {"approvalStyle": {"REFUND": "takeover"}})
        for m in (w.machine, w.machine2):  # with and without remote_approval_v1
            r = w.client.get(f"/api/v1/sync/{m.id}/settings", headers=_till(w, m))
            assert r.status_code == 200, r.text
            styles = r.json()["settings"]["approvalStyle"]
            assert styles["REFUND"] == "takeover" and styles["DISCOUNT"] == "both"
        assert "approvalRequests" not in w.client.get(
            f"/api/v1/sync/{w.machine2.id}/settings", headers=_till(w, w.machine2)).json()["settings"]

    def test_the_policy_page_reads_and_writes_them(self, w):
        r = w.client.put(f"/api/v1/approvals/policy?level=company&id={w.company.id}", headers=_dash(w, w.cm),
                         json={"approvalStyle": {"*": "approve"}})
        assert r.status_code == 200, r.text
        r = w.client.get(f"/api/v1/approvals/policy?level=shop&id={w.shop.id}", headers=_dash(w, w.cm)).json()
        assert r["own"]["approvalStyle"] == {} and r["inherited"]["approvalStyle"]["REFUND"] == "approve"
        assert r["inheritedSources"]["approvalStyle"]["REFUND"] == "company"
        assert r["catalog"]["approvalStyle"]["options"] == ["approve", "takeover", "both"]
        assert any(p["code"] == "TABLE_CANCEL" for p in r["catalog"]["approvalStyle"]["permissions"])

    def test_the_pin_elevation_honours_the_mode(self, w):
        _policy(w.db, w, "shop", w.shop.id, {"approvalStyle": {"DISCOUNT": "approve"}})
        body = {"posUserId": str(w.ron_pu.id), "pin": "8317", "scopes": ["discount"]}
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json={**body, "mode": "takeover"})
        assert r.status_code == 403 and r.json()["detail"] == "approval_style_not_allowed"
        r = w.client.post("/api/v1/elevation/sessions", headers=_till(w), json={**body, "mode": "nonsense"})
        assert r.status_code == 403
        assert w.client.post("/api/v1/elevation/sessions", headers=_till(w), json={**body, "mode": "approve"}).status_code == 200
        assert w.client.post("/api/v1/elevation/sessions", headers=_till(w), json=body).status_code == 200

    def test_a_takeover_document_names_the_manager_as_its_actor(self):
        from app.services.transactions import MANAGER_TAKEOVER, apply_takeover

        manager = uuid.uuid4()
        tx = SimpleNamespace(approval_mode="takeover", approved_by_pos_user_id=manager, cashier_id="cashier-1")
        note = apply_takeover(tx)
        assert tx.cashier_id == str(manager) and tx.approved_by_pos_user_id is None
        assert note["code"] == MANAGER_TAKEOVER
        # Sent as the actor already: filed as sent, still said.
        tx = SimpleNamespace(approval_mode="TAKEOVER", approved_by_pos_user_id=None, cashier_id=str(manager))
        assert apply_takeover(tx)["detail"] == str(manager) and tx.cashier_id == str(manager)
        # An approval stays an approval.
        tx = SimpleNamespace(approval_mode="approve", approved_by_pos_user_id=manager, cashier_id="cashier-1")
        assert apply_takeover(tx) is None and tx.approved_by_pos_user_id == manager

    def test_a_manager_named_as_the_operator_is_accepted(self, w):
        """`X-Pos-User-Id` = the manager who took over, not the signed-in employee: their own authority."""
        from app.middleware.auth import _operator_with_authority
        from app.services.permissions import Scope

        assert _operator_with_authority(w.db, w.machine, str(w.ron_pu.id), Scope.TABLE_CANCEL).id == w.ron_pu.id
        assert _operator_with_authority(w.db, w.machine, str(w.dana.id), Scope.TABLE_CANCEL) is None


def test_the_catalogue_has_a_remote_approval_permission_per_type():
    for t in C.TYPES:
        spec = TP.PERMISSIONS_BY_CODE[t.permission_code]
        assert spec.group == "approvals"
        assert [lim.key for lim in spec.limits] == ([C.LIMIT_KEY[t.unit]] if t.unit else [])
    assert TP.DEFAULTS[TP.SUPERVISOR]["APPROVE_REMOTE.refund"] == TP.ALLOW
    assert TP.DEFAULTS[TP.MANAGER]["APPROVE_REMOTE.refund"] == TP.ALLOW
    assert TP.DEFAULTS[TP.WAITER]["APPROVE_REMOTE.refund"] == TP.DENY
    assert TP.DEFAULTS[TP.CASHIER]["APPROVE_REMOTE.refund"] == TP.DENY
    assert TP.DEFAULTS[TP.LEGACY_CASHIER]["APPROVE_REMOTE.refund"] == TP.DENY
    assert TP.DEFAULTS[TP.LEGACY_MANAGER]["APPROVE_REMOTE.refund"] == TP.ALLOW
    # A legacy manager still reads as a shop manager to an older till.
    assert TP.legacy_role_for(TP.DEFAULTS[TP.LEGACY_MANAGER]) == "shop_manager"
