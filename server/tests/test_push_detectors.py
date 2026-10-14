"""
"עוד התראות Push" — the new detections (P:/specs/push-more.md §C) and the live till checks (§B2).

Each detector, on the in-memory SQLite world of tests/shift_world.py:

* is silent by default (every new kind is off until a level switches it on);
* fires once for its case — per shop and day, per table opening, per KDS ticket, per streak —
  and a second pass adds nothing;
* reads its switch and thresholds by level (a shop's or a till's own value beats its company's);
* closes its row by itself when the case is over (the shop opened, the table was paid, the
  ticket is ready, the till sells again) — and the log entry follows as "טופל";
* the daily summary's figures are the reports' and it is information, not a problem;
* "קופה כמעט לא מוכרת" runs from the background every 10 minutes with thresholds by level.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.exception_alerts import ExceptionAlertDispatch, ExceptionLogEntry
from app.models.kds import KitchenDispatch, KitchenOrder, KitchenTask
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import ShiftStatus
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import exception_log as LOGR
from app.routers import exceptions as XR
from app.routers import insights as IR
from app.services import webpush as W
from app.services.exception_alerts import catalog as C
from app.services.exception_alerts import daily_summary as DS
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import hooks as H
from app.services.exception_alerts import push as P
from app.services.exception_alerts import service_watch as SV
from app.services.exception_alerts import shop_watch as SW
from app.services.exception_alerts import till_activity as TA
from app.services.exception_alerts import worker
from shift_world import accept_str_uuids, make_world

JLM = ZoneInfo("Asia/Jerusalem")
UTC = timezone.utc
DAY = date(2026, 9, 27)  # a Sunday (weekday digit 1); IDT, UTC+3


def local(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=JLM).astimezone(UTC)


class FakePushService:
    def __init__(self):
        self.calls = []

    def post(self, endpoint, content, headers, timeout):
        self.calls.append((endpoint, content))
        from types import SimpleNamespace

        return SimpleNamespace(status_code=201)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    private, public = W.generate_vapid_keys()
    monkeypatch.setattr(W, "config", lambda: W.VapidConfig(public_key=public, private_key=private, subject="mailto:t@example.com"))
    world.push = FakePushService()
    monkeypatch.setattr(P, "SEND_MODE", "inline")
    monkeypatch.setattr(P, "TRANSPORT", world.push)
    SW.reset()
    TA.reset()
    yield world
    SW.reset()
    TA.reset()


def rule(w, kind, *, level="company", target=None, enabled=True, **params):
    scope_id = {
        "tenant": w.tenant.id,
        "company": w.company.id,
        "shop": (target or w.shop).id,
        "machine": target.id if target is not None else None,
    }[level]
    w.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type=level, scope_id=scope_id,
                                exception_type=kind, enabled=enabled, params=params or None))
    w.db.flush()


def rows(w, kind):
    return w.db.query(AuditException).filter(AuditException.exception_type == kind).order_by(AuditException.occurred_at).all()


def sale(w, till, when, total, *, shift=None, credit_note=False, discount="0"):
    tx = w.doc(till, shift, str(total), credit_note=credit_note, discount=discount)
    tx.created_at = when
    w.db.flush()
    return tx


def till(w, name, shop=None):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=(shop or w.shop).id, distributor_id=w.admin.id, name=name,
        machine_code=f"M-{uuid.uuid4().hex[:6]}", pos_number=str(len(w.tills) + 10), is_active=True,
        pairing_status=PairingStatus.ASSIGNED, last_heartbeat_at=datetime.now(UTC),
    )
    w.db.add(m)
    w.db.flush()
    w.tills.append(m)
    return m


def device(w, user, categories):
    import os

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    P.subscribe(w.db, user, w.tenant.id, endpoint=f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}",
                p256dh=W.b64u(public), auth=W.b64u(os.urandom(16)), user_agent="Chrome/130 Android")
    P.save_preferences(w.db, user, w.tenant.id, {"categories": categories})


def to_log(w, row, now):
    """The hooks' path for one exception row: its log entry, then the alert rules (SMS + push)."""
    created = H.record_rows(w.db, [("audit_exception", row.id)])
    for entry_id in created:
        E.process_entry(w.db, w.db.get(ExceptionLogEntry, entry_id), now=now)
    return w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.audit_exception_id == row.id).one()


def pushes(w):
    return w.db.query(ExceptionAlertDispatch).filter(ExceptionAlertDispatch.channel == "push").all()


# ═════════════════════════════════════════════════════════════════════════════
# Off by default, and on the settings page
# ═════════════════════════════════════════════════════════════════════════════

NEW_KINDS = ("shop_not_opened", "sales_pace_low", "table_open_long", "kds_ticket_late", "daily_summary", "till_idle")


