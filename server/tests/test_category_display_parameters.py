"""
"צבע ותמונה למחלקה" — the till parameters (P:/specs/category-color-image.md §2, §4,
app/services/category_display.py).

Three built-in enums of codes the till reads: `categoryColors` (off / chip / accent, off),
`categoryImages` (off / bar / landing, off) and `categoryImageSize` (s / m / l, m) — nothing set is
today's screens. Set like every till parameter (company → shop → point of sale → till, the most
specific wins, each change in `till_parameter_changes`), pulled with the others
(`GET /sync/{machine_id}/parameters`), and edited in "עיצוב קופה" too
(`GET / PUT /till-design/category-display`) by whoever edits the till design at that level.
`readable_text_on` is the chip's text rule, shared with the dashboard (lib/categoryLook.ts).

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.middleware.auth import get_current_machine_admin
from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterChange, TillParameterValue
from app.models.user import User, UserRole
from app.routers import till_design as D
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterUpdate, TillParameterValueIn
from app.services import ably_notify
from app.services import category_display as CD
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEYS = ("categoryColors", "categoryImages", "categoryImageSize")
DEFAULTS = {"categoryColors": "off", "categoryImages": "off", "categoryImageSize": "m"}
CODES = {
    "categoryColors": ["off", "chip", "accent"],
    "categoryImages": ["off", "bar", "landing"],
    "categoryImageSize": ["s", "m", "l"],
}


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    w = make_world()
    w.notified = []
    record = lambda tenant, machine, reason=None, **kw: w.notified.append((str(machine), reason))  # noqa: E731
    monkeypatch.setattr(TP, "publish_settings_notify", record)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", record)
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.area = area
    w.manager = _user(w, "mgr", UserRole.SHOP_MANAGER, shop=w.shop)
    w.north_manager = _user(w, "north", UserRole.SHOP_MANAGER, shop=w.other_shop)
    w.company_manager = _user(w, "cm", UserRole.COMPANY_MANAGER)
    w.cashier = _user(w, "cash", UserRole.CASHIER, shop=w.shop)
    w.db.commit()
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _user(w, name, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), email="owner@x")


def _spec(key):
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == key]
    return spec


def _definition(world, key) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == key).one()


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _set(world, key, scope_type, scope_id, value):
    """The parameters page's write (`PUT /till-parameters/{id}/values`)."""
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world, key).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    _run(tasks)
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    params = resp.model_dump(mode="json", by_alias=True)["parameters"]
    return {k: params.get(k) for k in KEYS}


def _changes(world, key):
    return (
        world.db.query(TillParameterChange)
        .filter(TillParameterChange.parameter_key == key)
        .order_by(TillParameterChange.created_at)
        .all()
    )


def _design_get(world, level, entity_id, user=None):
    return D.get_category_display(
        level=level, scope_id=entity_id, current_user=user or world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )


def _design_put(world, level, entity_id, values, user=None):
    tasks = BackgroundTasks()
    out = D.put_category_display(
        body=D.CategoryDisplayIn(values=values), background_tasks=tasks, level=level, scope_id=entity_id,
        current_user=user or world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )
    _run(tasks)
    return out


# ── The definitions ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("key", KEYS)
def test_three_builtin_enums_of_codes_today_by_default(key):
    spec = _spec(key)
    assert spec.value_type == "enum"
    assert list(spec.enum_options) == CODES[key]
    assert spec.default_value == DEFAULTS[key]
    assert spec.admin_only is False
    assert [p.key for p in TP.BUILTIN_PARAMETERS].count(key) == 1
    assert TP.validate_key(key) == key
    # Edited on the parameters page (and in "עיצוב קופה"), not on another tab.
    assert TP.managed_on(key) is None


def test_each_code_has_its_hebrew_and_the_descriptions_say_where_and_how():
    assert TP.enum_labels("categoryColors") == {
        "off": "כבוי — כמו היום", "chip": "רקע הכפתור בסרגל", "accent": "פס צבע בצד הכפתור ובכותרת",
    }
    assert TP.enum_labels("categoryImages") == {
        "off": "כבוי — כמו היום", "bar": "תמונה קטנה בכפתור המחלקה", "landing": "עמוד פתיחה של מחלקות עם תמונות",
    }
    assert TP.enum_labels("categoryImageSize") == {"s": "קטן", "m": "בינוני", "l": "גדול"}
    colors = _spec("categoryColors").description
    for where in ("בטלפון", "בטאבלט", "בהזמנת שולחן", "התבניות המעוצבות"):
        assert where in colors
    assert "לבן או שחור" in colors and "(ברירת מחדל)" in colors
    images = _spec("categoryImages").description
    assert "באות הראשונה שלה על הצבע שלה" in images and "גם בלי רשת" in images
    for key in KEYS:
        assert "חברה, סניף, נקודת מכירה או קופה" in _spec(key).description
        assert "עיצוב קופה" in _spec(key).description


