"""
"מצב סנכרון של מכשיר" (P:/specs/device-sync-status.md §5): the contract between the till and the
cloud, and the cloud's side of it.

* **Versions** (app/services/sync_versions.py): every pull says `X-Sync-Version: <key>=<version>`,
  the same value the dashboard computes for the comparison — catalog, menu and vouchers from one
  pull; parameters, the till design and the customer display by their ETags; settings and users by
  their watermarks; the tables by the floor plan only (never an order or a lock); promotions by
  their etag; media by the files.
* **The report** (app/services/sync_status.py): `syncState` / `outbox` on the heartbeat and on
  `POST /sync/{m}/sync-state`, cleaned value by value, replaced whole, never a refused beat.
* **The comparison**: up to date / pending (what changed and when) / error, a domain of several
  keys the worst of them; stale — online and not up to date for longer than `syncStaleMinutes` —
  an item on "בעיות".
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.shop_product_override import ShopProductOverride
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.voucher import Voucher
from app.routers import machines as MR
from app.routers import sync as SR
from app.routers import sync_status as SSR
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.tables import TableCreate, ZoneCreate
from app.services import ably_notify
from app.services import problems as PB
from app.services import sync_status as S
from app.services import sync_versions as V
from app.services import tables as T
from app.services import tables_state as TS
from app.services import till_parameters as TP
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world


def request(etag=None):
    headers = [(b"if-none-match", etag.encode())] if etag else []
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers, "query_string": b""})


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    db = world.db
    for name in dir(ably_notify):
        if name.startswith("publish"):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    monkeypatch.setattr(TS, "NOTIFY_WINDOW_S", 0.0)
    # The general item's SKU uses a Postgres regex (tests/test_menu.py does the same).
    monkeypatch.setattr(SR, "_ensure_shop_general_item", lambda *_a: None)
    TP.ensure_builtin_parameters(db)
    world.params = {p.key: p for p in db.query(TillParameter).all()}
    # Every row's stamp before NOW (the world's clock): a later edit is then the newest.
    world.cat = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Drinks", updated_at=NOW - timedelta(hours=5))
    db.add(world.cat)
    db.flush()
    world.cola = Product(
        id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, category_id=world.cat.id,
        catalog_level=CatalogLevel.GLOBAL, name="cola", price=Decimal("10"), sku="cola", is_available=True,
        updated_at=NOW - timedelta(hours=5),
    )
    db.add(world.cola)
    db.flush()
    db.add(ShopProductOverride(
        id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=world.cola.id, is_listed=True,
        updated_at=NOW - timedelta(hours=5),
    ))
    db.commit()
    world.a, world.b = world.tills
    V.clear_tables_cache()
    yield world
    V.clear_tables_cache()
    db.close()


def set_param(w, key, scope_type, scope_id, value):
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=w.params[key].id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.commit()


def report(w, till, keys, *, outbox=None):
    """The till's heartbeat with `syncState` (and `outbox`)."""
    body = {"syncState": keys}
    if outbox is not None:
        body["outbox"] = outbox
    MR.post_my_heartbeat(MachineHeartbeatBody.model_validate(body), machine=till, db=w.db)


def current(w, till):
    return {k: v.version for k, v in V.all_versions(w.db, till).items() if v is not None}


def holding_everything(w, till, *, pulled=NOW - timedelta(minutes=1)):
    """A report of a till that holds the cloud's current version of every key."""
    return {k: {"version": v, "pulledAt": pulled.isoformat(), "ok": True} for k, v in current(w, till).items()}


def evaluate(w, till, now=NOW, stale_minutes=None):
    return S.evaluate(V.VersionContext(w.db), till, now=now, stale_minutes=stale_minutes)


def domain(result, name):
    return next(d for d in result["domains"] if d["domain"] == name)


# ═════════════════════════════════════════════════════════════════════════════
# The contract
# ═════════════════════════════════════════════════════════════════════════════


