"""
"מרוחקת בזד הסניפי" — a till that is not on the shop's local server but is in the shop Z
(P:/specs/dedicated-local-server.md §12, "לא מחוברת לשרת, בזד הסניפי"). The combination already
exists: the device preset `remote_shop_z` (app/services/work_config.py) — a participant set
"מרוחק (דרך הענן)" (docs/SPEC_INDEPENDENT_TILL.md §8.14), "לא משמש כשרת מקומי", tables off or
«קופה אחת». The card "קופות בזד הסניפי" sets it too (the `remote` list).

What each class pins, end to end:

* **Off the local server** — never the main till, tables host or print server, whatever is set
  on it (also when only the card set it remote); never handed the LAN tables host nor the print
  server's LAN address (its own printers directly, a shop printer it does not reach through the
  cloud relay); its tables «קופה אחת» or off; the main-till card and "העבר את השרת" refuse it.
* **In the shop Z** — the cloud's run takes its shifts; in local mode the main till takes its
  part through the cloud, waits for it, verifies it and marks it taken once — and its next close
  first hears which of its shifts a Z already took (`pendingShopZPart.assigned`), as a till on
  the LAN does from the board.
* **Switching** — on or off the local server only by the super admin over a clean break;
  a Windows device or a stale entry never asks for one.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.shop_z_remote_part import ShopZRemotePart
from app.models.z_report import ZReport
from app.routers import machines as machines_router
from app.routers import till_shop_z_local as LR
from app.services import independent_till as IT
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import tables_state as TS
from app.services import till_parameters as TP
from app.services import work_config as WC
from app.services import z_runs as ZR
from app.services.printers import hosted_by_tills, print_host_block, print_host_of_shop
from app.services.tables import lan_host_block, tables_host_of_shop
from test_independent_till import (  # noqa: F401 - `w` is the fixture
    _manifest_body, _part, _put_remote, _report_body, _verification, closed_shift, cloud_mode, manager,
    owner_setup, put_main, run_z, set_param, upload, w,
)

HOST_KEYS = ("mainTill", "tablesHostTill", "printHostTill", "shopZMasterTill")
LAN = "רשת מקומית (קופה ראשית)"
SYNCED = "מסונכרן בין הקופות"
SINGLE = "קופה אחת"
OFF = "כבוי"


def remote_by_preset(w, till):
    """Till → "קופה מרוחקת בזד הסניפי" through the device's work config (the preset)."""
    WC.apply(w.db, w.admin, till, {"preset": WC.REMOTE_SHOP_Z})
    w.db.commit()


def ask_remote(w, main, till, request_id, round_id="r1"):
    return LR.till_shop_z_remote_close(
        str(main.id),
        LR.RemoteCloseIn.model_validate({"roundId": round_id, "requests": [{"machineId": str(till.id), "requestId": request_id}]}),
        machine=main, db=w.db,
    )


def answer(w, till, shift, request_id, round_id="r1"):
    part = _part(w, till, [shift])
    section = {
        "machineId": str(till.id), "posNumber": till.pos_number, "machineName": till.name,
        "shiftIds": part["shiftIds"], "till": part["till"], "report": part["report"], "manifest": part["manifest"],
    }
    LR.till_shop_z_remote_part(
        str(till.id), _report_body(request_id, round_id, till, "closed", section, str(shift.id)), machine=till, db=w.db,
    )
    return part


# ── Off the local server ──────────────────────────────────────────────────────


