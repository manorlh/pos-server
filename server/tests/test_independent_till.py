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
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import ShiftStatus
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
    """Another till prints and the tables are not on the LAN: the shop is not in local mode."""
    set_param(w, "printHostTill", "machine", w.six[1].id, True)
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

    def test_a_close_not_on_the_cloud_yet_is_waited_for(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:4]}
        still_open = w.shift(w.six[4], 1, status=ShiftStatus.OPEN)
        tills = [(m, [shifts[m.id]], None) for m in w.six[:4]] + [(w.six[4], [still_open], None)]
        code, out = upload(w, w.six[0], local_body(w, 1, tills))
        assert code == 409 and out["detail"] == "shift_not_closed"
        assert out["detail"] in LZ.RETRY_DETAILS
        assert last_shop_z_number(w.db, w.shop.id) == 0

    def test_a_participant_missing_from_the_paper_is_reported_never_hidden(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        tills = [(m, [shifts[m.id]], None) for m in w.six[:4]]  # till 5 left off the paper
        code, out = upload(w, w.six[0], local_body(w, 1, tills))
        assert code == 201
        assert {"key": "5:missing", "till": None, "cloud": 1} in out["discrepancies"]

    def test_the_paper_differing_from_the_documents_is_kept_beside_them(self, w):
        owner_setup(w)
        shifts = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:5]}
        tills = [(m, [shifts[m.id]], {"totalSales": 10.0}) for m in w.six[:4]]
        tills.append((w.six[4], [shifts[w.six[4].id]], {"totalSales": 12.0}))
        code, out = upload(w, w.six[0], local_body(w, 1, tills))
        assert code == 201
        assert {"key": "5:totalSales", "till": 12.0, "cloud": "10.00"} in out["discrepancies"]

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
        assert note == "כולל: Z סניפי מס׳ 1 (קופות 1–5) · Z עצמאי: קופה 6 (Z מס׳ 1)"

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
        code, out = set_value(w, "printHostTill", "machine", w.six[2].id, True)
        assert code == 409 and out["detail"] == LZ.BUSY
        with pytest.raises(Exception):
            IT.apply_shop(w.db, w.admin, w.shop, main_till_id=w.six[3].id)
        w.db.rollback()
        # Nothing moved.
        assert MT.main_till_of_shop(w.db, w.shop.id).id == main.id
        assert LZ.effective_producer(w.db, w.shop).is_local_of(main.id)

    def test_turning_the_lan_off_is_refused_while_the_main_till_holds_unsynced_zs(self, w):
        owner_setup(w)
        set_param(w, "tablesMode", "shop", w.shop.id, "רשת מקומית (קופה ראשית)")
        set_param(w, "printHostTill", "machine", w.six[1].id, True)  # local only by the LAN now
        assert LZ.local_mode_of_shop(w.db, w.shop) is True
        report(w, w.six[0], pending=1)
        w.db.commit()
        code, out = set_value(w, "tablesMode", "shop", w.shop.id, "כבוי")
        assert code == 409 and out["detail"] == LZ.BUSY

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
        assert "קופה 6 (קופה עצמאית)" in own["subtitle"]
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
        assert load_z_facts(w.db, till_z).till_label == "קופה 6"
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
