"""
"שיוך שולחנות ואזורים למלצר" and "שולחן תפוס" (P:/specs/table-waiter-assignment.md; app/services/
table_assignments.py, app/services/table_notices.py, app/services/tables.py).

What each class pins, and how it could look fine while doing damage:

* **Parameters** — the nine are built-ins with Hebrew labels, the spec's defaults (assignment off, the busy
  table blocked — on), only the codes the till knows, on the tables page in their own group, and the
  dashboard's warning for `tableBusyEntry` = off.
* **Permission** — TABLES.ASSIGN is (D, D, A, A); the till's write needs the till user who holds it alone.
* **Assignments** — a zone or a table (never both), `single` replaces, `multi` adds, unassign and "נקה הכל";
  a table's own beats its zone's; an archived target or an inactive waiter drops out.
* **Resets** — the shop's Z releases what was made before it (a till's Z only once the shop's day is over),
  an earlier business day no longer holds (`z`), another calendar day (`day`), `never` holds; the clock-out
  releases the waiter's under `release` and only theirs.
* **Copy** — from yesterday's final set, from the set the last Z ended; nothing to copy is refused.
* **Sync** — the tables state carries the `assignment` block and each table's only where the till's mode is
  on (off: the state of today, plus `busy`); per point of sale; a write wakes the shop.
* **LAN mirror** — rows by id, a release final, `single` keeps the latest, foreign rows skipped; the host
  seed carries them; only a LAN / single till reports.
* **Owner** — a new order on an assigned table is the assigned waiter's (`assigned`), the opener's
  (`opener`), the named waiter's always.
* **Busy table (§8)** — the lock names the device and the employee, `since` survives heartbeats, an employee
  switch wakes the others; the 409 says what the till may offer; `off` does not block; a lock that ran out
  unreleased is named (`staleLock`); "בקש מדנה לצאת" reaches the holder and its answer comes back.
* **Notices (§5)** — "מוכן להגשה" and "שולחן מתעכב" for the assigned waiter only with the notify on, once.
* **Dashboard** — read with the tables, write with `tables_manage`; the live view's holder and assignment;
  the waiter's colour on the employee card; "החלף מלצר" with "גם שיוך".
* **Migration** — the single head, on the release's.

Runs on the in-memory SQLite world of tests/shift_world.py (the tables tests' `w`).
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.pos_user import PosUser, PosUserRole
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.table_assignment import TableAssignment
from app.models.tables import DiningTable, TableOrder
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import tables as R
from app.schemas.tables import (
    DashboardAssignmentCopyIn,
    DashboardAssignmentsIn,
    TableAssignmentCopyIn,
    TableAssignmentsIn,
    TableAssignmentsReportIn,
    TableCreate,
    TableEnterIn,
    TableEntryRequestIn,
    TableHeartbeatIn,
    TableNoticeAnswerIn,
    ZoneCreate,
)
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import table_assignments as TAS
from app.services import table_notices as TN
from app.services import table_restore as TRS
from app.services import tables as T
from app.services import till_parameters as TP
from app.services import till_permissions as PERM
from shift_world import NOW
from test_tables import SYNCED, enter, refused, run, save, set_param, w  # noqa: F401 - the world


# ── Helpers ───────────────────────────────────────────────────────────────────


def waiter(w, first, last=None, *, created=None):
    pu = PosUser(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username=f"u{uuid.uuid4().hex[:8]}",
        first_name=first, last_name=last, pin_hash="x", role=PosUserRole.CASHIER, is_active=True,
        created_at=created or (NOW - timedelta(days=30)),
    )
    w.db.add(pu)
    w.db.commit()
    return pu


@pytest.fixture
def a(w):
    """The world with assignment on (`highlight`) at the shop, a garden zone of tables 20–21, and two waiters."""
    set_param(w, TAS.MODE_KEY, "shop", w.shop.id, TAS.MODE_HIGHLIGHT)
    w.garden = T.create_zone(w.db, w.shop, ZoneCreate(shopId=w.shop.id, name="גינה", layout="grid"))
    w.t[20] = T.create_table(w.db, w.garden, TableCreate(zoneId=w.garden.id, number=20))
    w.t[21] = T.create_table(w.db, w.garden, TableCreate(zoneId=w.garden.id, number=21))
    w.db.commit()
    w.dana = waiter(w, "דנה", "כהן", created=NOW - timedelta(days=20))
    w.yossi = waiter(w, "יוסי", "לוי", created=NOW - timedelta(days=10))
    return w


def ch(action="assign", *, user=None, table=None, zone=None):
    return {
        "action": action,
        "posUserId": str(user.id) if user is not None else None,
        "tableId": str(table.id) if table is not None else None,
        "zoneId": str(zone.id) if zone is not None else None,
    }


def assign(w, *changes, till=None, by=None, clear=False):
    till = till or w.a
    body = TableAssignmentsIn(changes=list(changes), clear=clear)
    return R.till_assign_tables(str(till.id), body, machine=till, operator_id=str((by or w.manager).id), db=w.db)


def state(w, till=None):
    return T.till_state(w.db, till or w.a)


def table_of(out, number):
    return next(t for t in out["tables"] if t["number"] == number)


def assigned(w, number, till=None):
    a = table_of(state(w, till), number).get("assignment")
    return (a["via"], a["posUserIds"]) if a else None


def live(w):
    return w.db.query(TableAssignment).filter(TableAssignment.released_at.is_(None)).all()


def replace_param(w, key, scope_type, scope_id, value):
    """A parameter's value at one level, replacing the one there."""
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == w.params[key].id, TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete(synchronize_session=False)
    w.db.commit()
    set_param(w, key, scope_type, scope_id, value)


# ── Parameters ────────────────────────────────────────────────────────────────


