"""
"קופה עצמאית בתוך סניף" and the shop Z in local mode (docs/SPEC_INDEPENDENT_TILL.md).

What each class pins:

* **Shop Z excludes the independent till** — not listed on the master's screen, its open
  shift blocks nothing (the rule is "block"), it cannot be selected, its documents are not
  in the shop Z's figures, and the shop's numbering never sees it.
* **Its own Z** — numbered in its own run from 1; the shop's counter does not move; the Z
  says it is an independent till's.
* **Switching** — the super admin's alone, only with no open shift, no closed shift
  waiting for a Z and no Z under way; a till can never be in both (the check); the old
  z-mode switch cannot take it back into the shop Z behind the card's back.
* **LAN hosts** — never the main till, tables host or print server, whatever is set on it;
  it is handed none of them; its host parameters read off and its tables are its own only.
* **The card** — the worked example: tills 1–5 in the shop Z leaning on till 1, till 6
  independent.
* **Local mode** — "allowed with confirmation" reads "block"; no till is left out by
  "proceed"; the local shop Z upload takes exactly the next number (409 with the expected
  one otherwise), is idempotent, waits for closes, reports what the paper got wrong, and
  says so when a participating till's shifts were not in it.
* **Reports** — each Z says what it includes; the day summary says which Zs it adds up.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import sync as sync_router
from app.routers import till_shop_z as SZ
from app.routers import till_shop_z_local as LR
from app.routers import z_participation as ZP
from app.schemas.shift import ShiftCloseIn
from app.schemas.till_z import TillZIn
from app.services import ably_notify
from app.services import independent_till as IT
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import till_parameters as TP
from app.services import z_mode_policy
from app.services import z_runs as ZR
from app.services.printers import print_host_block, print_host_of_shop
from app.services.shifts import apply_shift_close
from app.services.tables import lan_host_block, tables_host_of_shop
from app.services.z_sequence import last_shop_z_number
from shift_world import NOW, TODAY, accept_str_uuids, freeze_z_run_clock, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    # The owner's shop: six tills.
    for n in range(3, 7):
        world.db.add(POSMachine(
            id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id,
            distributor_id=world.admin.id, name=f"Till {n}", machine_code=f"M-{n + 10}",
            pos_number=str(n), is_active=True, pairing_status=PairingStatus.ASSIGNED,
            last_heartbeat_at=datetime.now(timezone.utc) - timedelta(seconds=10),
        ))
    world.db.flush()
    world.six = sorted(
        world.db.query(POSMachine).filter(POSMachine.shop_id == world.shop.id).all(),
        key=lambda m: int(m.pos_number),
    )
    for m in world.six:
        m.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    # The owner's shop works on its LAN: "רשת מקומית" on (docs/SPEC_LAN_MODE.md §4) — with a
    # main till it is in local mode, as the migration set it for every shop that was.
    world.shop.local_network = True
    world.db.commit()
    return world


# ── Helpers ──────────────────────────────────────────────────────────────────


def set_param(w, key, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id,
        TillParameterValue.scope_type == scope_type,
        TillParameterValue.scope_id == scope_id,
    ).delete(synchronize_session=False)
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.flush()


def closed_shift(w, till, seq, *totals):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    made = [w.doc(till, shift, t) for t in totals]
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "transactionIds": [str(d.id) for d in made],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def make_independent(w, till):
    IT.check_switch(w.db, w.admin, till, True)
    assert IT.set_independent(w.db, till, True)
    w.db.commit()


def owner_setup(w):
    """Tills 1–5 in the shop Z leaning on till 1 (the main till); till 6 independent."""
    ZP.put_z_participation(
        w.shop.id,
        ZP.ZParticipationIn.model_validate({
            "participants": [str(m.id) for m in w.six[:5]],
            "independent": [str(w.six[5].id)],
            "mainTillId": str(w.six[0].id),
        }),
        background_tasks=_Tasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    for m in w.six:
        w.db.refresh(m)


class _Tasks:
    def add_task(self, *a, **k):
        pass


def manager(w):
    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, email="m@x", username="m")
    w.db.add(u)
    w.db.flush()
    return u


def run_z(w, tills):
    return ZR.create_z_run(w.db, w.admin, w.tenant, w.shop, [ZR.MachineSelection(machine_id=m.id) for m in tills])


def cloud_mode(w):
    """"רשת מקומית" off (another till prints, too): the shop is not in local mode."""
    set_param(w, "printHostTill", "machine", w.six[1].id, True)
    w.shop.local_network = False
    w.db.flush()
    assert LZ.local_mode_of_shop(w.db, w.shop) is False
    w.db.commit()  # a refused request rolls back to here, never to local mode


def local_z_of_five(w, number=1, seq=1, total="10.00"):
    """A shop Z the main till made over the five, uploaded: (code, out)."""
    shifts = {m.id: closed_shift(w, m, seq, total) for m in w.six[:5]}
    return upload(w, w.six[0], local_body(w, number, [(m, [shifts[m.id]], None) for m in w.six[:5]]))


# ── The worked example ───────────────────────────────────────────────────────


class TestTheOwnersShop:
    def test_tills_1_to_5_in_the_shop_z_on_till_1_and_till_6_independent(self, w):
        owner_setup(w)
        state = IT.shop_state(w.db, w.shop, w.admin)
        roles = {t["posNumber"]: t["role"] for t in state["tills"]}
        assert roles == {"1": "shop_z", "2": "shop_z", "3": "shop_z", "4": "shop_z", "5": "shop_z", "6": "independent"}
        assert state["mainTill"]["posNumber"] == "1"
        assert next(t for t in state["tills"] if t["posNumber"] == "1")["mainTill"] is True
        six = w.six[5]
        assert six.independent_till is True and six.z_mode == "till"
        assert all(m.z_mode == "cloud" and not m.independent_till for m in w.six[:5])
        # Till 1 hosts the LAN; till 6 is handed none of it.
        assert tables_host_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert print_host_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert lan_host_block(w.db, six) is None
        assert print_host_block(w.db, six) is None
        assert print_host_block(w.db, w.six[1])["machineId"] == str(w.six[0].id)

    def test_the_shop_z_says_what_it_includes(self, w, z_activity_unchecked):
        owner_setup(w)
        code, out = local_z_of_five(w)
        assert code == 201, out
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        scope = z.header["scope"]
        assert scope["kind"] == "shop"
        assert scope["label"] == "Z סניפי — כולל קופות 1–5 · לא כולל קופות עצמאיות: 6 (Z נפרד לכל אחת)"
        assert [t["posNumber"] for t in scope["independentOutside"]] == ["6"]


# ── The shop Z excludes the independent till ─────────────────────────────────


class TestShopZExcludesIt:
    def test_not_listed_on_the_masters_screen_and_its_open_shift_blocks_nothing(self, w):
        owner_setup(w)
        main, six = w.six[0], w.six[5]
        w.shift(six, 1, status=ShiftStatus.OPEN)
        closed_shift(w, main, 1, "50.00")
        out = SZ.till_shop_z_status(str(main.id), machine=main, db=w.db)
        assert str(six.id) not in {t["id"] for t in out["tills"]}
        assert len(out["tills"]) == 5
        # Local mode: the rule is "block" — and it still does not see till 6.
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) == "block"
        tills = {m.id: m for m in ZR.shop_tills(w.db, w.shop.id)}
        left = ZR.tills_left_out(
            w.db, w.admin, w.shop, tills, {m.id: ZR.MachineSelection(machine_id=m.id) for m in w.six[:5]},
            own_z=ZR.per_till_ids(w.db, list(tills.values())),
        )
        assert six.id not in {t.machine.id for t in left}

    def test_it_cannot_be_selected_and_its_documents_never_reach_the_figures(self, w, z_activity_unchecked):
        owner_setup(w)
        cloud_mode(w)
        six = w.six[5]
        closed_shift(w, six, 1, "999.00")
        with pytest.raises(Exception) as e:
            run_z(w, [w.six[0], six])
        assert "machine_issues_its_own_z" in json.dumps(getattr(e.value, "body", {}) or str(e.value))
        w.db.rollback()
        for m in w.six[:5]:
            closed_shift(w, m, 1, "10.00")
        z = w.db.get(ZReport, run_z(w, w.six[:5]).z_report_id)
        assert str(z.total_sales) in ("50.00", "50")
        assert str(six.id) not in {s["machineId"] for s in z.per_machine}
        assert z.shop_sequence_number == 1

    def test_its_own_z_has_its_own_number_and_leaves_the_shops_counter(self, w):
        owner_setup(w)
        six = w.six[5]
        closed_shift(w, six, 1, "30.00")
        before = last_shop_z_number(w.db, w.shop.id)
        resp = sync_router.post_till_z(
            machine_id=str(six.id),
            body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}),
            machine=six, db=w.db,
        )
        assert resp.status_code == 201, resp.body
        z = w.db.get(ZReport, uuid.UUID(json.loads(resp.body)["zReport"]["id"]))
        assert z.machine_sequence_number == 1 and z.shop_sequence_number is None
        assert last_shop_z_number(w.db, w.shop.id) == before
        assert z.header["scope"]["kind"] == "independent_till"
        assert "קופה עצמאית" in z.header["scope"]["label"]

    def test_it_never_runs_the_shop_z(self, w):
        owner_setup(w)
        six = w.six[5]
        assert MT.till_shop_z_refusal(w.db, six) == MT.INDEPENDENT
        # Its history tells it the truth: it is not the producer and numbers nothing.
        out = LZ.history(w.db, six)
        assert out["numberCertain"] is False
        assert out["producer"]["machine"]["machineId"] == str(w.six[0].id)


# ── Switching ─────────────────────────────────────────────────────────────────


class TestSwitching:
    def test_super_admin_only(self, w):
        with pytest.raises(HTTPException) as e:
            IT.check_switch(w.db, manager(w), w.six[5], True)
        assert e.value.status_code == 403

    def test_refused_with_an_open_shift(self, w):
        six = w.six[5]
        w.shift(six, 1, status=ShiftStatus.OPEN)
        with pytest.raises(IT.IndependentSwitchRefused) as e:
            IT.check_switch(w.db, w.admin, six, True)
        assert e.value.body["detail"] == "independent_switch_open_shift"
        assert "משמרת פתוחה" in e.value.body["message"]

    def test_refused_with_closed_shifts_waiting_for_a_z(self, w):
        six = w.six[5]
        closed_shift(w, six, 1, "5.00")
        with pytest.raises(IT.IndependentSwitchRefused) as e:
            IT.check_switch(w.db, w.admin, six, True)
        assert e.value.body["detail"] == "independent_switch_unreported_shifts"
        assert e.value.body["count"] == 1
        assert "ה-Z הסניפי" in e.value.body["message"]

    def test_refused_while_a_z_is_under_way(self, w, z_activity_unchecked):
        t1, t2 = w.six[0], w.six[1]
        closed_shift(w, t1, 1, "5.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        run_z(w, [t1, t2])  # t2 is asked to close: a live item holds it
        w.db.commit()
        with pytest.raises(IT.IndependentSwitchRefused) as e:
            IT.check_switch(w.db, w.admin, t2, True)
        assert e.value.body["detail"] in ("independent_switch_z_in_progress", "independent_switch_open_shift")

    def test_a_clean_break_switches_both_ways(self, w):
        six = w.six[5]
        make_independent(w, six)
        assert six.independent_till and six.z_mode == "till"
        IT.check_switch(w.db, w.admin, six, False)
        assert IT.set_independent(w.db, six, False)
        w.db.commit()
        assert not six.independent_till and six.z_mode == "cloud"

    def test_a_till_can_never_be_both(self, w):
        six = w.six[5]
        six.independent_till = True
        six.z_mode = "cloud"
        with pytest.raises(IntegrityError):
            w.db.flush()
        w.db.rollback()

    def test_the_z_mode_switch_cannot_take_it_back_into_the_shop_z(self, w):
        six = w.six[5]
        make_independent(w, six)
        with pytest.raises(Exception) as e:
            z_mode_policy.check_switch(w.db, w.admin, six, "cloud")
        assert e.value.body["detail"] == "independent_till"

    def test_the_main_till_cannot_be_made_independent(self, w):
        owner_setup(w)
        with pytest.raises(IT.IndependentSwitchRefused) as e:
            IT.apply_shop(w.db, w.admin, w.shop, independent=[w.six[0].id])
        assert e.value.body["detail"] == "main_till_not_participating"
        # Unless another participant becomes the main till in the same save.
        IT.apply_shop(w.db, w.admin, w.shop, independent=[w.six[0].id], participants=[w.six[5].id],
                      main_till_id=w.six[1].id)
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[1].id
        assert w.six[0].independent_till and not w.six[5].independent_till

    def test_all_or_nothing(self, w):
        five, six = w.six[4], w.six[5]
        w.shift(six, 1, status=ShiftStatus.OPEN)
        with pytest.raises(IT.IndependentSwitchRefused):
            IT.apply_shop(w.db, w.admin, w.shop, independent=[five.id, six.id])
        w.db.rollback()
        assert not five.independent_till and not six.independent_till


# ── The LAN hosts ─────────────────────────────────────────────────────────────


class TestLanHosts:
    def test_never_chosen_as_a_host_whatever_is_set_on_it(self, w):
        six = w.six[5]
        make_independent(w, six)
        for key in ("mainTill", "tablesHostTill", "printHostTill", "shopZMasterTill"):
            set_param(w, key, "machine", six.id, True)
        assert MT.main_till_of_shop(w.db, w.shop.id) is None
        assert tables_host_of_shop(w.db, w.shop.id) is None
        assert print_host_of_shop(w.db, w.shop.id) is None
        params = TP.till_parameters_for_machine(w.db, six).parameters
        assert all(params[k] is False for k in ("mainTill", "tablesHostTill", "printHostTill", "shopZMasterTill"))
        assert str(six.id) not in {t["machineId"] for t in MT.shop_tills_out(w.db, w.shop.id)}

    def test_making_it_independent_clears_its_own_host_flags(self, w):
        six = w.six[5]
        set_param(w, "printHostTill", "machine", six.id, True)
        make_independent(w, six)
        assert print_host_of_shop(w.db, w.shop.id) is None
        param = w.db.query(TillParameter).filter(TillParameter.key == "printHostTill").one()
        assert w.db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == param.id, TillParameterValue.scope_id == six.id,
        ).count() == 0

    def test_the_only_till_left_in_the_lan_group_hosts(self, w):
        # Two tills in the world's first shop... reduced to one LAN member.
        for m in w.six[2:]:
            m.is_active = False
        w.db.flush()
        make_independent(w, w.six[1])
        assert tables_host_of_shop(w.db, w.shop.id).id == w.six[0].id

    def test_its_tables_are_off_unless_set_at_its_own_level(self, w):
        six = w.six[5]
        set_param(w, "tablesMode", "shop", w.shop.id, "רשת מקומית (קופה ראשית)")
        make_independent(w, six)
        assert TP.till_parameters_for_machine(w.db, six).parameters["tablesMode"] == "כבוי"
        assert TP.till_parameters_for_machine(w.db, w.six[1]).parameters["tablesMode"] == "רשת מקומית (קופה ראשית)"
        set_param(w, "tablesMode", "machine", six.id, "רשת מקומית (קופה ראשית)")
        assert TP.till_parameters_for_machine(w.db, six).parameters["tablesMode"] == "קופה אחת"
        set_param(w, "tablesMode", "machine", six.id, "קופה אחת")
        assert TP.till_parameters_for_machine(w.db, six).parameters["tablesMode"] == "קופה אחת"

    def test_it_cannot_be_made_the_main_till_or_take_over(self, w):
        six = w.six[5]
        make_independent(w, six)
        with pytest.raises(IT.IndependentSwitchRefused):
            IT.apply_shop(w.db, w.admin, w.shop, main_till_id=six.id)
        with pytest.raises(HTTPException) as e:
            MT.take_over(w.db, six)
        assert e.value.detail == MT.INDEPENDENT

    def test_the_heartbeat_tells_the_till(self, w):
        from app.routers import machines as machines_router

        six = w.six[5]
        make_independent(w, six)
        out = machines_router.post_my_heartbeat(None, machine=six, db=w.db)
        assert out["independentTill"] is True and out["zMode"] == "till"


# ── Local mode ────────────────────────────────────────────────────────────────


def local_body(w, number, tills, *, cid=None, zid=None):
    return LZ.LocalShopZIn.model_validate({
        "id": str(zid or uuid.uuid4()),
        "clientRequestId": str(cid or uuid.uuid4()),
        "shopSequenceNumber": number,
        "closedAt": NOW.isoformat(),
        "createdByName": "דנה",
        "tills": [
            {"machineId": str(m.id), "shiftIds": [str(s.id) for s in shifts], "till": figures}
            for m, shifts, figures in tills
        ],
    })


def upload(w, main, body):
    resp = LR.till_shop_z_local_upload(str(main.id), body, machine=main, db=w.db)
    if isinstance(resp, dict):
        return 201, resp
    return resp.status_code, json.loads(resp.body)


class TestLocalMode:
    def test_allowed_with_confirmation_reads_block_in_local_mode(self, w):
        set_param(w, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", w.shop.id, TP.SHOP_Z_OPEN_TILLS_CONFIRM)
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) == "confirm"
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, True)
        assert LZ.local_mode_of_shop(w.db, w.shop) is True
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) == "block"

    def test_no_cloud_z_run_at_all_in_local_mode(self, w, z_activity_unchecked):
        owner_setup(w)
        t1, t2 = w.six[0], w.six[1]
        closed_shift(w, t1, 1, "10.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        # Not from the dashboard, not from the main till's cloud flow: the main till numbers.
        with pytest.raises(HTTPException) as e:
            run_z(w, w.six[:5])
        assert e.value.detail["code"] == "shop_z_producer_local"
        with pytest.raises(HTTPException):
            SZ.till_shop_z_start(str(t1.id), SZ.ShopZStartIn(confirmOpenTills=True), machine=t1, db=w.db)

    def test_history_holds_the_last_number_a_month_and_the_participants(self, w, z_activity_unchecked):
        owner_setup(w)
        assert local_z_of_five(w)[0] == 201
        old = w.db.query(ZReport).one()
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        assert out["localMode"] is True
        assert out["lastShopZNumber"] == 1
        assert [z["shopSequenceNumber"] for z in out["zs"]] == [1]
        assert [p["posNumber"] for p in out["participants"]] == ["1", "2", "3", "4", "5"]
        assert [p["posNumber"] for p in out["independentTills"]] == ["6"]
        # The main till is the producer: it numbers the next one for certain.
        assert out["numberCertain"] is True and out["producer"]["kind"] == "local"
        # Older than the window: kept out of the Zs, never out of the number.
        old.closed_at = datetime.now(timezone.utc) - timedelta(days=40)
        w.db.flush()
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        assert out["zs"] == [] and out["lastShopZNumber"] == 1

    def test_only_the_next_number_is_filed(self, w):
        owner_setup(w)
        main = w.six[0]
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        tills = [(m, [shifts[m.id]], {"totalSales": 10.0, "transactionsCount": 1}) for m in w.six[:5]]
        w.db.commit()  # a refusal rolls the request back, never the shifts
        code, out = upload(w, main, local_body(w, 3, tills))
        assert code == 409 and out["detail"] == "offline_z_out_of_sequence"
        assert out["zNumber"] == 3 and out["expectedNumber"] == 1 and out["conflictRecorded"] is True
        code, out = upload(w, main, local_body(w, 1, tills))
        assert code == 201, out
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.shop_sequence_number == 1 and z.built_offline
        assert str(z.total_sales) in ("50.00", "50")
        assert z.header["scope"]["kind"] == "shop"
        assert not z.offline_discrepancies
        # The next one has to be 2 — 1 is used.
        more = {m.id: closed_shift(w, m, 2, "1.00") for m in w.six[:5]}
        tills2 = [(m, [more[m.id]], None) for m in w.six[:5]]
        code, out = upload(w, main, local_body(w, 1, tills2))
        assert code == 409 and out["expectedNumber"] == 2
        assert out["detail"] == "offline_z_number_taken" and out["takenByZReportId"] == str(z.id)

    def test_no_renumbering_anywhere(self, w):
        """The owner: "אין דבר כזה זד שממוספר מחדש" — no field, no path renumbers a shop Z."""
        owner_setup(w)
        code, out = local_z_of_five(w)
        assert code == 201
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert "renumberedFrom" not in z.offline_report
        assert "printed_number" not in LZ.LocalShopZIn.model_fields
        from app.schemas.z_report import ZReportOut

        assert "renumbered_from" not in ZReportOut.model_fields

    def test_idempotent_by_request_id(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        tills = [(m, [shifts[m.id]], None) for m in w.six[:5]]
        cid, zid = uuid.uuid4(), uuid.uuid4()
        code, first = upload(w, w.six[0], local_body(w, 1, tills, cid=cid, zid=zid))
        code2, again = upload(w, w.six[0], local_body(w, 1, tills, cid=cid, zid=zid))
        assert (code, code2) == (201, 200)
        assert again["status"] == "duplicate" and again["zReportId"] == first["zReportId"]
        assert w.db.query(ZReport).count() == 1

    def test_a_close_not_on_the_cloud_yet_is_waited_for_by_the_cloud_not_the_till(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:4]}
        still_open = w.shift(w.six[4], 1, status=ShiftStatus.OPEN)
        tills = [(m, [shifts[m.id]], None) for m in w.six[:4]] + [(w.six[4], [still_open], None)]
        code, out = upload(w, w.six[0], local_body(w, 1, tills))
        # Kept as printed (§8.12): the number is filed, and the shift is linked when it closes.
        assert code == 201, out
        assert last_shop_z_number(w.db, w.shop.id) == 1
        assert still_open.z_report_id is None
        still_open.status, still_open.closed_at = ShiftStatus.CLOSED, NOW
        still_open.close_accepted_at = NOW
        LZ.verify_pending(w.db, w.shop.id, force=True)
        assert str(still_open.z_report_id) == out["zReportId"]

    def test_a_participant_missing_from_the_paper_is_reported_never_hidden(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        tills = [(m, [shifts[m.id]], None) for m in w.six[:4]]  # till 5 left off the paper
        code, out = upload(w, w.six[0], local_body(w, 1, tills))
        assert code == 201
        assert {"key": "5:missing", "till": None, "cloud": 1} in out["discrepancies"]

    def test_a_paper_without_manifests_is_stored_as_printed_and_left_unverified(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        tills = [(m, [shifts[m.id]], {"totalSales": 10.0}) for m in w.six[:4]]
        tills.append((w.six[4], [shifts[w.six[4].id]], {"totalSales": 12.0}))
        code, out = upload(w, w.six[0], local_body(w, 1, tills))
        assert code == 201
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("52.00")  # as printed
        # An older till's paper names no documents: nothing to compare — never a mismatch (§8.12).
        assert z.offline_report["verification"]["state"] == "unverified"
        assert sequence_exceptions(w, "local_shop_z_mismatch") == []

    def test_an_independent_till_is_no_part_of_the_upload(self, w):
        owner_setup(w)
        six_shift = closed_shift(w, w.six[5], 1, "10.00")
        main_shift = closed_shift(w, w.six[0], 1, "10.00")
        code, out = upload(w, w.six[0], local_body(w, 1, [(w.six[0], [main_shift], None), (w.six[5], [six_shift], None)]))
        assert code == 409 and out["detail"] == "machine_issues_its_own_z"


# ── Reports ───────────────────────────────────────────────────────────────────


class TestReports:
    def test_the_day_summary_says_which_zs_it_adds_up(self, w, z_activity_unchecked):
        from app.services.reports import day_includes_note

        owner_setup(w)
        assert local_z_of_five(w)[0] == 201
        six = w.six[5]
        closed_shift(w, six, 1, "30.00")
        sync_router.post_till_z(
            machine_id=str(six.id),
            body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}),
            machine=six, db=w.db,
        )
        note = day_includes_note(w.db.query(ZReport).all())
        # Till 6 was made independent: its run began today, and says so (§3.1).
        assert note.startswith("כולל: Z סניפי מס׳ 1 (קופות 1–5) · Z עצמאי: קופה 6 (Z מס׳ 1, רצף מ-"), note

    def test_numbers_label(self):
        from app.services.z_builder import numbers_label

        assert numbers_label(["1", "2", "3", "4", "5"]) == "1–5"
        assert numbers_label(["1", "3", "6"]) == "1, 3, 6"
        assert numbers_label(["1", "2"]) == "1, 2"
        assert numbers_label(["2", "1", "3", "7", "8", "9", "10"]) == "1–3, 7–10"


# ── The review's gaps: no till skipped, no number taken twice ─────────────────


class TestNoTillSkipped:
    def test_block_rule_in_cloud_mode_refuses_proceed_without_a_till(self, w, z_activity_unchecked):
        set_param(w, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", w.shop.id, TP.SHOP_Z_OPEN_TILLS_BLOCK)
        t1, t2 = w.six[0], w.six[1]
        for m in w.six[2:]:
            m.is_active = False
        closed_shift(w, t1, 1, "10.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        assert LZ.local_mode_of_shop(w.db, w.shop) is False
        run = run_z(w, [t1, t2])  # every till selected: nothing left out at the start
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            ZR.proceed_without(w.db, run, [t2.id], deferred_by="דנה")
        assert e.value.detail["code"] == "all_tills_required"
        assert "חובה לסגור את כל הקופות" in e.value.detail["message"]

    def test_block_rule_run_that_expires_builds_nothing(self, w, z_activity_unchecked):
        set_param(w, TP.SHOP_Z_OPEN_TILLS_KEY, "shop", w.shop.id, TP.SHOP_Z_OPEN_TILLS_BLOCK)
        t1, t2 = w.six[0], w.six[1]
        for m in w.six[2:]:
            m.is_active = False
        closed_shift(w, t1, 1, "10.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        run = run_z(w, [t1, t2])
        w.db.commit()
        ZR.expire_overdue_runs(w.db, now=NOW + timedelta(hours=ZR.Z_RUN_TTL_HOURS + 1))
        w.db.refresh(run)
        assert run.z_report_id is None
        assert run.status == "expired"
        assert w.db.query(ZReport).count() == 0

    def test_confirm_rule_outside_local_mode_still_lets_a_till_wait_for_the_next_z(self, w, z_activity_unchecked):
        t1, t2 = w.six[0], w.six[1]
        for m in w.six[2:]:
            m.is_active = False
        closed_shift(w, t1, 1, "10.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        run = run_z(w, [t1, t2])
        w.db.commit()
        out = ZR.proceed_without(w.db, run, [t2.id])
        assert out.z_report_id is not None


class TestOneMainTillServes:
    def test_local_mode_needs_a_main_till(self, w):
        set_param(w, "tablesMode", "shop", w.shop.id, "רשת מקומית (קופה ראשית)")
        assert LZ.local_mode_of_shop(w.db, w.shop) is False
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, True)
        assert LZ.local_mode_of_shop(w.db, w.shop) is True

    def test_the_switch_decides_not_the_tables_or_the_print_server(self, w):
        """"רשת מקומית" (docs/SPEC_LAN_MODE.md §4): local mode is the switch and a main till."""
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, True)
        set_param(w, "printHostTill", "machine", w.six[1].id, True)  # another till prints
        assert LZ.local_mode_of_shop(w.db, w.shop) is True
        w.shop.local_network = False
        set_param(w, "tablesMode", "shop", w.shop.id, "רשת מקומית (קופה ראשית)")
        assert LZ.local_mode_of_shop(w.db, w.shop) is False

    def test_every_till_may_run_it_reads_main_till_only_in_local_mode(self, w):
        set_param(w, MT.SHOP_Z_FROM_KEY, "shop", w.shop.id, MT.Z_FROM_ANY)
        assert MT.till_shop_z_refusal(w.db, w.six[2]) is None
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, True)
        assert MT.till_shop_z_refusal(w.db, w.six[0]) is None
        assert MT.till_shop_z_refusal(w.db, w.six[2]) == MT.ONLY_FROM_MAIN
        assert LZ.history(w.db, w.six[2])["numberCertain"] is False
        assert LZ.history(w.db, w.six[0])["numberCertain"] is True

    def test_the_dashboard_never_starts_it_in_local_mode_even_with_the_main_till_offline(self, w):
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, True)
        set_param(w, MT.SHOP_Z_FROM_KEY, "shop", w.shop.id, MT.Z_FROM_ANY)
        w.six[0].last_heartbeat_at = datetime.now(timezone.utc) - timedelta(days=2)
        w.db.flush()
        refusal = MT.dashboard_z_refusal(w.db, w.shop)
        assert refusal["code"] == MT.ONLY_FROM_MAIN and refusal["localMode"] is True
        assert "בקש מהקופה הראשית" in refusal["message"]


class TestDashboardAsksTheMainTill:
    def test_the_request_reaches_the_main_till_only_and_its_z_completes_it(self, w):
        from app.routers import machines as machines_router

        owner_setup(w)
        main, other = w.six[0], w.six[1]
        req = LZ.request_from_dashboard(w.db, w.admin, w.shop)
        assert req["status"] == "waiting"
        # Asked again while pending: the same request.
        assert LZ.request_from_dashboard(w.db, w.admin, w.shop)["id"] == req["id"]
        w.db.commit()
        assert "pendingShopZ" not in machines_router.post_my_heartbeat(None, machine=other, db=w.db)
        beat = machines_router.post_my_heartbeat(None, machine=main, db=w.db)
        assert beat["pendingShopZ"]["requestId"] == req["id"]
        # A till blocks it: said back, still pending (the main till tries again).
        LZ.ack_request(w.db, main, req["id"], "failed", "קופה 3: לא מחוברת לרשת המקומית")
        state = LZ.request_state(w.db, w.shop)["request"]
        assert state["status"] == "failed" and "קופה 3" in state["message"]
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        body = local_body(w, 1, [(m, [shifts[m.id]], None) for m in w.six[:5]])
        body.shop_z_request_id = req["id"]
        code, out = upload(w, main, body)
        assert code == 201
        done = LZ.request_state(w.db, w.shop)["request"]
        assert done["status"] == "completed" and done["shopSequenceNumber"] == 1
        assert "pendingShopZ" not in machines_router.post_my_heartbeat(None, machine=main, db=w.db)

    def test_not_in_local_mode_the_wizard_does_it(self, w):
        with pytest.raises(LZ.LocalShopZRefused) as e:
            LZ.request_from_dashboard(w.db, w.admin, w.shop)
        assert e.value.body["detail"] == "not_local_mode"


# ── A Z number is final: kept as printed, recorded for support ────────────────


def conflicts_of(w):
    w.db.refresh(w.shop)
    return LZ.unresolved_conflicts(w.shop)


def sequence_exceptions(w, kind="offline_z_conflict"):
    from app.models.audit_exception import AuditException

    return w.db.query(AuditException).filter(AuditException.exception_type == kind).all()


class TestNoRenumberConflicts:
    def test_out_of_sequence_is_kept_as_printed_for_support_and_nothing_is_filed(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        zid = uuid.uuid4()
        code, out = upload(w, w.six[0], local_body(w, 3, [(m, [shifts[m.id]], None) for m in w.six[:5]], zid=zid))
        assert code == 409 and out["conflictRecorded"] is True
        assert "בלי מספור מחדש" in out["message"]
        assert w.db.query(ZReport).count() == 0
        (c,) = conflicts_of(w)
        assert c["zId"] == str(zid) and c["number"] == 3 and c["expectedNumber"] == 1
        # The Z itself, exactly as printed, for support.
        assert c["z"]["shopSequenceNumber"] == 3 and c["z"]["id"] == str(zid)
        assert len(sequence_exceptions(w)) == 1
        # Sent again: the same conflict, its number unchanged — never renumbered.
        code, out = upload(w, w.six[0], local_body(w, 3, [(m, [shifts[m.id]], None) for m in w.six[:5]], zid=zid))
        (c,) = conflicts_of(w)
        assert c["number"] == 3 and c["attempts"] == 2
        # The dashboard and the main till see it.
        assert IT.shop_state(w.db, w.shop, w.admin)["shopZ"]["conflicts"][0]["zId"] == str(zid)
        assert LZ.history(w.db, w.six[0])["conflicts"][0]["number"] == 3

    def test_a_taken_number_is_a_conflict_with_its_holder(self, w):
        owner_setup(w)
        code, first = local_z_of_five(w, number=1, seq=1)
        assert code == 201
        code, out = local_z_of_five(w, number=1, seq=2)
        assert code == 409 and out["detail"] == "offline_z_number_taken"
        assert out["takenByZReportId"] == first["zReportId"]
        assert w.db.query(ZReport).count() == 1
        assert conflicts_of(w)[0]["takenByZReportId"] == first["zReportId"]

    def test_later_queued_zs_keep_their_numbers(self, w):
        """#2 arrives before #1 (out of order): a conflict; #1 then #2 as printed — both filed."""
        owner_setup(w)
        s1 = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        s2 = {m.id: closed_shift(w, m, 2, "5.00") for m in w.six[:5]}
        w.db.commit()
        z2 = uuid.uuid4()
        body2 = local_body(w, 2, [(m, [s2[m.id]], None) for m in w.six[:5]], zid=z2)
        assert upload(w, w.six[0], body2)[0] == 409
        assert upload(w, w.six[0], local_body(w, 1, [(m, [s1[m.id]], None) for m in w.six[:5]]))[0] == 201
        code, out = upload(w, w.six[0], body2)
        assert code == 201 and out["shopSequenceNumber"] == 2
        assert conflicts_of(w) == []
        settled = [c for c in LZ._conflicts(w.shop) if c["zId"] == str(z2)][0]
        assert settled["resolvedHow"] == "uploaded"

    def test_a_till_that_is_not_the_producer_is_a_conflict(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        code, out = upload(w, w.six[1], local_body(w, 1, [(m, [shifts[m.id]], None) for m in w.six[:5]]))
        assert code == 409 and out["detail"] == "not_shop_z_producer" and out["conflictRecorded"] is True
        assert w.db.query(ZReport).count() == 0

    def test_support_settles_a_conflict_and_the_number_stays(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        zid = uuid.uuid4()
        upload(w, w.six[0], local_body(w, 3, [(m, [shifts[m.id]], None) for m in w.six[:5]], zid=zid))
        with pytest.raises(HTTPException):
            ZP.post_resolve_shop_z_conflict(
                w.shop.id, zid, ZP.ConflictResolveIn(note="x"),
                current_user=manager(w), active_tenant_id=w.tenant.id, db=w.db,
            )
        out = ZP.post_resolve_shop_z_conflict(
            w.shop.id, zid, ZP.ConflictResolveIn(note="נבדק מול רו״ח"),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["conflicts"] == []
        settled = LZ._conflicts(w.shop)[0]
        assert settled["number"] == 3 and settled["resolvedHow"] == "support"
        assert str(zid) in LZ.history(w.db, w.six[0])["resolvedConflictIds"]


# ── Exactly one producer of the shop's Z sequence ─────────────────────────────


def report(w, till, pending, last=None, online=True):
    from app.schemas.pos_machine import HeartbeatLocalShopZ

    till.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=10 if online else 3600)
    LZ.note_heartbeat(w.db, till, HeartbeatLocalShopZ(pending=pending, lastNumber=last))
    w.db.flush()


def put_main(w, machine_id, *, force=False, user=None):
    from fastapi import BackgroundTasks

    from app.routers import main_till as MR

    resp = MR.put_main_till(
        w.shop.id,
        MR.MainTillIn(machineId=machine_id, forceProducerSwitch=force),
        BackgroundTasks(),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    if isinstance(resp, dict):
        return 200, resp
    return resp.status_code, json.loads(resp.body)


def set_value(w, key, scope_type, scope_id, value):
    from fastapi import BackgroundTasks

    from app.routers import till_parameters as PR
    from app.schemas.till_parameter import TillParameterValueIn

    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    resp = PR.set_till_parameter_value(
        parameter.id,
        TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        BackgroundTasks(), _admin=w.admin, db=w.db,
    )
    if hasattr(resp, "status_code") and hasattr(resp, "body"):
        return resp.status_code, json.loads(resp.body)
    return 200, resp


def put_local_network(w, enabled, force=False, user=None):
    from app.routers import lan_server as LSR

    try:
        out = LSR.put_local_network(
            w.shop.id, LSR.LocalNetworkIn(enabled=enabled, forceProducerSwitch=force), BackgroundTasks(),
            current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
    except HTTPException as e:
        return e.status_code, {"detail": e.detail}
    return 200, out


class TestOneProducer:
    def test_unsynced_shop_zs_block_every_switch_of_producer(self, w):
        owner_setup(w)
        main = w.six[0]
        report(w, main, pending=2, last=7)
        w.db.commit()
        # Changing the main till, removing it, tables-LAN on then off, the print server: refused.
        code, out = put_main(w, w.six[2].id)
        assert code == 409 and out["detail"]["code"] == LZ.BUSY
        assert "2 דוחות Z סניפיים" in out["detail"]["message"]
        code, out = put_main(w, None)
        assert code == 409
        code, out = put_local_network(w, False)
        assert code == 409 and out["detail"]["code"] == LZ.BUSY
        with pytest.raises(Exception):
            IT.apply_shop(w.db, w.admin, w.shop, main_till_id=w.six[3].id)
        w.db.rollback()
        # Nothing moved.
        assert MT.main_till_of_shop(w.db, w.shop.id).id == main.id
        assert LZ.effective_producer(w.db, w.shop).is_local_of(main.id)

    def test_turning_the_lan_off_is_refused_while_the_main_till_holds_unsynced_zs(self, w):
        owner_setup(w)
        set_param(w, "tablesMode", "shop", w.shop.id, "רשת מקומית (קופה ראשית)")
        set_param(w, "printHostTill", "machine", w.six[1].id, True)
        assert LZ.local_mode_of_shop(w.db, w.shop) is True
        report(w, w.six[0], pending=1)
        w.db.commit()
        code, out = put_local_network(w, False)
        assert code == 409 and out["detail"]["code"] == LZ.BUSY
        assert w.db.get(Shop, w.shop.id).local_network is True
        # The tables off: the switch stays, and so does the producer.
        code, _ = set_value(w, "tablesMode", "shop", w.shop.id, "כבוי")
        assert code == 200 and LZ.local_mode_of_shop(w.db, w.shop) is True

    def test_offline_the_main_till_cannot_say_so_and_keeps_it(self, w):
        owner_setup(w)
        report(w, w.six[0], pending=0, online=False)
        w.db.commit()
        code, out = put_main(w, w.six[2].id)
        assert code == 409 and "לא מחוברת לענן" in out["detail"]["message"]

    def test_online_and_synced_hands_over_at_once(self, w):
        owner_setup(w)
        report(w, w.six[0], pending=0, last=0)
        w.db.commit()
        code, _ = put_main(w, w.six[2].id)
        assert code == 200
        assert LZ.effective_producer(w.db, w.shop).is_local_of(w.six[2].id)

    def test_a_till_that_never_made_a_shop_z_hands_over(self, w):
        owner_setup(w)
        code, _ = put_main(w, w.six[2].id)
        assert code == 200
        assert LZ.effective_producer(w.db, w.shop).is_local_of(w.six[2].id)

    def test_the_super_admin_may_force_it_and_it_is_recorded(self, w):
        owner_setup(w)
        report(w, w.six[0], pending=3)
        w.db.commit()
        code, out = put_main(w, w.six[2].id, force=True)
        assert code == 200
        pin = w.shop.settings[LZ.PRODUCER_KEY]
        assert pin["machineId"] == str(w.six[2].id) and pin["forcedBy"] == "admin"
        assert [e.details["kind"] for e in sequence_exceptions(w, "shop_z_producer_forced")] == ["forced_handover"]
        # Only the super admin.
        with pytest.raises(HTTPException):
            put_main(w, w.six[3].id, force=True, user=manager(w))

    def test_a_handover_waits_for_the_old_producer_whatever_road_changed_the_config(self, w):
        owner_setup(w)
        report(w, w.six[0], pending=1)
        w.db.commit()
        # The till parameters changed behind the cards' back (no guard on this road).
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, False)
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[2].id, True)
        producer = LZ.effective_producer(w.db, w.shop)
        assert producer.is_local_of(w.six[0].id) and producer.handover["reason"] == "unsynced_shop_zs"
        # The new main till may not number; the cloud makes no Z; the dashboard is told why.
        assert LZ.history(w.db, w.six[2])["numberCertain"] is False
        with pytest.raises(HTTPException) as e:
            run_z(w, w.six[:5])
        assert e.value.detail["code"] == "shop_z_producer_local"
        assert "לא הושלמה" in MT.dashboard_z_refusal(w.db, w.shop)["message"]
        # The old producer may still file what it printed.
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        code, _ = upload(w, w.six[0], local_body(w, 1, [(m, [shifts[m.id]], None) for m in w.six[:5]]))
        assert code == 201
        # It reports all synced, online: the handover completes on that beat.
        report(w, w.six[0], pending=0, last=1)
        assert LZ.effective_producer(w.db, w.shop).is_local_of(w.six[2].id)
        assert LZ.history(w.db, w.six[2])["numberCertain"] is True

    def test_into_local_mode_waits_for_a_cloud_z_under_way(self, w, z_activity_unchecked):
        t1, t2 = w.six[0], w.six[1]
        closed_shift(w, t1, 1, "10.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        run_z(w, [t1, t2])  # waits for till 2 to close
        w.db.commit()
        code, out = set_value(w, MT.MAIN_TILL_KEY, "machine", t1.id, True)
        assert code == 409 and out["reason"] == "cloud_run_live"

    def test_switching_the_lan_on_waits_for_a_cloud_z_under_way(self, w, z_activity_unchecked):
        w.shop.local_network = False
        set_param(w, MT.MAIN_TILL_KEY, "machine", w.six[0].id, True)
        w.db.commit()
        t1, t2 = w.six[0], w.six[1]
        closed_shift(w, t1, 1, "10.00")
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        run_z(w, [t1, t2])
        w.db.commit()
        code, out = put_local_network(w, True)
        assert code == 409 and out["detail"]["code"] == LZ.BUSY and out["detail"]["reason"] == "cloud_run_live"
        assert w.db.get(Shop, w.shop.id).local_network is False

    def test_a_takeover_moves_the_tables_but_keeps_the_z_production(self, w):
        owner_setup(w)
        set_param(w, "tablesMode", "shop", w.shop.id, "רשת מקומית (קופה ראשית)")
        report(w, w.six[0], pending=1, online=False)
        w.db.commit()
        out = MT.take_over(w.db, w.six[2], operator="דנה")
        assert out["mainTill"]["machineId"] == str(w.six[2].id)
        assert out["shopZHandover"]["reason"] == "unsynced_shop_zs"
        assert LZ.effective_producer(w.db, w.shop).is_local_of(w.six[0].id)
        assert LZ.history(w.db, w.six[2])["numberCertain"] is False
        # The super admin moves it on the shop's page when the old one is gone for good.
        out = ZP.post_shop_z_producer_handover(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["producer"]["machine"]["machineId"] == str(w.six[2].id)

    def test_the_heartbeat_report_is_kept_per_till(self, w):
        from app.routers import machines as machines_router
        from app.schemas.pos_machine import MachineHeartbeatBody

        owner_setup(w)
        body = MachineHeartbeatBody.model_validate({"localShopZ": {"pending": 2, "conflict": False, "lastNumber": 9}})
        machines_router.post_my_heartbeat(body, machine=w.six[0], db=w.db)
        rep = w.shop.settings[LZ.REPORTS_KEY][str(w.six[0].id)]
        assert rep["pending"] == 2 and rep["lastNumber"] == 9


# ── Two Z runs in one branch: the branch code on all, the till number between them ──


def _two_zs_of_one_branch(w):
    """The owner's shop with branch code 12: shop Z #1 (tills 1–5) and till 6's own Z #1."""
    from app.services import z_print  # noqa: F401

    w.shop.branch_id = "12"
    w.db.flush()
    owner_setup(w)
    code, out = local_z_of_five(w)
    assert code == 201, out
    shop_z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
    six = w.six[5]
    closed_shift(w, six, 1, "30.00")
    resp = sync_router.post_till_z(
        machine_id=str(six.id),
        body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}),
        machine=six, db=w.db,
    )
    till_z = w.db.get(ZReport, uuid.UUID(json.loads(resp.body)["zReport"]["id"]))
    return shop_z, till_z


class TestBranchCodeOnEveryZ:
    def test_every_printed_z_shows_the_branch_code_and_a_till_z_its_till(self, w):
        from app.services import z_print

        shop_z, till_z = _two_zs_of_one_branch(w)
        assert shop_z.shop_sequence_number == 1 and till_z.machine_sequence_number == 1
        tz = timezone.utc
        full = z_print.build_print_document(shop_z, tz)
        summary = z_print.build_summary_document(shop_z, tz)
        part = z_print.build_till_document(shop_z, w.six[0].id, tz)
        for doc in (full, summary, part):
            assert "קוד סניף 12" in doc["subtitle"], doc["subtitle"]
        # The shop Z says which tills it includes.
        assert any("כולל קופות 1–5" in line for line in full["subtitle"])
        own = z_print.build_print_document(till_z, tz)
        assert "קוד סניף 12" in own["subtitle"]
        assert any(line.startswith("קופה 6 (עצמאית)") for line in own["subtitle"]), own["subtitle"]
        # The till's list of Zs too.
        item = z_print.list_item(till_z, tz)
        assert item["branchCode"] == "12" and item["posNumber"] == "6"

    def test_the_dashboard_list_and_detail_carry_the_branch_code_and_the_till(self, w):
        from app.routers.z_reports import z_detail_out, z_to_out

        shop_z, till_z = _two_zs_of_one_branch(w)
        a, b = z_to_out(shop_z), z_to_out(till_z)
        assert a.branch_code == b.branch_code == "12"
        # Same number in one branch: told apart by the till.
        assert a.pos_number is None and b.pos_number == "6"
        assert (a.shop_sequence_number, b.machine_sequence_number) == (1, 1)
        detail = z_detail_out(w.db, till_z)
        assert detail.branch_code == "12" and detail.pos_number == "6"

    def test_the_day_summary_and_the_accounting_export_carry_the_till_with_a_till_z(self, w):
        from app.services.accounting.journal import load_z_facts
        from app.services.reports import _contributors_of

        shop_z, till_z = _two_zs_of_one_branch(w)
        (c,) = _contributors_of(till_z)
        assert c.branch_code == "12" and c.pos_number == "6" and c.machine_sequence_number == 1
        assert {x.pos_number for x in _contributors_of(shop_z)} == {"1", "2", "3", "4", "5"}
        # Made independent, its run began today: the export names the run too (§3.1).
        assert load_z_facts(w.db, till_z).till_label.startswith("קופה 6 (רצף מ-")
        assert load_z_facts(w.db, shop_z).till_label is None

    def test_a_z_built_before_the_header_carried_it_shows_the_shops_code_now(self, w):
        from app.services import z_print

        shop_z, _ = _two_zs_of_one_branch(w)
        shop_z.header = {k: v for k, v in (shop_z.header or {}).items() if k != "branchId"}
        assert z_print.branch_code_of(shop_z) == "12"

    def test_the_main_till_learns_the_branch_code_with_its_history(self, w):
        w.shop.branch_id = "12"
        owner_setup(w)
        assert LZ.history(w.db, w.six[0])["branchCode"] == "12"


# ── Ruling: made independent, a till starts again at Z 1 (§3.1) ───────────────


def own_z(w, till, seq, total="10.00"):
    """A shift of `till` closed and its own Z asked for: the Z."""
    closed_shift(w, till, seq, total)
    resp = sync_router.post_till_z(
        machine_id=str(till.id),
        body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}),
        machine=till, db=w.db,
    )
    assert resp.status_code == 201, resp.body
    return w.db.get(ZReport, uuid.UUID(json.loads(resp.body)["zReport"]["id"]))


