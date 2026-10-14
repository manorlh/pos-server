"""
"הדפס חשבון" from the dashboard's open tables on another till (P:/specs/bill-print-other-till.md §7; the
command contract: P:/specs/live-tables-cloud.md §6.2 `printOn`; app/services/table_actions.py).

What each test pins, and how it could look fine while doing damage:

* **The choice** — the tills offered besides the one that holds the table: those of the shop with a printer,
  within the holder's `remotePrintHosts`; one whose build does not print documents is listed, not offered
  ("נדרש עדכון גרסה"); nothing when the holder's `remotePrintFromDashboard` / `remotePrintEnabled` is off or
  its own build cannot relay.
* **The command** — always for the till that holds the table (it reckons the bill), never for the till that
  prints it; `printOn` and how to reach that till (its name, paper, LAN address) in the params; the cloud
  refuses a till it would not offer. A receipt printer of another till chosen as a printer carries
  `printOn` the same way.
* **The answer** — `printed`, `via`, `jobId`, `fallback`, `printOn` are kept; "print_target_unavailable" is a
  refusal of the contract.

Runs on the world of tests/test_table_actions.py (SQLite).
"""
from __future__ import annotations

import uuid

from app.models.device_command import DeviceCommand
from app.models.printers import KitchenPrinter, KitchenPrintHost
from app.routers import tables as TR
from app.services import device_commands as DC
from app.services import remote_print as RP
from app.services import table_actions as TA
from test_table_actions import (  # noqa: F401 - fixtures
    _tables,
    act_on,
    answer,
    c,
    f,
    follow,
    k,
    lan,
    put_param,
    refused_by,
    w,
)


