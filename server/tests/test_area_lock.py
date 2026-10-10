"""
"נעילת הקופה לנקודת המכירה שלה" — the area lock (app/services/area_lock.py, docs/SPEC_AREA_LOCK.md).

What each class pins:

* **The parameter** — built in, boolean, on by default, labelled in Hebrew; resolved company →
  shop → area → till (the most specific wins); no effect on a till without an area; a dashboard
  user on a till path is never locked.
* **Lock on / lock off** for every till-facing read and act that was shop-wide: the 24-hour
  documents list, the kiosks a till controls (and their commands), kiosk alerts (and "בדרך"),
  kiosk orders paid at the till, closed tables / restore / the till's tables report /
  reservations, the till's "הזמנות להכנה", the leaderboard. Off is exactly today's answer.
* **Never a sale, never fiscal** — "paid" on a kiosk order is recorded whatever the lock; a shop
  Z still takes every till of the shop; the Z list stays the shop's.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import itertools
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.kds import KitchenOrder
from app.models.kiosk import KioskOrder
from app.models.kiosk_ops import KioskAlert
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop_area import ShopArea
from app.models.tables import TableOrder
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import kiosk_alerts as KAR
from app.routers import kiosks as KR
from app.routers import reports as RR
from app.routers import tables as TR
from app.schemas.kiosk import KioskCreateIn
from app.schemas.tables import ReservationIn, ReservationStatusIn, TableCreate, ZoneCreate
from app.services import ably_notify
from app.services import area_lock as AL
from app.services import kds as KDS
from app.services import kiosk_control as KC
from app.services import kiosk_ops as KO
from app.services import kiosk_open_orders as KOO
from app.services import reports as REP
from app.services import sales_targets as ST
from app.services import tables as T
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world


# ── World ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    db = world.db
    for name in ("publish_notify", "publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    TP.ensure_builtin_parameters(db)
    world.params = {p.key: p for p in db.query(TillParameter).all()}
    world.bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="בר")
    world.terrace = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="מרפסת")
    db.add_all([world.bar, world.terrace])
    db.flush()
    world.a, world.b = world.tills  # a: the bar, b: the terrace
    world.a.area_id = world.bar.id
    world.b.area_id = world.terrace.id
    world.a2 = _till(world, "Bar 2", world.bar.id)
    world.c = _till(world, "Counter", None)  # no area
    db.commit()
    return world


#: Register numbers are unique per shop; the world's own tills take the low ones.
_POS_NUMBERS = itertools.count(100)


def _till(w, name, area_id):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name=name,
        machine_code=f"X-{uuid.uuid4().hex[:8]}", pos_number=str(next(_POS_NUMBERS)), is_active=True,
        pairing_status=PairingStatus.ASSIGNED, area_id=area_id,
    )
    w.db.add(m)
    w.db.flush()
    return m


def set_lock(w, scope_type, scope_id, value):
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=w.params[AL.AREA_SCOPE_LOCK_KEY].id,
        scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.commit()


def lock_off(w):
    set_lock(w, "shop", w.shop.id, False)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def is_area_locked(exc: HTTPException, kind: str):
    assert exc.status_code == 403 and exc.detail == AL.AREA_LOCKED
    assert isinstance(exc, AL.AreaLocked) and exc.body["kind"] == kind
    assert exc.body["message"] == AL.MESSAGES[kind]


# ── The parameter ─────────────────────────────────────────────────────────────


class TestTheParameter:
    def test_built_in_boolean_on_by_default_with_a_hebrew_label(self, w):
        p = w.params[AL.AREA_SCOPE_LOCK_KEY]
        assert p.value_type == "boolean" and p.default_value is True and p.is_active
        assert p.label == "נעילת הקופה לנקודת המכירה שלה"
        assert "נקודת מכירה" in p.description and "Z" in p.description

    def test_the_till_receives_it_with_its_parameters(self, w):
        assert TP.till_parameters_for_machine(w.db, w.a).parameters[AL.AREA_SCOPE_LOCK_KEY] is True

    def test_a_till_in_an_area_is_locked_by_default(self, w):
        scope = AL.scope_for(w.db, w.a)
        assert scope.locked and scope.area_id == w.bar.id and scope.area_name == "בר"
        assert scope.as_json() == {"areaId": str(w.bar.id), "areaName": "בר"}

    def test_a_till_without_an_area_is_never_locked(self, w):
        assert not AL.scope_for(w.db, w.c).locked
        assert AL.scope_for(w.db, w.c).as_json() is None

    def test_off_at_the_shop_unlocks_every_till(self, w):
        lock_off(w)
        assert not AL.is_locked(w.db, w.a) and not AL.is_locked(w.db, w.b)

    def test_the_most_specific_level_wins(self, w):
        set_lock(w, "company", w.company.id, False)
        set_lock(w, "area", w.bar.id, True)
        set_lock(w, "machine", w.a2.id, False)
        assert AL.is_locked(w.db, w.a)  # area on beats the company's off
        assert not AL.is_locked(w.db, w.a2)  # the till's own off beats its area's on
        assert not AL.is_locked(w.db, w.b)  # the terrace inherits the company's off

    def test_an_inactive_definition_falls_back_to_the_default(self, w):
        w.params[AL.AREA_SCOPE_LOCK_KEY].is_active = False
        w.db.commit()
        assert AL.is_locked(w.db, w.a)

    def test_a_dashboard_user_on_a_till_path_is_never_locked(self, w):
        AL.mark_dashboard_caller(w.a)
        assert not AL.is_locked(w.db, w.a)

    def test_the_sync_path_marks_a_dashboard_caller(self, w, monkeypatch):
        from app.middleware import auth as A

        monkeypatch.setattr(A, "decode_jwt_payload", lambda token: {"type": "user"})
        monkeypatch.setattr(A, "_resolve_user_from_bearer_token", lambda token, db: w.admin)
        monkeypatch.setattr(A.dashboard_access, "enforce_route", lambda *a, **k: None)
        monkeypatch.setattr(A, "_check_machine_access", lambda *a, **k: None)
        monkeypatch.setattr(A, "_check_sync_user_tenancy", lambda *a, **k: None)
        machine = A.get_pos_machine_for_sync_path(
            str(w.a.id), request=SimpleNamespace(), credentials=SimpleNamespace(credentials="t"), db=w.db,
        )
        assert machine.id == w.a.id and AL.is_dashboard_caller(machine) and not AL.is_locked(w.db, machine)

    def test_the_machine_token_path_does_not_mark(self, w, monkeypatch):
        from app.middleware import auth as A

        monkeypatch.setattr(A, "decode_jwt_payload", lambda token: {"type": "machine", "sub": str(w.b.id)})
        monkeypatch.setattr(A, "_require_current_token_version", lambda *a, **k: None)
        machine = A.get_pos_machine_for_sync_path(
            str(w.b.id), request=SimpleNamespace(), credentials=SimpleNamespace(credentials="t"), db=w.db,
        )
        assert not AL.is_dashboard_caller(machine) and AL.is_locked(w.db, machine)

    def test_the_refusal_body(self):
        exc = AL.refusal("document")
        assert exc.status_code == 403 and exc.detail == "area_locked"
        assert exc.body == {"detail": "area_locked", "message": "המסמך שייך לנקודת מכירה אחרת", "kind": "document"}

    def test_the_handler_answers_the_body(self):
        import asyncio

        resp = asyncio.run(AL.area_locked_handler(None, AL.refusal("table")))
        assert resp.status_code == 403
        assert json.loads(resp.body) == {"detail": "area_locked", "message": "השולחן שייך לנקודת מכירה אחרת", "kind": "table"}


# ── 24 hours of documents ─────────────────────────────────────────────────────


def _docs(w):
    now = datetime.now(timezone.utc) - timedelta(minutes=5)
    out = {}
    for till, n in ((w.a, "A-1"), (w.a2, "A2-1"), (w.b, "B-1"), (w.c, "C-1")):
        tx = w.doc(till, None, "10.00", number=n)
        tx.created_at = now
        out[n] = tx
    w.db.commit()
    return out


def _numbers(rows):
    return sorted(r.transaction_number for r in rows)


class TestShopTransactions:
    def test_locked_lists_its_areas_tills_only(self, w):
        _docs(w)
        rows, _ = REP.load_shop_transactions_for_machine(w.db, w.a, hours=24)
        assert _numbers(rows) == ["A-1", "A2-1"]
        rows, _ = REP.load_shop_transactions_for_machine(w.db, w.b, hours=24)
        assert _numbers(rows) == ["B-1"]

    def test_the_answer_names_the_area(self, w):
        _docs(w)
        out = RR.get_shop_transactions(hours=24, q=None, machine=w.a, db=w.db)
        assert out.area == {"areaId": str(w.bar.id), "areaName": "בר"}
        assert json.loads(out.model_dump_json(by_alias=True))["area"]["areaName"] == "בר"

    def test_the_search_stays_in_the_area(self, w):
        _docs(w)
        rows, _ = REP.load_shop_transactions_for_machine(w.db, w.a, hours=24, q="B-1")
        assert rows == []

    def test_off_is_the_whole_shop(self, w):
        _docs(w)
        lock_off(w)
        rows, _ = REP.load_shop_transactions_for_machine(w.db, w.a, hours=24)
        assert _numbers(rows) == ["A-1", "A2-1", "B-1", "C-1"]
        assert RR.get_shop_transactions(hours=24, q=None, machine=w.a, db=w.db).area is None

    def test_a_till_without_an_area_sees_the_whole_shop(self, w):
        _docs(w)
        rows, _ = REP.load_shop_transactions_for_machine(w.db, w.c, hours=24)
        assert _numbers(rows) == ["A-1", "A2-1", "B-1", "C-1"]

    def test_a_dashboard_user_sees_the_whole_shop(self, w):
        _docs(w)
        AL.mark_dashboard_caller(w.a)
        rows, _ = REP.load_shop_transactions_for_machine(w.db, w.a, hours=24)
        assert len(rows) == 4


# ── Kiosks: control, alerts, orders paid at the till ──────────────────────────


@pytest.fixture
def k(w):
    """Three kiosks: the bar's, the terrace's, the shop's (no area); every till controls each."""
    kiosks = {}
    for name, area in (("bar", w.bar.id), ("terrace", w.terrace.id), ("shop", None)):
        m = _till(w, f"kiosk {name}", area)
        KR.create_kiosk(body=KioskCreateIn(machineId=m.id, name=f"קיוסק {name}"), current_user=w.admin,
                        active_tenant_id=w.tenant.id, db=w.db)
        device = KC.get_device(w.db, m.id)
        device.controller_machine_ids = [str(t.id) for t in (w.a, w.b, w.c)]
        kiosks[name] = m
    w.db.commit()
    w.k = kiosks
    return w


