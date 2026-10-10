"""
The tables' state version, its tag, the per-shop snapshot and the coalesced signal
(app/services/tables_state.py; P:/specs/performance-review-2026-10.md #3).

What each class pins, and how it could look fine while doing damage:

* **Version** — every till write raises the shop's version once; a release that let go of
  nothing does not; another shop's never moves.
* **Tag** — a till sending back the tag it holds gets 304 / "unchanged" without the state
  being built; any write, another till's tag, the tag's age or a lock running out gives the
  full state again. A till sending nothing (every version before this) gets the full state.
* **Snapshot** — the tills of a shop share one build per version; each still gets its own
  view (its point of sale's zones, its own lock); the cached view equals the uncached one.
* **Signal** — the writes of a window become one message with the version, in one batch
  request: the shop channel and (legacy) every other till's channel; the sole writer is not
  woken by its own change; display devices are not woken at all.
* **Query counts** — what a poll costs, measured (the review's per-request figures).
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import event
from starlette.requests import Request
from starlette.responses import Response

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import tables as R
from app.schemas.tables import ReservationIn, TableCreate, TableEnterIn, TableReleaseIn, TableSaveIn, ZoneCreate
from app.services import ably_notify
from app.services import tables as T
from app.services import tables_state as TS
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world

SYNCED = "מסונכרן בין הקופות"


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now = self.now + timedelta(**kw)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    db = world.db
    TP.ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).all()}
    db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=params["tablesMode"].id, scope_type="shop", scope_id=world.shop.id, value=SYNCED,
    ))
    db.commit()
    world.clock = Clock()
    monkeypatch.setattr(T, "_now", world.clock)
    world.signals = []
    monkeypatch.setattr(TS, "NOTIFY_WINDOW_S", 0.0)
    monkeypatch.setattr(
        ably_notify, "publish_batch",
        lambda channels, event_, body: world.signals.append((list(channels), event_, dict(body))),
    )
    monkeypatch.setattr(TS, "SNAPSHOTS", TS.SnapshotCache())
    world.hall = T.create_zone(db, world.shop, ZoneCreate(shopId=world.shop.id, name="אולם", layout="map"))
    world.t = {n: T.create_table(db, world.hall, TableCreate(zoneId=world.hall.id, number=n)) for n in (1, 2, 3)}
    db.commit()
    world.a, world.b = world.tills
    return world


def request(tag=None):
    headers = [(b"if-none-match", f'"{tag}"'.encode())] if tag else []
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers, "query_string": b""})


def get(w, till, tag=None, since=None):
    response = Response()
    out = R.get_tables_state(str(till.id), since=since, machine=till, db=w.db, request=request(tag), response=response)
    return out, response


def enter(w, till, table):
    return R.enter_table(str(till.id), table.id, BackgroundTasks(), TableEnterIn(posUserId="pu", posUserName="דנה"),
                         machine=till, db=w.db)


def save(w, till, table, order_id, expected, action="save"):
    body = TableSaveIn(
        orderId=order_id, expectedVersion=expected, requestId=uuid.uuid4().hex, action=action, guests=2,
        cartJson=json.dumps({"cartId": "c", "lines": [{"id": "l1", "quantity": 1}]}), extrasJson=None,
        itemCount=1, total=Decimal("50"), posUserId="pu", posUserName="דנה",
    )
    return R.save_table(str(till.id), table.id, body, BackgroundTasks(), machine=till, db=w.db)


def release(w, till, table):
    return R.release_table(str(till.id), table.id, BackgroundTasks(), TableReleaseIn(), machine=till, db=w.db)


# ── Version ───────────────────────────────────────────────────────────────────


class TestVersion:
    def test_every_write_raises_the_shops_version_once(self, w):
        assert TS.current_version(w.db, w.shop.id) == 0
        out = enter(w, w.a, w.t[1])
        assert TS.current_version(w.db, w.shop.id) == 1
        save(w, w.a, w.t[1], str(uuid.uuid4()), None)
        assert TS.current_version(w.db, w.shop.id) == 2
        assert TS.current_version(w.db, w.other_shop.id) == 0
        assert out is not None

    def test_a_release_that_let_go_of_nothing_changes_nothing(self, w):
        assert release(w, w.b, w.t[2]) == {"released": False}
        assert TS.current_version(w.db, w.shop.id) == 0 and w.signals == []
        enter(w, w.a, w.t[2])
        assert release(w, w.a, w.t[2]) == {"released": True}
        assert TS.current_version(w.db, w.shop.id) == 2


# ── Tag ───────────────────────────────────────────────────────────────────────


class TestTag:
    def test_the_full_state_carries_its_version_and_tag(self, w):
        out, response = get(w, w.a)
        assert out["stateVersion"] == 0 and out["stateTag"].startswith("t0.")
        assert response.headers["etag"] == f'"{out["stateTag"]}"'
        assert len(out["tables"]) == 3

    def test_the_tag_sent_back_is_answered_304_without_a_build(self, w):
        out, _ = get(w, w.a)
        builds = TS.SNAPSHOTS.builds
        again, _ = get(w, w.a, tag=out["stateTag"])
        assert isinstance(again, Response) and again.status_code == 304
        assert again.headers["etag"] == f'"{out["stateTag"]}"'
        assert TS.SNAPSHOTS.builds == builds

    def test_since_answers_unchanged(self, w):
        out, _ = get(w, w.a)
        again, _ = get(w, w.a, since=out["stateTag"])
        assert again == {"syncType": "unchanged", "stateVersion": 0, "stateTag": out["stateTag"]}

    def test_a_write_makes_the_tag_stale(self, w):
        out, _ = get(w, w.b)
        enter(w, w.a, w.t[1])
        again, _ = get(w, w.b, tag=out["stateTag"])
        assert isinstance(again, dict) and again["stateVersion"] == 1
        row = next(t for t in again["tables"] if t["number"] == 1)
        assert row["state"] == "locked" and row["lock"]["mine"] is False

    def test_another_tills_tag_never_matches(self, w):
        out, _ = get(w, w.a)
        again, _ = get(w, w.b, tag=out["stateTag"])
        assert isinstance(again, dict) and "tables" in again

    def test_the_tag_ages_out(self, w):
        out, _ = get(w, w.a)
        w.clock.advance(seconds=TS.MAX_AGE.total_seconds() + 1)
        again, _ = get(w, w.a, tag=out["stateTag"])
        assert isinstance(again, dict) and "tables" in again

    def test_a_lock_running_out_ends_the_tag_first(self, w, monkeypatch):
        monkeypatch.setattr(TS, "MAX_AGE", timedelta(minutes=30))
        enter(w, w.a, w.t[1])  # a 2-minute lock
        out, _ = get(w, w.b)
        row = next(t for t in out["tables"] if t["number"] == 1)
        assert row["state"] == "locked"
        w.clock.advance(minutes=1)
        held, _ = get(w, w.b, tag=out["stateTag"])
        assert isinstance(held, Response) and held.status_code == 304
        w.clock.advance(minutes=2)
        again, _ = get(w, w.b, tag=out["stateTag"])
        row = next(t for t in again["tables"] if t["number"] == 1)
        assert row["state"] == "free" and row["lock"] is None

    def test_no_tag_is_the_full_state_as_always(self, w):
        first, _ = get(w, w.a)
        second, _ = get(w, w.a)
        assert first["tables"] == second["tables"] and "syncType" not in second

    def test_tags_parse_weak_quoted_and_lists(self):
        assert TS.parse_tags('W/"t1.2.ab", "t3.4.cd" , *') == ["t1.2.ab", "t3.4.cd"]
        assert TS.parse_tags(None) == [] and TS.parse_tags("") == []

    def test_a_malformed_tag_never_matches(self, w):
        for tag in ("", "x", "t1.2", "tX.1.2", "t0.notanumber.abc", "0.99999999999.x"):
            assert TS.tag_matches(tag, w.a, 0, NOW) is False


# ── Snapshot ──────────────────────────────────────────────────────────────────


class TestSnapshot:
    def test_the_tills_of_a_shop_share_one_build(self, w):
        get(w, w.a)
        get(w, w.b)
        assert TS.SNAPSHOTS.builds == 1 and TS.SNAPSHOTS.hits == 1
        enter(w, w.a, w.t[1])
        get(w, w.b)
        get(w, w.a)
        assert TS.SNAPSHOTS.builds == 2

    def test_each_till_still_gets_its_own_view(self, w):
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.db.flush()
        w.b.area_id = bar.id
        zone = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=bar.id, name="בר"))
        T.create_table(w.db, zone, TableCreate(zoneId=zone.id, number=50))
        w.db.commit()
        enter(w, w.a, w.t[1])
        a, _ = get(w, w.a)
        b, _ = get(w, w.b)
        assert TS.SNAPSHOTS.builds == 1
        assert {t["number"] for t in a["tables"]} == {1, 2, 3}
        assert {t["number"] for t in b["tables"]} == {1, 2, 3, 50}
        assert (len(a["zones"]), len(b["zones"])) == (1, 2)
        mine = next(t for t in a["tables"] if t["number"] == 1)
        theirs = next(t for t in b["tables"] if t["number"] == 1)
        assert (mine["lock"]["mine"], mine["state"]) == (True, "free")
        assert (theirs["lock"]["mine"], theirs["state"]) == (False, "locked")

    def test_the_cached_view_is_the_uncached_one(self, w):
        enter(w, w.a, w.t[1])
        save(w, w.a, w.t[1], str(uuid.uuid4()), None, action="send")
        enter(w, w.b, w.t[2])
        for table_id, hours in ((w.t[3].id, 3), (None, 5), (w.t[1].id, 40)):  # the last: past the window
            T.create_reservation(w.db, w.shop, ReservationIn(
                tableId=table_id, reservedAt=NOW + timedelta(hours=hours), customerName="כהן", guests=4,
            ), by_name="דנה")
        w.db.commit()
        for till in (w.a, w.b):
            version = TS.current_version(w.db, w.shop.id)
            cached, _ = T.till_state_cached(w.db, till, version=version, now=NOW)
            fresh = T.till_state(w.db, till, now=NOW)
            assert cached == fresh
            assert len(cached["reservations"]) == 2


# ── Signal ────────────────────────────────────────────────────────────────────


class TestSignal:
    def test_one_message_for_the_shop_with_the_version(self, w):
        enter(w, w.a, w.t[1])
        assert len(w.signals) == 1
        channels, name, body = w.signals[0]
        assert name == "tables" and body["version"] == 1 and body["tableId"] == str(w.t[1].id)
        assert body["shopId"] == str(w.shop.id)
        assert channels[0] == f"pos:{w.tenant.id}:shop:{w.shop.id}"
        # Legacy: every other till of the shop on its own channel, in the same request.
        assert f"pos:{w.tenant.id}:{w.b.id}" in channels
        assert f"pos:{w.tenant.id}:{w.a.id}" not in channels
        assert all(str(w.other_till.id) not in c for c in channels)

    def test_writes_within_the_window_become_one_message(self, w):
        sent = []
        notifier = TS.TablesNotifier(publish=lambda channels, body: sent.append((channels, body)))
        targets = [(str(w.tenant.id), str(w.a.id)), (str(w.tenant.id), str(w.b.id))]
        for version, table, origin in ((3, "t1", w.a.id), (4, "t2", w.a.id), (5, "t1", w.b.id)):
            notifier.changed(tenant_id=w.tenant.id, shop_id=w.shop.id, version=version, table_id=table,
                             origin=str(origin), targets=targets, window=60.0)
        assert sent == []
        notifier.flush()
        assert len(sent) == 1
        channels, body = sent[0]
        assert body["version"] == 5 and body["tableIds"] == ["t1", "t2"] and "tableId" not in body
        # Two tills wrote: both are woken (each missed the other's change).
        assert f"pos:{w.tenant.id}:{w.a.id}" in channels and f"pos:{w.tenant.id}:{w.b.id}" in channels

    def test_the_window_sends_by_itself(self, w):
        import threading

        done = threading.Event()
        sent = []

        def publish(channels, body):
            sent.append(body)
            done.set()

        notifier = TS.TablesNotifier(publish=publish)
        notifier.changed(tenant_id=w.tenant.id, shop_id=w.shop.id, version=7, window=0.05)
        assert done.wait(5) and sent[0]["version"] == 7

    def test_the_sole_writer_is_not_woken_on_its_own_channel(self, w):
        channels = TS.channels_for(
            str(w.tenant.id), str(w.shop.id), [(str(w.tenant.id), str(w.a.id)), (str(w.tenant.id), str(w.b.id))],
            origins={str(w.a.id)},
        )
        assert channels == [f"pos:{w.tenant.id}:shop:{w.shop.id}", f"pos:{w.tenant.id}:{w.b.id}"]

    def test_without_legacy_channels_only_the_shop_channel(self, w):
        channels = TS.channels_for(
            str(w.tenant.id), str(w.shop.id), [(str(w.tenant.id), str(w.b.id))], device_channels=False,
        )
        assert channels == [f"pos:{w.tenant.id}:shop:{w.shop.id}"]

    def test_a_display_device_is_never_woken(self, w):
        w.b.is_fiscal = False
        w.db.commit()
        assert (str(w.tenant.id), str(w.b.id)) not in T.notify_targets(w.db, w.shop.id)

    def test_a_dashboard_layout_change_wakes_every_till(self, w):
        tasks = BackgroundTasks()
        R._wake_shop(tasks, w.db, w.shop.id)
        channels, _, body = w.signals[-1]
        assert f"pos:{w.tenant.id}:{w.a.id}" in channels and f"pos:{w.tenant.id}:{w.b.id}" in channels
        assert body["version"] == 1


# ── Ably ──────────────────────────────────────────────────────────────────────


class _Response:
    def __init__(self, ok=True):
        self.success, self.status_code, self.error_code, self.error_message = ok, 201 if ok else 500, None, None


class _Client:
    def __init__(self, ok=True):
        self.requests, self.published, self.ok = [], [], ok
        client = self

        class _Channel:
            def __init__(self, name):
                self.name = name

            def publish(self, name, data):
                client.published.append((self.name, name, data))

        class _Channels:
            def get(self, name):
                return _Channel(name)

        self.channels = _Channels()

    def request(self, method, path, version, body=None, **kw):
        self.requests.append((method, path, body))
        return _Response(self.ok)


class TestAblyBatch:
    def test_one_request_for_every_channel(self, monkeypatch):
        client = _Client()
        monkeypatch.setattr(ably_notify, "_rest", lambda: client)
        ably_notify.publish_batch(["a", "b", "c"], "tables", {"version": 3})
        assert len(client.requests) == 1
        method, path, body = client.requests[0]
        assert (method, path, body["channels"]) == ("POST", "/messages", ["a", "b", "c"])
        message = body["messages"][0]
        assert message["name"] == "tables" and json.loads(message["data"]) == {"version": 3}
        assert message["encoding"] == "json" and client.published == []

    def test_a_failed_batch_falls_back_to_one_publish_per_channel(self, monkeypatch):
        client = _Client(ok=False)
        monkeypatch.setattr(ably_notify, "_rest", lambda: client)
        ably_notify.publish_batch(["a", "b"], "tables", {"version": 3})
        assert [c for c, _, _ in client.published] == ["a", "b"]

    def test_more_than_a_batch_is_split(self, monkeypatch):
        client = _Client()
        monkeypatch.setattr(ably_notify, "_rest", lambda: client)
        ably_notify.publish_batch([f"c{i}" for i in range(150)], "tables", {})
        assert [len(b["channels"]) for _, _, b in client.requests] == [100, 50]

    def test_the_token_lets_a_till_listen_on_its_shops_channel(self, monkeypatch, w):
        captured = {}

        class _Auth:
            def create_token_request(self, params):
                captured.update(params)

                class _T:
                    def to_dict(self):
                        return {}
                return _T()

        client = _Client()
        client.auth = _Auth()
        monkeypatch.setattr(ably_notify, "_rest", lambda: client)
        ably_notify.create_token_request_for_machine(w.a)
        assert captured["capability"] == {
            f"pos:{w.tenant.id}:{w.a.id}": ["subscribe", "history"],
            f"pos:{w.tenant.id}:shop:{w.shop.id}": ["subscribe", "history"],
        }

    def test_the_connection_info_names_the_shop_channel(self, w):
        from app.services.realtime_info import machine_realtime_connection_info, machine_realtime_refresh_info

        info = machine_realtime_connection_info(machine=w.a, access_token="x")
        assert info["realtimeShopChannel"] == f"pos:{w.tenant.id}:shop:{w.shop.id}"
        assert machine_realtime_refresh_info(machine=w.a)["realtimeShopChannel"] == info["realtimeShopChannel"]


# ── Query counts ──────────────────────────────────────────────────────────────


class TestQueryCounts:
    """
    What one `GET /sync/{m}/tables` costs in SQL statements (the machine already loaded by
    its token, as in production), on a floor of 3 tables with one open order and a lock.
    """

    def _count(self, w, fn):
        statements = []
        engine = w.db.get_bind()

        def before(conn, cursor, statement, *args):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", before)
        try:
            fn()
        finally:
            event.remove(engine, "before_cursor_execute", before)
        return len(statements)

    def test_a_poll_costs_far_less_than_a_build(self, w, capsys):
        enter(w, w.a, w.t[1])
        save(w, w.a, w.t[1], str(uuid.uuid4()), None, action="send")

        def fresh(till):
            # A new request: nothing in the session but the machine its token loaded.
            w.db.expire_all()
            w.db.refresh(till)

        fresh(w.b)
        uncached = self._count(w, lambda: T.till_state(w.db, w.b))
        fresh(w.b)
        cold = self._count(w, lambda: get(w, w.b))
        tag = get(w, w.a)[0]["stateTag"]
        fresh(w.b)
        warm = self._count(w, lambda: get(w, w.b))
        fresh(w.a)
        unchanged = self._count(w, lambda: get(w, w.a, tag=tag))
        with capsys.disabled():
            print(f"\n[tables GET statements] before (every poll built): {uncached}; "
                  f"cold snapshot: {cold}; snapshot shared: {warm}; 304 unchanged: {unchanged}")
        assert unchanged == 1
        assert warm < uncached
        assert cold <= uncached + 2
