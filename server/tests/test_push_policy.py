"""
"התראות בנייד שחובה להפעיל" (P:/specs/pwa-push-required.md, app/services/push_policy.py,
app/routers/push_policy.py):

* `required` per level — company (and its parent), dashboard template, role, user — the most
  specific that sets it wins, null inherits;
* the defaults: approver with approval requests on in one of their shops → required (only once
  the `approvals` section exists — absent on this branch, never required), "התראות" → reminder,
  anyone else off;
* `GET /push/status`: devices, last success, this device by its endpoint hash;
* "התראות בנייד" on the users list: green / yellow (no success for 7 days) / red (no device);
* the editors' routes: validation and who may write;
* per category: stays on screen / vibration, carried in the payload of a real delivery.

Runs on the in-memory SQLite world of tests/shift_world.py; nothing is sent anywhere.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.dashboard_access import DashboardAccessProfile, DashboardAccessTemplate
from app.models.exception_alerts import PushSubscription
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.routers import push_policy as R
from app.routers import users as UR
from app.schemas.user import UserResponse
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import push_policy as PP
from app.services import webpush as W
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import log as L
from app.services.exception_alerts import push as P
from app.services.settings_merge import merge_settings
from shift_world import accept_str_uuids, make_world

NOW = datetime(2026, 10, 13, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    private, public = W.generate_vapid_keys()
    monkeypatch.setattr(W, "config", lambda: W.VapidConfig(public_key=public, private_key=private, subject="mailto:t@example.com"))
    world.public_key = public
    # Nothing leaves the test: deliveries are captured, never posted.
    world.sent = []

    def fake_send(job):
        world.sent.append(job)
        return W.SendResult(ok=True, status=201)

    monkeypatch.setattr(P, "_send", fake_send)
    monkeypatch.setattr(P, "SEND_MODE", "inline")
    monkeypatch.setattr(E, "now_fn", lambda: NOW)
    return world


@pytest.fixture
def approvals_section(monkeypatch):
    """feat/remote-approvals' section, as if merged."""
    monkeypatch.setattr(DS, "SECTION_IDS", frozenset(DS.SECTION_IDS | {"approvals"}))


def user(w, role, *, shop=None, company=None, sections=None, full=False, template=None, builtin=None, username=None):
    company = company or w.company
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=company.id if role != UserRole.SUPER_ADMIN else None,
             shop_id=shop.id if shop else None, email=f"{uuid.uuid4().hex[:8]}@example.com",
             username=username or uuid.uuid4().hex[:10], is_active=True)
    w.db.add(u)
    w.db.flush()
    if sections is not None or full:
        w.db.add(DashboardAccessProfile(
            user_id=u.id, full_access=full, sections=dict(sections or {}),
            template_id=template.id if template is not None else None, builtin_template=builtin,
        ))
        w.db.flush()
    fresh(w)
    return u


def fresh(w):
    DA.forget(w.db)
    PP.forget(w.db)


def device(w, owner, *, success=None, failure=None, failures=0, created=None, disabled=False, endpoint=None):
    endpoint = endpoint or f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}"
    row = PushSubscription(
        id=uuid.uuid4(), user_id=owner.id, tenant_id=w.tenant.id, endpoint=endpoint,
        endpoint_hash=P.endpoint_hash(endpoint), p256dh="k", auth="a", label="Chrome · Android",
        created_at=created or NOW - timedelta(days=30), last_success_at=success, last_failure_at=failure,
        failure_count=failures, disabled_at=NOW if disabled else None,
    )
    w.db.add(row)
    w.db.flush()
    return row


def required(w, u):
    fresh(w)
    return PP.resolve_required(w.db, u, w.tenant.id)


def set_platform(w, templates=None, roles=None):
    PP.save_platform(w.db, {"templates": templates or {}, "roles": roles or {}}, w.admin)
    fresh(w)


# ── Defaults ─────────────────────────────────────────────────────────────────


def test_the_alerts_section_means_a_reminder_and_nothing_else_means_off(w):
    alerts = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "view"})
    reports = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"reports": "view"})
    assert required(w, alerts).as_json() == {"required": "reminder", "source": "default", "default": "reminder"}
    assert required(w, reports).mode == "off"
    # Full access holds every section; a producer never has notifications.
    assert required(w, user(w, UserRole.COMPANY_MANAGER, full=True)).mode == "reminder"
    producer = user(w, UserRole.PRODUCER_VIEW)
    assert required(w, producer).mode == "off"


