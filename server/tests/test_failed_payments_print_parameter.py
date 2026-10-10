"""
"הדפסת עסקאות שלא הושלמו בדוח משמרת / Z" (`printFailedPaymentsWithReports`).

The owner, 09.10.2026: "בקופה בהדפסת משמרת אל תדפיס את עסקאות שלא הושלמו, אפשר להדפיס בנפרד".
A built-in boolean, OFF by default: the till's shift X, shift close and till Z paper leave
"עסקאות שלא הושלמו" off unless it is on; its screens print the section apart with their own
button. Resolved per till like every parameter — till, then area, then shop, then company,
then the default — and pulled by the till with the others. It replaces `printFailedPayments`
(on by default), which alembic 9b4e2f7a1c58 deactivates. Read by the till only: nothing the
cloud computes depends on it (docs/SPEC_FAILED_PAYMENTS.md §3, §3.2).
"""
from __future__ import annotations

import importlib.util
import os
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterValueIn
from app.services import failed_payments as FP
from app.services import till_parameters as TP
from shift_world import make_world

KEY = "printFailedPaymentsWithReports"
OLD_KEY = "printFailedPayments"


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.db.commit()
    w.area = area
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN)


def _param(world, key=KEY) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == key).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_param(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def _pulled(world, till):
    """What the till's parameter sync hands it for the key (absent → None)."""
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def _spec():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    return spec


# ── The definition ───────────────────────────────────────────────────────────


def test_a_builtin_boolean_off_by_default():
    spec = _spec()
    assert spec.value_type == "boolean"
    assert spec.default_value is False
    assert spec.label == "הדפסת עסקאות שלא הושלמו בדוח משמרת / Z"
    assert FP.PRINT_PARAMETER_KEY == KEY


def test_the_help_text_says_what_off_and_on_do_and_where_to_print_it_apart():
    text = _spec().description
    assert text.startswith("כבוי (ברירת מחדל)")
    assert "\"עסקאות שלא הושלמו\"" in text and "\"מכירות שבוטלו\"" in text
    assert "\"הדפס עסקאות שלא הושלמו\"" in text and "בנפרד" in text
    assert "מופעל" in text and "לא נכלל בסה״כ המכירות" in text
    assert "חברה, סניף, נקודת מכירה או קופה" in text


def test_the_old_switch_is_no_longer_a_builtin():
    assert OLD_KEY not in {p.key for p in TP.BUILTIN_PARAMETERS}
    assert FP.RETIRED_PRINT_PARAMETER_KEY == OLD_KEY


def test_created_with_the_others_and_left_alone_afterwards(world):
    p = _param(world)
    assert p.is_active and p.value_type == "boolean" and p.default_value is False
    # A super admin turns the default on; the next startup keeps it.
    p.default_value = True
    world.db.commit()
    assert KEY not in TP.ensure_builtin_parameters(world.db)
    assert _param(world).default_value is True


# ── Per company, shop, area and till ─────────────────────────────────────────


def test_every_till_gets_off_until_someone_turns_it_on(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is False


def test_on_for_a_whole_company(world):
    _set(world, "company", world.company.id, True)
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) is True


def test_the_most_specific_level_wins(world):
    _set(world, "company", world.company.id, True)
    _set(world, "shop", world.shop.id, False)
    assert _pulled(world, world.tills[1]) is False  # the shop's off beats the company's on
    assert _pulled(world, world.other_till) is True  # another shop keeps the company's

    _set(world, "area", world.area.id, True)
    assert _pulled(world, world.tills[0]) is True  # in the area
    assert _pulled(world, world.tills[1]) is False  # same shop, no area

    _set(world, "machine", world.tills[0].id, False)
    assert _pulled(world, world.tills[0]) is False


@pytest.mark.parametrize("value", ["true", "כן", 1, 0, ""])
def test_only_true_or_false_is_accepted(world, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, "machine", world.tills[0].id, value)
    assert exc.value.status_code == 422


def test_resolution_without_a_database():
    """The pure resolver: default off; till → area → shop → company, the first set wins."""
    param = TillParameter(
        id=uuid.uuid4(), key=KEY, label="x", value_type="boolean", default_value=False, is_active=True,
    )
    till, area, shop, company = (uuid.uuid4() for _ in range(4))
    chain = TP.TillScopeChain(machine_id=till, area_id=area, shop_id=shop, company_id=company)

    def value(scope_type, scope_id, v):
        return MagicMock(parameter_id=param.id, scope_type=scope_type, scope_id=scope_id, value=v, updated_at=None)

    assert TP.resolve_till_parameters([param], [], chain).parameters == {KEY: False}
    assert TP.resolve_till_parameters([param], [value("company", company, True)], chain).parameters == {KEY: True}
    both = [value("company", company, True), value("shop", shop, False)]
    assert TP.resolve_till_parameters([param], both, chain).parameters == {KEY: False}
    assert TP.resolve_till_parameters([param], both + [value("machine", till, True)], chain).parameters == {KEY: True}


# ── The migration that retires the old switch ────────────────────────────────


def _migration():
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "9b4e2f7a1c58_retire_print_failed_payments.py"
    )
    spec = importlib.util.spec_from_file_location("retire_print_failed_payments", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_migration_deactivates_the_old_switch_and_keeps_its_values():
    module = _migration()
    assert module.KEY == OLD_KEY
    assert module.revision == "9b4e2f7a1c58" and module.down_revision == "c8a1e5f3d9b7"

    executed = []
    op = MagicMock()
    op.execute.side_effect = executed.append
    module.op = op

    module.upgrade()
    (statement,) = executed
    sql = str(statement)
    assert "UPDATE till_parameters SET is_active = false" in sql and "updated_at = now()" in sql
    assert "DELETE" not in sql.upper()
    assert statement.compile().params == {"key": OLD_KEY}

    executed.clear()
    module.downgrade()
    (statement,) = executed
    assert "SET is_active = true" in str(statement) and statement.compile().params == {"key": OLD_KEY}


def test_the_migration_is_a_unique_revision_on_the_single_head():
    import pathlib
    import re

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).absolute().parents[1]
    revision = "9b4e2f7a1c58"
    declaring = [
        p.name for p in (root / "alembic" / "versions").glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
    ]
    assert declaring == [f"{revision}_retire_print_failed_payments.py"]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