class TestParameters:
    def test_the_nine_are_builtins_with_the_spec_defaults(self, w):
        params = {p.key: p for p in w.db.query(TillParameter).all()}
        expected = {
            "tableAssignmentMode": "off", "tableAssignmentUnassigned": "open", "tableAssignmentOwner": "assigned",
            "tableAssignmentReset": "z", "tableAssignmentOnClockOut": "keep", "tableAssignmentMulti": "single",
            "tableAssignmentNotify": False, "tableBusyEntry": "block", "tableBusyShowHolder": True,
        }
        for key, default in expected.items():
            assert params[key].default_value == default, key
            assert any("\u0590" <= ch <= "\u05ff" for ch in params[key].label), key
            assert params[key].description and len(params[key].description) > 40, key
        assert params["tableBusyEntry"].enum_options == ["block", "request", "view", "off"]
        assert params["tableAssignmentMode"].enum_options == ["off", "highlight", "restrict"]
        assert TP.enum_labels("tableBusyEntry")["block"].startswith("חסימה")

    def test_only_the_codes_the_till_knows(self):
        assert TP.validate_keyed_value("tableBusyEntry", "request") == "request"
        for key, bad in (("tableBusyEntry", "maybe"), ("tableAssignmentMode", "on"), ("tableAssignmentReset", "week")):
            with pytest.raises(TP.TillParameterValueError):
                TP.validate_keyed_value(key, bad)

    def test_unknown_values_read_as_the_defaults(self):
        cfg = TAS.config_of({"tableAssignmentMode": "weird", "tableBusyShowHolder": None, "tableBusyEntry": 3})
        assert (cfg.mode, cfg.busy_entry, cfg.busy_show_holder, cfg.notify) == ("off", "block", True, False)
        assert TAS.config_of({"tableBusyShowHolder": False}).busy_show_holder is False

    def test_the_tables_page_edits_them_in_their_group_with_the_off_warning(self, w):
        view = TRS.level_view(w.db, "shop", w.shop.id)
        assert {"key": "waiters", "label": "שיוך מלצרים ושולחן תפוס"} in view["groups"]
        mine = [p for p in view["parameters"] if p["group"] == "waiters"]
        assert [p["key"] for p in mine] == list(TAS.LEVEL_KEYS)
        busy = next(p for p in mine if p["key"] == "tableBusyEntry")
        assert "לא בטוח" in busy["optionWarnings"]["off"]
        assert view["inherited"]["tableBusyEntry"] == "block"
        TRS.save_values(w.db, "shop", w.shop.id, {"tableBusyEntry": "request"}, user=w.admin)
        assert TRS.level_view(w.db, "shop", w.shop.id)["own"]["tableBusyEntry"] == "request"
        with pytest.raises(TP.TillParameterValueError):
            TRS.save_values(w.db, "shop", w.shop.id, {"tableBusyEntry": "nope"}, user=w.admin)

    def test_the_parameters_page_carries_the_warning_too(self):
        assert TP.option_warnings("tableBusyEntry")["off"].startswith("לא בטוח")
        assert TP.option_warnings("tablesMode") is None


# ── Permission ────────────────────────────────────────────────────────────────


class TestPermission:
    def test_the_spec_matrix(self):
        spec = PERM.PERMISSIONS_BY_CODE["TABLES.ASSIGN"]
        assert spec.label == "שיוך שולחנות למלצרים" and spec.group == "tables"
        got = tuple(PERM.DEFAULTS[k]["TABLES.ASSIGN"] for k in (PERM.WAITER, PERM.CASHIER, PERM.SUPERVISOR, PERM.MANAGER))
        assert got == (PERM.DENY, PERM.DENY, PERM.ALLOW, PERM.ALLOW)
        assert PERM.DEFAULTS[PERM.LEGACY_CASHIER]["TABLES.ASSIGN"] == PERM.APPROVAL
        assert PERM.DEFAULTS[PERM.LEGACY_MANAGER]["TABLES.ASSIGN"] == PERM.ALLOW

    def test_the_till_write_needs_the_permission(self, a):
        e = refused(assign, a, ch(user=a.dana, zone=a.garden), by=a.cashier)
        assert e.status_code == 401 and e.detail == "elevation_required"
        e = refused(R.till_assign_tables, str(a.a.id), TableAssignmentsIn(changes=[ch(user=a.dana, zone=a.garden)]),
                    machine=a.a, operator_id=None, db=a.db)
        assert e.status_code == 401
        assert live(a) == []
        assert assign(a, ch(user=a.dana, zone=a.garden))["changed"] == 1

    def test_a_till_out_of_the_cloud_tables_keeps_its_own(self, a):
        set_param(a, "tablesMode", "machine", a.b.id, "קופה אחת")
        e = refused(assign, a, ch(user=a.dana, zone=a.garden), till=a.b)
        assert e.status_code == 409 and e.detail == {"code": "tables_not_synced"}


# ── Assignments ───────────────────────────────────────────────────────────────


