"""
"הסתרת אפשרויות מתפריט הקופה" — `hiddenMenuItems` (P:/specs/till-menu-hide.md, app/services/till_menu.py,
app/routers/till_menu.py).

* The definition: a built-in string, empty by default (the menu as today), edited on the parameters
  page with checkboxes (`widget: menu_items`), created at startup with the others — no migration.
* The keys: the till's §5 list in the menu's order, pinned with the dashboard by
  tests/fixtures/till_menu_items_golden.json; three critical items with their warnings.
* The value: known keys only, each once, in the menu's order; unknown keys dropped with a warning;
  what is not a key list refused.
* Levels: company → shop → point of sale → till, the most specific list wins whole — a lower level
  adds items or gives them back ([] = nothing hidden there).
* The payload: every till gets it with its parameters (`GET /sync/{id}/parameters`), and the ETag moves.
* The device page's card (`/till-menu-hide`): the level's view, and its writers — the super admin and
  the company managers over the level, never a shop manager.
* "עיצוב קופה"'s card (`/till-design/menu-hide`): the same value, written by the design's writers.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.company import Company
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterChange, TillParameterValue
from app.models.user import User, UserRole
from app.routers import till_menu as M
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterValueIn
from app.services import ably_notify
from app.services import dashboard_sections as DS
from app.services import till_menu as TM
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "hiddenMenuItems"
GOLDEN = Path(__file__).parent / "fixtures" / "till_menu_items_golden.json"

#: Spec §5, in the menu's order (the till's keys; they never change).
SPEC_KEYS = [
    "catalog_admin", "shop_z", "shift", "shift_close", "till_z", "open_cash_drawer", "cash_menu", "refund",
    "transmission", "attendance", "sync_now", "ready_orders", "kiosk_orders", "voucher_station",
    "voucher_balance", "app_update", "history", "recent", "shift_history", "till_z_history", "product_sales",
    "workers", "tips", "tables_reports", "z_reports", "settings", "printers", "print_queue", "screen_edit",
    "diagnostics", "kiosk_mode", "alerts", "blocks_now", "managed_kiosks", "lock", "support", "switch_user",
    "tables", "training", "quick_order",
    # "דוח X סניפי" (P:/specs/shop-x-report.md §3): appended last, in the "דוחות" folder.
    "shop_x",
]


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.notified = []
    record = lambda tenant, machine, reason=None, **kw: world.notified.append((str(machine), reason))  # noqa: E731
    monkeypatch.setattr(TP, "publish_settings_notify", record)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", record)
    world.area = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="בר")
    world.db.add(world.area)
    world.db.flush()
    world.bar_till, world.counter_till = world.tills
    world.bar_till.area_id = world.area.id
    # Another company of the same organisation, with a shop and a till.
    world.far_company = Company(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Far", vat_number="514141414")
    world.db.add(world.far_company)
    world.db.flush()
    world.far_shop = Shop(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.far_company.id, name="Far", settings={})
    world.db.add(world.far_shop)
    world.db.flush()
    world.manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.north_manager = _user(world, "north", UserRole.SHOP_MANAGER, shop=world.other_shop)
    world.company_manager = _user(world, "cm", UserRole.COMPANY_MANAGER)
    world.far_manager = _user(world, "far", UserRole.COMPANY_MANAGER, company=world.far_company)
    world.cashier = _user(world, "cash", UserRole.CASHIER, shop=world.shop)
    world.db.commit()
    TP.ensure_builtin_parameters(world.db)
    world.db.commit()
    return world


def _user(w, name, role, shop=None, company=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=(company or w.company).id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _definition(w) -> TillParameter:
    return w.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _set(w, scope_type, scope_id, value):
    """The parameters page's write (`PUT /till-parameters/{id}/values`, the super admin)."""
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(w).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks, _admin=_admin(), db=w.db,
    )
    _run(tasks)
    return out


