""""מדפסת חשבוניות" = "אוטומטי" (docs/SPEC_KIOSK.md §14.7): the option and the default.

The owner, 07.10.2026: a USB receipt printer plugged into a till is detected by itself, as on
the kiosk. The cloud's part is the parameter: "אוטומטי" first and the default, so a till nobody
set a receipt printer for gets it (the till decides: a USB printer attached and approved, else
its own head — pos-android domain/UsbPrinterAuto.kt), while a value someone set keeps winning.
The migration (e9a3c7f1b5d2) adds the option to an existing database and moves the default only
while it is still the old built-in one. Pure: plain objects and a fake connection.
"""
from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

from app.services import till_parameters as TP
from app.services.till_parameters import (
    RECEIPT_PRINTER_AUTO,
    TillScopeChain,
    clean_enum_options,
    resolve_till_parameters,
    validate_value,
)

BUILT_IN = "מובנית בקופה"


def _spec():
    return next(p for p in TP.BUILTIN_PARAMETERS if p.key == "receiptPrinter")


def test_automatic_is_the_first_option_and_the_default():
    spec = _spec()
    assert RECEIPT_PRINTER_AUTO == "אוטומטי"
    assert spec.enum_options[0] == RECEIPT_PRINTER_AUTO
    assert spec.default_value == RECEIPT_PRINTER_AUTO
    # Every connection a till could be set to before is still there.
    assert set(spec.enum_options) == {RECEIPT_PRINTER_AUTO, BUILT_IN, "רשת (IP)", "Bluetooth", "USB"}
    options = clean_enum_options("enum", list(spec.enum_options))
    assert validate_value("enum", spec.default_value, options) == RECEIPT_PRINTER_AUTO
    assert "אוטומטי" in spec.description and BUILT_IN in spec.description


def _definition():
    spec = _spec()
    return SimpleNamespace(
        id=uuid.uuid4(), key=spec.key, value_type="enum", enum_options=list(spec.enum_options),
        default_value=spec.default_value, is_active=True, updated_at=None,
    )


def test_a_till_nobody_set_gets_automatic_and_a_value_set_anywhere_wins():
    chain = TillScopeChain(machine_id=uuid.uuid4(), area_id=None, shop_id=uuid.uuid4(), company_id=uuid.uuid4())
    p = _definition()
    assert resolve_till_parameters([p], [], chain).parameters == {"receiptPrinter": RECEIPT_PRINTER_AUTO}

    def value(scope_type, scope_id, v):
        return SimpleNamespace(parameter_id=p.id, scope_type=scope_type, scope_id=scope_id, value=v, updated_at=None)

    # "מובנית בקופה" set at the company: the built-in printer, even with a USB printer attached.
    assert resolve_till_parameters([p], [value("company", chain.company_id, BUILT_IN)], chain).parameters == {"receiptPrinter": BUILT_IN}
    assert resolve_till_parameters([p], [value("machine", chain.machine_id, "USB")], chain).parameters == {"receiptPrinter": "USB"}


# ── The migration on an existing database ────────────────────────────────────


def _migration():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "e9a3c7f1b5d2_receipt_printer_auto.py"
    spec = importlib.util.spec_from_file_location("receipt_printer_auto_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Conn:
    """`till_parameters`' one row as Postgres returns it (JSONB decoded), and the updates made."""

    def __init__(self, options, default):
        self.row = {"id": "p-1", "enum_options": list(options), "default_value": default}
        self.updates = []

    def execute(self, statement, params):
        sql = str(statement)
        if sql.startswith("SELECT"):
            row = self.row
            return SimpleNamespace(first=lambda: None if row is None else (row["id"], row["enum_options"], row["default_value"]))
        self.updates.append(sql)
        if "enum_options" in sql:
            self.row["enum_options"] = json.loads(params["options"])
        if "default_value" in sql:
            self.row["default_value"] = json.loads(params["value"])
        return None


def _run(module, conn, step):
    module.op = SimpleNamespace(get_bind=lambda: conn)
    getattr(module, step)()


def test_the_migration_adds_the_option_first_and_moves_the_old_default_once():
    m = _migration()
    conn = _Conn([BUILT_IN, "רשת (IP)", "Bluetooth", "USB"], BUILT_IN)
    _run(m, conn, "upgrade")
    assert conn.row["enum_options"] == [RECEIPT_PRINTER_AUTO, BUILT_IN, "רשת (IP)", "Bluetooth", "USB"]
    assert conn.row["default_value"] == RECEIPT_PRINTER_AUTO
    assert len(conn.updates) == 2
    # Again: nothing to do.
    _run(m, conn, "upgrade")
    assert len(conn.updates) == 2
    # Down: the default back, the option off.
    _run(m, conn, "downgrade")
    assert conn.row == {"id": "p-1", "enum_options": [BUILT_IN, "רשת (IP)", "Bluetooth", "USB"], "default_value": BUILT_IN}


def test_a_default_a_super_admin_chose_is_kept():
    m = _migration()
    conn = _Conn([BUILT_IN, "רשת (IP)", "Bluetooth", "USB"], "USB")
    _run(m, conn, "upgrade")
    assert conn.row["default_value"] == "USB"
    assert conn.row["enum_options"][0] == RECEIPT_PRINTER_AUTO


def test_the_migration_is_the_single_head_on_prepaid_voucher_kinds():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    # Not resolve(): under the dev box's short P: path the versions stay under MAX_PATH.
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    # One head, with this migration on the line to it (later ones chain on top — d4a8c2e6f0b1).
    heads = script.get_heads()
    assert len(heads) == 1
    assert "e9a3c7f1b5d2" in {r.revision for r in script.iterate_revisions(heads[0], "base")}
    assert script.get_revision("e9a3c7f1b5d2").down_revision == "c7e2f4a9d1b6"


def test_no_definition_yet_is_left_to_the_built_in_one():
    m = _migration()
    conn = _Conn([], None)
    conn.row = None
    _run(m, conn, "upgrade")
    assert conn.updates == []