class TestAssignments:
    def test_a_zone_covers_its_tables_and_a_table_beats_it(self, a):
        out = assign(a, ch(user=a.dana, zone=a.garden), ch(user=a.yossi, table=a.t[21]))
        assert out["changed"] == 2 and len(out["assignments"]) == 2
        assert assigned(a, 20) == ("zone", [str(a.dana.id)])
        assert assigned(a, 21) == ("table", [str(a.yossi.id)])
        assert assigned(a, 12) is None
        # A table added to the zone later is covered too.
        later = T.create_table(a.db, a.garden, TableCreate(zoneId=a.garden.id, number=22))
        a.db.commit()
        assert assigned(a, 22) == ("zone", [str(a.dana.id)])
        assert later is not None

    def test_single_replaces_multi_adds_the_first_is_the_main(self, a):
        assign(a, ch(user=a.dana, table=a.t[12]))
        assign(a, ch(user=a.yossi, table=a.t[12]))
        assert assigned(a, 12) == ("table", [str(a.yossi.id)])
        replaced = a.db.query(TableAssignment).filter(TableAssignment.released_reason == "replaced").one()
        assert replaced.pos_user_id == a.dana.id and replaced.released_by == "מנהלת רותי"
        set_param(a, TAS.MULTI_KEY, "shop", a.shop.id, TAS.MULTI_MULTI)
        a.clock.advance(seconds=1)
        assign(a, ch(user=a.dana, table=a.t[12]))
        assert assigned(a, 12) == ("table", [str(a.yossi.id), str(a.dana.id)])

    def test_assigning_twice_is_one_assignment(self, a):
        assign(a, ch(user=a.dana, table=a.t[12]))
        assert assign(a, ch(user=a.dana, table=a.t[12]))["changed"] == 0
        assert len(live(a)) == 1

    def test_unassign_one_or_everyone_and_clear(self, a):
        set_param(a, TAS.MULTI_KEY, "shop", a.shop.id, TAS.MULTI_MULTI)
        assign(a, ch(user=a.dana, table=a.t[12]), ch(user=a.yossi, table=a.t[12]), ch(user=a.dana, zone=a.garden))
        assign(a, ch("unassign", user=a.dana, table=a.t[12]))
        assert assigned(a, 12) == ("table", [str(a.yossi.id)])
        assign(a, ch("unassign", table=a.t[12]))
        assert assigned(a, 12) is None
        out = assign(a, clear=True)
        assert out["assignments"] == [] and out["changed"] == 1
        assert {r.released_reason for r in a.db.query(TableAssignment).all()} == {"unassigned", "clear"}

    def test_refusals(self, a):
        other = T.create_zone(a.db, a.other_shop, ZoneCreate(shopId=a.other_shop.id, name="אחר", layout="grid"))
        a.db.commit()
        assert refused(assign, a, ch(user=a.dana, zone=other)).detail == {"code": "zone_not_found"}
        assert refused(assign, a, {"action": "assign", "posUserId": str(a.dana.id), "tableId": str(uuid.uuid4())}).detail == {
            "code": "table_not_found"}
        gone = waiter(a, "עזב")
        gone.is_active = False
        a.db.commit()
        assert refused(assign, a, ch(user=gone, table=a.t[1])).detail == {"code": "waiter_not_found"}
        with pytest.raises(Exception):
            TableAssignmentsIn(changes=[{"action": "assign", "posUserId": str(a.dana.id), "tableId": str(a.t[1].id),
                                         "zoneId": str(a.garden.id)}])
        # All or nothing: the good change before the bad one is not kept.
        refused(assign, a, ch(user=a.dana, table=a.t[1]), ch(user=gone, table=a.t[2]))
        assert live(a) == []

    def test_an_archived_target_or_a_waiter_gone_drops_out(self, a):
        assign(a, ch(user=a.dana, table=a.t[3]), ch(user=a.yossi, table=a.t[2]))
        T.archive_table(a.db, a.t[3])
        a.yossi.is_active = False
        a.db.commit()
        out = state(a)
        assert all(t["number"] != 3 for t in out["tables"]) and assigned(a, 2) is None
        assert out["assignment"]["rows"] == []
        TAS.sweep(TAS._Ctx.of(a.db, a.shop, T._now()))
        assert {r.released_reason for r in a.db.query(TableAssignment).all()} >= {"target_gone"}

    def test_a_write_wakes_every_till_of_the_shop(self, a):
        a.signals.clear()
        assign(a, ch(user=a.dana, table=a.t[12]))
        assert a.signals, "the tables signal"


# ── Resets ────────────────────────────────────────────────────────────────────


def z_of(shop, closed_at, machine=None):
    return SimpleNamespace(id=uuid.uuid4(), shop_id=shop.id, closed_at=closed_at, machine_id=machine.id if machine else None)


