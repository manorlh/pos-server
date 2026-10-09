"""
The shop's local network (docs/SPEC_LAN_MODE.md §3–4, §6; app/services/lan_server.py).

What each class pins:

* **"לא משמש כשרת מקומי" in every election** — an excluded device is never the main till,
  the tables host (not even as the shop's one possible host), the print server or a takeover
  target; the pickers refuse it with a Hebrew 409; its host parameters read "off" but its
  tables mode stays; it stays in the shop Z and keeps using the shop's hosts. A till showing
  a KDS screen is excluded by itself; a kiosk or a handheld is only suggested.
* **The switch "רשת מקומית"** — local mode is the switch and a main till; switching needs a
  main till and passes the shop Z producer's guard like every other transition.
* **The migration's mapping** — exactly the shops in local mode by the old rule get the switch on.
* **The sync lag** — the local server's heartbeat report, and the card's alert past a minute.

Runs on the owner's six-till shop of tests/test_independent_till.py ("רשת מקומית" on).
"""
from __future__ import annotations

import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.kds import KdsDevice
from app.models.kiosk import KioskDevice
from app.models.pos_machine import PairingStatus, POSMachine, set_kiosk_cache
from app.models.till_parameter import TillParameterValue, TillParameter
from app.routers import lan_server as LSR
from app.routers import machines as machines_router
from app.routers import main_till as MR
from app.routers import z_participation as ZP
from app.schemas.pos_machine import HeartbeatLanSync, MachineHeartbeatBody
from app.services import independent_till as IT
from app.services import lan_server as LS
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import printers as K
from app.services import till_parameters as TP
from app.services.printers import print_host_block, print_host_of_shop
from app.services.tables import lan_host_block, tables_host_of_shop
from test_independent_till import _Tasks, manager, put_main, report, set_param, w  # noqa: F401

LAN = "רשת מקומית (קופה ראשית)"
HOST_KEYS = ("mainTill", "tablesHostTill", "printHostTill", "shopZMasterTill")


def exclude(w, till, on=True):
    till.lan_server_excluded = on
    w.db.flush()


def kds_screen(w, till):
    w.db.add(KdsDevice(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=till.id,
                       name="KDS", role="expo", station_ids=[], is_active=True))
    w.db.flush()