def _pulled(w, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


def _stored(w):
    return {
        (r.scope_type, str(r.scope_id)): r.value
        for r in w.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == _definition(w).id).all()
    }


def _changes(w):
    return (
        w.db.query(TillParameterChange)
        .filter(TillParameterChange.parameter_key == KEY)
        .order_by(TillParameterChange.created_at)
        .all()
    )


def _device_get(w, level, ident, user=None):
    return M.get_till_menu_hide(
        level=level, scope_id=ident, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _device_put(w, level, ident, hidden, user=None):
    tasks = BackgroundTasks()
    out = M.put_till_menu_hide(
        body=M.MenuHideIn(hidden=hidden), background_tasks=tasks, level=level, scope_id=ident,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    _run(tasks)
    return out


def _design_get(w, level, ident, user=None):
    return M.get_design_menu_hide(
        level=level, scope_id=ident, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _design_put(w, level, ident, hidden, user=None):
    tasks = BackgroundTasks()
    out = M.put_design_menu_hide(
        body=M.MenuHideIn(hidden=hidden), background_tasks=tasks, level=level, scope_id=ident,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    _run(tasks)
    return out


def _refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


# ── The definition ───────────────────────────────────────────────────────────


def test_a_builtin_string_empty_by_default_edited_with_checkboxes():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.value_type == "string"
    assert spec.default_value == ""
    assert spec.admin_only is False and KEY not in TP.ADMIN_ONLY_KEYS
    assert TP.validate_key(KEY) == KEY
    assert TP.parameter_widget(KEY, "string") == TP.WIDGET_MENU_ITEMS == "menu_items"
    assert TP.managed_on(KEY) is None  # on the parameters page, as well as the two cards
    for words in ("לאף עובד", "בלי קשר להרשאות", "קוד טכנאי", "חברה, סניף, נקודת מכירה או קופה", "עיצוב הקופה"):
        assert words in spec.description


def test_created_with_the_others_at_startup_and_left_alone_afterwards(w):
    row = _definition(w)
    assert row.is_active and row.value_type == "string" and row.default_value == ""
    row.label = "תפריט"
    w.db.commit()
    assert KEY not in TP.ensure_builtin_parameters(w.db)
    assert _definition(w).label == "תפריט"


def test_the_parameters_page_lists_it_with_its_widget(w):
    rows = {r.key: r.model_dump(mode="json", by_alias=True) for r in R.list_till_parameters(_admin=_admin(), db=w.db)}
    assert rows[KEY]["widget"] == "menu_items"
    assert rows[KEY]["valueType"] == "string" and rows[KEY]["defaultValue"] == ""
    assert rows[KEY]["managedOn"] is None and rows[KEY]["adminOnly"] is False


# ── The keys ─────────────────────────────────────────────────────────────────


def test_the_keys_are_the_tills_in_the_menus_order():
    assert list(TM.KNOWN_KEYS) == SPEC_KEYS
    assert len(set(TM.KNOWN_KEYS)) == len(TM.KNOWN_KEYS) == 41
    assert all(item.label for item in TM.ITEMS)
    assert TM.REPORT_KEYS == tuple(SPEC_KEYS[17:25]) + ("shop_x",)


def test_the_list_is_the_dashboards_the_shared_golden_file():
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert golden == [
        {
            "key": i.key,
            "label": i.label,
            "also": i.also,
            "critical": i.warning is not None,
            "warning": i.warning,
            "report": i.key in TM.REPORT_KEYS,
        }
        for i in TM.ITEMS
    ]


def test_three_critical_items_each_with_its_warning():
    assert TM.CRITICAL_KEYS == ("shift_close", "till_z", "settings")
    warnings = {w["key"]: w["warning"] for w in TM.warnings_for(["settings", "catalog_admin", "till_z", "shift_close"])}
    assert list(warnings) == ["shift_close", "till_z", "settings"]  # the menu's order
    assert warnings["till_z"] == "בקופה הזו לא יהיה אפשר לבצע Z. ודאו ש-Z נעשה בקופה אחרת או בענן."
    assert "לסגור משמרת" in warnings["shift_close"]
    assert "רק בקוד טכנאי" in warnings["settings"]
    assert TM.warnings_for(["catalog_admin", "lock"]) == []


# ── The value ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("given,stored", [
    ("", ""),
    ("   ", ""),
    ("till_z", "till_z"),
    (" Settings , CATALOG_ADMIN,till_z,,catalog_admin ", "catalog_admin,till_z,settings"),
    (["lock", "shift_close", "lock"], "shift_close,lock"),
    ("training,catalog_admin", "catalog_admin,training"),
])
def test_known_keys_once_each_in_the_menus_order(given, stored):
    assert TM.clean(given).value == stored
    assert TM.clean(given).ignored == ()


def test_unknown_keys_are_dropped_with_a_warning(caplog, monkeypatch):
    monkeypatch.setattr(TM.logger, "disabled", False)
    with caplog.at_level(logging.WARNING, logger=TM.logger.name):
        assert TM.clean_value("till_z, coffee_machine ,settings,blocked_now") == "till_z,settings"
    assert "ignoring unknown menu keys coffee_machine, blocked_now" in caplog.text
    assert TM.clean("coffee_machine").ignored == ("coffee_machine",)


@pytest.mark.parametrize("bad", [5, True, {"till_z": True}, [1, 2], ["x" * 65], ",".join(f"k{i}" for i in range(65))])
def test_what_is_not_a_key_list_is_refused(bad):
    with pytest.raises(TM.MenuKeysError):
        TM.clean(bad)


def test_the_parameters_page_stores_the_clean_list(w, caplog, monkeypatch):
    monkeypatch.setattr(TM.logger, "disabled", False)
    with caplog.at_level(logging.WARNING, logger=TM.logger.name):
        out = _set(w, "machine", w.bar_till.id, " Till_Z, catalog_admin , espresso ")
    assert out.value == "catalog_admin,till_z"
    assert "espresso" in caplog.text
    assert _stored(w) == {("machine", str(w.bar_till.id)): "catalog_admin,till_z"}
    assert w.notified == [(str(w.bar_till.id), TP.NOTIFY_REASON)]


def test_the_parameters_page_refuses_a_value_that_is_not_text(w):
    with pytest.raises(HTTPException) as exc:
        _set(w, "shop", w.shop.id, ["till_z"])
    assert exc.value.status_code == 422
    assert _stored(w) == {}


# ── Levels and the payload ───────────────────────────────────────────────────


def test_every_till_gets_an_empty_list_until_a_level_sets_one(w):
    for till in (*w.tills, w.other_till):
        assert _pulled(w, till) == ""


def test_the_most_specific_list_wins_whole_adding_or_giving_back(w):
    _set(w, "company", w.company.id, "catalog_admin")
    _set(w, "shop", w.shop.id, "catalog_admin,settings")
    # The point of sale gives everything back: [] there hides nothing, whatever is above.
    _set(w, "area", w.area.id, "")
    assert _pulled(w, w.bar_till) == ""
    assert _pulled(w, w.counter_till) == "catalog_admin,settings"
    assert _pulled(w, w.other_till) == "catalog_admin"
    # The till hides Z, and only Z.
    _set(w, "machine", w.bar_till.id, "till_z")
    assert _pulled(w, w.bar_till) == "till_z"
    assert TM.hidden_for({KEY: _pulled(w, w.counter_till)}) == ["catalog_admin", "settings"]


def test_the_sync_payload_carries_it_and_its_etag_moves(w):
    request = MagicMock()
    request.headers = {}
    first = get_till_parameters_sync(machine_id=str(w.bar_till.id), machine=w.bar_till, request=request, db=w.db)
    assert json.loads(first.body)["parameters"][KEY] == ""
    etag = first.headers["etag"]
    _set(w, "area", w.area.id, "catalog_admin")
    request.headers = {"if-none-match": etag}
    second = get_till_parameters_sync(machine_id=str(w.bar_till.id), machine=w.bar_till, request=request, db=w.db)
    assert second.status_code == 200 and second.headers["etag"] != etag
    assert json.loads(second.body)["parameters"][KEY] == "catalog_admin"


def test_off_the_tills_get_nothing(w):
    _definition(w).is_active = False
    w.db.commit()
    assert _pulled(w, w.bar_till) is None
    assert _device_get(w, "machine", w.bar_till.id)["active"] is False


# ── One level: the cards' view ───────────────────────────────────────────────


def test_a_level_shows_its_own_what_it_inherits_and_from_where(w):
    _set(w, "company", w.company.id, "catalog_admin")
    _set(w, "shop", w.shop.id, "settings,till_z")

    till = _device_get(w, "machine", w.bar_till.id)
    assert (till["key"], till["level"], till["id"]) == (KEY, "machine", str(w.bar_till.id))
    assert till["own"] is None
    assert till["inherited"] == ["till_z", "settings"]
    assert till["inheritedFrom"] == {"level": "shop", "id": str(w.shop.id), "name": "Center"}
    assert till["effective"] == ["till_z", "settings"]
    assert [x["key"] for x in till["warnings"]] == ["till_z", "settings"]
    assert [i["key"] for i in till["items"]] == SPEC_KEYS
    assert {i["key"] for i in till["items"] if i["critical"]} == {"shift_close", "till_z", "settings"}
    assert {i["key"] for i in till["items"] if i["report"]} == set(TM.REPORT_KEYS)
    (catalog,) = [i for i in till["items"] if i["key"] == "catalog_admin"]
    assert catalog["label"] == "ניהול קטלוג" and "לחיצה ארוכה" in catalog["also"]
    assert (till["canEdit"], till["ignored"], till["active"]) == (True, [], True)

    shop = _device_get(w, "shop", w.shop.id)
    assert shop["own"] == ["till_z", "settings"]
    assert shop["inheritedFrom"]["level"] == "company" and shop["inherited"] == ["catalog_admin"]
    assert shop["effective"] == ["till_z", "settings"]

    company = _device_get(w, "company", w.company.id)
    assert company["own"] == ["catalog_admin"]
    assert company["inherited"] == [] and company["inheritedFrom"] is None  # the default: nothing


def _tables(w, scope_type, scope_id, mode):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == "tablesMode").one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=mode,
    ))
    w.db.commit()