class TestContract:
    def test_the_domains_are_the_specs_nine_and_every_key_has_one(self):
        assert [d for d, _, _ in V.DOMAINS] == [
            "catalog", "parameters", "settings", "users", "tables", "menu", "promotions", "vouchers", "media",
        ]
        assert set(V.DOMAIN_OF_KEY) == set(V.KEYS)
        assert V.DOMAIN_OF_KEY["settings.design"] == V.DOMAIN_OF_KEY["settings.display"] == "settings"

    def test_the_header_lists_keys_in_order_and_reads_back(self):
        value = V.header_value({"vouchers": "v3", "catalog": V.CloudVersion("c1"), "menu": '"m2"'})
        assert value == "catalog=c1, menu=m2, vouchers=v3"
        assert V.parse_header(value) == {"catalog": "c1", "menu": "m2", "vouchers": "v3"}
        # A timestamp's colons and plus sign survive the round trip.
        stamp = V.stamp(datetime(2026, 10, 14, 10, 42, tzinfo=timezone.utc))
        assert stamp == "2026-10-14T10:42:00+00:00"
        assert V.parse_header(V.header_value({"settings": stamp})) == {"settings": stamp}

    def test_a_stamp_is_utc_whatever_zone_it_was_read_in(self):
        from zoneinfo import ZoneInfo

        local = datetime(2026, 10, 14, 13, 42, tzinfo=ZoneInfo("Asia/Jerusalem"))
        assert V.stamp(local) == "2026-10-14T10:42:00+00:00"
        assert V.stamp(datetime(2026, 10, 14, 10, 42)) == "2026-10-14T10:42:00+00:00"
        assert V.stamp(None) == V.NONE

    def test_versions_compare_without_quotes_or_weak_prefix(self):
        assert V.normalize(' W/"abc" ') == V.normalize('"abc"') == V.normalize("abc") == "abc"


# ═════════════════════════════════════════════════════════════════════════════
# Each pull says its version — the one the dashboard compares with
# ═════════════════════════════════════════════════════════════════════════════


class TestHeaders:
    def test_the_catalog_pull_carries_catalog_menu_and_vouchers(self, w):
        response = Response()
        SR.get_catalog_sync(str(w.a.id), since=None, machine=w.a, db=w.db, response=response)
        said = V.parse_header(response.headers[V.HEADER])
        assert set(said) == {"catalog", "menu", "vouchers"}
        now = current(w, w.a)
        assert said == {k: now[k] for k in said}
        # A delta pull says the version of everything, not of the delta.
        delta = Response()
        SR.get_catalog_sync(str(w.a.id), since=NOW.isoformat(), machine=w.a, db=w.db, response=delta)
        assert V.parse_header(delta.headers[V.HEADER]) == said

    def test_the_catalog_version_moves_with_a_price_and_names_when(self, w):
        before = current(w, w.a)["catalog"]
        w.cola.price = Decimal("12")
        w.cola.updated_at = NOW - timedelta(minutes=20)
        w.db.commit()
        after = V.all_versions(w.db, w.a)["catalog"]
        assert after.version != before
        assert after.changed_at == NOW - timedelta(minutes=20)
        # A voucher definition is its own key, not the catalog's.
        w.db.add(Voucher(id=uuid.uuid4(), tenant_id=w.tenant.id, name="10%", updated_at=NOW - timedelta(minutes=5)))
        w.db.commit()
        again = current(w, w.a)
        assert again["catalog"] == after.version and again["vouchers"] == V.stamp(NOW - timedelta(minutes=5))

    def test_settings_users_and_promotions(self, w):
        for call, key in (
            (lambda r: SR.get_settings_sync(str(w.a.id), since=None, machine=w.a, db=w.db, response=r), "settings"),
            (lambda r: SR.get_pos_users_sync(str(w.a.id), since=None, machine=w.a, db=w.db, response=r), "users"),
        ):
            response = Response()
            call(response)
            assert V.parse_header(response.headers[V.HEADER]) == {key: current(w, w.a)[key]}
        # An unchanged settings answer says it too.
        response = Response()
        out = SR.get_settings_sync(str(w.a.id), since=(NOW + timedelta(days=3650)).isoformat(), machine=w.a, db=w.db, response=response)
        assert out.sync_type == "unchanged"
        assert V.parse_header(response.headers[V.HEADER]) == {"settings": current(w, w.a)["settings"]}

        from app.routers.promotions import get_own_promotions

        response = Response()
        out = get_own_promotions(str(w.a.id), etag=None, machine=w.a, db=w.db, response=response)
        assert V.parse_header(response.headers[V.HEADER]) == {"promotions": out["etag"]} == {"promotions": current(w, w.a)["promotions"]}

    def test_the_etag_pulls_say_it_on_a_304_too(self, w):
        from app.routers.customer_display import get_device_config
        from app.routers.till_design import get_till_design_sync

        pulls = (
            (lambda req: SR.get_till_parameters_sync(str(w.a.id), machine=w.a, request=req, db=w.db), {"parameters"}),
            (lambda req: get_till_design_sync(str(w.a.id), req, machine=w.a, db=w.db), {"settings.design"}),
            (lambda req: get_device_config(str(w.a.id), req, machine=w.a, db=w.db), {"settings.display", "media"}),
        )
        now = current(w, w.a)
        for pull, keys in pulls:
            full = pull(request())
            said = V.parse_header(full.headers[V.HEADER])
            assert set(said) == keys and said == {k: now[k] for k in keys}
            again = pull(request(full.headers["ETag"]))
            assert again.status_code == 304
            assert V.parse_header(again.headers[V.HEADER]) == said
        # The parameters' version is their ETag, bare.
        assert now["parameters"] == V.normalize(pulls[0][0](request()).headers["ETag"])


