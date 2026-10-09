"""
"חסימות ואזל" — blocks on a product ("אזל" / "חסום") for a scope, for a while
(app/services/sold_out.py, app/services/sold_out_rules.py, app/services/block_durations.py,
app/routers/item_blocks.py).

Each test names a way the feature could look right and still sell what it should not:

* the shared rule drifting from the till's (the golden cases, same bytes in pos-android);
* a scope reaching the wrong devices — the tills of another shop, a regular till for "all kiosks",
  a till outside the point of sale or the event;
* a block (or its end) that never reaches a till pulling deltas, or a till that wakes before the
  commit;
* "עד שעה" landing in the past, "עד סוף היום" ending at midnight, daylight saving moving an hour;
* the automatic "אזל" touching a hand block, or staying after stock came back;
* a manager blocking another shop's devices.

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import Base
from app.models.kiosk import KioskDevice
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.shop_area import ShopArea
from app.models.sold_out import SoldOutMark
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovementReason
from app.routers import item_blocks as R
from app.services import block_durations as D
from app.services import commit_signals
from app.services import sold_out as svc
from app.services import sold_out_rules as rules
from app.services import stock as stock_service
from app.services import sync as S

from test_product_availability import OLD, world  # noqa: F401

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "sold_out_golden.json"
#: The LF-normalised bytes' SHA-256 — pos-android's SoldOutRulesTest pins the same value.
GOLDEN_SHA256 = "f6afb7e161bba418c2396d98ba94a0b4e8fc875620ef99a94cfa60a6c1e95565"

NOW = datetime(2026, 10, 9, 9, 0, tzinfo=timezone.utc)  # 12:00 in Israel


# ── The shared rule ──────────────────────────────────────────────────────────


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_golden_cases_are_the_bytes_pos_android_pins():
    data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256


@pytest.mark.parametrize("case", _golden()["cases"], ids=lambda c: c["name"])
def test_the_shared_rule_gives_each_golden_answer(case):
    t = case["till"]
    till = rules.Till(
        company_id=t.get("companyId"), shop_id=t.get("shopId"), area_id=t.get("areaId"),
        machine_id=t.get("machineId"), is_kiosk=bool(t.get("isKiosk")),
        event_ids=tuple(t.get("eventIds") or ()), group_ids=tuple(t.get("groupIds") or ()),
    )
    item = case.get("item")
    got = rules.decide(
        case["blocks"], rules.parse_time(case["now"]), till=till, setting=case["setting"],
        track_stock=case["trackStock"], stock=case["stock"],
        item=rules.Item(item.get("productId"), tuple(item.get("categoryIds") or ())) if item else None,
    )
    expect = case["expect"]
    assert got.state == expect["state"]
    assert got.reason == expect["reason"]
    assert (got.block or {}).get("id") == expect["block"]
    assert got.overridable is expect["overridable"]
    assert got.display == expect["kioskDisplay"]


# ── Durations ────────────────────────────────────────────────────────────────


class TestDurations:
    def test_presets_and_custom_minutes(self):
        for m in D.PRESET_MINUTES + (7,):
            assert D.compute_end("minutes", NOW, minutes=m).until == NOW + timedelta(minutes=m)

    def test_minutes_out_of_range_are_refused(self):
        for bad in (0, -5, D.MAX_MINUTES + 1, None, True):
            with pytest.raises(D.DurationRefused):
                D.compute_end("minutes", NOW, minutes=bad)

    def test_until_a_time_later_today(self):
        end = D.compute_end("time", NOW, zone_name="Asia/Jerusalem", at="14:35")
        assert end.until == datetime(2026, 10, 9, 11, 35, tzinfo=timezone.utc) and end.rolled is False

    def test_a_time_that_passed_rolls_to_tomorrow_and_says_so(self):
        end = D.compute_end("time", NOW, zone_name="Asia/Jerusalem", at="11:00")
        assert end.until == datetime(2026, 10, 10, 8, 0, tzinfo=timezone.utc) and end.rolled is True
        same = D.compute_end("time", NOW, zone_name="Asia/Jerusalem", at="12:00")
        assert same.rolled is True, "now itself is the past"

    def test_end_of_day_is_the_next_business_day_start(self):
        assert D.business_day_start() == "04:00", "the one day start: insights' DEFAULT_DAY_START_HOUR"
        assert D.compute_end("end_of_day", NOW, zone_name="Asia/Jerusalem").until == datetime(
            2026, 10, 10, 1, 0, tzinfo=timezone.utc
        ), "04:00 tomorrow"
        night = datetime(2026, 10, 9, 22, 30, tzinfo=timezone.utc)  # 01:30 local on the 10th
        assert D.compute_end("end_of_day", night, zone_name="Asia/Jerusalem").until == datetime(
            2026, 10, 10, 1, 0, tzinfo=timezone.utc
        ), "a bar's night ends with the same morning"
        assert D.business_today(night, "Asia/Jerusalem") == date(2026, 10, 9), "01:30 is still the 9th's business day"

    def test_daylight_saving_ends_overnight(self):
        # Israel leaves summer time on 25.10.2026 at 02:00 (back to 01:00): +03:00 → +02:00.
        evening = datetime(2026, 10, 24, 19, 0, tzinfo=timezone.utc)  # 22:00 local, summer time
        assert D.compute_end("end_of_day", evening, zone_name="Asia/Jerusalem").until == datetime(
            2026, 10, 25, 2, 0, tzinfo=timezone.utc
        ), "04:00 winter time"
        assert D.compute_end("time", evening, zone_name="Asia/Jerusalem", at="09:00").until == datetime(
            2026, 10, 25, 7, 0, tzinfo=timezone.utc
        )

    def test_daylight_saving_starts_and_a_missing_time_moves_on(self):
        # 27.03.2026 02:00 → 03:00: 02:30 does not exist that night.
        before = datetime(2026, 3, 26, 22, 0, tzinfo=timezone.utc)  # 00:00 local
        end = D.compute_end("time", before, zone_name="Asia/Jerusalem", at="02:30")
        assert end.until == datetime(2026, 3, 27, 0, 30, tzinfo=timezone.utc), "03:30 summer time"

    def test_bad_times_and_modes(self):
        for at in ("25:00", "9:00", "", None, "12:60"):
            with pytest.raises(D.DurationRefused):
                D.compute_end("time", NOW, at=at)
        with pytest.raises(D.DurationRefused):
            D.compute_end("forever", NOW)
        assert D.compute_end("none", NOW).until is None

    def test_extend_adds_to_the_end_or_to_now_when_it_passed(self):
        end = NOW + timedelta(minutes=10)
        assert D.extend(end, NOW, 30) == NOW + timedelta(minutes=40)
        assert D.extend(NOW - timedelta(minutes=5), NOW, 15) == NOW + timedelta(minutes=15)
        with pytest.raises(D.DurationRefused):
            D.extend(None, NOW, 15)


# ── On a real session ────────────────────────────────────────────────────────


@pytest.fixture
def b(world, monkeypatch):  # noqa: F811
    """h_shop: h1 in point of sale "Bar", h2 a kiosk, a third till k3 in no area; an event with h1."""
    db = world.db
    for name in (
        "sync_logs", "stock_levels", "stock_movements", "sold_out_marks", "kiosk_devices",
        "report_events", "report_event_machines", "shop_category_overrides",
        "machine_groups", "machine_group_members",
    ):
        if name in Base.metadata.tables and not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    world.signals = []
    monkeypatch.setattr(commit_signals, "publish", lambda t, m, why: world.signals.append((m, why)))
    monkeypatch.setattr(stock_service, "pg_insert", sqlite_insert)
    bar = ShopArea(id=uuid.uuid4(), tenant_id=world.tid, shop_id=world.h_shop.id, name="Bar")
    db.add(bar)
    db.flush()
    world.h1.area_id = bar.id
    db.add(KioskDevice(machine_id=world.h2.id, tenant_id=world.tid, shop_id=world.h_shop.id, name="Kiosk", enabled=True))
    event = ReportEvent(
        id=uuid.uuid4(), tenant_id=world.tid, company_id=world.H.id, shop_id=world.h_shop.id, name="Fest",
        starts_at=NOW - timedelta(hours=1), ends_at=NOW + timedelta(hours=6),
    )
    db.add(event)
    db.flush()
    db.add(ReportEventMachine(id=uuid.uuid4(), event_id=event.id, machine_id=world.h1.id))
    db.commit()
    world.bar, world.event = bar, event
    return world


def _row(w, machine, product=None, since=None):
    product = product or w.P
    rows = S.get_products_for_sync(w.db, str(w.tid), str(machine.id), since=since)
    hits = [r for r in rows if r["globalProductId"] == str(product.id)]
    return hits[0] if hits else None


def _block(w, scope, scope_id, *, kind="sold_out", until=None, user=None, product=None, note=None):
    target = svc.resolve_target(w.db, scope, scope_id, w.tid)
    mark = svc.block(
        w.db, tenant_id=w.tid, product=product or w.P, target=target, kind=kind, until=until,
        user=user or w.users.admin, note=note,
    )
    w.db.commit()
    return mark


def _sells(w, machine) -> bool:
    return _row(w, machine)["isAvailable"]


def _group(w, name, company, machines):
    """A device group ("קבוצות מכשירים", app/models/machine_group.py) of the company, with these tills."""
    from app.models.machine_group import MachineGroup, MachineGroupMember

    g = MachineGroup(id=uuid.uuid4(), tenant_id=w.tid, company_id=company.id, name=name)
    w.db.add(g)
    w.db.flush()
    for m in machines:
        w.db.add(MachineGroupMember(group_id=g.id, machine_id=m.id))
    w.db.commit()
    return g


class TestScopes:
    def test_a_shop_block_reaches_every_device_of_the_shop_and_no_other(self, b):
        _block(b, "shop", b.h_shop.id)
        assert (_sells(b, b.h1), _sells(b, b.h2), _sells(b, b.a1)) == (False, False, True)
        row = _row(b, b.h1)
        assert row["lockAvailable"] is True, "a block is not the catalog lock"
        assert [x["scope"] for x in row["blocks"]] == ["shop"]

    def test_all_kiosks_stop_the_kiosk_and_the_tills_keep_selling(self, b):
        _block(b, "kiosks", b.h_shop.id, kind="blocked")
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)

    def test_one_kiosk_only_and_never_a_till_named_as_a_kiosk(self, b):
        _block(b, "kiosk", b.h2.id)
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)
        with pytest.raises(HTTPException) as refused:
            svc.resolve_target(b.db, "kiosk", b.h1.id, b.tid)
        assert refused.value.detail["code"] == "not_a_kiosk"

    def test_a_point_of_sale_reaches_the_tills_standing_in_it(self, b):
        _block(b, "area", b.bar.id)
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (False, True)

    def test_one_till(self, b):
        _block(b, "machine", b.h2.id)
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)

    def test_an_event_reaches_its_tills_until_they_are_released(self, b):
        _block(b, "event", b.event.id)
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (False, True)
        b.db.query(ReportEventMachine).update({ReportEventMachine.released_at: NOW})
        b.db.commit()
        assert _sells(b, b.h1) is True

    def test_a_company_reaches_its_own_shops_only(self, b):
        _block(b, "company", b.H.id)
        assert (_sells(b, b.h1), _sells(b, b.a1)) == (False, True), "a sub-company's shop is another company"

    def test_overlapping_blocks_any_one_stops_and_each_is_removed_alone(self, b):
        shop = _block(b, "shop", b.h_shop.id)
        area = _block(b, "area", b.bar.id, kind="blocked", note="הגריל סגור")
        assert len(_row(b, b.h1)["blocks"]) == 2
        svc.clear(b.db, shop, user=b.users.admin)
        b.db.commit()
        assert _sells(b, b.h1) is False and _sells(b, b.h2) is True
        svc.clear(b.db, area, user=b.users.admin)
        b.db.commit()
        assert _sells(b, b.h1) is True

    def test_the_same_block_again_is_updated_not_doubled(self, b):
        _block(b, "shop", b.h_shop.id)
        _block(b, "shop", b.h_shop.id, until=datetime.now(timezone.utc) + timedelta(hours=1))
        assert b.db.query(SoldOutMark).count() == 1

    # ── Device groups (feat/menu-groups' model, wired at the integration merge) ──

    def test_a_group_inside_one_shop_reaches_its_members_only(self, b):
        bar = _group(b, "בר", b.H, [b.h1])
        target = svc.resolve_target(b.db, "group", bar.id, b.tid)
        assert (target.company_id, target.shop_id, target.name) == (b.H.id, b.h_shop.id, "בר")
        _block(b, "group", bar.id)
        assert (_sells(b, b.h1), _sells(b, b.h2), _sells(b, b.a1)) == (False, True, True)
        assert [x["scope"] for x in _row(b, b.h1)["blocks"]] == ["group"]

    def test_a_group_across_shops_reaches_its_members_in_each(self, b):
        events = _group(b, "עמדות אירוע", b.H, [b.h1, b.a1])
        target = svc.resolve_target(b.db, "group", events.id, b.tid)
        assert (target.company_id, target.shop_id) == (b.H.id, None), "across shops: a company-wide target"
        _block(b, "group", events.id)
        assert (_sells(b, b.h1), _sells(b, b.h2), _sells(b, b.a1)) == (False, True, False)

    def test_another_tenants_group_or_an_unknown_one_is_not_found(self, b):
        from app.models.machine_group import MachineGroup

        other = MachineGroup(id=uuid.uuid4(), tenant_id=uuid.uuid4(), company_id=b.H.id, name="זר")
        b.db.add(other)
        b.db.commit()
        for gid in (other.id, uuid.uuid4()):
            with pytest.raises(HTTPException) as refused:
                svc.resolve_target(b.db, "group", gid, b.tid)
            assert refused.value.status_code == 404 and refused.value.detail["code"] == "scope_not_found"

    def test_an_inactive_member_is_not_reached(self, b):
        from app.services import device_groups

        g = _group(b, "בר", b.H, [b.h1, b.h2])
        b.h2.is_active = False
        b.db.commit()
        assert device_groups.group(b.db, g.id, b.tid)["machineIds"] == [b.h1.id]
        assert device_groups.groups_of(b.db, b.h1.id) == [g.id]


class TestDelivery:
    def test_devices_wake_only_after_the_commit(self, b):
        target = svc.resolve_target(b.db, "area", b.bar.id, b.tid)
        svc.block(b.db, tenant_id=b.tid, product=b.P, target=target, user=b.users.admin)
        assert b.signals == []
        b.db.commit()
        assert {m for m, _ in b.signals} == {str(b.h1.id)}

    def test_an_automatic_sold_out_never_reaches_a_till_that_predates_blocks(self, b):
        target = svc.resolve_target(b.db, "shop", b.h_shop.id, b.tid)
        svc.block(b.db, tenant_id=b.tid, product=b.P, target=target, by_name="אזל אוטומטי", source="auto")
        b.db.commit()
        row = _row(b, b.h1)
        # An older till reads only isAvailable: it keeps selling under its own stock policy.
        assert row["isAvailable"] is True and row["lockAvailable"] is True
        # An updated till or kiosk reads the block.
        assert [x["source"] for x in row["blocks"]] == ["auto"]
        _block(b, "shop", b.h_shop.id)  # a block set by hand reaches every till
        assert _row(b, b.h1)["isAvailable"] is False

    def test_a_block_and_its_removal_reach_a_till_that_pulls_deltas(self, b):
        since = datetime.now(timezone.utc) - timedelta(seconds=1)
        mark = _block(b, "shop", b.h_shop.id)
        assert _row(b, b.h1, since=since)["isAvailable"] is False
        later = datetime.now(timezone.utc)
        svc.clear(b.db, mark, user=b.users.admin, now=later + timedelta(seconds=1))
        b.db.commit()
        row = _row(b, b.h1, since=later)
        assert row is not None and row["isAvailable"] is True and row["blocks"] == []

    def test_a_block_that_ended_by_itself_reaches_a_delta_pull(self, b):
        now = datetime.now(timezone.utc)
        mark = _block(b, "shop", b.h_shop.id, until=now + timedelta(minutes=30))
        mark.updated_at = now - timedelta(hours=1)
        mark.created_at = now - timedelta(hours=1)
        mark.until = now - timedelta(minutes=1)
        b.db.commit()
        row = _row(b, b.h1, since=now - timedelta(minutes=10))
        assert row is not None and row["isAvailable"] is True, "its end moved the row"
        assert _row(b, b.h1, since=now) is None, "and only once"

    def test_the_till_gets_the_absolute_end_to_lift_it_offline(self, b):
        until = datetime.now(timezone.utc) + timedelta(minutes=45)
        _block(b, "shop", b.h_shop.id, until=until)
        sent = _row(b, b.h1)["blocks"][0]
        assert rules.parse_time(sent["until"]) == until.replace(microsecond=until.microsecond)
        assert rules.decide([sent], until + timedelta(seconds=1)).state == rules.AVAILABLE


class TestAutomatic:
    def _stock(self, w, qty):
        w.P.track_stock = True
        w.db.add(StockLevel(tenant_id=w.tid, shop_id=w.h_shop.id, product_id=w.P.id, quantity=Decimal(qty)))
        w.db.commit()

    def _move(self, w, delta):
        stock_service.apply_movement(
            w.db, movement_id=uuid.uuid4(), tenant_id=w.tid, shop_id=w.h_shop.id, product_id=w.P.id,
            delta=Decimal(delta), reason=StockMovementReason.SALE, occurred_at=datetime.now(timezone.utc),
            machine_id=w.h1.id,
        )
        w.db.commit()

    def _auto(self, w):
        return w.db.query(SoldOutMark).filter(SoldOutMark.source == "auto", SoldOutMark.cleared_at.is_(None)).all()

    def test_the_last_unit_sold_blocks_the_shop_and_stock_back_clears_it(self, b):
        self._stock(b, "1")
        self._move(b, "-1")
        assert [(m.scope, m.kind) for m in self._auto(b)] == [("shop", "sold_out")]
        # The kiosk (an updated device) reads the block at once; an older till's isAvailable is
        # left to its own stock policy.
        assert [x["source"] for x in _row(b, b.h2)["blocks"]] == ["auto"]
        assert _sells(b, b.h2) is True
        self._move(b, "5")
        assert self._auto(b) == []
        assert _row(b, b.h2)["blocks"] == []

    def test_a_hand_block_is_never_touched_by_stock(self, b):
        self._stock(b, "1")
        _block(b, "shop", b.h_shop.id, kind="blocked")
        self._move(b, "-1")
        self._move(b, "3")
        hand = b.db.query(SoldOutMark).filter(SoldOutMark.source == "manual").one()
        assert hand.cleared_at is None

    def test_the_setting_off_sets_none(self, b):
        b.h_shop.settings = {"autoSoldOutAtZero": False}
        b.db.commit()
        self._stock(b, "1")
        self._move(b, "-1")
        assert self._auto(b) == []

    def test_untracked_products_never_block_themselves(self, b):
        b.db.add(StockLevel(tenant_id=b.tid, shop_id=b.h_shop.id, product_id=b.P.id, quantity=Decimal("1")))
        b.db.commit()
        self._move(b, "-1")
        assert self._auto(b) == []


class TestDashboard:
    def _create(self, w, user, targets, **kw):
        body = R.BlockIn(productId=w.P.id, targets=[R.TargetIn(scope=s, scopeId=i) for s, i in targets], **kw)
        return R.create_blocks(body, current_user=user, active_tenant_id=w.tid, db=w.db)

    def test_several_points_of_sale_in_one_tap_with_one_end(self, b):
        lobby = ShopArea(id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.h_shop.id, name="Lobby")
        b.db.add(lobby)
        b.db.commit()
        out = self._create(
            b, b.users.admin, [("area", b.bar.id), ("area", lobby.id)],
            duration=R.DurationIn(mode="minutes", minutes=30),
        )
        assert len(out["blocks"]) == 2
        assert len({x["until"] for x in out["blocks"]}) == 1

    def test_a_shop_manager_cannot_block_another_shops_devices(self, b):
        with pytest.raises(HTTPException) as refused:
            self._create(b, b.users.a_shop_manager, [("shop", b.h_shop.id)])
        assert refused.value.status_code == 403
        assert b.db.query(SoldOutMark).count() == 0

    def test_a_cashier_cannot_block(self, b):
        with pytest.raises(HTTPException):
            self._create(b, b.users.h_cashier, [("shop", b.h_shop.id)])

    def test_extend_and_remove_now(self, b):
        out = self._create(b, b.users.admin, [("shop", b.h_shop.id)], duration=R.DurationIn(mode="minutes", minutes=15))
        block_id = uuid.UUID(out["blocks"][0]["id"])
        before = rules.parse_time(out["blocks"][0]["until"])
        extended = R.extend_block(block_id, R.ExtendIn(minutes=30), current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert rules.parse_time(extended["until"]) == before + timedelta(minutes=30)
        removed = R.clear_block(block_id, current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert removed["inForce"] is False and _sells(b, b.h1) is True

    def test_an_open_ended_block_cannot_be_extended(self, b):
        out = self._create(b, b.users.admin, [("shop", b.h_shop.id)])
        with pytest.raises(HTTPException) as refused:
            R.extend_block(uuid.UUID(out["blocks"][0]["id"]), R.ExtendIn(minutes=15), current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert refused.value.detail["code"] == "no_end"

    def test_the_list_says_who_what_where_and_how_long(self, b):
        self._create(b, b.users.admin, [("area", b.bar.id)], kind="blocked", note="הגריל סגור",
                     duration=R.DurationIn(mode="minutes", minutes=60))
        rows = R.list_blocks(None, b.h_shop.id, None, False, current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert len(rows) == 1
        row = rows[0]
        assert (row["scope"], row["scopeName"], row["kind"], row["note"], row["productName"]) == (
            "area", "Bar", "blocked", "הגריל סגור", "Cola",
        )
        assert 3500 < row["secondsLeft"] <= 3600

    def test_clear_every_block_of_a_product_in_one_tap(self, b):
        self._create(b, b.users.admin, [("shop", b.h_shop.id), ("area", b.bar.id)])
        out = R.clear_product_blocks(R.ClearIn(productId=b.P.id, shopId=b.h_shop.id), current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert out["cleared"] == 2 and _sells(b, b.h1) is True

    def test_the_targets_offer_tills_and_kiosks_apart(self, b):
        out = R.list_targets(b.h_shop.id, current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert {t["id"] for t in out["kiosks"]} == {str(b.h2.id)}
        assert str(b.h1.id) in {t["id"] for t in out["tills"]}
        assert [a["name"] for a in out["areas"]] == ["Bar"]
        assert out["groupsAvailable"] is True and out["businessDayStart"] == "04:00"
        assert out["groups"] == []

    def test_who_may_block_a_device_group(self, b):
        inside = _group(b, "בר", b.H, [b.h1])
        across = _group(b, "עמדות אירוע", b.H, [b.h1, b.a1])
        # The shop's manager: a group inside their shop, never one across shops (that is the company's).
        self._create(b, b.users.h_shop_manager, [("group", inside.id)])
        with pytest.raises(HTTPException) as refused:
            self._create(b, b.users.h_shop_manager, [("group", across.id)])
        assert refused.value.status_code == 403
        # The group's company manager: across its shops too; another company's manager: neither.
        self._create(b, b.users.h_manager, [("group", across.id)])
        for group in (inside, across):
            with pytest.raises(HTTPException) as refused:
                self._create(b, b.users.b_manager, [("group", group.id)])
            assert refused.value.status_code in (403, 404)

    def test_the_picker_offers_the_groups_each_user_may_block(self, b):
        inside = _group(b, "בר", b.H, [b.h1])
        across = _group(b, "עמדות אירוע", b.H, [b.h1, b.a1])
        _group(b, "רחוק", b.H, [b.a1])  # no till in this shop: not offered here
        admin = R.list_targets(b.h_shop.id, current_user=b.users.admin, active_tenant_id=b.tid, db=b.db)
        assert {(g["id"], g["acrossShops"], g["machines"]) for g in admin["groups"]} == {
            (str(inside.id), False, 1), (str(across.id), True, 2),
        }
        manager = R.list_targets(b.h_shop.id, current_user=b.users.h_shop_manager, active_tenant_id=b.tid, db=b.db)
        assert [g["id"] for g in manager["groups"]] == [str(inside.id)]


def test_the_migrations_chain_on_one_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert len(script.get_heads()) == 1
    # Written on 6b1e9d4f2a87; re-chained after device groups' e8b3f5a1c7d2 at the integration merge.
    assert script.get_revision("8d5f3b0e2a74").down_revision == "e8b3f5a1c7d2"
    assert script.get_revision("9e6a4c1f3b85").down_revision == "8d5f3b0e2a74"
    # specs/item-blocks-targets.md: targets, category blocks, the quick hides folded in.
    assert script.get_revision("c7d1a9e4f2b6").down_revision == "b8e2d4f6a1c3"


# ── Targets, categories, the kiosks' look, devices (specs/item-blocks-targets.md) ──


def _kiosk_in_bar(w):
    """h2 (the kiosk) stands in the point of sale "Bar" with h1 (a till)."""
    w.h2.area_id = w.bar.id
    w.db.commit()


def _sub_category(w, name="Soft"):
    """A category under the product's, holding the second product Q."""
    from app.models.category import Category

    parent = w.db.get(Category, w.P.category_id)
    child = Category(id=uuid.uuid4(), tenant_id=w.tid, name=name, parent_id=parent.id, updated_at=OLD)
    w.db.add(child)
    w.db.flush()
    w.Q.category_id = child.id
    w.db.commit()
    return parent, child