def test_quick_order_is_the_tables_only_device(w):
    (item,) = [i for i in TM.ITEMS if i.key == "quick_order"]
    assert item.label == "הזמנה מהירה (בסרגל, לא בתפריט)"
    assert TM.KNOWN_KEYS[-3:-1] == ("training", "quick_order")
    assert item.warning is None and "quick_order" not in TM.CRITICAL_KEYS
    assert "מסך השולחנות" in item.also
    _set(w, "machine", w.bar_till.id, "quick_order,training")
    assert _pulled(w, w.bar_till) == "training,quick_order"


def test_no_way_to_sell_is_a_warning_when_the_tables_are_off_or_hidden(w):
    def selling(view):
        return [x["warning"] for x in view["warnings"] if x["key"] == "quick_order"]

    # Tables off (the default): hiding "הזמנה מהירה" leaves no way to sell — said, not refused.
    view = _device_put(w, "machine", w.bar_till.id, ["quick_order"])
    assert view["own"] == ["quick_order"] and view["tablesOff"] is True
    (text,) = selling(view)
    assert text.startswith("בקופה הזו לא תישאר דרך למכור") and "ניהול השולחנות כבוי" in text
    assert _pulled(w, w.bar_till) == "quick_order"

    # Tables on for the shop: a tables-only till, no warning — unless "שולחנות" is hidden too.
    _tables(w, "shop", w.shop.id, "מסונכרן בין הקופות")
    view = _device_get(w, "machine", w.bar_till.id)
    assert view["tablesOff"] is False and selling(view) == []
    view = _design_put(w, "machine", w.bar_till.id, ["quick_order", "tables"])
    (text,) = selling(view)
    assert text.startswith(TM.NO_WAY_TO_SELL) and "גם \"שולחנות\" מוסתר" in text
    assert [x["key"] for x in view["warnings"]] == ["quick_order"]

    # Above a till: the level's own tables mode.
    assert _device_get(w, "shop", w.shop.id)["tablesOff"] is False
    assert _device_get(w, "company", w.company.id)["tablesOff"] is True
    _tables(w, "area", w.area.id, "כבוי")
    assert _device_get(w, "area", w.area.id)["tablesOff"] is True
    view = _device_put(w, "area", w.area.id, ["quick_order"])
    assert selling(view)
    # Nothing about selling when "הזמנה מהירה" shows.
    assert TM.sell_warning(["tables"], True) is None
    assert TM.sell_warning(["quick_order"], None) is None


