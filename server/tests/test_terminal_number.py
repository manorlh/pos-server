"""
The till's card terminal number: reported in the heartbeat, checked against the
settings, and forced from the cloud.

What each class pins, and how it could look fine while doing damage:

* **Heartbeat** — the `terminal` block is optional (an old till sends none) and never a
  422; a beat without it leaves the stored reading alone. Wiping it would turn every
  till "unknown" the moment one beat came from an older build.
* **Status** — "match"/"mismatch" ignore leading zeros, as the till does. Without that a
  till Agamento reports as "01807770" would show red while selling happily.
* **Machine fields** — list and detail carry the reading and the effective settings,
  the force switch with the level it comes from.
* **Setting** — `forceTerminalNumber` merges like any other key, resets with `null`, and
  always reaches the till as a real bool.
* **Force endpoint** — writes through the level's own settings PATCH (same permission
  checks), tells that level's tills, and answers them with their status.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import settings as settings_router
from app.routers.sync import get_settings_sync
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.pos_settings import PosSettingsV1Patch
from app.schemas.terminal import TerminalNumberForceRequest
from app.services import ably_notify
from app.services import settings_notify
from app.services.settings_merge import MANAGED_SETTING_KEYS
from app.services.terminal_status import (
    MATCH,
    MISMATCH,
    NOT_REQUIRED,
    UNKNOWN,
    normalize_terminal_number,
    terminal_status,
)
from shift_world import accept_str_uuids, make_world

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_transmit_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    world.notified = []
    monkeypatch.setattr(
        settings_notify,
        "publish_settings_notify",
        lambda tid, mid, reason=None: world.notified.append(mid),
    )
    world.now = datetime.now(timezone.utc)
    for till in world.tills + [world.other_till]:
        till.last_heartbeat_at = world.now - timedelta(seconds=10)
    world.db.commit()
    return world


def beat(w, till, payload=None):
    body = MachineHeartbeatBody.model_validate(payload) if payload is not None else None
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db)


def detail(w, till):
    return machines_router.get_machine(
        machine_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
    )


def listing(w):
    rows = machines_router.list_machines(
        skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
        include_inactive=False, area_id=None,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return {row["id"]: row for row in rows}


def force(w, user, level, target, *, force=True, number=None):
    payload = {"level": level, "targetId": str(target), "force": force}
    if number is not None:
        payload["terminalNumber"] = number
    return settings_router.force_terminal_number(
        body=TerminalNumberForceRequest.model_validate(payload),
        current_user=user,
        active_tenant_id=w.tenant.id,
        db=w.db,
    )


def user(role, shop_id=None):
    return User(id=uuid.uuid4(), role=role, shop_id=shop_id, email="u@x", username="u")


def set_shop(w, shop, settings):
    shop.settings = settings
    w.db.commit()


TERMINAL = {
    "terminalNumber": "1807770",
    "clearingServer": "PELECARD",
    "offlineMode": False,
    "lastWrite": {
        "field": "terminalNumber", "value": "1807770", "ok": True, "error": None,
        "at": "2026-10-03T10:00:00Z",
    },
}


class TestHeartbeat:
    def test_the_block_is_stored(self, w):
        till = w.tills[0]
        beat(w, till, {"terminal": TERMINAL})

        assert till.terminal_number == "1807770"
        assert till.terminal_clearing_server == "PELECARD"
        assert till.terminal_offline_mode is False
        assert till.terminal_reported_at is not None
        assert till.terminal_last_write == {
            "field": "terminalNumber", "value": "1807770", "ok": True, "error": None,
            "at": "2026-10-03T10:00:00+00:00",
        }

    def test_a_beat_without_the_block_leaves_the_reading(self, w):
        till = w.tills[0]
        beat(w, till, {"terminal": TERMINAL})
        stamp = till.terminal_reported_at
        beat(w, till, {"appVersion": "1.2.3"})
        beat(w, till, {"terminal": None})
        beat(w, till)

        assert till.terminal_number == "1807770"
        assert till.terminal_reported_at == stamp
        assert till.terminal_last_write["ok"] is True

    def test_a_block_without_a_write_keeps_the_last_write(self, w):
        till = w.tills[0]
        beat(w, till, {"terminal": TERMINAL})
        beat(w, till, {"terminal": {"terminalNumber": "555", "offlineMode": True, "lastWrite": None}})

        assert till.terminal_number == "555"
        assert till.terminal_clearing_server is None
        assert till.terminal_offline_mode is True
        assert till.terminal_last_write["value"] == "1807770"

    def test_a_failed_write_is_stored_with_its_error(self, w):
        till = w.tills[0]
        beat(w, till, {"terminal": {**TERMINAL, "lastWrite": {
            "field": "terminalNumber", "value": "1807770", "ok": False,
            "error": "Agamento refused", "at": "2026-10-03T10:00:00Z",
        }}})
        assert till.terminal_last_write["ok"] is False
        assert till.terminal_last_write["error"] == "Agamento refused"

    @pytest.mark.parametrize("block", ["yes", 7, ["1807770"]])
    def test_a_block_that_is_not_an_object_is_ignored(self, w, block):
        body = MachineHeartbeatBody.model_validate({"terminal": block, "appVersion": "1"})
        assert body.terminal is None and body.app_version == "1"

    def test_unreadable_fields_are_unknown_not_a_422(self):
        body = MachineHeartbeatBody.model_validate({"terminal": {
            "terminalNumber": "9" * 40, "clearingServer": " shva ", "offlineMode": "yes",
            "lastWrite": "done",
        }})
        assert body.terminal.terminal_number == "9" * 20
        assert body.terminal.clearing_server == "SHVA"
        assert body.terminal.offline_mode is None
        assert body.terminal.last_write is None
        bad_write = MachineHeartbeatBody.model_validate(
            {"terminal": {"lastWrite": {"ok": "maybe", "at": "not a time", "error": {"x": 1}}}}
        )
        write = bad_write.terminal.last_write
        assert write.ok is None and write.at is None and write.error is None


class TestStatus:
    @pytest.mark.parametrize(
        "reported, expected, status",
        [
            ("1807770", "1807770", MATCH),
            ("01807770", "1807770", MATCH),
            ("1807770", "001807770", MATCH),
            (" 1807770 ", "1807770", MATCH),
            ("1807771", "1807770", MISMATCH),
            ("0", "000", MATCH),
            (None, "1807770", UNKNOWN),
            ("", "1807770", UNKNOWN),
            ("1807770", None, NOT_REQUIRED),
            ("1807770", "", NOT_REQUIRED),
            (None, None, NOT_REQUIRED),
        ],
    )
    def test_terminal_status(self, reported, expected, status):
        assert terminal_status(reported, NOW, expected) == status

    def test_never_reported_is_unknown_whatever_the_column_says(self):
        assert terminal_status("1807770", None, "1807770") == UNKNOWN

    def test_normalize(self):
        assert normalize_terminal_number("01807770") == "1807770"
        assert normalize_terminal_number("   ") is None
        assert normalize_terminal_number("0000") == "0"


class TestMachineFields:
    def test_a_till_that_never_reported(self, w):
        set_shop(w, w.shop, {"expectedTerminalNumber": "1807770"})
        row = detail(w, w.tills[0])
        assert row["terminalNumber"] is None and row["terminalReportedAt"] is None
        assert row["expectedTerminalNumber"] == "1807770"
        assert row["terminalStatus"] == UNKNOWN
        assert row["forceTerminalNumber"] is False and row["forceTerminalNumberSource"] is None

    def test_list_and_detail_agree(self, w):
        set_shop(w, w.shop, {"expectedTerminalNumber": "1807770", "forceTerminalNumber": True})
        a, b = w.tills
        b.settings = {"expectedTerminalNumber": "2000"}
        w.db.commit()
        beat(w, a, {"terminal": {**TERMINAL, "terminalNumber": "01807770"}})
        beat(w, b, {"terminal": TERMINAL})
        beat(w, w.other_till, {"terminal": TERMINAL})

        rows = listing(w)
        assert rows[a.id]["terminalStatus"] == MATCH
        assert rows[b.id]["terminalStatus"] == MISMATCH
        assert rows[b.id]["expectedTerminalNumber"] == "2000"
        assert rows[a.id]["forceTerminalNumber"] is True
        assert rows[a.id]["forceTerminalNumberSource"] == "shop"
        assert rows[a.id]["terminalClearingServer"] == "PELECARD"
        assert rows[a.id]["terminalLastWrite"]["ok"] is True
        # The other shop expects nothing.
        assert rows[w.other_till.id]["terminalStatus"] == NOT_REQUIRED
        for till in (a, b, w.other_till):
            single = detail(w, till)
            for key in ("terminalStatus", "expectedTerminalNumber", "forceTerminalNumber"):
                assert single[key] == rows[till.id][key]

    def test_the_till_layer_beats_the_shop(self, w):
        set_shop(w, w.shop, {"forceTerminalNumber": True})
        w.tills[0].settings = {"forceTerminalNumber": False}
        w.db.commit()
        rows = listing(w)
        assert rows[w.tills[0].id]["forceTerminalNumber"] is False
        assert rows[w.tills[0].id]["forceTerminalNumberSource"] == "machine"
        assert rows[w.tills[1].id]["forceTerminalNumber"] is True


class TestSetting:
    def test_managed_and_validated(self):
        assert "forceTerminalNumber" in MANAGED_SETTING_KEYS
        assert PosSettingsV1Patch.model_validate({"forceTerminalNumber": True}).force_terminal_number is True

    def test_null_resets_the_layer(self, w):
        till = w.tills[0]
        till.settings = {"forceTerminalNumber": True, "expectedTerminalNumber": "1"}
        w.db.commit()
        settings_router.patch_machine_settings(
            str(till.id), PosSettingsV1Patch.model_validate({"forceTerminalNumber": None}),
            w.admin, w.tenant.id, w.db,
        )
        assert till.settings == {"expectedTerminalNumber": "1"}

    def test_the_till_always_gets_a_bool(self, w):
        till = w.tills[0]

        def sync():
            with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
                "app.routers.sync.machine_area_for_sync", return_value=(None, [])
            ):
                return get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db)

        assert sync().settings["forceTerminalNumber"] is False
        set_shop(w, w.shop, {"forceTerminalNumber": True})
        assert sync().settings["forceTerminalNumber"] is True


class TestForceEndpoint:
    def test_shop_level_sets_both_keys_and_tells_the_shops_tills(self, w):
        beat(w, w.tills[0], {"terminal": TERMINAL})
        beat(w, w.tills[1], {"terminal": {**TERMINAL, "terminalNumber": "999"}})

        out = force(w, w.admin, "shop", w.shop.id, number="1807770")

        assert w.shop.settings["forceTerminalNumber"] is True
        assert w.shop.settings["expectedTerminalNumber"] == "1807770"
        assert sorted(w.notified) == sorted(str(t.id) for t in w.tills)
        by_id = {m["id"]: m for m in out["machines"]}
        assert set(by_id) == {t.id for t in w.tills}
        assert by_id[w.tills[0].id]["terminalStatus"] == MATCH
        assert by_id[w.tills[1].id]["terminalStatus"] == MISMATCH
        assert all(m["forceTerminalNumber"] is True for m in out["machines"])
        assert w.other_shop.settings == {}

    def test_without_a_number_only_the_switch_moves(self, w):
        set_shop(w, w.shop, {"expectedTerminalNumber": "42"})
        force(w, w.admin, "shop", w.shop.id, force=False)
        assert w.shop.settings == {"expectedTerminalNumber": "42", "forceTerminalNumber": False}

    def test_machine_level_touches_that_till_only(self, w):
        till = w.tills[1]
        out = force(w, w.admin, "machine", till.id, number="0555")

        assert till.settings == {"forceTerminalNumber": True, "expectedTerminalNumber": "0555"}
        assert w.tills[0].settings in (None, {})
        assert w.notified == [str(till.id)]
        assert [m["id"] for m in out["machines"]] == [till.id]
        assert out["machines"][0]["terminalStatus"] == UNKNOWN

    def test_company_level_reaches_every_shop(self, w):
        out = force(w, w.admin, "company", w.company.id)
        assert w.company.settings["forceTerminalNumber"] is True
        assert {m["id"] for m in out["machines"]} == {t.id for t in w.tills + [w.other_till]}

    def test_a_cashier_may_not(self, w):
        cashier = user(UserRole.CASHIER, w.shop.id)
        for level, target in (("shop", w.shop.id), ("machine", w.tills[0].id)):
            with pytest.raises(HTTPException) as err:
                force(w, cashier, level, target)
            assert err.value.status_code == 403
        assert "forceTerminalNumber" not in (w.shop.settings or {})
        assert w.notified == []

    def test_a_shop_manager_only_in_their_own_shop(self, w):
        manager = user(UserRole.SHOP_MANAGER, w.shop.id)
        force(w, manager, "shop", w.shop.id)
        force(w, manager, "machine", w.tills[0].id)
        for level, target in (("shop", w.other_shop.id), ("machine", w.other_till.id)):
            with pytest.raises(HTTPException) as err:
                force(w, manager, level, target)
            assert err.value.status_code == 403
        assert w.other_shop.settings == {}

    def test_a_shop_manager_may_not_force_the_company(self, w):
        with pytest.raises(HTTPException) as err:
            force(w, user(UserRole.SHOP_MANAGER, w.shop.id), "company", w.company.id)
        assert err.value.status_code == 403

    def test_another_tenant_is_refused(self, w):
        with pytest.raises(HTTPException) as err:
            settings_router.force_terminal_number(
                body=TerminalNumberForceRequest.model_validate(
                    {"level": "shop", "targetId": str(w.shop.id), "force": True}
                ),
                current_user=w.admin, active_tenant_id=uuid.uuid4(), db=w.db,
            )
        assert err.value.status_code == 403

    def test_a_missing_target_is_404(self, w):
        with pytest.raises(HTTPException) as err:
            force(w, w.admin, "shop", uuid.uuid4())
        assert err.value.status_code == 404

    @pytest.mark.parametrize("payload", [
        {"level": "shop", "targetId": "x", "force": True},
        {"level": "tenant", "targetId": str(uuid.uuid4()), "force": True},
        {"level": "shop", "targetId": str(uuid.uuid4()), "force": True, "terminalNumber": "12a"},
    ])
    def test_bad_requests_are_422(self, payload):
        with pytest.raises(ValidationError):
            TerminalNumberForceRequest.model_validate(payload)