def test_every_new_kind_is_a_rule_off_by_default_listed_with_its_thresholds(w):
    out = XR.get_rules(level="tenant", target_id=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    by_type = {r.type: r for r in out.rules}
    for kind in NEW_KINDS:
        assert by_type[kind].default_enabled is False and by_type[kind].effective_enabled is False
        assert kind in C.KINDS_BY_KEY and kind in C.OPT_IN_KINDS
    assert {p.key for p in by_type["shop_not_opened"].params} == {"time", "days"}
    assert {p.key for p in by_type["sales_pace_low"].params} == {"pacePercent", "minHoursOpen", "weeks"}
    assert [p.key for p in by_type["table_open_long"].params] == ["openMinutes"]
    assert [p.key for p in by_type["kds_ticket_late"].params] == ["readyMinutes"]
    assert [(p.key, p.default) for p in by_type["daily_summary"].params] == [("at", -1)]
    assert {p.key for p in by_type["till_idle"].params} == {"idleMinutes", "minPeers"}
    # The push categories.
    assert P.CATEGORY_BY_KEY["shop_open"].kinds == ("shop_not_opened",)
    assert P.CATEGORY_BY_KEY["sales_pace"].kinds == ("sales_pace_low",)
    assert set(P.CATEGORY_BY_KEY["slow_order"].kinds) >= {"table_open_long", "kds_ticket_late"}
    assert P.CATEGORY_BY_KEY["daily_summary"].kinds == ("daily_summary",)
    assert "till_idle" in P.CATEGORY_BY_KEY["till_low_sales"].kinds
    assert C.INFO_KINDS == {"daily_summary"} and C.is_info("daily_summary") and not C.is_info("shop_not_opened")


def test_nothing_fires_while_the_kinds_are_off(w):
    t1, t2 = w.tills
    now = local(DAY, 15, 0)
    # A shop that never opened, a table open for hours, a late ticket, an idle till, a Z.
    w.db.add(ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id, business_date=DAY,
                     closed_at=now - timedelta(minutes=5)))
    zone, table = _table(w)
    _order(w, table, zone, opened=now - timedelta(hours=5))
    _ticket(w, released=now - timedelta(hours=1))
    w.db.flush()
    for job in (SW.scan_not_opened, SW.scan_sales_pace, SV.scan_tables, SV.scan_kds, TA.scan_idle, DS.scan):
        assert job(w.db, now=now) == 0
    assert w.db.query(AuditException).count() == 0
    assert w.db.query(ExceptionLogEntry).count() == 0


# ═════════════════════════════════════════════════════════════════════════════
# "הסניף לא נפתח"
# ═════════════════════════════════════════════════════════════════════════════


def test_shop_not_opened_fires_once_by_the_deadline_and_closes_when_it_opens(w):
    rule(w, "shop_not_opened", time=10)
    rule(w, "shop_not_opened", level="shop", target=w.other_shop, enabled=False)  # North: off
    assert SW.scan_not_opened(w.db, now=local(DAY, 9, 59)) == 0
    assert SW.scan_not_opened(w.db, now=local(DAY, 10, 5)) == 1
    assert SW.scan_not_opened(w.db, now=local(DAY, 10, 6)) == 0  # once per shop and day
    (row,) = rows(w, "shop_not_opened")
    assert row.shop_id == w.shop.id and row.machine_id is None and row.status == "new"
    assert row.occurred_at.replace(tzinfo=UTC) == local(DAY, 10) and "עד 10:00" in row.details["summary"]
    # Into the log and onto a phone that chose "הסניף לא פתח".
    device(w, w.admin, ["shop_open"])
    entry = to_log(w, row, local(DAY, 10, 6))
    assert entry.kind == "shop_not_opened" and entry.acknowledged_at is None
    (sent,) = pushes(w)
    assert sent.status == "sent" and "הסניף לא פתח" in sent.text and "Center" in sent.text
    # The shop opens: the row closes by itself, and its log entry with it.
    w.shift(w.tills[0], 1, status=ShiftStatus.OPEN, opened_at=local(DAY, 10, 20))
    assert SW.scan_not_opened(w.db, now=local(DAY, 10, 21)) == 1
    assert row.status == "reviewed" and row.review_note.startswith("נסגר אוטומטית") and "10:20" in row.review_note
    assert row.details["openedBy"] == "shift"
    H.record_rows(w.db, [("audit_exception", row.id)])
    assert entry.acknowledged_at is not None and entry.note.startswith("נסגר אוטומטית")
    assert len(pushes(w)) == 1  # nothing sent for the closing