def _tblock(w, scope, scope_id, *, reach="all", kind="sold_out", product=None, category=None, display=None, until=None):
    target = svc.resolve_target(w.db, scope, scope_id, w.tid)
    mark = svc.block(
        w.db, tenant_id=w.tid, product=None if category is not None else (product or w.P), category=category,
        target=target, kind=kind, until=until, user=w.users.admin, reach=reach, display=display,
    )
    w.db.commit()
    return mark


class TestTargets:
    def test_kiosks_only_at_a_point_of_sale_stops_its_kiosk_and_its_till_keeps_selling(self, b):
        _kiosk_in_bar(b)
        _tblock(b, "area", b.bar.id, reach="kiosks", kind="blocked")
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)
        assert _row(b, b.h1)["blocks"] == [], "a till is never sent a kiosks-only block"
        assert [x["target"] for x in _row(b, b.h2)["blocks"]] == ["kiosks"]

    def test_tills_only_at_the_shop_stops_the_tills_and_the_kiosk_keeps_selling(self, b):
        _tblock(b, "shop", b.h_shop.id, reach="tills")
        assert (_sells(b, b.h1), _sells(b, b.h2), _sells(b, b.a1)) == (False, True, True)
        assert _row(b, b.h2)["blocks"] == []

    def test_a_kiosk_of_another_point_of_sale_is_not_reached(self, b):
        _tblock(b, "area", b.bar.id, reach="kiosks")
        assert _sells(b, b.h2) is True, "the kiosk stands in no point of sale"

    def test_the_older_kiosks_scope_is_written_as_the_shop_for_kiosks(self, b):
        mark = _block(b, "kiosks", b.h_shop.id)
        assert (mark.scope, mark.target) == ("shop", "kiosks")
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)
        one = _block(b, "kiosk", b.h2.id)
        assert (one.scope, one.target) == ("machine", "kiosks")

    def test_an_older_kiosks_row_stays_readable_and_is_the_same_block(self, b):
        old = SoldOutMark(
            id=uuid.uuid4(), tenant_id=b.tid, company_id=b.H.id, shop_id=b.h_shop.id, product_id=b.P.id,
            scope="kiosks", scope_id=b.h_shop.id, target="kiosks", kind="sold_out", source="manual",
            created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
        )
        b.db.add(old)
        b.db.commit()
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)
        again = _tblock(b, "shop", b.h_shop.id, reach="kiosks", until=datetime.now(timezone.utc) + timedelta(hours=1))
        assert again.id == old.id, "updated, not doubled"
        assert svc.target_of(old) == "kiosks" and svc.level_of(old) == "shop"

    def test_all_kiosks_for_the_tills_only_is_refused(self, b):
        target = svc.resolve_target(b.db, "kiosks", b.h_shop.id, b.tid)
        with pytest.raises(HTTPException) as refused:
            svc.block(b.db, tenant_id=b.tid, product=b.P, target=target, reach="tills", user=b.users.admin)
        assert refused.value.detail["code"] == "target_conflict"

    def test_only_the_reached_devices_wake(self, b):
        _kiosk_in_bar(b)
        _tblock(b, "area", b.bar.id, reach="tills")
        assert {m for m, _ in b.signals} == {str(b.h1.id)}
        b.signals.clear()
        _tblock(b, "area", b.bar.id, reach="kiosks")
        assert {m for m, _ in b.signals} == {str(b.h2.id)}


