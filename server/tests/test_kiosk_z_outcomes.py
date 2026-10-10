"""
A kiosk's "הפקת Z" / "סגירת משמרת" command follows what the kiosk did (app/services/kiosk_z.py
`settle_commands`), and closed shifts with nothing in them never block a Z-mode switch
(app/services/till_z.py `waiting_shifts_all_empty`).

The owner (07.10): a dashboard "הפקת Z" to the Royal kiosk stayed `requested` forever. The kiosk
had picked it up, closed its (empty) shift and asked for its Z; the cloud refused it as empty
(`empty_z`, "אל תאפשר לסגור Z על 0") and the request ended failed — but nothing carried that
back to the command row. And the kiosk's empty closed shifts — no Z can ever be made for them —
then refused its move back into the shop Z (`independent_switch_unreported_shifts`).

What each test pins:

* **empty_z** — the request ends at once with why (the kiosk's later ack, "http_409" from an
  older app, changes nothing), the command reads `refused · אין מסמכים — אין צורך ב-Z`, and no
  Z number is drawn.
* **A Z made** — `applied · Z מס׳ 1 הופק`.
* **Rows stuck before this fix** — settled on the next read of the command list.
* **Expiry / a failed close / a close accepted** — the same, for both actions.
* **The switch** — only-empty waiting shifts: allowed, recorded on the switch, carried into the
  first Z of the new mode (shift count, no gap, no number for nothing, the till Z's business day
  is the one the till began on); empty and real mixed: still refused; documents still on the
  till, a shift the cloud closed for a dead till: refused as before.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

import pytest

from app.models.kiosk import KioskCommand
from app.models.till_z_request import TillZRequest
from app.models.z_report import ZReport
from app.services import independent_till as IT
from app.services import kiosk_control
from app.services import kiosk_z as KZ
from app.services import till_z
from app.services.shifts import apply_shift_close
from app.schemas.shift import ShiftCloseIn

import test_kiosk_z as K
import test_till_z as T

EMPTY_TEXT = "אין מסמכים — אין צורך ב-Z"


# ── The kiosk's command follows its request ──────────────────────────────────


w = K.w  # the kiosk world: "Till 1" is a kiosk, "Till 2" controls it


def _close_empty(w, shift):
    """The kiosk closes its shift for the Z, with no document in it (as the Royal kiosk did)."""
    body = ShiftCloseIn.model_validate({"closedAt": (shift.opened_at + timedelta(hours=1)).isoformat(), "transactionIds": []})
    closed, outcome = apply_shift_close(w.db, w.kiosk, shift.id, body)
    assert outcome == "accepted"
    w.db.commit()
    return closed


def _ask_raw(w, request_id):
    from app.routers import sync as sync_router
    from app.schemas.till_z import TillZIn

    resp = sync_router.post_till_z(
        machine_id=str(w.kiosk.id),
        body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4()), "tillZRequestId": str(request_id)}),
        machine=w.kiosk, db=w.db,
    )
    return resp.status_code, json.loads(resp.body)


def _command(w):
    return w.db.query(KioskCommand).filter(KioskCommand.action == "till_z").order_by(KioskCommand.created_at.desc()).first()


def test_an_empty_z_ends_the_request_and_the_command_says_why(w):
    K.make_independent(w)
    shift = K.open_shift(w)
    out, code = K.dashboard_command(w, "till_z")
    assert code == 201 and out["status"] == "requested"
    req = w.db.query(TillZRequest).one()
    till_z.apply_ack(w.db, w.kiosk, request_id=req.id, phase="received")
    w.db.commit()
    _close_empty(w, shift)

    status_code, body = _ask_raw(w, req.id)

    assert (status_code, body["detail"]) == (409, "empty_z")
    w.db.refresh(req)
    assert (req.status, req.error_code, req.error_message) == ("failed", "empty_z", EMPTY_TEXT)
    row = _command(w)
    assert (row.status, row.detail) == ("refused", EMPTY_TEXT)
    # No number drawn, no Z written: the kiosk's run still starts at 1.
    assert w.db.query(ZReport).filter(ZReport.machine_id == w.kiosk.id).count() == 0
    # The kiosk's own failed ack (an older app sends "http_409") changes nothing now.
    till_z.apply_ack(w.db, w.kiosk, request_id=req.id, phase="failed", error_code="http_409", error_message="empty_z")
    w.db.commit()
    w.db.refresh(req)
    assert (req.status, req.error_code) == ("failed", "empty_z")
    # Every screen says it the same way.
    assert kiosk_control.list_commands(w.db, w.kiosk.id)[0]["detail"] == EMPTY_TEXT
    state = K.summary(w)["tillZRequest"]
    assert state["state"] == "failed" and state["message"] == f"ה-Z לא הופק: {EMPTY_TEXT}"


def test_a_z_made_marks_the_command_applied_with_its_number(w):
    K.make_independent(w)
    shift = K.open_shift(w)
    out, _ = K.dashboard_command(w, "till_z")
    K.accept_close(w, shift)  # one document in it

    answer = K.ask_z(w, out["requestId"])

    assert answer["zReport"]["machineSequenceNumber"] == 1
    row = _command(w)
    assert (row.status, row.detail) == ("applied", "Z מס׳ 1 הופק")


def test_a_row_stuck_before_the_fix_is_settled_on_the_next_read(w):
    """The dev DB's two rows: the request failed through the kiosk's ack, the command never moved."""
    K.make_independent(w)
    K.open_shift(w)
    K.dashboard_command(w, "till_z")
    req = w.db.query(TillZRequest).one()
    # As before this fix: the request ended, the command row was left behind.
    req.status, req.error_code, req.error_message = "failed", "http_409", "empty_z"
    w.db.commit()
    assert _command(w).status == "requested"

    listed = K.R.get_kiosk_commands(
        machine_id=w.kiosk.id, limit=20, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )

    assert (listed[0]["status"], listed[0]["detail"]) == ("refused", EMPTY_TEXT)
    w.db.rollback()  # committed by the read itself
    assert _command(w).status == "refused"


def test_nothing_to_report_and_expiry_are_refusals_too(w):
    K.make_independent(w)
    K.dashboard_command(w, "till_z")
    req = w.db.query(TillZRequest).one()
    # No shift waits for a Z at all: answered, no Z.
    status_code, body = _ask_raw(w, req.id)
    assert (status_code, body["detail"]) == (409, "nothing_to_report")
    assert (_command(w).status, _command(w).detail) == ("refused", KZ.FAILURE_TEXTS["nothing_to_report"])
    # A request nobody answered in time.
    K.open_shift(w)
    K.dashboard_command(w, "till_z")
    pending = w.db.query(TillZRequest).filter(TillZRequest.status == "waiting").one()
    pending.expires_at = pending.created_at - timedelta(minutes=1)
    w.db.commit()
    till_z.expire_overdue(w.db)
    assert (_command(w).status, _command(w).detail) == ("refused", "הקיוסק לא ענה בזמן — הבקשה פגה")


def test_a_close_shift_command_is_applied_when_the_close_is_accepted_and_refused_when_it_fails(w):
    shift = K.open_shift(w)
    out, code = K.dashboard_command(w, "close_shift")
    assert code == 201
    row = w.db.query(KioskCommand).filter(KioskCommand.action == "close_shift").one()
    assert row.status == "requested"
    K.accept_close(w, shift, request_id=out["requestId"])
    w.db.refresh(row)
    assert (row.status, row.detail) == ("applied", "המשמרת נסגרה")
    # And one the kiosk could not do.
    K.open_shift(w, 2)
    out, _ = K.dashboard_command(w, "close_shift")
    K.ack_close(w, out["requestId"], "failed", "open_tables")
    w.db.commit()
    failed = w.db.query(KioskCommand).filter(KioskCommand.request_id == uuid.UUID(out["requestId"])).one()
    assert (failed.status, failed.detail) == ("refused", "יש שולחנות פתוחים בקיוסק")


def test_an_older_apps_http_409_ack_reads_as_the_clouds_reason():
    class Req:
        status, error_code, error_message, z_report_id = "failed", "http_409", "empty_z", None

    assert KZ.command_outcome("till_z", Req()) == ("refused", EMPTY_TEXT)
    Req.error_code, Req.error_message = "http_500", "boom"
    assert KZ.command_outcome("till_z", Req()) == ("refused", "boom")
    Req.status = "in_progress"
    assert KZ.command_outcome("till_z", Req()) is None


# ── Empty shifts never block a switch ────────────────────────────────────────


@pytest.fixture
def t(monkeypatch):
    """tests/test_till_z.py's world: every till in the shop Z but "Till 1" (its own Z)."""
    from datetime import datetime, timezone

    from app.services import ably_notify
    from shift_world import accept_str_uuids, make_world

    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_till_z_notify", lambda *a, **k: None)
    world.now = datetime.now(timezone.utc)
    for till in world.tills + [world.other_till]:
        till.last_heartbeat_at = world.now - timedelta(seconds=10)
        till.z_mode = "cloud"
    world.till = world.tills[0]
    world.till.z_mode = "till"
    world.db.commit()
    return world


