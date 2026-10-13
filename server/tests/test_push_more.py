"""
More phone alerts, per level (P:/specs/push-more.md §A, §B, §B2):

* "שלח התראה לטלפון" (`push`) on each exception rule, per tenant / company / shop / till like the
  rest — on by default for what was always sent and the battery, off for the new types; on at one
  shop sends from that shop only; null inherits again; a kind detected elsewhere has only it;
* the amount: each kind's rule floor where it happened, the user's own floor on top of it;
* the void's message names the employee, the approver, the reason and the document; the drawer type
  has the denied attempt, the cash out over the threshold and the count variance;
* "סוללה חלשה": on by default, `batteryPushLevel` (all / critical / off), the critical one red; a
  charge closes its log entry and sends nothing;
* urgent alerts (`integrity`, a critical battery) skip the rate limit and the digest; quiet hours
  still hold them, and they go one by one when the quiet hours end;
* the alerts feed lists a switched-on kind only where it is switched on;
* the data migration turns the new types on for users who had every type.

The in-memory SQLite world of tests/test_push_alerts.py; the sender runs inline.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

from app.models.audit_exception import ExceptionRuleValue
from app.models.device_battery import DeviceBatteryAlert
from app.models.exception_alerts import ExceptionAlertRule, ExceptionLogEntry
from app.models.user import UserRole
from app.routers import exceptions as XR
from app.routers import push_alerts as R
from app.schemas.audit_exception import RuleIn, RulesPut
from app.services import battery_alerts as BA
from app.services import exceptions as EX
from app.services import webpush as W
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import hooks
from app.services.exception_alerts import push as P
from test_push_alerts import NOW, device, entry, pushes, run, user, w  # noqa: F401


def push_rule(w, scope_type, scope_id, kind, **params):
    w.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type=scope_type, scope_id=scope_id,
                                exception_type=kind, params=params))
    w.db.flush()


def manager_with_phone(w, shop=None, **prefs):
    u = user(w, UserRole.SHOP_MANAGER, shop or w.shop)
    phone = device(w, u)
    P.save_preferences(w.db, u, w.tenant.id, {"rateLimitMinutes": 0, **prefs})
    return u, phone


def battery(w, *, percent=10, level=10, severity="warning", machine=None):
    till = machine or w.tills[0]
    row = DeviceBatteryAlert(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=till.shop_id, machine_id=till.id,
                             cycle_id=uuid.uuid4(), level=level, percent=percent, last_percent=percent,
                             severity=severity, raised_at=NOW - timedelta(minutes=1))
    w.db.add(row)
    w.db.flush()
    [entry_id] = hooks.record_rows(w.db, [("battery", row.id)])
    return row, w.db.get(ExceptionLogEntry, entry_id)


def ctx(w):
    return dict(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


# ── The organization's push switch ───────────────────────────────────────────


def test_a_new_type_is_sent_only_where_a_level_switches_it_on(w):
    center, _ = manager_with_phone(w)
    north, _ = manager_with_phone(w, w.other_shop)
    assert EX.RULES_BY_TYPE["discount"].push_default is False
    assert run(w, entry(w, "discount", amount=Decimal("500"))) == []          # off by default: logged only
    out = XR.put_rules(RulesPut(rules=[RuleIn(type="discount", push=True)]), level="shop", target_id=w.shop.id, **ctx(w))
    rule = next(r for r in out.rules if r.type == "discount")
    assert rule.own_push is True and rule.effective_push is True and rule.inherited_push is False
    assert rule.own_enabled is None and rule.own_params == {}
    sent = run(w, entry(w, "discount", amount=Decimal("500")))
    assert [d.user_id for d in sent] == [center.id]
    assert run(w, entry(w, "discount", amount=Decimal("500"), shop=w.other_shop, machine=w.other_till)) == []
    # A till turns it off under its shop; null at the shop inherits again (off).
    push_rule(w, "machine", w.tills[1].id, "discount", push=False)
    assert run(w, entry(w, "discount", amount=Decimal("500"), machine=w.tills[1])) == []
    XR.put_rules(RulesPut(rules=[RuleIn(type="discount", push=None)]), level="shop", target_id=w.shop.id, **ctx(w))
    assert run(w, entry(w, "discount", amount=Decimal("500"))) == []
    # The switch is not a threshold.
    from fastapi import HTTPException

    try:
        XR.put_rules(RulesPut(rules=[RuleIn(type="discount", params={"push": 1})]), level="shop", target_id=w.shop.id, **ctx(w))
        raise AssertionError("refused expected")
    except HTTPException as err:
        assert err.status_code == 422
    assert north is not None


def test_what_was_always_sent_stays_on_and_can_be_switched_off(w):
    center, _ = manager_with_phone(w)
    assert EX.RULES_BY_TYPE["till_offline"].push_default is True
    assert len(run(w, entry(w, "till_offline"))) == 1
    push_rule(w, "company", w.company.id, "till_offline", push=False)
    assert run(w, entry(w, "till_offline")) == []
    # "שלמות נתונים" is the super admins': no level switches it off.
    push_rule(w, "company", w.company.id, "offline_z_gap", push=False)
    device(w, w.admin)
    assert [d.user_id for d in run(w, entry(w, "offline_z_gap", severity="high"))] == [w.admin.id]
    assert center is not None


def test_a_kind_detected_elsewhere_has_only_its_push_switch(w):
    out = XR.put_rules(RulesPut(rules=[RuleIn(type="stock_out", enabled=False, push=True)]), level="shop",
                       target_id=w.shop.id, **ctx(w))
    rule = next(r for r in out.rules if r.type == "stock_out")
    assert rule.push_only is True and rule.own_enabled is None and rule.own_push is True
    assert rule.push_category == "stock"
    kinds = {r.type: r for r in out.rules}
    assert kinds["offline_z_gap"].push_category == "integrity" and kinds["local_shop_z_till_unsynced"].push_category is None
    assert EX.RULES_BY_TYPE["device_battery"].push_only and EX.RULES_BY_TYPE["device_battery"].push_default


# ── The amount ───────────────────────────────────────────────────────────────


def test_the_rules_floor_and_the_users_own_floor_above_it(w):
    push_rule(w, "shop", w.shop.id, "discount", push=True, minAmount=50)
    picky, _ = manager_with_phone(w, minAmount=300)
    easy, _ = manager_with_phone(w, minAmount=0)
    assert [d.user_id for d in run(w, entry(w, "discount", amount=Decimal("100")))] == [easy.id]
    assert {d.user_id for d in run(w, entry(w, "discount", amount=Decimal("350")))} == {picky.id, easy.id}
    # A refund under the rule's floor where it happened is not sent, whatever the user chose.
    push_rule(w, "shop", w.shop.id, "refund", minAmount=500)
    assert run(w, entry(w, "refund", amount=Decimal("-300"))) == []
    assert {d.user_id for d in run(w, entry(w, "refund", amount=Decimal("-600")))} == {picky.id, easy.id}


# ── The message ──────────────────────────────────────────────────────────────


def test_a_void_names_the_employee_the_approver_the_reason_and_the_document(w):
    _, phone = manager_with_phone(w)
    e = entry(w, "table_cancelled", amount=Decimal("480"), details={"reason": "לקוח עזב", "approvedBy": "יוסי"})
    e.pos_user_name = "דנה"
    run(w, e)
    payload = json.loads(W.decrypt(w.push.calls[-1].content, phone._key, phone._auth))
    assert payload["title"].startswith("ביטול / זיכוי גדול")
    for part in ("עובד: דנה", "אישר: יוסי", "סיבה: לקוח עזב", "₪480"):
        assert part in payload["body"], part
    refund = entry(w, "refund", amount=Decimal("-250"), details={"transactionNumber": "1042", "approvedBy": str(w.admin.id)})
    run(w, refund)
    payload = json.loads(W.decrypt(w.push.calls[-1].content, phone._key, phone._auth))
    assert "מסמך 1042" in payload["body"] and "אישר: admin" in payload["body"]


def test_the_drawer_type_has_the_denied_attempt_the_cash_out_and_the_count_variance(w):
    for kind in ("drawer_open_denied", "cash_out_over_threshold", "drawer_count_variance"):
        assert P.category_of(entry(w, kind)) == "drawer_no_sale"


# ── The battery ──────────────────────────────────────────────────────────────


def test_a_low_battery_reaches_the_manager_red_when_critical_and_closes_on_charge(w):
    _, phone = manager_with_phone(w)
    row, e = battery(w, percent=10, level=10)
    assert e.kind == "device_battery" and e.severity == "low"
    assert [d.status for d in run(w, e)] == ["sent"]
    payload = json.loads(W.decrypt(w.push.calls[-1].content, phone._key, phone._auth))
    assert payload["title"].startswith("סוללה חלשה") and "קופה 1, Center: סוללה 10%" in payload["body"]
    _, critical = battery(w, percent=5, level=5, severity="critical")
    assert critical.severity == "high" and P.is_urgent(critical)
    run(w, critical)
    payload = json.loads(W.decrypt(w.push.calls[-1].content, phone._key, phone._auth))
    assert payload["severity"] == "high" and "(קריטי)" in payload["body"]
    # Charged: the entry closes by itself; nothing is sent for it.
    calls = len(w.push.calls)
    row.cleared_at = NOW
    row.clear_reason = "charging"
    w.db.flush()
    assert hooks.record_rows(w.db, [("battery", row.id)]) == []
    w.db.flush()
    assert e.acknowledged_at is not None and "בטעינה" in e.note and len(w.push.calls) == calls


def test_the_battery_push_level_and_the_rules_switch(w, monkeypatch):
    manager_with_phone(w)
    monkeypatch.setattr(BA, "push_level_of", lambda db, machine, params=None: BA.PUSH_CRITICAL)
    assert run(w, battery(w, percent=10, level=10)[1]) == []
    assert len(run(w, battery(w, percent=5, level=5, severity="critical")[1])) == 1
    monkeypatch.setattr(BA, "push_level_of", lambda db, machine, params=None: BA.PUSH_OFF)
    assert run(w, battery(w, percent=5, level=5, severity="critical")[1]) == []
    monkeypatch.setattr(BA, "push_level_of", lambda db, machine, params=None: BA.PUSH_ALL)
    push_rule(w, "shop", w.shop.id, "device_battery", push=False)
    assert run(w, battery(w, percent=10, level=10)[1]) == []
    assert any(s["key"] == BA.PUSH_LEVEL_KEY and s["default_value"] == BA.PUSH_ALL for s in BA.BATTERY_PARAMETER_SPECS)


# ── Urgent alerts ────────────────────────────────────────────────────────────


def test_urgent_alerts_skip_the_rate_limit_and_the_digest_quiet_hours_still_hold_them(w):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"rateLimitMinutes": 60, "digestEnabled": False})
    assert run(w, entry(w, "till_offline"))[0].status == "sent"
    assert run(w, entry(w, "kiosk_offline"))[0].status == "suppressed_rate_limit"
    assert run(w, entry(w, "document_refused", severity="high"))[0].status == "sent"   # urgent: past the limit
    _, critical = battery(w, percent=5, level=5, severity="critical")
    assert run(w, critical)[0].status == "sent"
    # Quiet hours hold an urgent one; when they end it goes on its own — no digest, not the limit.
    P.save_preferences(w.db, w.admin, w.tenant.id, {"quietFrom": "18:00", "quietTo": "23:00"})
    quiet_now = NOW + timedelta(hours=1)                                   # 20:00 local
    held = run(w, entry(w, "z_totals_mismatch", severity="high", minutes_ago=0), now=quiet_now)
    assert [d.status for d in held] == ["suppressed_quiet_hours"]
    assert E.flush_digests(w.db, now=quiet_now + timedelta(minutes=30)) == 0
    after = NOW + timedelta(hours=4, minutes=1)                            # 23:01 local
    assert E.flush_digests(w.db, now=after) == 1
    late = [d for d in pushes(w) if d.dedupe_key.startswith("push:late:")]
    assert len(late) == 1 and late[0].kind == "alert" and late[0].entry_id == held[0].entry_id
    assert w.db.get(type(held[0]), held[0].id).digest_id == late[0].id
    # The rate-limited one was not summed up (no digest) and is not looked at again.
    assert E.flush_digests(w.db, now=after + timedelta(minutes=5)) == 0


def test_after_the_quiet_hours_an_urgent_alert_goes_alone_and_the_rest_in_the_digest(w):
    device(w, w.admin)
    P.save_preferences(w.db, w.admin, w.tenant.id, {"quietFrom": "18:00", "quietTo": "23:00", "rateLimitMinutes": 0})
    quiet_now = NOW + timedelta(hours=1)                                   # 20:00 local
    urgent = run(w, entry(w, "document_refused", severity="high", minutes_ago=0), now=quiet_now)
    run(w, entry(w, "till_offline", minutes_ago=0), now=quiet_now)
    run(w, entry(w, "kiosk_offline", minutes_ago=0), now=quiet_now)
    assert E.flush_digests(w.db, now=NOW + timedelta(hours=4, minutes=1)) == 2   # the urgent one + one digest
    sent = [d for d in pushes(w) if d.status == "sent"]
    assert sorted(d.kind for d in sent) == ["alert", "digest"]
    assert next(d for d in sent if d.kind == "alert").entry_id == urgent[0].entry_id
    assert next(d for d in sent if d.kind == "digest").digest_count == 2


# ── The feed ─────────────────────────────────────────────────────────────────


def test_the_feed_lists_a_switched_on_kind_only_where_it_is_on(w, monkeypatch):
    monkeypatch.setattr(R, "_now", lambda: NOW)
    here = entry(w, "discount", amount=Decimal("80"))
    there = entry(w, "discount", amount=Decimal("80"), shop=w.other_shop, machine=w.other_till)
    push_rule(w, "shop", w.shop.id, "discount", push=True)
    feed = R.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, open_only=True,
                         days=2, limit=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    ids = {a["id"] for a in feed["alerts"]}
    assert str(here.id) in ids and str(there.id) not in ids and feed["open"] == 1
    assert feed["alerts"][0]["categoryLabel"] == "הנחות, מחירים ועל חשבון הבית"


# ── The data migration ───────────────────────────────────────────────────────


def test_the_migration_turns_the_push_more_types_on_for_who_had_every_type(w):
    import importlib.util
    import pathlib

    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    original = ["till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached"]
    owner = user(w, UserRole.SHOP_MANAGER, w.shop)
    other = user(w, UserRole.SHOP_MANAGER, w.shop)
    everything = ExceptionAlertRule(id=uuid.uuid4(), tenant_id=w.tenant.id, channel="push", owner_user_id=owner.id,
                                    name="p", categories=list(original), kinds=[], recipients=[])
    picked = ExceptionAlertRule(id=uuid.uuid4(), tenant_id=w.tenant.id, channel="push", owner_user_id=other.id,
                                name="p", categories=["large_void"], kinds=[], recipients=[])
    w.db.add_all([everything, picked])
    w.db.commit()
    path = next(pathlib.Path(__file__).parents[1].glob("alembic/versions/8d4f2a6c1e93_*.py"))
    spec = importlib.util.spec_from_file_location("push_more_categories_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with Operations.context(MigrationContext.configure(w.db.connection())):
        module.upgrade()
        module.upgrade()
    w.db.expire_all()
    assert w.db.get(ExceptionAlertRule, everything.id).categories == [*original, *P.PUSH_MORE_CATEGORY_KEYS]
    assert w.db.get(ExceptionAlertRule, picked.id).categories == ["large_void"]
    assert set(P.PUSH_MORE_CATEGORY_KEYS) <= set(P.CATEGORY_KEYS)