class TestCategories:
    def test_a_category_block_stops_every_product_in_it_and_below_it(self, b):
        parent, child = _sub_category(b)
        _tblock(b, "shop", b.h_shop.id, category=parent, kind="blocked")
        assert _row(b, b.h1)["isAvailable"] is False
        assert _row(b, b.h1, product=b.Q)["isAvailable"] is False, "a product of a sub-category"
        sent = _row(b, b.h1, product=b.Q)["blocks"][0]
        assert (sent["categoryId"], sent["productId"]) == (str(parent.id), None)

    def test_a_sub_category_block_leaves_the_parent_category_selling(self, b):
        parent, child = _sub_category(b)
        _tblock(b, "shop", b.h_shop.id, category=child)
        assert (_row(b, b.h1)["isAvailable"], _row(b, b.h1, product=b.Q)["isAvailable"]) == (True, False)

    def test_a_category_block_and_its_removal_reach_a_delta_pull(self, b):
        parent, _child = _sub_category(b)
        since = datetime.now(timezone.utc) - timedelta(seconds=1)
        mark = _tblock(b, "shop", b.h_shop.id, category=parent)
        assert _row(b, b.h1, product=b.Q, since=since)["isAvailable"] is False
        later = datetime.now(timezone.utc)
        svc.clear(b.db, mark, user=b.users.admin, now=later + timedelta(seconds=1))
        b.db.commit()
        row = _row(b, b.h1, product=b.Q, since=later)
        assert row is not None and row["isAvailable"] is True

    def test_the_list_finds_a_products_category_blocks(self, b):
        parent, _child = _sub_category(b)
        _tblock(b, "shop", b.h_shop.id, category=parent)
        rows = svc.list_blocks(b.db, tenant_id=b.tid, shop_ids=[b.h_shop.id], product_id=b.Q.id)
        assert [(r["itemType"], r["itemName"]) for r in rows] == [("category", parent.name)]

    def test_neither_or_both_is_refused(self, b):
        from app.models.category import Category

        target = svc.resolve_target(b.db, "shop", b.h_shop.id, b.tid)
        cat = b.db.get(Category, b.P.category_id)
        for kw in ({}, {"product": b.P, "category": cat}):
            with pytest.raises(HTTPException) as refused:
                svc.block(b.db, tenant_id=b.tid, target=target, user=b.users.admin, **kw)
            assert refused.value.detail["code"] == "item_required"