class TestResets:
    def test_the_shops_z_releases_what_was_made_before_it(self, a):
        assign(a, ch(user=a.dana, zone=a.garden), ch(user=a.yossi, table=a.t[12]))
        z_at = NOW + timedelta(minutes=5)
        a.clock.advance(minutes=10)
        assign(a, ch(user=a.dana, table=a.t[1]))  # after the Z
        assert TAS.after_z(a.db, z_of(a.shop, z_at), []) == 2
        a.db.commit()
        rows = a.db.query(TableAssignment).all()
        assert sorted((r.released_reason or "live") for r in rows) == ["live", "z", "z"]
        assert len({r.released_at for r in rows if r.released_reason == "z"}) == 1
        assert assigned(a, 1) == ("table", [str(a.dana.id)]) and assigned(a, 20) is None

    def test_a_tills_z_releases_only_once_the_shops_day_is_over(self, a):
        assign(a, ch(user=a.dana, zone=a.garden))
        a.shift(a.b, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=2))
        a.db.commit()
        assert TAS.after_z(a.db, z_of(a.shop, NOW + timedelta(minutes=1), a.a), [a.a]) == 0
        assert len(live(a)) == 1
        assert TAS.after_z(a.db, z_of(a.shop, NOW + timedelta(minutes=1), a.a), [a.a, a.b]) == 1

    def test_not_under_another_reset(self, a):
        set_param(a, TAS.RESET_KEY, "shop", a.shop.id, TAS.RESET_NEVER)
        assign(a, ch(user=a.dana, zone=a.garden))
        assert TAS.after_z(a.db, z_of(a.shop, NOW + timedelta(minutes=1)), []) == 0

    def test_z_an_earlier_business_day_no_longer_holds(self, a):
        assign(a, ch(user=a.dana, zone=a.garden))
        # 21:00 local; the business day ends at 04:00 — at 03:59 it still holds, at 04:01 not.
        a.clock.advance(hours=6, minutes=59)
        assert assigned(a, 20) == ("zone", [str(a.dana.id)])
        a.clock.advance(minutes=2)
        assert assigned(a, 20) is None

    def test_day_resets_at_midnight_never_holds(self, a):
        set_param(a, TAS.RESET_KEY, "shop", a.shop.id, TAS.RESET_DAY)
        assign(a, ch(user=a.dana, zone=a.garden))
        a.clock.advance(hours=2, minutes=59)  # 23:59 local
        assert assigned(a, 20) is not None
        a.clock.advance(minutes=2)
        assert assigned(a, 20) is None
        replace_param(a, TAS.RESET_KEY, "shop", a.shop.id, TAS.RESET_NEVER)
        a.clock.advance(days=5)
        assert assigned(a, 20) == ("zone", [str(a.dana.id)])

    def test_the_clock_out_releases_the_waiters_under_release(self, a):
        assign(a, ch(user=a.dana, zone=a.garden), ch(user=a.yossi, table=a.t[12]))
        shift = SimpleNamespace(id=uuid.uuid4(), shop_id=a.shop.id, pos_user_id=a.dana.id,
                                clock_out_at=NOW + timedelta(minutes=30), closed_by_name="דנה כהן")
        assert TAS.on_clock_out(a.db, shift, shift.clock_out_at) == 0  # keep, the default
        set_param(a, TAS.CLOCK_OUT_KEY, "shop", a.shop.id, TAS.CLOCK_OUT_RELEASE)
        assert TAS.on_clock_out(a.db, shift, shift.clock_out_at) == 1
        a.db.commit()
        assert [r.pos_user_id for r in live(a)] == [a.yossi.id]
        gone = a.db.query(TableAssignment).filter(TableAssignment.released_reason == "clock_out").one()
        assert gone.pos_user_id == a.dana.id

    def test_the_attendance_clock_out_calls_it(self, a, monkeypatch):
        from app.services import attendance

        calls = []
        monkeypatch.setattr(TAS, "on_clock_out", lambda db, shift, at, now=None: calls.append((shift, at)))
        shift = SimpleNamespace(clock_out_at=NOW)
        attendance._release_table_assignments(a.db, shift, NOW)
        assert calls == [(shift, NOW)]


# ── Copy ──────────────────────────────────────────────────────────────────────


def copy(w, source, till=None, by=None):
    till = till or w.a
    return R.till_copy_assignments(str(till.id), TableAssignmentCopyIn(**{"from": source}), machine=till,
                                   operator_id=str((by or w.manager).id), db=w.db)


class TestCopy:
    def test_from_yesterday(self, a):
        assign(a, ch(user=a.dana, zone=a.garden), ch(user=a.yossi, table=a.t[12]), ch(user=a.dana, table=a.t[1]))
        assign(a, ch("unassign", table=a.t[1]))  # taken back by hand: not copied
        a.clock.advance(days=1)
        assert state(a)["assignment"]["rows"] == []
        out = copy(a, "yesterday")
        assert out["copied"] == 2 and out["from"]["businessDay"] == "2026-09-27"
        assert assigned(a, 20) == ("zone", [str(a.dana.id)]) and assigned(a, 12) == ("table", [str(a.yossi.id)])
        assert assigned(a, 1) is None
        assert {r.source for r in live(a)} == {"copy"}

    def test_from_the_set_the_last_z_ended(self, a):
        assign(a, ch(user=a.dana, zone=a.garden))
        TAS.after_z(a.db, z_of(a.shop, NOW + timedelta(minutes=1)), [])
        a.db.commit()
        a.clock.advance(minutes=5)
        assign(a, ch(user=a.yossi, table=a.t[12]))  # the next shift began
        sources = TAS.copy_sources(TAS._Ctx.of(a.db, a.shop, T._now()))
        assert sources["previous_shift"]["count"] == 1 and sources["previous_shift"]["endedAt"]
        out = copy(a, "previous_shift")
        assert out["copied"] == 1 and out["released"] == 1
        assert assigned(a, 20) == ("zone", [str(a.dana.id)]) and assigned(a, 12) is None

    def test_nothing_to_copy(self, a):
        assert refused(copy, a, "yesterday").detail == {"code": "nothing_to_copy", "source": "yesterday"}
        assert refused(copy, a, "previous_shift", by=a.cashier).status_code == 401


# ── The tills' state ──────────────────────────────────────────────────────────


class TestSync:
    def test_off_sends_nothing_of_it_but_busy(self, w):
        out = state(w)
        assert "assignment" not in out
        assert all("assignment" not in t for t in out["tables"])
        assert out["busy"] == {"entry": "block", "showHolder": True}

    def test_on_the_block_and_each_table(self, a):
        assign(a, ch(user=a.dana, zone=a.garden))
        out = state(a)
        block = out["assignment"]
        assert block["mode"] == "highlight" and block["owner"] == "assigned" and block["businessDay"] == "2026-09-27"
        assert [r["zoneId"] for r in block["rows"]] == [str(a.garden.id)]
        names = {x["posUserId"]: x for x in block["waiters"]}
        dana = names[str(a.dana.id)]
        assert (dana["name"], dana["initials"]) == ("דנה כהן", "ד.כ") and dana["color"].startswith("#")
        assert dana["color"] != names[str(a.yossi.id)]["color"]
        assert table_of(out, 1)["assignment"] is None

    def test_per_till_and_per_point_of_sale(self, a):
        assign(a, ch(user=a.dana, zone=a.garden))
        set_param(a, TAS.MODE_KEY, "machine", a.b.id, TAS.MODE_OFF)
        assert "assignment" not in state(a, a.b)
        bar = ShopArea(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.shop.id, name="בר")
        a.db.add(bar)
        a.db.flush()
        a.garden.area_id = bar.id
        a.db.commit()
        out = state(a)
        assert out["assignment"]["rows"] == [] and all(t["number"] < 20 for t in out["tables"])

    def test_the_cached_state_carries_it_and_a_write_moves_the_version(self, a):
        from app.services import tables_state as TS

        TS.SNAPSHOTS.clear()
        before = TS.current_version(a.db, a.shop.id)
        assign(a, ch(user=a.dana, table=a.t[12]))
        version = TS.current_version(a.db, a.shop.id)
        assert version > before
        out, _tag = T.till_state_cached(a.db, a.a, version=version)
        assert table_of(out, 12)["assignment"] == {"via": "table", "posUserIds": [str(a.dana.id)]}