def back_to_shop_z(w, till):
    IT.check_switch(w.db, w.admin, till, False)
    assert IT.set_independent(w.db, till, False)
    w.db.commit()


class TestIndependentRunStartsAtOne:
    def test_made_independent_a_till_starts_again_at_z_1_and_the_old_z_1_stays(self, w):
        from app.routers import machines as machines_router
        from app.routers.z_reports import z_to_out
        from app.services import z_print
        from app.services.till_z import set_z_mode

        six = w.six[5]
        # An earlier run: "Z לכל קופה" (its own Z, not independent) — Z 1 and Z 2.
        set_z_mode(w.db, six, "till")
        w.db.commit()
        first = own_z(w, six, 1)
        assert own_z(w, six, 2).machine_sequence_number == 2
        assert first.machine_sequence_number == 1 and first.machine_sequence_epoch == 0
        # To the shop Z, then independent: a new run.
        back_to_shop_z(w, six)
        make_independent(w, six)
        new = own_z(w, six, 3)
        assert new.machine_sequence_number == 1 and new.machine_sequence_epoch == 1
        # Both "Z 1" of till 6 are on file, apart by their run.
        ones = w.db.query(ZReport).filter(ZReport.machine_id == six.id, ZReport.machine_sequence_number == 1).all()
        assert sorted(z.machine_sequence_epoch for z in ones) == [0, 1]
        # The heartbeat: the new run, its last number, when it began.
        beat = machines_router.post_my_heartbeat(None, machine=six, db=w.db)
        assert beat["tillZEpoch"] == 1 and beat["lastTillZNumber"] == 1
        assert beat["tillZEpochStartedAt"]
        # The paper and the dashboard tell the two apart.
        started = new.header["sequence"]["startedAt"]
        assert started and new.header["sequence"]["independent"] is True
        lines = z_print.build_print_document(new, timezone.utc)["subtitle"]
        assert any(line.startswith("קופה 6 (עצמאית) · רצף מ-") for line in lines), lines
        assert not any("רצף מ-" in line for line in z_print.build_print_document(first, timezone.utc)["subtitle"])
        out = z_to_out(new)
        assert out.machine_sequence_epoch == 1 and out.sequence_started_at == started
        item = z_print.list_item(new, timezone.utc)
        assert item["sequenceEpoch"] == 1 and item["sequenceStartedAt"] == started

    def test_independent_again_later_starts_another_run(self, w):
        six = w.six[5]
        make_independent(w, six)
        assert own_z(w, six, 1).machine_sequence_number == 1
        assert own_z(w, six, 2).machine_sequence_number == 2
        back_to_shop_z(w, six)
        make_independent(w, six)
        again = own_z(w, six, 3)
        assert (again.machine_sequence_epoch, again.machine_sequence_number) == (2, 1)

    def test_back_in_the_shop_z_it_rejoins_the_shops_run(self, w, z_activity_unchecked):
        six = w.six[5]
        make_independent(w, six)
        own_z(w, six, 1)
        back_to_shop_z(w, six)
        cloud_mode(w)
        closed_shift(w, six, 2, "10.00")
        z = w.db.get(ZReport, run_z(w, [six]).z_report_id)
        assert z.shop_sequence_number == 1 and z.machine_sequence_number is None

    def test_an_offline_z_of_the_old_run_is_never_filed_into_the_new_one(self, w):
        six = w.six[5]
        make_independent(w, six)
        shift = closed_shift(w, six, 1, "10.00")
        w.db.commit()
        body = {
            "clientRequestId": str(uuid.uuid4()),
            "throughShiftId": str(shift.id),
            "offline": {
                "id": str(uuid.uuid4()), "machineSequenceNumber": 1, "machineSequenceEpoch": 0,
                "closedAt": NOW.isoformat(), "businessDate": str(TODAY), "shiftIds": [str(shift.id)],
            },
        }
        resp = sync_router.post_till_z(machine_id=str(six.id), body=TillZIn.model_validate(body), machine=six, db=w.db)
        assert resp.status_code == 409 and json.loads(resp.body)["detail"] == "offline_z_other_sequence"
        body["offline"]["machineSequenceEpoch"] = 1
        body["clientRequestId"] = str(uuid.uuid4())
        body["offline"]["id"] = str(uuid.uuid4())
        resp = sync_router.post_till_z(machine_id=str(six.id), body=TillZIn.model_validate(body), machine=six, db=w.db)
        assert resp.status_code == 201, resp.body

    def test_no_switch_while_its_offline_zs_are_unsynced(self, w):
        from app.services.till_z import TillZRefused

        from app.services.till_z import set_z_mode

        six = w.six[5]
        # Its own Zs ("Z לכל קופה"), one closed with no connection not in the cloud yet.
        set_z_mode(w.db, six, "till")
        six.offline_till_z_pending = 1
        w.db.flush()
        with pytest.raises(TillZRefused) as e:
            IT.check_switch(w.db, w.admin, six, True)
        assert e.value.body["detail"] == "till_offline_zs_unsynced"

    def test_no_switch_while_it_holds_shop_zs_it_made_as_a_main_till(self, w):
        five = w.six[4]
        report(w, five, pending=2)
        with pytest.raises(IT.IndependentSwitchRefused) as e:
            IT.check_switch(w.db, w.admin, five, True)
        assert e.value.body["detail"] == "independent_switch_shop_zs_unsynced"
        assert "דוחות Z סניפיים" in e.value.body["message"]

    def test_a_report_of_the_old_run_does_not_move_the_new_runs_last_number(self, w):
        from app.schemas.pos_machine import HeartbeatOfflineTillZ
        from app.services.till_z import apply_offline_report

        six = w.six[5]
        make_independent(w, six)
        assert six.offline_till_z_last_number is None
        apply_offline_report(six, HeartbeatOfflineTillZ(pending=0, lastNumber=7, epoch=0))
        assert six.offline_till_z_last_number is None
        apply_offline_report(six, HeartbeatOfflineTillZ(pending=0, lastNumber=2, epoch=1))
        assert six.offline_till_z_last_number == 2


