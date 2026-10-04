"""
A shop Z that leaves tills behind: the `shopZOpenTills` till parameter.

What is pinned, and how it could look fine while doing damage:

* **Resolution at shop level** — the shop's value beats its company's, which beats the
  default; an area's or a till's value never decides a rule about the whole shop.
* **Block** — a shop Z leaving a till with an open (or un-Z'd) shift behind is refused
  with the tills listed, not silently produced.
* **Confirm** — refused until the request confirms; then the tills it went without and
  who confirmed are recorded on the run and frozen into the Z's header, also when the
  Z is built later than the request.
* **Unaffected** — a per-till Z (`zScope` = machine), a Z that leaves nothing behind, and
  a database without the parameter (it was deactivated or never created) behave as before.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.z_report import ZReport
from app.models.z_run import ZRunItemStatus, ZRunStatus
from app.routers import sync as sync_router
from app.schemas.shift import ShiftCloseIn
from app.services import ably_notify
from app.services import till_parameters as TP
from app.services import z_runs as ZR
from app.services.shifts import apply_shift_close
from shift_world import NOW, accept_str_uuids, freeze_z_run_clock, make_world

pytestmark = pytest.mark.usefixtures("z_activity_unchecked")  # not about "no Z on 0"

BLOCK = TP.SHOP_Z_OPEN_TILLS_BLOCK
CONFIRM = TP.SHOP_Z_OPEN_TILLS_CONFIRM


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    world.sent = []
    monkeypatch.setattr(
        ably_notify, "publish_close_shift_notify", lambda *a, **k: world.sent.append(a)
    )
    return world


@pytest.fixture
def rule(w):
    """The built-in parameter, as the API creates it on start-up."""
    assert TP.SHOP_Z_OPEN_TILLS_KEY in TP.ensure_builtin_parameters(w.db)
    return w.db.query(TillParameter).filter(TillParameter.key == TP.SHOP_Z_OPEN_TILLS_KEY).one()


def set_value(w, parameter, scope_type, scope_id, value):
    w.db.add(
        TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value
        )
    )
    w.db.flush()


def closed_shift(w, till, seq):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN)
    doc = w.doc(till, shift, "10.00")
    body = ShiftCloseIn.model_validate({
        "closedAt": NOW.isoformat(), "unattended": True, "countedCash": None,
        "transactionIds": [str(doc.id)],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def sel(machine, include_open=None):
    return ZR.MachineSelection(machine_id=machine.id, include_open_shift=include_open)


def run(w, *selections, confirm=False):
    return ZR.create_z_run(
        w.db, w.admin, w.tenant, w.shop, list(selections), confirm_open_tills=confirm, now=NOW
    )


def refusal(w, *selections, confirm=False):
    with pytest.raises(HTTPException) as caught:
        run(w, *selections, confirm=confirm)
    assert caught.value.status_code == 409
    return caught.value.detail


# ── Resolution at shop level ─────────────────────────────────────────────────


class TestResolveForShop:
    def test_the_default_when_nothing_is_set(self, w, rule):
        assert TP.resolve_for_shop(w.db, w.shop)[TP.SHOP_Z_OPEN_TILLS_KEY] == CONFIRM

    def test_the_company_value_beats_the_default(self, w, rule):
        set_value(w, rule, "company", w.company.id, BLOCK)
        assert TP.resolve_for_shop(w.db, w.shop)[TP.SHOP_Z_OPEN_TILLS_KEY] == BLOCK

    def test_the_shop_value_beats_the_company_value(self, w, rule):
        set_value(w, rule, "company", w.company.id, BLOCK)
        set_value(w, rule, "shop", w.shop.id, CONFIRM)
        assert TP.resolve_for_shop(w.db, w.shop)[TP.SHOP_Z_OPEN_TILLS_KEY] == CONFIRM
        # Another shop of the company still gets the company's value.
        assert TP.resolve_for_shop(w.db, w.other_shop)[TP.SHOP_Z_OPEN_TILLS_KEY] == BLOCK

    def test_a_till_or_area_value_does_not_decide_for_the_shop(self, w, rule):
        area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(area)
        w.db.flush()
        set_value(w, rule, "machine", w.tills[0].id, BLOCK)
        set_value(w, rule, "area", area.id, BLOCK)
        assert TP.resolve_for_shop(w.db, w.shop)[TP.SHOP_Z_OPEN_TILLS_KEY] == CONFIRM

    def test_an_inactive_parameter_is_not_resolved(self, w, rule):
        rule.is_active = False
        w.db.flush()
        assert TP.SHOP_Z_OPEN_TILLS_KEY not in TP.resolve_for_shop(w.db, w.shop)


class TestRule:
    def test_the_rule_the_wizard_is_told(self, w, rule):
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) == "confirm"
        set_value(w, rule, "shop", w.shop.id, BLOCK)
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) == "block"
        w.tenant.settings = {"zScope": "machine"}
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) is None

    def test_no_rule_without_the_parameter(self, w):
        assert ZR.open_tills_rule(w.db, w.tenant, w.shop) is None


class TestBuiltinParameter:
    def test_created_once_and_never_overwritten(self, w, rule):
        assert rule.value_type == "enum"
        assert rule.enum_options == [BLOCK, CONFIRM]
        assert rule.default_value == CONFIRM
        assert rule.is_active is True
        rule.default_value = BLOCK
        rule.label = "renamed"
        w.db.flush()

        assert TP.ensure_builtin_parameters(w.db) == []

        again = w.db.query(TillParameter).filter(TillParameter.key == TP.SHOP_Z_OPEN_TILLS_KEY).all()
        assert len(again) == 1
        assert again[0].default_value == BLOCK and again[0].label == "renamed"


# ── Block ────────────────────────────────────────────────────────────────────


class TestBlock:
    def test_an_unselected_till_with_an_open_shift_blocks_the_z(self, w, rule):
        set_value(w, rule, "company", w.company.id, BLOCK)
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        open_shift = w.shift(t2, 1, status=ShiftStatus.OPEN)

        detail = refusal(w, sel(t1), confirm=True)  # confirming does not lift a block

        assert detail == {
            "code": "open_tills_block_z",
            "tills": [{"id": str(t2.id), "posNumber": t2.pos_number, "name": t2.name, "openShiftId": str(open_shift.id)}],
        }
        assert w.sent == []

    def test_a_selected_till_whose_open_shift_stays_open_blocks_the_z(self, w, rule):
        set_value(w, rule, "shop", w.shop.id, BLOCK)
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        open_shift = w.shift(t1, 2, status=ShiftStatus.OPEN)

        detail = refusal(w, sel(t1, include_open=False))

        assert detail["code"] == "open_tills_block_z"
        assert [t["id"] for t in detail["tills"]] == [str(t1.id)]
        assert detail["tills"][0]["openShiftId"] == str(open_shift.id)

    def test_an_unselected_till_with_closed_shifts_awaiting_a_z_blocks_it(self, w, rule):
        set_value(w, rule, "shop", w.shop.id, BLOCK)
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        closed_shift(w, t2, 1)

        detail = refusal(w, sel(t1))

        assert detail["tills"] == [{"id": str(t2.id), "posNumber": t2.pos_number, "name": t2.name, "openShiftId": None}]

    def test_a_z_that_takes_every_till_goes_ahead(self, w, rule):
        set_value(w, rule, "shop", w.shop.id, BLOCK)
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        r = run(w, sel(t1), sel(t2))  # t2's open shift is asked to close into this Z

        assert r.status == ZRunStatus.WAITING
        assert ZR.open_tills_left_out(w.db, r) is None

    def test_a_till_with_nothing_to_report_is_not_in_the_way(self, w, rule):
        set_value(w, rule, "shop", w.shop.id, BLOCK)
        t1, _t2 = w.tills
        closed_shift(w, t1, 1)

        assert run(w, sel(t1)).status == ZRunStatus.COMPLETED


# ── Confirm ──────────────────────────────────────────────────────────────────


class TestConfirm:
    def test_refused_until_confirmed(self, w, rule):
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        open_shift = w.shift(t2, 1, status=ShiftStatus.OPEN)

        detail = refusal(w, sel(t1))

        assert detail["code"] == "open_tills_need_confirmation"
        assert detail["tills"][0]["id"] == str(t2.id)
        assert detail["tills"][0]["openShiftId"] == str(open_shift.id)

    def test_a_confirmed_z_records_the_tills_and_who_confirmed(self, w, rule):
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        open_shift = w.shift(t2, 1, status=ShiftStatus.OPEN)

        r = run(w, sel(t1), confirm=True)

        assert r.status == ZRunStatus.COMPLETED
        z = w.db.get(ZReport, r.z_report_id)
        left = z.header["openTillsLeftOut"]
        assert left["tills"] == [
            {"id": str(t2.id), "posNumber": t2.pos_number, "name": t2.name, "openShiftId": str(open_shift.id)}
        ]
        assert left["confirmedByUserId"] == str(w.admin.id)
        assert left["confirmedByName"] == "admin"
        assert left["confirmedAt"]
        # The till left out was not asked to close, and its shift is still open.
        assert w.sent == []
        # The run shows the confirmation, not a phantom item for the left-out till.
        out = ZR.run_to_out(w.db, r)
        assert out["openTillsLeftOut"]["tills"][0]["id"] == str(t2.id)
        assert [i["machineId"] for i in out["items"]] == [t1.id]
        # And the printed Z says so.
        from zoneinfo import ZoneInfo

        from app.services.z_print import build_print_document

        footer = build_print_document(z, ZoneInfo("Asia/Jerusalem"))["footer"]
        assert any(line.startswith("הופק ללא קופות: 2") and "admin" in line for line in footer)

    def test_the_confirmation_reaches_a_z_built_later(self, w, rule):
        t1, t2 = w.tills
        open_t1 = w.shift(t1, 1, status=ShiftStatus.OPEN)
        doc = w.doc(t1, open_t1, "10.00")
        closed_shift(w, t2, 1)

        r = run(w, sel(t1), confirm=True)  # t1 asked to close; t2's closed shift waits
        assert r.status == ZRunStatus.WAITING
        item = next(i for i in r.items if not ZR.is_left_out_marker(i))
        assert item.status == ZRunItemStatus.WAITING_CLOSE

        body = ShiftCloseIn.model_validate({
            "closedAt": NOW.isoformat(), "unattended": True, "countedCash": None,
            "transactionIds": [str(doc.id)], "closeRequestId": str(item.id),
        })
        sync_router.post_shift_close(
            machine_id=str(t1.id), shift_id=open_t1.id, body=body, machine=t1, approval=None, db=w.db
        )
        w.db.refresh(r)

        assert r.status == ZRunStatus.COMPLETED, (r.status, r.error_code, r.error_message)
        z = w.db.get(ZReport, r.z_report_id)
        assert [t["id"] for t in z.header["openTillsLeftOut"]["tills"]] == [str(t2.id)]
        assert z.header["openTillsLeftOut"]["tills"][0]["openShiftId"] is None
        assert z.machine_count == 1

    def test_a_z_that_needs_no_confirmation_records_none(self, w, rule):
        t1, _t2 = w.tills
        closed_shift(w, t1, 1)

        r = run(w, sel(t1), confirm=True)

        z = w.db.get(ZReport, r.z_report_id)
        assert "openTillsLeftOut" not in z.header
        assert ZR.run_to_out(w.db, r)["openTillsLeftOut"] is None

    def test_a_till_another_run_is_producing_is_not_listed(self, w, rule):
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        w.shift(t2, 1, status=ShiftStatus.OPEN)
        other = run(w, sel(t2), confirm=True)  # t1's closed shift is left behind there
        assert other.status == ZRunStatus.WAITING

        r = run(w, sel(t1))  # t2 is the other run's: nothing to confirm here

        assert r.status == ZRunStatus.COMPLETED


# ── Unaffected ───────────────────────────────────────────────────────────────


class TestUnaffected:
    def test_a_per_till_z_is_not_subject_to_the_rule(self, w, rule):
        set_value(w, rule, "company", w.company.id, BLOCK)
        w.tenant.settings = {"zScope": "machine"}
        w.db.flush()
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        r = run(w, sel(t1))

        assert r.status == ZRunStatus.COMPLETED
        assert "openTillsLeftOut" not in w.db.get(ZReport, r.z_report_id).header

    def test_without_the_parameter_a_partial_z_goes_ahead_as_before(self, w):
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        assert run(w, sel(t1)).status == ZRunStatus.COMPLETED

    def test_a_deactivated_parameter_lifts_the_rule(self, w, rule):
        set_value(w, rule, "company", w.company.id, BLOCK)
        rule.is_active = False
        w.db.flush()
        t1, t2 = w.tills
        closed_shift(w, t1, 1)
        w.shift(t2, 1, status=ShiftStatus.OPEN)

        assert run(w, sel(t1)).status == ZRunStatus.COMPLETED
