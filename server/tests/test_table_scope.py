"""
"תחום שולחנות" and "מספר שולחן עם אותיות" (P:/specs/table-scope.md; app/services/table_scope.py,
app/services/table_labels.py, app/services/tables.py) — the owner's 16.10 decisions (§13): the device's and the
employee's scopes cut each other, outside the scope is hidden, the unassigned table follows
`tableAssignmentUnassigned`, TABLES.SEE_ALL (P, P, A, A), labels of 12 Hebrew / English letters, digits, spaces and
"-" (English upper case), a label typed that is not there makes no table, `tableTerm` now, the device's scope from
the dashboard only, old tills by the compatibility path, the history unfiltered.

What each class pins, and how it could look fine while doing damage:

* **Goldens** — the label rules and the scope rule are the fixtures' (pos-android runs the same bytes); a drift
  between the languages would show a waiter one floor and refuse another.
* **Nothing set** — no scope, no labels: the state has today's keys only, its tag today's fingerprint, the
  parameters change nothing (the owner's rule: a deploy never changes what a shop sees).
* **Device scope** — the cloud never sends what is outside it (hidden, or a skeleton under `dim`), tabs without a
  table in it are gone, its writes are refused (403 with the table) unless the employee may see everything or a
  manager approved — then `scope_override` names them; "כל השולחנות" (`?scope=all`) only for an allowed employee,
  with a tag of its own. The LAN host gets everything, every device's scope and every area.
* **Employee scope** — fixed, by assignment (open / restricted, multi), their union; the cloud refuses the write.
* **Labels** — "3b" is "3B" with an internal number from 99,999 down, "3-B" is taken, "12" is a number, a range
  "3A"–"3L", swaps in one layout batch, an old till sees the label as its name and its layout save keeps the label;
  a label typed that is not there is not made.
* **Dashboard** — the device's and the employee's scope set, checked, logged and reset on a move; "מי רואה מה".
* **Notices** — a waiter's notice on a table outside a device's scope goes elsewhere, never lost.
* **Migration** — one head, on main's.

Runs on the in-memory SQLite world of tests/shift_world.py (the tables tests' `w`).
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import uuid
from datetime import timedelta

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.pos_user import PosUser, PosUserRole
from app.models.shop_area import ShopArea
from app.models.tables import DiningTable, TableEvent, TableOrder, TableReservation, TableScopeChange
from app.routers import tables as R
from app.schemas.tables import (
    BulkTablesIn,
    TableAdhocIn,
    TableCreate,
    TableEnterIn,
    TableMoveIn,
    TableUpdate,
    TillLayoutIn,
    ZoneCreate,
)
from app.services import table_assignments as TAS
from app.services import table_labels as TL
from app.services import table_scope as TSC
from app.services import tables as T
from app.services import tables_state as TS
from app.services import till_parameters as TP
from app.services import till_permissions as PERM
from shift_world import NOW
from test_tables import SYNCED, enter, refused, run, set_param, w  # noqa: F401 - the world
from test_tables import put_param

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
LABELS = FIXTURES / "table_label_sort_golden.json"
SCOPES = FIXTURES / "table_scope_golden.json"
LAN = "רשת מקומית (קופה ראשית)"


def _golden(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path) -> str:
    return hashlib.sha256(path.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8")).hexdigest()


#: The LF-normalised SHA-256 of the fixtures — pos-android's tests pin the same.
LABELS_SHA256 = "869b5391e26e97d0402facb5299f1241d283adf00202f56987bf733af7ce196a"
SCOPES_SHA256 = "ffd848a4622d753aa213a0fc1c672c51d1550d405f616d83f850ff4a1a4fd606"


# ── Helpers ───────────────────────────────────────────────────────────────────


def user(w, first, role=PosUserRole.CASHIER, **extra):
    pu = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username=f"u{uuid.uuid4().hex[:8]}",
        first_name=first, pin_hash="x", role=role, is_active=True, created_at=NOW - timedelta(days=30), **extra,
    )
    w.db.add(pu)
    w.db.commit()
    return pu


def state(w, till, *, scope=None, operator=None):
    return R.get_tables_state(str(till.id), scope=scope, machine=till, db=w.db, operator_id=operator)


def numbers(out):
    return sorted(t["number"] for t in out["tables"])


def enter_as(w, till, table, operator=None, approver=None, name="דנה"):
    tasks = BackgroundTasks()
    out = R.enter_table(
        str(till.id), table.id, tasks,
        TableEnterIn(posUserId=str(operator.id) if operator is not None else "pu-" + name, posUserName=name),
        machine=till, db=w.db, operator_id=None, scope_approver=str(approver.id) if approver is not None else None,
    )
    run(tasks)
    return out


def device_scope(w, till, *, zones=(), tables=()):
    till.table_scope = {"zoneIds": [str(z.id) for z in zones], "tableIds": [str(t.id) for t in tables]}
    w.db.commit()
    TS.SNAPSHOTS.clear()


@pytest.fixture
def floor(w):
    """Two zones: "מפלס 2" (20, 21) and "מפלס 3" (30, 31), beside the hall (1, 2, 3, 12)."""
    w.l2 = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, name="מפלס 2", layout="grid"))
    w.l3 = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, name="מפלס 3", layout="grid"))
    for n in (20, 21):
        w.t[n] = T.create_table(w.db, w.l2, TableCreate(zoneId=w.l2.id, number=n))
    for n in (30, 31):
        w.t[n] = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number=n))
    w.db.commit()
    TS.SNAPSHOTS.clear()
    return w


# ── Goldens ───────────────────────────────────────────────────────────────────


class TestLabelGolden:
    def test_the_fixture_is_the_till_s_byte_for_byte(self):
        assert sha(LABELS) == LABELS_SHA256

    def test_parse(self):
        for case in _golden(LABELS)["parse"]:
            if "error" in case:
                with pytest.raises(TL.LabelError) as e:
                    TL.parse(case["input"])
                assert e.value.reason == case["error"], case
                continue
            got = TL.parse(case["input"])
            if "number" in case:
                assert (got.number, got.label) == (case["number"], None), case
            else:
                assert (got.number, got.label, got.key) == (None, case["label"], case["key"]), case

    def test_the_natural_order(self):
        g = _golden(LABELS)
        assert sorted(g["shuffled"], key=TL.sort_key) == g["sorted"]
        assert sorted(g["mixed"]["input"], key=TL.sort_key) == g["mixed"]["sorted"]

    def test_titles_and_the_word_before_them(self):
        for c in _golden(LABELS)["titles"]:
            title = TL.table_title(c["number"], c["label"], c["name"], c["labelOnly"])
            assert title == c["title"], c
            assert TL.with_term(c["term"], title, c["labelOnly"]) == c["withTerm"], c

    def test_ranges(self):
        for c in _golden(LABELS)["ranges"]:
            if "error" in c:
                with pytest.raises(TL.LabelError) as e:
                    TL.expand_range(c["from"], c["to"])
                assert e.value.reason == c["error"], c
                continue
            got = [p.label if p.is_label else p.number for p in TL.expand_range(c["from"], c["to"])]
            assert got == c["items"], c

    def test_the_keypad(self):
        g = _golden(LABELS)["keypad"]

        class Row:
            def __init__(self, d):
                self.number, self.label = d["number"], d["label"]

        rows = [Row(d) for d in g["tables"]]
        for c in g["cases"]:
            got = [TL.shown_of(r.number, r.label) for r in TL.suggestions(c["typed"], rows)]
            assert got == c["suggestions"], c
            hit = next((r for r in rows if TL.exact(c["typed"], r.number, r.label)), None)
            assert (TL.shown_of(hit.number, hit.label) if hit else None) == c["exact"], c

    def test_the_row_of_letters_and_the_internal_number(self):
        g = _golden(LABELS)
        assert TL.letters_in(g["letters"]["labels"]) == g["letters"]["letters"]
        for c in g["internal"]:
            assert TL.internal_number(c["taken"]) == c["number"]


class TestScopeGolden:
    def test_the_fixture_is_the_till_s_byte_for_byte(self):
        assert sha(SCOPES) == SCOPES_SHA256

    def test_every_case(self):
        g = _golden(SCOPES)
        tables = [(t, z) for z, ts in g["zones"].items() for t in ts]
        live_tables = {t for t, _ in tables}

        def resolved(raw):
            if raw is None:
                return None
            return TSC.Resolved(
                zone_ids=frozenset(z for z in raw["zoneIds"] if z in g["zones"]),
                table_ids=frozenset(t for t in raw["tableIds"] if t in live_tables),
            )

        for c in g["cases"]:
            got = TSC.visible_tables(
                tables, device=resolved(c["device"]), fixed=resolved(c["fixed"]), by_assignment=c["byAssignment"],
                assignees=g["assignees"], me=c["me"], unassigned_open=c["unassignedOpen"], see_all=c["seeAll"],
                all_tables=c["allTables"],
            )
            assert (None if got is None else sorted(got, key=TL.sort_key)) == c["visible"], c["name"]


# ── The parameters and the permission ─────────────────────────────────────────


class TestParameters:
    def test_built_in_with_today_s_defaults_and_hebrew_words(self):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        assert specs["tableAssignmentScope"].value_type == "boolean" and specs["tableAssignmentScope"].default_value is False
        assert specs["tableScopeOutside"].enum_options == ("hide", "dim") and specs["tableScopeOutside"].default_value == "hide"
        assert specs["tableTerm"].value_type == "string" and specs["tableTerm"].default_value == "שולחן"
        for key in TSC.LEVEL_KEYS:
            assert any("\u0590" <= ch <= "\u05ff" for ch in specs[key].label), key
        assert TP.enum_labels("tableScopeOutside") == TSC.OUTSIDE_LABELS

    def test_only_what_the_till_knows(self):
        assert TP.validate_keyed_value("tableScopeOutside", "dim") == "dim"
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value("tableScopeOutside", "blur")
        assert TP.validate_keyed_value("tableTerm", "  תא ") == "תא"
        for bad in ("", "   ", "מילה ארוכה מדי"):
            with pytest.raises(TP.TillParameterValueError):
                TP.validate_keyed_value("tableTerm", bad)

    def test_the_scope_from_the_assignment_needs_the_assignment_on(self):
        assert TSC.from_assignment({}) is False
        assert TSC.from_assignment({"tableAssignmentScope": True}) is False
        assert TSC.from_assignment({"tableAssignmentScope": True, "tableAssignmentMode": "restrict"}) is True
        assert TSC.term_of({}) == "שולחן" and TSC.term_of({"tableTerm": "תא"}) == "תא"
        assert TSC.outside_of({"tableScopeOutside": "nope"}) == "hide"

    def test_see_all_is_allowed_to_the_supervisor_and_the_manager_on_approval_to_the_others(self):
        assert [PERM.DEFAULTS[r]["TABLES.SEE_ALL"] for r in ("waiter", "cashier", "supervisor", "manager")] == [
            "approval", "approval", "allow", "allow",
        ]
        assert PERM.DEFAULTS["legacy_cashier"]["TABLES.SEE_ALL"] == "approval"
        assert PERM.DEFAULTS["legacy_manager"]["TABLES.SEE_ALL"] == "allow"
        assert "TABLES.SEE_ALL" in PERM.CODES


# ── Nothing set: today ────────────────────────────────────────────────────────

#: Every key of the state and of a table a till got before this module — nothing more when nothing is set.
STATE_KEYS = {
    "serverTime", "mode", "lockMinutes", "blockCloseWithOpenTables", "busy", "zones", "tables", "cancelReasons",
    "reservations", "stateVersion", "stateTag",
}
TABLE_KEYS = {
    "id", "zoneId", "number", "name", "seats", "shape", "x", "y", "width", "height", "rotation", "cleaningSince",
    "labelOnly", "kind", "discountPercent", "typeId", "policy", "order", "lock", "state",
}


class TestNothingSet:
    def test_the_state_of_today_its_keys_and_its_tag(self, floor):
        w = floor
        out = state(w, w.a)
        assert set(out) == STATE_KEYS
        for t in out["tables"]:
            assert set(t) == TABLE_KEYS, set(t) ^ TABLE_KEYS
        assert numbers(out) == [1, 2, 3, 12, 20, 21, 30, 31]
        # The fingerprint of a till with none of it is its fingerprint of before (no scope, no capability).
        import hashlib as _h

        raw = "|".join(str(v) for v in (w.a.id, w.a.tenant_id, w.a.shop_id, w.a.area_id, False, False, True))
        assert TS.fingerprint(w.a) == _h.sha1(raw.encode("utf-8")).hexdigest()[:10]

    def test_scope_all_without_a_scope_is_the_same_state(self, floor):
        w = floor
        mgr = w.manager
        a, b = state(w, w.a), state(w, w.a, scope="all", operator=str(mgr.id))
        assert "scopeAll" not in b and numbers(a) == numbers(b) and a["stateTag"] == b["stateTag"]


# ── The device's scope ────────────────────────────────────────────────────────


class TestDeviceScope:
    def test_only_what_is_in_it_and_the_tabs_that_have_one(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l3], tables=[w.t[20]])
        out = state(w, w.a)
        assert numbers(out) == [20, 30, 31]
        assert [z["name"] for z in out["zones"]] == ["מפלס 2", "מפלס 3"]
        assert out["scope"]["device"] == {"zoneIds": [str(w.l3.id)], "tableIds": [str(w.t[20].id)]}
        assert out["scope"]["outside"] == "hide" and out["scope"]["fromAssignment"] is False
        # Another till of the shop: everything, as ever.
        assert numbers(state(w, w.b)) == [1, 2, 3, 12, 20, 21, 30, 31]

    def test_dim_sends_the_skeleton_only(self, floor):
        w = floor
        set_param(w, "tableScopeOutside", "shop", w.shop.id, "dim")
        device_scope(w, w.a, tables=[w.t[20]])
        enter(w, w.b, w.t[21])
        TS.SNAPSHOTS.clear()
        out = state(w, w.a)
        by = {t["number"]: t for t in out["tables"]}
        assert sorted(by) == [20, 21] and [z["name"] for z in out["zones"]] == ["מפלס 2"]
        assert by[21]["outOfScope"] is True and by[21]["order"] is None and by[21]["lock"] is None
        assert "policy" not in by[21] and "outOfScope" not in by[20]

    def test_an_archived_zone_leaves_an_empty_scope_that_sees_nothing(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l3])
        T.archive_table(w.db, w.t[30])
        T.archive_table(w.db, w.t[31])
        T.archive_zone(w.db, w.l3)
        w.db.commit()
        TS.SNAPSHOTS.clear()
        out = state(w, w.a)
        assert out["tables"] == [] and out["zones"] == [] and out["scope"]["device"] == {"zoneIds": [], "tableIds": []}

    def test_a_write_outside_it_is_refused_with_the_table(self, floor):
        w = floor
        w.t[30].label, w.t[30].label_key = None, None
        device_scope(w, w.a, zones=[w.l2])
        e = refused(enter, w, w.a, w.t[30])
        assert e.status_code == 403
        assert e.detail == {"code": "table_out_of_scope", "table": {"id": str(w.t[30].id), "number": 30, "label": None},
                            "scope": "device"}
        assert enter(w, w.a, w.t[20])["table"]["number"] == 20

    def test_a_manager_s_code_lets_one_action_through_and_names_them(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l2])
        dana = user(w, "דנה")
        out = enter_as(w, w.a, w.t[30], operator=dana, approver=w.manager)
        assert out["table"]["number"] == 30
        ev = w.db.query(TableEvent).filter(TableEvent.kind == "scope_override").one()
        assert ev.table_id == w.t[30].id and ev.machine_id == w.a.id
        assert ev.details["approverPosUserId"] == str(w.manager.id) and ev.details["scope"] == "device"
        assert ev.details["posUserId"] == str(dana.id) and ev.details["action"] == "enter"
        # A cashier's code is no approval (TABLES.SEE_ALL on approval to them).
        other = user(w, "יוסי")
        e = refused(enter_as, w, w.a, w.t[31], operator=dana, approver=other)
        assert e.status_code == 403

    def test_an_employee_who_may_see_everything_is_not_refused_nor_recorded(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l2])
        enter_as(w, w.a, w.t[30], operator=w.manager)
        assert w.db.query(TableEvent).filter(TableEvent.kind == "scope_override").count() == 0

    def test_move_transfer_merge_and_peek(self, floor):
        w = floor
        from app.schemas.tables import TableMoveIn as Move

        device_scope(w, w.a, zones=[w.l2])
        enter(w, w.a, w.t[20])
        from test_tables import save

        save(w, w.a, w.t[20], uuid.uuid4(), None)
        order = w.db.query(TableOrder).filter(TableOrder.table_id == w.t[20].id).one()
        e = refused(
            R.move_table, str(w.a.id), w.t[20].id,
            Move(orderId=order.id, expectedVersion=order.version, requestId="r1", targetTableId=w.t[30].id,
                 posUserId="pu-dana", posUserName="דנה"),
            BackgroundTasks(), machine=w.a, db=w.db, operator_id=None, scope_approver=None,
        )
        assert e.status_code == 403 and e.detail["table"]["number"] == 30
        e = refused(T.peek, w.db, w.a, w.t[30].id)
        assert e.status_code == 403

    def test_scope_all_for_an_allowed_employee_alone_with_a_tag_of_its_own(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l2])
        scoped = state(w, w.a)
        everything = state(w, w.a, scope="all", operator=str(w.manager.id))
        assert numbers(scoped) == [20, 21]
        assert numbers(everything) == [1, 2, 3, 12, 20, 21, 30, 31] and everything["scopeAll"] is True
        assert everything["stateTag"] != scoped["stateTag"]
        # A cashier (on approval): the scoped state.
        assert numbers(state(w, w.a, scope="all", operator=str(w.cashier.id))) == [20, 21]
        # The scoped tag is not honoured for "all", nor the other way round.
        assert not TS.tag_matches(scoped["stateTag"], w.a, scoped["stateVersion"], T._now(), TS.VARIANT_ALL)
        assert TS.tag_matches(scoped["stateTag"], w.a, scoped["stateVersion"], T._now())

    def test_the_scope_is_in_the_tag(self, floor):
        w = floor
        before = TS.fingerprint(w.a)
        device_scope(w, w.a, zones=[w.l2])
        assert TS.fingerprint(w.a) != before

    def test_closed_and_reports_on_the_till_are_the_scope_s(self, floor):
        w = floor
        enter(w, w.a, w.t[30])
        from test_tables import pay, save

        oid = uuid.uuid4()
        save(w, w.a, w.t[30], oid, None)
        pay(w, w.a, w.t[30], oid, 1)
        w.db.commit()
        assert [o["tableId"] for o in T.closed_orders(w.db, w.a)] == [str(w.t[30].id)]
        device_scope(w, w.a, zones=[w.l2])
        assert T.closed_orders(w.db, w.a) == []

    def test_a_booking_on_a_table_outside_it(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l2])
        e = refused(T.check_reservation_scope, w.db, w.a, w.t[30].id)
        assert e.status_code == 403
        T.check_reservation_scope(w.db, w.a, w.t[20].id)
        T.check_reservation_scope(w.db, w.a, None)


class TestLanHost:
    def test_the_host_gets_everything_every_device_s_scope_and_every_area(self, floor):
        w = floor
        put_param(w, "tablesMode", "shop", w.shop.id, LAN)
        put_param(w, "tablesHostTill", "machine", w.b.id, True)
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.db.flush()
        stools = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=bar.id, name="בר"))
        w.t[50] = T.create_table(w.db, stools, TableCreate(zoneId=stools.id, number=50))
        w.b.table_scope = {"zoneIds": [str(w.l3.id)], "tableIds": []}
        w.db.commit()
        device_scope(w, w.a, zones=[w.l2])
        host = state(w, w.b)
        assert host["lanHost"]["isSelf"] is True
        # Not narrowed by its own scope; no area of another till's yet (a build before table_scope_v1).
        assert numbers(host) == [1, 2, 3, 12, 20, 21, 30, 31] and "hostAllAreas" not in host
        devices = {d["machineId"]: d for d in host["scope"]["devices"]}
        assert devices[str(w.a.id)]["zoneIds"] == [str(w.l2.id)] and devices[str(w.b.id)]["zoneIds"] == [str(w.l3.id)]
        assert host["scope"]["device"] == {"zoneIds": [str(w.l3.id)], "tableIds": []}
        # A build that narrows every device itself: every area's zones too.
        w.b.capabilities = [TSC.CAPABILITY_SCOPE, TSC.CAPABILITY_LABELS]
        w.db.commit()
        TS.SNAPSHOTS.clear()
        host = state(w, w.b)
        assert host["hostAllAreas"] is True and 50 in numbers(host)
        # The other tills: their own scope, never the devices'.
        a = state(w, w.a)
        assert numbers(a) == [20, 21] and "devices" not in a["scope"]


# ── The employee's scope ──────────────────────────────────────────────────────


class TestEmployeeScope:
    def test_the_state_carries_the_fixed_scopes_and_the_till_narrows(self, floor):
        w = floor
        dana = user(w, "דנה", table_scope={"zoneIds": [], "tableIds": [str(w.t[30].id)]})
        TS.SNAPSHOTS.clear()
        out = state(w, w.a)
        assert numbers(out) == [1, 2, 3, 12, 20, 21, 30, 31]
        assert out["scope"]["users"] == [{"posUserId": str(dana.id), "zoneIds": [], "tableIds": [str(w.t[30].id)]}]
        assert out["scope"]["device"] is None

    def test_the_cloud_refuses_her_write_outside_it(self, floor):
        w = floor
        dana = user(w, "דנה", table_scope={"zoneIds": [str(w.l3.id)], "tableIds": []})
        e = refused(enter_as, w, w.a, w.t[20], operator=dana)
        assert e.status_code == 403 and e.detail["scope"] == "user"
        assert enter_as(w, w.a, w.t[30], operator=dana)["table"]["number"] == 30
        assert enter_as(w, w.a, w.t[21], operator=dana, approver=w.manager)["table"]["number"] == 21
        assert w.db.query(TableEvent).filter(TableEvent.kind == "scope_override").one().details["scope"] == "user"

    def test_by_assignment_open_and_restricted(self, floor):
        w = floor
        set_param(w, TAS.MODE_KEY, "shop", w.shop.id, TAS.MODE_RESTRICT)
        set_param(w, TSC.ASSIGNMENT_SCOPE_KEY, "shop", w.shop.id, True)
        dana, yossi = user(w, "דנה"), user(w, "יוסי")
        shop_ctx = TAS._Ctx.of(w.db, w.shop)
        who = TAS.Who(name="רותי")
        TAS.assign(shop_ctx, w.t[30], None, dana, who)
        TAS.assign(shop_ctx, w.t[31], None, yossi, who)
        w.db.commit()
        TS.SNAPSHOTS.clear()
        assert state(w, w.a)["scope"]["fromAssignment"] is True
        # Hers, and nobody's (unassigned = open).
        assert enter_as(w, w.a, w.t[30], operator=dana)["table"]["number"] == 30
        assert enter_as(w, w.b, w.t[20], operator=dana)["table"]["number"] == 20
        assert refused(enter_as, w, w.a, w.t[31], operator=dana).detail["scope"] == "user"
        # Restricted: nobody's is the allowed employees' alone.
        set_param(w, TAS.UNASSIGNED_KEY, "shop", w.shop.id, TAS.UNASSIGNED_RESTRICTED)
        assert refused(enter_as, w, w.a, w.t[21], operator=dana).detail["scope"] == "user"
        assert enter_as(w, w.a, w.t[21], operator=w.manager)["table"]["number"] == 21

    def test_device_and_employee_cut_each_other(self, floor):
        w = floor
        device_scope(w, w.a, zones=[w.l2])
        dana = user(w, "דנה", table_scope={"zoneIds": [str(w.l3.id)], "tableIds": []})
        # Neither 20 (not hers) nor 30 (not the device's).
        assert refused(enter_as, w, w.a, w.t[20], operator=dana).detail["scope"] == "user"
        assert refused(enter_as, w, w.a, w.t[30], operator=dana).detail["scope"] == "device"


# ── Labels ────────────────────────────────────────────────────────────────────


class TestLabels:
    def test_made_by_the_one_field_upper_case_with_an_internal_number(self, floor):
        w = floor
        w.a.capabilities = [TSC.CAPABILITY_LABELS]
        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3b"))
        w.db.commit()
        assert (t.label, t.label_key, t.number) == ("3B", "3B", 99_999)
        twelve = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="13"))
        assert (twelve.number, twelve.label) == (13, None)
        e = refused(T.create_table, w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3-B"))
        assert (e.status_code, e.detail["code"], e.detail["label"]) == (409, "table_label_taken", "3-B")
        e = refused(T.create_table, w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3/B"))
        assert (e.status_code, e.detail) == (422, {"code": "table_label_invalid", "reason": "characters"})
        nxt = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3C"))
        assert nxt.number == 99_998
        out = {x["number"]: x for x in state(w, w.a)["tables"]}
        assert out[99_999]["label"] == "3B" and "label" not in out[30]

    def test_the_state_s_order_is_the_natural_one(self, floor):
        w = floor
        w.a.capabilities = [TSC.CAPABILITY_LABELS]
        for label in ("3B", "3A", "10A"):
            T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number=label))
        w.db.commit()
        TS.SNAPSHOTS.clear()
        level3 = [t for t in state(w, w.a)["tables"] if t["zoneId"] == str(w.l3.id)]
        assert [t.get("label") or t["number"] for t in level3] == ["3A", "3B", "10A", 30, 31]

    def test_an_old_till_sees_the_label_as_its_name(self, floor):
        w = floor
        T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B", name="VIP"))
        w.db.commit()
        TS.SNAPSHOTS.clear()
        old = next(t for t in state(w, w.a)["tables"] if t["number"] == 99_999)
        assert (old["name"], old["labelOnly"], "label" in old) == ("3B · VIP", True, False)
        w.a.capabilities = [TSC.CAPABILITY_LABELS]
        w.db.commit()
        new = next(t for t in state(w, w.a)["tables"] if t["number"] == 99_999)
        assert (new["name"], new["labelOnly"], new["label"]) == ("VIP", False, "3B")

    def test_an_old_till_s_layout_save_keeps_the_label(self, floor):
        w = floor
        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        w.db.commit()
        body = TillLayoutIn.model_validate({"tables": [{"id": str(t.id), "name": "3B", "x": 10}]})
        T.apply_till_layout(w.db, w.a, body)
        w.db.commit()
        w.db.refresh(t)
        assert (t.label, t.name, t.x) == ("3B", None, 10)

    def test_labels_swap_in_one_batch_and_a_new_one_needs_no_number(self, floor):
        w = floor
        w.a.capabilities = [TSC.CAPABILITY_LABELS]
        a = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3A"))
        b = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        w.db.commit()
        body = TillLayoutIn.model_validate({"tables": [
            {"id": str(a.id), "label": "3b"}, {"id": str(b.id), "label": "3A"},
            {"zoneId": str(w.l3.id), "label": "3C"},
        ]})
        T.apply_till_layout(w.db, w.a, body)
        w.db.commit()
        w.db.refresh(a)
        w.db.refresh(b)
        assert (a.label, b.label) == ("3B", "3A")
        c = w.db.query(DiningTable).filter(DiningTable.label == "3C").one()
        assert c.number == 99_997
        e = refused(T.apply_till_layout, w.db, w.a, TillLayoutIn.model_validate({"tables": [
            {"id": str(a.id), "label": "3 C"},
        ]}))
        assert (e.status_code, e.detail["code"]) == (409, "table_label_taken")

    def test_the_label_taken_off_needs_a_number(self, floor):
        w = floor
        a = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3A"))
        w.db.commit()
        e = refused(T.apply_till_layout, w.db, w.a, TillLayoutIn.model_validate({"tables": [{"id": str(a.id), "label": None}]}))
        assert e.detail == "table_number_required"
        T.apply_till_layout(w.db, w.a, TillLayoutIn.model_validate({"tables": [{"id": str(a.id), "label": None, "number": 40}]}))
        w.db.commit()
        w.db.refresh(a)
        assert (a.label, a.number) == (None, 40)

    def test_a_range_with_letters(self, floor):
        w = floor
        T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3C"))
        out = T.bulk_create(w.db, w.l3, BulkTablesIn.model_validate({"from": "3A", "to": "3L"}))
        assert out["skipped"] == ["3C"] and len(out["created"]) == 11 and out["created"][0] == "3A"
        nums = sorted(t.number for t in w.db.query(DiningTable).filter(DiningTable.label.isnot(None)).all())
        assert nums == list(range(99_988, 100_000))
        assert refused(T.bulk_create, w.db, w.l3, BulkTablesIn.model_validate({"from": "3A", "to": "4B"})).status_code == 422
        assert refused(T.bulk_create, w.db, w.l3, BulkTablesIn.model_validate({"from": 1, "to": 600})).detail == "bulk_too_many"

    def test_update_makes_a_number_a_label_and_back(self, floor):
        w = floor
        t = w.t[30]
        T.update_table(w.db, t, TableUpdate(number="3b"), w.tenant.id)
        assert (t.label, t.number) == ("3B", 99_999)
        T.update_table(w.db, t, TableUpdate(number=32), w.tenant.id)
        assert (t.label, t.label_key, t.number) == (None, None, 32)

    def test_an_order_keeps_its_label(self, floor):
        w = floor
        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        w.db.commit()
        enter(w, w.a, t)
        from test_tables import save

        save(w, w.a, t, uuid.uuid4(), None)
        order = w.db.query(TableOrder).filter(TableOrder.table_id == t.id).one()
        assert (order.table_number, order.table_label) == (99_999, "3B")

    def test_a_label_typed_is_found_never_made(self, floor):
        w = floor
        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        w.db.commit()
        found = R.adhoc_table(str(w.a.id), TableAdhocIn(label="3 b"), BackgroundTasks(), machine=w.a, operator_id=None,
                              db=w.db, scope_approver=None)
        assert found["table"]["id"] == str(t.id) and found["created"] is False
        e = refused(R.adhoc_table, str(w.a.id), TableAdhocIn(label="3K"), BackgroundTasks(), machine=w.a,
                    operator_id=None, db=w.db, scope_approver=None)
        assert (e.status_code, e.detail) == (404, {"code": "table_not_found", "label": "3K"})
        # A labelled table's internal number is no table to key.
        e = refused(T.adhoc_table, w.db, w.a, 99_999)
        assert e.detail["code"] == "table_number_taken"

    def test_by_number_or_label_outside_the_scope(self, floor):
        w = floor
        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        w.db.commit()
        device_scope(w, w.a, zones=[w.l2])
        e = refused(T.adhoc_table, w.db, w.a, None, label="3B")
        assert e.status_code == 403 and e.detail["table"] == {"id": str(t.id), "number": 99_999, "label": "3B"}
        assert refused(T.adhoc_table, w.db, w.a, 30).status_code == 403
        # A new table by number: only where "שולחנות מזדמנים" is in the scope — never here, unless approved.
        e = refused(T.adhoc_table, w.db, w.a, 45)
        assert e.status_code == 403 and e.detail["table"] is None and e.detail["number"] == 45
        actor = T.Actor(machine=w.a, pos_user_id="pu-dana", scope_approver=str(w.manager.id))
        out = T.adhoc_table(w.db, w.a, 45, actor=actor)
        assert out["created"] is True
        assert w.db.query(TableEvent).filter(TableEvent.kind == "scope_override").one().details["action"] == "adhoc"

    def test_the_history_finds_3b(self, floor):
        from app.services import table_documents as D

        for q in ("ש3B", "שולחן 3b", "תא 3-B", "t3b"):
            tq = D.parse_table_query(q)
            assert tq.explicit and tq.label_key == "3B", q
            assert tq.matches(99_999, None, "3B") and not tq.matches(99_999, None, "3C"), q
        chip = D.parse_table_query("3b", chip=True)
        assert chip.matches(1, None, "3B") and not chip.matches(3, None, None)
        assert D.parse_table_query("שניצל").explicit is False


# ── The dashboard ─────────────────────────────────────────────────────────────


class TestDashboard:
    def put(self, w, machine, scope, also=()):
        from app.routers import machines as RM

        body = RM.TableScopeIn.model_validate({"tableScope": scope, "alsoMachineIds": [str(m.id) for m in also]})
        return RM.put_machine_table_scope(machine.id, body, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

    def test_set_checked_logged_and_on_several_devices(self, floor):
        w = floor
        scope = {"zoneIds": [str(w.l2.id)], "tableIds": [str(w.t[30].id)]}
        out = self.put(w, w.a, scope, also=[w.b])
        assert [d["tableScope"] for d in out["devices"]] == [scope, scope]
        assert w.db.query(TableScopeChange).filter(TableScopeChange.target_type == "machine").count() == 2
        # Again, the same: nothing logged.
        self.put(w, w.a, scope)
        assert w.db.query(TableScopeChange).count() == 2
        # Another shop's zone, a device of another shop, junk.
        with pytest.raises(HTTPException) as e:
            self.put(w, w.a, {"zoneIds": [str(uuid.uuid4())], "tableIds": []})
        assert e.value.status_code == 422 and e.value.detail["reason"] == "zone_not_seen"
        with pytest.raises(HTTPException) as e:
            self.put(w, w.a, scope, also=[w.other_till])
        assert e.value.detail["code"] == "machine_other_shop"
        with pytest.raises(HTTPException) as e:
            self.put(w, w.a, {"zoneIds": ["nope"]})
        assert e.value.detail["code"] == "table_scope_invalid"
        # Back to everything.
        self.put(w, w.a, None)
        w.db.refresh(w.a)
        assert w.a.table_scope is None

    def test_a_device_sees_its_point_of_sale_s_zones_only(self, floor):
        w = floor
        bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(bar)
        w.db.flush()
        stools = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, areaId=bar.id, name="בר"))
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            self.put(w, w.a, {"zoneIds": [str(stools.id)], "tableIds": []})
        assert e.value.detail["reason"] == "zone_not_seen"
        from app.routers import machines as RM

        tree = RM.get_machine_table_scope(w.a.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert "בר" not in [z["name"] for z in tree["zones"]] and tree["device"]["tableScope"] is None

    def test_moving_shop_clears_it(self, floor, monkeypatch):
        w = floor
        from app.services import document_prefix
        from app.services import register_number as RN

        # The register number's draw reads Postgres' regex: not this test's business.
        monkeypatch.setattr(RN, "assign_register_number", lambda db, m: None)
        monkeypatch.setattr(RN, "_release_offline_assignments", lambda db, m: None)
        monkeypatch.setattr(document_prefix, "settle_default", lambda db, m: None)
        self.put(w, w.a, {"zoneIds": [str(w.l2.id)], "tableIds": []})
        RN.set_machine_shop(w.db, w.a, w.other_shop.id)
        assert w.a.table_scope is None

    def test_the_employee_s_card(self, floor):
        w = floor
        from app.routers import pos_users as RP
        from app.schemas.pos_user import PosUserUpdate

        dana = user(w, "דנה")
        scope = {"zoneIds": [str(w.l3.id)], "tableIds": []}
        out = RP.update_pos_user(str(w.shop.id), str(dana.id), PosUserUpdate.model_validate({"tableScope": scope}),
                                 current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out.table_scope == scope
        row = w.db.query(TableScopeChange).filter(TableScopeChange.target_type == "pos_user").one()
        assert (row.old_value, row.new_value, row.target_name) == (None, scope, "דנה")
        with pytest.raises(HTTPException):
            RP.update_pos_user(str(w.shop.id), str(dana.id),
                               PosUserUpdate.model_validate({"tableScope": {"zoneIds": [str(uuid.uuid4())]}}),
                               current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)

    def test_archived_ids_are_dropped_when_read_and_when_saved(self, floor):
        w = floor
        from app.routers import machines as RM
        from app.routers import pos_users as RP
        from app.schemas.pos_user import PosUserUpdate

        scope = {"zoneIds": [str(w.l2.id)], "tableIds": [str(w.t[30].id), str(w.t[31].id)]}
        self.put(w, w.a, scope)
        T.archive_table(w.db, w.t[31])
        w.db.commit()
        # Read: what the device sees of it (§14.1).
        got = RM.get_machine_table_scope(w.a.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert got["device"]["tableScope"] == {"zoneIds": [str(w.l2.id)], "tableIds": [str(w.t[30].id)]}
        # Saved again as it was read before the archive: not refused, the archived table dropped.
        out = self.put(w, w.a, scope)
        assert out["devices"][0]["tableScope"]["tableIds"] == [str(w.t[30].id)]
        w.db.refresh(w.a)
        assert w.a.table_scope["tableIds"] == [str(w.t[30].id)]
        # The employee's card the same; an id the shop never had is still refused.
        dana = user(w, "דנה")
        RP.update_pos_user(str(w.shop.id), str(dana.id), PosUserUpdate.model_validate({"tableScope": scope}),
                           current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        w.db.refresh(dana)
        assert dana.table_scope["tableIds"] == [str(w.t[30].id)]
        with pytest.raises(HTTPException) as e:
            self.put(w, w.a, {"zoneIds": [], "tableIds": [str(uuid.uuid4())]})
        assert e.value.detail["reason"] == "table_not_seen"
        tree = RP.pos_users_table_scope_tree(str(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert tree["devices"][0]["tableScope"]["tableIds"] == [str(w.t[30].id)]

    def test_a_booking_and_the_training_check_name_the_label(self, floor):
        w = floor
        from app.services import training_mode as TM

        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        w.db.commit()
        reservation = TableReservation(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=t.id,
            reserved_at=NOW + timedelta(hours=2), duration_minutes=90, guests=2, customer_name="כהן", status="booked",
        )
        w.db.add(reservation)
        w.db.commit()
        row = T.reservation_out(reservation, t)
        assert row["tableLabel"] == "3B" and row["tableNumber"] == t.number
        assert "tableLabel" not in T.reservation_out(reservation, w.t[30])
        enter(w, w.a, t)
        from test_tables import save

        save(w, w.a, t, uuid.uuid4(), None)
        blockers = [b for b in TM.blockers(w.db, w.shop) if b["code"] == TM.OPEN_TABLES]
        assert blockers and blockers[0]["tables"][0]["label"] == "3B"

    def test_who_sees_what(self, floor):
        w = floor
        self.put(w, w.a, {"zoneIds": [str(w.l2.id)], "tableIds": []})
        got = R.get_table_scopes(shop_id=w.shop.id, current_user=w.admin, tenant_id=w.tenant.id, db=w.db)
        devices = {d["id"]: d for d in got["devices"]}
        assert devices[str(w.a.id)]["tableScope"]["zoneIds"] == [str(w.l2.id)] and devices[str(w.b.id)]["tableScope"] is None
        assert {d["machineId"] for d in got["oldDevices"]} == {str(w.a.id), str(w.b.id)}
        assert got["changes"][0]["targetId"] == str(w.a.id)
        assert [z["name"] for z in got["zones"]][-2:] == ["מפלס 2", "מפלס 3"]


# ── Notices ───────────────────────────────────────────────────────────────────


class TestNotices:
    def test_a_waiter_s_notice_is_shown_where_the_table_is_in_scope_and_never_lost(self, floor):
        w = floor
        from app.models.table_assignment import TableNotice
        from app.services import table_notices as TN

        dana = user(w, "דנה")
        n = TableNotice(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=w.t[30].id, kind=TN.KDS_READY,
            to_machine_id=None, to_pos_user_id=str(dana.id), text="מוכן", payload={}, dedupe_key="k1",
            created_at=T._now(), expires_at=T._now() + timedelta(minutes=10),
        )
        w.db.add(n)
        w.db.commit()
        device_scope(w, w.a, zones=[w.l2])
        # Till 2 sees it all: Till 1 (out of scope) is not shown it.
        assert TN.pending_for(w.db, w.a, str(dana.id)) == []
        assert [x.id for x in TN.pending_for(w.db, w.b, str(dana.id))] == [n.id]
        # No device sees the table: everyone is shown it.
        device_scope(w, w.b, zones=[w.l2])
        assert [x.id for x in TN.pending_for(w.db, w.a, str(dana.id))] == [n.id]

    def test_the_word_before_the_number(self, floor):
        w = floor
        from app.services import table_notices as TN

        t = T.create_table(w.db, w.l3, TableCreate(zoneId=w.l3.id, number="3B"))
        assert TN.table_words(t) == "שולחן 3B" and TN.table_words(t, term="תא") == "תא 3B"
        set_param(w, "tableTerm", "shop", w.shop.id, "תא")
        assert TN.shop_term(w.db, w.shop.id) == "תא"


# ── Migration ─────────────────────────────────────────────────────────────────

_NO_PROXY = object()


def _render(*args) -> str:
    """
    `alembic upgrade --sql` from this checkout's own path (`absolute()`, never `resolve()`: a subst drive resolves to
    the long path), always in PostgreSQL's dialect; alembic's proxies and the loggers put back as they were (the
    pattern of tests/test_fire_flow_settings.py).
    """
    import io
    import logging

    import alembic.context
    import alembic.op
    from alembic import command
    from alembic.config import Config

    from app.config import get_settings

    here = pathlib.Path(__file__).absolute().parents[1]
    buf = io.StringIO()
    cfg = Config(str(here / "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", str(here / "alembic"))
    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    settings = get_settings()
    url = settings.database_url
    proxies = {m: vars(m).get("_proxy", _NO_PROXY) for m in (alembic.context, alembic.op)}
    try:
        settings.database_url = "postgresql://render-only/offline"
        command.upgrade(cfg, *args, sql=True)
    finally:
        settings.database_url = url
        for module, proxy in proxies.items():
            if proxy is _NO_PROXY:
                vars(module).pop("_proxy", None)
            else:
                vars(module)["_proxy"] = proxy
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


class TestMigration:
    def test_one_head_on_main_s(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        here = pathlib.Path(__file__).absolute().parents[1]
        cfg = Config(str(here / "alembic.ini"))
        cfg.set_main_option("script_location", str(here / "alembic"))
        script = ScriptDirectory.from_config(cfg)
        heads = script.get_heads()
        assert len(heads) == 1
        line = {r.revision for r in script.walk_revisions("base", heads[0])}
        assert {"e7c4a1b9d3f6", "6b3b29c7bc5b"} <= line
        assert script.get_revision("e7c4a1b9d3f6").down_revision == "6b3b29c7bc5b"

    def test_add_only_on_postgres(self):
        sql = _render("6b3b29c7bc5b:e7c4a1b9d3f6")
        assert "ALTER TABLE pos_machines ADD COLUMN table_scope JSONB" in sql
        assert "ALTER TABLE pos_users ADD COLUMN table_scope JSONB" in sql
        assert "ALTER TABLE dining_tables ADD COLUMN label VARCHAR(12)" in sql
        assert "ALTER TABLE dining_tables ADD COLUMN label_key VARCHAR(12)" in sql
        assert "CREATE UNIQUE INDEX uq_dining_tables_shop_live_label ON dining_tables (shop_id, label_key)" in sql
        assert "WHERE archived_at IS NULL AND label_key IS NOT NULL" in sql
        assert "ALTER TABLE table_orders ADD COLUMN table_label VARCHAR(12)" in sql
        assert "CREATE TABLE table_scope_changes" in sql
        # Add-only: no row of anyone's changes (the one UPDATE is alembic's own version row).
        assert sql.count("UPDATE ") == 1 and "UPDATE alembic_version" in sql and "DROP " not in sql