def test_an_empty_own_list_is_not_inheriting(w):
    _set(w, "shop", w.shop.id, "settings")
    _set(w, "area", w.area.id, "")
    view = _device_get(w, "area", w.area.id)
    assert view["own"] == [] and view["inherited"] == ["settings"] and view["effective"] == []
    assert view["warnings"] == []


# ── The device page's card: writes and who ───────────────────────────────────


def test_the_device_card_writes_clears_and_tells_only_the_tills_under_it(w):
    view = _device_put(w, "machine", w.bar_till.id, ["settings", "catalog_admin", "Coffee"])
    assert view["own"] == ["catalog_admin", "settings"] and view["ignored"] == ["coffee"]
    assert [x["key"] for x in view["warnings"]] == ["settings"]
    assert _stored(w) == {("machine", str(w.bar_till.id)): "catalog_admin,settings"}
    assert _pulled(w, w.bar_till) == "catalog_admin,settings" and _pulled(w, w.counter_till) == ""
    assert w.notified == [(str(w.bar_till.id), TP.NOTIFY_REASON)]
    assert [(c.action, c.scope_type, c.old_value, c.new_value, c.user_email) for c in _changes(w)] == [
        ("set", "machine", None, "catalog_admin,settings", w.admin.email),
    ]

    # The same choice again (in another order): nothing changes, nothing logged, nobody told.
    w.notified.clear()
    _device_put(w, "machine", w.bar_till.id, ["catalog_admin", "settings"])
    assert len(_changes(w)) == 1 and w.notified == []

    # null: the level's own list goes — it inherits again.
    view = _device_put(w, "machine", w.bar_till.id, None)
    assert view["own"] is None and view["effective"] == []
    assert _stored(w) == {}
    assert [c.action for c in _changes(w)] == ["set", "clear"]
    assert _pulled(w, w.bar_till) == ""


