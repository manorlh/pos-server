"""
"ביטול שולחן מהדשבורד" in the LAN mode: a command to the tables host (app/services/remote_table_cancel.py,
P:/specs/remote-table-cancel.md — the owner's "אפשרות 2").

What each test pins, and how it could look fine while doing damage:

* **The command** — the dashboard's cancel of a LAN host's order is a `cancel_table` command for the
  shop's CURRENT host, with the contract's params (the order's version, the void seed the cloud would
  use); the cloud itself cancels nothing and prints nothing. A direct cancel here would leave the table
  open on the host's floor while the kitchen stopped cooking.
* **Its answer** — done (voided printers, KDS), each refusal with its reason; `not_host` goes on to
  the current host once — never a loop, never to the host that refused.
* **The timeout** — past `remoteCancelTimeoutSeconds` it is expired: a late pull never gets it, the
  dashboard says "timeout", and still nothing was cancelled here — even for a host that is silent
  (it may serve its LAN without internet).
* **blocked** — the setting, or a host build that never said `remote_table_cancel_v1`: refused, and the
  live view shows no cancel.
* **hostless** — no host serves the copy: the direct cancel, as in the cloud mode.

Runs on the world of tests/test_table_void_tickets.py (SQLite).
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi import BackgroundTasks, Response

from app.database import Base
from app.models.device_command import DeviceCommand
from app.models.tables import TableOrder
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import device_commands as DCR
from app.routers import tables as TR
from app.schemas.tables import DashboardCancelIn
from app.services import device_commands as DC
from app.services import remote_table_cancel as RTC
from app.services import table_void_tickets as VT
from app.services import tables as T
from app.services import till_parameters as TP
from test_kitchen_printers import _run, k, refused, w  # noqa: F401 - fixtures
from test_table_void_tickets import (
    LAN,
    floor,
    heard,
    jobs_of,
    live,
    order_on,
    reason,
    sent,
    set_param,
)


def _tables(db):
    for name in ("device_commands", "device_remote_states"):
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())


def host_on(k, till):
    """`tablesHostTill` on `till` alone."""
    parameter = k.db.query(TillParameter).filter(TillParameter.key == "tablesHostTill").one_or_none()
    if parameter is not None:
        k.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).delete(
            synchronize_session=False,
        )
        k.db.commit()
    set_param(k, "tablesHostTill", "machine", till.id, True)
    assert T.tables_host_of_shop(k.db, k.shop.id).id == till.id


@pytest.fixture
def lan(k, monkeypatch):
    """The LAN mode, till 1 the tables host, its build taking `cancel_table`; an open order on table 12."""
    v = floor(k, monkeypatch)
    _tables(v.db)
    set_param(v, "tablesMode", "shop", v.shop.id, LAN)
    host_on(v, v.t1)
    v.t1.capabilities = [RTC.CAPABILITY]
    v.t2.capabilities = [RTC.CAPABILITY]
    v.db.commit()
    v.order = order_on(v, sent(("l1", v.steak, 2)), source="local")
    return v


def cancel(k, **shown):
    tasks, response = BackgroundTasks(), Response()
    out = TR.dashboard_cancel_table(
        k.table.id, DashboardCancelIn(reasonId=reason(k).id, **shown), tasks,
        current_user=k.admin, active_tenant_id=k.tenant.id, db=k.db, response=response,
    )
    _run(tasks)
    return out, response.status_code


def command(k, ident) -> DeviceCommand:
    k.db.expire_all()
    return k.db.get(DeviceCommand, uuid.UUID(str(ident)))


def status(k, ident, user=None):
    return DCR.get_command(uuid.UUID(str(ident)), current_user=user or k.admin, active_tenant_id=k.tenant.id, db=k.db)


def pull(k, till):
    return DCR.till_pull(str(till.id), machine=till, db=k.db)["commands"]


def answer(k, till, ident, status_, detail=None, result=None):
    return DCR.till_ack(
        str(till.id), str(ident), DCR.AckIn(status=status_, detail=detail, result=result), machine=till, db=k.db,
    )


def assert_nothing_cancelled_here(k):
    k.db.expire_all()
    assert k.db.get(TableOrder, k.order.id).status == "open"
    assert jobs_of(k) == []


# ── The command ───────────────────────────────────────────────────────────────


def test_the_cancel_is_a_command_for_the_current_host(lan):
    out, code = cancel(lan)
    assert code == 202 and out["mode"] == "via_till" and out["timeoutSeconds"] == 20
    row = command(lan, out["commandId"])
    assert (row.action, row.machine_id, row.status) == ("cancel_table", lan.t1.id, "pending")
    assert row.params == {
        "orderId": str(lan.order.id),
        "tableId": str(lan.table.id),
        "tableLabel": "12",
        "orderVersion": 3,
        "reason": "לקוח עזב",
        "reasonId": str(reason(lan).id),
        "reasonText": None,
        "requestedBy": {"userId": str(lan.admin.id), "name": "admin"},
        "voidJobKey": VT.cancel_seed(lan.order.id),
    }
    assert DC._aware(row.expires_at) - DC._aware(row.created_at) == timedelta(seconds=20)
    # The host is woken, and finds it on its pull; the cloud cancelled and printed nothing.
    assert (str(lan.t1.id), DC.NOTIFY_EVENT) in lan.jobs_notified
    assert [(c["action"], c["params"]["orderId"]) for c in pull(lan, lan.t1)] == [("cancel_table", str(lan.order.id))]
    assert_nothing_cancelled_here(lan)
    assert status(lan, out["commandId"])["outcome"] == "waiting"


def test_a_second_click_is_the_same_command(lan):
    first, _ = cancel(lan)
    again, code = cancel(lan)
    assert code == 202 and again["commandId"] == first["commandId"]
    assert lan.db.query(DeviceCommand).filter(DeviceCommand.action == "cancel_table").count() == 1


def test_the_host_moved_the_command_goes_to_the_new_one(lan):
    host_on(lan, lan.t2)
    out, _ = cancel(lan)
    assert command(lan, out["commandId"]).machine_id == lan.t2.id


def test_a_silent_host_still_gets_the_command_and_nothing_is_cancelled_here(lan):
    """A host without internet may still serve its LAN: never a direct cancel while a host exists."""
    heard(lan.t1, timedelta(hours=2))
    lan.db.commit()
    out, code = cancel(lan)
    assert code == 202 and command(lan, out["commandId"]).machine_id == lan.t1.id
    assert_nothing_cancelled_here(lan)


def test_the_order_the_dashboard_showed_must_be_the_one_open(lan):
    e = refused(cancel, lan, expectedVersion=2)
    assert e.status_code == 409 and e.detail["code"] == "order_changed"
    e = refused(cancel, lan, orderId=uuid.uuid4())
    assert e.detail["code"] == "order_changed"
    out, code = cancel(lan, orderId=lan.order.id, expectedVersion=3)
    assert code == 202


def test_the_timeout_comes_from_the_hosts_levels(lan):
    set_param(lan, TP.REMOTE_CANCEL_TIMEOUT_KEY, "shop", lan.shop.id, 45)
    out, _ = cancel(lan)
    row = command(lan, out["commandId"])
    assert out["timeoutSeconds"] == 45
    assert DC._aware(row.expires_at) - DC._aware(row.created_at) == timedelta(seconds=45)
    with pytest.raises(TP.TillParameterValueError):
        TP.validate_keyed_value(TP.REMOTE_CANCEL_TIMEOUT_KEY, 3)
    with pytest.raises(TP.TillParameterValueError):
        TP.validate_keyed_value(TP.DASHBOARD_TABLE_CANCEL_KEY, "direct")


# ── The answer ────────────────────────────────────────────────────────────────


def test_done_with_the_voided_printers_and_the_kds(lan):
    out, _ = cancel(lan)
    pull(lan, lan.t1)
    answer(lan, lan.t1, out["commandId"], "done", result={"voidedPrinters": ["Kitchen"], "kds": True})
    seen = status(lan, out["commandId"])
    assert (seen["outcome"], seen["voidedPrinters"], seen["kds"], seen["retargeted"]) == ("done", ["Kitchen"], True, False)


@pytest.mark.parametrize("why", ["table_not_open", "payment_in_progress", "order_changed"])
@pytest.mark.parametrize("as_result", [False, True])
def test_each_refusal_with_its_reason(lan, why, as_result):
    out, _ = cancel(lan)
    pull(lan, lan.t1)
    if as_result:
        answer(lan, lan.t1, out["commandId"], "refused", result={"reason": why})
    else:
        answer(lan, lan.t1, out["commandId"], "refused", detail=why)
    seen = status(lan, out["commandId"])
    assert (seen["outcome"], seen["reason"]) == ("refused", why)
    # Nothing goes on for these: one command.
    assert lan.db.query(DeviceCommand).filter(DeviceCommand.action == "cancel_table").count() == 1
    assert_nothing_cancelled_here(lan)


def test_not_host_goes_on_to_the_current_host_once(lan):
    out, _ = cancel(lan)
    pull(lan, lan.t1)
    # Till 1 is no longer the host (the server moved): it says so; the cloud sends it to till 2.
    host_on(lan, lan.t2)
    answer(lan, lan.t1, out["commandId"], "refused", detail="not_host")
    seen = status(lan, out["commandId"])
    assert (seen["outcome"], seen["retargeted"]) == ("waiting", True)
    onward = command(lan, seen["currentId"])
    assert onward.machine_id == lan.t2.id and onward.params["retargetOf"] == out["commandId"]
    assert onward.params["voidJobKey"] == VT.cancel_seed(lan.order.id)
    assert (str(lan.t2.id), DC.NOTIFY_EVENT) in lan.jobs_notified
    # Till 2 says the same: no third host — the refusal stands.
    pull(lan, lan.t2)
    host_on(lan, lan.t1)
    answer(lan, lan.t2, onward.id, "refused", detail="not_host")
    seen = status(lan, out["commandId"])
    assert (seen["outcome"], seen["reason"]) == ("refused", "not_host")
    assert lan.db.query(DeviceCommand).filter(DeviceCommand.action == "cancel_table").count() == 2
    assert_nothing_cancelled_here(lan)


def test_not_host_from_the_host_itself_is_final(lan):
    out, _ = cancel(lan)
    answer(lan, lan.t1, out["commandId"], "refused", detail="not_host")
    seen = status(lan, out["commandId"])
    assert (seen["outcome"], seen["reason"], seen["retargeted"]) == ("refused", "not_host", False)


# ── The timeout ───────────────────────────────────────────────────────────────


def _age(k, ident, seconds):
    row = command(k, ident)
    for field in ("created_at", "expires_at"):
        setattr(row, field, DC._aware(getattr(row, field)) - timedelta(seconds=seconds))
    if row.delivered_at is not None:
        row.delivered_at = DC._aware(row.delivered_at) - timedelta(seconds=seconds)
    k.db.commit()


def test_not_picked_up_in_time_it_expires_and_a_late_pull_never_gets_it(lan):
    out, _ = cancel(lan)
    _age(lan, out["commandId"], 21)
    assert status(lan, out["commandId"])["outcome"] == "timeout"
    # The host comes back: nothing to do.
    assert pull(lan, lan.t1) == []
    assert command(lan, out["commandId"]).status == "expired"
    assert_nothing_cancelled_here(lan)


def test_taken_but_not_answered_in_time_it_times_out_and_a_late_done_still_counts(lan):
    out, _ = cancel(lan)
    pull(lan, lan.t1)
    _age(lan, out["commandId"], 21)
    assert status(lan, out["commandId"])["outcome"] == "timeout"
    DC.expire_old(lan.db)
    lan.db.commit()
    row = command(lan, out["commandId"])
    assert (row.status, row.detail) == ("expired", "not_answered")
    # The host did cancel it, just after: what happened is shown.
    answer(lan, lan.t1, out["commandId"], "done", result={"voidedPrinters": [], "kds": False})
    assert status(lan, out["commandId"])["outcome"] == "done"


# ── blocked ───────────────────────────────────────────────────────────────────


def test_blocked_by_the_setting_at_the_company(lan):
    set_param(lan, TP.DASHBOARD_TABLE_CANCEL_KEY, "company", lan.shop.company_id, TP.DASHBOARD_TABLE_CANCEL_BLOCKED)
    e = refused(cancel, lan)
    assert e.status_code == 409 and e.detail["code"] == "remote_cancel_blocked" and e.detail["why"] == "setting"
    row = next(t for t in live(lan)["tables"] if t["number"] == 12)
    assert row["cancel"]["mode"] == "blocked"
    assert lan.db.query(DeviceCommand).count() == 0
    assert_nothing_cancelled_here(lan)


def test_a_host_build_that_cannot_is_blocked(lan):
    lan.t1.capabilities = ["remote_close_v2"]
    lan.db.commit()
    e = refused(cancel, lan)
    assert e.detail["code"] == "remote_cancel_blocked" and e.detail["why"] == "no_capability"
    assert lan.db.query(DeviceCommand).count() == 0
    # Said through the device-logs record of the beat counts too.
    lan.t1.reported_capabilities = {"list": [RTC.CAPABILITY], "appVersion": None, "at": None}
    lan.db.commit()
    assert cancel(lan)[1] == 202


# ── hostless, the live view, the reader ───────────────────────────────────────


def test_hostless_is_the_direct_cancel(k, monkeypatch):
    v = floor(k, monkeypatch, print_host=False)
    _tables(v.db)
    set_param(v, "tablesMode", "shop", v.shop.id, LAN)
    assert T.tables_host_of_shop(v.db, v.shop.id) is None
    v.order = order_on(v, sent(("l1", v.steak, 2)), source="local")
    out, code = cancel(v)
    assert code == 200 and out["mode"] == "direct" and out["status"] == "cancelled"
    assert len(jobs_of(v)) == 1 and v.db.query(DeviceCommand).count() == 0


def test_the_live_view_says_how_each_order_is_cancelled(lan):
    rows = {t["number"]: t for t in live(lan)["tables"]}
    assert rows[12]["cancel"] == {"mode": "via_till", "why": None, "hostName": rows[12]["cancel"]["hostName"], "timeoutSeconds": 20}
    assert rows[12]["cancel"]["hostName"]
    # The cloud's own tables: direct.
    lan.order.source = "synced"
    lan.db.commit()
    rows = {t["number"]: t for t in live(lan)["tables"]}
    assert rows[12]["cancel"]["mode"] == "direct"


def test_only_the_shops_tables_readers_follow_it(lan):
    out, _ = cancel(lan)
    e = refused(status, lan, out["commandId"], user=lan.north_manager)
    assert e.status_code in (403, 404)
    assert status(lan, out["commandId"], user=lan.manager)["outcome"] == "waiting"