def _controls(w, till):
    return sorted(d.name for d in KC.controlled_devices(w.db, till))


class TestKioskControl:
    def test_locked_controls_its_areas_and_the_shops_kiosks(self, k):
        assert _controls(k, k.a) == ["קיוסק bar", "קיוסק shop"]
        assert _controls(k, k.b) == ["קיוסק shop", "קיוסק terrace"]
        assert _controls(k, k.c) == ["קיוסק bar", "קיוסק shop", "קיוסק terrace"]

    def test_the_sync_carries_the_narrowed_list(self, k):
        out = KC.kiosk_sync(k.db, k.a, None)
        assert sorted(c["name"] for c in out["controls"]) == ["קיוסק bar", "קיוסק shop"]

    def test_a_command_to_another_areas_kiosk_is_refused(self, k):
        is_area_locked(refused(KC.controller_target, k.db, k.a, k.k["terrace"].id), "kiosk")

    def test_its_own_and_the_shops_kiosk_answer(self, k):
        assert KC.controller_target(k.db, k.a, k.k["bar"].id)[0].id == k.k["bar"].id
        assert KC.controller_target(k.db, k.a, k.k["shop"].id)[0].id == k.k["shop"].id

    def test_off_is_the_controller_list_as_today(self, k):
        lock_off(k)
        assert _controls(k, k.a) == ["קיוסק bar", "קיוסק shop", "קיוסק terrace"]
        assert KC.controller_target(k.db, k.a, k.k["terrace"].id)[0].id == k.k["terrace"].id

    def test_not_a_controller_is_still_403_not_kiosk_controller(self, k):
        KC.get_device(k.db, k.k["bar"].id).controller_machine_ids = [str(k.b.id)]
        k.db.commit()
        exc = refused(KC.controller_target, k.db, k.a, k.k["bar"].id)
        assert exc.status_code == 403 and exc.detail != AL.AREA_LOCKED