def _empty(t, till, seq, business_date=T.TODAY):
    return T.closed_shift(t, till, seq, (), business_date=business_date)


class TestSwitchOverEmptyShifts:
    def test_only_empty_shifts_waiting_switch_independent_to_the_shop_z_and_ride_along(self, t):
        till = t.tills[1]
        IT.check_switch(t.db, t.admin, till, True)
        IT.set_independent(t.db, till, True)
        t.db.commit()
        # The Royal kiosk: shifts closed for remote Zs the cloud refused as empty.
        empties = [_empty(t, till, n) for n in (1, 2, 3, 4)]
        t.db.commit()
        assert till_z.unreported_closed_count(t.db, till.id) == 4

        IT.check_switch(t.db, t.admin, till, False)
        assert IT.set_independent(t.db, till, False)
        t.db.commit()

        assert (till.independent_till, till.z_mode) == (False, "cloud")
        entry = till.z_mode_history[-1]
        assert (entry["from"], entry["to"]) == ("till", "cloud")
        assert entry["emptyShiftsCarried"] == [str(s.id) for s in empties]
        # No Z was made for them, no number drawn.
        assert t.db.query(ZReport).filter(ZReport.machine_id == till.id).count() == 0
        # The shop's next Z takes them along with the first real shift: no gap in the run.
        T.closed_shift(t, till, 5, [dict(total="10.00")])
        run = T.cloud_run(t, till)
        z = t.db.get(ZReport, run.z_report_id)
        assert (z.shift_count, z.shop_sequence_number, z.total_sales) == (5, 1, 10)

    def test_empty_and_real_shifts_mixed_are_still_refused(self, t):
        till = t.tills[1]
        _empty(t, till, 1)
        T.closed_shift(t, till, 2, [dict(total="10.00")])
        t.db.commit()
        with pytest.raises(IT.IndependentSwitchRefused) as e:
            IT.check_switch(t.db, t.admin, till, True)
        assert (e.value.body["detail"], e.value.body["count"]) == ("independent_switch_unreported_shifts", 2)
        out = T.put_mode(t, till, "till")
        assert (out.status_code, json.loads(out.body)) == (409, {"detail": "unreported_shifts", "count": 2})

    def test_documents_still_on_the_till_keep_the_block(self, t):
        till = t.tills[1]
        _empty(t, till, 1)
        till.pending_documents = 2
        t.db.commit()
        out = T.put_mode(t, till, "till")
        assert (out.status_code, json.loads(out.body)) == (409, {"detail": "unreported_shifts", "count": 1})

    def test_into_its_own_z_the_first_z_files_under_the_day_it_began(self, t):
        till = t.tills[1]
        old_day = T.TODAY - timedelta(days=3)
        carried = _empty(t, till, 1, business_date=old_day)
        t.db.commit()

        assert T.put_mode(t, till, "till").z_mode == "till"
        assert till.z_mode_history[-1]["emptyShiftsCarried"] == [str(carried.id)]
        first = T.closed_shift(t, till, 2, [dict(total="10.00")])
        body = T.created(t, till)

        z = t.db.get(ZReport, uuid.UUID(body["zReport"]["id"]))
        assert z.machine_sequence_number == 1
        assert z.shift_count == 2  # the empty one rides along: no gap
        assert z.business_date == first.business_date != old_day

    def test_an_empty_shift_alone_is_still_no_z(self, t):
        """The switch carries them; it never makes them a Z of their own."""
        till = t.tills[1]
        _empty(t, till, 1)
        t.db.commit()
        assert T.put_mode(t, till, "till").z_mode == "till"
        code, body, _cid = T.ask(t, till)
        assert (code, body["detail"]) == (409, "empty_z")
        assert t.db.query(ZReport).filter(ZReport.machine_id == till.id).count() == 0
