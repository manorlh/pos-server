"""
The board's lights as alerts (P:/specs/manager-problems.md §2; app/services/exception_alerts/
status_watch.py): "Z לא בוצע", "משמרת פתוחה מעבר לזמן", "שידור אשראי באיחור", "תקלת מדפסת בקופה".

* each is recorded from the same readings as the machines page's flags, once per case (a till /
  shop and business day, a shift, a till and level, a printer fault streak), and closed when
  the light goes out — the log entry mirrors it as handled;
* the policy is the exceptions rules engine ("הגדרות חריגות", GET / PUT /exceptions/rules): on
  by default with the spec's values, per tenant / company / shop / till, null = inherit; a kind
  switched off is neither logged nor sent there, and only there; who may edit is the rules'
  `settingsWrite` scoping (a shop manager their shop, a company manager the company).

The in-memory SQLite world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.exception_alerts import ExceptionLogEntry
from app.models.shift import ShiftStatus
from app.models.z_report import ZReport
from app.routers import exceptions as R
from app.schemas.audit_exception import RuleIn, RulesPut
from app.services import exceptions as svc
from app.services import machine_status as MS
from app.services.exception_alerts import hooks
from app.services.exception_alerts import status_watch as SW
from test_shop_areas import _ctx, refused, w  # noqa: F401

DAY = date(2026, 9, 27)
#: 2026-09-28 00:00 Asia/Jerusalem — the end of DAY.
DAY_END = datetime(2026, 9, 27, 21, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _fresh_printer_streaks(monkeypatch):
    monkeypatch.setattr(SW, "_printer_since", {})


def rows(w, kind):
    return (
        w.db.query(AuditException)
        .filter(AuditException.exception_type == kind)
        .order_by(AuditException.detected_at, AuditException.dedupe_key)
        .all()
    )


def set_rule(w, scope_type, scope_id, kind, enabled=None, **params):
    w.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type=scope_type, scope_id=scope_id,
                                exception_type=kind, enabled=enabled, params=params or None))
    w.db.flush()


def closed_day(w, till, seq, *, documents=True):
    shift = w.shift(till, seq, business_date=DAY, opened_at=datetime(2026, 9, 27, 6, 0, tzinfo=timezone.utc))
    if documents:
        w.doc(till, shift, "50.00")
    return shift


def z_for(w, shifts, *, till=None):
    z = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shifts[0].shop_id, machine_id=till.id if till else None,
                origin="till" if till else "cloud", business_date=DAY, closed_at=DAY_END + timedelta(hours=3))
    w.db.add(z)
    w.db.flush()
    for s in shifts:
        s.z_report_id = z.id
    w.db.flush()


# ── The defaults and the policy ──────────────────────────────────────────────


def test_the_new_kinds_are_rules_on_by_default_with_the_specs_values(w):
    rules = svc.rules_for_machine(w.db, w.tills[0])
    assert rules["z_missing"].enabled and rules["z_missing"].params == {"hoursAfterDayEnd": 2}
    assert rules["shift_open_overdue"].params == {"hours": 16}
    assert rules["card_transmission_overdue"].params == {"warnHours": 24, "criticalDays": 4}
    assert rules["till_printer"].params == {"minutes": 3}
    from app.services.exception_alerts import catalog as CAT

    assert {"z_missing", "shift_open_overdue", "card_transmission_overdue", "till_printer"} <= CAT.OPT_IN_KINDS
    assert CAT.KINDS_BY_KEY["z_missing"].source == "audit_exception"


def test_policy_inherit_override_reset_and_who_may_edit(w):
    put = lambda body, level, target, user=None: R.put_rules(  # noqa: E731
        RulesPut(rules=body), level=level, target_id=target, **_ctx(w, user))
    # The company (a company manager), a shop's own override (its manager), back to inherit (null).
    put([RuleIn(type="z_missing", enabled=True, params={"hoursAfterDayEnd": 5})], "company", w.company.id, w.company_manager)
    shop = put([RuleIn(type="z_missing", enabled=False, params={})], "shop", w.shop.id, w.manager)
    z = next(r for r in shop.rules if r.type == "z_missing")
    assert z.own_enabled is False and z.inherited_enabled is True and z.inherited_params == {"hoursAfterDayEnd": 5}
    assert z.inherited_sources == {"enabled": "company", "hoursAfterDayEnd": "company"} and z.effective_enabled is False
    assert svc.rules_for_machine(w.db, w.other_till)["z_missing"].params == {"hoursAfterDayEnd": 5}
    reset = put([RuleIn(type="z_missing", enabled=None, params={"hoursAfterDayEnd": None})], "shop", w.shop.id, w.manager)
    z = next(r for r in reset.rules if r.type == "z_missing")
    assert z.own_enabled is None and z.effective_enabled is True and z.effective_params == {"hoursAfterDayEnd": 5}
    # Ranges.
    for bad in ({"criticalDays": 8}, {"warnHours": 0}, {"warnHours": 2.5}):
        assert refused(put, [RuleIn(type="card_transmission_overdue", params=bad)], "shop", w.shop.id).status_code == 422
    # A shop manager: their shop only; not the company, not another shop.
    body = [RuleIn(type="till_printer", enabled=False)]
    assert refused(put, body, "company", w.company.id, w.manager).status_code == 403
    assert refused(put, body, "shop", w.other_shop.id, w.manager).status_code == 403
    put(body, "shop", w.other_shop.id, w.company_manager)
    put(body, "shop", w.shop.id)  # the super admin


# ── Z not made ───────────────────────────────────────────────────────────────


def test_z_missing_per_shop_once_a_day_after_the_hours_and_closed_by_the_z(w):
    a = closed_day(w, w.tills[0], 1)
    b = closed_day(w, w.tills[1], 2)
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=1, minutes=59)) == 0  # not 2 hours yet
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=2, minutes=1)) == 1
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=3)) == 0               # once
    [row] = rows(w, "z_missing")
    assert row.machine_id is None and row.shop_id == w.shop.id and row.severity == "high"
    assert row.details["scope"] == "shop" and row.details["businessDate"] == "2026-09-27" and row.details["shiftCount"] == 2
    assert row.occurred_at.replace(tzinfo=timezone.utc) == DAY_END + timedelta(hours=2)
    # The same light the board shows.
    assert MS.date_has_passed(DAY, "Asia/Jerusalem", now=DAY_END + timedelta(minutes=1))
    # Into the log; the Z closes it, and the log follows as handled.
    [entry_id] = hooks.record_rows(w.db, [("audit_exception", row.id)])
    z_for(w, [a, b])
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=4)) == 1
    assert row.details["resolvedAt"] and row.status == "reviewed" and row.review_note.startswith("נסגר אוטומטית")
    hooks.record_rows(w.db, [("audit_exception", row.id)])
    entry = w.db.get(ExceptionLogEntry, entry_id)
    assert entry.acknowledged_at is not None and entry.acknowledged_by_user_id is None and "Z" in entry.note
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=5)) == 0


def test_z_missing_waits_for_the_day_and_needs_documents(w):
    closed_day(w, w.tills[0], 1)
    late = w.shift(w.tills[1], 2, status=ShiftStatus.OPEN, business_date=DAY,
                   opened_at=datetime(2026, 9, 27, 15, 0, tzinfo=timezone.utc))
    SW.scan(w.db, now=DAY_END + timedelta(hours=3))
    assert rows(w, "z_missing") == []                                       # a till of that day still open
    late.status = ShiftStatus.CLOSED
    late.closed_at = DAY_END + timedelta(hours=2)                          # closed at 02:00 local
    w.db.flush()
    SW.scan(w.db, now=DAY_END + timedelta(hours=3, minutes=59))
    assert rows(w, "z_missing") == []                                       # 2 hours after the last close
    SW.scan(w.db, now=DAY_END + timedelta(hours=4, minutes=1))
    assert len(rows(w, "z_missing")) == 1
    # A shift with nothing sold needs no Z.
    closed_day(w, w.other_till, 3, documents=False)
    SW.scan(w.db, now=DAY_END + timedelta(hours=6))
    assert [r.shop_id for r in rows(w, "z_missing")] == [w.shop.id]


def test_z_missing_per_till_in_till_z_mode_and_off_where_the_rule_is_off(w):
    for till in (w.tills[0], w.other_till):
        till.z_mode = "till"
    w.db.flush()
    mine = closed_day(w, w.tills[0], 1)
    closed_day(w, w.other_till, 2)
    set_rule(w, "machine", w.other_till.id, "z_missing", enabled=False)   # off at that till: not logged
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=3)) == 1
    [row] = rows(w, "z_missing")
    assert row.machine_id == w.tills[0].id and row.details["scope"] == "till"
    z_for(w, [mine], till=w.tills[0])
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=4)) == 1 and row.details["resolvedAt"]


def test_switching_z_missing_off_at_one_shop_leaves_the_other(w):
    closed_day(w, w.tills[0], 1)
    closed_day(w, w.other_till, 2)
    set_rule(w, "shop", w.shop.id, "z_missing", enabled=False)
    assert SW.scan(w.db, now=DAY_END + timedelta(hours=3)) == 1
    assert [r.shop_id for r in rows(w, "z_missing")] == [w.other_shop.id]


# ── A shift open past its time ───────────────────────────────────────────────


def test_a_shift_open_too_long_once_per_shift_and_closed_with_it(w):
    now = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)                # 21:00 local
    shift = w.shift(w.tills[0], 1, status=ShiftStatus.OPEN, business_date=DAY, opened_at=now - timedelta(hours=17))
    w.shift(w.tills[1], 2, status=ShiftStatus.OPEN, business_date=DAY, opened_at=now - timedelta(hours=10))
    assert SW.scan(w.db, now=now) == 1
    assert SW.scan(w.db, now=now + timedelta(minutes=5)) == 0
    [row] = rows(w, "shift_open_overdue")
    assert row.shift_id == shift.id and row.details["reason"] == "hours" and row.threshold == 16 and row.value == 17
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = now + timedelta(minutes=10)
    w.db.flush()
    assert SW.scan(w.db, now=now + timedelta(minutes=11)) == 1 and row.details["resolvedAt"]


def test_a_shift_past_its_date_and_the_hours_from_the_rule(w):
    opened = datetime(2026, 9, 26, 19, 0, tzinfo=timezone.utc)             # 22:00 local on the 26th
    w.shift(w.tills[0], 1, status=ShiftStatus.OPEN, business_date=date(2026, 9, 26), opened_at=opened)
    assert SW.scan(w.db, now=datetime(2026, 9, 26, 20, 59, tzinfo=timezone.utc)) == 0
    assert SW.scan(w.db, now=datetime(2026, 9, 26, 21, 1, tzinfo=timezone.utc)) == 1  # 00:01 local: past its date
    assert rows(w, "shift_open_overdue")[0].details["reason"] == "past_date"
    # The company's hours, and off at a till.
    now = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
    set_rule(w, "company", w.company.id, "shift_open_overdue", hours=20)
    w.shift(w.tills[1], 2, status=ShiftStatus.OPEN, business_date=DAY, opened_at=now - timedelta(hours=17))
    set_rule(w, "machine", w.other_till.id, "shift_open_overdue", enabled=False)
    w.shift(w.other_till, 3, status=ShiftStatus.OPEN, business_date=date(2026, 9, 25),
            opened_at=now - timedelta(hours=40))
    assert SW.scan(w.db, now=now) == 0


# ── Card transmission ────────────────────────────────────────────────────────


def _pending(till, now, *, oldest_hours, count=3):
    till.transmission_tracking_started_at = now - timedelta(days=30)
    till.transmission_reported_at = now - timedelta(minutes=1)
    till.transmission_pending_count = count
    till.transmission_pending_amount = Decimal("240.00")
    till.transmission_oldest_pending_at = now - timedelta(hours=oldest_hours)
    till.transmission_last_success_at = now - timedelta(hours=oldest_hours + 1)


def test_card_transmission_medium_then_high_once_each_and_closed_when_sent(w):
    now = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
    till = w.tills[0]
    _pending(till, now, oldest_hours=10)
    w.db.flush()
    assert SW.scan(w.db, now=now) == 0
    _pending(till, now, oldest_hours=30)
    w.db.flush()
    assert SW.scan(w.db, now=now) == 1
    assert SW.scan(w.db, now=now + timedelta(minutes=5)) == 0
    [medium] = rows(w, "card_transmission_overdue")
    assert medium.severity == "medium" and medium.amount == Decimal("240.00") and medium.details["level"] == "medium"
    # The board's flag with the same readings agrees.
    data = MS.StatusInput(transmission_pending=True, transmission_oldest_pending_at=till.transmission_oldest_pending_at,
                          transmission_last_success_at=till.transmission_last_success_at)
    assert MS.MachineFlag.TRANSMISSION_OVERDUE in MS.transmission_flags(data, now=now)
    later = now + timedelta(days=3, hours=19)                               # the oldest 4 days + 1 hour old
    assert SW.scan(w.db, now=later) == 2                                    # high written, medium closed
    medium_row, high = sorted(rows(w, "card_transmission_overdue"), key=lambda r: r.severity != "medium")
    assert high.severity == "high" and medium_row.details["resolvedAt"]
    assert SW.scan(w.db, now=later + timedelta(minutes=5)) == 0
    till.transmission_pending_count = 0
    till.transmission_last_success_at = later + timedelta(minutes=6)
    w.db.flush()
    assert SW.scan(w.db, now=later + timedelta(minutes=7)) == 1 and high.details["resolvedAt"]


def test_card_transmission_thresholds_come_from_the_rule(w):
    now = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
    _pending(w.tills[0], now, oldest_hours=30)
    set_rule(w, "shop", w.shop.id, "card_transmission_overdue", warnHours=48)
    _pending(w.other_till, now, oldest_hours=30)
    set_rule(w, "shop", w.other_shop.id, "card_transmission_overdue", criticalDays=1)
    w.db.flush()
    assert SW.scan(w.db, now=now) == 1
    [row] = rows(w, "card_transmission_overdue")
    assert row.machine_id == w.other_till.id and row.severity == "high"


# ── The till's printer ───────────────────────────────────────────────────────


def test_a_printer_fault_after_the_minutes_once_per_streak_and_closed_when_fine(w):
    t0 = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
    till = w.tills[0]
    w.shift(till, 1, status=ShiftStatus.OPEN, business_date=DAY, opened_at=t0 - timedelta(hours=2))
    w.shift(w.tills[1], 2, status=ShiftStatus.CLOSED, business_date=DAY)
    w.tills[1].printer_status = "no_paper"                                 # no open shift there: not news

    def at(minutes, status="no_paper"):
        till.printer_status = status
        till.last_heartbeat_at = t0 + timedelta(minutes=minutes, seconds=-10)
        w.db.flush()
        return SW.scan(w.db, now=t0 + timedelta(minutes=minutes))

    assert at(0) == 0
    assert at(2) == 0
    assert at(3, "error") == 1                                              # 3 minutes of one streak
    assert at(4) == 0
    [row] = rows(w, "till_printer")
    assert row.machine_id == till.id and row.details["printerStatus"] == "error" and row.dedupe_key.endswith(":1")
    assert at(5, "ok") == 1 and row.details["resolvedAt"]
    assert at(6) == 0 and at(10) == 1                                       # a new streak, a new row
    assert [r.dedupe_key.rsplit(":", 1)[1] for r in rows(w, "till_printer")] == ["1", "2"]


def test_a_printer_rule_switched_off_logs_nothing(w):
    t0 = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
    till = w.tills[0]
    w.shift(till, 1, status=ShiftStatus.OPEN, business_date=DAY, opened_at=t0 - timedelta(hours=2))
    set_rule(w, "machine", till.id, "till_printer", enabled=False)
    till.printer_status = "overheated"
    for minutes in (0, 5, 10):
        till.last_heartbeat_at = t0 + timedelta(minutes=minutes)
        w.db.flush()
        assert SW.scan(w.db, now=t0 + timedelta(minutes=minutes)) == 0
    assert rows(w, "till_printer") == []


def test_the_watch_runs_at_most_every_two_minutes(monkeypatch):
    monkeypatch.setattr(SW, "_last_run", None)
    t = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)
    assert SW.due(t) and not SW.due(t + timedelta(minutes=1)) and SW.due(t + timedelta(minutes=2))
