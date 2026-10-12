"""
"פתיחת מגירה" by device (the owner, 12.10.2026: "ברירת מחדל שיופיע אם יש מדפסת מובנית").

* A till whose own model drives a drawer port (`device_has_cash_drawer_port`) with `cashDrawer`
  unset at every level resolves it to "בתשלום מזומן + כפתור פתיחה" — the "פתיחת מגירה" button.
* Every other till keeps the parameter's default, "כבוי".
* A value set at any level wins (an explicit "כבוי" at the shop too). Nothing is written.
* The sync payload (`GET /sync/{m}/parameters`) carries the resolved value; the printers page
  and the roles page's drawer card say where it comes from ("device_default").

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks

from app.models.pos_machine import device_has_cash_drawer_port
from app.models.till_parameter import TillParameter, TillParameterValue
from app.routers import printers as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.kitchen_printers import KitchenOptionsIn
from app.services import cash_drawer as CD
from app.services import till_parameters as TP
from test_shop_areas import _ctx, w  # noqa: F401

KEY = TP.CASH_DRAWER_KEY
BUTTON = TP.CASH_DRAWER_WITH_BUTTON
OFF = TP.CASH_DRAWER_OFF
DRAWER_MODELS = ("SUNMI_T2S", "SUNMI_D3", "IMIN_D4", "IMIN_FALCON2", "IMIN_SWAN2")
PLAIN_MODELS = ("SUNMI_V2_PRO", "N55F", None)


@pytest.fixture
def d(w):
    TP.ensure_builtin_parameters(w.db)
    w.drawer_till, w.plain_till = w.tills
    w.drawer_till.device_model = "SUNMI_T2S"
    w.plain_till.device_model = "SUNMI_V2_PRO"
    w.db.commit()
    return w


def put(w, scope_type, scope_id, values):
    body = KitchenOptionsIn.model_validate({"scopeType": scope_type, "scopeId": str(scope_id), "values": values})
    tasks = BackgroundTasks()
    out = R.put_options(w.shop.id, body, tasks, **_ctx(w))
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def resolved(w, till):
    return TP.till_parameters_for_machine(w.db, till).parameters[KEY]


def pulled(w, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"][KEY]


class TestTheRule:
    def test_the_models(self):
        assert all(device_has_cash_drawer_port(m) for m in DRAWER_MODELS)
        assert not any(device_has_cash_drawer_port(m) for m in PLAIN_MODELS)
        for m in DRAWER_MODELS:
            assert TP.device_default(KEY, m) == BUTTON
        for m in PLAIN_MODELS:
            assert TP.device_default(KEY, m) is None
        assert TP.device_default("askBeforePrint", "SUNMI_T2S") is None

    def test_the_parameter_keeps_its_own_default_and_says_so(self):
        spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == KEY)
        assert spec.default_value == OFF and BUTTON in spec.enum_options
        assert "ברירת מחדל לפי המכשיר" in spec.description


class TestTheTill:
    def test_a_drawer_port_till_with_nothing_set_gets_the_button(self, d):
        assert resolved(d, d.drawer_till) == BUTTON
        assert pulled(d, d.drawer_till) == BUTTON
        for model in DRAWER_MODELS:
            d.drawer_till.device_model = model
            assert pulled(d, d.drawer_till) == BUTTON, model

    def test_a_till_without_a_drawer_port_keeps_off(self, d):
        assert resolved(d, d.plain_till) == OFF
        assert pulled(d, d.plain_till) == OFF
        for model in PLAIN_MODELS:
            d.plain_till.device_model = model
            assert pulled(d, d.plain_till) == OFF, model

    def test_an_explicit_off_at_the_shop_beats_the_device_default(self, d):
        put(d, "shop", d.shop.id, {KEY: OFF})
        assert pulled(d, d.drawer_till) == OFF
        assert pulled(d, d.plain_till) == OFF

    def test_any_level_wins(self, d):
        put(d, "shop", d.shop.id, {KEY: "בתשלום מזומן"})
        assert pulled(d, d.drawer_till) == "בתשלום מזומן"
        put(d, "machine", d.drawer_till.id, {KEY: OFF})
        assert pulled(d, d.drawer_till) == OFF
        # The plain till takes the shop's value, not its own "כבוי".
        assert pulled(d, d.plain_till) == "בתשלום מזומן"
        # Removed everywhere: back to the device default.
        put(d, "machine", d.drawer_till.id, {KEY: None})
        put(d, "shop", d.shop.id, {KEY: None})
        assert pulled(d, d.drawer_till) == BUTTON and pulled(d, d.plain_till) == OFF

    def test_a_company_value_wins_too(self, d):
        parameter = d.db.query(TillParameter).filter(TillParameter.key == KEY).one()
        d.db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="company", scope_id=d.company.id, value=OFF,
        ))
        d.db.commit()
        assert pulled(d, d.drawer_till) == OFF

    def test_nothing_is_written(self, d):
        before = d.db.query(TillParameterValue).count()
        pulled(d, d.drawer_till)
        R.list_printers(d.shop.id, **_ctx(d))
        assert d.db.query(TillParameterValue).count() == before


class TestTheDashboard:
    def test_the_printers_page_says_device_default(self, d):
        options = R.list_printers(d.shop.id, **_ctx(d))["options"]
        assert options["deviceDefaults"] == {str(d.drawer_till.id): {KEY: BUTTON}}
        assert options["effective"][str(d.drawer_till.id)][KEY] == {"value": BUTTON, "effectiveSource": "device_default"}
        assert options["effective"][str(d.plain_till.id)][KEY] == {"value": OFF, "effectiveSource": "default"}
        # The shop itself still inherits the parameter's default.
        assert options["inherited"][KEY] == OFF

        out = put(d, "shop", d.shop.id, {KEY: OFF})
        assert out["effective"][str(d.drawer_till.id)][KEY] == {"value": OFF, "effectiveSource": "shop"}
        # Still the device's default below every level, for the page to show under an override.
        assert out["deviceDefaults"] == {str(d.drawer_till.id): {KEY: BUTTON}}

    def test_the_roles_drawer_card_inherits_the_device_default(self, d):
        view = CD.level_view(d.db, "machine", d.drawer_till.id)
        assert view["inherited"][KEY] == BUTTON and view["inheritedSources"] == {KEY: "device_default"}
        plain = CD.level_view(d.db, "machine", d.plain_till.id)
        assert plain["inherited"][KEY] == OFF and plain["inheritedSources"] == {}
        put(d, "shop", d.shop.id, {KEY: OFF})
        view = CD.level_view(d.db, "machine", d.drawer_till.id)
        assert view["inherited"][KEY] == OFF and view["inheritedSources"] == {}