def test_shop_not_opened_by_level_days_and_a_sale_counts_as_open(w):
    rule(w, "shop_not_opened", time=10)
    rule(w, "shop_not_opened", level="shop", target=w.shop, time=1130)  # Center: 11:30
    assert SW.scan_not_opened(w.db, now=local(DAY, 10, 30)) == 1      # North only
    assert [r.shop_id for r in rows(w, "shop_not_opened")] == [w.other_shop.id]
    sale(w, w.tills[0], local(DAY, 11, 0), 40)                          # Center sold at 11:00
    assert SW.scan_not_opened(w.db, now=local(DAY, 11, 35)) == 0      # a sale is the shop open
    # Not a working day: the company leaves Sunday (1) out — Center's own row sets only the time.
    company = w.db.query(ExceptionRuleValue).filter(ExceptionRuleValue.scope_type == "company").one()
    company.params = {"time": 10, "days": 234567}
    w.db.flush()
    nxt = DAY + timedelta(days=7)
    assert SW.scan_not_opened(w.db, now=local(nxt, 10, 30)) == 0
    assert SW.scan_not_opened(w.db, now=local(nxt + timedelta(days=1), 11, 45)) == 2  # Monday: both


def test_the_deadline_reads_hours_or_hhmm(w):
    assert SW.deadline_clock(10).strftime("%H:%M") == "10:00"
    assert SW.deadline_clock(9.5).strftime("%H:%M") == "09:30"
    assert SW.deadline_clock(930).strftime("%H:%M") == "09:30"
    assert SW.deadline_clock(1045).strftime("%H:%M") == "10:45"
    assert SW.deadline_clock(50).strftime("%H:%M") == "10:00"     # neither: the default
    assert SW.working_days(123456) == {1, 2, 3, 4, 5, 6} and SW.working_days(890) == set(range(1, 8))


# ═════════════════════════════════════════════════════════════════════════════
# "קצב מכירות נמוך"
# ═════════════════════════════════════════════════════════════════════════════


def _pace_history(w, *, weeks=4, per_week=1000, today=300):
    t1 = w.tills[0]
    for k in range(1, weeks + 1):
        d = DAY - timedelta(days=7 * k)
        for h in (10, 11, 12, 13):
            sale(w, t1, local(d, h), per_week / 4)
        sale(w, t1, local(d, 18), 5000)  # after 14:00: not part of "to the same hour"
    w.shift(t1, 1, status=ShiftStatus.OPEN, opened_at=local(DAY, 9))
    sale(w, t1, local(DAY, 10), today)


def test_sales_pace_low_once_a_day_and_at_most_hourly(w):
    _pace_history(w)
    rule(w, "sales_pace_low")
    assert SW.scan_sales_pace(w.db, now=local(DAY, 14, 5)) == 1
    (row,) = rows(w, "sales_pace_low")
    assert row.amount == Decimal("300.00") and row.value == Decimal("30.00") and row.threshold == Decimal("60.00")
    assert row.details["averageNet"] == 1000.0 and len(row.details["references"]) == 4
    assert "30%" in row.details["summary"] and "₪1,000" in row.details["summary"]
    SW.reset()
    assert SW.scan_sales_pace(w.db, now=local(DAY, 15, 5)) == 0  # once a day


def test_sales_pace_respects_the_shop_level_the_hour_and_the_references(w):
    _pace_history(w)
    rule(w, "sales_pace_low")
    rule(w, "sales_pace_low", level="shop", target=w.shop, pacePercent=25)
    assert SW.scan_sales_pace(w.db, now=local(DAY, 14, 5)) == 0  # 30% is above the shop's 25%
    rule_row = w.db.query(ExceptionRuleValue).filter(ExceptionRuleValue.scope_type == "shop").one()
    rule_row.params = {"pacePercent": 50}
    w.db.flush()
    assert SW.scan_sales_pace(w.db, now=local(DAY, 14, 30)) == 0  # judged already this hour
    assert SW.scan_sales_pace(w.db, now=local(DAY, 15, 1)) == 1   # next hour: 30% < 50%


def test_sales_pace_needs_the_open_hours_and_two_references(w):
    _pace_history(w, weeks=1)
    rule(w, "sales_pace_low")
    assert SW.scan_sales_pace(w.db, now=local(DAY, 14, 5)) == 0      # one reference of the four
    SW.reset()
    rule(w, "sales_pace_low", level="shop", target=w.shop, weeks=1, minHoursOpen=6)
    assert SW.scan_sales_pace(w.db, now=local(DAY, 14, 5)) == 0      # open 5 hours of the 6
    SW.reset()
    assert SW.scan_sales_pace(w.db, now=local(DAY, 15, 5)) == 1


# ═════════════════════════════════════════════════════════════════════════════
# "שולחן פתוח זמן רב"
# ═════════════════════════════════════════════════════════════════════════════


def _table(w, shop=None):
    shop = shop or w.shop
    zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, name="גן")
    w.db.add(zone)
    w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, zone_id=zone.id, number=12)
    w.db.add(table)
    w.db.flush()
    return zone, table