def test_without_the_approvals_section_nobody_is_required_by_default(w):
    w.shop.settings = {"approvalRequests": {"enabled": True}}
    w.db.flush()
    full = user(w, UserRole.COMPANY_MANAGER, full=True)
    # A profile naming the section keeps nothing of it while it is not registered.
    named = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"approvals": "edit", "alerts": "view"})
    assert "approvals" not in DS.SECTION_IDS
    assert required(w, full).mode == "reminder"
    assert required(w, named).mode == "reminder"


def test_an_approver_is_required_once_requests_are_on_in_one_of_their_shops(w, approvals_section):
    approver = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"approvals": "edit", "alerts": "view"})
    viewer = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"approvals": "view", "alerts": "view"})
    assert required(w, approver).mode == "reminder"  # requests are off everywhere
    w.other_shop.settings = {"approvalRequests": {"enabled": True}}
    w.db.flush()
    assert required(w, approver).mode == "reminder"  # on, but not in a shop of theirs
    w.shop.settings = {"approvalRequests": {"enabled": True}}
    w.db.flush()
    assert required(w, approver).as_json() == {"required": "required", "source": "default", "default": "required"}
    assert required(w, viewer).mode == "reminder"  # sees requests, does not decide them
    # On at the company: every shop of it.
    w.shop.settings = {}
    w.other_shop.settings = {}
    w.company.settings = {"approvalRequests": {"enabled": True}}
    w.db.flush()
    assert required(w, approver).mode == "required"


def test_feat_remote_approvals_policy_is_read_when_present(w, approvals_section, monkeypatch):
    approver = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"approvals": "edit"})
    seen = []
    fake = SimpleNamespace(
        chain_for=lambda **kw: [("shop", kw["shop_id"]), ("company", kw["company_id"])],
        rows_on_chain=lambda db, chain: seen.append(chain) or [],
        resolve=lambda rows, chain: SimpleNamespace(enabled=True),
    )
    monkeypatch.setattr(PP, "_approvals_policy_module", lambda: fake)
    assert required(w, approver).mode == "required"
    assert seen and seen[0][0] == ("shop", w.shop.id)
    # A module that is not what is expected: the settings are read instead (off here).
    monkeypatch.setattr(PP, "_approvals_policy_module", lambda: SimpleNamespace())
    assert required(w, approver).mode == "off"


# ── Levels ───────────────────────────────────────────────────────────────────


def test_the_most_specific_level_wins_and_null_inherits(w):
    manager = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "edit"}, builtin=DS.BRANCH_MANAGER_TEMPLATE)
    assert required(w, manager).as_json() == {"required": "reminder", "source": "default", "default": "reminder"}

    PP.set_company_policy(w.company, {"required": "required"})
    w.db.flush()
    assert (required(w, manager).mode, required(w, manager).source) == ("required", "company")

    set_platform(w, roles={"shop_manager": {"required": "off"}})
    assert (required(w, manager).mode, required(w, manager).source) == ("off", "role")

    set_platform(w, templates={DS.BRANCH_MANAGER_TEMPLATE: {"required": "reminder"}}, roles={"shop_manager": {"required": "off"}})
    assert (required(w, manager).mode, required(w, manager).source) == ("reminder", "template")

    PP.set_user_policy(manager, {"required": "required"})
    w.db.flush()
    assert (required(w, manager).mode, required(w, manager).source) == ("required", "user")

    PP.set_user_policy(manager, {})  # null = inherit again
    w.db.flush()
    assert manager.preferences is None
    assert required(w, manager).source == "template"


def test_a_custom_template_and_a_parent_company(w):
    template = DashboardAccessTemplate(id=uuid.uuid4(), name="מאשר", sections={"alerts": "view"})
    w.db.add(template)
    child = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Child", parent_company_id=w.company.id, settings={})
    w.db.add(child)
    w.db.flush()
    u = user(w, UserRole.COMPANY_MANAGER, company=child, sections={"alerts": "view"}, template=template)
    PP.set_company_policy(w.company, {"required": "required"})
    w.db.flush()
    assert (required(w, u).mode, required(w, u).source) == ("required", "company")  # from the parent
    PP.set_company_policy(child, {"required": "off"})
    w.db.flush()
    assert required(w, u).mode == "off"  # the child's own
    set_platform(w, templates={str(template.id): {"required": "required"}})
    assert (required(w, u).mode, required(w, u).source) == ("required", "template")


def test_the_company_level_never_reaches_a_till(w):
    PP.set_company_policy(w.company, {"required": "required", "notify": {"approvals": {"requireInteraction": "never"}}})
    w.db.flush()
    assert w.company.settings[PP.POLICY_KEY]["required"] == "required"
    assert PP.POLICY_KEY not in merge_settings(w.company, w.shop, w.tenant)


