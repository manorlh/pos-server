"""
"רוחב הדפסה" — a printer's print width in dots (kitchen_printers.print_width_dots).

* Null by default — "by the paper", as before — and one of 576 / 512 / 432 / 384 when set;
  anything else is refused. The till's own printer has none.
* It reaches the dashboard, the till's pull (and moves its ETag) and a relayed job's printer.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.routers import printers as R
from app.schemas.kitchen_printers import PrinterIn, PrintJobIn
from app.services import ably_notify
from test_shop_areas import _ctx, w  # noqa: F401


def printer_in(**over):
    base = {"name": "בר", "connectionType": "network", "host": "192.168.0.253"}
    base.update(over)
    return PrinterIn.model_validate(base)


def create(w, **over):
    return R.create_printer(w.shop.id, printer_in(**over), BackgroundTasks(), **_ctx(w))


def test_by_the_paper_unless_set():
    assert printer_in().print_width_dots is None
    assert printer_in(printWidthDots=512).print_width_dots == 512
    for bad in (500, 0, 640, "wide"):
        with pytest.raises(ValidationError):
            printer_in(printWidthDots=bad)


def test_the_tills_own_printer_has_none():
    till = printer_in(connectionType="till", host=None, printWidthDots=512)
    assert till.print_width_dots is None


def test_it_reaches_the_dashboard_the_till_and_the_relay(w, monkeypatch):
    monkeypatch.setattr(ably_notify, "publish_notify", lambda *a, **k: None)
    out = create(w, printWidthDots=512)
    assert out["printWidthDots"] == 512
    page = R.list_printers(w.shop.id, **_ctx(w))
    assert page["printers"][0]["printWidthDots"] == 512

    till = w.tills[0]
    pulled = R.get_own_printers(str(till.id), etag=None, machine=till, db=w.db)
    assert pulled["printers"][0]["printWidthDots"] == 512

    # Changed: the till's ETag moves.
    R.update_printer(uuid.UUID(out["id"]), printer_in(printWidthDots=576), BackgroundTasks(), **_ctx(w))
    again = R.get_own_printers(str(till.id), etag=pulled["etag"], machine=till, db=w.db)
    assert again["syncType"] == "full" and again["printers"][0]["printWidthDots"] == 576

    # A relayed ticket's printer carries it to the till that prints it.
    cloud = create(w, name="גן", connectionType="cloud", hostMachineId=str(w.tills[1].id),
                   hostConnection="network", host="192.168.0.254", printWidthDots=432)
    tasks = BackgroundTasks()
    R.post_print_job(
        str(till.id),
        PrintJobIn.model_validate({
            "id": str(uuid.uuid4()), "printerId": cloud["id"],
            "ticket": {"source": "sale", "createdAt": "2026-10-06T00:00:00+03:00", "lines": []},
        }),
        tasks, machine=till, db=w.db,
    )
    jobs = R.get_pending_print_jobs(str(w.tills[1].id), machine=w.tills[1], db=w.db)["jobs"]
    assert jobs[0]["printer"]["printWidthDots"] == 432


def test_existing_printers_print_as_before(w):
    out = create(w)
    assert out["printWidthDots"] is None