class TestTables:
    @pytest.fixture
    def floor(self, w):
        set_param(w, "tablesMode", "shop", w.shop.id, "מסונכרן (ענן)")
        w.hall = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, name="אולם", layout="map"))
        w.t = {n: T.create_table(w.db, w.hall, TableCreate(zoneId=w.hall.id, number=n)) for n in (1, 2)}
        w.db.commit()
        TS.bump(w.db, w.shop.id)
        w.db.commit()
        return w

    def get(self, w, since=None, etag=None):
        from app.routers import tables as TR

        response = Response()
        out = TR.get_tables_state(str(w.a.id), since=since, machine=w.a, db=w.db, request=request(etag), response=response)
        headers = out.headers if isinstance(out, Response) and not isinstance(out, dict) else response.headers
        return out, headers

    def test_every_answer_says_the_floor_plan_version(self, floor):
        w = floor
        out, headers = self.get(w)
        said = V.parse_header(headers[V.HEADER])
        assert said == {"tables": current(w, w.a)["tables"]} and said["tables"] != V.NONE
        unchanged, headers = self.get(w, since=out["stateTag"])
        assert unchanged["syncType"] == "unchanged" and V.parse_header(headers[V.HEADER]) == said
        not_modified, headers = self.get(w, etag=f'"{out["stateTag"]}"')
        assert not_modified.status_code == 304 and V.parse_header(headers[V.HEADER]) == said

    def test_orders_and_locks_do_not_move_it_a_layout_edit_does(self, floor):
        w = floor
        before = current(w, w.a)["tables"]
        table = w.t[1]
        table.lock_machine_id = w.a.id
        table.lock_expires_at = NOW + timedelta(minutes=5)
        table.cleaning_since = NOW
        w.db.commit()
        TS.bump(w.db, w.shop.id)
        w.db.commit()
        assert current(w, w.a)["tables"] == before
        table.x = 250.0
        w.db.commit()
        TS.bump(w.db, w.shop.id)
        w.db.commit()
        assert current(w, w.a)["tables"] != before


# ═════════════════════════════════════════════════════════════════════════════
# The report: stored cleaned, replaced whole, never a refused beat
# ═════════════════════════════════════════════════════════════════════════════