class TestKioskLook:
    def test_hide_rides_on_the_kiosk_config(self, b):
        from app.models.category import Category
        from app.services import kiosk_config as cfgsvc

        if not b.db.get_bind().dialect.has_table(b.db.connection(), "kiosk_settings"):
            Base.metadata.tables["kiosk_settings"].create(b.db.get_bind())
        _tblock(b, "shop", b.h_shop.id, reach="kiosks", display="hide")
        cat = b.db.get(Category, b.P.category_id)
        _tblock(b, "shop", b.h_shop.id, reach="kiosks", category=cat, display="hide", kind="blocked")
        cfg = cfgsvc.effective_config(b.db, b.h2)
        assert str(b.P.id) in cfg["catalog"]["hiddenProducts"]
        assert str(cat.id) in cfg["catalog"]["hiddenCategories"]
        assert svc.kiosk_hidden(b.db, b.h1) == ([], []), "a till has no kiosk config to hide in"

    def test_grey_is_sent_on_the_row(self, b):
        _tblock(b, "shop", b.h_shop.id, display="grey")
        assert _row(b, b.h2)["kioskDisplay"] == "grey"
        assert _row(b, b.h2, product=b.Q)["kioskDisplay"] is None


class TestListFilters:
    def test_by_point_of_sale_and_by_target(self, b):
        lobby = ShopArea(id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.h_shop.id, name="Lobby")
        b.db.add(lobby)
        b.db.commit()
        _tblock(b, "shop", b.h_shop.id, reach="kiosks")
        _tblock(b, "area", b.bar.id, reach="tills", product=b.Q)
        _tblock(b, "area", lobby.id)
        _tblock(b, "machine", b.h1.id, kind="blocked")
        bar = svc.list_blocks(b.db, tenant_id=b.tid, shop_ids=[b.h_shop.id], area_id=b.bar.id)
        assert sorted(r["level"] for r in bar) == ["area", "machine", "shop"], "not the lobby's"
        kiosks = svc.list_blocks(b.db, tenant_id=b.tid, shop_ids=[b.h_shop.id], target="kiosks")
        assert [(r["level"], r["target"]) for r in kiosks] == [("shop", "kiosks")]
        tills = svc.list_blocks(b.db, tenant_id=b.tid, shop_ids=[b.h_shop.id], target="tills")
        assert [r["level"] for r in tills] == ["area"]