# ── Ruling: the main till's paper is the Z (§8.7) ──────────────────────────────


def _till_manifest(w, till, shifts):
    """The till's part manifest: the same computation, over its documents of those shifts."""
    from app.models.transaction import Transaction
    from app.services import shop_z_manifest as MF

    ids = [s.id for s in shifts]
    docs = w.db.query(Transaction).filter(Transaction.shift_id.in_(ids)).all()
    manifest = MF.manifest_of(MF.cloud_documents(w.db, [str(d.id) for d in docs]).values())
    return {**manifest, "machineId": str(till.id), "shiftIds": sorted(str(i) for i in ids)}


def _part(w, till, shifts, manifest=None):
    """A till's part as the main till uploads it: its manifest, and its figures the manifest's."""
    m = manifest or _till_manifest(w, till, shifts)
    t = m["totals"]
    gross, discounts = Decimal(t["gross"]), Decimal(t["discounts"])
    section = {
        "grossSales": t["gross"], "discountsTotal": t["discounts"], "totalSales": str(gross - discounts),
        "totalRefunds": t["refunds"], "netSales": t["net"], "totalCash": t["cash"], "totalCard": t["card"],
        "totalExchange": t["exchange"], "totalTips": t["tips"], "vatTotal": t["vat"],
        "transactionsCount": t["documents"], "paymentBreakdown": t["payments"],
        "documentRanges": m["types"], "manifestDigest": m["digest"],
    }
    figures = {
        "totalSales": float(t["gross"]), "totalDiscounts": float(t["discounts"]), "totalRefunds": float(t["refunds"]),
        "totalCash": float(t["cash"]), "totalCard": float(t["card"]), "totalExchange": float(t["exchange"]),
        "totalTips": float(t["tips"]), "vatTotal": None if t["vat"] is None else float(t["vat"]),
        "transactionsCount": t["documents"],
    }
    return {"machineId": str(till.id), "shiftIds": [str(s.id) for s in shifts], "till": figures,
            "report": section, "manifest": m}


