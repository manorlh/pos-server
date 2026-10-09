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
from datetime import datetime, timedelta, timezone
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
GOLDEN_SHA256 = "164f2d9558d33584b3e6c52364e5f678c4760d83ffc91e5040bad2c584caf230"

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
    got = rules.decide(
        case["blocks"], rules.parse_time(case["now"]), till=till, setting=case["setting"],
        track_stock=case["trackStock"], stock=case["stock"],
    )
    expect = case["expect"]
    assert got.state == expect["state"]
    assert got.reason == expect["reason"]
    assert (got.block or {}).get("id") == expect["block"]
    assert got.overridable is expect["overridable"]


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
        assert D.compute_end("end_of_day", NOW, zone_name="Asia/Jerusalem").until == datetime(
            2026, 10, 10, 2, 0, tzinfo=timezone.utc
        ), "05:00 tomorrow"
        night = datetime(2026, 10, 9, 23, 30, tzinfo=timezone.utc)  # 02:30 local on the 10th
        assert D.compute_end("end_of_day", night, zone_name="Asia/Jerusalem").until == datetime(
            2026, 10, 10, 2, 0, tzinfo=timezone.utc
        ), "a bar's night ends with the same morning"
        assert D.compute_end("end_of_day", NOW, zone_name="Asia/Jerusalem", day_start="04:00").until == datetime(
            2026, 10, 10, 1, 0, tzinfo=timezone.utc
        )

    def test_daylight_saving_ends_overnight(self):
        # Israel leaves summer time on 25.10.2026 at 02:00 (back to 01:00): +03:00 → +02:00.
        evening = datetime(2026, 10, 24, 19, 0, tzinfo=timezone.utc)  # 22:00 local, summer time
        assert D.compute_end("end_of_day", evening, zone_name="Asia/Jerusalem").until == datetime(
            2026, 10, 25, 3, 0, tzinfo=timezone.utc
        ), "05:00 winter time"
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

    def test_a_group_cannot_be_chosen_while_groups_are_not_in_this_base(self, b):
        with pytest.raises(HTTPException) as refused:
            svc.resolve_target(b.db, "group", uuid.uuid4(), b.tid)
        assert refused.value.detail["code"] == "groups_unavailable"


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
        assert out["groupsAvailable"] is False and out["businessDayStart"] == "05:00"


def test_the_migrations_chain_on_one_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert len(script.get_heads()) == 1
    assert script.get_revision("8d5f3b0e2a74").down_revision == "6b1e9d4f2a87"
    assert script.get_revision("9e6a4c1f3b85").down_revision == "8d5f3b0e2a74"
