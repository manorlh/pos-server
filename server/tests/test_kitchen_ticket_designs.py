"""
"עיצוב בון" in the cloud (P:/specs/kitchen-ticket-designs.md §3, §4, §6ג, §8–§10;
app/services/kitchen_ticket_designs.py, app/routers/printers.py). The look's own rules and the
shared golden: tests/test_kitchen_ticket_style.py.

* **The migration** — the table and the printer's nullable columns on the single head
  bb6205ba290c; no row is written (every printer inherits until someone picks a design).
* **The printer** — its design (a template or a named design, never both) and its own options:
  checked by the schema; an older dashboard's replace (no ticket fields) leaves them.
* **Named designs** — per company: the company's managers create / change / delete them; a shop
  manager reads them on the printers page only; a name once per company; a design in use is not
  deleted; the tills of the shops it reaches are told.
* **The till's printers config** — each kitchen printer's `ticketStyle` (classic, ink saver on, by
  default), resolved with the printer's design, the till parameters set on the till's levels and
  the printer's own options; the raw `ticket*` fields; a receipt printer has none.
* **The till parameters on the printers page** — `/shops/{id}/printer-options/ticket`, by shop →
  point of sale → till; a design must be one the shop may use.
* **The test print** — no body: the plain test page, as before; with one: the sample ticket marked
  a test, in the look the dashboard shows (saved or not), `ticketStyle` on the job.
* **The relay** keeps `openedAt` and `held`; a relayed job's printer block carries the host's look.

Runs on the world of tests/test_shop_areas.py (with tests/test_kitchen_printers.py's menu).
"""
from __future__ import annotations

import io
import logging
import os
import pathlib
import uuid

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.models.company import Company
from app.models.printers import KitchenPrinter, KitchenPrintJob, KitchenTicketDesign
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import printers as R
from app.schemas.kitchen_printers import KitchenOptionsIn, PrinterIn, PrintJobIn, TestPrintIn, TicketDesignIn
from app.services import kitchen_ticket_style as S
from app.services import printers as K
from app.services import till_parameters as TP
from test_kitchen_printers import _run, create, k, pending, printer_in, pull  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401

REVISION = "d8a3f1c6e2b7"


# ── Helpers ───────────────────────────────────────────────────────────────────


def design(w, name="בר", template="compact", overrides=None, user=None, company=None):
    tasks = BackgroundTasks()
    body = TicketDesignIn.model_validate({
        "companyId": str((company or w.company).id), "name": name, "template": template, "overrides": overrides,
    })
    out = R.create_ticket_design(body, tasks, **_ctx(w, user))
    _run(tasks)
    return out


def update_printer(w, printer_id, body, user=None):
    tasks = BackgroundTasks()
    out = R.update_printer(uuid.UUID(printer_id), PrinterIn.model_validate(body), tasks, **_ctx(w, user))
    _run(tasks)
    return out


def set_param(w, key, scope_type, scope_id, value):
    TP.ensure_builtin_parameters(w.db)
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id,
        value=TP.validate_keyed_value(key, value),
    ))
    w.db.commit()


def ticket_options(w, scope_type, scope_id, values, user=None):
    tasks = BackgroundTasks()
    body = KitchenOptionsIn.model_validate({"scopeType": scope_type, "scopeId": str(scope_id), "values": values})
    out = R.put_ticket_options(w.shop.id, body, tasks, **_ctx(w, user))
    _run(tasks)
    return out


def send_test_print(w, printer_id, body=None, user=None):
    tasks = BackgroundTasks()
    out = R.test_printer(
        uuid.UUID(printer_id), tasks, response=None, idempotency_key=None,
        body=TestPrintIn.model_validate(body) if body is not None else None, **_ctx(w, user),
    )
    _run(tasks)
    return out


def style_of(w, till, printer_id):
    return next(p for p in pull(w, till)["printers"] if p["id"] == printer_id)


# ── The migration ─────────────────────────────────────────────────────────────


