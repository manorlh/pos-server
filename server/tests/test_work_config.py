"""
"תצורת עבודה למכשיר" (app/services/work_config.py, docs/SPEC_DEVICE_WORK_CONFIG.md).

What each class pins:

* **The presets** — the fixed table matches the dashboard's copy (a shared golden file); which
  presets a device may take (role, the shop's "רשת מקומית", the main till, a LAN client) and
  what "לפי הסניף" is.
* **Reading** — every value with where it comes from: "נקבע במכשיר" or the level it inherits.
* **Every preset** — the values it writes, each through its own service: in / out of the shop Z,
  the main till, "מרוחק (דרך הענן)", "לא משמש כשרת מקומי", "רשת מקומית", the tables at the device's
  level (audited), the receipt printer and the KDS targets.
* **A remote participant with a local server** — the owner's question: in the shop Z, closed
  through the cloud (the main till's request reaches it on its heartbeat), never on the LAN.
* **The rules stay** — the super admin alone, a clean break (open shift, closed shift waiting for
  a Z, a Z under way), the main till and the shop Z producer's guard; refused with the services'
  own Hebrew, and nothing written (all or nothing).
* **Pairing** — the plan is checked when the code is made and applied as the device pairs; a
  refusal then never fails the pairing and is kept for the device page.

Runs on the owner's six-till shop of tests/test_independent_till.py ("רשת מקומית" on).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.responses import JSONResponse

from app.models.kds import KdsDevice
from app.models.kiosk import KioskDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine, set_kiosk_cache
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterChange, TillParameterValue
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.routers import work_config as WR
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse
from app.schemas.work_config import WorkConfigPutIn
from app.services import independent_till as IT
from app.services import kiosk_control
from app.services import lan_server as LS
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import pairing as P
from app.services import till_parameters as TP
from app.services import work_config as WC
from test_independent_till import (  # noqa: F401
    _Tasks, closed_shift, manager, owner_setup, report, run_z, set_param, w,
)

LAN = "רשת מקומית (קופה ראשית)"
SYNCED = "מסונכרן בין הקופות"
SINGLE = "קופה אחת"
OFF = "כבוי"
GOLDEN = Path(__file__).parent / "fixtures" / "work_config_presets_golden.json"


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    sent = []
    monkeypatch.setattr(TP, "publish_parameters_notify", lambda targets: sent.append(list(targets)))
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return sent


def cloud_shop(w):
    w.shop.local_network = False
    w.db.commit()


def get(w, machine, user=None):
    return WR.get_machine_work_config(machine.id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


class _Recorded:
    """The background tasks a route queued (run here: the notify is the patched recorder)."""

    def add_task(self, fn, *args, **kwargs):
        fn(*args, **kwargs)


def put(w, machine, user=None, force=False, **plan):
    resp = WR.put_machine_work_config(
        machine.id, WorkConfigPutIn.model_validate({**plan, "forceProducerSwitch": force}), _Recorded(),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    if isinstance(resp, JSONResponse):
        return resp.status_code, json.loads(resp.body)
    return 200, resp


def own(w, machine, key):
    row = (
        w.db.query(TillParameterValue)
        .join(TillParameter, TillParameter.id == TillParameterValue.parameter_id)
        .filter(TillParameter.key == key, TillParameterValue.scope_type == "machine",
                TillParameterValue.scope_id == machine.id)
        .first()
    )
    return None if row is None else row.value


def make_kiosk(w, machine):
    w.db.add(KioskDevice(machine_id=machine.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="קיוסק"))
    w.db.flush()
    set_kiosk_cache(machine, None)
    w.db.commit()


def make_screen(w, machine, role="expo"):
    machine.is_fiscal = False
    w.db.add(KdsDevice(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=machine.id,
                       name="מסך", role=role, station_ids=[], is_active=True))
    w.db.commit()


def ids(view):
    return {p["id"]: p for p in view["presets"]}


# ── The presets ───────────────────────────────────────────────────────────────


class TestPresets:
    def test_the_fixed_table_is_the_dashboards(self):
        assert WC.static_table() == json.loads(GOLDEN.read_text(encoding="utf-8"))

    def test_each_role_has_its_presets(self):
        assert [p.id for p in WC.presets_for_role("till")] == [
            "shop_z_cloud", "main_till", "lan_member", "remote_shop_z", "independent", "own_z",
        ]
        assert [p.id for p in WC.presets_for_role("kiosk")] == ["kiosk_shop_z", "kiosk_own_z"]
        assert [p.id for p in WC.presets_for_role("kds")] == ["kds_screen"]
        assert [p.id for p in WC.presets_for_role("order_status_board")] == ["ready_board"]

    def test_a_lan_shop(self, w):
        owner_setup(w)
        view = get(w, w.six[2])
        presets = ids(view)
        assert view["inheritedPreset"] == "lan_member" and view["currentPreset"] == "lan_member"
        assert view["isInherited"] is True
        assert presets["lan_member"]["available"] and presets["remote_shop_z"]["available"]
        assert presets["main_till"]["available"] and presets["main_till"]["movesMainTillFrom"]["machineId"] == str(w.six[0].id)
        assert not presets["shop_z_cloud"]["available"]
        assert presets["shop_z_cloud"]["reason"] == "work_config_shop_is_lan"
        assert "רשת מקומית" in presets["shop_z_cloud"]["message"]

    def test_a_cloud_shop(self, w):
        cloud_shop(w)
        view = get(w, w.six[2])
        presets = ids(view)
        assert view["inheritedPreset"] == "shop_z_cloud" and view["currentPreset"] == "shop_z_cloud"
        assert presets["shop_z_cloud"]["available"]
        assert presets["lan_member"]["reason"] == "work_config_shop_not_lan"
        assert presets["remote_shop_z"]["reason"] == "work_config_shop_not_lan"
        assert "מסתנכרנת לבד מול הענן" in presets["remote_shop_z"]["message"]
        # The main till turns "רשת מקומית" on with it.
        assert presets["main_till"]["available"] and presets["main_till"]["turnsOnLocalNetwork"]

    def test_the_main_till_takes_no_other_preset_until_another_is_chosen(self, w):
        owner_setup(w)
        presets = ids(get(w, w.six[0]))
        assert get(w, w.six[0])["currentPreset"] == "main_till"
        for name in ("lan_member", "remote_shop_z", "independent", "own_z"):
            assert presets[name]["reason"] == "work_config_is_main_till"
        assert "בחרו קודם קופה ראשית אחרת" in presets["own_z"]["message"]

    def test_a_windows_device_never_serves_or_joins_the_lan(self, w):
        owner_setup(w)
        w.six[3].platform = "windows"
        w.db.commit()
        view = get(w, w.six[3])
        presets = ids(view)
        assert presets["lan_member"]["reason"] == presets["main_till"]["reason"] == "work_config_needs_lan_client"
        assert view["inheritedPreset"] == view["currentPreset"] == "remote_shop_z"
        assert view["values"]["link"] == {"value": "remote", "source": "fixed", "applies": True}

    def test_kiosk_and_screen_presets(self, w):
        make_kiosk(w, w.six[4])
        make_screen(w, w.six[5])
        kiosk = get(w, w.six[4])
        assert [p["id"] for p in kiosk["presets"]] == ["kiosk_shop_z", "kiosk_own_z"]
        assert kiosk["inheritedPreset"] == kiosk["currentPreset"] == "kiosk_shop_z"
        screen = get(w, w.six[5])
        assert screen["fiscal"] is False and [p["id"] for p in screen["presets"]] == ["kds_screen"]
        assert screen["currentPreset"] == "kds_screen"


# ── Reading ───────────────────────────────────────────────────────────────────


class TestSources:
    def test_each_value_says_where_it_comes_from(self, w):
        owner_setup(w)
        till = w.six[2]
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        set_param(w, "receiptPrinter", "company", w.company.id, "רשת (IP)")
        w.db.commit()
        values = get(w, till)["values"]
        assert values["tablesMode"]["value"] == LAN and values["tablesMode"]["source"] == "shop"
        assert values["receiptPrinter"]["source"] == "company"
        assert values["workflowTargets"]["value"] == ["printer"] and values["workflowTargets"]["source"] == "default"
        assert values["zMode"] == {"value": "cloud", "source": "inherited"}
        assert values["mainTill"]["value"] is False
        # Set on the device: "נקבע במכשיר", and what it would inherit.
        set_param(w, "tablesMode", "machine", till.id, SINGLE)
        w.db.commit()
        tables = get(w, till)["values"]["tablesMode"]
        assert (tables["value"], tables["source"], tables["own"]) == (SINGLE, "machine", SINGLE)
        assert (tables["inherited"], tables["inheritedSource"]) == (LAN, "shop")

    def test_an_independent_till_reads_its_tables_from_its_own_level_only(self, w):
        owner_setup(w)
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        w.db.commit()
        tables = get(w, w.six[5])["values"]["tablesMode"]
        assert (tables["value"], tables["source"]) == (OFF, "independent")

    def test_the_main_till_and_the_lan_flag(self, w):
        owner_setup(w)
        assert get(w, w.six[0])["values"]["mainTill"] == {"value": True, "source": "device"}
        w.six[3].lan_server_excluded = True
        w.db.commit()
        flag = get(w, w.six[3])["values"]["lanServerExcluded"]
        assert (flag["value"], flag["source"]) == (True, "device")

    def test_a_shop_manager_reads_but_edits_only_the_printing(self, w):
        owner_setup(w)
        view = get(w, w.six[2], user=manager_of(w))
        assert view["canEdit"] is False and view["canEditPrinting"] is True


def manager_of(w):
    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
             username=uuid.uuid4().hex[:6], shop_id=w.shop.id)
    w.db.add(u)
    w.db.commit()
    return u


# ── Every preset ──────────────────────────────────────────────────────────────


class TestEveryPreset:
    def test_shop_z_cloud(self, w, _quiet):
        cloud_shop(w)
        till = w.six[2]
        till.z_mode = "till"  # "Z בקופה" before — back into the shop Z
        w.db.commit()
        code, out = put(w, till, preset="shop_z_cloud", tablesMode=SYNCED)
        assert code == 200, out
        assert till.z_mode == "cloud" and not till.independent_till
        assert own(w, till, "tablesMode") == SYNCED
        assert out["currentPreset"] == "shop_z_cloud" and set(out["changes"]) == {"zMode", "tablesMode"}
        # Audited, like the parameters page; the shop's tills told.
        change = w.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == "tablesMode").one()
        assert (change.scope_type, change.new_value, change.user_role) == ("machine", SYNCED, "super_admin")
        assert till.z_mode_history[-1]["to"] == "cloud"
        assert _quiet and {m for _, m in _quiet[-1]} >= {str(t.id) for t in w.six}

    def test_main_till_moves_the_main_till_and_clears_the_lan_flag(self, w):
        owner_setup(w)
        till = w.six[2]
        till.lan_server_excluded = True
        w.db.commit()
        code, out = put(w, till, preset="main_till")
        assert code == 200, out
        assert MT.main_till_of_shop(w.db, w.shop.id).id == till.id
        assert till.lan_server_excluded is False
        assert LZ.effective_producer(w.db, w.shop).is_local_of(till.id)
        assert out["currentPreset"] == "main_till" and out["values"]["mainTill"]["source"] == "device"

    def test_main_till_in_a_cloud_shop_turns_on_the_local_network(self, w):
        cloud_shop(w)
        till = w.six[1]
        code, out = put(w, till, preset="main_till")
        assert code == 409 and out["detail"] == "work_config_local_network_off"
        assert "הפעלת רשת מקומית בסניף" in out["message"]
        code, out = put(w, till, preset="main_till", enableLocalNetwork=True)
        assert code == 200, out
        assert w.shop.local_network is True and LZ.local_mode_of_shop(w.db, w.shop)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == till.id

    def test_lan_member_with_its_choices(self, w):
        owner_setup(w)
        till = w.six[3]
        code, out = put(w, till, preset="lan_member", lanServerExcluded=True, tablesMode=LAN)
        assert code == 200, out
        assert till.lan_server_excluded is True and own(w, till, "tablesMode") == LAN
        assert till.id in {m.id for m in LZ.participants(w.db, w.shop.id)}
        assert str(till.id) not in LZ.remote_till_ids(w.shop)

    def test_remote_shop_z(self, w):
        owner_setup(w)
        till = w.six[4]
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        w.db.commit()
        code, out = put(w, till, preset="remote_shop_z")
        assert code == 200, out
        assert str(till.id) in LZ.remote_till_ids(w.shop)
        assert till.lan_server_excluded is True
        # Off the LAN, it cannot reach the shop's tables host: its tables are off unless its own.
        assert own(w, till, "tablesMode") == OFF
        assert TP.till_parameters_for_machine(w.db, till).parameters["tablesMode"] == OFF
        assert out["currentPreset"] == "remote_shop_z"
        assert out["values"]["link"] == {"value": "remote", "source": "device", "applies": True}

    def test_a_stale_remote_entry_never_blocks_the_save(self, w):
        owner_setup(w)
        # The main till and an independent till on the list from before: dropped, not refused.
        LZ.set_remote_till_ids(w.shop, [w.six[0].id, w.six[5].id])
        w.db.commit()
        code, out = put(w, w.six[4], preset="remote_shop_z")
        assert code == 200, out
        assert LZ.remote_till_ids(w.shop) == {str(w.six[4].id)}

    def test_independent(self, w):
        owner_setup(w)
        till = w.six[4]
        set_param(w, "printHostTill", "machine", till.id, True)
        w.db.commit()
        code, out = put(w, till, preset="independent", tablesMode=SINGLE)
        assert code == 200, out
        assert till.independent_till and till.z_mode == "till"
        assert IT.role_of(till) == IT.ROLE_INDEPENDENT
        assert TP.till_parameters_for_machine(w.db, till).parameters["tablesMode"] == SINGLE
        assert own(w, till, "printHostTill") is None  # its host flags cleared by the service
        assert till.id not in {m.id for m in LZ.participants(w.db, w.shop.id)}

    def test_own_z_stays_in_the_lan_group(self, w):
        owner_setup(w)
        till = w.six[3]
        code, out = put(w, till, preset="own_z")
        assert code == 200, out
        assert till.z_mode == "till" and not till.independent_till
        assert IT.role_of(till) == IT.ROLE_OWN_Z
        assert till in IT.lan_members(w.six)
        assert till.id not in {m.id for m in LZ.participants(w.db, w.shop.id)}

    def test_own_z_from_independent_goes_through_the_shop_card(self, w):
        owner_setup(w)
        six = w.six[5]  # independent
        code, out = put(w, six, preset="own_z")
        assert code == 200, out
        assert six.z_mode == "till" and not six.independent_till
        assert [h["to"] for h in six.z_mode_history[-2:]] == ["cloud", "till"]

    def test_kiosk_in_the_shop_z_remote(self, w):
        owner_setup(w)
        kiosk = w.six[4]
        make_kiosk(w, kiosk)
        code, out = put(w, kiosk, preset="kiosk_shop_z", link="remote")
        assert code == 200, out
        assert str(kiosk.id) in LZ.remote_till_ids(w.shop)
        assert kiosk.lan_server_excluded is True  # the kiosk's default: never the local server

    def test_kiosk_with_its_own_z(self, w):
        owner_setup(w)
        kiosk = w.six[4]
        make_kiosk(w, kiosk)
        code, out = put(w, kiosk, preset="kiosk_own_z")
        assert code == 200, out
        assert kiosk.independent_till and out["currentPreset"] == "kiosk_own_z"

    def test_a_screen_takes_its_own_preset_and_nothing_else(self, w):
        make_screen(w, w.six[5])
        code, out = put(w, w.six[5], preset="kds_screen")
        assert code == 200 and out["changes"] == []
        code, out = put(w, w.six[5], preset="kds_screen", tablesMode=SINGLE)
        assert code == 409 and out["detail"] == "device_not_fiscal"
        code, out = put(w, w.six[5], preset="lan_member")
        assert code == 409 and out["detail"] == "device_not_fiscal"
        # The "מוכן / לא מוכן" board: its own.
        make_screen(w, w.six[4], role="pickup")
        view = get(w, w.six[4])
        assert view["role"] == "order_status_board" and view["currentPreset"] == "ready_board"
        code, out = put(w, w.six[4], preset="ready_board")
        assert code == 200 and out["changes"] == []
        code, out = put(w, w.six[4], preset="kds_screen")
        assert code == 409 and out["detail"] == "device_not_fiscal"

    def test_printing_overrides_and_back_to_inherited(self, w):
        owner_setup(w)
        till = w.six[2]
        code, out = put(w, till, receiptPrinter="רשת (IP)", workflowTargets=["kds", "printer"])
        assert code == 200, out
        assert own(w, till, "receiptPrinter") == "רשת (IP)"
        assert own(w, till, "workflowTargets") == "printer,kds"
        assert out["values"]["receiptPrinter"]["source"] == "machine"
        keys = {c.parameter_key for c in w.db.query(TillParameterChange).all()}
        assert {"receiptPrinter", "workflowTargets"} <= keys
        # "חזרה לירושה".
        code, out = put(w, till, receiptPrinter="inherit", workflowTargets="inherit")
        assert code == 200, out
        assert own(w, till, "receiptPrinter") is None and own(w, till, "workflowTargets") is None
        assert out["values"]["receiptPrinter"]["source"] == "default"

    def test_back_to_the_shop_default(self, w):
        owner_setup(w)
        till = w.six[3]
        assert put(w, till, preset="remote_shop_z")[0] == 200
        code, out = put(w, till, preset="inherit")
        assert code == 200, out
        assert str(till.id) not in LZ.remote_till_ids(w.shop)
        assert out["currentPreset"] == "lan_member" and out["isInherited"] is True
        # The fiscal part only: its own tables and flag stay, each with its own "חזרה לירושה".
        assert own(w, till, "tablesMode") == OFF and till.lan_server_excluded is True
        code, out = put(w, till, tablesMode="inherit", lanServerExcluded=False)
        assert code == 200, out
        assert own(w, till, "tablesMode") is None and till.lan_server_excluded is False
        assert out["values"]["tablesMode"]["source"] == "default"

    def test_back_to_the_shop_default_is_refused_for_the_main_till(self, w):
        owner_setup(w)
        code, out = put(w, w.six[0], preset="inherit")
        assert code == 409 and out["detail"] == "work_config_is_main_till"

    def test_a_windows_device_is_already_the_shops_default(self, w):
        owner_setup(w)
        w.six[3].platform = "windows"
        w.db.commit()
        code, out = put(w, w.six[3], preset="inherit")
        assert code == 200 and out["changes"] == []
        assert str(w.six[3].id) not in LZ.remote_till_ids(w.shop)

    def test_the_same_again_changes_nothing(self, w):
        owner_setup(w)
        code, out = put(w, w.six[3], preset="lan_member")
        assert code == 200 and out["changes"] == []


# ── The owner's question: in the shop Z with a local server, syncing alone with the cloud ──


class TestRemoteParticipant:
    def test_it_is_in_the_shop_z_and_closed_through_the_cloud(self, w):
        owner_setup(w)
        main, remote = w.six[0], w.six[4]
        assert LZ.local_mode_of_shop(w.db, w.shop)
        assert put(w, remote, preset="remote_shop_z")[0] == 200
        # Still a participant of the shop Z, marked to close through the cloud.
        participants = {p["machineId"]: p for p in LZ.history(w.db, main)["participants"]}
        assert participants[str(remote.id)]["remote"] is True
        assert participants[str(w.six[3].id)]["remote"] is False
        # The main till asks the cloud; the remote till hears it on its own heartbeat.
        LZ.request_remote_parts(w.db, main, "round-1", [{"machineId": str(remote.id), "requestId": "req-1"}])
        w.db.commit()
        beat = machines_router.post_my_heartbeat(None, machine=remote, db=w.db)
        assert beat["pendingShopZPart"]["requestId"] == "req-1"
        # A LAN till gets no such request.
        assert machines_router.post_my_heartbeat(None, machine=w.six[3], db=w.db).get("pendingShopZPart") is None


# ── The rules stay ────────────────────────────────────────────────────────────


class TestRefusals:
    def test_the_super_admin_alone_changes_the_z_and_the_lan(self, w):
        owner_setup(w)
        boss = manager_of(w)
        code, out = put(w, w.six[3], user=boss, preset="remote_shop_z")
        assert code == 403 and out["detail"] == "super_admin_only" and "מנהל-על" in out["message"]
        code, out = put(w, w.six[3], user=boss, tablesMode=SINGLE)
        assert code == 403
        # The printing is a manager's.
        code, out = put(w, w.six[3], user=boss, receiptPrinter="USB")
        assert code == 200, out

    def test_an_open_shift_blocks_independence_and_nothing_is_written(self, w):
        owner_setup(w)
        till = w.six[4]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        code, out = put(w, till, preset="independent", tablesMode=SINGLE)
        assert code == 409 and out["detail"] == "independent_switch_open_shift"
        assert "משמרת פתוחה" in out["message"] and out["step"] == "z_participation"
        w.db.expire_all()
        assert not till.independent_till and own(w, till, "tablesMode") is None

    def test_closed_shifts_waiting_for_a_z(self, w):
        owner_setup(w)
        till = w.six[4]
        closed_shift(w, till, 1, "5.00")
        w.db.commit()
        code, out = put(w, till, preset="independent")
        assert code == 409 and out["detail"] == "independent_switch_unreported_shifts" and out["count"] == 1

    def test_own_z_with_an_open_shift(self, w):
        owner_setup(w)
        till = w.six[3]
        w.shift(till, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        code, out = put(w, till, preset="own_z")
        assert code == 409 and out["detail"] == "till_open" and out["step"] == "z_mode"
        w.db.expire_all()
        assert till.z_mode == "cloud"

    def test_the_main_till_is_not_moved_while_a_z_run_is_under_way(self, w, z_activity_unchecked):
        cloud_shop(w)
        t1, t2 = w.six[0], w.six[1]
        closed_shift(w, t1, 1, "5.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        run_z(w, [t1, t2])
        w.six[3].lan_server_excluded = True
        w.db.commit()
        code, out = put(w, w.six[3], preset="main_till", enableLocalNetwork=True)
        assert code == 409 and out["detail"] == "z_run_in_progress"
        # All or nothing: the flag cleared on the way is back.
        w.db.expire_all()
        assert w.six[3].lan_server_excluded is True and w.shop.local_network is False

    def test_the_shop_z_producer_guard(self, w):
        owner_setup(w)
        report(w, w.six[0], pending=2, last=7)
        w.db.commit()
        code, out = put(w, w.six[2], preset="main_till")
        assert code == 409 and out["detail"] == LZ.BUSY and "2 דוחות Z סניפיים" in out["message"]
        w.db.expire_all()
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[0].id
        code, out = put(w, w.six[2], preset="main_till", force=True)
        assert code == 200, out
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[2].id

    def test_unavailable_presets_say_why(self, w):
        owner_setup(w)
        code, out = put(w, w.six[2], preset="shop_z_cloud")
        assert code == 409 and out["detail"] == "work_config_shop_is_lan"
        code, out = put(w, w.six[0], preset="lan_member")
        assert code == 409 and out["detail"] == "work_config_is_main_till"
        code, out = put(w, w.six[2], preset="kiosk_shop_z")
        assert code == 409 and out["detail"] == "work_config_wrong_role"
        code, out = put(w, w.six[2], preset="nope")
        assert code == 422 and out["detail"] == "work_config_unknown_preset"

    def test_a_choice_the_preset_does_not_offer(self, w):
        owner_setup(w)
        code, out = put(w, w.six[4], preset="independent", tablesMode=SYNCED)
        assert code == 422 and out["detail"] == "work_config_value_not_allowed"
        code, out = put(w, w.six[4], preset="remote_shop_z", tablesMode=LAN)
        assert code == 422
        code, out = put(w, w.six[2], receiptPrinter="מדפסת שלא קיימת")
        assert code == 422 and out["field"] == "receiptPrinter"
        code, out = put(w, w.six[2], workflowTargets=["fax"])
        assert code == 422 and out["field"] == "workflowTargets"

    def test_the_main_till_cannot_be_marked_not_a_server(self, w):
        owner_setup(w)
        code, out = put(w, w.six[0], lanServerExcluded=True)
        assert code == 409 and out["detail"]["code"] == LS.EXCLUDED_IS_MAIN
        assert "היא הקופה הראשית" in out["message"]

    def test_a_remote_device_is_never_a_server(self, w):
        owner_setup(w)
        assert put(w, w.six[4], preset="remote_shop_z")[0] == 200
        code, out = put(w, w.six[4], lanServerExcluded=False)
        assert code == 422 and "מרוחק" in out["message"]

    def test_a_device_with_no_shop(self, w):
        till = w.six[4]
        till.shop_id = None
        till.pairing_status = PairingStatus.PAIRED
        w.db.commit()
        code, out = put(w, till, preset="lan_member")
        assert code == 409 and out["detail"] == "work_config_requires_shop"


# ── Pairing ───────────────────────────────────────────────────────────────────


def _seat(monkeypatch):
    """The register number's regex is Postgres-only: seat the machine in the shop directly."""

    def _assign(db, machine_id, shop_id):
        machine = db.get(POSMachine, machine_id)
        machine.shop_id = shop_id
        machine.pairing_status = PairingStatus.ASSIGNED
        db.flush()
        return machine

    monkeypatch.setattr(P, "assign_machine_to_shop", _assign)