def _manifest_body(w, number, parts, *, summary=None, cid=None, zid=None):
    """The main till's upload: the parts, and the summary it printed — their sum."""
    from app.services import shop_z_manifest as MF

    total = MF.sum_totals([p["manifest"] for p in parts])
    report = summary or {
        "gross": total["gross"], "discounts": total["discounts"], "refunds": total["refunds"], "net": total["net"],
        "cash": total["cash"], "card": total["card"], "exchange": total["exchange"], "tips": total["tips"],
        "vat": total["vat"], "transactions": total["documents"],
    }
    return LZ.LocalShopZIn.model_validate({
        "id": str(zid or uuid.uuid4()), "clientRequestId": str(cid or uuid.uuid4()),
        "shopSequenceNumber": number, "closedAt": NOW.isoformat(), "businessDate": str(TODAY),
        "createdByName": "דנה", "tills": parts, "report": report,
    })


def _withhold(w, till, shift):
    """
    The cloud has not got this till's shift close nor its documents yet (a till that syncs
    late, or died after reporting its part): taken out of the cloud; the returned call brings
    them in, as the till's sync would.
    """
    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment

    saved = []
    for tx in w.db.query(Transaction).filter(Transaction.shift_id == shift.id).all():
        legs = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == tx.id).all()
        saved.append((
            {c.name: getattr(tx, c.name) for c in Transaction.__table__.columns if c.name != "document_series"},
            [{c.name: getattr(leg, c.name) for c in TransactionPayment.__table__.columns} for leg in legs],
        ))
        for leg in legs:
            w.db.delete(leg)
        w.db.delete(tx)
    closed = (shift.closed_at, shift.close_accepted_at)
    shift.status, shift.closed_at, shift.close_accepted_at = ShiftStatus.OPEN, None, None
    w.db.flush()

    def documents_arrive():
        for columns, legs in saved:
            w.db.add(Transaction(**columns))
            w.db.flush()
            for leg in legs:
                w.db.add(TransactionPayment(**leg))
        w.db.flush()

    def close_arrives():
        shift.status, (shift.closed_at, shift.close_accepted_at) = ShiftStatus.CLOSED, closed
        w.db.flush()

    return documents_arrive, close_arrives


