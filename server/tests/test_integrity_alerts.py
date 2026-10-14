"""
"שלמות נתונים" and the new phone-alert types (P:/specs/manager-problems.md §1, §2, §6):

* `integrity` reaches super admins only — from every organization, past the organizations'
  scoping, under their own switch, companies and muted devices, with the quiet hours of their
  preferences; a company manager or a shop manager never, whatever they chose;
* `GET /push/categories` (and `/push/config`) list it for a super admin only; nobody else may
  choose it; the feed shows it, and lets "טופל" through, for a super admin only;
* the board's lights reach the new types (`z_shift`, `card_transmission`, `till_printer`), and
  SMS rules fire on them only when they name them (dry run as always);
* the data migration turns the new types on for users who had every type, and only for them.

The in-memory SQLite world of tests/test_push_alerts.py; the sender runs inline.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.exception_alerts import ExceptionAlertRule
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import exception_log as LR
from app.routers import push_alerts as R
from app.services import webpush as W
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import push as P
from test_push_alerts import NOW, device, entry, pushes, run, user, w  # noqa: F401


def _other_org(w):
    """A second organization with a company, and a super admin who belongs to it only."""
    tenant = Tenant(id=uuid.uuid4(), name="T2", slug=f"t2-{uuid.uuid4().hex[:6]}", timezone="Asia/Jerusalem")
    w.db.add(tenant)
    w.db.flush()
    company = Company(id=uuid.uuid4(), tenant_id=tenant.id, name="Beta", vat_number="2")
    w.db.add(company)
    admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tenant.id, email="root2@x",
                 username="root2", is_active=True)
    w.db.add(admin)
    w.db.flush()
    return SimpleNamespace(tenant=tenant, company=company, admin=admin)


def _subscribe(w, who, tenant_id, name="phone"):
    from test_push_alerts import browser

    key, p256dh, auth = browser()
    row = P.subscribe(w.db, who, tenant_id, endpoint=f"https://fcm.googleapis.com/fcm/send/{name}-{uuid.uuid4().hex}",
                      p256dh=p256dh, auth=auth, user_agent="Mozilla/5.0 (Linux; Android 14) Chrome/130.0")
    row._key, row._auth = key, auth
    return row


# ── Who receives "שלמות נתונים" ───────────────────────────────────────────────


def test_integrity_reaches_super_admins_only_from_every_organization(w):
    w.admin.is_active = True
    manager = user(w, UserRole.COMPANY_MANAGER)
    shop_manager = user(w, UserRole.SHOP_MANAGER, w.shop)
    for u in (manager, shop_manager):
        device(w, u)
        P.save_preferences(w.db, u, w.tenant.id, {})  # every type they may choose
    root_phone = device(w, w.admin)
    other = _other_org(w)
    other_phone = _subscribe(w, other.admin, other.tenant.id)  # preferences in their own organization only

    refused = entry(w, "document_refused", amount=Decimal("120"), severity="high")
    refused.summary = "מסמך 1007 נדחה: מספור"
    sent = run(w, refused)
    assert {d.user_id for d in sent} == {w.admin.id, other.admin.id}
    assert all(d.status == "sent" for d in sent)
    # The super admin of the other organization goes by their home preferences (not a member here).
    home = P.rule_for_user(w.db, other.admin.id, other.tenant.id)
    assert next(d for d in sent if d.user_id == other.admin.id).rule_id == home.id
    by_endpoint = {c.endpoint: c for c in w.push.calls}
    payload = json.loads(W.decrypt(by_endpoint[root_phone.endpoint].content, root_phone._key, root_phone._auth))
    assert payload["category"] == "integrity" and payload["title"].startswith("שלמות נתונים")
    assert "Acme" in payload["body"] and "מסמך 1007" in payload["body"] and "₪120" in payload["body"]
    assert payload["url"].startswith("/x/")
    assert other_phone.endpoint in by_endpoint
    # Every integrity kind is the category; none is a company's push type.
    for kind in P.INTEGRITY_KINDS:
        assert P.category_of(SimpleNamespace(kind=kind, details=None)) == "integrity"
        assert all(kind not in c.kinds for c in P.CATEGORIES)


def test_a_company_never_receives_integrity_even_when_it_names_it(w):
    manager = user(w, UserRole.COMPANY_MANAGER)
    device(w, manager)
    with pytest.raises(P.RuleError) as err:
        P.save_preferences(w.db, manager, w.tenant.id, {"categories": ["till_offline", "integrity"]})
    assert err.value.code == "category_unknown"
    with pytest.raises(HTTPException) as http:
        R.put_preferences({"integrity": {"companyIds": None}}, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert http.value.status_code == 422
    # Even a rule row that somehow holds it never matches.
    rule = P.rule_for_user(w.db, manager.id, w.tenant.id)
    rule.categories = [*rule.categories, "integrity"]
    w.db.flush()
    assert run(w, entry(w, "z_totals_mismatch", severity="high")) == []


def test_the_super_admins_own_switch_companies_and_devices(w):
    w.admin.is_active = True
    phone = device(w, w.admin, "phone")
    laptop = device(w, w.admin, "laptop")
    # Off: categories without it.
    R.put_preferences({"categories": ["till_offline"]}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert P.integrity_prefs(w.admin)["enabled"] is False
    assert run(w, entry(w, "offline_z_gap", severity="high")) == []
    # On, but only for another company.
    other = _other_org(w)
    out = R.put_preferences({"categories": ["till_offline", "integrity"], "integrity": {"companyIds": [str(other.company.id)]}},
                            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert "integrity" in out["categories"] and out["integrity"]["companyIds"] == [str(other.company.id)]
    assert run(w, entry(w, "offline_z_gap", severity="high")) == []
    # This company: yes — on the devices not muted for it.
    R.put_preferences({"integrity": {"companyIds": [str(w.company.id)]}}, current_user=w.admin,
                      active_tenant_id=w.tenant.id, db=w.db)
    muted = R.update_device(laptop.id, {"integrity": False}, current_user=w.admin, db=w.db)
    assert muted["integrity"] is False
    devices = {d["id"]: d for d in R.list_devices(current_user=w.admin, db=w.db)["devices"]}
    assert devices[str(phone.id)]["integrity"] is True and devices[str(laptop.id)]["integrity"] is False
    sent = run(w, entry(w, "offline_z_conflict", severity="high"))
    assert [d.subscription_id for d in sent] == [phone.id]
    # A company manager may not mute a device for it (they have none of it).
    manager = user(w, UserRole.COMPANY_MANAGER)
    theirs = device(w, manager)
    with pytest.raises(HTTPException) as err:
        R.update_device(theirs.id, {"integrity": False}, current_user=manager, db=w.db)
    assert err.value.status_code == 403
    assert "integrity" not in R.list_devices(current_user=manager, db=w.db)["devices"][0]


def test_integrity_keeps_the_quiet_hours_of_the_preferences(w):
    w.admin.is_active = True
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"quietFrom": "18:00", "quietTo": "23:00"})
    held = run(w, entry(w, "shift_totals_mismatch"), now=NOW + timedelta(hours=1))  # 20:00 local
    assert [d.status for d in held] == ["suppressed_quiet_hours"]


def test_categories_are_listed_and_the_feed_shown_to_a_super_admin_only(w, monkeypatch):
    monkeypatch.setattr(R, "_now", lambda: NOW)
    manager = user(w, UserRole.COMPANY_MANAGER)
    mine = {c["key"] for c in R.get_push_categories(current_user=w.admin)["categories"]}
    theirs = {c["key"] for c in R.get_push_categories(current_user=manager)["categories"]}
    assert "integrity" in mine and "integrity" not in theirs
    assert {"z_shift", "card_transmission", "till_printer"} <= theirs
    assert "integrity" not in {c["key"] for c in R.get_push_config(current_user=manager)["categories"]}
    assert {c["key"] for c in R.get_push_config(current_user=w.admin)["categories"]} == mine
    assert "companies" in R.get_options(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert "companies" not in R.get_options(current_user=manager, active_tenant_id=w.tenant.id, db=w.db)

    refused = entry(w, "document_refused", severity="high")
    late = entry(w, "z_missing", severity="high")
    other = _other_org(w)

    def feed(u, tenant_id):
        return R.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None,
                             open_only=True, days=2, limit=50, current_user=u, active_tenant_id=tenant_id, db=w.db)

    ids = {a["id"]: a for a in feed(w.admin, w.tenant.id)["alerts"]}
    assert ids[str(refused.id)]["categoryLabel"] == "שלמות נתונים" and ids[str(late.id)]["category"] == "z_shift"
    # From another organization's dashboard too (it reaches the phone from all of them).
    away = feed(w.admin, other.tenant.id)
    assert [a["id"] for a in away["alerts"]] == [str(refused.id)] and away["alerts"][0]["tenantId"] == str(w.tenant.id)
    done = R.acknowledge_alert(refused.id, {"note": "נבדק"}, current_user=w.admin, active_tenant_id=other.tenant.id, db=w.db)
    assert done["acknowledged"] is True
    # A company manager: the new type, never integrity — not in the feed, not through its "טופל".
    theirs = [a["id"] for a in feed(manager, w.tenant.id)["alerts"]]
    assert theirs == [str(late.id)]
    with pytest.raises(HTTPException) as err:
        R.acknowledge_alert(refused.id, {}, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 404


def test_the_alerts_link_opens_an_integrity_entry_from_any_organization(w):
    refused = entry(w, "document_refused", severity="high")
    discount = entry(w, "discount", amount=Decimal("5"))
    other = _other_org(w)
    q = LR.filtered(w.db, w.admin, other.tenant.id, code=refused.short_code)
    assert [r.id for r in q.all()] == [refused.id]
    assert LR.filtered(w.db, w.admin, other.tenant.id, code=discount.short_code).all() == []
    manager = user(w, UserRole.COMPANY_MANAGER)
    assert [r.id for r in LR.filtered(w.db, manager, w.tenant.id, code=refused.short_code).all()] == [refused.id]


# ── The new types for everyone ────────────────────────────────────────────────


def test_the_boards_lights_reach_their_new_types(w):
    shop_manager = user(w, UserRole.SHOP_MANAGER, w.shop)
    device(w, shop_manager)
    P.save_preferences(w.db, shop_manager, w.tenant.id, {"rateLimitMinutes": 0})
    for kind, category in (("z_missing", "z_shift"), ("shift_open_overdue", "z_shift"),
                           ("card_transmission_overdue", "card_transmission"), ("till_printer", "till_printer")):
        assert P.category_of(SimpleNamespace(kind=kind, details=None)) == category
        assert [d.status for d in run(w, entry(w, kind))] == ["sent"]
    # Chosen out: nothing.
    P.save_preferences(w.db, shop_manager, w.tenant.id, {"categories": ["till_offline"], "rateLimitMinutes": 0})
    assert run(w, entry(w, "till_printer")) == []


def test_sms_rules_fire_on_the_new_kinds_only_when_they_name_them(w):
    rule = ExceptionAlertRule(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="הכול", kinds=[],
                              recipients=[{"phone": "+972501234567"}])
    for kind in ("z_missing", "shift_open_overdue", "card_transmission_overdue", "till_printer"):
        e = SimpleNamespace(kind=kind, severity="high", amount=None, value=None)
        assert E.entry_matches(rule, e) is False
        rule.kinds = [kind]
        assert E.entry_matches(rule, e) is True
        rule.kinds = []


# ── The data migration ────────────────────────────────────────────────────────


def test_the_migration_turns_the_new_types_on_for_who_had_every_type(w):
    import importlib.util
    import pathlib

    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    original = ["till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached"]

    def rule(categories):
        u = user(w, UserRole.SHOP_MANAGER, w.shop)
        r = ExceptionAlertRule(id=uuid.uuid4(), tenant_id=w.tenant.id, channel="push", owner_user_id=u.id, name="p",
                               categories=categories, kinds=[], recipients=[])
        w.db.add(r)
        return r

    everything = rule([*original, "card_reconcile"])
    picked = rule(["till_offline", "large_void"])
    partly = rule([*original, "till_printer"])
    w.db.commit()
    path = next(pathlib.Path(__file__).parents[1].glob("alembic/versions/3c9e5a7b1d24_*.py"))
    spec = importlib.util.spec_from_file_location("push_categories_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with Operations.context(MigrationContext.configure(w.db.connection())):
        module.upgrade()
        module.upgrade()  # idempotent
    w.db.expire_all()
    assert w.db.get(ExceptionAlertRule, everything.id).categories == [
        *original, "card_reconcile", "z_shift", "card_transmission", "till_printer"]
    assert w.db.get(ExceptionAlertRule, picked.id).categories == ["till_offline", "large_void"]
    assert w.db.get(ExceptionAlertRule, partly.id).categories == [*original, "till_printer", "z_shift", "card_transmission"]
    # A new user (no preferences): every type, the new ones included.
    assert set(P.NEW_CATEGORY_KEYS) <= set(P.clean({})["categories"])
