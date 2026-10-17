"""
"דוח X סניפי" — the shop-wide interim X (P:/specs/shop-x-report.md; app/services/shop_x.py,
app/routers/till_shop_x.py).

* The figures, against sample documents of three tills: two in the shop Z, one in `zMode = till`
  whose own Z already took its earlier shift (its period starts after it). Closed and open shifts;
  the open one's cash from its documents now, its Cash In from the movements uploaded.
* Nothing is written: no Z, no number, no shift claimed.
* The refresh: `sync_now` to the online tills; one answers, one does not — that one is marked
  ("לא עודכנה מאז …, N מסמכים ממתינים"), and the report is built anyway.
* `shopXTills` all / selected / master / off; the permission (SHOP_X_REPORT: a manager alone,
  a cashier needs a grant); the endpoints; the print document; the journal line.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.models.audit_exception import TillEvent
from app.models.cash_drawer import CashMovement
from app.models.device_command import DeviceCommand
from app.models.pos_user import PosUser, PosUserRole
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.transaction_item import TransactionItem
from app.models.z_report import ZReport
from app.routers import till_shop_x as R
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import device_commands as DC
from app.services import shop_x as SX
from app.services import till_menu as TM
from app.services import till_parameters as TP
from app.services import till_permissions as TPerm
from app.services.permissions import Scope
from app.services.shifts import apply_shift_close
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    # The heartbeats are "now" for each test, not once at import: the full suite reaches these tests
    # long after collection, past the 5-minute online window, and the tills would read as offline.
    world.real_now = datetime.now(timezone.utc)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(DC, "wake", lambda machines: None)
    TP.ensure_builtin_parameters(world.db)
    db = world.db
    world.t1, world.t2 = world.tills
    from app.models.pos_machine import POSMachine

    world.t3 = POSMachine(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
        name="Bar", machine_code="M-9", pos_number="3", is_active=True,
        pairing_status=world.t1.pairing_status, last_heartbeat_at=world.real_now, z_mode="till",
    )
    db.add(world.t3)
    for m in (world.t1, world.t2):
        m.last_heartbeat_at = world.real_now
    world.manager = PosUser(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, username="mgr",
        first_name="רותי", last_name="מנהלת", pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True,
    )
    world.cashier = PosUser(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, username="dana",
        first_name="דנה", pin_hash="x", role=PosUserRole.CASHIER, is_active=True,
    )
    db.add_all([world.manager, world.cashier])
    db.flush()
    return world


def closed_shift(w, till, seq, *docs):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=8))
    made = [w.doc(till, shift, total, **kw) for total, kw in docs]
    body = ShiftCloseIn.model_validate({
        "closedAt": (NOW - timedelta(hours=5)).isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(d.id) for d in made],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def set_param(w, key, scope_type, scope_id, value):
    param = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=param.id, scope_type=scope_type, scope_id=scope_id, value=value))
    w.db.flush()


def sample(w):
    """
    Till 1: a closed shift (cash 100, card 50) and an open one (cash 20 less a 10% discount on 20…,
    a card sale 40 with a 5 tip, a ₪30 Cash In, an OTH line, a line void). Till 2: an open shift
    with a credit note of 15 cash. Till 3 (Z לכל קופה): a shift its own Z took (not in the X) and
    an open one with cash 70.
    """
    db = w.db
    closed_shift(w, w.t1, 1, ("100.00", {}), ("50.00", {"method": "card"}))
    w.open1 = w.shift(w.t1, 2, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=4), opening_cash="200.00")
    sale = w.doc(w.t1, w.open1, "20.00", discount="2.00")
    w.doc(w.t1, w.open1, "40.00", method="card", tip="5.00", tip_method="card")
    db.add(TransactionItem(
        id=uuid.uuid4(), transaction_id=sale.id, product_name="קפה", quantity=Decimal("2"),
        unit_price=Decimal("6.50"), total_price=Decimal("0"), oth_reason="לקוח קבוע",
    ))
    db.add(CashMovement(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.t1.id, movement_type="cash_in",
        amount=Decimal("30.00"), shift_id=w.open1.id, occurred_at=NOW - timedelta(hours=1), received_at=NOW,
    ))
    db.add(TillEvent(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.t1.id, shop_id=w.shop.id, event_type="line_void",
        occurred_at=NOW - timedelta(hours=1), amount=Decimal("12.00"), received_at=NOW,
    ))
    db.add(TillEvent(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.t1.id, shop_id=w.shop.id, event_type="table_cancelled",
        occurred_at=NOW - timedelta(minutes=30), amount=Decimal("80.00"), received_at=NOW,
    ))
    # Before the period: not counted.
    db.add(TillEvent(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.t1.id, shop_id=w.shop.id, event_type="line_void",
        occurred_at=NOW - timedelta(days=2), amount=Decimal("99.00"), received_at=NOW,
    ))
    w.open2 = w.shift(w.t2, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=3), opening_cash="50.00")
    w.doc(w.t2, w.open2, "15.00", credit_note=True)
    # Till 3 makes its own Z: its earlier shift is in that Z, so not in the X.
    old = w.shift(w.t3, 1, opened_at=NOW - timedelta(days=1))
    w.doc(w.t3, old, "999.00")
    z = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=w.t3.id, origin="till",
                business_date=TODAY - timedelta(days=1), closed_at=NOW - timedelta(hours=20))
    db.add(z)
    db.flush()
    old.z_report_id = z.id
    w.open3 = w.shift(w.t3, 2, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=2), opening_cash="0.00")
    w.doc(w.t3, w.open3, "70.00")
    db.flush()


def build(w, **kw):
    settings = kw.pop("settings", SX.Settings())
    return SX.build(w.db, w.shop, settings=settings, now=NOW, **kw)


# ── The figures ───────────────────────────────────────────────────────────────


def test_the_figures_against_the_documents_of_three_tills(w):
    sample(w)
    report = build(w)
    s = report["summary"]
    # 100 + 50 + (20 − 2) + 40 + 70 = 278 sales; a credit note of 15.
    assert s["totalSales"] == "278.00"
    assert s["refunds"] == {"count": 1, "amount": "15.00"}
    assert s["netSales"] == "263.00"
    assert s["grossSales"] == "280.00"
    assert s["discounts"] == {"count": 1, "amount": "2.00"}
    assert s["documents"] == 6
    assert s["payments"]["cash"] == "173.00"  # 100 + 18 + 70 − 15
    assert s["payments"]["card"] == "90.00"
    assert s["tips"] == {"card": "5.00", "cash": "0.00", "total": "5.00"}
    assert s["oth"] == {"count": 1, "amount": "13.00"}
    assert s["voids"] == {"count": 1, "amount": "12.00"}
    assert s["tableCancels"] == {"count": 1, "amount": "80.00"}
    # The drawers: till 1 opened its first shift with 100 (the world's float) and handed it on
    # (the open shift's 200 float is 100 put in between the shifts: 200 − (100 + 100)), cash 100
    # + 18, Cash In 30; till 2 50 − 15; till 3 0 + 70.
    d = s["drawer"]
    assert d["opening"] == "150.00"
    assert d["cashIn"] == "30.00"
    assert d["cashSales"] == "173.00"
    assert d["betweenShifts"] == "0.00"
    till1 = next(t for t in report["tills"] if t["posNumber"] == "1")
    assert till1["expectedCash"] == "248.00"  # 200 (handed-on float) + 18 + 30
    assert d["expected"] == str(Decimal("248.00") + Decimal("35.00") + Decimal("70.00"))
    # Per till: Till 3's period is after its own Z — its old 999 is not here.
    till3 = next(t for t in report["tills"] if t["posNumber"] == "3")
    assert till3["zMode"] == "till"
    assert till3["totalSales"] == "70.00"
    assert till3["shiftCount"] == 1
    assert till1["shiftState"] == "open" and till1["shiftCount"] == 2
    assert report["closing"] is False and report["number"] is None
    assert report["headline"] == "דוח X סניפי — דוח ביניים, אינו סוגר יום"


def test_it_writes_nothing_no_z_no_number_no_shift_claimed(w):
    sample(w)
    before = w.db.query(ZReport).count()
    build(w)
    w.db.flush()
    assert w.db.query(ZReport).count() == before
    assert w.open1.z_report_id is None and w.open1.status == ShiftStatus.OPEN


def test_the_x_and_the_z_agree_on_the_closed_part(w):
    """A till whose period is closed shifts only: the X's section is the Z builder's own."""
    closed_shift(w, w.t2, 1, ("33.30", {}), ("10.00", {"method": "card"}))
    report = build(w)
    till2 = next(t for t in report["tills"] if t["posNumber"] == "2")
    assert till2["totalSales"] == "43.30" and till2["totalCash"] == "33.30" and till2["totalCard"] == "10.00"
    assert till2["shiftState"] == "closed"


def test_per_till_and_per_employee_follow_the_parameters(w):
    sample(w)
    off = build(w, settings=SX.Settings(per_till=False, per_employee=True))
    assert off["tills"] == []
    assert isinstance(off["employees"], list) and off["employees"]
    on = build(w)
    assert len(on["tills"]) == 3 and on["employees"] == []


# ── The refresh ───────────────────────────────────────────────────────────────


def test_a_till_that_did_not_answer_is_marked_and_the_report_is_built(w):
    sample(w)
    # Till 2 says it still holds 4 documents, the oldest from 20:10 local (17:10 UTC).
    w.t2.device_info = {"outbox": {"documents": 4, "events": 0, "oldestAt": "2026-09-27T17:10:00+00:00",
                                    "reportedAt": NOW.isoformat()}}
    w.db.flush()
    ticks = iter(range(100))
    slept = []

    def sleep(sec):
        slept.append(sec)
        # Till 3 answers its sync_now; till 2 never does.
        row = w.db.query(DeviceCommand).filter(DeviceCommand.machine_id == w.t3.id).one()
        row.status = "done"
        w.db.flush()

    refresh = SX.refresh_tills(
        w.db, w.shop, [w.t1, w.t2, w.t3], requester=w.t1, by_name="רותי", wait_sec=3, now=w.real_now,
        sleep=sleep, clock=lambda: next(ticks),
    )
    asked = {str(w.t2.id), str(w.t3.id)}
    assert set(refresh.asked) == asked  # the requester sent its own
    assert refresh.answered == [str(w.t3.id)]
    assert slept  # it waited
    cmds = w.db.query(DeviceCommand).filter(DeviceCommand.action == "sync_now").all()
    assert {str(c.machine_id) for c in cmds} == asked
    from zoneinfo import ZoneInfo

    report = build(w, refresh=refresh, requester=w.t1, tzinfo=ZoneInfo("Asia/Jerusalem"))
    warnings = {x["machineId"]: x for x in report["warnings"]}
    assert set(warnings) == {str(w.t2.id)}
    assert warnings[str(w.t2.id)]["text"] == "קופה 2 — לא עודכנה מאז 20:10, 4 מסמכים ממתינים"
    assert report["refresh"]["asked"] == 2 and report["refresh"]["answered"] == 1
    assert report["summary"]["totalSales"] == "278.00"  # built anyway


def test_an_offline_till_gets_no_command(w):
    w.t2.last_heartbeat_at = w.real_now - timedelta(hours=1)
    w.db.flush()
    refresh = SX.refresh_tills(w.db, w.shop, [w.t1, w.t2], requester=None, by_name="x", wait_sec=0, now=w.real_now,
                               sleep=lambda s: None)
    assert refresh.asked == [str(w.t1.id)]


# ── Where it shows ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("mode,expect", [
    ("all", (True, True)),
    ("off", (False, False)),
    ("selected", (False, True)),
    ("master", (True, False)),
])
def test_shop_x_tills_modes(w, mode, expect):
    set_param(w, TP.SHOP_X_TILLS_KEY, "shop", w.shop.id, mode)
    set_param(w, TP.SHOP_X_TILL_IDS_KEY, "shop", w.shop.id, SX.till_ids_value([w.t2.id]))
    set_param(w, "shopZMasterTill", "machine", w.t1.id, True)
    got = tuple(SX.available_on(w.db, m)[0] for m in (w.t1, w.t2))
    assert got == expect


def test_till_ids_are_read_leniently():
    a, b = uuid.uuid4(), uuid.uuid4()
    assert SX.till_ids_of(f" {a}, junk;{b},{a}") == [str(a), str(b)]
    assert SX.till_ids_of(f'["{a}"]') == [str(a)]
    assert SX.till_ids_value([b, a, b]) == f"{b},{a}"


def test_the_parameters_are_registered_with_hebrew_labels_and_defaults(w):
    rows = {p.key: p for p in w.db.query(TillParameter).filter(TillParameter.key.like("shopX%")).all()}
    assert set(rows) == {"shopXTills", "shopXTillIds", "shopXRefreshSec", "shopXPerTill", "shopXPerEmployee"}
    assert rows["shopXTills"].default_value == "all" and rows["shopXTills"].enum_options == ["all", "selected", "master", "off"]
    assert rows["shopXRefreshSec"].default_value == 10
    assert rows["shopXPerTill"].default_value is True and rows["shopXPerEmployee"].default_value is False
    assert all(r.label.startswith("דוח X סניפי") for r in rows.values())
    assert TP.enum_labels("shopXTills")["master"] == "רק בקופה הראשית של ה-Z הסניפי"


# ── The permission ────────────────────────────────────────────────────────────


def test_the_permission_waiter_deny_cashier_approval_supervisor_and_manager_allow():
    assert TPerm.PERMISSIONS_BY_CODE["SHOP_X_REPORT"].label == "דוח X סניפי"
    assert TPerm.SCOPE_PERMISSIONS["report:shop-x"] == "SHOP_X_REPORT"
    got = tuple(TPerm.DEFAULTS[r]["SHOP_X_REPORT"] for r in ("waiter", "cashier", "supervisor", "manager"))
    assert got == ("deny", "approval", "allow", "allow")
    assert TPerm.DEFAULTS["legacy_cashier"]["SHOP_X_REPORT"] == "approval"
    assert TPerm.DEFAULTS["legacy_manager"]["SHOP_X_REPORT"] == "allow"
    assert Scope("report:shop-x") is Scope.SHOP_X_REPORT


def test_the_matrix_fixture_has_it():
    data = json.loads((Path(__file__).parent / "fixtures" / "till_permissions_matrix.json").read_text(encoding="utf-8"))
    assert "SHOP_X_REPORT" in data["codes"]
    assert data["scopes"]["report:shop-x"] == "SHOP_X_REPORT"
    assert data["roles"]["cashier"]["states"]["SHOP_X_REPORT"] == "approval"


def test_the_menu_key_is_last_and_a_report():
    assert TM.KNOWN_KEYS[-1] == "shop_x"
    assert "shop_x" in TM.REPORT_KEYS


# ── The endpoints ─────────────────────────────────────────────────────────────


def get(w, till, operator=None, token=None):
    return R.till_shop_x(str(till.id), machine=till, elevation_token=token,
                         operator_id=str(operator.id) if operator else None, db=w.db)


def test_the_till_endpoint_answers_a_manager_with_the_report_and_its_print_document(w):
    sample(w)
    out = get(w, w.t2, w.manager)
    assert out["available"] is True
    assert out["report"]["summary"]["totalSales"] == "278.00"
    assert "_sections" not in out["report"]
    doc = out["printDocument"]
    assert set(doc) == {"title", "number", "businessName", "subtitle", "sections", "footer"}
    assert doc["title"] == "דוח X סניפי" and doc["number"] is None
    assert doc["subtitle"][0] == "דוח X סניפי — דוח ביניים, אינו סוגר יום"
    titles = [s["title"] for s in doc["sections"]]
    for title in ("מכירות", "אמצעי תשלום", "תשר", "קופה", "ביטולים והנחות", "שולחנות פתוחים"):
        assert title in titles
    assert any(t.startswith("קופה 3") for t in titles)  # per till, on by default
    for s in doc["sections"]:
        for r in s["rows"]:
            assert set(r) == {"label", "value", "emphasis"} and isinstance(r["value"], str)
    assert any(line.startswith("הופק ע״י רותי מנהלת בקופה 2,") for line in doc["footer"])
    assert doc["footer"][-1] == "סוף דוח X סניפי"
    # Journalled — a till event of its own, not an exception.
    ev = w.db.query(TillEvent).filter(TillEvent.event_type == SX.JOURNAL_EVENT).one()
    assert ev.machine_id == w.t2.id and ev.pos_user_id == str(w.manager.id)
    from app.models.audit_exception import AuditException

    assert w.db.query(AuditException).count() == 0


def test_a_cashier_alone_is_refused_and_asks_for_a_manager(w):
    with pytest.raises(HTTPException) as e:
        get(w, w.t1, w.cashier)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        get(w, w.t1, None)
    assert e.value.status_code == 401


def test_a_cashier_with_a_managers_grant_is_answered(w, monkeypatch):
    class _Grant:
        pos_user_id = w.manager.id
        user_id = None

    seen = {}

    def checked(db, machine, token, scope):
        seen["scope"] = scope
        return _Grant()

    monkeypatch.setattr(R, "_checked_grant", checked)
    out = get(w, w.t1, w.cashier, token="grant")
    assert seen["scope"] == Scope.SHOP_X_REPORT
    assert out["available"] is True


def test_not_available_on_this_till(w):
    set_param(w, TP.SHOP_X_TILLS_KEY, "shop", w.shop.id, "off")
    with pytest.raises(HTTPException) as e:
        get(w, w.t1, w.manager)
    assert e.value.status_code == 403
    assert e.value.detail["code"] == "shop_x_not_available" and e.value.detail["reason"] == "off"


def test_post_refreshes_then_builds(w, monkeypatch):
    sample(w)
    set_param(w, TP.SHOP_X_REFRESH_SEC_KEY, "shop", w.shop.id, 0)
    calls = {}
    real = SX.refresh_tills

    def spy(db, shop, tills, **kw):
        calls.update(kw)
        return real(db, shop, tills, sleep=lambda s: None, **kw)

    monkeypatch.setattr(SX, "refresh_tills", spy)
    out = R.till_shop_x_refresh(
        str(w.t1.id), body={"posUserName": "רותי", "outbox": {"documents": 0, "oldestAt": None}},
        machine=w.t1, elevation_token=None, operator_id=str(w.manager.id), db=w.db,
    )
    assert calls["requester"] is w.t1 and calls["wait_sec"] == 0
    assert out["report"]["refresh"]["requested"] is True
    assert out["report"]["refresh"]["asked"] == 2
    assert w.t1.device_info["outbox"]["documents"] == 0  # the till's own report stored


def test_the_dashboard_endpoint(w):
    sample(w)
    set_param(w, TP.SHOP_X_PER_TILL_KEY, "shop", w.shop.id, False)
    out = R.dashboard_shop_x(w.shop.id, refresh=False, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["report"]["summary"]["totalSales"] == "278.00"
    assert out["report"]["tills"] == []
    assert out["report"]["settings"]["perTill"] is False
    assert not any(s["title"].startswith("קופה 3") for s in out["printDocument"]["sections"])
    with pytest.raises(HTTPException) as e:
        R.dashboard_shop_x(w.other_shop.id, refresh=False, current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db)
    assert e.value.status_code == 404