def _five(w, total="10.00", *, more=None):
    """Tills 1–5 each with a closed shift (documents in the cloud): {till id: shift}."""
    owner_setup(w)
    shifts = {}
    for m in w.six[:5]:
        totals = [total] + list((more or {}).get(m.pos_number, []))
        shifts[m.id] = closed_shift(w, m, 1, *totals)
    w.db.commit()
    return shifts


def _verification(w, out):
    return w.db.get(ZReport, uuid.UUID(out["zReportId"])).offline_report["verification"]


def _states(v):
    return {t["posNumber"]: t["state"] for t in v["tills"]}


class TestOneComputationNoMismatch:
    """
    The owner: "תוודא שלא יהיה מצב של אי התאמה בנתונים — רק במצב שהקופה מתה" (§8.12). The
    normal flows never raise `local_shop_z_mismatch`; only everything-arrived-and-different does.
    """

    def _parts(self, w, shifts):
        return [_part(w, m, [shifts[m.id]]) for m in w.six[:5]]

    def _no_mismatch(self, w):
        assert sequence_exceptions(w, "local_shop_z_mismatch") == []

    def test_all_tills_online_verified_at_once(self, w):
        shifts = _five(w)
        code, out = upload(w, w.six[0], _manifest_body(w, 1, self._parts(w, shifts)))
        assert code == 201, out
        v = _verification(w, out)
        assert v["state"] == "verified" and set(_states(v).values()) == {"verified"}
        assert out["verification"]["state"] == "verified"
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("50.00") and z.transactions_count == 5
        assert all(s.z_report_id == z.id for s in shifts.values())
        self._no_mismatch(w)
        assert sequence_exceptions(w, "local_shop_z_till_unsynced") == []

    def test_a_till_syncing_late_is_waited_for_never_a_mismatch(self, w):
        from app.routers import machines as machines_router

        shifts = _five(w)
        parts = self._parts(w, shifts)  # till 5 reported its part over the LAN …
        five = w.six[4]
        documents_arrive, close_arrives = _withhold(w, five, shifts[five.id])  # … the cloud has nothing yet
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201, out  # kept as printed, never refused for waiting
        v = _verification(w, out)
        assert v["state"] == "waiting" and _states(v)["5"] == "waiting"
        assert "ממתין למסמכים מקופה 5" in v["message"]
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("50.00")  # the paper, all five
        assert shifts[five.id].z_report_id is None
        assert str(z.id) in w.shop.settings[LZ.VERIFY_KEY]
        # Its documents arrive, its close not yet: still waiting — for the close.
        documents_arrive()
        LZ.verify_pending(w.db, w.shop.id, force=True)
        v = z.offline_report["verification"]
        assert v["state"] == "waiting" and "ממתין לסגירת המשמרת מקופה 5" in v["message"]
        # The close arrives; the next heartbeat of any till links it and verifies.
        close_arrives()
        w.db.commit()
        LZ._LAST_CHECK.pop(str(w.shop.id), None)
        machines_router.post_my_heartbeat(None, machine=w.six[2], db=w.db)
        w.db.refresh(z)
        assert z.offline_report["verification"]["state"] == "verified"
        assert shifts[five.id].z_report_id == z.id
        assert not (w.shop.settings or {}).get(LZ.VERIFY_KEY)
        self._no_mismatch(w)

    def test_the_main_till_syncing_late_is_the_same(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        main = w.six[0]
        documents_arrive, close_arrives = _withhold(w, main, shifts[main.id])
        w.db.commit()
        code, out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201
        assert _states(_verification(w, out))["1"] == "waiting"
        close_arrives()
        documents_arrive()
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert LZ.verify_pending(w.db, w.shop.id, force=True) == 1
        assert z.offline_report["verification"]["state"] == "verified"
        self._no_mismatch(w)

    def test_retries_and_repeated_checks_change_nothing(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        documents_arrive, close_arrives = _withhold(w, w.six[3], shifts[w.six[3].id])
        w.db.commit()
        cid, zid = uuid.uuid4(), uuid.uuid4()
        body = _manifest_body(w, 1, parts, cid=cid, zid=zid)
        assert upload(w, w.six[0], body)[0] == 201
        for _ in range(3):  # the main till sends it again, the tills beat again
            code, again = upload(w, w.six[0], _manifest_body(w, 1, parts, cid=cid, zid=zid))
            assert code == 200 and again["status"] == "duplicate"
            LZ.verify_pending(w.db, w.shop.id, force=True)
        documents_arrive()
        close_arrives()
        for _ in range(3):
            LZ.verify_pending(w.db, w.shop.id, force=True)
        z = w.db.get(ZReport, zid)
        assert z.offline_report["verification"]["state"] == "verified"
        assert w.db.query(ZReport).count() == 1
        self._no_mismatch(w)

    def test_a_till_that_goes_offline_after_reporting_is_for_support_never_a_mismatch(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        three = w.six[2]
        _withhold(w, three, shifts[three.id])  # its part is on the paper; it never syncs again
        three.last_heartbeat_at = NOW - timedelta(hours=30)
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert _states(_verification(w, out))["3"] == "waiting"
        # A day later it still has not: "קופה 3 לא השלימה סנכרון" — not a mismatch.
        later = z.uploaded_at.replace(tzinfo=timezone.utc) + timedelta(hours=25) if z.uploaded_at.tzinfo is None else z.uploaded_at + timedelta(hours=25)
        v = LZ.verify(w.db, z, now=later)
        assert v["state"] == "incomplete" and "קופה 3 לא השלימה סנכרון" in v["message"]
        unsynced = sequence_exceptions(w, "local_shop_z_till_unsynced")
        assert len(unsynced) == 1 and unsynced[0].details["missing"] == 1
        LZ.verify(w.db, z, now=later)  # once
        assert len(sequence_exceptions(w, "local_shop_z_till_unsynced")) == 1
        self._no_mismatch(w)
        # Support closes it, recording what is missing; the Z stays as printed.
        out = ZP.post_close_local_shop_z_part(
            w.shop.id, z.id, three.id, ZP.ConflictResolveIn(note="הקופה הושמדה"),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["state"] == "closed_by_support"
        closed = next(t for t in out["tills"] if t["posNumber"] == "3")["closedBySupport"]
        assert closed["missingDocuments"] == 1 and closed["missingShiftIds"] == [str(shifts[three.id].id)]
        assert closed["printedTotals"]["gross"] == "10.00" and closed["note"] == "הקופה הושמדה"
        assert z.total_sales == Decimal("50.00")
        assert not (w.shop.settings or {}).get(LZ.VERIFY_KEY)
        self._no_mismatch(w)

    def test_a_till_removed_after_reporting_is_incomplete_at_once(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        two = w.six[1]
        _withhold(w, two, shifts[two.id])
        two.pairing_status = PairingStatus.UNPAIRED
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        v = _verification(w, out)
        assert v["state"] == "incomplete" and _states(v)["2"] == "incomplete"
        assert next(t for t in v["tills"] if t["posNumber"] == "2")["reason"] == "removed"
        self._no_mismatch(w)

    def test_only_everything_arrived_and_different_is_a_mismatch_with_full_detail(self, w):
        from app.models.transaction import Transaction

        shifts = _five(w)
        parts = self._parts(w, shifts)
        # A bug: the cloud's copy of a till 4 document is not what the till counted.
        doc = w.db.query(Transaction).filter(Transaction.shift_id == shifts[w.six[3].id].id).one()
        doc.total_amount = Decimal("10.01")
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201  # stored as printed all the same
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("50.00")
        v = z.offline_report["verification"]
        assert v["state"] == "mismatch" and _states(v)["4"] == "mismatch"
        keys = {d["key"] for d in v["discrepancies"]}
        assert {"4:totals.gross", "4:digest"} <= keys
        exc = sequence_exceptions(w, "local_shop_z_mismatch")
        assert len(exc) == 1
        details = exc[0].details
        assert details["allDocumentsArrived"] is True and details["storedAsPrinted"] is True
        assert details["severity"] == "high"
        assert "אי-התאמה בין Z מקומי לנתוני הענן" in details["summary"]
        four = details["tills"][0]
        assert four["printed"]["totals"]["gross"] == "10.00" and four["cloud"]["totals"]["gross"] == "10.01"
        # Checked again: one exception, not one per check.
        LZ.verify(w.db, z)
        assert len(sequence_exceptions(w, "local_shop_z_mismatch")) == 1

    def test_a_paper_that_is_not_its_parts_is_a_mismatch_once_everything_arrived(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        summary = {"gross": "53.00", "discounts": "0.00", "refunds": "0.00", "net": "53.00", "cash": "53.00",
                   "card": "0.00", "exchange": "0.00", "tips": "0.00", "vat": None, "transactions": 5}
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts, summary=summary))
        assert code == 201
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("53.00")  # as printed
        v = z.offline_report["verification"]
        assert v["state"] == "mismatch"
        assert {"key": "summary:gross", "printed": "53.00", "cloud": "50.00"} in v["discrepancies"]

    def test_the_manifest_names_documents_a_late_document_of_the_shift_is_not_compared(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        # Written into till 2's shift after its part was built (it is the next Z's): not named.
        w.doc(w.six[1], shifts[w.six[1].id], "7.00")
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        assert _verification(w, out)["state"] == "verified"
        self._no_mismatch(w)

    def test_an_older_till_without_a_manifest_is_unverified_never_a_mismatch(self, w):
        shifts = _five(w)
        parts = self._parts(w, shifts)
        parts[1] = {k: v for k, v in parts[1].items() if k != "manifest"}
        parts[1]["report"] = {k: v for k, v in parts[1]["report"].items() if k != "manifestDigest"}
        body = _manifest_body(w, 1, [p for p in parts if "manifest" in p])
        body.tills.insert(1, LZ.LocalShopZTill.model_validate(parts[1]))
        code, out = upload(w, w.six[0], body)
        assert code == 201
        v = _verification(w, out)
        assert _states(v)["2"] == "unverified" and v["state"] == "verified"
        self._no_mismatch(w)


class TestThePaperIsTheZ:
    def test_stored_exactly_as_printed_with_its_ranges_and_no_figures_of_the_cloud(self, w):
        from app.routers.z_reports import z_to_out

        shifts = _five(w, more={"5": ["2.00"]})
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5]]
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201, out
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("52.00") and z.transactions_count == 6
        section5 = next(s for s in z.per_machine if s["posNumber"] == "5")
        assert section5["grossSales"] == "12.00" and section5["documentRanges"]["320"]["count"] == 2
        assert z.shop_sequence_number == 1
        assert z_to_out(z).total_sales == Decimal("52.00")
        assert z_to_out(z).verification["state"] == "verified"
        assert "cloudCheck" not in z.offline_report
        assert "byWaiter" not in z.header and z.header["asPrinted"]["producedBy"]["posNumber"] == "1"
        assert z.header["scope"]["kind"] == "shop"
        assert w.db.query(ZReport).count() == 1  # one Z: no corrective one


# ── Kiosks, and a participant off the LAN closed through the cloud (§8.13–8.14) ──


def _make_kiosk(w, till):
    from app.models.kiosk import KioskDevice
    from app.models.pos_machine import _KIOSK_CACHE

    w.db.add(KioskDevice(
        machine_id=till.id, tenant_id=till.tenant_id, shop_id=till.shop_id, name=f"קיוסק {till.pos_number}", enabled=True,
    ))
    w.db.flush()
    till.__dict__.pop(_KIOSK_CACHE, None)
    return till


def _put_remote(w, ids):
    out = ZP.put_z_participation(
        w.shop.id,
        ZP.ZParticipationIn.model_validate({
            "participants": [], "independent": [], "remote": [str(i) for i in ids],
        }),
        background_tasks=_Tasks(), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return out if isinstance(out, dict) else json.loads(out.body)


def _report_body(request_id, round_id, machine, outcome="closed", section=None, shift_id=None):
    return {
        "requestId": request_id, "roundId": round_id, "machineId": str(machine.id), "outcome": outcome,
        "shiftId": shift_id, "message": None, "section": section,
    }


class TestKioskParticipant:
    def test_a_kiosk_in_the_shop_z_is_a_participant_named_as_a_kiosk(self, w):
        owner_setup(w)
        _make_kiosk(w, w.six[4])
        out = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        five = next(p for p in out["participants"] if p["posNumber"] == "5")
        assert five["kiosk"] is True and five["remote"] is False
        assert next(p for p in out["participants"] if p["posNumber"] == "1")["kiosk"] is False
        card = ZP.get_z_participation(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert next(t for t in card["tills"] if t["posNumber"] == "5")["kiosk"] is True

    def test_a_kiosks_part_is_in_the_local_z_and_verified_like_any_till(self, w):
        shifts = _five(w)
        _make_kiosk(w, w.six[4])
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5]]
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert "5" in {s["posNumber"] for s in z.per_machine}
        assert z.offline_report["verification"]["state"] == "verified"
        assert shifts[w.six[4].id].z_report_id == z.id

    def test_after_the_local_z_only_a_kiosk_not_in_it_is_asked_to_close(self, w, monkeypatch):
        from app.models.kiosk_ops import KioskCloseRequest
        from app.services import kiosk_config as KC
        from app.services import kiosk_ops

        shifts = _five(w)
        # Till 5 a kiosk in the shop Z; till 6 a kiosk making its own Z ("Z לכל קופה").
        _make_kiosk(w, w.six[4])
        from app.services.till_z import set_z_mode

        six = _make_kiosk(w, w.six[5])
        set_z_mode(w.db, six, "till")
        w.db.commit()
        monkeypatch.setattr(KC, "effective_config", lambda db, m: {"operations": {"closeWithShopZ": True}})
        monkeypatch.setattr(kiosk_ops, "wake_machine", lambda *a, **k: None)
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5]]
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        asked = {r.kiosk_machine_id for r in w.db.query(KioskCloseRequest).all()}
        assert asked == {six.id}


class TestRemoteParticipant:
    def _setup(self, w, remote=None):
        owner_setup(w)
        kiosk = _make_kiosk(w, w.six[4])
        out = _put_remote(w, [kiosk.id] if remote is None else remote)
        return kiosk, out

    def test_the_card_sets_a_participant_remote_and_shows_the_lan_hint(self, w):
        kiosk, out = self._setup(w)
        five = next(t for t in out["tills"] if t["posNumber"] == "5")
        assert five["link"] == "remote" and five["kiosk"] is True
        assert next(t for t in out["tills"] if t["posNumber"] == "2")["link"] == "lan"
        assert five["seenOnLan"] is None  # the main till has not said whom it hears yet
        # The main till's heartbeat says whom it hears on the LAN: a hint, the setting decides.
        from app.routers import machines as machines_router
        from app.schemas.pos_machine import MachineHeartbeatBody

        main = w.six[0]
        main.last_heartbeat_at = datetime.now(timezone.utc)
        body = MachineHeartbeatBody.model_validate({
            "localShopZ": {"pending": 0, "conflict": False, "lanSeen": [str(m.id) for m in w.six[1:4]]},
        })
        machines_router.post_my_heartbeat(body, machine=main, db=w.db)
        card = ZP.get_z_participation(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        hint = {t["posNumber"]: t["seenOnLan"] for t in card["tills"]}
        assert hint["2"] is True and hint["5"] is False and hint["1"] is True
        assert next(t for t in card["tills"] if t["posNumber"] == "5")["link"] == "remote"
        hist = LR.till_shop_z_history(str(main.id), days=31, machine=main, db=w.db)
        assert next(p for p in hist["participants"] if p["posNumber"] == "5")["remote"] is True

    def test_a_windows_kiosk_is_always_closed_through_the_cloud(self, w):
        """
        The Windows kiosk has no LAN client: over the LAN the main till would wait for it as
        unreachable, forever (PARITY.md gap 5). It is remote whatever the setting, and the card
        says the choice is not one.
        """
        owner_setup(w)
        kiosk = _make_kiosk(w, w.six[4])
        kiosk.platform = "windows"
        w.db.commit()
        card = ZP.get_z_participation(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        five = next(t for t in card["tills"] if t["posNumber"] == "5")
        assert five["link"] == "remote" and five["linkFixed"] is True
        assert next(t for t in card["tills"] if t["posNumber"] == "2")["linkFixed"] is False
        main = w.six[0]
        hist = LR.till_shop_z_history(str(main.id), days=31, machine=main, db=w.db)
        remote = {p["posNumber"]: p["remote"] for p in hist["participants"]}
        assert remote["5"] is True and remote["2"] is False
        # The main till may ask the cloud to close it, like any remote participant.
        out = LR.till_shop_z_remote_close(
            str(main.id),
            LR.RemoteCloseIn.model_validate({"roundId": "r1", "requests": [{"machineId": str(kiosk.id), "requestId": "q1"}]}),
            machine=main, db=w.db,
        )
        assert out["refused"] == [] and [p["state"] for p in out["parts"]] == ["requested"]

    def test_only_a_participant_and_never_the_main_till_is_remote(self, w):
        owner_setup(w)
        out = _put_remote(w, [w.six[0].id])
        assert out["detail"] == "remote_main_till"
        out = _put_remote(w, [w.six[5].id])
        assert out["detail"] == "remote_not_participant"

    def test_closed_through_the_cloud_and_included_in_the_local_z(self, w):
        from app.routers import machines as machines_router

        kiosk, _ = self._setup(w)
        main = w.six[0]
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        w.db.commit()
        # The main till asks the cloud to close the remote kiosk for its round.
        out = LR.till_shop_z_remote_close(
            str(main.id),
            LR.RemoteCloseIn.model_validate({"roundId": "r1", "requests": [{"machineId": str(kiosk.id), "requestId": "q1"}]}),
            machine=main, db=w.db,
        )
        assert [p["state"] for p in out["parts"]] == ["requested"] and out["refused"] == []
        # The kiosk hears it on its heartbeat.
        beat = machines_router.post_my_heartbeat(None, machine=kiosk, db=w.db)
        assert beat["pendingShopZPart"] == {"requestId": "q1", "roundId": "r1", "force": True}
        # A card in flight first ("ממתינה לסיום חיוב אשראי"): not final.
        LR.till_shop_z_remote_part(str(kiosk.id), _report_body("q1", "r1", kiosk, "waiting_card"), machine=kiosk, db=w.db)
        part = _part(w, kiosk, [shifts[kiosk.id]])
        section = {
            "machineId": str(kiosk.id), "posNumber": "5", "machineName": kiosk.name,
            "shiftIds": part["shiftIds"], "till": part["till"], "report": part["report"], "manifest": part["manifest"],
        }
        LR.till_shop_z_remote_part(
            str(kiosk.id), _report_body("q1", "r1", kiosk, "closed", section, str(shifts[kiosk.id].id)), machine=kiosk, db=w.db,
        )
        # Answered: no longer pending on its heartbeat; the main till pulls the part as sent.
        assert "pendingShopZPart" not in machines_router.post_my_heartbeat(None, machine=kiosk, db=w.db)
        pulled = LR.till_shop_z_remote_parts(str(main.id), round_id="r1", machine=main, db=w.db)
        (got,) = pulled["parts"]
        assert got["state"] == "reported" and got["outcome"] == "closed"
        assert got["report"]["section"]["manifest"]["digest"] == part["manifest"]["digest"]
        # The local Z includes it; the cloud verifies it like any part, and records it taken.
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:4]] + [part]
        code, z_out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201
        assert _verification(w, z_out)["state"] == "verified"
        from app.models.shop_z_remote_part import ShopZRemotePart

        row = w.db.query(ShopZRemotePart).one()
        assert row.state == "taken" and str(row.z_report_id) == z_out["zReportId"]

    def test_retry_supersedes_and_an_old_answer_is_refused(self, w):
        from app.routers import machines as machines_router

        kiosk, _ = self._setup(w)
        main = w.six[0]
        ask = lambda rid: LR.till_shop_z_remote_close(  # noqa: E731
            str(main.id),
            LR.RemoteCloseIn.model_validate({"roundId": "r1", "requests": [{"machineId": str(kiosk.id), "requestId": rid}]}),
            machine=main, db=w.db,
        )
        ask("q1")
        ask("q1")  # the same request again: nothing new
        ask("q2")  # "נסה שוב": a new request supersedes the first
        assert machines_router.post_my_heartbeat(None, machine=kiosk, db=w.db)["pendingShopZPart"]["requestId"] == "q2"
        resp = LR.till_shop_z_remote_part(str(kiosk.id), _report_body("q1", "r1", kiosk), machine=kiosk, db=w.db)
        assert resp.status_code == 409 and json.loads(resp.body)["detail"] == "unknown_request"
        pulled = LR.till_shop_z_remote_parts(str(main.id), round_id="r1", machine=main, db=w.db)
        assert [p["requestId"] for p in pulled["parts"]] == ["q2"]

    def test_only_the_main_till_asks_and_only_for_participants(self, w):
        kiosk, _ = self._setup(w)
        body = LR.RemoteCloseIn.model_validate({"roundId": "r1", "requests": [{"machineId": str(kiosk.id), "requestId": "q1"}]})
        resp = LR.till_shop_z_remote_close(str(w.six[1].id), body, machine=w.six[1], db=w.db)
        assert resp.status_code == 409 and json.loads(resp.body)["detail"] == "not_main_till"
        out = LR.till_shop_z_remote_close(
            str(w.six[0].id),
            LR.RemoteCloseIn.model_validate({"roundId": "r1", "requests": [{"machineId": str(w.six[5].id), "requestId": "q9"}]}),
            machine=w.six[0], db=w.db,
        )
        assert out["refused"] == [{"machineId": str(w.six[5].id), "detail": "not_a_participant"}]
        assert out["parts"] == []

    def test_a_remote_kiosk_that_died_after_reporting_is_waited_for_then_for_support(self, w):
        kiosk, _ = self._setup(w)
        shifts = _five(w)
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5]]
        _withhold(w, kiosk, shifts[kiosk.id])  # its part reached the main till; its documents never the cloud
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        v = _verification(w, out)
        assert _states(v)["5"] == "waiting" and "ממתין למסמכים מקופה 5" in v["message"]
        assert sequence_exceptions(w, "local_shop_z_mismatch") == []