# ── The LAN host's copy ───────────────────────────────────────────────────────


def lan(w):
    set_param(w, "tablesMode", "machine", w.a.id, "רשת מקומית (קופה ראשית)")


def report(w, *rows, till=None):
    till = till or w.a
    return R.report_assignments(str(till.id), TableAssignmentsReportIn(assignments=list(rows)), machine=till, db=w.db)


def row(w, user, *, table=None, zone=None, rid=None, created=None, released=None, reason=None):
    return {
        "id": str(rid or uuid.uuid4()), "posUserId": str(user.id),
        "tableId": str(table.id) if table is not None else None, "zoneId": str(zone.id) if zone is not None else None,
        "businessDay": "2026-09-27", "assignedBy": "רותי", "createdAt": (created or NOW).isoformat(),
        "releasedAt": released.isoformat() if released else None, "releasedReason": reason,
    }


class TestLanMirror:
    def test_rows_by_id_a_release_is_final(self, a):
        lan(a)
        rid = uuid.uuid4()
        out = report(a, row(a, a.dana, zone=a.garden, rid=rid))
        assert out["accepted"] == [str(rid)] and [r["id"] for r in out["assignments"]] == [str(rid)]
        again = report(a, row(a, a.dana, zone=a.garden, rid=rid))
        assert len(again["assignments"]) == 1 and a.db.get(TableAssignment, rid).source == "lan"
        report(a, row(a, a.dana, zone=a.garden, rid=rid, released=NOW + timedelta(minutes=1), reason="unassigned"))
        assert report(a)["assignments"] == []
        # Live again from a stale copy: never.
        report(a, row(a, a.dana, zone=a.garden, rid=rid))
        assert a.db.get(TableAssignment, rid).released_at is not None

    def test_single_keeps_the_latest_made(self, a):
        lan(a)
        TAS.apply_changes(a.db, a.shop, [SimpleNamespace(action="assign", pos_user_id=a.yossi.id, table_id=a.t[12].id,
                                                          zone_id=None)], TAS.Who(name="דשבורד", source="dashboard"))
        a.db.commit()
        old = report(a, row(a, a.dana, table=a.t[12], created=NOW - timedelta(minutes=5)))
        assert [r["posUserId"] for r in old["assignments"]] == [str(a.yossi.id)]
        a.clock.advance(minutes=1)
        new = report(a, row(a, a.dana, table=a.t[12], created=NOW + timedelta(seconds=30)))
        assert [r["posUserId"] for r in new["assignments"]] == [str(a.dana.id)]

    def test_foreign_rows_are_skipped(self, a):
        lan(a)
        north = PosUser(id=uuid.uuid4(), tenant_id=a.tenant.id, shop_id=a.other_shop.id, username="n", pin_hash="x",
                        role=PosUserRole.CASHIER, is_active=True)
        a.db.add(north)
        a.db.commit()
        out = report(a, row(a, north, table=a.t[12]), row(a, a.dana, table=SimpleNamespace(id=uuid.uuid4())))
        assert len(out["skipped"]) == 2 and out["assignments"] == []

    def test_only_a_local_till_reports_and_the_host_seed_carries_them(self, a):
        assert refused(report, a).detail == {"code": "tables_not_local"}
        assign(a, ch(user=a.dana, zone=a.garden))
        lan(a)
        set_param(a, "tablesHostTill", "machine", a.a.id, True)
        seed = T.host_seed(a.db, a.a)
        assert [r["zoneId"] for r in seed["assignments"]] == [str(a.garden.id)]


# ── Owner ─────────────────────────────────────────────────────────────────────


class TestOwner:
    def test_a_new_order_is_the_assigned_waiters(self, a):
        assign(a, ch(user=a.dana, table=a.t[12]))
        enter(a, a.a, a.t[12], name="מנהלת")
        o = save(a, a.a, a.t[12], uuid.uuid4(), None, name="מנהלת")["order"]
        assert (o["waiterPosUserId"], o["waiterName"]) == (str(a.dana.id), "דנה כהן")
        assert o["openedByName"] == "מנהלת"

    def test_opener_and_the_named_waiter(self, a):
        assign(a, ch(user=a.dana, table=a.t[12]), ch(user=a.dana, table=a.t[1]))
        set_param(a, TAS.OWNER_KEY, "shop", a.shop.id, TAS.OWNER_OPENER)
        enter(a, a.a, a.t[12], name="יוסי")
        assert save(a, a.a, a.t[12], uuid.uuid4(), None, name="יוסי")["order"]["waiterName"] == "יוסי"
        replace_param(a, TAS.OWNER_KEY, "shop", a.shop.id, TAS.OWNER_ASSIGNED)
        enter(a, a.a, a.t[1], name="יוסי")
        from app.schemas.tables import TableSaveIn

        body = TableSaveIn(orderId=uuid.uuid4(), expectedVersion=None, requestId="r1", action="save", cartJson="{}",
                           itemCount=1, posUserId="pu-y", posUserName="יוסי", waiterPosUserId=str(a.yossi.id),
                           waiterPosUserName="יוסי לוי")
        out = R.save_table(str(a.a.id), a.t[1].id, body, BackgroundTasks(), machine=a.a, db=a.db)
        assert out["order"]["waiterName"] == "יוסי לוי"

    def test_off_is_today(self, w):
        enter(w, w.a, w.t[12], name="יוסי")
        assert save(w, w.a, w.t[12], uuid.uuid4(), None, name="יוסי")["order"]["waiterName"] == "יוסי"