def test_they_are_created_with_the_others_and_left_alone_afterwards(world):
    for key in KEYS:
        row = _definition(world, key)
        assert row.is_active and row.value_type == "enum"
        assert row.enum_options == CODES[key] and row.default_value == DEFAULTS[key]
    _definition(world, "categoryColors").label = "צבע"
    world.db.commit()
    assert not set(KEYS) & set(TP.ensure_builtin_parameters(world.db))
    assert _definition(world, "categoryColors").label == "צבע"


def test_the_dashboard_list_carries_the_hebrew_of_each_code(world):
    rows = {r.key: r.model_dump(mode="json", by_alias=True) for r in R.list_till_parameters(_admin=_admin(), db=world.db)}
    for key in KEYS:
        assert rows[key]["enumOptions"] == CODES[key]
        assert rows[key]["enumLabels"] == TP.enum_labels(key)
        assert rows[key]["defaultValue"] == DEFAULTS[key]
        assert rows[key]["managedOn"] is None and rows[key]["adminOnly"] is False


# ── Per company, shop, point of sale and till ────────────────────────────────


def test_every_till_pulls_todays_screens_until_someone_sets_them(world):
    for till in (*world.tills, world.other_till):
        assert _pulled(world, till) == DEFAULTS


def test_the_most_specific_level_wins(world):
    t_area, t_shop = world.tills
    _set(world, "categoryColors", "company", world.company.id, "accent")
    _set(world, "categoryColors", "shop", world.shop.id, "chip")
    _set(world, "categoryImages", "area", world.area.id, "landing")
    _set(world, "categoryImageSize", "machine", t_area.id, "l")

    assert _pulled(world, t_area) == {"categoryColors": "chip", "categoryImages": "landing", "categoryImageSize": "l"}
    assert _pulled(world, t_shop) == {"categoryColors": "chip", "categoryImages": "off", "categoryImageSize": "m"}
    assert _pulled(world, world.other_till) == {"categoryColors": "accent", "categoryImages": "off", "categoryImageSize": "m"}


@pytest.mark.parametrize("key,value", [
    ("categoryColors", "blue"), ("categoryColors", "Chip"), ("categoryColors", True),
    ("categoryImages", "grid"), ("categoryImages", ""), ("categoryImageSize", "xl"), ("categoryImageSize", 2),
])
def test_a_value_that_is_not_one_of_the_codes_is_refused(world, key, value):
    with pytest.raises(HTTPException) as exc:
        _set(world, key, "shop", world.shop.id, value)
    assert exc.value.status_code == 422
    assert world.db.query(TillParameterValue).filter(TillParameterValue.parameter_id == _definition(world, key).id).count() == 0
    assert _pulled(world, world.tills[0]) == DEFAULTS


def test_the_till_knows_its_codes_even_if_the_options_are_re_edited(world):
    R.update_till_parameter(
        parameter_id=_definition(world, "categoryImages").id,
        body=TillParameterUpdate(enumOptions=["off", "bar", "landing", "grid"]),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=world.db,
    )
    with pytest.raises(HTTPException) as exc:
        _set(world, "categoryImages", "machine", world.tills[0].id, "grid")
    assert exc.value.status_code == 422 and "off, bar, landing" in exc.value.detail


def test_the_sync_payload_carries_plain_strings_and_its_etag_moves(world):
    till = world.tills[0]
    request = MagicMock()
    request.headers = {}
    first = get_till_parameters_sync(machine_id=str(till.id), machine=till, request=request, db=world.db)
    body = json.loads(first.body)
    assert {k: body["parameters"][k] for k in KEYS} == DEFAULTS
    etag = first.headers["etag"]
    _set(world, "categoryColors", "area", world.area.id, "chip")
    request.headers = {"if-none-match": etag}
    second = get_till_parameters_sync(machine_id=str(till.id), machine=till, request=request, db=world.db)
    assert second.status_code == 200 and second.headers["etag"] != etag
    assert json.loads(second.body)["parameters"]["categoryColors"] == "chip"


# ── "עיצוב קופה": the card ────────────────────────────────────────────────────


def test_the_design_card_shows_own_inherited_and_the_definitions(world):
    _set(world, "categoryColors", "company", world.company.id, "accent")
    _set(world, "categoryImages", "shop", world.shop.id, "bar")

    view = _design_get(world, "area", world.area.id)
    assert (view["level"], view["id"], view["canEdit"]) == ("area", str(world.area.id), True)
    assert view["own"] == {}
    assert view["inherited"] == {"categoryColors": "accent", "categoryImages": "bar", "categoryImageSize": "m"}
    assert [p["key"] for p in view["parameters"]] == list(KEYS)
    for p in view["parameters"]:
        assert p["enumOptions"] == CODES[p["key"]]
        assert p["enumLabels"] == TP.enum_labels(p["key"])
        assert p["defaultValue"] == DEFAULTS[p["key"]]
        assert p["label"] and p["description"]

    shop = _design_get(world, "shop", world.shop.id)
    assert shop["own"] == {"categoryImages": "bar"}
    assert shop["inherited"]["categoryImages"] == "off"  # the company sets none: the default
    company = _design_get(world, "company", world.company.id)
    assert company["own"] == {"categoryColors": "accent"} and company["inherited"] == DEFAULTS