def _alert(w, kiosk):
    row = KioskAlert(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, kiosk_machine_id=kiosk.id, kind="help",
        key="help", reason="help", text="עזרה", raised_at=datetime.now(timezone.utc),
        last_reported_at=datetime.now(timezone.utc),
    )
    w.db.add(row)
    w.db.commit()
    return row


class TestKioskAlerts:
    def _fake(self, k, monkeypatch):
        monkeypatch.setattr(KO, "alerts_for_till", lambda db, till: [
            {"id": name, "kioskMachineId": str(m.id)} for name, m in sorted(k.k.items())
        ] + [{"id": "battery:c", "kioskMachineId": str(k.c.id)}, {"id": "battery:b", "kioskMachineId": str(k.b.id)}])

    def test_locked_keeps_its_areas_and_the_shops_devices(self, k, monkeypatch):
        self._fake(k, monkeypatch)
        out = KAR.till_kiosk_alerts(str(k.a.id), machine=k.a, db=k.db)
        assert [a["id"] for a in out["alerts"]] == ["bar", "shop", "battery:c"]

    def test_off_keeps_every_routed_alert(self, k, monkeypatch):
        self._fake(k, monkeypatch)
        lock_off(k)
        out = KAR.till_kiosk_alerts(str(k.a.id), machine=k.a, db=k.db)
        assert len(out["alerts"]) == 5

    def test_on_my_way_on_another_areas_kiosk_is_refused(self, k):
        row = _alert(k, k.k["terrace"])
        is_area_locked(refused(KO.acknowledge, k.db, k.a, str(row.id)), "kiosk")
        assert k.db.get(KioskAlert, row.id).acknowledged_at is None

    def test_on_my_way_off_goes_on_to_the_routing(self, k, monkeypatch):
        row = _alert(k, k.k["terrace"])
        lock_off(k)
        monkeypatch.setattr(KO, "targets", lambda db, kiosk, cfg, kind: [k.a])
        out = KO.acknowledge(k.db, k.a, str(row.id), pos_user_name="דנה")
        assert out["acknowledgedAt"] is not None