# ── The busy table (§8) ───────────────────────────────────────────────────────


def heartbeat(w, till, table, name):
    return R.table_heartbeat(str(till.id), table.id, TableHeartbeatIn(posUserId="pu-" + name, posUserName=name),
                             machine=till, db=w.db)


class TestBusyTable:
    def test_the_lock_names_the_device_and_the_employee_since(self, w):
        enter(w, w.a, w.t[12], name="דנה כהן")
        w.clock.advance(minutes=1)
        heartbeat(w, w.a, w.t[12], "דנה כהן")
        e = refused(enter, w, w.b, w.t[12], name="יוסי")
        lock = e.detail["lock"]
        assert lock["deviceLabel"] == "קופה 1 (Till 1)" and lock["deviceShort"] == "ק1"
        assert (lock["posUserName"], lock["posUserInitials"]) == ("דנה כהן", "ד.כ")
        assert lock["holderText"] == "קופה 1 (Till 1) · דנה כהן" and lock["holderShort"] == "ק1 · ד.כ"
        assert lock["since"] == NOW.isoformat() == lock["acquiredAt"]
        assert lock["lastSeenAt"] == (NOW + timedelta(minutes=1)).isoformat()
        assert e.detail["busy"] == {"entry": "block", "showHolder": True, "canRequest": False, "canView": False,
                                    "canRelease": True}

    def test_an_employee_switch_is_the_locks_and_wakes_the_others(self, w):
        enter(w, w.a, w.t[12], name="דנה")
        w.signals.clear()
        out = heartbeat(w, w.a, w.t[12], "דנה")
        assert "_changed" not in out and w.signals == []
        heartbeat(w, w.a, w.t[12], "רון")
        assert w.signals and table_of(state(w, w.b), 12)["lock"]["posUserName"] == "רון"
        assert table_of(state(w, w.b), 12)["lock"]["since"] == NOW.isoformat()

    def test_request_and_view_say_what_the_till_may_offer(self, w):
        enter(w, w.a, w.t[12], name="דנה")
        set_param(w, TAS.BUSY_ENTRY_KEY, "machine", w.b.id, TAS.BUSY_REQUEST)
        e = refused(enter, w, w.b, w.t[12])
        assert e.detail["busy"]["canRequest"] is True and e.detail["busy"]["entry"] == "request"
        replace_param(w, TAS.BUSY_ENTRY_KEY, "machine", w.b.id, TAS.BUSY_VIEW)
        e = refused(enter, w, w.b, w.t[12])
        assert e.detail["busy"]["canView"] is True
        # "צפייה בלבד": the order read without a lock.
        assert R.peek_table_order(str(w.b.id), w.t[12].id, machine=w.b, db=w.db)["lock"]["mine"] is False

    def test_off_does_not_block_the_version_still_guards(self, w):
        enter(w, w.a, w.t[1], name="דנה")
        oid = uuid.uuid4()
        save(w, w.a, w.t[1], oid, None, name="דנה")
        enter(w, w.a, w.t[1], name="דנה")
        set_param(w, TAS.BUSY_ENTRY_KEY, "shop", w.shop.id, TAS.BUSY_OFF)
        out = enter(w, w.b, w.t[1], name="יוסי")
        assert out["shared"] is True and out["lock"]["machineId"] == str(w.a.id) and out["order"]["version"] == 1
        assert save(w, w.b, w.t[1], oid, 1, lines=("l1", "l2"), name="יוסי")["order"]["version"] == 2
        e = refused(save, w, w.a, w.t[1], oid, 1, lines=("l9",), name="דנה")
        assert e.detail["code"] == "table_version_conflict"

    def test_a_lock_that_ran_out_unreleased_is_named(self, w):
        enter(w, w.a, w.t[12], name="דנה")
        w.clock.advance(minutes=3)
        row = table_of(state(w, w.b), 12)
        assert row["lock"] is None and row["state"] != "locked"
        assert row["staleLock"]["holderText"] == "קופה 1 (Till 1) · דנה"
        assert row["staleLock"]["lastSeenAt"] == NOW.isoformat()
        assert "staleLock" not in table_of(state(w, w.a), 12)
        out = enter(w, w.b, w.t[12], name="יוסי")
        assert out["staleLock"]["machineId"] == str(w.a.id)
        assert "staleLock" not in table_of(state(w, w.b), 12)
        # A clean leave leaves nothing to name.
        R.release_table(str(w.b.id), w.t[12].id, BackgroundTasks(), None, machine=w.b, db=w.db)
        assert w.db.get(DiningTable, w.t[12].id).lock_seen_at is None


# ── "בקש מדנה לצאת" ───────────────────────────────────────────────────────────


def ask(w, till, table, name="יוסי"):
    return R.request_table_entry(str(till.id), table.id, TableEntryRequestIn(posUserId="pu-y", posUserName=name),
                                 machine=till, db=w.db)