@pytest.fixture
def dev(b):
    """The world with till users: a manager (legacy: everything), a cashier (asks a manager), another shop's manager."""
    from app.models.pos_user import PosUser, PosUserRole

    for name in ("employee_roles", "till_roles", "pos_users"):
        if name in Base.metadata.tables and not b.db.get_bind().dialect.has_table(b.db.connection(), name):
            Base.metadata.tables[name].create(b.db.get_bind())
    b.mgr = PosUser(id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.h_shop.id, username="mgr", first_name="Dana",
                    pin_hash="x", role=PosUserRole.SHOP_MANAGER, is_active=True)
    b.cashier = PosUser(id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.h_shop.id, username="cash", pin_hash="x",
                        role=PosUserRole.CASHIER, is_active=True)
    b.other_mgr = PosUser(id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.a_shop.id, username="far", pin_hash="x",
                          role=PosUserRole.SHOP_MANAGER, is_active=True)
    b.db.add_all([b.mgr, b.cashier, b.other_mgr])
    b.db.commit()
    return b


def _dev_block(w, machine, approver, **body):
    payload = {"productId": w.P.id, **body}
    return R.device_block(
        str(machine.id), R.DeviceBlockIn(**payload), pos_user_id=str(approver.id) if approver else None,
        machine=machine, db=w.db,
    )