def _order(w, table, zone, *, opened, source="synced", machine=None):
    o = TableOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=table.shop_id, table_id=table.id, zone_id=zone.id,
        table_number=table.number, status="open", source=source, total=Decimal("480"), item_count=Decimal("6"),
        guests=4, opened_at=opened, opened_machine_id=(machine or w.tills[0]).id,
        waiter_pos_user_id="w-1", waiter_pos_user_name="דנה",
    )
    w.db.add(o)
    w.db.flush()
    return o


def test_a_table_open_too_long_once_per_opening_closed_when_paid(w):
    now = local(DAY, 20, 0)
    zone, table = _table(w)
    order = _order(w, table, zone, opened=now - timedelta(minutes=200))
    rule(w, "table_open_long", openMinutes=240)
    assert SV.scan_tables(w.db, now=now) == 0                       # the company's 240 minutes
    rule(w, "table_open_long", level="machine", target=w.tills[0], openMinutes=180)
    assert SV.scan_tables(w.db, now=now) == 1                       # the till's own 180
    assert SV.scan_tables(w.db, now=now + timedelta(minutes=5)) == 0
    (row,) = rows(w, "table_open_long")
    assert row.machine_id == w.tills[0].id and row.amount == Decimal("480.00") and row.pos_user_name == "דנה"
    assert row.threshold == Decimal("180.00") and row.value == Decimal("200.00")
    assert "שולחן 12 (גן) פתוח 3:20 שע׳" in row.details["summary"] and "₪480" in row.details["summary"]
    order.status, order.closed_at, order.paid_total = "paid", now + timedelta(minutes=9), Decimal("480")
    w.db.flush()
    assert SV.scan_tables(w.db, now=now + timedelta(minutes=10)) == 1
    assert row.status == "reviewed" and "השולחן שולם" in row.review_note and row.details["paidTotal"] == 480.0
    # A new opening of the same table is a new case.
    _order(w, table, zone, opened=now - timedelta(minutes=181))
    assert SV.scan_tables(w.db, now=now + timedelta(minutes=11)) == 1


def test_a_mirrored_table_is_judged_only_while_its_till_is_heard(w):
    now = local(DAY, 20, 0)
    zone, table = _table(w)
    _order(w, table, zone, opened=now - timedelta(hours=4), source="local")
    rule(w, "table_open_long")
    w.tills[0].last_heartbeat_at = now - timedelta(hours=1)
    w.db.flush()
    assert SV.scan_tables(w.db, now=now) == 0
    w.tills[0].last_heartbeat_at = now - timedelta(minutes=1)
    w.db.flush()
    assert SV.scan_tables(w.db, now=now) == 1


# ═════════════════════════════════════════════════════════════════════════════
# "הזמנה במטבח לא מוכנה בזמן"
# ═════════════════════════════════════════════════════════════════════════════


def _ticket(w, *, released, workflow="ORDER_PROCESS", dispatch_id=None, order=None, fallback=False, round_no=1,
            names=("המבורגר", "צ'יפס")):
    if order is None:
        order = KitchenOrder(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.tills[0].id, source="table",
            source_ref=uuid.uuid4().hex, table_ref="7", display_ref="45", status="open", workflow_mode=workflow,
            waiter_name="דנה", first_released_at=released,
        )
        w.db.add(order)
        w.db.flush()
    dispatch = KitchenDispatch(id=dispatch_id or uuid.uuid4().hex, tenant_id=w.tenant.id, shop_id=w.shop.id,
                               order_id=order.id, round_no=round_no, fallback_printed=fallback)
    w.db.add(dispatch)
    w.db.flush()
    tasks = []
    for i, name in enumerate(names):
        t = KitchenTask(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, order_id=order.id, dispatch_id=dispatch.id,
            round_no=round_no, station_key="grill", station_name="גריל", line_key=f"l{i}", name=name,
            ordered_qty=Decimal("1"), cancelled_qty=Decimal("0"), prepared_qty=Decimal("0"),
            required=workflow == "ORDER_PROCESS", target_kind="prep" if workflow == "ORDER_PROCESS" else "view",
            release_state="released", prep_state="queued", fallback_printed=fallback,
            created_at=released, released_at=released,
        )
        w.db.add(t)
        tasks.append(t)
    w.db.flush()
    return order, dispatch, tasks