T0 = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)


def _kiosk_order(w, kiosk, local_id):
    row = KioskOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=kiosk.id, local_id=local_id,
        pickup_number=17, pickup_label="A-17", business_date=T0.date(), fulfillment_mode="BON",
        bon_status="pending", receipt_status="pending", status="open", pay_at_till=True, open_state="open", total_agorot=1000, tip_agorot=0, item_count=1, lines=[],
        created_at=T0, expires_at=T0 + timedelta(hours=1),
    )
    w.db.add(row)
    w.db.commit()
    return row


class TestKioskOrdersAtTheTill:
    @pytest.fixture
    def o(self, k, monkeypatch):
        monkeypatch.setattr(KOO, "expire_due", lambda *a, **k: None)
        k.orders = {name: _kiosk_order(k, m, f"o-{name}") for name, m in k.k.items()}
        return k

    def _listed(self, w, till):
        return sorted(r["localId"] for r in KOO.list_for_till(w.db, till, now=T0))

    def test_locked_lists_its_areas_and_the_shops_kiosks_orders(self, o):
        assert self._listed(o, o.a) == ["o-bar", "o-shop"]
        assert self._listed(o, o.c) == ["o-bar", "o-shop", "o-terrace"]

    def test_taking_another_areas_order_is_refused(self, o):
        is_area_locked(refused(KOO.lock, o.db, o.a, "o-terrace", pos_user_name="דנה", now=T0), "order")
        is_area_locked(refused(KOO.cancel, o.db, o.a, "o-terrace", reason="x", pos_user_name="דנה", now=T0), "order")

    def test_its_own_areas_order_is_taken(self, o):
        out = KOO.lock(o.db, o.a, "o-bar", pos_user_name="דנה", now=T0)
        assert out["lockedByMe"] is True

    def test_paid_is_recorded_whatever_the_lock(self, o):
        out = KOO.mark_paid(o.db, o.a, "o-terrace", transaction_id=str(uuid.uuid4()), transaction_number="7", now=T0)
        assert out["state"] == "paid"

    def test_an_order_it_already_holds_stays_its_own(self, o):
        lock_off(o)
        KOO.lock(o.db, o.a, "o-terrace", pos_user_name="דנה", now=T0)
        o.db.query(TillParameterValue).delete()
        o.db.commit()
        assert AL.is_locked(o.db, o.a)
        assert KOO.release(o.db, o.a, "o-terrace", now=T0)["state"] == "open"

    def test_off_lists_and_takes_every_order(self, o):
        lock_off(o)
        assert self._listed(o, o.a) == ["o-bar", "o-shop", "o-terrace"]
        assert KOO.lock(o.db, o.a, "o-terrace", pos_user_name="דנה", now=T0)["lockedByMe"] is True