# ── The editors' routes ──────────────────────────────────────────────────────


def test_company_policy_route(w):
    manager = user(w, UserRole.COMPANY_MANAGER, full=True)
    shop_manager = user(w, UserRole.SHOP_MANAGER, shop=w.shop, full=True)
    stamp = w.company.settings_updated_at
    out = R.put_company_push_policy(
        w.company.id, {"required": "reminder", "notify": {"till_offline": {"requireInteraction": "always", "vibrate": "double"}}},
        current_user=manager, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert out["policy"] == {"required": "reminder", "notify": {"till_offline": {"requireInteraction": "always", "vibrate": "double"}}}
    assert out["canEdit"] is True
    assert w.company.settings_updated_at == stamp  # no till re-syncs for this
    keys = {c["key"] for c in out["catalogue"]["categories"]}
    assert {"till_offline", "approvals", "integrity", "device_battery"} <= keys
    got = R.get_company_push_policy(w.company.id, current_user=shop_manager, active_tenant_id=w.tenant.id, db=w.db)
    assert got["canEdit"] is False and got["policy"]["required"] == "reminder"
    with pytest.raises(HTTPException) as err:
        R.put_company_push_policy(w.company.id, {"required": "off"}, current_user=shop_manager, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 403
    for bad in ({"required": "always"}, {"notify": {"nope": {"requireInteraction": "always"}}},
                {"notify": {"approvals": {"vibrate": "disco"}}}, {"other": 1}):
        with pytest.raises(HTTPException) as err:
            R.put_company_push_policy(w.company.id, bad, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
        assert err.value.status_code == 422
    other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", settings={})
    w.db.add(other)
    w.db.flush()
    with pytest.raises(HTTPException) as err:
        R.put_company_push_policy(other.id, {"required": "off"}, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 403
    # Null clears the level: the company inherits again.
    out = R.put_company_push_policy(w.company.id, {"required": None, "notify": None}, current_user=manager,
                                    active_tenant_id=w.tenant.id, db=w.db)
    assert out["policy"] == {"required": None, "notify": {}} and PP.POLICY_KEY not in w.company.settings


def test_template_and_role_route(w):
    template = DashboardAccessTemplate(id=uuid.uuid4(), name="מאשר", sections={})
    w.db.add(template)
    w.db.flush()
    out = R.put_platform_push_policy(
        {"templates": {DS.BRANCH_MANAGER_TEMPLATE: {"required": "required"}, str(template.id): {"required": None}},
         "roles": {"shift_supervisor": {"required": "reminder"}}},
        current_user=w.admin, db=w.db,
    )
    assert out["templates"] == {DS.BRANCH_MANAGER_TEMPLATE: {"required": "required", "notify": {}}}
    assert out["roles"] == {"shift_supervisor": {"required": "reminder", "notify": {}}}
    assert {t["id"] for t in out["templateList"]} >= {DS.BRANCH_MANAGER_TEMPLATE, str(template.id)}
    for bad in ({"templates": {"nope": {"required": "off"}}}, {"roles": {"king": {"required": "off"}}},
                {"roles": {"cashier": {"required": "sometimes"}}}):
        with pytest.raises(HTTPException) as err:
            R.put_platform_push_policy(bad, current_user=w.admin, db=w.db)
        assert err.value.status_code == 422
    supervisor = user(w, UserRole.SHIFT_SUPERVISOR, shop=w.shop, sections={})
    assert (required(w, supervisor).mode, required(w, supervisor).source) == ("reminder", "role")


def test_user_level_route(w):
    boss = user(w, UserRole.COMPANY_MANAGER, full=True)
    manager = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "view"})
    peer = user(w, UserRole.COMPANY_MANAGER, full=True)
    out = R.put_user_push_policy(manager.id, {"required": "required"}, current_user=boss, active_tenant_id=w.tenant.id, db=w.db)
    assert out["policy"]["required"] == "required"
    assert out["resolved"] == {"required": "required", "source": "user", "default": "reminder"}
    assert out["inherited"] == {"required": "reminder", "source": "default", "default": "reminder"}
    assert manager.preferences == {"pushPolicy": {"required": "required"}}
    # Their own per-category choice stays when only `required` changes.
    PP.set_user_policy(manager, {"required": "required", "notify": {"approvals": {"vibrate": "long"}}})
    out = R.put_user_push_policy(manager.id, {"required": None}, current_user=boss, active_tenant_id=w.tenant.id, db=w.db)
    assert out["policy"] == {"required": None, "notify": {"approvals": {"vibrate": "long"}}}
    with pytest.raises(HTTPException) as err:  # never one's own requirement
        R.put_user_push_policy(manager.id, {"required": "off"}, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 403
    with pytest.raises(HTTPException) as err:  # nor an equal's
        R.put_user_push_policy(peer.id, {"required": "off"}, current_user=boss, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 403
    with pytest.raises(HTTPException) as err:
        R.put_user_push_policy(manager.id, {"required": "maybe"}, current_user=boss, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 422
    got = R.get_user_push_policy(manager.id, current_user=boss, active_tenant_id=w.tenant.id, db=w.db)
    assert got["health"] == {"devices": 0, "lastSuccessAt": None, "lastFailureAt": None, "tone": "red"}


# ── GET /push/status ─────────────────────────────────────────────────────────


def test_push_status(w, monkeypatch):
    monkeypatch.setattr(PP, "datetime", SimpleNamespace(now=lambda tz=None: NOW))
    manager = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "view"})
    other = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "view"})
    out = R.push_status(endpoint_hash=None, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["required"] == "reminder" and out["devices"] == 0 and out["thisDeviceRegistered"] is False
    assert out["configured"] is True and out["publicKey"] == w.public_key and out["tone"] == "red"

    phone = device(w, manager, success=NOW - timedelta(hours=3))
    device(w, manager, success=NOW - timedelta(days=1))
    device(w, manager, success=NOW - timedelta(minutes=5), disabled=True)  # turned off: not counted
    theirs = device(w, other, success=NOW)
    out = R.push_status(endpoint_hash=phone.endpoint_hash, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["devices"] == 2 and out["thisDeviceRegistered"] is True and out["tone"] == "green"
    assert out["lastSuccessAt"] == (NOW - timedelta(hours=3)).isoformat()
    assert out["thisDevice"]["failing"] is False
    # Someone else's device is not "this device" of mine.
    out = R.push_status(endpoint_hash=theirs.endpoint_hash, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["thisDeviceRegistered"] is False and out["thisDevice"] is None
    # Failing since its last success: the dashboard re-subscribes it.
    phone.last_failure_at = NOW - timedelta(minutes=1)
    phone.failure_count = 1
    w.db.flush()
    out = R.push_status(endpoint_hash=phone.endpoint_hash, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["thisDevice"]["failing"] is True
    # Re-subscribed (the count is reset): no longer failing, until it fails again.
    phone.failure_count = 0
    w.db.flush()
    out = R.push_status(endpoint_hash=phone.endpoint_hash, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["thisDevice"]["failing"] is False
    # Push not configured on the server: the dashboard asks nothing of anyone.
    monkeypatch.setattr(W, "config", lambda: None)
    out = R.push_status(endpoint_hash=None, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert out["configured"] is False and out["publicKey"] is None


# ── "התראות בנייד" on the users list ─────────────────────────────────────────


def test_health_tones():
    def d(**kw):
        base = {"last_success_at": None, "last_failure_at": None, "failure_count": 0, "created_at": NOW - timedelta(days=30)}
        base.update(kw)
        return SimpleNamespace(**base)

    assert PP.health_tone([], NOW) == "red"
    assert PP.health_tone([d(last_success_at=NOW - timedelta(days=2))], NOW) == "green"
    assert PP.health_tone([d(last_success_at=NOW - timedelta(days=8))], NOW) == "yellow"
    assert PP.health_tone([d(last_success_at=NOW - timedelta(days=8)), d(last_success_at=NOW)], NOW) == "green"
    # New, nothing sent yet: it has not had seven days.
    assert PP.health_tone([d(created_at=NOW - timedelta(days=1))], NOW) == "green"
    assert PP.health_tone([d(created_at=NOW - timedelta(days=1), last_failure_at=NOW)], NOW) == "yellow"
    assert PP.health_tone([d(created_at=NOW - timedelta(days=9))], NOW) == "yellow"
    # Failing again and again since its last success.
    assert PP.health_tone([d(last_success_at=NOW - timedelta(days=1), failure_count=3)], NOW) == "yellow"


def test_the_users_list_carries_push_health(w, monkeypatch):
    monkeypatch.setattr(PP, "datetime", SimpleNamespace(now=lambda tz=None: NOW))
    green = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "view"}, username="green")
    yellow = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={}, username="yellow")
    red = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={}, username="red")
    device(w, green, success=NOW - timedelta(days=1))
    device(w, green, success=NOW - timedelta(days=20))
    device(w, yellow, success=NOW - timedelta(days=10))
    device(w, red, success=NOW, disabled=True)
    PP.set_user_policy(red, {"required": "required"})
    w.db.flush()
    rows = UR.list_users(skip=0, limit=100, company_id=None, shop_id=None, role=None,
                         current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    wire = {r.username: UserResponse.model_validate(r).model_dump(by_alias=True, mode="json") for r in rows}
    assert wire["green"]["pushHealth"] == {
        "devices": 2, "lastSuccessAt": (NOW - timedelta(days=1)).isoformat(), "lastFailureAt": None,
        "tone": "green", "required": "reminder",
    }
    assert wire["green"]["pushRequired"] is None
    assert (wire["yellow"]["pushHealth"]["tone"], wire["yellow"]["pushHealth"]["required"]) == ("yellow", "off")
    assert (wire["red"]["pushHealth"]["tone"], wire["red"]["pushHealth"]["devices"]) == ("red", 0)
    assert (wire["red"]["pushRequired"], wire["red"]["pushHealth"]["required"]) == ("required", "required")


# ── How a notification behaves ───────────────────────────────────────────────


def test_category_defaults_and_levels(w):
    manager = user(w, UserRole.SHOP_MANAGER, shop=w.shop, sections={"alerts": "view"})
    rules = PP.resolve_notify(w.db, manager, w.company.id)
    high, medium = {"severity": "high"}, {"severity": "medium"}
    assert PP.behaviour(rules["approvals"], medium) == {"requireInteraction": True, "vibrate": [300, 120, 300, 120, 600]}
    assert PP.behaviour(rules["integrity"], medium) == {"requireInteraction": True}
    assert PP.behaviour(rules["device_battery"], high) == {"requireInteraction": True}
    assert PP.behaviour(rules["device_battery"], medium) == {"requireInteraction": False}
    assert PP.behaviour(rules["device_battery"], medium, SimpleNamespace(severity="medium", details={"critical": True})) == {
        "requireInteraction": True}
    # Any other category keeps today's rule: a high-severity one stays.
    assert PP.behaviour(rules["till_offline"], high) == {"requireInteraction": True}
    assert PP.behaviour(rules["till_offline"], medium) == {"requireInteraction": False}

    PP.set_company_policy(w.company, {"notify": {"approvals": {"requireInteraction": "never"}}})
    set_platform(w, roles={"shop_manager": {"notify": {"till_offline": {"vibrate": "short"}}}})
    PP.set_user_policy(manager, {"notify": {"till_offline": {"requireInteraction": "always"}}})
    w.db.flush()
    fresh(w)
    rules = PP.resolve_notify(w.db, manager, w.company.id)
    assert rules["approvals"] == {"requireInteraction": "never", "vibrate": "urgent"}  # field by field
    assert PP.behaviour(rules["till_offline"], medium) == {"requireInteraction": True, "vibrate": [200]}


def test_the_payload_carries_the_behaviour_to_the_phone(w):
    PP.set_company_policy(w.company, {"notify": {"till_offline": {"requireInteraction": "always", "vibrate": "urgent"}}})
    w.db.flush()
    fresh(w)
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {})
    spec = L.EntrySpec(
        source="test", source_id=uuid.uuid4().hex, dedupe_key=f"test:{uuid.uuid4().hex}", kind="till_offline",
        severity="medium", occurred_at=NOW - timedelta(minutes=1), tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=w.shop.id, machine_id=w.tills[0].id,
    )
    entry, _ = L.record(w.db, spec, now=NOW)
    E.process_entry(w.db, entry, now=NOW)
    payloads = [job["payload"] for job in w.sent if job["payload"].get("kind") == "till_offline"]
    assert payloads and payloads[0]["requireInteraction"] is True
    assert payloads[0]["vibrate"] == [300, 120, 300, 120, 600]
    # A test message: no category — today's rule (not high: does not stay).
    w.sent.clear()
    P.send_test(w.db, w.admin, w.tenant.id, now=NOW)
    assert w.sent and w.sent[0]["payload"]["requireInteraction"] is False and "vibrate" not in w.sent[0]["payload"]


def test_decorate_never_loses_a_notification(w, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")

    monkeypatch.setattr(PP, "resolve_notify", boom)
    payload = {"title": "t", "category": "approvals"}
    assert PP.decorate(w.db, w.admin.id, payload) == payload


def test_clean_policy_reads_forgivingly():
    assert PP.clean_policy({"required": "bogus", "notify": {"x": {"requireInteraction": "nah", "vibrate": "urgent"}}}) == {
        "notify": {"x": {"vibrate": "urgent"}}}
    assert PP.clean_policy("junk") == {}
    assert PP.clean_policy({"notify": {"approvals": {"requireInteraction": True}}}, strict=True) == {
        "notify": {"approvals": {"requireInteraction": "always"}}}