def test_a_late_kds_ticket_once_and_closed_when_ready(w):
    now = local(DAY, 20, 0)
    order, dispatch, tasks = _ticket(w, released=now - timedelta(minutes=25))
    _ticket(w, released=now - timedelta(minutes=40), workflow="DIRECT_SALE")       # view only: no readiness
    _ticket(w, released=now - timedelta(minutes=40), fallback=True)                # printed off the screen
    rule(w, "kds_ticket_late")
    assert SV.scan_kds(w.db, now=now) == 1
    assert SV.scan_kds(w.db, now=now + timedelta(minutes=1)) == 0
    (row,) = rows(w, "kds_ticket_late")
    assert row.details["dispatchId"] == dispatch.id and row.threshold == Decimal("20.00")
    assert "הזמנה 45 (שולחן 7) לא מוכנה 25 דק׳" in row.details["summary"] and "גריל" in row.details["summary"]
    # The next round of the same table is a ticket of its own.
    _ticket(w, released=now - timedelta(minutes=21), order=order, round_no=2, names=("קינוח",))
    assert SV.scan_kds(w.db, now=now + timedelta(minutes=2)) == 1
    tasks[0].prep_state = "ready"
    w.db.flush()
    assert SV.scan_kds(w.db, now=now + timedelta(minutes=3)) == 0                  # one still waits
    tasks[1].prep_state, tasks[1].ready_at = "ready", now + timedelta(minutes=3)
    w.db.flush()
    assert SV.scan_kds(w.db, now=now + timedelta(minutes=4)) == 1
    assert row.status == "reviewed" and "ההזמנה סומנה כמוכנה" in row.review_note


def test_the_kds_minutes_by_level(w):
    now = local(DAY, 20, 0)
    _ticket(w, released=now - timedelta(minutes=25))
    rule(w, "kds_ticket_late", readyMinutes=20)
    rule(w, "kds_ticket_late", level="shop", target=w.shop, readyMinutes=30)
    assert SV.scan_kds(w.db, now=now) == 0
    assert SV.scan_kds(w.db, now=now + timedelta(minutes=6)) == 1


# ═════════════════════════════════════════════════════════════════════════════
# "סיכום יום"
# ═════════════════════════════════════════════════════════════════════════════


def _trading_day(w):
    t1, t2 = w.tills[0], w.tills[1]
    s1 = w.shift(t1, 1, status=ShiftStatus.OPEN, opened_at=local(DAY, 9), business_date=DAY)
    s2 = w.shift(t2, 2, status=ShiftStatus.OPEN, opened_at=local(DAY, 9), business_date=DAY)
    sale(w, t1, local(DAY, 10), 100, shift=s1)
    sale(w, t2, local(DAY, 12), 200, shift=s2, discount="20")
    sale(w, t1, local(DAY, 13), 50, shift=s1, credit_note=True)
    last_week = DAY - timedelta(days=7)
    sale(w, t1, local(last_week, 11), 200)
    return s1, s2


def _close(w, shift, at, discrepancy=None):
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = at
    shift.discrepancy = Decimal(discrepancy) if discrepancy is not None else None
    w.db.flush()


def test_the_daily_summary_after_the_z_with_the_reports_figures(w, monkeypatch):
    s1, s2 = _trading_day(w)
    rule(w, "daily_summary")
    device(w, w.admin, ["daily_summary"])
    now = local(DAY, 22, 0)
    assert DS.scan(w.db, now=now) == 0                                   # no Z yet
    _close(w, s1, local(DAY, 21, 0), "-15")
    w.db.add(ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, business_date=DAY,
                     shop_sequence_number=7, closed_at=local(DAY, 21, 30)))
    w.db.flush()
    assert DS.scan(w.db, now=now) == 0                                   # till 2 still open
    _close(w, s2, local(DAY, 21, 40))
    assert DS.scan(w.db, now=now) == 1
    assert DS.scan(w.db, now=now + timedelta(minutes=1)) == 0            # once per shop and day
    (entry,) = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "daily_summary").all()
    d = entry.details
    assert entry.source == "daily_summary" and entry.severity == "low" and d["info"] is True
    assert d["net"] == 230.0 and d["sales"] == 2 and d["average"] == 140.0
    assert d["refunds"] == 50.0 and d["refundsCount"] == 1 and d["discounts"] == 20.0
    assert d["lastWeekNet"] == 200.0 and d["changePct"] == 15.0
    assert d["cashDifference"] == -15.0 and d["cashDifferenceShifts"] == 1 and d["zNumber"] == 7
    assert entry.amount == Decimal("230.00") and entry.z_report_id is not None
    assert entry.summary.startswith("₪230 נטו · 2 עסקאות · ממוצע ₪140 · +15% מול שבוע שעבר")
    assert "זיכויים ₪50 (1)" in entry.summary and "הנחות ₪20" in entry.summary and "הפרשי קופה -₪15 (1)" in entry.summary
    (sent,) = pushes(w)
    assert sent.status == "sent" and sent.text.startswith("סיכום יום") and "₪230 נטו" in sent.text
    # Information, not a problem: out of the open count.
    summary = LOGR.log_summary(from_date=DAY - timedelta(days=1), to_date=DAY + timedelta(days=1), company_id=None, shop_id=None, area_id=None,
                               machine_id=None, kinds=None, severities=None, employee=None,
                               current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert summary["total"] == 1 and summary["open"] == 0
    assert C.is_info(entry.kind)
    from app.routers import push_alerts as PR

    monkeypatch.setattr(PR, "_now", lambda: now)
    feed = PR.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, open_only=False,
                          days=2, limit=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert [a["kind"] for a in feed["alerts"]] == ["daily_summary"] and feed["alerts"][0]["info"] is True
    assert feed["open"] == 0


def test_the_daily_summary_at_an_hour_by_level(w):
    _trading_day(w)
    rule(w, "daily_summary")                                             # the company: after the Z
    rule(w, "daily_summary", level="shop", target=w.shop, at=20)         # Center: at 20:00
    assert DS.scan(w.db, now=local(DAY, 19, 59)) == 0
    assert DS.scan(w.db, now=local(DAY, 20, 1)) == 1                     # no Z needed; North sold nothing
    (entry,) = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "daily_summary").all()
    assert entry.shop_id == w.shop.id and entry.details["trigger"] == "hour" and entry.details["net"] == 230.0