def test_the_device_card_writers_are_the_super_admin_and_the_company_managers(w):
    # A company manager: any level of their company.
    for level, ident in (("company", w.company.id), ("shop", w.other_shop.id), ("area", w.area.id), ("machine", w.bar_till.id)):
        assert _device_put(w, level, ident, ["lock"], user=w.company_manager)["own"] == ["lock"]
    assert _device_get(w, "machine", w.bar_till.id, user=w.company_manager)["canEdit"] is True
    # …not another company's.
    assert _refused(_device_put, w, "company", w.company.id, ["lock"], user=w.far_manager).status_code == 403
    assert _refused(_device_put, w, "shop", w.shop.id, ["lock"], user=w.far_manager).status_code == 403
    # A shop manager reads their own shop's levels, and writes none of them.
    view = _device_get(w, "machine", w.bar_till.id, user=w.manager)
    assert view["canEdit"] is False and view["own"] == ["lock"]
    for level, ident in (("shop", w.shop.id), ("machine", w.bar_till.id)):
        assert _refused(_device_put, w, level, ident, ["till_z"], user=w.manager).status_code == 403
    assert _refused(_device_get, w, "machine", w.other_till.id, user=w.manager).status_code == 403
    assert _refused(_device_get, w, "machine", w.bar_till.id, user=w.north_manager).status_code == 403
    # A cashier: nothing.
    assert _refused(_device_get, w, "machine", w.bar_till.id, user=w.cashier).status_code == 403
    assert _refused(_device_put, w, "machine", w.bar_till.id, ["till_z"], user=w.cashier).status_code == 403
    # What they could not write is not there.
    assert _stored(w) == {
        ("company", str(w.company.id)): "lock",
        ("shop", str(w.other_shop.id)): "lock",
        ("area", str(w.area.id)): "lock",
        ("machine", str(w.bar_till.id)): "lock",
    }


