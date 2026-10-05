"""
"מדפסת חלופית" — asking the employee for another printer when one is not available.

* **The parameter** — `printerFailoverPrompt`, a built-in boolean, on by default, edited on
  the printers page (shop → point of sale → till) and resolved for every till.
* **The log** — the till's record of a redirect is kept once (idempotent by its id, which
  no other till may take); a printer of another shop is not linked, its name is kept.
* **The printers page** — the last days' redirects, newest first, with the till's name;
  only the shop's managers read them.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks

from app.models.printers import KitchenPrintRedirect
from app.routers import print_redirects as RR
from app.routers import printers as R
from app.schemas.kitchen_printers import KitchenOptionsIn, PrinterIn
from app.schemas.printer_discovery import PrintRedirectIn
from app.services import printers as K
from app.services.till_parameters import ensure_builtin_parameters, managed_on, till_parameters_for_machine
from test_shop_areas import _ctx, refused, w  # noqa: F401

KEY = "printerFailoverPrompt"


def printer(w, shop=None, **over):
    base = {"name": "P", "connectionType": "network", "host": "192.168.1.50"}
    base.update(over)
    return R.create_printer((shop or w.shop).id, PrinterIn.model_validate(base), BackgroundTasks(), **_ctx(w))["id"]


def log(w, till, **over):
    body = {"id": str(uuid.uuid4()), "kind": "kitchen", "fromName": "בר", "toName": "מטבח", "ticket": "שולחן 12"}
    body.update(over)
    return RR.post_print_redirect(str(till.id), PrintRedirectIn.model_validate(body), machine=till, db=w.db)


def listed(w, user=None, days=7):
    return RR.get_print_redirects(w.shop.id, days=days, **_ctx(w, user))["redirects"]


class TestParameter:
    def test_on_by_default_for_every_till(self, w):
        ensure_builtin_parameters(w.db)
        for till in w.tills:
            assert till_parameters_for_machine(w.db, till).parameters.get(KEY) is True

    def test_edited_on_the_printers_page(self, w):
        assert managed_on(KEY) == "printers"
        options = K.options_out(w.db, w.shop)
        definition = next(p for p in options["parameters"] if p["key"] == KEY)
        assert definition["valueType"] == "boolean" and definition["defaultValue"] is True
        assert definition["label"] == "שאלה על מדפסת חלופית כשמדפסת לא זמינה"

    def test_turned_off_for_one_till(self, w):
        tasks = BackgroundTasks()
        R.put_options(
            w.shop.id, KitchenOptionsIn(scopeType="machine", scopeId=w.tills[0].id, values={KEY: False}),
            tasks, **_ctx(w),
        )
        assert till_parameters_for_machine(w.db, w.tills[0]).parameters.get(KEY) is False
        assert till_parameters_for_machine(w.db, w.tills[1]).parameters.get(KEY) is True


class TestLog:
    def test_kept_once(self, w):
        bar = printer(w, name="בר")
        kitchen = printer(w, name="מטבח", host="192.168.1.51")
        rid = str(uuid.uuid4())
        until = datetime.now(timezone.utc) + timedelta(minutes=15)
        out = log(w, w.tills[0], id=rid, fromPrinterId=bar, toPrinterId=kitchen, temporaryUntil=until.isoformat(),
                  error="192.168.1.50:9100 — refused", posUserName="דנה")
        assert (out["fromPrinterId"], out["toPrinterId"], out["machineName"]) == (bar, kitchen, "1 · Till 1")
        assert out["temporaryUntil"] is not None
        log(w, w.tills[0], id=rid)
        assert w.db.query(KitchenPrintRedirect).count() == 1

    def test_another_tills_id_is_refused(self, w):
        rid = str(uuid.uuid4())
        log(w, w.tills[0], id=rid)
        e = refused(log, w, w.tills[1], id=rid)
        assert (e.status_code, e.detail) == (409, "print_redirect_id_taken")

    def test_a_printer_of_another_shop_is_not_linked(self, w):
        far = printer(w, shop=w.other_shop, name="צפון")
        out = log(w, w.tills[0], fromPrinterId=far, fromName=None)
        assert out["fromPrinterId"] is None and out["fromName"] is None
        out = log(w, w.tills[0], toPrinterId=None, toName="המדפסת של הקופה", kind="receipt")
        assert (out["kind"], out["toName"]) == ("receipt", "המדפסת של הקופה")


class TestPrintersPage:
    def test_the_last_days_newest_first(self, w):
        old = log(w, w.tills[0], ticket="ישן")
        w.db.get(KitchenPrintRedirect, uuid.UUID(old["id"])).created_at = datetime.now(timezone.utc) - timedelta(days=10)
        w.db.commit()
        log(w, w.tills[0], ticket="ראשון")
        log(w, w.tills[1], ticket="שני")
        log(w, w.other_till, ticket="סניף אחר")
        rows = listed(w)
        assert {r["ticket"] for r in rows} == {"ראשון", "שני"}
        assert [r["ticket"] for r in listed(w, days=30)][-1] == "ישן"

    def test_only_the_shops_managers(self, w):
        assert refused(listed, w, w.cashier).status_code == 403
        assert refused(listed, w, w.north_manager).status_code == 403
        assert listed(w, w.manager) == []

    def test_names_are_trimmed(self):
        body = PrintRedirectIn.model_validate({"id": str(uuid.uuid4()), "fromName": "  בר   ראשי ", "ticket": "x" * 300})
        assert body.from_name == "בר ראשי" and len(body.ticket) == 200
        with pytest.raises(Exception):
            PrintRedirectIn.model_validate({"id": str(uuid.uuid4()), "kind": "label"})