# ═════════════════════════════════════════════════════════════════════════════
# "קופה לא מוכרת כשהאחרות מוכרות"
# ═════════════════════════════════════════════════════════════════════════════


def _idle_world(w, now, *, quiet_sold=True):
    t3 = till(w, "Till 3")
    tills = [w.tills[0], w.tills[1], t3]
    for i, t in enumerate(tills, start=1):
        w.shift(t, i, status=ShiftStatus.OPEN, opened_at=now - timedelta(hours=3))
    sale(w, tills[0], now - timedelta(minutes=10), 30)
    sale(w, tills[1], now - timedelta(minutes=5), 30)
    if quiet_sold:
        sale(w, t3, now - timedelta(minutes=50), 30)
    return tills


def test_an_idle_till_while_the_others_sell_once_per_streak(w):
    now = local(DAY, 13, 0)
    t1, t2, t3 = _idle_world(w, now)
    rule(w, "till_idle")
    assert TA.scan_idle(w.db, now=now) == 1
    assert TA.scan_idle(w.db, now=now + timedelta(minutes=1)) == 0
    (row,) = rows(w, "till_idle")
    assert row.machine_id == t3.id and row.details["kind"] == "gap" and row.details["peersSelling"] == 2
    assert "לא מכרה 50 דק׳" in row.details["summary"] and "2 קופות אחרות מוכרות" in row.details["summary"]
    # Into the existing push category "קופה כמעט לא מוכרת".
    device(w, w.admin, ["till_low_sales"])
    to_log(w, row, now)
    assert len(pushes(w)) == 1
    # It sells again: closed. A new quiet streak later is a new case.
    sale(w, t3, now + timedelta(minutes=2), 20)
    assert TA.scan_idle(w.db, now=now + timedelta(minutes=3)) == 1
    assert row.status == "reviewed" and "חזרה למכור" in row.review_note
    for t in (t1, t2):
        sale(w, t, now + timedelta(minutes=40), 30)
    assert TA.scan_idle(w.db, now=now + timedelta(minutes=45)) == 1
    assert len(rows(w, "till_idle")) == 2
    # Its shift closes while still quiet: closed too (nothing to sell any more).
    (second,) = [r for r in rows(w, "till_idle") if r.status == "new"]
    from app.models.shift import Shift

    shift = w.db.query(Shift).filter(Shift.machine_id == t3.id).one()
    shift.status, shift.closed_at = ShiftStatus.CLOSED, now + timedelta(minutes=46)
    w.db.flush()
    assert TA.scan_idle(w.db, now=now + timedelta(minutes=47)) == 1
    assert second.status == "reviewed" and "המשמרת נסגרה" in second.review_note


def test_a_till_that_sold_nothing_at_all_and_the_peers_by_level(w):
    now = local(DAY, 13, 0)
    t1, t2, t3 = _idle_world(w, now, quiet_sold=False)
    rule(w, "till_idle")
    rule(w, "till_idle", level="machine", target=t3, minPeers=3)
    assert TA.scan_idle(w.db, now=now) == 0                              # only two others sell
    w.db.query(ExceptionRuleValue).filter(ExceptionRuleValue.scope_type == "machine").delete()
    w.db.flush()
    assert TA.scan_idle(w.db, now=now) == 1
    (row,) = rows(w, "till_idle")
    assert row.details["kind"] == "no_sales" and "לא מכרה כלל מאז פתיחת המשמרת" in row.details["summary"]


# ═════════════════════════════════════════════════════════════════════════════
# "קופה כמעט לא מוכרת" from the background, thresholds by level
# ═════════════════════════════════════════════════════════════════════════════