def put_flag(w, till, excluded, user=None, force=False):
    try:
        out = LSR.put_machine_lan_server(
            till.id, LSR.LanServerIn(excluded=excluded, forceProducerSwitch=force), BackgroundTasks(),
            current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
    except HTTPException as e:
        return e.status_code, e.detail
    return 200, out


def put_switch(w, enabled, user=None, force=False):
    try:
        out = LSR.put_local_network(
            w.shop.id, LSR.LocalNetworkIn(enabled=enabled, forceProducerSwitch=force), BackgroundTasks(),
            current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
    except HTTPException as e:
        return e.status_code, e.detail
    return 200, out


def participation(w, **body):
    resp = ZP.put_z_participation(
        w.shop.id, ZP.ZParticipationIn.model_validate({"participants": [], "independent": [], **body}),
        background_tasks=_Tasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    if isinstance(resp, dict):
        return 200, resp
    import json

    return resp.status_code, json.loads(resp.body)


# ── The flag in every election ────────────────────────────────────────────────


class TestNeverTheServer:
    def test_never_the_main_till_whatever_is_set(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        set_param(w, "mainTill", "machine", w.six[1].id, True)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[0].id
        exclude(w, w.six[0])
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[1].id
        assert str(w.six[0].id) not in {t["machineId"] for t in MT.shop_tills_out(w.db, w.shop.id)}

    def test_its_host_parameters_read_off_but_its_tables_mode_stays(self, w):
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        for key in HOST_KEYS:
            set_param(w, key, "machine", w.six[2].id, True)
        exclude(w, w.six[2])
        params = TP.till_parameters_for_machine(w.db, w.six[2]).parameters
        assert all(params[k] is False for k in HOST_KEYS)
        assert params["tablesMode"] == LAN
        # Another till reads its own as set.
        set_param(w, "tablesHostTill", "machine", w.six[3].id, True)
        assert TP.till_parameters_for_machine(w.db, w.six[3]).parameters["tablesHostTill"] is True

    def test_never_the_tables_host_and_still_uses_it(self, w):
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        set_param(w, "tablesHostTill", "machine", w.six[2].id, True)
        assert tables_host_of_shop(w.db, w.shop.id).id == w.six[2].id
        exclude(w, w.six[2])
        assert tables_host_of_shop(w.db, w.shop.id).id == w.six[0].id
        block = lan_host_block(w.db, w.six[2])
        assert block["machineId"] == str(w.six[0].id) and block["isSelf"] is False

    def test_the_one_till_fallback_counts_only_the_candidates(self, w):
        for m in w.six[2:]:
            m.is_active = False
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        a, b = w.six[0], w.six[1]
        # Two tills, no main till: no host.
        assert tables_host_of_shop(w.db, w.shop.id) is None
        # One of them never serves: the other is the shop's one possible host.
        exclude(w, b)
        assert tables_host_of_shop(w.db, w.shop.id).id == a.id
        # Both: none — an excluded till never holds the tables, even alone.
        exclude(w, a)
        assert tables_host_of_shop(w.db, w.shop.id) is None

    def test_never_the_print_server_but_its_own_printers_stay_its(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        set_param(w, "printHostTill", "machine", w.six[3].id, True)
        assert print_host_of_shop(w.db, w.shop.id).id == w.six[3].id
        exclude(w, w.six[3])
        assert print_host_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert print_host_block(w.db, w.six[3])["machineId"] == str(w.six[0].id)
        with pytest.raises(HTTPException) as e:
            K.set_print_host(w.db, w.shop, w.six[3].id)
        assert e.value.status_code == 409 and e.value.detail["code"] == LS.PRINT_HOST_NOT_SERVER
        assert "מסומנת" in e.value.detail["message"]

    def test_the_main_till_pickers_refuse_it(self, w):
        exclude(w, w.six[1])
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            put_main(w, w.six[1].id)
        assert e.value.status_code == 409 and e.value.detail["code"] == LS.MAIN_TILL_NOT_SERVER
        code, out = participation(w, mainTillId=str(w.six[1].id))
        assert code == 409 and out["detail"] == LS.MAIN_TILL_NOT_SERVER and "לא משמש כשרת מקומי" in out["message"]

    def test_no_takeover_by_it(self, w):
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        w.six[0].last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=2)
        exclude(w, w.six[4])
        with pytest.raises(HTTPException) as e:
            MT.take_over(w.db, w.six[4], operator="דנה")
        assert e.value.status_code == 409 and e.value.detail["code"] == LS.TAKE_OVER_NOT_SERVER
        # Another till may.
        assert MT.take_over(w.db, w.six[3], operator="דנה")["mainTill"]["machineId"] == str(w.six[3].id)

    def test_it_stays_in_the_shop_z(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        exclude(w, w.six[4])
        assert w.six[4].id in {m.id for m in LZ.participants(w.db, w.shop.id)}
        state = IT.shop_state(w.db, w.shop, w.admin)
        row = next(t for t in state["tills"] if t["machineId"] == str(w.six[4].id))
        assert row["role"] == "shop_z" and row["lanServerExcluded"] is True and row["lanServerExcludedReason"] == "set"

    def test_the_heartbeat_tells_the_till(self, w):
        assert machines_router.post_my_heartbeat(None, machine=w.six[1], db=w.db)["lanServerExcluded"] is False
        exclude(w, w.six[1])
        assert machines_router.post_my_heartbeat(None, machine=w.six[1], db=w.db)["lanServerExcluded"] is True


class TestKdsScreensAndSuggestions:
    def test_a_till_showing_a_kds_screen_is_excluded_by_itself(self, w):
        kds_screen(w, w.six[2])
        assert LS.exclusion(w.db, w.six[2]) == LS.REASON_KDS_SCREEN
        set_param(w, "mainTill", "machine", w.six[2].id, True)
        assert MT.main_till_of_shop(w.db, w.shop.id) is None
        state = LS.card_rows(w.db, [w.six[2]])[str(w.six[2].id)]
        assert state["lanServerExcluded"] is True and state["lanServerExcludedAuto"] is True
        # The switch cannot take it back.
        code, out = put_flag(w, w.six[2], False)
        assert code == 200 and out["lanServerExcluded"] is True and out["lanServerExcludedReason"] == "kds_screen"
        assert machines_router.post_my_heartbeat(None, machine=w.six[2], db=w.db)["lanServerExcluded"] is True

    def test_a_kiosk_and_a_handheld_are_suggested_not_excluded(self, w):
        w.db.add(KioskDevice(machine_id=w.six[3].id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="קיוסק"))
        w.db.flush()
        set_kiosk_cache(w.six[3], None)
        w.six[4].device_model = "SUNMI_V2_PRO"
        w.db.flush()
        rows = LS.card_rows(w.db, w.six)
        assert rows[str(w.six[3].id)]["lanServerExcludedSuggested"] is True
        assert rows[str(w.six[4].id)]["lanServerExcludedSuggested"] is True
        assert rows[str(w.six[1].id)]["lanServerExcludedSuggested"] is False
        assert not any(r["lanServerExcluded"] for r in rows.values())
        assert not any(r["lanServerExcludedChosen"] for r in rows.values())
        # A waiter's handheld by its workflow, whatever the model.
        set_param(w, "workflowSource", "machine", w.six[5].id, "HANDHELD")
        assert LS.card_rows(w.db, [w.six[5]])[str(w.six[5].id)]["lanServerExcludedSuggested"] is True


class TestTheSwitchOnADevice:
    def test_set_and_cleared_by_the_super_admin(self, w):
        set_param(w, "printHostTill", "machine", w.six[3].id, True)
        code, out = put_flag(w, w.six[3], True)
        assert code == 200 and out["lanServerExcluded"] is True and out["lanServerExcludedChosen"] is True
        # Its own host flags are gone, so un-excluding it later makes it no host by surprise.
        param = w.db.query(TillParameter).filter(TillParameter.key == "printHostTill").one()
        assert w.db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == param.id, TillParameterValue.scope_id == w.six[3].id
        ).count() == 0
        code, out = put_flag(w, w.six[3], False)
        assert code == 200 and out["lanServerExcluded"] is False and out["lanServerExcludedChosen"] is True

    def test_only_the_super_admin(self, w):
        code, out = put_flag(w, w.six[3], True, user=manager(w))
        assert code == 403
        assert LSR.get_machine_lan_server(w.six[3].id, current_user=w.admin, active_tenant_id=w.tenant.id,
                                          db=w.db)["canEdit"] is True

    def test_not_the_main_till_itself(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        w.db.commit()
        code, out = put_flag(w, w.six[0], True)
        assert code == 409 and out["code"] == LS.EXCLUDED_IS_MAIN and "קופה ראשית אחרת" in out["message"]

    def test_the_shop_card_saves_the_list_all_or_nothing(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        w.db.commit()
        code, out = participation(w, lanServerExcluded=[str(w.six[4].id), str(w.six[5].id)])
        assert code == 200
        flags = {t["posNumber"]: t["lanServerExcluded"] for t in out["tills"]}
        assert flags == {"1": False, "2": False, "3": False, "4": False, "5": True, "6": True}
        # The main till in the list: refused, nothing written.
        code, out = participation(w, lanServerExcluded=[str(w.six[0].id)])
        assert code == 409 and out["detail"] == LS.EXCLUDED_IS_MAIN
        w.db.rollback()
        assert w.db.get(POSMachine, w.six[0].id).lan_server_excluded is False
        # A new main till and the old one excluded, in one save.
        code, out = participation(w, mainTillId=str(w.six[1].id), lanServerExcluded=[str(w.six[0].id)])
        assert code == 200 and out["mainTill"]["machineId"] == str(w.six[1].id)


# ── The switch "רשת מקומית" ───────────────────────────────────────────────────


class TestLocalNetworkSwitch:
    def test_on_needs_a_main_till(self, w):
        w.shop.local_network = False
        w.db.commit()
        code, out = put_switch(w, True)
        assert code == 409 and out["code"] == LS.LOCAL_NETWORK_NEEDS_MAIN and "קופה ראשית" in out["message"]

    def test_on_and_off_move_the_producer_through_the_guard(self, w):
        w.shop.local_network = False
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        w.db.commit()
        assert LZ.local_mode_of_shop(w.db, w.shop) is False
        assert LZ.effective_producer(w.db, w.shop).kind == LZ.CLOUD
        code, out = put_switch(w, True)
        assert code == 200 and out["localNetwork"] is True and out["localMode"] is True
        assert LZ.effective_producer(w.db, w.shop).is_local_of(w.six[0].id)
        assert w.shop.local_network_changed_at is not None
        # Off while the main till holds shop Zs the cloud has not: refused; the super admin may force it.
        report(w, w.six[0], pending=2)
        w.db.commit()
        code, out = put_switch(w, False)
        assert code == 409 and out["code"] == LZ.BUSY and out["canForce"] is True
        code, out = put_switch(w, False, force=True)
        assert code == 200 and out["localMode"] is False
        assert LZ.effective_producer(w.db, w.shop).kind == LZ.CLOUD

    def test_only_the_super_admin(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        code, _ = put_switch(w, False, user=manager(w))
        assert code == 403

    def test_the_card_has_a_row_per_system(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        out = MR.get_main_till(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        rows = {r["system"]: r for r in out["lanHealth"]}
        assert list(rows) == ["tables", "print", "shop_z", "kds", "kiosk"]
        assert rows["tables"]["state"] == "lan" and rows["tables"]["host"]["machineId"] == str(w.six[0].id)
        assert rows["print"]["state"] == "lan"
        assert rows["shop_z"]["state"] == "lan"
        assert rows["kds"]["state"] == "soon"
        assert rows["kiosk"]["state"] == "none"
        assert out["localNetwork"] is True and out["localMode"] is True


# ── The migration's mapping ───────────────────────────────────────────────────


def _migration():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "c3e9f1a7b5d2_lan_server_and_local_network.py"
    spec = importlib.util.spec_from_file_location("lan_mode_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestMigrationMapping:
    """Exactly the shops in local mode by the rule before the switch get it on."""

    def local(self, w):
        w.db.flush()
        return str(w.shop.id) in _migration().shops_in_local_mode(w.db.connection())

    def test_a_main_till_that_is_its_own_print_server(self, w):
        assert self.local(w) is False
        set_param(w, "mainTill", "machine", w.six[1].id, True)
        assert self.local(w) is True

    def test_another_print_server_and_no_lan_tables(self, w):
        set_param(w, "mainTill", "machine", w.six[1].id, True)
        set_param(w, "printHostTill", "machine", w.six[2].id, True)
        assert self.local(w) is False
        set_param(w, "tablesMode", "company", w.company.id, LAN)  # the company's LAN tables count
        assert self.local(w) is True
        set_param(w, "tablesMode", "shop", w.shop.id, "כבוי")  # the shop's own value wins
        assert self.local(w) is False

    def test_the_main_till_is_the_lowest_number_and_never_independent_or_inactive(self, w):
        set_param(w, "mainTill", "shop", w.shop.id, True)  # every till: the lowest number is it
        set_param(w, "printHostTill", "machine", w.six[1].id, True)
        assert self.local(w) is False  # till 1 is the main, till 2 prints
        w.six[0].is_active = False
        assert self.local(w) is True  # till 2 is the main now, and prints
        w.six[1].independent_till = True
        w.six[1].z_mode = "till"
        # Till 3 is the main; independent till 2 is no print server any more: the main till is.
        assert self.local(w) is True
        set_param(w, "printHostTill", "machine", w.six[3].id, True)
        assert self.local(w) is False

    def test_an_invalid_value_falls_through_like_the_resolver(self, w):
        set_param(w, "mainTill", "machine", w.six[1].id, "yes")  # not a boolean: ignored
        assert self.local(w) is False
        set_param(w, "mainTill", "area", uuid.uuid4(), True)  # another area: not on its chain
        assert self.local(w) is False


# ── The sync lag ("השרת מעדכן את הענן בזמן אמת") ───────────────────────────────


def beat_sync(w, till, pending, oldest_ms, systems=None, at=None):
    body = {"pending": pending, "oldestAgeMs": oldest_ms}
    if systems:
        body["systems"] = systems
    LS.note_sync(till, HeartbeatLanSync.model_validate(body), now=at)
    w.db.flush()


class TestSyncLag:
    def setup_lan(self, w):
        set_param(w, "mainTill", "machine", w.six[0].id, True)
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        w.six[0].last_heartbeat_at = datetime.now(timezone.utc)

    def test_no_report_is_unknown_and_none_without_a_server(self, w):
        assert LS.sync_state(w.db, w.shop)["state"] == "none"
        self.setup_lan(w)
        assert LS.sync_state(w.db, w.shop)["state"] == "unknown"

    def test_synced_syncing_and_the_alert_past_a_minute(self, w):
        self.setup_lan(w)
        now = datetime.now(timezone.utc)
        beat_sync(w, w.six[0], 0, None, at=now)
        assert LS.sync_state(w.db, w.shop, now=now)["state"] == "synced"
        beat_sync(w, w.six[0], 3, 1500, systems={"tables": {"pending": 3, "oldestAgeMs": 1500}}, at=now)
        state = LS.sync_state(w.db, w.shop, now=now)
        assert state["state"] == "syncing" and state["pending"] == 3 and state["alert"] is False
        assert state["systems"]["tables"]["pending"] == 3
        later = now + timedelta(seconds=61)
        w.six[0].last_heartbeat_at = later
        beat_sync(w, w.six[0], 3, 62_500, at=later)
        state = LS.sync_state(w.db, w.shop, now=later)
        assert state["state"] == "lagging" and state["alert"] is True and state["oldestAgeSeconds"] >= 61

    def test_the_oldest_change_keeps_its_moment_across_beats(self, w):
        self.setup_lan(w)
        now = datetime.now(timezone.utc)
        beat_sync(w, w.six[0], 1, 1000, at=now)
        first = w.six[0].lan_sync["oldestAt"]
        beat_sync(w, w.six[0], 1, 31_800, at=now + timedelta(seconds=31))
        assert w.six[0].lan_sync["oldestAt"] == first

    def test_offline_is_no_alert_and_a_stale_report_says_nothing(self, w):
        self.setup_lan(w)
        now = datetime.now(timezone.utc)
        beat_sync(w, w.six[0], 5, 600_000, at=now)
        w.six[0].last_heartbeat_at = now - timedelta(hours=1)
        assert LS.sync_state(w.db, w.shop, now=now)["state"] == "offline"
        w.six[0].last_heartbeat_at = now + timedelta(minutes=10)
        assert LS.sync_state(w.db, w.shop, now=now + timedelta(minutes=10))["state"] == "unknown"

    def test_the_heartbeat_keeps_it_and_the_card_shows_it(self, w):
        self.setup_lan(w)
        body = MachineHeartbeatBody.model_validate({"lanSync": {"pending": 2, "oldestAgeMs": 800}})
        machines_router.post_my_heartbeat(body, machine=w.six[0], db=w.db)
        assert w.six[0].lan_sync["pending"] == 2 and w.six[0].lan_sync_reported_at is not None
        out = MR.get_main_till(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["lanSync"]["state"] == "syncing" and out["lanSync"]["host"]["machineId"] == str(w.six[0].id)