def _refusal(out):
    assert hasattr(out, "status_code"), out
    return out.status_code, json.loads(out.body)["detail"]["code"]


class TestDevices:
    def test_a_till_blocks_for_its_own_point_of_sale_by_default(self, dev):
        out = _dev_block(dev, dev.h1, dev.mgr, kind="blocked", note="נגמר")
        block = out["block"]
        assert (block["level"], block["scopeId"], block["target"], block["origin"]) == ("area", str(dev.bar.id), "all", "till")
        assert block["by"].startswith("h1") and block["removable"] is True
        assert _sells(dev, dev.h1) is False

    def test_a_cashier_alone_or_a_manager_of_another_shop_is_refused(self, dev):
        for who in (dev.cashier, dev.other_mgr, None):
            assert _refusal(_dev_block(dev, dev.h1, who)) == (403, "item_block_requires_manager")
        assert dev.db.query(SoldOutMark).count() == 0

    def test_a_till_never_blocks_another_point_of_sale_or_shop(self, dev):
        lobby = ShopArea(id=uuid.uuid4(), tenant_id=dev.tid, shop_id=dev.h_shop.id, name="Lobby")
        dev.db.add(lobby)
        dev.db.commit()
        assert _refusal(_dev_block(dev, dev.h1, dev.mgr, level="area", levelId=lobby.id))[0] == 403
        assert _refusal(_dev_block(dev, dev.h1, dev.mgr, level="machine", levelId=dev.a1.id))[0] == 404
        assert _refusal(_dev_block(dev, dev.h1, dev.mgr, level="machine", levelId=dev.h2.id))[0] == 403, "not in its point of sale"

    def test_a_till_blocks_the_shop_for_the_kiosks_only(self, dev):
        out = _dev_block(dev, dev.h1, dev.mgr, level="shop", target="kiosks", kioskDisplay="hide")
        assert (out["block"]["level"], out["block"]["target"], out["block"]["kioskDisplay"]) == ("shop", "kiosks", "hide")
        assert (_sells(dev, dev.h1), _sells(dev, dev.h2)) == (True, False)

    def test_a_kiosk_blocks_for_kiosks_whatever_it_asks(self, dev):
        out = _dev_block(dev, dev.h2, dev.mgr, level="shop", target="all")
        assert (out["block"]["target"], out["block"]["origin"]) == ("kiosks", "kiosk")
        assert (_sells(dev, dev.h1), _sells(dev, dev.h2)) == (True, False)

    def test_a_controlling_till_blocks_on_its_kiosk(self, dev):
        device = dev.db.get(KioskDevice, dev.h2.id)
        device.controller_machine_ids = [str(dev.h1.id)]
        dev.db.commit()
        out = _dev_block(dev, dev.h1, dev.mgr, level="machine", kioskId=dev.h2.id)
        assert (out["block"]["level"], out["block"]["scopeId"], out["block"]["target"], out["block"]["origin"]) == (
            "machine", str(dev.h2.id), "kiosks", "controller",
        )
        assert (_sells(dev, dev.h1), _sells(dev, dev.h2)) == (True, False)
        device.controller_machine_ids = []
        dev.db.commit()
        with pytest.raises(HTTPException):
            R.device_blocks(str(dev.h1.id), kiosk_id=dev.h2.id, machine=dev.h1, db=dev.db)

    def test_now_blocked_for_the_point_of_sale_and_one_tap_unblock(self, dev):
        _block(dev, "company", dev.H.id)
        mine = _dev_block(dev, dev.h1, dev.mgr, productId=None, categoryId=dev.P.category_id)
        listed = R.device_blocks(str(dev.h1.id), kiosk_id=None, machine=dev.h1, db=dev.db)
        assert listed["context"]["areaName"] == "Bar" and listed["context"]["isKiosk"] is False
        by_level = {r["level"]: r for r in listed["blocks"]}
        assert by_level["company"]["removable"] is False and by_level["area"]["removable"] is True
        assert by_level["area"]["itemType"] == "category"
        refused = R.device_clear(
            str(dev.h1.id), uuid.UUID(by_level["company"]["id"]), pos_user_id=str(dev.mgr.id), machine=dev.h1, db=dev.db,
        )
        assert _refusal(refused) == (403, "not_from_here")
        cleared = R.device_clear(
            str(dev.h1.id), uuid.UUID(mine["block"]["id"]), pos_user_id=str(dev.mgr.id), machine=dev.h1, db=dev.db,
        )
        assert cleared["inForce"] is False and cleared["clearedBy"].startswith("h1")


