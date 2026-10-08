"""
Till anomalies ("חריגות בקופות", app/services/insights/anomalies.py) — docs/SPEC_INSIGHTS.md §10.1.

What each class pins, and how it could look fine while being wrong:

* **Robust statistics** — the median and the MAD, not the mean: one busy till must not make
  every other till look weak; a widely spread group does not single out its lowest till.
* **The rules** — weak sales per open hour, an odd average ticket, an odd cash share or cash
  per document, each against the *other* tills of the same group and kind; small tills and
  small groups are never judged (`minDocs`, `minPeers`, `minOpenHours`).
* **The endpoint** — on the SQLite world: an empty period says nothing; shifts are the open
  hours; a till-level scope reads its shop and reports on itself; an event scope keeps to
  the event's tills and window; the thresholds come from the organization and the event.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.audit_exception import TillEvent
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.user import User, UserRole
from app.routers import insights as R
from app.services.insights import anomalies as AN
from app.services.insights import service as S
from app.services.report_events import rules as EVR
from shift_world import NOW, accept_str_uuids, make_world

JLM = ZoneInfo("Asia/Jerusalem")
UTC = timezone.utc
TODAY = date(2026, 9, 27)
TH = dict(AN.DEFAULT_THRESHOLDS)


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=JLM).astimezone(UTC)


# ═════════════════════════════════════════════════════════════════════════════
# Robust statistics
# ═════════════════════════════════════════════════════════════════════════════


class TestRobustStatistics:
    def test_median_and_mad(self):
        assert AN.median([5, 1, 3]) == 3
        assert AN.median([4, 1, 3, 2]) == 2.5
        assert AN.median([]) is None
        # |x − 3| for 1,2,3,4,100 = 2,1,0,1,97 → median 1: the outlier does not move it.
        assert AN.mad([1, 2, 3, 4, 100]) == 1

    def test_robust_z_is_none_without_a_spread(self):
        assert AN.robust_z(5, [10, 10, 10]) is None
        z = AN.robust_z(0, [100, 110, 90, 105])
        assert z is not None and z < -10

    def test_one_busy_till_does_not_make_the_others_look_weak(self):
        # A mean of 100, 110, 90 and 2000 is 575: every ordinary till would sit at under 20%
        # of it. Against the median (105) they are at home.
        tills = [ts("a", 100), ts("b", 110), ts("c", 90), ts("busy", 2000)]
        out = AN.evaluate(tills, TH)
        assert [c for c in out["cards"] if c["type"] == "till_low_sales"] == []


def ts(name, net_per_hour, *, hours=10.0, sales=30, group="shop", kiosk=False, **kw) -> AN.TillStats:
    """A till that took `net_per_hour` agorot an hour over `hours` hours, in `sales` sales."""
    net = int(round(net_per_hour * hours))
    base = dict(
        machine_id=name, name=name, group=group, group_name="Center", shop_id="s", shop_name="Center",
        kiosk=kiosk, docs=sales, sales=sales, net=net, gross=net, open_hours=hours, open_source="shifts",
        cash=net // 2, tendered=net, cash_docs=sales // 2,
    )
    base.update(kw)
    return AN.TillStats(**base)


def cards_of(out, type_):
    return {c["params"]["machineId"]: c for c in out["cards"] if c["type"] == type_}


# ═════════════════════════════════════════════════════════════════════════════
# The rules
# ═════════════════════════════════════════════════════════════════════════════


class TestLowSales:
    def test_a_till_far_under_its_peers_median_per_open_hour(self):
        tills = [ts("t1", 10_000), ts("t2", 11_000), ts("t3", 9_000), ts("quiet", 1_000, sales=3)]
        out = AN.evaluate(tills, TH)
        card = cards_of(out, "till_low_sales")["quiet"]
        assert card["severity"] == "critical"  # 10% of the median, under half the 35% threshold
        p = card["params"]
        assert p["metric"] in ("net", "documents")
        assert p["peers"] == 3 and p["openHours"] == 10.0
        assert p["peersNetPerHour"] == 10_000
        assert set(cards_of(out, "till_low_sales")) == {"quiet"}

    def test_a_till_that_was_open_and_sold_nothing_is_flagged(self):
        tills = [ts("t1", 10_000), ts("t2", 10_500), ts("idle", 0, sales=0, cash=0, tendered=0, cash_docs=0)]
        card = cards_of(AN.evaluate(tills, TH), "till_low_sales")["idle"]
        assert card["params"]["ratioPct"] == 0.0 and card["severity"] == "critical"

    def test_just_above_the_threshold_is_not_weak(self):
        tills = [ts("t1", 10_000), ts("t2", 10_000), ts("t3", 10_000), ts("ok", 3_600)]
        assert cards_of(AN.evaluate(tills, TH), "till_low_sales") == {}

    def test_a_widely_spread_group_does_not_single_out_its_lowest(self):
        # Four peers spread from 100 to 3000: 400 is 27% of the median (1,500) — under the
        # ratio — but its modified z-score is −0.8: nothing unusual in such a group.
        spread = [ts("a", 100), ts("b", 1_000), ts("c", 2_000), ts("d", 3_000), ts("low", 400)]
        assert "low" not in cards_of(AN.evaluate(spread, TH), "till_low_sales")
        tight = [ts("a", 1_000), ts("b", 1_050), ts("c", 1_100), ts("d", 950), ts("low", 300)]
        assert "low" in cards_of(AN.evaluate(tight, TH), "till_low_sales")

    def test_too_few_peers_or_a_short_opening_is_not_judged(self):
        assert cards_of(AN.evaluate([ts("t1", 10_000), ts("quiet", 100)], TH), "till_low_sales") == {}
        brief = [ts("t1", 10_000), ts("t2", 10_000), ts("brief", 100, hours=1.0)]
        assert cards_of(AN.evaluate(brief, TH), "till_low_sales") == {}
        # Peers with too few sales do not count as peers either.
        thin = [ts("t1", 10_000, sales=5), ts("t2", 10_000, sales=5), ts("quiet", 100)]
        assert cards_of(AN.evaluate(thin, TH), "till_low_sales") == {}

    def test_kiosks_are_compared_with_kiosks(self):
        tills = [ts("t1", 10_000), ts("t2", 10_000), ts("k1", 1_000, kiosk=True), ts("k2", 1_100, kiosk=True)]
        out = AN.evaluate(tills, TH)
        assert cards_of(out, "till_low_sales") == {}
        assert {(g["group"], g["kiosk"]) for g in out["groups"]} == {("shop", False), ("shop", True)}


class TestAverageTicket:
    def test_an_average_ticket_far_above_the_peers(self):
        # Ticket = net / sales: 5,000 for the peers, 15,000 for "big" (3×, ≥ 1.5² → critical).
        tills = [ts("t1", 15_000), ts("t2", 15_000), ts("t3", 15_000), ts("big", 15_000, sales=10, hours=10)]
        tills[-1].sales = 30
        tills[-1].net = tills[-1].gross = 450_000
        card = cards_of(AN.evaluate(tills, TH), "till_avg_ticket")["big"]
        assert card["params"]["direction"] == "high"
        assert card["params"]["value"] == 15_000 and card["params"]["median"] == 5_000
        assert card["severity"] == "critical"

    def test_a_low_ticket_and_the_small_sample_rule(self):
        tills = [ts("t1", 15_000), ts("t2", 15_000), ts("low", 15_000, sales=60)]
        card = cards_of(AN.evaluate(tills, TH), "till_avg_ticket")["low"]
        # Half the peers' ticket: under 1/1.5, not under 1/1.5².
        assert card["params"]["direction"] == "low" and card["severity"] == "warning"
        assert card["params"]["ratioPct"] == 50.0
        # Under `minDocs` sales the till is not judged at all.
        small = [ts("t1", 15_000), ts("t2", 15_000), ts("few", 15_000, sales=10)]
        small[-1].net = small[-1].gross = 15_000 * 10 * 3
        assert cards_of(AN.evaluate(small, TH), "till_avg_ticket") == {}


class TestCash:
    def test_a_cash_share_far_from_the_peers_with_the_evidence(self):
        tills = [ts(n, 10_000, cash=30_000, tendered=100_000, cash_docs=9) for n in ("t1", "t2", "t3")]
        odd = ts("odd", 10_000, cash=90_000, tendered=100_000, cash_docs=27, voids=7, no_sale_opens=5, refunds_count=4)
        card = cards_of(AN.evaluate(tills + [odd], TH), "till_cash")["odd"]
        p = card["params"]
        assert p["cashSharePct"] == 90.0 and p["peersCashSharePct"] == 30.0 and p["shareDiffPoints"] == 60.0
        assert p["shareFlag"]["direction"] == "high"
        assert p["evidence"]["voids"] == 7 and p["evidence"]["noSaleOpens"] == 5 and p["evidence"]["peersVoids"] == 0
        assert card["severity"] in ("warning", "critical")

    def test_cash_per_cash_document_far_from_the_peers(self):
        tills = [ts(n, 10_000, cash=30_000, tendered=100_000, cash_docs=15) for n in ("t1", "t2", "t3")]
        # The same share (30%) in fewer documents: 1.5× the cash per cash document — under 1.6×.
        odd = ts("odd", 10_000, cash=30_000, tendered=100_000, cash_docs=10)
        assert odd.cash_avg / (30_000 / 15) == 1.5
        assert "odd" not in cards_of(AN.evaluate(tills + [odd], TH), "till_cash")
        odd.cash = 40_000  # 4,000 a document: 2×; the share (40%) is only 10 points off
        card = cards_of(AN.evaluate(tills + [odd], TH), "till_cash")["odd"]
        assert card["params"]["avgFlag"]["direction"] == "high" and card["params"]["shareFlag"] is None
        # Too few cash documents (under max(5, minDocs / 2)) are not judged on their average.
        odd.cash_docs = 8
        odd.cash = 32_000
        assert "odd" not in cards_of(AN.evaluate(tills + [odd], TH), "till_cash")

    def test_a_normal_till_is_quiet(self):
        tills = [ts(n, 10_000, cash=30_000 + i * 2_000, tendered=100_000, cash_docs=10 + i) for i, n in enumerate("abcd")]
        out = AN.evaluate(tills, TH)
        assert out["cards"] == [] and out["counts"] == {"critical": 0, "warning": 0}


class TestThresholds:
    def test_layers_and_validation(self):
        th = AN.effective_thresholds({"lowSalesPct": 20}, {"lowSalesPct": 50, "minDocs": "x"})
        assert th["lowSalesPct"] == 50 and th["minDocs"] == AN.DEFAULT_THRESHOLDS["minDocs"]
        with pytest.raises(HTTPException) as bad:
            AN.clean_thresholds({"lowSalesPct": 0})
        assert bad.value.status_code == 422
        assert AN.clean_thresholds({"minPeers": 3.4, "nope": 1}) == {"minPeers": 3}

    def test_an_event_accepts_its_anomaly_keys_and_clears_them(self):
        th = EVR.normalize_thresholds({"weakTillPct": 50, "anomalyLowSalesPct": 25})
        assert th["anomalyLowSalesPct"] == 25 and th["weakTillPct"] == 50
        assert "anomalyLowSalesPct" not in EVR.normalize_thresholds({})
        assert "anomalyLowSalesPct" not in EVR.normalize_thresholds({**th, "anomalyLowSalesPct": None})
        with pytest.raises(HTTPException):
            EVR.normalize_thresholds({"anomalyLowSalesPct": 1000})
        assert AN.from_event(th) == {"lowSalesPct": 25}


# ═════════════════════════════════════════════════════════════════════════════
# The endpoint, on the SQLite world
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(S, "_now", lambda: NOW)
    db = world.db
    for n in (3, 4):
        m = POSMachine(
            id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
            name=f"Till {n}", machine_code=f"M-x{n}", pos_number=str(10 + n), is_active=True,
            pairing_status=PairingStatus.ASSIGNED, last_heartbeat_at=NOW,
        )
        db.add(m)
        world.tills.append(m)
    world.manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world.tenant.id, email="m@x",
                         username="manager", shop_id=world.shop.id)
    world.company_manager = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=world.tenant.id,
                                 email="cm@x", username="cm", company_id=world.company.id)
    db.add_all([world.manager, world.company_manager])
    db.commit()
    return world


def sale(w, till, when, total, *, cash=None, credit=False):
    """A document of `total` shekels at `when`; `cash` of it in cash, the rest by card."""
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=uuid.uuid4().hex[:12], status=TransactionStatus.COMPLETED,
        document_type=330 if credit else 320, payment_method="cash",
        total_amount=Decimal(str(total)), document_discount=Decimal("0"),
        created_at=when, updated_at=when, server_received_at=when,
    )
    w.db.add(tx)
    w.db.flush()
    cash_part = Decimal(str(total if cash is None else cash))
    legs = [("cash", cash_part)] if cash_part else []
    if Decimal(str(total)) - cash_part > 0:
        legs.append(("card", Decimal(str(total)) - cash_part))
    for i, (method, amount) in enumerate(legs, start=1):
        w.db.add(TransactionPayment(id=uuid.uuid4(), transaction_id=tx.id, sequence=i, method=method, amount=amount))
    w.db.flush()
    return tx


def trading_week(w, *, quiet=None, sales_per_day=6, quiet_sales=0):
    """Seven days to yesterday: each till a 4-hour shift a day and `sales_per_day` sales of ₪50."""
    for i in range(1, 8):
        day = TODAY - timedelta(days=i)
        for till in w.tills:
            w.shift(till, None, business_date=day, opened_at=at(day, 10))
            n = quiet_sales if till is quiet else sales_per_day
            for k in range(n):
                sale(w, till, at(day, 10, 5 + k * 5), 50, cash=20)
    w.db.commit()


def params(**kw):
    return R.InsightParams(**kw)


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


class TestEndpoint:
    def test_an_empty_period_says_nothing(self, w):
        out = R.get_till_anomalies(window="period", p=params(days=7, shop_id=w.shop.id), **ctx(w))
        assert out["cards"] == []
        (group,) = out["groups"]  # the shop's four tills, no sales
        assert {t["name"] for t in group["tills"]} == {"Till 1", "Till 2", "Till 3", "Till 4"}
        assert out["window"]["kind"] == "period" and out["thresholds"] == AN.DEFAULT_THRESHOLDS

    def test_a_quiet_till_by_its_shifts(self, w):
        quiet = w.tills[3]
        trading_week(w, quiet=quiet, quiet_sales=0)
        out = R.get_till_anomalies(window="period", p=params(days=7), **ctx(w))
        low = cards_of(out, "till_low_sales")
        assert set(low) == {str(quiet.id)}
        p = low[str(quiet.id)]["params"]
        assert p["openHours"] == 28.0 and p["openSource"] == "shifts" and p["peers"] == 3
        assert p["ratioPct"] == 0.0 and low[str(quiet.id)]["severity"] == "critical"
        # The feed shows it among its cards.
        feed = R.get_insights_feed(p=params(days=7), **ctx(w))
        assert any(c["type"] == "till_low_sales" for c in feed["cards"])
        # The other shop's till has no peers of its own: never judged.
        assert all(c["params"]["shopId"] == str(w.shop.id) for c in out["cards"])

    def test_today_window_and_a_till_scope(self, w):
        quiet = w.tills[3]
        trading_week(w, quiet=quiet)
        today = R.get_till_anomalies(window="today", p=params(days=7), **ctx(w))
        assert today["cards"] == [] and today["window"]["kind"] == "today"
        # Scoped to one ordinary till: its shop is read, its own cards only (none).
        own = R.get_till_anomalies(window="period", p=params(days=7, machine_id=w.tills[0].id), **ctx(w))
        assert own["cards"] == []
        mine = R.get_till_anomalies(window="period", p=params(days=7, machine_id=quiet.id), **ctx(w))
        assert [c["params"]["machineId"] for c in mine["cards"]] == [str(quiet.id)]

    def test_cash_and_its_evidence_from_the_documents_and_events(self, w):
        for i in range(1, 8):
            day = TODAY - timedelta(days=i)
            for till in w.tills:
                w.shift(till, None, business_date=day, opened_at=at(day, 10))
                for k in range(5):
                    cash = 50 if till is w.tills[2] else 10
                    sale(w, till, at(day, 10, 5 + k * 5), 50, cash=cash)
        for k in range(6):
            w.db.add(TillEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.tills[2].id, shop_id=w.shop.id,
                               event_type="drawer_open", occurred_at=at(TODAY - timedelta(days=2), 12, k)))
        w.db.commit()
        out = R.get_till_anomalies(window="period", p=params(days=7), **ctx(w))
        card = cards_of(out, "till_cash")[str(w.tills[2].id)]
        assert card["params"]["cashSharePct"] == 100.0 and card["params"]["peersCashSharePct"] == 20.0
        assert card["params"]["evidence"]["noSaleOpens"] == 6
        row = next(t for g in out["groups"] for t in g["tills"] if t["machineId"] == str(w.tills[2].id))
        assert row["flags"] == ["till_cash"] and row["cash"] == 7 * 5 * 5_000

    def test_a_distributor_compares_only_the_tills_they_placed(self, w):
        trading_week(w, quiet=w.tills[3])
        other = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=w.tenant.id, email="d@x", username="dist")
        w.db.add(other)
        w.db.commit()
        out = R.get_till_anomalies(window="period", p=params(days=7), **ctx(w, other))
        assert out["cards"] == []
        assert all(t["documents"] == 0 for g in out["groups"] for t in g["tills"])
        assert not any(t["machineId"] == str(w.tills[3].id) for g in out["groups"] for t in g["tills"])

    def test_the_organization_thresholds_and_who_sets_them(self, w):
        quiet = w.tills[3]
        trading_week(w, quiet=quiet, quiet_sales=1)  # 1 sale a day vs 6: 17%
        assert str(quiet.id) in cards_of(R.get_till_anomalies(window="period", p=params(days=7), **ctx(w)), "till_low_sales")
        with pytest.raises(HTTPException) as refused:
            R.put_anomaly_settings(thresholds={"lowSalesPct": 10}, **ctx(w, w.manager))
        assert refused.value.status_code == 403
        saved = R.put_anomaly_settings(thresholds={"lowSalesPct": 10}, **ctx(w, w.company_manager))
        assert saved["thresholds"]["lowSalesPct"] == 10 and saved["stored"] == {"lowSalesPct": 10}
        assert cards_of(R.get_till_anomalies(window="period", p=params(days=7), **ctx(w)), "till_low_sales") == {}
        assert R.get_anomaly_settings(**ctx(w, w.manager))["canEdit"] is False
        cleared = R.put_anomaly_settings(thresholds=None, **ctx(w))
        assert cleared["stored"] == {} and "insightAnomalies" not in (w.tenant.settings or {})


def event(w, tills, start, end, **kw):
    e = ReportEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                    name="פסטיבל", starts_at=start, ends_at=end, status="draft", **kw)
    w.db.add(e)
    w.db.flush()
    for t in tills:
        w.db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e.id, machine_id=t.id))
    w.db.commit()
    return e


class TestEventScope:
    def test_the_event_keeps_to_its_tills_and_its_window(self, w):
        day = TODAY - timedelta(days=2)
        members = w.tills[:3]
        e = event(w, members, at(day, 18), at(day, 23))
        for till in w.tills:
            w.shift(till, None, business_date=day, opened_at=at(day, 18))
            for k in range(25):
                sale(w, till, at(day, 18, k * 2), 40, cash=10)
        sale(w, members[0], at(day, 12), 999)  # before the event: not counted
        w.db.commit()
        out = R.get_till_anomalies(window="period", p=params(event_id=e.id), **ctx(w))
        (group,) = out["groups"]
        assert group["group"] == str(e.id) and group["name"] == "פסטיבל"
        assert {t["machineId"] for t in group["tills"]} == {str(t.id) for t in members}
        assert all(t["net"] == 25 * 4_000 for t in group["tills"])
        assert out["event"]["name"] == "פסטיבל" and out["period"]["from"] == day.isoformat()
        kpis = R.get_insights_kpis(p=params(event_id=e.id), **ctx(w))["kpis"]["current"]
        assert kpis["net"] == 3 * 25 * 4_000

    def test_the_event_thresholds_and_its_access(self, w):
        day = TODAY - timedelta(days=1)
        members = w.tills
        e = event(w, members, at(day, 10), at(day, 20), thresholds={"anomalyLowSalesPct": 5})
        for till in members:
            w.shift(till, None, business_date=day, opened_at=at(day, 10))
            for k in range(25 if till is not members[3] else 2):
                sale(w, till, at(day, 10, k * 2), 40)
        w.db.commit()
        out = R.get_till_anomalies(window="period", p=params(event_id=e.id), **ctx(w))
        assert out["thresholds"]["lowSalesPct"] == 5
        # 2 sales against 25 is 8%: above the event's own 5% — no card; at the default 35%, one.
        assert cards_of(out, "till_low_sales") == {}
        north = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="n@x",
                     username="north", shop_id=w.other_shop.id)
        w.db.add(north)
        w.db.commit()
        with pytest.raises(HTTPException) as refused:
            R.get_till_anomalies(window="period", p=params(event_id=e.id), **ctx(w, north))
        assert refused.value.status_code in (403, 404)

    def test_an_event_that_has_not_started_reads_nothing(self, w):
        e = event(w, w.tills[:2], NOW + timedelta(days=2), NOW + timedelta(days=2, hours=5))
        out = R.get_till_anomalies(window="period", p=params(event_id=e.id), **ctx(w))
        assert out["cards"] == [] and all(t["documents"] == 0 for g in out["groups"] for t in g["tills"])