def _code(w, plan, *, role=None, options=None, shop=True, target=None, by=None) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"C{uuid.uuid4().hex[:7].upper()}", distributor_id=(by or w.admin).id,
        tenant_id=w.tenant.id, shop_id=w.shop.id if shop else None, target_machine_id=target,
        device_role=role, kiosk_options=options, work_config=plan,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def generate(w, user=None, **body):
    out = pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    if isinstance(out, JSONResponse):
        return out.status_code, json.loads(out.body)
    return 201, out


def distributor(w):
    u = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=w.tenant.id, email="d@x", username="dist")
    w.db.add(u)
    w.db.commit()
    return u


class TestPairing:
    def test_the_code_carries_the_plan(self, w):
        owner_setup(w)
        code, out = generate(w, shopId=w.shop.id, deviceRole="till", workConfig={"preset": "remote_shop_z"})
        assert code == 201
        assert out.work_config == {"preset": "remote_shop_z"}
        assert PairingCodeResponse.model_validate(out).model_dump(by_alias=True)["workConfig"] == {"preset": "remote_shop_z"}

    def test_by_the_shop_needs_nothing(self, w):
        code, out = generate(w, shopId=w.shop.id, deviceRole="till", workConfig={"preset": "lan_member"})
        assert code == 201 and out.work_config is None  # a new device in a LAN shop is that already

    def test_refused_while_the_dialog_is_open(self, w):
        owner_setup(w)
        code, out = generate(w, shopId=w.shop.id, deviceRole="till", workConfig={"preset": "shop_z_cloud"})
        assert code == 409 and out["detail"] == "work_config_shop_is_lan"
        code, out = generate(w, deviceRole="till", workConfig={"preset": "independent"})
        assert code == 400 and out["detail"] == "work_config_requires_shop"
        # A distributor adds devices "לפי הסניף" — and may set the printing; the Z is the super admin's.
        dist = distributor(w)
        code, out = generate(w, user=dist, shopId=w.shop.id, deviceRole="till", workConfig={"preset": "independent"})
        assert code == 403 and out["detail"] == "super_admin_only"
        code, out = generate(w, user=dist, shopId=w.shop.id, deviceRole="till", workConfig={"receiptPrinter": "USB"})
        assert code == 201 and out.work_config == {"receiptPrinter": "USB"}

    def test_applied_as_the_device_pairs(self, w, monkeypatch, _quiet):
        _seat(monkeypatch)
        owner_setup(w)
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        w.db.commit()
        code = _code(w, {"preset": "remote_shop_z", "tablesMode": SINGLE})
        machine = P.validate_pairing_code(w.db, code.code, {}, "בר בכניסה")
        assert machine.pairing_status == PairingStatus.ASSIGNED
        assert str(machine.id) in LZ.remote_till_ids(w.db.get(type(w.shop), w.shop.id))
        assert machine.lan_server_excluded is True and own(w, machine, "tablesMode") == SINGLE
        result = w.db.get(PairingCode, code.id).work_config_result
        assert result["applied"] is True and "remote" in result["changes"]
        outcome = get(w, machine)["pairing"]
        assert outcome["preset"] == "remote_shop_z" and outcome["applied"] is True
        assert _quiet  # the shop's tills told

    def test_a_new_main_till(self, w, monkeypatch):
        _seat(monkeypatch)
        cloud_shop(w)
        code = _code(w, {"preset": "main_till", "enableLocalNetwork": True})
        machine = P.validate_pairing_code(w.db, code.code, {}, "שרת")
        assert MT.main_till_of_shop(w.db, w.shop.id).id == machine.id
        assert LZ.local_mode_of_shop(w.db, w.shop)

    def test_a_kiosk_with_its_own_z(self, w, monkeypatch):
        _seat(monkeypatch)
        code = _code(w, {"preset": "kiosk_own_z"}, role="kiosk", options={"name": "קיוסק", "lockDevice": False})
        machine = P.validate_pairing_code(w.db, code.code, {}, "קיוסק")
        assert w.db.get(KioskDevice, machine.id) is not None
        assert machine.independent_till and machine.z_mode == "till"

    def test_a_refusal_never_fails_the_pairing_and_is_kept(self, w, monkeypatch):
        _seat(monkeypatch)
        owner_setup(w)
        # The shop's "רשת מקומית" went off after the code was made (the code is not committed:
        # a reload from SQLite would read `expires_at` naive).
        code = _code(w, {"preset": "remote_shop_z"})
        w.shop.local_network = False
        w.db.flush()
        machine = P.validate_pairing_code(w.db, code.code, {}, "בר")
        assert machine is not None and machine.pairing_status == PairingStatus.ASSIGNED
        assert str(machine.id) not in LZ.remote_till_ids(w.shop) and not machine.lan_server_excluded
        outcome = get(w, machine)["pairing"]
        assert outcome["applied"] is False and outcome["detail"] == "work_config_shop_not_lan"
        assert "רשת מקומית" in outcome["message"]

    def test_a_replacement_keeps_the_tills_configuration(self, w, monkeypatch):
        _seat(monkeypatch)
        owner_setup(w)
        old = w.six[3]
        code = _code(w, {"preset": "independent"}, target=old.id)
        machine = P.validate_pairing_code(w.db, code.code, {}, "החלפה")
        assert machine.id == old.id and not machine.independent_till
        assert w.db.get(PairingCode, code.id).work_config_result is None


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    def _module(self, monkeypatch):
        import importlib.util
        from types import SimpleNamespace

        path = next(Path(__file__).resolve().parents[1].glob("alembic/versions/e5b9d3f7a1c4_*.py"))
        spec = importlib.util.spec_from_file_location("work_config_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "context", SimpleNamespace(is_offline_mode=lambda: False))
        return module

    def test_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = Path(__file__).resolve().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert "e5b9d3f7a1c4" in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision("e5b9d3f7a1c4").down_revision == "c7e2f4a9d1b6"

    def test_adds_the_two_columns_once(self, monkeypatch):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module(monkeypatch)
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.exec_driver_sql("CREATE TABLE pairing_codes (id CHAR(32) PRIMARY KEY, code VARCHAR(50))")
            for _ in range(2):  # idempotent: the second run finds them
                with Operations.context(MigrationContext.configure(conn)):
                    module.upgrade()
            columns = {c["name"] for c in sa.inspect(conn).get_columns("pairing_codes")}
        assert {"work_config", "work_config_result"} <= columns