def _low_sales_world(w, now, *, quiet_sales=0):
    for n in (3, 4):
        till(w, f"Till {n}")
    quiet = w.tills[3]
    for i, t in enumerate(w.tills[:4], start=1):
        w.shift(t, i, status=ShiftStatus.OPEN, opened_at=now - timedelta(hours=4))
        count = quiet_sales if t is quiet else 24
        for k in range(count):
            sale(w, t, now - timedelta(hours=4) + timedelta(minutes=5 + k * 9), 50)
    w.db.commit()
    return quiet


def _low_entries(w):
    return w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == "till_low_sales").all()


def test_till_low_sales_runs_in_the_background_every_ten_minutes(w):
    now = local(DAY, 14, 0)
    quiet = _low_sales_world(w, now)
    assert TA.scan_low_sales(w.db, now=now) == 1
    (entry,) = _low_entries(w)
    assert entry.machine_id == quiet.id and entry.source == "insight"
    assert TA.scan_low_sales(w.db, now=now + timedelta(minutes=3)) == 0   # not due yet: did not run
    assert TA.scan_low_sales(w.db, now=now + timedelta(minutes=10)) == 1  # ran again …
    assert len(_low_entries(w)) == 1                                       # … one entry a day


def test_a_live_event_judges_its_own_tills(w):
    """An event's tills (no shift needed) against each other: the idle check and the low-sales pass."""
    from event_live_world import make_event

    now = local(DAY, 20, 0)
    for n in (3, 4):
        till(w, f"Till {n}")
    quiet = w.tills[3]
    event = make_event(w, name="פסטיבל", tills=w.tills[:4], start=now - timedelta(hours=3), end=now + timedelta(hours=2))
    for t in w.tills[:3]:
        for k in range(24):
            sale(w, t, now - timedelta(hours=3) + timedelta(minutes=2 + k * 7), 40)
    # The quiet till was switched on (its shift is its open hours — the insights rule judges only an open till).
    w.shift(quiet, 9, status=ShiftStatus.OPEN, opened_at=now - timedelta(hours=3))
    w.db.commit()
    rule(w, "till_idle")
    assert TA.scan_idle(w.db, now=now) == 1
    (row,) = rows(w, "till_idle")
    assert row.machine_id == quiet.id and row.details["eventId"] == str(event.id) and row.details["kind"] == "no_sales"
    assert "מאז תחילת האירוע" in row.details["summary"] and "פסטיבל" in row.details["summary"]
    assert TA.scan_low_sales(w.db, now=now, force=True) >= 1   # the event's pass (then the shop's, the same entry)
    (entry,) = _low_entries(w)
    assert entry.machine_id == quiet.id and entry.details["eventId"] == str(event.id)
    # The event ends with the till still quiet: closed.
    assert TA.scan_idle(w.db, now=now + timedelta(hours=2, minutes=1)) == 1
    assert row.status == "reviewed" and "האירוע הסתיים" in row.review_note


def test_the_worker_runs_the_watches_on_their_own_sessions(w, monkeypatch):
    calls = []
    for mod, name in ((SW, "scan_not_opened"), (SW, "scan_sales_pace"), (SV, "scan_tables"), (SV, "scan_kds"),
                      (TA, "scan_idle"), (DS, "scan"), (TA, "scan_low_sales")):
        monkeypatch.setattr(mod, name, lambda db, _n=name, **kw: calls.append(_n) or 0)
    from app.services.exception_alerts import till_watch, push

    monkeypatch.setattr(till_watch, "scan", lambda db, **kw: 0)
    monkeypatch.setattr(push, "retry_stale", lambda db, **kw: 0)

    class _S:
        def __init__(self):
            self.info = {}

        def commit(self):
            pass

        def rollback(self):
            pass

        def close(self):
            pass

    worker.run_watches(lambda: _S())
    assert calls == ["scan_not_opened", "scan_sales_pace", "scan_tables", "scan_kds", "scan_idle", "scan", "scan_low_sales"]