def test_the_design_card_writes_and_clears_a_level_like_the_parameters_page(world):
    t_area, t_shop = world.tills
    view = _design_put(world, "area", world.area.id, {"categoryColors": "chip", "categoryImages": "landing"})
    assert view["own"] == {"categoryColors": "chip", "categoryImages": "landing"}
    assert _pulled(world, t_area) == {"categoryColors": "chip", "categoryImages": "landing", "categoryImageSize": "m"}
    assert _pulled(world, t_shop) == DEFAULTS
    # Only the till the area reaches is told to pull its parameters.
    assert world.notified == [(str(t_area.id), TP.NOTIFY_REASON)]

    rows = _changes(world, "categoryColors")
    assert [(r.action, r.scope_type, r.old_value, r.new_value, r.user_email) for r in rows] == [
        ("set", "area", None, "chip", world.admin.email),
    ]

    # A key left out stays; null inherits again.
    view = _design_put(world, "area", world.area.id, {"categoryColors": None, "categoryImageSize": "s"})
    assert view["own"] == {"categoryImages": "landing", "categoryImageSize": "s"}
    assert [(r.action, r.old_value) for r in _changes(world, "categoryColors")][-1] == ("clear", "chip")
    assert _pulled(world, t_area) == {"categoryColors": "off", "categoryImages": "landing", "categoryImageSize": "s"}

    # The same again: nothing changed, nothing logged.
    before = len(_changes(world, "categoryImages"))
    _design_put(world, "area", world.area.id, {"categoryImages": "landing"})
    assert len(_changes(world, "categoryImages")) == before


@pytest.mark.parametrize("values", [
    {"categoryColors": "chip", "categoryImages": "grid"},
    {"categoryColors": "chip", "sellAllTab": "last"},
    {"categoryImageSize": "xl"},
])
def test_the_design_card_refuses_a_bad_key_or_code_and_writes_nothing(world, values):
    with pytest.raises(HTTPException) as exc:
        _design_put(world, "shop", world.shop.id, values)
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "invalid_category_display"
    assert world.db.query(TillParameterValue).count() == 0
    assert world.notified == []
    assert _pulled(world, world.tills[1]) == DEFAULTS


def test_the_design_card_has_the_designs_access(world):
    # A shop manager: their shop, its points of sale and tills — not another shop, not the company.
    assert _design_get(world, "shop", world.shop.id, user=world.manager)["canEdit"] is True
    _design_put(world, "machine", world.tills[1].id, {"categoryColors": "accent"}, user=world.manager)
    assert _pulled(world, world.tills[1])["categoryColors"] == "accent"
    for level, entity in (("shop", world.other_shop.id), ("machine", world.other_till.id), ("company", world.company.id)):
        with pytest.raises(HTTPException) as exc:
            _design_put(world, level, entity, {"categoryColors": "chip"}, user=world.manager)
        assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        _design_get(world, "shop", world.shop.id, user=world.north_manager)
    assert exc.value.status_code == 403
    # A company manager: the company tree.
    _design_put(world, "company", world.company.id, {"categoryImages": "bar"}, user=world.company_manager)
    assert _pulled(world, world.other_till)["categoryImages"] == "bar"
    # A cashier: neither reads nor writes the design.
    with pytest.raises(HTTPException) as exc:
        _design_get(world, "shop", world.shop.id, user=world.cashier)
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        get_current_machine_admin(world.cashier)
    assert exc.value.status_code == 403
    # Unknown level entity.
    with pytest.raises(HTTPException) as exc:
        _design_get(world, "area", uuid.uuid4())
    assert exc.value.status_code == 404


# ── The chip's text ──────────────────────────────────────────────────────────

#: Shared with the dashboard's lib/categoryLook.test.ts: the same colour, the same text.
TEXT_ON = [
    ("#2563EB", "#FFFFFF"),  # "שתייה" in blue: white text (§5.1)
    ("#1F6FEB", "#FFFFFF"),
    ("#FACC15", "#000000"),
    ("#FFFFFF", "#000000"),
    ("#000000", "#FFFFFF"),
    ("#EF4444", "#000000"),
    ("#DC2626", "#FFFFFF"),
    ("#22C55E", "#000000"),
    ("#15803D", "#FFFFFF"),
    # Either side of the line (luminance 0.179, where white and black contrast alike).
    ("#767676", "#000000"),
    ("#757575", "#FFFFFF"),
    ("#0f0", "#000000"),
    ("#00f", "#FFFFFF"),
]


@pytest.mark.parametrize("color,text", TEXT_ON)
def test_the_chips_text_is_white_or_black_by_the_colours_brightness(color, text):
    assert CD.readable_text_on(color) == text


@pytest.mark.parametrize("bad", ["", "blue", "#12345", "#GGGGGG", None])
def test_no_text_colour_for_what_is_not_a_colour(bad):
    assert CD.readable_text_on(bad) is None