def choices(w):
    return TR.get_bill_printers(w.table.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


def relay(*tills):
    for till in tills:
        till.capabilities = list(dict.fromkeys([*(till.capabilities or []), RP.CAPABILITY]))


def command(w, out) -> DeviceCommand:
    return w.db.get(DeviceCommand, uuid.UUID(out["commandId"]))


def test_the_tills_offered_besides_the_one_that_holds_the_table(lan):
    # The host's build cannot relay yet: nothing to choose, and why.
    info = choices(lan)["remotePrint"]
    assert (info["ownerMachineId"], info["available"], info["why"], info["targets"]) == (
        str(lan.t1.id), False, "owner_needs_update", [],
    )
    relay(lan.t1)
    lan.db.commit()
    info = choices(lan)["remotePrint"]
    assert info["available"] is True and info["why"] is None
    # Till 2 has a printer (its own head) but an older build: shown, not offered.
    assert info["targets"] == [{
        "machineId": str(lan.t2.id), "tillName": "2 · Till 2", "label": "קופה 2", "paperWidth": 58,
        "available": False, "why": "needs_update",
    }]
    relay(lan.t2)
    lan.db.commit()
    assert choices(lan)["remotePrint"]["targets"][0]["available"] is True
    # The printers of §6.4 are as they were.
    assert [c["printerId"] for c in choices(lan)["printers"]] == [None]


def test_the_holders_parameters_decide(lan):
    relay(lan.t1, lan.t2)
    lan.db.commit()
    put_param(lan, RP.FROM_DASHBOARD_KEY, "machine", lan.t1.id, False)
    assert choices(lan)["remotePrint"]["why"] == "off"
    e = refused_by(lan, "print-bill", printOn=lan.t2.id)
    assert (e.status_code, e.detail["code"], e.detail["why"]) == (409, "remote_print_off", "off")
    put_param(lan, RP.FROM_DASHBOARD_KEY, "machine", lan.t1.id, True)
    put_param(lan, RP.ENABLED_KEY, "shop", lan.shop.id, False)
    assert choices(lan)["remotePrint"]["why"] == "off"
    put_param(lan, RP.ENABLED_KEY, "shop", lan.shop.id, True)
    # Its hosts: another till only — till 2 is not offered, and not taken.
    put_param(lan, RP.HOSTS_KEY, "machine", lan.t1.id, str(uuid.uuid4()))
    assert choices(lan)["remotePrint"]["targets"] == []
    assert refused_by(lan, "print-bill", printOn=lan.t2.id).detail["code"] == "print_target_not_found"
    put_param(lan, RP.HOSTS_KEY, "machine", lan.t1.id, f"{lan.t2.id}")
    assert [t["machineId"] for t in choices(lan)["remotePrint"]["targets"]] == [str(lan.t2.id)]


def test_the_command_goes_to_the_holder_with_print_on(lan):
    relay(lan.t1, lan.t2)
    lan.db.add(KitchenPrintHost(machine_id=lan.t2.id, shop_id=lan.shop.id, lan_address="192.168.1.22", port=8399))
    lan.db.commit()
    request = uuid.uuid4()
    out, code = act_on(lan, "print-bill", printOn=lan.t2.id, requestId=request)
    assert code == 202 and out["hostMachineId"] == str(lan.t1.id) and out["printOnName"] == "קופה 2"
    row = command(lan, out)
    assert (row.action, row.machine_id) == ("table_print_bill", lan.t1.id)
    assert row.params == {
        "orderId": str(lan.order.id), "tableId": str(lan.table.id), "tableLabel": "12", "orderVersion": 3,
        "requestId": str(request), "requestedBy": {"userId": str(lan.admin.id), "name": "admin"}, "mode": "lan",
        "printerId": None, "printerName": None,
        "printOn": str(lan.t2.id), "printOnName": "קופה 2", "printOnPaperWidth": 58,
        "printOnLan": {"address": "192.168.1.22", "port": 8399},
    }
    # The same click again is the same command.
    again, _ = act_on(lan, "print-bill", printOn=lan.t2.id, requestId=request)
    assert again["commandId"] == out["commandId"]
    # The holder printed it there (through the cloud): the answer keeps what the contract names.
    answer(lan, lan.t1, out["commandId"], "done", result={
        "printerName": None, "marked": True, "printOn": str(lan.t2.id), "via": "cloud", "jobId": "j-1",
        "printed": True, "junk": 1,
    })
    seen = follow(lan, out["commandId"])
    assert seen["outcome"] == "done" and seen["printOnName"] == "קופה 2"
    assert seen["result"] == {"marked": True, "printOn": str(lan.t2.id), "via": "cloud", "jobId": "j-1", "printed": True}


def test_a_till_the_cloud_would_not_offer_is_refused(lan):
    relay(lan.t1)
    lan.db.commit()
    e = refused_by(lan, "print-bill", printOn=lan.t2.id)
    assert (e.detail["code"], e.detail["till"]) == ("print_target_needs_update", "קופה 2")
    assert refused_by(lan, "print-bill", printOn=uuid.uuid4()).detail["code"] == "print_target_not_found"
    assert refused_by(lan, "print-bill", printOn=lan.t1.id).detail["code"] == "print_target_not_found"
    assert lan.db.query(DeviceCommand).count() == 0


def test_a_till_without_a_printer_is_not_offered(lan):
    relay(lan.t1, lan.t2)
    lan.t2.device_model = "P18"
    lan.db.commit()
    assert choices(lan)["remotePrint"]["targets"] == []
    # Unless it hosts a receipt printer of another till ("המדפסת של קופה 2", on its USB).
    lan.db.add(KitchenPrinter(
        id=uuid.uuid4(), tenant_id=lan.tenant.id, shop_id=lan.shop.id, name="המדפסת של קופה 2", purpose="receipt",
        connection_type="cloud", host_machine_id=lan.t2.id, host_connection="usb", paper_width=80,
    ))
    lan.db.commit()
    [target] = choices(lan)["remotePrint"]["targets"]
    assert (target["machineId"], target["paperWidth"]) == (str(lan.t2.id), 80)


def test_a_receipt_printer_of_another_till_chosen_carries_print_on(lan):
    relay(lan.t1, lan.t2)
    receipt = KitchenPrinter(
        id=uuid.uuid4(), tenant_id=lan.tenant.id, shop_id=lan.shop.id, name="המדפסת של קופה 2", purpose="receipt",
        connection_type="cloud", host_machine_id=lan.t2.id, host_connection="till", paper_width=58,
    )
    lan.db.add(receipt)
    lan.db.commit()
    assert str(receipt.id) in [c["printerId"] for c in choices(lan)["printers"]]
    out, code = act_on(lan, "print-bill", printerId=receipt.id)
    row = command(lan, out)
    assert code == 202 and row.machine_id == lan.t1.id
    assert (row.params["printerId"], row.params["printOn"], row.params["printOnPaperWidth"]) == (
        str(receipt.id), str(lan.t2.id), 58,
    )
    assert row.params["printOnLan"] is None  # no LAN address heard: the cloud relay


def test_the_cloud_tables_send_it_to_the_till_that_worked_the_table(c):
    _tables(c.db)
    c.t1.capabilities = [TA.CAPABILITY, RP.CAPABILITY]
    relay(c.t2)
    c.db.commit()
    info = choices(c)["remotePrint"]
    assert info["ownerMachineId"] == str(c.t1.id) and [t["machineId"] for t in info["targets"]] == [str(c.t2.id)]
    out, code = act_on(c, "print-bill", printOn=c.t2.id)
    row = command(c, out)
    assert code == 202 and row.machine_id == c.t1.id
    assert (row.params["mode"], row.params["printOn"], row.params["printerId"]) == ("cloud", str(c.t2.id), None)
    # The till that worked it cannot take the command: no holder, nothing to choose.
    c.t1.capabilities = [RP.CAPABILITY]
    c.db.commit()
    assert choices(c)["remotePrint"]["why"] == "no_owner"
    assert refused_by(c, "print-bill", printOn=c.t2.id).detail["code"] == "remote_action_blocked"


def test_the_refusal_is_the_contracts():
    assert "print_target_unavailable" in TA.REFUSALS and "print_target_unavailable" in DC.REFUSAL_REASONS
    detail, result = TA.clean_answer("table_print_bill", "refused", None, {"reason": "print_target_unavailable"})
    assert detail == "print_target_unavailable" and result == {"reason": "print_target_unavailable"}
    _, result = TA.clean_answer("table_print_bill", "done", None, {"printed": False, "fallback": "local", "marked": True})
    assert result == {"printed": False, "fallback": "local", "marked": True}