class TestEntryRequest:
    def test_the_holder_is_asked_and_its_answer_comes_back(self, w, monkeypatch):
        from app.services import ably_notify

        sent = []
        monkeypatch.setattr(ably_notify, "publish_notify", lambda t, m, event, body: sent.append((m, event, body)))
        set_param(w, TAS.BUSY_ENTRY_KEY, "shop", w.shop.id, TAS.BUSY_REQUEST)
        enter(w, w.a, w.t[12], name="דנה")
        req = ask(w, w.b, w.t[12])["request"]
        assert req["text"] == "יוסי מבקש להיכנס לשולחן 12" and req["status"] == "pending"
        assert req["from"]["deviceLabel"] == "קופה 2 (Till 2)" and req["toMachineId"] == str(w.a.id)
        assert sent and sent[-1][:2] == (str(w.a.id), "table-notice") and sent[-1][2]["kind"] == "entry_request"
        # A second tap: the same request.
        assert ask(w, w.b, w.t[12])["request"]["id"] == req["id"]
        hb = heartbeat(w, w.a, w.t[12], "דנה")
        assert [r["id"] for r in hb["entryRequests"]] == [req["id"]]
        pulled = R.get_table_notices(str(w.a.id), pos_user_id="pu-d", machine=w.a, db=w.db)["notices"]
        assert [n["id"] for n in pulled] == [req["id"]]
        assert R.get_table_notices(str(w.b.id), pos_user_id=None, machine=w.b, db=w.db)["notices"] == []
        out = R.answer_table_notice(str(w.a.id), uuid.UUID(req["id"]), TableNoticeAnswerIn(answer="leaving", posUserName="דנה"),
                                    machine=w.a, db=w.db)
        assert out["notice"]["status"] == "leaving"
        assert sent[-1][:2] == (str(w.b.id), "table-notice") and sent[-1][2]["answer"] == "leaving"
        seen = R.get_table_notice(str(w.b.id), uuid.UUID(req["id"]), machine=w.b, db=w.db)["notice"]
        assert (seen["status"], seen["answeredByName"]) == ("leaving", "דנה")
        # Answered once; the asker cannot answer for the holder.
        e = refused(R.answer_table_notice, str(w.b.id), uuid.UUID(req["id"]), TableNoticeAnswerIn(answer="ignored"),
                    machine=w.b, db=w.db)
        assert e.status_code == 403

    def test_refusals_and_expiry(self, w):
        e = refused(ask, w, w.b, w.t[12])
        assert e.detail == {"code": "entry_request_off", "entry": "block"}
        set_param(w, TAS.BUSY_ENTRY_KEY, "shop", w.shop.id, TAS.BUSY_REQUEST)
        assert refused(ask, w, w.b, w.t[12]).detail["code"] == "table_not_locked"
        enter(w, w.a, w.t[12], name="דנה")
        req = ask(w, w.b, w.t[12])["request"]
        w.clock.advance(minutes=1, seconds=30)
        heartbeat(w, w.a, w.t[12], "דנה")
        w.clock.advance(minutes=1)
        assert heartbeat(w, w.a, w.t[12], "דנה")["entryRequests"] == []
        assert R.get_table_notice(str(w.b.id), uuid.UUID(req["id"]), machine=w.b, db=w.db)["notice"]["status"] == "expired"


# ── Notices for the assigned waiter (§5) ──────────────────────────────────────


def open_order(w, table, *, updated=None):
    o = TableOrder(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id, zone_id=table.zone_id,
                   table_number=table.number, status="open", source="synced", version=1, opened_at=NOW,
                   updated_at=updated or NOW, send_count=1)
    w.db.add(o)
    w.db.commit()
    return o


class TestNotices:
    def test_ready_tells_the_assigned_waiter_once_with_notify_on(self, a):
        assign(a, ch(user=a.dana, table=a.t[12]))
        o = open_order(a, a.t[12])
        korder = SimpleNamespace(id=uuid.uuid4(), source="table", source_ref=str(o.id), shop_id=a.shop.id, ready_at=NOW)
        assert TN.on_kds_ready(a.db, korder) == []
        set_param(a, TAS.NOTIFY_KEY, "shop", a.shop.id, True)
        made = TN.on_kds_ready(a.db, korder)
        assert [(n.kind, n.to_pos_user_id, n.text) for n in made] == [("kds_ready", str(a.dana.id), "מוכן להגשה — שולחן 12")]
        assert TN.on_kds_ready(a.db, korder) == []
        a.db.commit()
        # Shown wherever Dana is signed in; nowhere else.
        mine = R.get_table_notices(str(a.b.id), pos_user_id=str(a.dana.id), machine=a.b, db=a.db)["notices"]
        assert [n["kind"] for n in mine] == ["kds_ready"]
        assert R.get_table_notices(str(a.b.id), pos_user_id=str(a.yossi.id), machine=a.b, db=a.db)["notices"] == []

    def test_the_device_she_holds_a_table_on(self, a):
        set_param(a, TAS.NOTIFY_KEY, "shop", a.shop.id, True)
        assign(a, ch(user=a.dana, table=a.t[12]))
        R.enter_table(str(a.b.id), a.t[3].id, BackgroundTasks(), TableEnterIn(posUserId=str(a.dana.id), posUserName="דנה"),
                      machine=a.b, db=a.db)
        o = open_order(a, a.t[12])
        made = TN.notify_assigned(a.db, a.t[12], o, TN.KDS_READY, "x", "k1", ttl=TN.READY_TTL)
        assert made[0].to_machine_id == a.b.id

    def test_overdue_once_per_quiet_spell(self, a):
        set_param(a, TAS.NOTIFY_KEY, "shop", a.shop.id, True)
        assign(a, ch(user=a.dana, zone=a.garden))
        o = open_order(a, a.t[20], updated=NOW - timedelta(minutes=50))
        open_order(a, a.t[12], updated=NOW - timedelta(minutes=50))  # assigned to nobody
        made = TN.overdue_pass(a.db, now=NOW)
        assert [(n.kind, n.order_id) for n in made] == [("overdue", o.id)]
        assert "שולחן 20 מתעכב — 50 דק׳" in made[0].text
        a.db.commit()
        assert TN.overdue_pass(a.db, now=NOW + timedelta(minutes=1)) == []
        o.updated_at = NOW
        a.db.commit()
        assert TN.overdue_pass(a.db, now=NOW + timedelta(minutes=30)) == []
        assert len(TN.overdue_pass(a.db, now=NOW + timedelta(minutes=46))) == 1

    def test_the_worker_pass(self, a):
        from app.services import table_notices_worker as W

        assert W.run_once(lambda: a.db, now=NOW) == []