# ── A till's late documents: a part of its own, keyed by till and `late` ──────────


def _carry_shift(w, till, *totals, z_number=4):
    """A carry shift of `till` (SPEC_OFFLINE_TILL_Z §4.6.3): late documents for the next Z."""
    from app.models.shift import Shift

    at = NOW - timedelta(hours=1)
    shift = Shift(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        business_date=TODAY, sequence_number=None, opened_at=at, closed_at=at, close_accepted_at=at,
        status=ShiftStatus.CLOSED, unattended=True, reconstructed=True, reconstructed_by="מסמכים מאוחרים",
        reconstruction_basis={
            "kind": "late_documents", "source": "support_z", "producedBySupport": True,
            "sourceZNumber": z_number, "posNumber": till.pos_number, "sourceShiftIds": [],
            "label": f"מסמכים מאוחרים מתקופה קודמת (קופה {till.pos_number}, הופקו לפני Z מס׳ {z_number} שהופק ע״י התמיכה)",
        },
    )
    w.db.add(shift)
    w.db.flush()
    for total in totals:
        w.doc(till, shift, total)
    return shift


def _late_part_of(w, till):
    """The late part the cloud hands the main till in the history, as the main till uploads it."""
    hist = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
    p = next(x for x in hist["participants"] if x["machineId"] == str(till.id)).get("lateDocuments")
    assert p is not None and p["late"] is True and p["manifest"]["digest"]
    return {
        "machineId": p["machineId"], "shiftIds": p["shiftIds"], "till": p["till"], "report": p["report"],
        "firstDocumentNumber": p.get("firstDocumentNumber"), "lastDocumentNumber": p.get("lastDocumentNumber"),
        "manifest": p["manifest"], "late": True, "label": p["label"],
    }