class TestReport:
    def test_the_heartbeat_stores_what_it_can_read(self, w):
        report(w, w.a, {
            "catalog": {"version": "2026-10-14T10:42:00+00:00", "pulledAt": "2026-10-14T10:42:05Z", "ok": True},
            "parameters": {"version": '"abc"', "pulledAt": "not a date", "ok": False, "error": "x" * 900},
            "printers": {"version": "1", "ok": True},  # not a key of the contract
            "users": "not an object",
            "media": {"version": {"nested": True}, "ok": "yes"},
        }, outbox={"documents": 3, "events": -1, "attendance": "2", "refunds": 1.0, "oldestAt": "2026-10-14T10:31:00Z"})
        keys, at = S.reported(w.a)
        assert set(keys) == {"catalog", "parameters", "media"}
        assert keys["catalog"] == {
            "version": "2026-10-14T10:42:00+00:00", "pulledAt": "2026-10-14T10:42:05+00:00", "ok": True,
            "error": None, "errorSince": None,
        }
        assert keys["parameters"]["version"] == "abc" and keys["parameters"]["pulledAt"] is None
        assert keys["parameters"]["ok"] is False and len(keys["parameters"]["error"]) == S.ERROR_MAX
        assert keys["media"]["version"] is None and keys["media"]["ok"] is True
        assert at is not None
        box = S.outbox_out(w.a)
        assert (box["documents"], box["events"], box["attendance"], box["refunds"], box["total"]) == (3, 0, 0, 1, 4)
        assert box["oldestAt"] == "2026-10-14T10:31:00+00:00"

    def test_a_block_that_is_not_an_object_never_fails_the_beat_and_changes_nothing(self, w):
        report(w, w.a, {"catalog": {"version": "c1", "ok": True}})
        for junk in ("x", 5, ["catalog"], None):
            out = MR.post_my_heartbeat(
                MachineHeartbeatBody.model_validate({"syncState": junk, "outbox": junk}), machine=w.a, db=w.db,
            )
            assert out["ok"] is True
        assert S.reported(w.a)[0]["catalog"]["version"] == "c1"
        # A beat without the fields (an older build) leaves the report as it was.
        MR.post_my_heartbeat(MachineHeartbeatBody.model_validate({}), machine=w.a, db=w.db)
        assert S.reported(w.a)[0]["catalog"]["version"] == "c1"

    def test_the_block_is_replaced_whole_and_other_device_info_kept(self, w):
        w.a.device_info = {"model": "N55F"}
        w.db.commit()
        report(w, w.a, {"catalog": {"version": "c1", "ok": True}, "users": {"version": "u1", "ok": True}})
        report(w, w.a, {"catalog": {"version": "c2", "ok": True}})
        assert set(S.reported(w.a)[0]) == {"catalog"}
        assert w.a.device_info["model"] == "N55F"
        # The machines list shows device_info without the report (it has its own read).
        assert MR._device_info_out(w.a.device_info) == {"model": "N55F"}

    def test_the_after_sync_post_stores_the_same(self, w):
        out = SSR.post_sync_state(str(w.a.id), body={"syncState": {"menu": {"version": "m1", "ok": True}}}, machine=w.a, db=w.db)
        assert out["ok"] is True
        assert S.reported(w.a)[0]["menu"]["version"] == "m1"
        assert SSR.post_sync_state(str(w.a.id), body="junk", machine=w.a, db=w.db)["ok"] is True
        assert S.reported(w.a)[0]["menu"]["version"] == "m1"


# ═════════════════════════════════════════════════════════════════════════════
# The comparison
# ═════════════════════════════════════════════════════════════════════════════