class TestQuickHidesAreBlocks:
    def test_the_migration_copies_the_quick_hides_in_force_under_their_ids(self, b):
        import importlib.util

        from sqlalchemy import text

        from app.models.kiosk_live import KioskQuickHide

        if not b.db.get_bind().dialect.has_table(b.db.connection(), "kiosk_quick_hides"):
            Base.metadata.tables["kiosk_quick_hides"].create(b.db.get_bind())
        # Not resolve(): P: would turn into the long path the loader cannot open.
        path = pathlib.Path(__file__).parent.parent / "alembic" / "versions" / "c7d1a9e4f2b6_item_block_targets.py"
        spec = importlib.util.spec_from_file_location("ib_migration", path)
        mig = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mig)
        now = datetime.now(timezone.utc)

        def hide(kind, item, until=None, cleared=None):
            row = KioskQuickHide(
                id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.h_shop.id, kind=kind, item_id=item, until=until,
                cleared_at=cleared, note="הגריל סגור", created_by_name="dana",
                created_at=now - timedelta(minutes=5), updated_at=now - timedelta(minutes=5),
            )
            b.db.add(row)
            return row

        live = hide("product", b.P.id, until=now + timedelta(hours=2))
        cat = hide("category", b.P.category_id)
        hide("product", b.Q.id, until=now - timedelta(minutes=1))
        hide("product", b.Q.id, cleared=now - timedelta(minutes=1))
        older = SoldOutMark(
            id=uuid.uuid4(), tenant_id=b.tid, shop_id=b.h_shop.id, product_id=b.Q.id, scope="kiosks",
            scope_id=b.h_shop.id, kind="sold_out", source="manual", created_at=now, updated_at=now,
        )
        b.db.add(older)
        b.db.commit()
        b.db.execute(text(mig.BACKFILL_TARGET))
        b.db.execute(text(mig.COPY_HIDES))
        b.db.execute(text(mig.COPY_HIDES))  # idempotent
        b.db.commit()
        b.db.expire_all()
        copied = {m.id: m for m in b.db.query(SoldOutMark).filter(SoldOutMark.origin == "kiosk_hide").all()}
        assert set(copied) == {live.id, cat.id}, "only those in force, under their own ids"
        p = copied[live.id]
        assert (p.scope, p.scope_id, p.target, p.kind, p.kiosk_display, p.product_id, p.note) == (
            "shop", b.h_shop.id, "kiosks", "blocked", "hide", b.P.id, "הגריל סגור",
        )
        assert (copied[cat.id].category_id, copied[cat.id].product_id) == (b.P.category_id, None)
        assert b.db.get(SoldOutMark, older.id).target == "kiosks", "the older kiosks scope backfilled"
        assert b.db.query(KioskQuickHide).count() == 4, "the old rows stay as they were"
        assert (_sells(b, b.h1), _sells(b, b.h2)) == (True, False)