class TestOffTheLocalServer:
    def test_the_preset_is_the_combination(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        assert LZ.is_remote_participant(four)
        assert four.z_mode == "cloud" and not four.independent_till and four.lan_server_excluded
        assert str(four.id) in LZ.remote_till_ids(w.shop)
        ctx = WC.context_for_machine(w.db, four)
        assert WC.current_preset(ctx) == WC.REMOTE_SHOP_Z
        assert IT.role_of(four) == "shop_z"
        row = next(t for t in IT.shop_state(w.db, w.shop, w.admin)["tills"] if t["posNumber"] == "4")
        assert row["role"] == "shop_z" and row["link"] == "remote"

    @pytest.mark.parametrize("how", ["preset", "card"])
    def test_never_a_host_whatever_is_set_on_it(self, w, how):
        owner_setup(w)
        four = w.six[3]
        if how == "preset":
            remote_by_preset(w, four)
        else:  # the card alone: "מרוחק (דרך הענן)", not "לא משמש כשרת מקומי"
            _put_remote(w, [four.id])
            assert not four.lan_server_excluded
        # The main till is the card's to name (and it refuses a remote one); the other host flags,
        # set on it anyway, never make it a server.
        keys = HOST_KEYS if how == "preset" else tuple(k for k in HOST_KEYS if k != "mainTill")
        for key in keys:
            set_param(w, key, "machine", four.id, True)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert tables_host_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert print_host_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert str(four.id) not in {t["machineId"] for t in MT.shop_tills_out(w.db, w.shop.id)}
        params = TP.till_parameters_for_machine(w.db, four).parameters
        assert all(params[k] is False for k in HOST_KEYS)

    def test_a_till_marked_the_main_till_is_the_server_never_remote(self, w):
        """A list from before that names the main till never takes the shop's server away."""
        owner_setup(w)
        main = w.six[0]
        LZ.set_remote_till_ids(w.shop, [main.id])
        w.db.commit()
        assert not LZ.is_remote_participant(main)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == main.id
        assert print_host_block(w.db, main)["isSelf"] is True and lan_host_block(w.db, main)["isSelf"] is True

    def test_handed_no_lan_tables_host_and_no_print_server(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        # As an independent till: no LAN tables host, no print server — its own printers.
        assert lan_host_block(w.db, four) is None
        assert print_host_block(w.db, four) is None
        from app.services.printers import sync_payload

        payload = sync_payload(w.db, four)
        assert payload.get("printHost") is None and not payload.get("hostsLan")
        # A till on the server still has both.
        assert lan_host_block(w.db, w.six[1])["machineId"] == str(w.six[0].id)
        assert print_host_block(w.db, w.six[1])["machineId"] == str(w.six[0].id)

    def test_a_cloud_printer_hosted_by_another_till_is_named_never_addressed(self, w):
        from app.models.printers import KitchenPrintHost, KitchenPrinter

        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        w.db.add(KitchenPrintHost(machine_id=w.six[1].id, shop_id=w.shop.id, lan_address="10.0.0.12", port=8399))
        w.db.flush()
        printer = KitchenPrinter(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר", connection_type="cloud",
            host_machine_id=w.six[1].id,
        )
        # Off the LAN: its name only — the job goes through the cloud relay.
        assert hosted_by_tills(w.db, four, [printer])[str(w.six[1].id)]["lanAddress"] is None
        # A till on the server is told where the host listens.
        assert hosted_by_tills(w.db, w.six[2], [printer])[str(w.six[1].id)]["lanAddress"] == "10.0.0.12"

    def test_its_tables_are_single_or_off(self, w):
        owner_setup(w)
        four = w.six[3]
        set_param(w, "tablesMode", "shop", w.shop.id, LAN)
        _put_remote(w, [four.id])  # the card alone: no tables of its own set
        assert TP.till_parameters_for_machine(w.db, four).parameters["tablesMode"] == SINGLE
        assert TP.till_parameters_for_machine(w.db, w.six[1]).parameters["tablesMode"] == LAN
        for own, reads in ((LAN, SINGLE), (SYNCED, SINGLE), (SINGLE, SINGLE), (OFF, OFF)):
            set_param(w, "tablesMode", "machine", four.id, own)
            assert TP.till_parameters_for_machine(w.db, four).parameters["tablesMode"] == reads
        # The preset writes "כבוי" at its own level by default.
        remote_by_preset(w, w.six[2])
        assert TP.till_parameters_for_machine(w.db, w.six[2]).parameters["tablesMode"] == OFF

    def test_never_made_the_main_till_or_takes_over(self, w):
        owner_setup(w)
        four = w.six[3]
        _put_remote(w, [four.id])
        with pytest.raises(HTTPException) as e:
            put_main(w, str(four.id))
        assert e.value.status_code == 409 and e.value.detail["code"] == "remote_main_till"
        assert "לא מחוברת לשרת המקומי" in e.value.detail["message"]
        with pytest.raises(HTTPException) as e:
            MT.take_over(w.db, four)
        assert e.value.detail == MT.REMOTE
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[0].id

    def test_its_z_is_the_shops_never_its_own(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        beat = machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        assert beat["zMode"] == "cloud" and beat["independentTill"] is False
        assert four.id not in ZR.per_till_ids(w.db, w.six)

    def test_a_windows_device_and_a_stale_entry_are_not_moved_off_the_lan(self, w):
        owner_setup(w)
        five = w.six[4]
        five.platform = "windows"
        w.db.commit()
        _put_remote(w, [five.id])
        assert not LZ.is_remote_participant(five)  # closed through the cloud by its platform only
        assert LZ.closes_through_cloud(five, LZ.remote_till_ids(w.shop))
        # Till 6 (independent) and the main till on the stored list by an older save: neither is
        # moved off the LAN — the main till stays the shop's server, serving itself.
        LZ.set_remote_till_ids(w.shop, [w.six[5].id, w.six[0].id])
        w.db.commit()
        assert not LZ.is_remote_participant(w.six[5]) and not LZ.is_remote_participant(w.six[0])
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert print_host_block(w.db, w.six[0])["isSelf"] is True
        assert lan_host_block(w.db, w.six[0])["isSelf"] is True
        # And dropping them is no move: a save while the main till has an open shift goes through.
        w.shift(w.six[0], 1, status=ShiftStatus.OPEN)
        w.db.commit()
        out = _put_remote(w, [])
        assert out.get("detail") is None, out

    def test_the_cards_change_reaches_the_tables_state(self, w):
        owner_setup(w)
        before = TS.current_version(w.db, w.shop.id)
        _put_remote(w, [w.six[3].id])
        after = TS.current_version(w.db, w.shop.id)
        assert after > before
        _put_remote(w, [w.six[3].id])  # the same list again: no change
        assert TS.current_version(w.db, w.shop.id) == after


# ── In the shop Z ─────────────────────────────────────────────────────────────


class TestInTheShopZ:
    def test_the_clouds_run_takes_its_shifts(self, w, z_activity_unchecked):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        cloud_mode(w)  # the shop leaves local mode: the cloud makes its Z again
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        z = w.db.get(ZReport, run_z(w, w.six[:5]).z_report_id)
        assert str(four.id) in {s["machineId"] for s in z.per_machine}
        assert str(z.total_sales) in ("50.00", "50")
        assert shifts[four.id].z_report_id == z.id

    def test_the_clouds_run_waits_for_its_open_shift_like_any_till(self, w, z_activity_unchecked):
        from app.services import till_z

        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        cloud_mode(w)
        for m in w.six[:5]:
            if m.id != four.id:
                closed_shift(w, m, 1, "10.00")
        w.shift(four, 1, status=ShiftStatus.OPEN)
        run = run_z(w, w.six[:5])
        assert run.z_report_id is None and till_z.live_z_run_item(w.db, four.id) is not None

    def test_local_mode_its_part_comes_through_the_cloud_is_waited_for_and_taken_once(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        main = w.six[0]
        hist = LR.till_shop_z_history(str(main.id), days=31, machine=main, db=w.db)
        assert {p["posNumber"]: p["remote"] for p in hist["participants"]} == {
            "1": False, "2": False, "3": False, "4": True, "5": False,
        }
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        out = ask_remote(w, main, four, "q4")
        assert out["refused"] == []
        beat = machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        assert beat["pendingShopZPart"] == {"requestId": "q4", "roundId": "r1", "force": True}
        # Not answered yet: the main till has nothing to take — it waits ("ממתין לסגירה דרך הענן").
        pulled = LR.till_shop_z_remote_parts(str(main.id), round_id="r1", machine=main, db=w.db)
        assert [(p["state"], p["report"]) for p in pulled["parts"]] == [("delivered", None)]
        part = answer(w, four, shifts[four.id], "q4")
        pulled = LR.till_shop_z_remote_parts(str(main.id), round_id="r1", machine=main, db=w.db)
        assert [p["state"] for p in pulled["parts"]] == ["reported"]
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5] if m.id != four.id] + [part]
        code, z_out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201, z_out
        z = w.db.get(ZReport, uuid.UUID(z_out["zReportId"]))
        assert str(four.id) in {s["machineId"] for s in z.per_machine}
        assert _verification(w, z_out)["state"] == "verified"
        assert shifts[four.id].z_report_id == z.id
        assert w.db.query(ShopZRemotePart).one().state == "taken"
        # Its shift is in one Z only: a second Z naming it is refused (a conflict), never filed twice.
        code, again = upload(w, main, _manifest_body(w, 2, [_part(w, four, [shifts[four.id]])]))
        assert code == 409 and again["detail"] == "offline_z_shift_in_another_z"
        assert w.db.query(ZReport).filter(ZReport.shop_sequence_number.isnot(None)).count() == 1

    def test_its_next_close_first_hears_which_shifts_a_z_took(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        main = w.six[0]
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        ask_remote(w, main, four, "q1")
        machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        part = answer(w, four, shifts[four.id], "q1")
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5] if m.id != four.id] + [part]
        code, z_out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201
        # The next round: the close the till hears names the Z that took its shift — as the LAN
        # board's `assigned` does — so its next part never names that shift again.
        ask_remote(w, main, four, "q2", round_id="r2")
        beat = machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        assert beat["pendingShopZPart"]["requestId"] == "q2"
        assert beat["pendingShopZPart"]["assigned"] == [
            {"zId": z_out["zReportId"], "number": 1, "shiftIds": [str(shifts[four.id].id)]},
        ]
        # Only its own shifts, never another till's.
        assert LZ.shift_assignments(w.db, w.six[1]) == [
            {"zId": z_out["zReportId"], "number": 1, "shiftIds": [str(shifts[w.six[1].id].id)]},
        ]


# ── Switching on or off the local server ─────────────────────────────────────


class TestSwitching:
    def test_super_admin_only(self, w):
        owner_setup(w)
        with pytest.raises(HTTPException) as e:
            IT.apply_shop(w.db, manager(w), w.shop, remote=[w.six[3].id])
        assert e.value.status_code == 403

    @pytest.mark.parametrize("to_remote", [True, False])
    def test_refused_with_an_open_shift(self, w, to_remote):
        owner_setup(w)
        four = w.six[3]
        if not to_remote:
            _put_remote(w, [four.id])
        w.shift(four, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        out = _put_remote(w, [four.id] if to_remote else [])
        assert out["detail"] == "independent_switch_open_shift"
        target = "מרוחקת בזד הסניפי" if to_remote else "מחוברת לשרת המקומי"
        assert target in out["message"] and "משמרת פתוחה" in out["message"]
        w.db.refresh(w.shop)
        assert (str(four.id) in LZ.remote_till_ids(w.shop)) is (not to_remote)

    def test_refused_with_closed_shifts_waiting_for_a_z(self, w):
        owner_setup(w)
        four = w.six[3]
        closed_shift(w, four, 1, "5.00")
        w.db.commit()
        out = _put_remote(w, [four.id])
        assert out["detail"] == "independent_switch_unreported_shifts" and out["count"] == 1

    def test_refused_while_a_z_is_under_way(self, w, z_activity_unchecked):
        owner_setup(w)
        cloud_mode(w)
        four = w.six[3]
        closed_shift(w, w.six[0], 1, "5.00")
        w.shift(four, 1, status=ShiftStatus.OPEN)
        run_z(w, [w.six[0], four])
        w.db.commit()
        out = _put_remote(w, [four.id])
        assert out["detail"] in ("independent_switch_z_in_progress", "independent_switch_open_shift")

    def test_the_preset_keeps_the_same_rules(self, w):
        owner_setup(w)
        four = w.six[3]
        w.shift(four, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        with pytest.raises(WC.WorkConfigRefused) as e:
            WC.apply(w.db, w.admin, four, {"preset": WC.REMOTE_SHOP_Z})
        assert e.value.body["detail"] == "independent_switch_open_shift"

    def test_a_clean_break_both_ways_and_unrelated_tills_are_not_asked(self, w):
        owner_setup(w)
        four = w.six[3]
        # Till 2 has an open shift: it does not move, so it does not hold the save.
        w.shift(w.six[1], 1, status=ShiftStatus.OPEN)
        w.db.commit()
        out = _put_remote(w, [four.id])
        assert out.get("detail") is None, out
        assert LZ.is_remote_participant(four)
        out = _put_remote(w, [])
        assert out.get("detail") is None, out
        assert not LZ.is_remote_participant(four)


# ── The card: all four, every move over a clean break ────────────────────────

ROLES = ("shop_z", "remote_shop_z", "own_z", "independent")


def role_on_card(till):
    if till.independent_till:
        return "independent"
    if till.z_mode == "till":
        return "own_z"
    return "remote_shop_z" if LZ.is_remote_participant(till) else "shop_z"


def put_role(w, till, role, user=None):
    """The card's save putting `till` in `role` (the body the dashboard sends: lists + remote)."""
    from app.routers import z_participation as ZP
    from test_independent_till import _Tasks

    remote = {i for i in LZ.remote_till_ids(w.shop) if i != str(till.id)}
    body = {"participants": [], "independent": [], "ownZ": []}
    if role in ("shop_z", "remote_shop_z"):
        body["participants"] = [str(till.id)]
    elif role == "own_z":
        body["ownZ"] = [str(till.id)]
    else:
        body["independent"] = [str(till.id)]
    if role == "remote_shop_z":
        remote.add(str(till.id))
    body["remote"] = sorted(remote)
    out = ZP.put_z_participation(
        w.shop.id, ZP.ZParticipationIn.model_validate(body),
        background_tasks=_Tasks(), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    if isinstance(out, dict):
        return 200, out
    return out.status_code, json.loads(out.body)


#: How a refusal names where the till was going.
TARGET_WORDS = {
    "shop_z": "ל-Z הסניפי",
    "remote_shop_z": "מרוחקת בזד הסניפי",
    "own_z": "Z בקופה, בתוך הסניף",
    "independent": "לקופה עצמאית",
}


class TestTheCardsFourRoles:
    @pytest.mark.parametrize("start", ROLES)
    @pytest.mark.parametrize("end", ROLES)
    def test_every_move_over_a_clean_break(self, w, start, end):
        owner_setup(w)
        four = w.six[3]
        code, out = put_role(w, four, start)
        assert code == 200, out
        assert role_on_card(four) == start
        code, out = put_role(w, four, end)
        assert code == 200, out
        w.db.refresh(four)
        assert role_on_card(four) == end
        # The card shows it so: the server's role, and the link for a till of the shop Z.
        row = next(t for t in out["tills"] if t["machineId"] == str(four.id))
        expected = {"shop_z": ("shop_z", "lan"), "remote_shop_z": ("shop_z", "remote"),
                    "own_z": ("own_z", None), "independent": ("independent", None)}[end]
        assert row["role"] == expected[0]
        if expected[1]:
            assert row["link"] == expected[1]
        assert four.z_mode == ("cloud" if end in ("shop_z", "remote_shop_z") else "till")
        assert bool(four.independent_till) is (end == "independent")

    @pytest.mark.parametrize("start", ROLES)
    @pytest.mark.parametrize("end", ROLES)
    def test_never_over_an_open_shift_said_in_hebrew(self, w, start, end):
        if start == end:
            pytest.skip("no move")
        owner_setup(w)
        four = w.six[3]
        assert put_role(w, four, start)[0] == 200
        w.shift(four, 1, status=ShiftStatus.OPEN)
        w.db.commit()
        code, out = put_role(w, four, end)
        assert code == 409 and out["detail"] == "independent_switch_open_shift", out
        assert TARGET_WORDS[end] in out["message"] and "משמרת פתוחה" in out["message"]
        assert out["posNumber"] == "4"
        w.db.refresh(four)
        assert role_on_card(four) == start  # nothing written

    @pytest.mark.parametrize("end", ["remote_shop_z", "own_z", "independent"])
    def test_never_over_closed_shifts_waiting_for_a_z(self, w, end):
        owner_setup(w)
        four = w.six[3]
        closed_shift(w, four, 1, "5.00")
        w.db.commit()
        code, out = put_role(w, four, end)
        assert code == 409 and out["detail"] == "independent_switch_unreported_shifts"
        assert "משמרות סגורות שעוד לא נכללו ב-Z" in out["message"]

    @pytest.mark.parametrize("end", ["remote_shop_z", "own_z", "independent"])
    def test_the_super_admins_alone(self, w, end):
        owner_setup(w)
        with pytest.raises(HTTPException) as e:
            put_role(w, w.six[3], end, user=manager(w))
        assert e.value.status_code == 403

    def test_the_main_till_stays_the_server_in_the_shop_z(self, w):
        owner_setup(w)
        main = w.six[0]
        for end in ("remote_shop_z", "own_z", "independent"):
            code, out = put_role(w, main, end)
            assert code == 422 and out["detail"] in ("remote_main_till", "main_till_not_participating"), out
            assert out["message"]
        assert role_on_card(main) == "shop_z" and MT.main_till_of_shop(w.db, w.shop.id).id == main.id

    def test_a_z_mode_switch_never_gives_a_remote_till_its_own_z_behind_the_card(self, w):
        from datetime import datetime, timezone

        from app.services import till_z, z_mode_policy
        from app.services import work_profile as WP

        owner_setup(w)
        four = w.six[3]
        assert put_role(w, four, "remote_shop_z")[0] == 200
        with pytest.raises(till_z.TillZRefused) as e:
            z_mode_policy.check_switch(w.db, w.admin, four, "till")
        assert e.value.body["detail"] == "remote_till" and "קופות בזד הסניפי" in e.value.body["message"]
        tills = [m for m in w.six if not m.independent_till]
        with pytest.raises(till_z.TillZRefused):
            z_mode_policy.switch_all(w.db, w.admin, tills, "till")
        w.db.rollback()
        assert all(m.z_mode == "cloud" for m in tills)
        why = WP._switch_refusal(w.db, four, "till", datetime.now(timezone.utc))
        assert why["code"] == "remote_till" and "מרוחקת בזד הסניפי" in why["message"]


# ── Offline and late ──────────────────────────────────────────────────────────


class TestOfflineAndLate:
    def test_a_remote_till_that_is_offline_is_waited_for_never_skipped(self, w):
        from datetime import timedelta

        from shift_world import NOW

        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        main = w.six[0]
        LZ.request_remote_parts(w.db, main, "r1", [{"machineId": str(four.id), "requestId": "q1"}], now=NOW)
        # It does not beat: the request waits; the main till has no answer to take.
        assert [p["state"] for p in LZ.remote_parts(w.db, main, "r1", now=NOW + timedelta(hours=2))["parts"]] == ["requested"]
        # A day and a half later the request lapses — the round still has no answer (never skipped):
        # "נסה שוב" asks again, and the till answers when it is back.
        late = NOW + timedelta(hours=37)
        assert [p["state"] for p in LZ.remote_parts(w.db, main, "r1", now=late)["parts"]] == ["expired"]
        LZ.request_remote_parts(w.db, main, "r1", [{"machineId": str(four.id), "requestId": "q2"}], now=late)
        assert LZ.take_pending_remote_part(w.db, four, now=late)["requestId"] == "q2"
        shift = closed_shift(w, four, 1, "10.00")
        answer(w, four, shift, "q2")
        assert [p["state"] for p in LZ.remote_parts(w.db, main, "r1", now=late)["parts"]] == ["reported"]

    def test_its_close_and_documents_reaching_the_cloud_late_are_waited_for_then_verified(self, w):
        from test_independent_till import _states, _withhold

        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        main = w.six[0]
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        ask_remote(w, main, four, "q1")
        machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        part = answer(w, four, shifts[four.id], "q1")
        # Its part reached the main till; its close and documents not the cloud yet.
        documents_arrive, close_arrives = _withhold(w, four, shifts[four.id])
        w.db.commit()
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5] if m.id != four.id] + [part]
        code, z_out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201, z_out
        v = _verification(w, z_out)
        assert _states(v)["4"] == "waiting" and "ממתין" in v["message"]
        documents_arrive()
        close_arrives()
        w.db.commit()
        LZ.verify_pending(w.db, w.shop.id, force=True)
        w.db.commit()
        z = w.db.get(ZReport, uuid.UUID(z_out["zReportId"]))
        assert z.offline_report["verification"]["state"] == "verified"
        assert shifts[four.id].z_report_id == z.id

    def test_its_late_documents_from_a_closed_period_come_with_its_part(self, w):
        from test_independent_till import _carry_shift, _late_part_of

        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        carry = _carry_shift(w, four, "7.00")
        w.db.commit()
        hist = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        mine = next(p for p in hist["participants"] if p["machineId"] == str(four.id))
        assert mine["remote"] is True and mine["lateDocuments"]["late"] is True
        code, out = upload(w, w.six[0], _manifest_body(w, 1, [_late_part_of(w, four)]))
        assert code == 201, out
        assert carry.z_report_id == uuid.UUID(out["zReportId"])
        # The carry shift is the cloud's: never handed to the till as one of its own.
        assert LZ.shift_assignments(w.db, four) == []


# ── Numbering, and every shift exactly once ─────────────────────────────────


class TestNumberingAndOnce:
    def _round(self, w, main, four, shifts, number, request_id, round_id):
        ask_remote(w, main, four, request_id, round_id=round_id)
        machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        part = answer(w, four, shifts[four.id], request_id, round_id=round_id)
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5] if m.id != four.id] + [part]
        return upload(w, main, _manifest_body(w, number, parts))

    def test_two_rounds_numbered_one_two_and_each_shift_once(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        main = w.six[0]
        day1 = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        code, z1 = self._round(w, main, four, day1, 1, "q1", "r1")
        assert code == 201
        day2 = {m.id: closed_shift(w, m, 2, "20.00") for m in w.six[:5]}
        w.db.commit()
        code, z2 = self._round(w, main, four, day2, 2, "q2", "r2")
        assert code == 201, z2
        zs = w.db.query(ZReport).filter(ZReport.shop_sequence_number.isnot(None)).order_by(ZReport.shop_sequence_number).all()
        assert [z.shop_sequence_number for z in zs] == [1, 2]
        assert day1[four.id].z_report_id == zs[0].id and day2[four.id].z_report_id == zs[1].id
        assert [str(zs[0].total_sales), str(zs[1].total_sales)] == ["50.00", "100.00"]
        # A number that is not the next is never filed — kept for support, never renumbered.
        extra = closed_shift(w, w.six[1], 3, "1.00")
        code, out = upload(w, main, _manifest_body(w, 4, [_part(w, w.six[1], [extra])]))
        assert code == 409 and out["detail"] == "offline_z_out_of_sequence"
        assert w.db.query(ZReport).filter(ZReport.shop_sequence_number.isnot(None)).count() == 2

    def test_a_part_naming_a_shift_a_z_took_never_reaches_the_main_till(self, w):
        """An older remote till (no `assigned`) re-sends a taken shift: refused, the request stays live."""
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        main = w.six[0]
        day1 = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        code, _ = self._round(w, main, four, day1, 1, "q1", "r1")
        assert code == 201
        ask_remote(w, main, four, "q2", round_id="r2")
        machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        part = _part(w, four, [day1[four.id]])
        section = {"machineId": str(four.id), "posNumber": "4", "shiftIds": part["shiftIds"], "till": part["till"],
                   "report": part["report"], "manifest": part["manifest"]}
        resp = LR.till_shop_z_remote_part(
            str(four.id), _report_body("q2", "r2", four, "closed", section, str(day1[four.id].id)), machine=four, db=w.db,
        )
        body = json.loads(resp.body)
        assert resp.status_code == 409 and body["detail"] == "shift_in_another_z" and body["zNumbers"] == [1]
        assert "כבר נכללה ב-Z סניפי מס׳ 1" in body["message"]
        # The main till has nothing to take; the till still hears the close.
        pulled = LR.till_shop_z_remote_parts(str(main.id), round_id="r2", machine=main, db=w.db)
        assert [(p["state"], p["report"]) for p in pulled["parts"]] == [("delivered", None)]
        assert machines_router.post_my_heartbeat(None, machine=four, db=w.db)["pendingShopZPart"]["requestId"] == "q2"
        # Answered with nothing new ("no_open_shift", no shift): taken as such.
        LR.till_shop_z_remote_part(str(four.id), _report_body("q2", "r2", four, "no_open_shift"), machine=four, db=w.db)
        pulled = LR.till_shop_z_remote_parts(str(main.id), round_id="r2", machine=main, db=w.db)
        assert [p["state"] for p in pulled["parts"]] == ["reported"]

    def test_a_shift_linked_to_a_z_in_the_cloud_is_refused_too(self, w, z_activity_unchecked):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        cloud_mode(w)
        day1 = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        z = w.db.get(ZReport, run_z(w, w.six[:5]).z_report_id)
        assert day1[four.id].z_report_id == z.id
        w.shop.local_network = True
        w.db.query(TP.TillParameterValue).filter(
            TP.TillParameterValue.scope_id == w.six[1].id
        ).delete(synchronize_session=False)  # back to the owner's LAN: till 1 serves
        w.db.commit()
        main = w.six[0]
        ask_remote(w, main, four, "q9", round_id="r9")
        section = {"machineId": str(four.id), "shiftIds": [str(day1[four.id].id)]}
        resp = LR.till_shop_z_remote_part(
            str(four.id), _report_body("q9", "r9", four, "closed", section), machine=four, db=w.db,
        )
        assert resp.status_code == 409 and json.loads(resp.body)["detail"] == "shift_in_another_z"


# ── Never a till Z of its own ────────────────────────────────────────────────


class TestNeverATillZ:
    def test_a_till_z_is_refused_it_is_in_the_shop_z(self, w):
        from app.routers import sync as sync_router
        from app.schemas.till_z import TillZIn

        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        closed_shift(w, four, 1, "10.00")
        resp = sync_router.post_till_z(
            machine_id=str(four.id), body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}),
            machine=four, db=w.db,
        )
        assert resp.status_code == 409 and json.loads(resp.body)["detail"] == "till_z_disabled"
        assert w.db.query(ZReport).filter(ZReport.machine_id == four.id).count() == 0