class TestComparison:
    def test_a_device_holding_the_current_versions_is_up_to_date(self, w):
        report(w, w.a, holding_everything(w, w.a))
        out = evaluate(w, w.a)
        assert out["reported"] is True and out["status"] == S.UP_TO_DATE
        assert {d["domain"] for d in out["domains"]} == {d for d, _, _ in V.DOMAINS}
        assert all(d["status"] == S.UP_TO_DATE for d in out["domains"])
        assert out["pendingCount"] == out["errorCount"] == 0 and out["stale"] is False

    def test_a_price_changed_in_the_cloud_is_pending_with_when_then_received(self, w):
        report(w, w.a, holding_everything(w, w.a))
        w.cola.price = Decimal("12")
        w.cola.updated_at = NOW - timedelta(seconds=30)
        w.db.commit()
        out = evaluate(w, w.a)
        catalog = domain(out, "catalog")
        assert out["status"] == S.PENDING and out["pendingCount"] == 1
        assert catalog["status"] == S.PENDING
        assert catalog["changedAt"] == (NOW - timedelta(seconds=30)).isoformat()
        assert catalog["pendingSince"] == (NOW - timedelta(seconds=30)).isoformat()
        # "סנכרן עכשיו": the till pulls, says the new version — everything received.
        report(w, w.a, holding_everything(w, w.a, pulled=NOW))
        assert evaluate(w, w.a)["status"] == S.UP_TO_DATE

    def test_an_error_wins_and_settings_takes_the_worst_of_its_three(self, w):
        keys = holding_everything(w, w.a)
        keys["settings.design"] = {**keys["settings.design"], "version": "older"}
        keys["users"] = {**keys["users"], "ok": False, "error": "HTTP 500", "errorSince": (NOW - timedelta(minutes=3)).isoformat()}
        report(w, w.a, keys)
        out = evaluate(w, w.a)
        settings = domain(out, "settings")
        assert settings["status"] == S.PENDING
        assert {k["key"]: k["status"] for k in settings["keys"]} == {
            "settings": S.UP_TO_DATE, "settings.design": S.PENDING, "settings.display": S.UP_TO_DATE,
        }
        users = domain(out, "users")
        assert users["status"] == S.ERROR and users["error"] == "HTTP 500"
        assert users["pendingSince"] == (NOW - timedelta(minutes=3)).isoformat()
        assert out["status"] == S.ERROR and out["errorCount"] == 1 and out["pendingCount"] == 1

    def test_only_what_the_device_reports_is_compared(self, w):
        assert evaluate(w, w.a)["status"] == S.NOT_REPORTED
        report(w, w.a, {"catalog": holding_everything(w, w.a)["catalog"]})
        out = evaluate(w, w.a)
        assert [d["domain"] for d in out["domains"]] == ["catalog"] and out["status"] == S.UP_TO_DATE

    def test_a_key_the_cloud_cannot_read_is_unknown_never_a_failure(self, w, monkeypatch):
        report(w, w.a, holding_everything(w, w.a))

        def broken(*a, **k):
            raise RuntimeError("db hiccup")

        monkeypatch.setattr(V, "promotions_version", broken)
        out = evaluate(w, w.a)
        assert domain(out, "promotions")["status"] == S.UNKNOWN
        assert out["status"] == S.UP_TO_DATE

    def test_the_dashboard_reads_one_and_many_in_its_scope(self, w):
        report(w, w.a, holding_everything(w, w.a))
        one = SSR.get_sync_status(str(w.a.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert one["machineId"] == str(w.a.id) and one["status"] == S.UP_TO_DATE
        many = SSR.list_sync_status(shop_id=w.shop.id, machine_ids=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert {i["machineId"]: i["status"] for i in many["items"]} == {
            str(w.a.id): S.UP_TO_DATE, str(w.b.id): S.NOT_REPORTED,
        }
        with pytest.raises(HTTPException) as e:
            SSR.list_sync_status(shop_id=None, machine_ids=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.status_code == 422
        with pytest.raises(HTTPException) as e:
            SSR.get_sync_status(str(w.a.id), current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db)
        assert e.value.status_code == 403


# ═════════════════════════════════════════════════════════════════════════════
# Stale: online and not up to date for longer than `syncStaleMinutes` — "בעיות"
# ═════════════════════════════════════════════════════════════════════════════


class TestStale:
    def stale_report(self, w, till, *, changed_minutes_ago, pulled_minutes_ago=120):
        report(w, till, holding_everything(w, till, pulled=NOW - timedelta(minutes=pulled_minutes_ago)))
        w.cola.price = Decimal("13")
        w.cola.updated_at = NOW - timedelta(minutes=changed_minutes_ago)
        w.db.commit()

    def problems(self, w):
        out = PB.build(w.db, w.admin, w.tenant.id, now=NOW)
        devices = next(g for g in out["groups"] if g["key"] == "devices")
        return [i for i in devices["items"] if i["kind"] == "device_sync_stale"]

    def test_pending_longer_than_the_threshold_is_stale(self, w):
        self.stale_report(w, w.a, changed_minutes_ago=45)
        out = evaluate(w, w.a)
        assert out["stale"] is True and out["staleMinutes"] == TP.SYNC_STALE_MINUTES_DEFAULT
        assert out["staleSince"] == (NOW - timedelta(minutes=45)).isoformat()
        (item,) = self.problems(w)
        assert item["machineId"] == str(w.a.id) and item["severity"] == "low"
        assert item["link"] == f"/dashboard/machines/{w.a.id}#sync"
        assert "קטלוג" in item["detail"]

    def test_a_change_newer_than_the_threshold_is_not_stale_yet(self, w):
        # The till last pulled two hours ago; the change is ten minutes old — pending, not stale.
        self.stale_report(w, w.a, changed_minutes_ago=10)
        assert evaluate(w, w.a)["stale"] is False
        assert self.problems(w) == []

    def test_offline_is_not_this_problem(self, w):
        self.stale_report(w, w.a, changed_minutes_ago=45)
        w.a.last_heartbeat_at = NOW - timedelta(minutes=30)
        w.db.commit()
        assert evaluate(w, w.a)["stale"] is False
        assert self.problems(w) == []

    def test_the_threshold_is_a_till_parameter(self, w):
        self.stale_report(w, w.a, changed_minutes_ago=45)
        set_param(w, TP.SYNC_STALE_MINUTES_KEY, "shop", w.shop.id, 60)
        assert S.stale_minutes_by_machine(w.db, [w.a])[str(w.a.id)] == 60
        assert self.problems(w) == []
        set_param(w, TP.SYNC_STALE_MINUTES_KEY, "machine", w.a.id, 15)
        assert S.stale_minutes_by_machine(w.db, [w.a, w.b]) == {str(w.a.id): 15, str(w.b.id): 60}
        (item,) = self.problems(w)
        assert item["severity"] == "medium"  # 45 minutes is more than twice 15
        # Out of range is clamped, never zero.
        assert S.threshold_of(0) == TP.SYNC_STALE_MINUTES_MIN and S.threshold_of(10**6) == TP.SYNC_STALE_MINUTES_MAX

    def test_an_error_is_stale_from_its_first_failure_and_medium(self, w):
        keys = holding_everything(w, w.a, pulled=NOW - timedelta(minutes=50))
        keys["parameters"] = {**keys["parameters"], "ok": False, "error": "timeout",
                              "errorSince": (NOW - timedelta(minutes=40)).isoformat()}
        report(w, w.a, keys)
        (item,) = self.problems(w)
        assert item["severity"] == "medium" and "פרמטרים: timeout" in item["detail"]
        assert item["since"] == (NOW - timedelta(minutes=40)).isoformat()

    def test_a_device_that_pulled_within_the_threshold_is_never_compared(self, w, monkeypatch):
        report(w, w.a, holding_everything(w, w.a, pulled=NOW - timedelta(minutes=5)))
        assert S.could_be_stale(w.a, 30, NOW) is False
        calls = []
        monkeypatch.setattr(S, "evaluate", lambda *a, **k: calls.append(a) or {"stale": False})
        assert S.stale_devices(w.db, [w.a, w.b], now=NOW) == [] and calls == []