# ── Tables ────────────────────────────────────────────────────────────────────


@pytest.fixture
def t(w):
    db = w.db
    w.hall = T.create_zone(db, w.shop, ZoneCreate(shopId=w.shop.id, name="אולם", layout="grid"))
    w.bar_zone = T.create_zone(db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=w.bar.id, name="בר", layout="grid"))
    w.deck = T.create_zone(db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=w.terrace.id, name="מרפסת", layout="grid"))
    w.t_hall = T.create_table(db, w.hall, TableCreate(zoneId=w.hall.id, number=1))
    w.t_bar = T.create_table(db, w.bar_zone, TableCreate(zoneId=w.bar_zone.id, number=2))
    w.t_deck = T.create_table(db, w.deck, TableCreate(zoneId=w.deck.id, number=3))
    now = datetime.now(timezone.utc)
    w.closed = {}
    for table, zone in ((w.t_hall, w.hall), (w.t_bar, w.bar_zone), (w.t_deck, w.deck)):
        o = TableOrder(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=zone.id,
            table_number=table.number, status="paid", source="synced", version=1, total=50, paid_total=50,
            opened_at=now - timedelta(hours=1), closed_at=now - timedelta(minutes=10), updated_at=now,
        )
        db.add(o)
        w.closed[table.number] = o
    db.commit()
    return w


def _actor(till):
    return T.Actor(machine=till, pos_user_id="u", pos_user_name="דנה")