def test_a_company_manager_writes_their_own_companys_levels_only(w):
    _device_put(w, "company", w.far_company.id, ["support"], user=w.far_manager)
    assert _stored(w) == {("company", str(w.far_company.id)): "support"}
    assert _refused(_device_get, w, "company", w.far_company.id, user=w.company_manager).status_code == 403


def test_the_device_card_refuses_what_is_not_a_key_list(w):
    exc = _refused(_device_put, w, "machine", w.bar_till.id, ["x" * 65])
    assert exc.status_code == 422 and exc.detail["code"] == "invalid_menu_keys"
    assert _stored(w) == {} and w.notified == []


def test_an_unknown_level_entity_is_a_404(w):
    assert _refused(_device_get, w, "area", uuid.uuid4()).status_code == 404
    assert _refused(_device_put, w, "machine", uuid.uuid4(), ["till_z"]).status_code == 404


# ── "עיצוב קופה": the same value, the design's writers ────────────────────────


def test_the_design_card_writes_the_same_parameter(w):
    _set(w, "shop", w.shop.id, "catalog_admin")
    view = _design_get(w, "machine", w.bar_till.id)
    assert view["inherited"] == ["catalog_admin"] and view["inheritedFrom"]["level"] == "shop"
    assert view["canEdit"] is True

    view = _design_put(w, "machine", w.bar_till.id, ["till_z", "unknown_key"])
    assert view["own"] == ["till_z"] and view["ignored"] == ["unknown_key"]
    assert [x["key"] for x in view["warnings"]] == ["till_z"]
    # One value, wherever it was written: the parameters page and the device card see it.
    assert _stored(w) == {("shop", str(w.shop.id)): "catalog_admin", ("machine", str(w.bar_till.id)): "till_z"}
    assert _device_get(w, "machine", w.bar_till.id)["own"] == ["till_z"]
    values = R.list_till_parameter_values(parameter_id=_definition(w).id, _admin=_admin(), db=w.db)
    assert {(v.scope_type, v.value) for v in values} == {("shop", "catalog_admin"), ("machine", "till_z")}
    assert _pulled(w, w.bar_till) == "till_z"
    assert w.notified[-1] == (str(w.bar_till.id), TP.NOTIFY_REASON)

    # [] gives back what the shop hides; null inherits it again.
    assert _design_put(w, "machine", w.bar_till.id, [])["effective"] == []
    assert _pulled(w, w.bar_till) == ""
    assert _design_put(w, "machine", w.bar_till.id, None)["effective"] == ["catalog_admin"]
    assert _pulled(w, w.bar_till) == "catalog_admin"
    assert [c.action for c in _changes(w)][-3:] == ["set", "set", "clear"]


