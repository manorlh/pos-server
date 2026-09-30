"""
The till's printer state, from its heartbeat (docs/SHIFTS_API.md §1.6a).

What each class pins, and how it could look fine while doing damage:

* **Heartbeat** — the block is optional (an old till sends none), a snapshot, and never a
  422: an unknown status is "unknown", an over-long message is cut, a block that is not
  an object is ignored. A 422 here would show a till with a jammed printer as dead.
* **Machine fields** — list and detail carry the reading, null for a till that never sent one.
* **Flag** — `printer_problem` for no paper / overheated / error only, and never a colour:
  a till out of paper still sells, and a red light for it would hide a real outage.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody
from app.services import ably_notify
from app.services.machine_status import MachineFlag, StatusInput, resolve_status
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_transmit_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    world.now = datetime.now(timezone.utc)
    for till in world.tills + [world.other_till]:
        till.last_heartbeat_at = world.now - timedelta(seconds=10)
    return world


def beat(w, till, payload=None):
    body = MachineHeartbeatBody.model_validate(payload) if payload is not None else None
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db)


def detail(w, till):
    return machines_router.get_machine(
        machine_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )


def printer_of(block):
    return MachineHeartbeatBody.model_validate({"printer": block}).printer


def utc(moment):
    """SQLite hands a timestamp back naive; Postgres keeps the zone. Both are UTC here."""
    return moment if moment is None or moment.tzinfo else moment.replace(tzinfo=timezone.utc)


AT = "2026-10-01T10:00:00Z"
OK_AT = "2026-10-01T09:58:00Z"


class TestHeartbeat:
    def test_the_block_is_stored(self, w):
        till = w.tills[0]
        beat(w, till, {"printer": {
            "status": "no_paper", "code": 115, "message": "Out of paper",
            "at": AT, "lastPrintOkAt": OK_AT,
        }})

        assert till.printer_status == "no_paper" and till.printer_error_code == 115
        assert till.printer_message == "Out of paper"
        assert utc(till.printer_status_at) == datetime(2026, 10, 1, 10, 0, tzinfo=timezone.utc)
        assert utc(till.printer_last_ok_at) == datetime(2026, 10, 1, 9, 58, tzinfo=timezone.utc)
        # Our clock, not the till's.
        assert till.printer_reported_at is not None
        assert abs(utc(till.printer_reported_at) - datetime.now(timezone.utc)) < timedelta(minutes=1)

    def test_an_old_heartbeat_without_the_block_is_accepted_and_changes_nothing(self, w):
        till = w.tills[0]
        out = beat(w, till, {"appVersion": "0.1.150", "batteryPercent": 80})
        assert out["ok"] is True
        assert till.printer_status is None and till.printer_reported_at is None

        beat(w, till, {"printer": {"status": "ok", "at": AT}})
        beat(w, till, {"appVersion": "0.1.150"})
        beat(w, till)
        assert till.printer_status == "ok"

    def test_it_is_a_snapshot_an_absent_field_clears(self, w):
        till = w.tills[0]
        beat(w, till, {"printer": {"status": "error", "code": 120, "message": "jam", "at": AT}})
        beat(w, till, {"printer": {"status": "ok", "at": AT, "lastPrintOkAt": OK_AT}})
        assert till.printer_status == "ok"
        assert till.printer_error_code is None and till.printer_message is None

    @pytest.mark.parametrize("raw,stored", [
        ("ok", "ok"), ("no_paper", "no_paper"), ("overheated", "overheated"), ("error", "error"),
        ("unavailable", "unavailable"), ("unknown", "unknown"), (" No_Paper ", "no_paper"),
        ("no-paper", "no_paper"), ("jammed", "unknown"), ("", "unknown"), (None, "unknown"),
        (115, "unknown"), (["ok"], "unknown"), ({"s": 1}, "unknown"), (True, "unknown"),
    ])
    def test_an_unknown_status_is_stored_as_unknown_never_a_422(self, raw, stored):
        assert printer_of({"status": raw, "at": AT}).status == stored

    def test_a_missing_status_is_unknown(self):
        assert printer_of({"code": 115}).status == "unknown"

    def test_an_unknown_status_lands_in_the_column(self, w):
        till = w.tills[0]
        beat(w, till, {"printer": {"status": "paper_low_soon", "at": AT}})
        assert till.printer_status == "unknown"

    def test_a_long_message_is_cut_not_refused(self):
        p = printer_of({"status": "error", "message": "m" * 900})
        assert p.message == "m" * 200

    @pytest.mark.parametrize("raw,stored", [
        (115, 115), (116, 116), ("132", 132), (133.0, 133), (None, None),
        ("x", None), (1.5, None), (True, None), (2**31, None), ([115], None),
    ])
    def test_the_code_is_an_integer_or_null(self, raw, stored):
        assert printer_of({"status": "error", "code": raw}).code == stored

    def test_unreadable_fields_are_null_never_a_422(self):
        p = printer_of({"status": "ok", "message": {"a": 1}, "at": "soon", "lastPrintOkAt": [1]})
        assert p.status == "ok"
        assert p.message is None and p.at is None and p.last_print_ok_at is None

    @pytest.mark.parametrize("block", ["garbage", 5, ["x"], True])
    def test_a_block_that_is_not_an_object_is_ignored(self, w, block):
        till = w.tills[0]
        body = MachineHeartbeatBody.model_validate({"printer": block, "appVersion": "2.0"})
        assert body.printer is None and body.app_version == "2.0"
        beat(w, till, {"printer": block})
        assert till.printer_reported_at is None

    def test_an_explicit_null_block_changes_nothing(self, w):
        till = w.tills[0]
        beat(w, till, {"printer": {"status": "no_paper", "code": 115}})
        beat(w, till, {"printer": None})
        assert till.printer_status == "no_paper"

    def test_the_route_answers_with_a_bad_block(self, monkeypatch):
        """Through FastAPI: the body is parsed there, so this is where a 422 would come from."""
        from unittest.mock import MagicMock

        from fastapi.testclient import TestClient

        from app.database import get_db
        from app.main import app
        from app.middleware.auth import get_pos_machine_from_machine_token

        seen = []
        monkeypatch.setattr(machines_router, "update_machine_heartbeat", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "take_pending_close_shift", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "z_reported_through_sequence", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "recent_shift_zs", lambda *a, **k: [])
        monkeypatch.setattr(machines_router, "is_foreign_shift", lambda *a, **k: False)
        monkeypatch.setattr(machines_router.transmit_requests, "take_pending", lambda *a, **k: None)
        monkeypatch.setattr(machines_router, "apply_printer_block", lambda m, block: seen.append(block))
        app.dependency_overrides[get_db] = lambda: MagicMock()
        app.dependency_overrides[get_pos_machine_from_machine_token] = lambda: MagicMock()
        try:
            client = TestClient(app)
            r = client.post("/api/v1/machines/me/heartbeat", json={
                "printer": {"status": "on_fire", "code": "many", "message": "x" * 500,
                            "at": "2026-10-01T13:00:00+03:00", "lastPrintOkAt": None},
            })
            r2 = client.post("/api/v1/machines/me/heartbeat", json={"printer": "nope"})
            r3 = client.post("/api/v1/machines/me/heartbeat", json={"appVersion": "0.1.100"})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200 and r2.status_code == 200 and r3.status_code == 200
        assert len(seen) == 1
        assert seen[0].status == "unknown" and seen[0].code is None and len(seen[0].message) == 200
        assert seen[0].at == datetime(2026, 10, 1, 10, 0, tzinfo=timezone.utc)


class TestMachineFields:
    def test_a_till_that_never_reported(self, w):
        row = detail(w, w.tills[0])
        for key in ("printerStatus", "printerErrorCode", "printerMessage", "printerStatusAt",
                    "printerLastOkAt", "printerReportedAt"):
            assert row[key] is None
        assert MachineFlag.PRINTER_PROBLEM not in row["statusFlags"]

    def test_detail_carries_the_reading_and_the_flag(self, w):
        till = w.tills[0]
        beat(w, till, {"printer": {"status": "no_paper", "code": 115, "message": "no paper",
                                   "at": AT, "lastPrintOkAt": OK_AT}})
        row = detail(w, till)
        assert row["printerStatus"] == "no_paper" and row["printerErrorCode"] == 115
        assert row["printerMessage"] == "no paper"
        assert utc(row["printerStatusAt"]) == datetime(2026, 10, 1, 10, 0, tzinfo=timezone.utc)
        assert utc(row["printerLastOkAt"]) == datetime(2026, 10, 1, 9, 58, tzinfo=timezone.utc)
        assert row["printerReportedAt"] is not None
        assert MachineFlag.PRINTER_PROBLEM in row["statusFlags"]

        beat(w, till, {"printer": {"status": "ok", "at": AT}})
        assert MachineFlag.PRINTER_PROBLEM not in detail(w, till)["statusFlags"]

    def test_the_list_carries_it_too(self, w):
        till = w.tills[0]
        beat(w, till, {"printer": {"status": "overheated", "code": 116, "at": AT}})
        rows = machines_router.list_machines(
            skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
            include_inactive=False, area_id=None, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        mine = next(r for r in rows if r["id"] == till.id)
        other = next(r for r in rows if r["id"] == w.tills[1].id)
        assert mine["printerStatus"] == "overheated" and mine["printerErrorCode"] == 116
        assert MachineFlag.PRINTER_PROBLEM in mine["statusFlags"]
        assert other["printerStatus"] is None
        assert MachineFlag.PRINTER_PROBLEM not in other["statusFlags"]

    def test_the_response_model_keeps_the_fields(self, w):
        """FastAPI filters through POSMachineResponse: a field missing there never leaves."""
        from app.schemas.pos_machine import POSMachineResponse

        till = w.tills[0]
        beat(w, till, {"printer": {"status": "error", "code": 120, "message": "m", "at": AT,
                                   "lastPrintOkAt": OK_AT}})
        out = POSMachineResponse.model_validate(detail(w, till)).model_dump(by_alias=True)
        assert out["printerStatus"] == "error" and out["printerErrorCode"] == 120
        assert out["printerMessage"] == "m"
        assert out["printerStatusAt"] is not None and out["printerLastOkAt"] is not None
        assert out["printerReportedAt"] is not None
        assert "printer_problem" in out["statusFlags"]


# ── The flag ────────────────────────────────────────────────────────────────


NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def resolved(**kw):
    data = StatusInput(is_active=True, pairing_status="assigned", last_heartbeat_at=NOW, **kw)
    return resolve_status(data, now=NOW)


class TestFlag:
    @pytest.mark.parametrize("status", ["no_paper", "overheated", "error"])
    def test_a_problem_is_flagged(self, status):
        assert resolved(shift_open=True, printer_status=status).flags == [MachineFlag.PRINTER_PROBLEM]

    @pytest.mark.parametrize("status", [None, "ok", "unavailable", "unknown"])
    def test_anything_else_is_not(self, status):
        assert MachineFlag.PRINTER_PROBLEM not in resolved(shift_open=True, printer_status=status).flags

    @pytest.mark.parametrize("shift_open", [True, False])
    def test_flags_never_change_the_colour(self, shift_open):
        calm = resolved(shift_open=shift_open, printer_status="ok")
        alarmed = resolved(shift_open=shift_open, printer_status="no_paper")
        assert calm.status == alarmed.status
        assert MachineFlag.PRINTER_PROBLEM in alarmed.flags

    def test_nor_on_an_offline_till(self):
        stale = NOW - timedelta(hours=1)
        data = dict(is_active=True, pairing_status="assigned", last_heartbeat_at=stale, shift_open=True)
        calm = resolve_status(StatusInput(**data, printer_status="ok"), now=NOW)
        alarmed = resolve_status(StatusInput(**data, printer_status="error"), now=NOW)
        assert calm.status == alarmed.status == "offline"


# ── Migration ───────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_card_transmission():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert len(heads) == 1
    assert "f1a2b3c4d5e6" in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision("f1a2b3c4d5e6").down_revision == "e0f1a2b3c4d5"


def test_the_migration_adds_the_model_columns():
    """The model and the migration name the same columns, or a deploy writes to nothing."""
    import importlib.util
    import pathlib

    from app.models.pos_machine import POSMachine

    path = pathlib.Path(__file__).resolve().parents[1] / "alembic/versions/f1a2b3c4d5e6_machine_printer_status.py"
    spec = importlib.util.spec_from_file_location("printer_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    migrated = {name for name, _ in module._MACHINE_COLUMNS}
    modelled = {c.name for c in POSMachine.__table__.columns if c.name.startswith("printer_")}
    assert migrated == modelled