def test_anomaly_thresholds_by_level_and_who_sets_them(w, monkeypatch):
    from app.services.insights import service as S

    now = local(DAY, 14, 0)
    monkeypatch.setattr(S, "_now", lambda: now + timedelta(minutes=2))
    quiet = _low_sales_world(w, now, quiet_sales=4)  # 4 sales against 24: 17%
    shop_manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="m@x",
                        username="manager", shop_id=w.shop.id)
    company_manager = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.tenant.id, email="cm@x",
                           username="cm", company_id=w.company.id)
    w.db.add_all([shop_manager, company_manager])
    w.db.commit()
    ctx = dict(active_tenant_id=w.tenant.id, db=w.db)
    # The company's managers set the company's level, not the organization's.
    with pytest.raises(HTTPException) as refused:
        IR.put_anomaly_settings(thresholds={"lowSalesPct": 10}, level="tenant", target_id=None,
                                current_user=company_manager, **ctx)
    assert refused.value.status_code == 403
    saved = IR.put_anomaly_settings(thresholds={"lowSalesPct": 10}, level="company", target_id=w.company.id,
                                    current_user=company_manager, **ctx)
    assert saved["level"] == "company" and saved["stored"] == {"lowSalesPct": 10} and saved["canEdit"] is True
    assert TA.scan_low_sales(w.db, now=now, force=True) == 0              # 17% is above the company's 10%
    # The shop's own manager sets the shop's level, over the company's.
    with pytest.raises(HTTPException):
        IR.put_anomaly_settings(thresholds={"lowSalesPct": 30}, level="shop", target_id=w.other_shop.id,
                                current_user=shop_manager, **ctx)
    shop_level = IR.put_anomaly_settings(thresholds={"lowSalesPct": 30}, level="shop", target_id=w.shop.id,
                                         current_user=shop_manager, **ctx)
    assert shop_level["thresholds"]["lowSalesPct"] == 30 and shop_level["inherited"]["lowSalesPct"] == 10
    assert shop_level["inheritedSources"]["lowSalesPct"] == "company" and shop_level["inheritedSources"]["minDocs"] is None
    assert TA.scan_low_sales(w.db, now=now + timedelta(minutes=1), force=True) == 1
    (entry,) = _low_entries(w)
    assert entry.machine_id == quiet.id
    # The organization's level is still the super admin's, and the default call reads it.
    org = IR.get_anomaly_settings(level=None, target_id=None, current_user=w.admin, **ctx)
    assert org["level"] == "tenant" and org["stored"] == {} and org["canEdit"] is True
    # The cockpit reads the shop's thresholds too (a shop scope), and a company-wide scope judges
    # each shop's tills by its own shop's.
    out = IR.get_till_anomalies(window="today", p=IR.InsightParams(shop_id=w.shop.id, days=7),
                                current_user=w.admin, **ctx)
    assert out["thresholds"]["lowSalesPct"] == 30
    wide = IR.get_till_anomalies(window="today", p=IR.InsightParams(company_id=w.company.id, days=7),
                                 current_user=w.admin, **ctx)
    assert any(c["type"] == "till_low_sales" for c in wide["cards"]) and wide["thresholds"]["lowSalesPct"] == 10


# ── The data migration (release 14.10.2026) ──────────────────────────────────


def test_the_migration_turns_the_detector_types_on_for_who_had_every_type(w):
    """
    396f22daf19c: a push rule that holds each of the six types the phone alerts started with
    ("בחרו 'הכל'", as 3c9e5a7b1d24 / 8d4f2a6c1e93) gets `shop_open`, `sales_pace`, `daily_summary`;
    one that left any out keeps its choice; `payment_reversals` stays opt-in.
    """
    import importlib.util
    import pathlib

    from alembic.config import Config
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    from app.models.exception_alerts import ExceptionAlertRule

    def owner(name):
        u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email=f"{name}@x",
                 username=name, shop_id=w.shop.id)
        w.db.add(u)
        w.db.flush()
        return u

    original = ["till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached"]
    rules = {
        "everything": [*original, *P.PUSH_MORE_CATEGORY_KEYS],
        "picked": ["large_void", "till_offline"],
        "partly": [*original, "sales_pace"],
    }
    rows = {}
    for name, categories in rules.items():
        rows[name] = ExceptionAlertRule(id=uuid.uuid4(), tenant_id=w.tenant.id, channel="push",
                                        owner_user_id=owner(name).id, name="p", categories=list(categories),
                                        kinds=[], recipients=[])
    w.db.add_all(rows.values())
    w.db.commit()
    root = pathlib.Path(__file__).absolute().parents[1]
    path = next(root.glob("alembic/versions/396f22daf19c_*.py"))
    spec = importlib.util.spec_from_file_location("push_detector_categories_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with Operations.context(MigrationContext.configure(w.db.connection())):
        module.upgrade()
        module.upgrade()  # idempotent
    w.db.expire_all()
    got = {name: w.db.get(ExceptionAlertRule, row.id).categories for name, row in rows.items()}
    assert got["everything"] == [*original, *P.PUSH_MORE_CATEGORY_KEYS, *P.DETECTOR_CATEGORY_KEYS]
    assert got["picked"] == ["large_void", "till_offline"]
    assert got["partly"] == [*original, "sales_pace", "shop_open", "daily_summary"]
    assert "payment_reversals" not in got["everything"]
    assert set(P.DETECTOR_CATEGORY_KEYS) <= set(P.CATEGORY_KEYS)
    assert set(P.DETECTOR_CATEGORY_KEYS) == set(module.NEW)
    # On the release's single head, right after its merge revision.
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert "396f22daf19c" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("396f22daf19c").down_revision == "9f55dd368692"