# ── Dashboard ─────────────────────────────────────────────────────────────────


def restricted(monkeypatch, sections):
    access = DA.EffectiveAccess(restricted=True, sections=sections, has_profile=True, full_access=False)
    monkeypatch.setattr(DA, "effective_access", lambda db, user: access)


class TestDashboard:
    def test_read_with_the_tables_write_with_tables_manage(self, a, monkeypatch):
        view = R.get_table_assignments(shop_id=a.shop.id, current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)
        assert view["canManage"] is True and view["config"]["mode"] == "highlight"
        assert view["copySources"] == {"yesterday": None, "previous_shift": None}
        body = DashboardAssignmentsIn(shopId=a.shop.id, changes=[ch(user=a.dana, zone=a.garden)])
        out = R.post_table_assignments(body, BackgroundTasks(), current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)
        row = a.db.get(TableAssignment, uuid.UUID(out["assignments"][0]["id"]))
        assert (row.source, row.assigned_by, row.assigned_by_user_id) == ("dashboard", "admin", a.admin.id)
        restricted(monkeypatch, {"tables": DS.EDIT})
        view = R.get_table_assignments(shop_id=a.shop.id, current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)
        assert view["canManage"] is False and view["tables"][str(a.t[20].id)]["via"] == "zone"
        with pytest.raises(HTTPException) as e:
            R.post_table_assignments(body, BackgroundTasks(), current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)
        assert e.value.status_code == 403 and e.value.detail["section"] == "tables_manage"
        with pytest.raises(HTTPException):
            R.copy_table_assignments(DashboardAssignmentCopyIn(shopId=a.shop.id, **{"from": "yesterday"}),
                                     BackgroundTasks(), current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)

    def test_the_live_view_names_the_holder_and_the_assignment(self, a):
        assign(a, ch(user=a.dana, zone=a.garden))
        enter(a, a.a, a.t[20], name="דנה כהן")
        view = T.live(a.db, a.shop)
        row = next(t for t in view["tables"] if t["number"] == 20)
        assert row["holder"]["text"] == "קופה 1 (Till 1) · דנה כהן"
        assert row["assignment"] == {"via": "zone", "posUserIds": [str(a.dana.id)]}
        assert view["assignment"]["mode"] == "highlight" and view["busy"]["showHolder"] is True
        assert {x["posUserId"] for x in view["assignment"]["waiters"]} >= {str(a.dana.id), str(a.yossi.id)}
        set_param(a, TAS.BUSY_SHOW_HOLDER_KEY, "shop", a.shop.id, False)
        row = next(t for t in T.live(a.db, a.shop)["tables"] if t["number"] == 20)
        assert row["holder"] is None and row["heldBy"]

    def test_the_route_rules(self):
        assert DS.rule_for("GET", "/tables/assignments").level == DS.VIEW
        assert DS.rule_for("POST", "/tables/assignments").sections == ("tables",)
        assert DS.rule_for("POST", "/tables/assignments/copy").sections == ("tables",)

    def test_the_waiters_colour_on_the_employee_card(self, a):
        from app.routers import pos_users as PU
        from app.schemas.pos_user import PosUserUpdate

        auto = TAS.colors_of(TAS.shop_users(a.db, a.shop.id))
        assert len(set(auto.values())) == len(auto)
        out = PU.update_pos_user(str(a.shop.id), str(a.dana.id), PosUserUpdate(tableColor="#ABCDEF"),
                                 current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)
        assert (out.table_color, out.table_color_effective) == ("#abcdef", "#abcdef")
        set_param(a, TAS.MODE_KEY, "machine", a.a.id, TAS.MODE_HIGHLIGHT)
        dana = next(x for x in state(a)["assignment"]["waiters"] if x["posUserId"] == str(a.dana.id))
        assert dana["color"] == "#abcdef"
        out = PU.update_pos_user(str(a.shop.id), str(a.dana.id), PosUserUpdate(tableColor=""),
                                 current_user=a.admin, active_tenant_id=a.tenant.id, db=a.db)
        assert out.table_color is None and out.table_color_effective == auto[str(a.dana.id)]
        with pytest.raises(Exception):
            PosUserUpdate(tableColor="red")

    def test_set_waiter_with_its_assignment(self, a):
        from app.schemas.tables import TableActionIn
        from app.services import table_actions as TA

        assign(a, ch(user=a.yossi, table=a.t[12]))
        enter(a, a.a, a.t[12], name="יוסי")
        oid = uuid.uuid4()
        save(a, a.a, a.t[12], oid, None, action="leave", name="יוסי")
        o = a.db.get(TableOrder, oid)
        body = TableActionIn(orderId=oid, expectedVersion=o.version, requestId=uuid.uuid4(),
                             waiterPosUserId=a.dana.id, alsoAssignment=True)
        out = TA.perform(a.db, a.admin, a.shop, a.t[12], "set-waiter", body)
        a.db.commit()
        assert out["waiterName"] == "דנה כהן" and out["assignment"] is True
        assert assigned(a, 12) == ("table", [str(a.dana.id)])


# ── The migration ─────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_the_release():
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    line = {r.revision for r in script.walk_revisions("base", heads[0])}
    assert {"d8b3f1a6c2e4", "bb6205ba290c"} <= line
    assert script.get_revision("d8b3f1a6c2e4").down_revision == "bb6205ba290c"


def test_the_migration_renders_add_only():
    from pathlib import Path

    source = next((Path(__file__).absolute().parents[1] / "alembic" / "versions").glob("d8b3f1a6c2e4_*.py")).read_text("utf-8")
    for needle in ("table_assignments", "table_notices", "lock_seen_at", "table_color", "has_table"):
        assert needle in source
    assert "drop_" not in source.split("def downgrade")[0]