# ── Older apps ───────────────────────────────────────────────────────────────


class TestOlderApps:
    def test_the_heartbeat_says_what_it_always_said(self, w):
        owner_setup(w)
        four = w.six[3]
        remote_by_preset(w, four)
        beats = {m.pos_number: machines_router.post_my_heartbeat(None, machine=m, db=w.db) for m in w.six}
        assert (beats["4"]["zMode"], beats["4"]["independentTill"], beats["4"]["lanServerExcluded"]) == ("cloud", False, True)
        assert (beats["6"]["zMode"], beats["6"]["independentTill"]) == ("till", True)
        assert (beats["2"]["zMode"], beats["2"]["independentTill"]) == ("cloud", False)
        # No close for it, no new field: nothing a till that knows nothing of this has to read.
        assert "pendingShopZPart" not in beats["4"]

    def test_the_older_card_save_leaves_the_four_as_they_are(self, w):
        from app.routers import z_participation as ZP
        from test_independent_till import _Tasks

        owner_setup(w)
        assert put_role(w, w.six[3], "remote_shop_z")[0] == 200
        assert put_role(w, w.six[2], "own_z")[0] == 200
        # The older card: only the lists it knew, nothing changed.
        out = ZP.put_z_participation(
            w.shop.id, ZP.ZParticipationIn.model_validate({"participants": [], "independent": []}),
            background_tasks=_Tasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert isinstance(out, dict)
        assert [role_on_card(m) for m in w.six] == [
            "shop_z", "shop_z", "own_z", "remote_shop_z", "shop_z", "independent",
        ]