class TestLateDocumentsPart:
    def test_a_late_part_only(self, w):
        owner_setup(w)
        three = w.six[2]
        carry = _carry_shift(w, three, "7.00")
        w.db.commit()
        late = _late_part_of(w, three)
        code, out = upload(w, w.six[0], _manifest_body(w, 1, [late]))
        assert code == 201, out
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("7.00")
        (section,) = z.per_machine
        assert section["late"] is True and section["label"].startswith("מסמכים מאוחרים מתקופה קודמת (קופה 3")
        v = z.offline_report["verification"]
        assert v["state"] == "verified"
        (entry,) = v["tills"]
        assert entry["key"] == f"{three.id}:late" and entry["late"] is True
        assert carry.z_report_id == z.id
        # Taken: the next history offers it no more.
        hist = LR.till_shop_z_history(str(w.six[0].id), days=31, machine=w.six[0], db=w.db)
        assert "lateDocuments" not in next(x for x in hist["participants"] if x["machineId"] == str(three.id))

    def test_a_late_part_and_a_regular_part_of_the_same_till(self, w):
        owner_setup(w)
        three = w.six[2]
        regular = closed_shift(w, three, 1, "10.00")
        carry = _carry_shift(w, three, "7.00", "3.00")
        w.db.commit()
        parts = [_part(w, three, [regular]), _late_part_of(w, three)]
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201, out
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert z.total_sales == Decimal("20.00") and z.transactions_count == 3
        assert len(z.per_machine) == 2 and z.machine_count == 1
        assert [bool(s.get("late")) for s in z.per_machine] == [False, True]
        v = z.offline_report["verification"]
        assert v["state"] == "verified"
        assert {t["key"]: t["state"] for t in v["tills"]} == {str(three.id): "verified", f"{three.id}:late": "verified"}
        assert regular.z_report_id == z.id and carry.z_report_id == z.id

    def test_verified_on_upload_each_part_on_its_own(self, w):
        from app.models.transaction import Transaction

        owner_setup(w)
        three = w.six[2]
        regular = closed_shift(w, three, 1, "10.00")
        carry = _carry_shift(w, three, "7.00")
        w.db.commit()
        parts = [_part(w, three, [regular]), _late_part_of(w, three)]
        # A bug: the cloud's copy of the late document is not what the part counted.
        doc = w.db.query(Transaction).filter(Transaction.shift_id == carry.id).one()
        doc.total_amount = Decimal("7.50")
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        v = _verification(w, out)
        assert v["state"] == "mismatch"
        states = {t["key"]: t["state"] for t in v["tills"]}
        assert states == {str(three.id): "verified", f"{three.id}:late": "mismatch"}
        assert any(d["key"].startswith("3:late:") for d in v["discrepancies"])
        assert len(sequence_exceptions(w, "local_shop_z_mismatch")) == 1

    def test_support_closes_a_late_part_by_its_key(self, w):
        owner_setup(w)
        three = w.six[2]
        regular = closed_shift(w, three, 1, "10.00")
        carry = _carry_shift(w, three, "7.00")
        w.db.commit()
        parts = [_part(w, three, [regular]), _late_part_of(w, three)]
        _withhold(w, three, carry)  # its documents are not in the cloud (any more)
        w.db.commit()
        code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
        assert code == 201
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert {t["key"]: t["state"] for t in _verification(w, out)["tills"]}[f"{three.id}:late"] == "waiting"
        out = ZP.post_close_local_shop_z_part(
            w.shop.id, z.id, three.id, ZP.ConflictResolveIn(note="לא יגיעו"), late=True,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        states = {t["key"]: t["state"] for t in out["tills"]}
        assert states == {str(three.id): "verified", f"{three.id}:late": "closed_by_support"}