def _render(*args) -> str:
    from alembic import command
    from alembic.config import Config

    here = pathlib.Path(__file__).resolve().parents[1]
    buf = io.StringIO()
    cfg = Config(os.path.join(here, "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", os.path.join(here, "alembic"))
    # env.py's fileConfig() disables every logger: put them back for the later tests' caplog.
    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    try:
        command.upgrade(cfg, *args, sql=True)
    finally:
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


class TestMigration:
    def test_on_the_single_head_on_the_release_merge(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = pathlib.Path(__file__).resolve().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert REVISION in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision(REVISION).down_revision == "bb6205ba290c"

    def test_upgrade_adds_the_table_and_the_nullable_columns_and_writes_no_row(self):
        sql = _render(f"bb6205ba290c:{REVISION}")
        assert "CREATE TABLE kitchen_ticket_designs" in sql
        assert "CREATE UNIQUE INDEX uq_kitchen_ticket_designs_company_name ON kitchen_ticket_designs (company_id, name)" in sql
        for column in (
            "ticket_design VARCHAR(24)", "ticket_design_id UUID", "ticket_font_scale INTEGER", "ticket_header JSON",
            "ticket_checkboxes BOOLEAN", "ticket_elapsed BOOLEAN", "ticket_fit VARCHAR(8)",
            "ticket_min_text_size VARCHAR(4)", "ticket_max_text_size VARCHAR(4)", "ticket_header_size VARCHAR(4)",
            "ticket_inline_mods BOOLEAN", "ticket_order VARCHAR(10)", "ticket_order_list JSON",
            "ticket_group_headers VARCHAR(4)", "ticket_no_course VARCHAR(6)",
        ):
            assert f"ALTER TABLE kitchen_printers ADD COLUMN {column}" in sql, column
        assert "ON DELETE SET NULL" in sql
        for name in ("ticket_design", "ticket_design_one", "ticket_font_scale", "ticket_text", "ticket_order"):
            assert f"ck_kitchen_printers_{name}" in sql, name
        assert "NOT NULL" not in sql.split("CREATE TABLE kitchen_ticket_designs")[1].split("ALTER TABLE kitchen_printers")[1]
        moved = sql.replace("UPDATE alembic_version", "").replace("INSERT INTO alembic_version", "")
        assert "UPDATE " not in moved and "INSERT INTO" not in moved


# ── The printer's design and options ─────────────────────────────────────────


class TestThePrinter:
    def test_the_schema_checks_the_design_and_the_options(self):
        ok = printer_in(
            ticketDesign="large", ticketFontScale=120, ticketHeader="waiter,time", ticketCheckboxes=True,
            ticketFit="wrap", ticketMinTextSize="xs", ticketMaxTextSize="l", ticketHeaderSize="s",
            ticketInlineMods=False, ticketOrder="custom", ticketGroupHeaders="off", ticketNoCourse="first",
            ticketOrderList=["course:c0000000-0000-4000-8000-000000000001"],
        )
        assert ok.ticket_header == ["table", "waiter", "time"]
        assert ok.ticket_order_list == [{"kind": "course", "id": "c0000000-0000-4000-8000-000000000001"}]
        for bad in (
            {"ticketDesign": "fancy"},
            {"ticketDesign": "large", "ticketDesignId": str(uuid.uuid4())},
            {"ticketFontScale": 79},
            {"ticketFontScale": 151},
            {"ticketHeader": ["zone"]},
            {"ticketFit": "shrink"},
            {"ticketMinTextSize": "l"},
            {"ticketMaxTextSize": "xl"},
            {"ticketHeaderSize": "xl"},
            {"ticketOrder": "price"},
            {"ticketGroupHeaders": "yes"},
            {"ticketNoCourse": "middle"},
            {"ticketOrderList": ["dish:c0000000-0000-4000-8000-000000000001"]},
        ):
            with pytest.raises(ValidationError):
                printer_in(**bad)

    def test_saved_shown_and_left_alone_by_an_older_dashboard(self, k):
        out = create(k, ticketDesign="large", ticketFontScale=110, ticketHeader=["time"], ticketElapsed=True)
        assert (out["ticketDesign"], out["ticketDesignId"], out["ticketFontScale"]) == ("large", None, 110)
        assert out["ticketHeader"] == ["table", "time"] and out["ticketElapsed"] is True
        assert out["ticketCheckboxes"] is None and out["ticketOrder"] is None
        # A replace that does not mention them (a dashboard of before) keeps them.
        again = update_printer(k, out["id"], {"name": "Kitchen 2", "connectionType": "network", "host": "192.168.1.51"})
        assert again["name"] == "Kitchen 2"
        assert (again["ticketDesign"], again["ticketFontScale"], again["ticketHeader"]) == ("large", 110, ["table", "time"])
        # null: inherit again.
        again = update_printer(k, out["id"], {
            "name": "Kitchen 2", "connectionType": "network", "host": "192.168.1.51", "ticketDesign": None,
            "ticketFontScale": None,
        })
        assert again["ticketDesign"] is None and again["ticketFontScale"] is None and again["ticketElapsed"] is True

    def test_a_named_design_and_a_template_replace_each_other(self, k):
        d = design(k)
        out = create(k, ticketDesignId=d["id"])
        assert out["ticketDesignId"] == d["id"] and out["ticketDesign"] is None
        base = {"name": "Kitchen", "connectionType": "network", "host": "192.168.1.50"}
        out = update_printer(k, out["id"], {**base, "ticketDesign": "modern"})
        assert out["ticketDesign"] == "modern" and out["ticketDesignId"] is None
        out = update_printer(k, out["id"], {**base, "ticketDesignId": d["id"]})
        assert out["ticketDesignId"] == d["id"] and out["ticketDesign"] is None

    def test_a_design_the_shop_may_not_use_is_refused(self, k):
        sister = Company(id=uuid.uuid4(), tenant_id=k.tenant.id, name="Sister", vat_number="2")
        k.db.add(sister)
        k.db.commit()
        foreign = design(k, name="אחר", company=sister)
        assert refused(create, k, ticketDesignId=foreign["id"]).detail == "design_not_usable"
        assert refused(create, k, ticketDesignId=str(uuid.uuid4())).detail == "design_not_usable"

    def test_a_parent_company_s_design_reaches_its_sub_companies_shops(self, k):
        parent = Company(id=uuid.uuid4(), tenant_id=k.tenant.id, name="Group", vat_number="3")
        k.db.add(parent)
        k.db.flush()
        k.company.parent_company_id = parent.id
        k.db.commit()
        group = design(k, name="של הקבוצה", company=parent)
        out = create(k, ticketDesignId=group["id"])
        assert out["ticketDesignId"] == group["id"]
        page = R.list_printers(k.shop.id, **_ctx(k))
        assert [d["name"] for d in page["ticketDesigns"]] == ["של הקבוצה"]


# ── Named designs ─────────────────────────────────────────────────────────────


class TestDesigns:
    def test_created_listed_changed_by_the_company_s_managers(self, k):
        made = design(k, overrides={"bands": {"addition": "stars"}, "fontScale": 90}, user=k.company_manager)
        assert made["template"] == "compact" and made["overrides"] == {"fontScale": 90, "bands": {"addition": "stars"}}
        assert made["style"]["designName"] == "בר" and made["style"]["bands"]["addition"] == "stars"
        assert made["style"]["fontScale"] == 90 and made["usage"] == {"printers": [], "parameterValues": []}
        listed = R.list_ticket_designs(k.company.id, **_ctx(k, k.company_manager))
        assert listed["canEdit"] is True and [d["name"] for d in listed["designs"]] == ["בר"]
        assert [t["key"] for t in listed["catalog"]["templates"]] == list(S.TEMPLATES)
        tasks = BackgroundTasks()
        changed = R.update_ticket_design(
            uuid.UUID(made["id"]), TicketDesignIn.model_validate({"name": "בר ראשי", "template": "modern"}), tasks,
            **_ctx(k, k.company_manager),
        )
        assert changed["name"] == "בר ראשי" and changed["template"] == "modern"
        assert changed["overrides"] == made["overrides"]  # not sent — kept

    def test_shop_managers_and_cashiers_do_not_edit_them(self, k):
        assert refused(design, k, user=k.manager).status_code == 403
        assert refused(design, k, user=k.cashier).status_code == 403
        assert refused(R.list_ticket_designs, k.company.id, **_ctx(k, k.manager)).status_code == 403
        # Another tenant's company: not found.
        other = refused(R.list_ticket_designs, k.foreign_shop.company_id, **_ctx(k))
        assert other.status_code == 404

    def test_a_name_once_per_company_and_overrides_the_look_takes(self, k):
        design(k)
        assert refused(design, k).detail == "design_name_taken"
        assert refused(design, k, name="x", overrides={"bands": {"addition": "hidden"}}).status_code == 422
        assert refused(design, k, name="y", template="fancy").detail == "design_template_unknown"
        assert refused(design, k, name=" ").detail == "design_name_required"

    def test_a_design_in_use_is_not_deleted(self, k):
        d = design(k)
        printer = create(k, ticketDesignId=d["id"])
        tasks = BackgroundTasks()
        err = refused(R.delete_ticket_design, uuid.UUID(d["id"]), tasks, **_ctx(k))
        assert err.status_code == 409 and err.detail["code"] == "design_in_use"
        assert err.detail["usage"]["printers"][0]["id"] == printer["id"]
        update_printer(k, printer["id"], {**printer_in().model_dump(by_alias=True, mode="json"), "ticketDesignId": None})
        set_param(k, S.DESIGN_KEY, "company", k.company.id, d["id"])
        err = refused(R.delete_ticket_design, uuid.UUID(d["id"]), tasks, **_ctx(k))
        assert err.detail["usage"]["parameterValues"] == [{"scopeType": "company", "scopeId": str(k.company.id)}]
        k.db.query(TillParameterValue).delete()
        k.db.commit()
        R.delete_ticket_design(uuid.UUID(d["id"]), tasks, **_ctx(k))
        assert k.db.query(KitchenTicketDesign).count() == 0

    def test_a_change_tells_every_till_of_the_company(self, k):
        d = design(k)
        k.notified.clear()
        tasks = BackgroundTasks()
        R.update_ticket_design(uuid.UUID(d["id"]), TicketDesignIn.model_validate({"overrides": {"qty": "box_outline"}}), tasks, **_ctx(k))
        _run(tasks)
        told = {m for m, reason in k.notified if reason == K.NOTIFY_REASON}
        assert told == {str(t.id) for t in k.tills} | {str(k.other_till.id)}


# ── The till's printers config ─────────────────────────────────────────────────


class TestTheTillsConfig:
    def test_classic_with_the_ink_saver_by_default(self, k):
        out = create(k)
        p = style_of(k, k.tills[0], out["id"])
        assert p["ticketStyle"] == S.resolve_with_params("classic")
        assert p["ticketStyle"]["inkSaver"] is True and S.black_parts(p["ticketStyle"]) == []
        for field in ("ticketDesign", "ticketDesignId", "ticketFontScale", "ticketHeader", "ticketCheckboxes",
                      "ticketElapsed", "ticketFit", "ticketMinTextSize", "ticketMaxTextSize", "ticketHeaderSize",
                      "ticketInlineMods", "ticketOrder", "ticketOrderList", "ticketGroupHeaders", "ticketNoCourse"):
            assert p[field] is None, field

    def test_a_receipt_printer_has_no_ticket_style(self, k):
        out = create(k, name="Receipts", purpose="receipt")
        assert style_of(k, k.tills[0], out["id"])["ticketStyle"] is None

    def test_the_printer_s_design_its_options_and_the_levels(self, k):
        d = design(k, overrides={"bands": {"fire": "stars"}, "order": {"by": "course"}})
        bar = create(k, name="Bar", ticketDesignId=d["id"], ticketFontScale=120)
        kitchen = create(k, name="Kitchen", ticketDesign="large")
        plain = create(k, name="Pass")
        # Company: the default design and the order; the till's own level: header size.
        set_param(k, S.DESIGN_KEY, "company", k.company.id, "modern")
        set_param(k, S.ORDER_KEY, "company", k.company.id, "category")
        set_param(k, S.HEADER_SIZE_KEY, "machine", k.tills[0].id, "s")
        one = {p["id"]: p for p in pull(k, k.tills[0])["printers"]}
        assert one[bar["id"]]["ticketStyle"] == S.resolve_with_params(
            "compact", params={S.ORDER_KEY: "category", S.HEADER_SIZE_KEY: "s"},
            overrides={"bands": {"fire": "stars"}, "order": {"by": "course"}},
            design_id=d["id"], design_name="בר", printer={"fontScale": 120},
        )
        assert one[bar["id"]]["ticketStyle"]["order"]["by"] == "course"  # the design wins over the level
        assert one[kitchen["id"]]["ticketStyle"]["template"] == "large"
        assert one[plain["id"]]["ticketStyle"]["template"] == "modern"
        assert one[plain["id"]]["ticketStyle"]["header"]["size"] == "s"
        # The other till has no header size of its own: modern's.
        two = {p["id"]: p for p in pull(k, k.tills[1])["printers"]}
        assert two[plain["id"]]["ticketStyle"]["header"]["size"] == S.template_style("modern")["header"]["size"] == "m"

    def test_a_level_design_by_id_and_one_gone(self, k):
        d = design(k, template="courses")
        out = create(k)
        set_param(k, S.DESIGN_KEY, "shop", k.shop.id, d["id"])
        style = style_of(k, k.tills[0], out["id"])["ticketStyle"]
        assert style["template"] == "courses" and style["designId"] == d["id"]
        k.db.query(TillParameterValue).delete()
        k.db.commit()
        set_param(k, S.DESIGN_KEY, "shop", k.shop.id, str(uuid.uuid4()))
        assert style_of(k, k.tills[0], out["id"])["ticketStyle"]["template"] == "classic"

    def test_the_custom_order_carries_names(self, k):
        from app.models.category import Category

        out = create(k, ticketOrder="custom", ticketOrderList=[f"category:{k.drinks.id}", f"category:{k.food.id}"])
        style = style_of(k, k.tills[0], out["id"])["ticketStyle"]
        assert style["order"]["by"] == "custom" and style["order"]["groupHeaders"] is True
        assert [(e["kind"], e["name"]) for e in style["order"]["list"]] == [("category", "Drinks"), ("category", "Food")]
        assert isinstance(k.db.get(Category, k.drinks.id), Category)

    def test_the_etag_moves_when_a_design_changes(self, k):
        d = design(k)
        create(k, ticketDesignId=d["id"])
        first = pull(k, k.tills[0])
        tasks = BackgroundTasks()
        R.update_ticket_design(uuid.UUID(d["id"]), TicketDesignIn.model_validate({"overrides": {"feedLines": 0}}), tasks, **_ctx(k))
        assert pull(k, k.tills[0], etag=first["etag"])["syncType"] == "full"


# ── The till parameters on the printers page ──────────────────────────────────


class TestTheParametersCard:
    def test_by_shop_point_of_sale_and_till_cleaned(self, k):
        page = R.list_printers(k.shop.id, **_ctx(k))["ticketOptions"]
        assert [p["key"] for p in page["parameters"]] == list(K.TICKET_SETTING_KEYS) == list(S.PARAMETER_KEYS)
        fit = next(p for p in page["parameters"] if p["key"] == S.FIT_KEY)
        assert fit["enumOptions"] == ["fit", "wrap"] and fit["enumLabels"]["fit"].startswith("שורה אחת")
        out = ticket_options(k, "shop", k.shop.id, {S.HEADER_KEY: "time, table", S.FONT_SCALE_KEY: 120})
        assert out["shop"] == {S.HEADER_KEY: "table,time", S.FONT_SCALE_KEY: 120}
        out = ticket_options(k, "machine", k.tills[0].id, {S.INK_SAVER_KEY: False})
        assert out["machines"][str(k.tills[0].id)] == {S.INK_SAVER_KEY: False}
        out = ticket_options(k, "shop", k.shop.id, {S.FONT_SCALE_KEY: None})
        assert out["shop"] == {S.HEADER_KEY: "table,time"}
        assert TP.till_parameters_for_machine(k.db, k.tills[0]).parameters[S.INK_SAVER_KEY] is False

    def test_what_the_till_cannot_parse_and_a_design_the_shop_may_not_use_are_refused(self, k):
        assert refused(ticket_options, k, "shop", k.shop.id, {S.FIT_KEY: "shrink"}).detail.startswith("invalid_value:")
        assert refused(ticket_options, k, "shop", k.shop.id, {S.DESIGN_KEY: "fancy"}).detail.startswith("invalid_value:")
        assert refused(ticket_options, k, "shop", k.shop.id, {S.DESIGN_KEY: str(uuid.uuid4())}).detail == "design_not_usable"
        assert refused(ticket_options, k, "shop", k.shop.id, {"askBeforePrint": True}).detail == "unknown_setting:askBeforePrint"
        assert refused(ticket_options, k, "shop", k.shop.id, {S.FONT_SCALE_KEY: 120}, user=k.cashier).status_code == 403
        d = design(k)
        out = ticket_options(k, "shop", k.shop.id, {S.DESIGN_KEY: d["id"]})
        assert out["shop"] == {S.DESIGN_KEY: d["id"]}

    def test_on_the_parameters_page_too_by_company(self):
        for key in S.PARAMETER_KEYS:
            assert TP.managed_on(key) is None, key
        assert not set(S.PARAMETER_KEYS) & set(K.SETTING_KEYS)


# ── The test print ─────────────────────────────────────────────────────────────


class TestTheTestPrint:
    def test_no_body_the_plain_test_page_as_before(self, k):
        out = create(k)
        send_test_print(k, out["id"])
        jobs = pending(k, k.tills[0])
        assert jobs[0]["kind"] == "test" and jobs[0]["ticket"]["source"] == "test" and jobs[0]["ticket"]["lines"] == []
        assert jobs[0]["ticketStyle"] is None and "style" not in jobs[0]["ticket"]

    def test_the_sample_in_this_design_marked_a_test(self, k):
        out = create(k, ticketDesign="large")
        made = send_test_print(k, out["id"], {"ticketDesign": "compact", "ticketFontScale": 90})
        assert len(made["jobs"]) == 2
        job = pending(k, k.tills[0])[0]
        assert job["ticket"]["lines"] == S.SAMPLE_TICKET["lines"]
        assert S.notice_parts(job["ticket"]["notice"])[0] == ("notice", S.TEST_PRINT_NOTICE)
        assert job["ticketStyle"]["template"] == "compact" and job["ticketStyle"]["fontScale"] == 90
        assert job["ticket"]["style"] == job["ticketStyle"]
        # The printer itself is unchanged.
        assert k.db.get(KitchenPrinter, uuid.UUID(out["id"])).ticket_design == "large"

    def test_a_design_being_edited(self, k):
        d = design(k, template="classic")
        out = create(k)
        send_test_print(k, out["id"], {"ticketDesignId": d["id"], "template": "modern", "overrides": {"qty": "box_outline"}})
        style = pending(k, k.tills[0])[0]["ticketStyle"]
        assert style["template"] == "modern" and style["qty"] == "box_outline"
        assert style["designId"] == d["id"] and style["designName"] == "בר"
        assert refused(send_test_print, k, out["id"], {"template": "large", "overrides": {"qty": "huge"}}).status_code == 422


# ── The relay ─────────────────────────────────────────────────────────────────


class TestTheRelay:
    def test_opened_at_and_held_go_through_and_the_host_gets_its_look(self, k):
        host = k.tills[0]
        out = create(k, name="Cloud", connectionType="cloud", hostMachineId=str(host.id), ticketDesign="courses")
        tasks = BackgroundTasks()
        body = PrintJobIn.model_validate({
            "id": str(uuid.uuid4()), "printerId": out["id"],
            "ticket": {
                "source": "table", "tableName": "5", "createdAt": "2026-10-14T17:30:00Z", "openedAt": "2026-10-14T17:00:00Z",
                "lines": [{"name": "סטייק", "quantity": 1, "course": "עיקריות", "held": True}],
                "style": {"template": "large"},
            },
        })
        R.post_print_job(str(k.tills[1].id), body, tasks, machine=k.tills[1], db=k.db)
        job = pending(k, host)[0]
        assert job["ticket"]["openedAt"] == "2026-10-14T17:00:00Z" and job["ticket"]["lines"][0]["held"] is True
        assert "style" not in job["ticket"] and job["ticketStyle"] is None  # a till's own style never rides the relay
        assert job["printer"]["ticketStyle"]["template"] == "courses"
        assert k.db.query(KitchenPrintJob).count() == 1


# ── "הרשאות דשבורד" ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "method, path, needed",
    [
        ("GET", "/kitchen-ticket-designs", "printers:view"),
        ("POST", "/kitchen-ticket-designs", "printers:edit"),
        ("PUT", "/kitchen-ticket-designs/{design_id}", "printers:edit"),
        ("DELETE", "/kitchen-ticket-designs/{design_id}", "printers:edit"),
        ("GET", "/kitchen-ticket-designs/catalog", "printers:view"),
        ("PUT", "/shops/{shop_id}/printer-options/ticket", "printers:edit"),
    ],
)
def test_the_route_sections(method, path, needed):
    fixture = (pathlib.Path(__file__).parent / "fixtures" / "dashboard_route_sections.txt").read_text(encoding="utf-8")
    assert f"{method} {path} -> {needed}" in fixture.splitlines()