class TestTables:
    def test_the_screen_was_already_by_point_of_sale(self, t):
        # Unchanged by the lock: the shop-wide zone and its own point of sale's.
        names = sorted(z["name"] for z in T.till_state(t.db, t.a)["zones"])
        assert names == ["אולם", "בר"]
        lock_off(t)
        assert sorted(z["name"] for z in T.till_state(t.db, t.a)["zones"]) == ["אולם", "בר"]

    def test_closed_today_locked_is_its_areas_and_the_shop_wide_zones(self, t):
        assert sorted(o["tableNumber"] for o in T.closed_orders(t.db, t.a)) == [1, 2]
        assert sorted(o["tableNumber"] for o in T.closed_orders(t.db, t.c)) == [1, 2, 3]

    def test_closed_today_off_is_the_whole_shop(self, t):
        lock_off(t)
        assert sorted(o["tableNumber"] for o in T.closed_orders(t.db, t.a)) == [1, 2, 3]

    def test_restoring_another_areas_table_is_refused(self, t):
        is_area_locked(refused(T.mark_restored, t.db, t.a, t.closed[3].id, _actor(t.a)), "table")
        assert t.db.get(TableOrder, t.closed[3].id).restored_at is None
        assert T.mark_restored(t.db, t.a, t.closed[1].id, _actor(t.a)).restored_at is not None

    def test_restoring_off_is_as_today(self, t):
        lock_off(t)
        assert T.mark_restored(t.db, t.a, t.closed[3].id, _actor(t.a)).restored_at is not None

    def test_the_tills_tables_report_locked_and_off(self, t):
        day = datetime.now(timezone.utc).date()
        locked = TR.get_tables_reports(str(t.a.id), date_from=day - timedelta(days=1), date_to=day + timedelta(days=1), machine=t.a, db=t.db)
        lock_off(t)
        whole = TR.get_tables_reports(str(t.a.id), date_from=day - timedelta(days=1), date_to=day + timedelta(days=1), machine=t.a, db=t.db)
        assert json.dumps(locked, default=str) != json.dumps(whole, default=str)
        assert "מרפסת" not in json.dumps(locked, ensure_ascii=False, default=str)
        assert "מרפסת" in json.dumps(whole, ensure_ascii=False, default=str)

    def test_a_booking_on_another_areas_table_is_refused(self, t):
        body = ReservationIn(tableId=t.t_deck.id, reservedAt=datetime.now(timezone.utc) + timedelta(hours=2),
                             customerName="כהן", posUserName="דנה")
        from fastapi import BackgroundTasks

        is_area_locked(refused(TR.till_create_reservation, str(t.a.id), body, BackgroundTasks(), machine=t.a, db=t.db), "table")
        ok = ReservationIn(tableId=t.t_hall.id, reservedAt=datetime.now(timezone.utc) + timedelta(hours=2),
                           customerName="כהן", posUserName="דנה")
        assert TR.till_create_reservation(str(t.a.id), ok, BackgroundTasks(), machine=t.a, db=t.db)["tableId"] == str(t.t_hall.id)
        none = ReservationIn(reservedAt=datetime.now(timezone.utc) + timedelta(hours=3), customerName="לוי", posUserName="דנה")
        assert TR.till_create_reservation(str(t.a.id), none, BackgroundTasks(), machine=t.a, db=t.db)["tableId"] is None

    def test_another_areas_booking_cannot_be_marked(self, t):
        from fastapi import BackgroundTasks

        body = ReservationIn(tableId=t.t_deck.id, reservedAt=datetime.now(timezone.utc) + timedelta(hours=2),
                             customerName="כהן", posUserName="דנה")
        r = TR.till_create_reservation(str(t.b.id), body, BackgroundTasks(), machine=t.b, db=t.db)
        status_in = ReservationStatusIn(status="seated")
        is_area_locked(
            refused(TR.till_reservation_status, str(t.a.id), uuid.UUID(r["id"]), status_in, BackgroundTasks(), machine=t.a, db=t.db),
            "reservation",
        )
        lock_off(t)
        assert TR.till_reservation_status(str(t.a.id), uuid.UUID(r["id"]), status_in, BackgroundTasks(), machine=t.a, db=t.db)["status"] == "seated"


# ── KDS: the till's "הזמנות להכנה" ────────────────────────────────────────────


def _kitchen_order(w, ref, area_id, till):
    o = KitchenOrder(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, area_id=area_id, machine_id=till.id,
        source="quick", source_ref=ref, display_ref=ref, workflow_mode="ORDER_PROCESS", status="open",
        created_at=datetime.now(timezone.utc), first_released_at=datetime.now(timezone.utc),
    )
    w.db.add(o)
    w.db.commit()
    return o


class TestReadyOrders:
    @pytest.fixture
    def r(self, w):
        w.ko = {
            "bar": _kitchen_order(w, "bar", w.bar.id, w.a),
            "deck": _kitchen_order(w, "deck", w.terrace.id, w.b),
            "shop": _kitchen_order(w, "shop", None, w.c),
        }
        return w

    def _refs(self, w, till):
        return sorted(o["sourceRef"] for o in KDS.ready_orders(w.db, till)["orders"])

    def test_locked_lists_its_area_and_the_area_less(self, r):
        assert self._refs(r, r.a) == ["bar", "shop"]
        assert self._refs(r, r.c) == ["bar", "deck", "shop"]

    def test_off_is_the_whole_shop(self, r):
        lock_off(r)
        assert self._refs(r, r.a) == ["bar", "deck", "shop"]

    def test_marking_another_areas_order_is_refused(self, r):
        from app.schemas.kds import KdsReadyActionIn

        body = KdsReadyActionIn.model_validate({"id": str(uuid.uuid4()), "type": "ready", "orderId": str(r.ko["deck"].id)})
        is_area_locked(refused(KDS.ready_action, r.db, r.a, body), "order")


