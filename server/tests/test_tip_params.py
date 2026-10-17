"""
"טיפים" — the tip till parameters per level (app/services/tip_params.py, GET/PUT
/companies/{id}/till-tip-params): the same parameters as everywhere else, written by whoever may
set the shop's drawer parameters, all of a PUT or none of it.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.till_parameter import TillParameterChange
from app.models.user import User, UserRole
from app.routers import till_roles as R
from app.services import tip_params as TIPS
from shift_world import accept_str_uuids, make_world

KEYS = ("tipAutoPrompt", "terminalTipPrompt", "billTipBase", "cashDrawer.cardTipsFromDrawer")


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.shop_manager = _user(world, "mgr", UserRole.SHOP_MANAGER, shop=world.shop)
    world.supervisor = _user(world, "sup", UserRole.SHIFT_SUPERVISOR, shop=world.shop)
    world.company_manager = _user(world, "cm", UserRole.COMPANY_MANAGER)
    world.db.commit()
    return world


def _user(w, name, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def put(w, scope_type, scope_id, values, user=None):
    body = R.DrawerParamsIn(scopeType=scope_type, scopeId=scope_id, values=values)
    return R.put_tip_params(str(w.company.id), body, **ctx(w, user))


def get(w, scope_type, scope_id, user=None):
    return R.get_tip_params(str(w.company.id), scope_type=scope_type, scope_id=scope_id, **ctx(w, user))


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def test_the_keys_are_the_existing_parameters():
    from app.services.cash_drawer import CARD_TIPS_FROM_DRAWER_KEY
    from app.services.table_restore import TIP_BASE_KEY
    from app.services.till_parameters import BUILTIN_PARAMETERS, TERMINAL_TIP_PROMPT_KEY

    assert TIPS.TIP_PARAM_KEYS == KEYS
    assert (TIPS.TIP_AUTO_PROMPT_KEY, TERMINAL_TIP_PROMPT_KEY, TIP_BASE_KEY, CARD_TIPS_FROM_DRAWER_KEY) == KEYS
    builtin = {p.key for p in BUILTIN_PARAMETERS}
    assert set(KEYS) <= builtin


def test_a_new_shop_inherits_the_defaults(w):
    view = get(w, "shop", w.shop.id)
    assert view["own"] == {}
    assert view["inherited"] == {
        "tipAutoPrompt": True, "terminalTipPrompt": False, "billTipBase": "balance",
        "cashDrawer.cardTipsFromDrawer": False,
    }
    listed = {p["key"]: p for p in view["parameters"]}
    assert list(listed) == list(KEYS)
    assert listed["billTipBase"]["enumLabels"] == {"balance": "לפי היתרה לתשלום", "total": "לפי הסכום הכולל"}
    assert view["canEdit"] is True


def test_the_shop_level_reaches_its_tills_only(w):
    from app.services.till_parameters import till_parameters_for_machine

    view = put(w, "shop", w.shop.id, {"cashDrawer.cardTipsFromDrawer": True, "billTipBase": "total",
                                      "terminalTipPrompt": True, "tipAutoPrompt": False}, w.shop_manager)
    assert view["own"] == {"cashDrawer.cardTipsFromDrawer": True, "billTipBase": "total",
                           "terminalTipPrompt": True, "tipAutoPrompt": False}
    params = till_parameters_for_machine(w.db, w.tills[0]).parameters
    assert params["cashDrawer.cardTipsFromDrawer"] is True and params["billTipBase"] == "total"
    assert params["terminalTipPrompt"] is True and params["tipAutoPrompt"] is False
    # Each value in the change log, as the parameters page writes it.
    changes = w.db.query(TillParameterChange).filter(TillParameterChange.scope_type == "shop").all()
    assert {c.parameter_key for c in changes} == set(KEYS)
    # null clears the level's own value: it inherits again.
    view = put(w, "shop", w.shop.id, {"billTipBase": None, "tipAutoPrompt": None})
    assert view["own"] == {"cashDrawer.cardTipsFromDrawer": True, "terminalTipPrompt": True}


def test_a_refused_value_writes_nothing(w):
    for values in ({"billTipBase": "half"}, {"tipAutoPrompt": "yes"}, {"tipPresets": [10]}):
        bad = {"cashDrawer.cardTipsFromDrawer": True, **values}
        assert refused(put, w, "shop", w.shop.id, bad).status_code == 422
    assert get(w, "shop", w.shop.id)["own"] == {}


def test_who_may_set_which_level(w):
    assert refused(put, w, "company", w.company.id, {"tipAutoPrompt": False}, w.shop_manager).status_code == 403
    assert refused(put, w, "shop", w.other_shop.id, {"tipAutoPrompt": False}, w.shop_manager).status_code == 403
    assert refused(put, w, "shop", w.shop.id, {"tipAutoPrompt": False}, w.supervisor).status_code == 403
    assert put(w, "company", w.company.id, {"tipAutoPrompt": False}, w.company_manager)["own"] == {"tipAutoPrompt": False}
    assert get(w, "shop", w.shop.id, w.shop_manager)["inherited"]["tipAutoPrompt"] is False


def test_the_routes_are_till_settings():
    from app.services.dashboard_sections import rule_for

    for method in ("GET", "PUT"):
        rule = rule_for(method, "/companies/{company_id}/till-tip-params")
        assert rule.kind == "section" and "till_settings" in rule.sections