def test_the_design_card_is_written_by_a_company_manager_and_up_only(w):
    # A company manager: any level of the company tree, not another company's.
    for level, ident in (("company", w.company.id), ("shop", w.shop.id), ("area", w.area.id), ("machine", w.counter_till.id)):
        assert _design_put(w, level, ident, ["catalog_admin"], user=w.company_manager)["own"] == ["catalog_admin"]
    assert _design_get(w, "machine", w.counter_till.id, user=w.company_manager)["canEdit"] is True
    assert _refused(_design_put, w, "company", w.company.id, ["lock"], user=w.far_manager).status_code == 403
    assert _refused(_design_put, w, "shop", w.shop.id, ["lock"], user=w.far_manager).status_code == 403

    # A shop manager edits the rest of the design, but sees this card read-only — at every level of
    # their shop (hiding Z, the shift close or the settings is not theirs to decide).
    for level, ident in (("shop", w.shop.id), ("area", w.area.id), ("machine", w.counter_till.id)):
        view = _design_get(w, level, ident, user=w.manager)
        assert view["canEdit"] is False and view["own"] == ["catalog_admin"]
        assert _refused(_design_put, w, level, ident, ["till_z"], user=w.manager).status_code == 403
        assert _refused(_design_put, w, level, ident, None, user=w.manager).status_code == 403
    assert _refused(_design_put, w, "machine", w.other_till.id, ["till_z"], user=w.manager).status_code == 403
    assert _refused(_design_get, w, "shop", w.shop.id, user=w.north_manager).status_code == 403
    # …while the design itself stays theirs (PUT /till-design/settings).
    from app.routers import till_design as D

    D.put_settings(
        body=D.TillDesignSettingsIn(overrides={}), background_tasks=BackgroundTasks(), level="shop",
        scope_id=w.shop.id, current_user=w.manager, active_tenant_id=w.tenant.id, db=w.db,
    )

    # A cashier: neither reads nor writes the design.
    assert _refused(_design_get, w, "shop", w.shop.id, user=w.cashier).status_code == 403
    assert _refused(_design_put, w, "shop", w.shop.id, ["lock"], user=w.cashier).status_code == 403
    # What they could not write is not there.
    assert _stored(w) == {
        ("company", str(w.company.id)): "catalog_admin",
        ("shop", str(w.shop.id)): "catalog_admin",
        ("area", str(w.area.id)): "catalog_admin",
        ("machine", str(w.counter_till.id)): "catalog_admin",
    }
    assert w.notified and all(reason == TP.NOTIFY_REASON for _, reason in w.notified)


def test_both_cards_have_the_same_writers():
    assert set(M.SETTINGS_WRITERS) == {UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER}
    assert not hasattr(M, "DESIGN_WRITERS")


def test_a_distributor_writes_its_own_tills_on_both_cards(w):
    distributor = _user(w, "dist", UserRole.DISTRIBUTOR)
    w.bar_till.distributor_id = distributor.id
    w.db.commit()
    assert _device_put(w, "machine", w.bar_till.id, ["lock"], user=distributor)["own"] == ["lock"]
    assert _design_get(w, "machine", w.bar_till.id, user=distributor)["canEdit"] is True
    assert _design_put(w, "machine", w.bar_till.id, ["support"], user=distributor)["own"] == ["support"]
    # Not a till of another distributor's.
    assert _refused(_design_put, w, "machine", w.counter_till.id, ["lock"], user=distributor).status_code == 403


def test_the_design_card_refuses_what_is_not_a_key_list(w):
    exc = _refused(_design_put, w, "shop", w.shop.id, ["y" * 70])
    assert exc.status_code == 422 and exc.detail["code"] == "invalid_menu_keys"
    assert _stored(w) == {}


# ── The dashboard's sections ──────────────────────────────────────────────────


def test_the_routes_sections():
    assert DS.rule_for("GET", "/till-menu-hide").describe("GET") == "devices|till_settings:view"
    assert DS.rule_for("PUT", "/till-menu-hide").describe("PUT") == "devices|till_settings:edit"
    assert DS.rule_for("GET", "/till-design/menu-hide").describe("GET") == "till_design:view"
    assert DS.rule_for("PUT", "/till-design/menu-hide").describe("PUT") == "till_design:edit"