# ── Leaderboard ───────────────────────────────────────────────────────────────


class TestLeaderboard:
    def test_locked_ranks_its_areas_cashiers(self, w, monkeypatch):
        captured = {}
        real = ST._base_query

        def spy(db, tenant_id, shop_id, start, end, machine_ids=None):
            captured["ids"] = machine_ids
            return real(db, tenant_id, shop_id, start, end, machine_ids)

        monkeypatch.setattr(ST, "_base_query", spy)
        ST.leaderboard(w.db, w.a)
        assert sorted(captured["ids"], key=str) == sorted([w.a.id, w.a2.id], key=str)
        lock_off(w)
        ST.leaderboard(w.db, w.a)
        assert captured["ids"] is None


# ── Fiscal: unchanged ─────────────────────────────────────────────────────────


class TestFiscalUnchanged:
    def test_a_shop_z_still_takes_every_till_of_the_shop(self, w):
        from app.services import z_runs as ZR

        ids = {m.id for m in ZR.shop_tills(w.db, w.shop.id)}
        assert {w.a.id, w.a2.id, w.b.id, w.c.id} <= ids

    def test_the_tills_z_list_is_the_shops(self, w):
        from app.routers import sync as SR

        q = SR._own_shop_z_query(w.db, w.a)
        assert "area" not in str(q.statement).lower().split("where", 1)[1]

    def test_the_master_tills_shop_z_takes_every_till_whatever_its_lock(self, w, monkeypatch):
        from app.routers import till_shop_z as TSZ

        monkeypatch.setattr(TSZ, "_require_master", lambda db, machine: None)
        assert AL.is_locked(w.db, w.a)
        ids = {m.id for m in TSZ._shop_z_tills(w.db, w.a, w.shop, w.tenant)}
        assert {w.a.id, w.a2.id, w.b.id, w.c.id} <= ids


# ── The golden fixture shared with the till (pos-android app/src/test/resources) ──


GOLDEN_SHA256 = "413d23fcc59163f4a439f5f0b33f65a43efa7d60fc0a44256b2ff1791046790d"


def _golden():
    import hashlib
    from pathlib import Path

    raw = (Path(__file__).parent / "fixtures" / "area_lock_golden.json").read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest(), json.loads(raw.decode("utf-8"))


class TestGolden:
    def test_the_fixture_is_the_pinned_one(self):
        sha, _ = _golden()
        assert sha == GOLDEN_SHA256

    def test_the_parameter_and_the_refusal_match(self):
        _, g = _golden()
        spec = AL.AREA_LOCK_PARAMETER_SPECS[0]
        assert spec["key"] == g["parameter"]["key"] == AL.AREA_SCOPE_LOCK_KEY
        assert spec["label"] == g["parameter"]["label"]
        assert spec["value_type"] == g["parameter"]["valueType"]
        assert spec["default_value"] is g["parameter"]["default"]
        assert AL.AREA_LOCKED == g["refusal"]["detail"] and AL.refusal().status_code == g["refusal"]["status"]
        assert AL.MESSAGES == g["messages"]

    def test_covers_shared_cases(self):
        _, g = _golden()
        ids = {"bar": uuid.uuid4(), "terrace": uuid.uuid4()}
        for case in g["coversShared"]:
            scope = AL.AreaScope(shop_id=uuid.uuid4(), area_id=ids["bar"], area_name="בר", locked=case["locked"])
            area = ids.get(case["resourceArea"]) if case["resourceArea"] else None
            assert scope.covers_shared(area) is case["covers"], case

    def test_locked_cases(self, w):
        _, g = _golden()
        for case in g["locked"]:
            w.db.query(TillParameterValue).delete()
            w.db.commit()
            w.a.area_id = w.bar.id if case["area"] else None
            if case["param"] is not None:
                set_lock(w, "machine", w.a.id, case["param"])
            w.db.commit()
            assert AL.is_locked(w.db, w.a) is case["locked"], case
