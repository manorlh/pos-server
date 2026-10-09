"""Till parameters ("פרמטרים לקופות"): definitions, values per level, and the till's pull.

Covers validation (key slug, types, enum options, values per type), the resolution order
till → area → shop → company → default (inactive left out, no value and no default left
out), the wire shape of `GET /sync/{id}/parameters`, the Ably notify on writes, and that
every dashboard endpoint is super admin only.

The pure parts run on plain objects; the handlers run against the in-memory SQLite
world of tests/shift_world.py, called directly. HTTP is only used where the wire itself
is the subject (the sync JSON, and the 403s), with dependencies overridden.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import (
    TillParameterCreate,
    TillParameterUpdate,
    TillParameterValueIn,
)
from app.services import till_parameters as TP
from app.services.till_parameters import (
    TillParameterValueError,
    TillScopeChain,
    clean_enum_options,
    resolve_till_parameters,
    validate_key,
    validate_value,
)
from shift_world import make_world


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


# ── Definition validation ────────────────────────────────────────────────────


@pytest.mark.parametrize("key", ["printCopies", "printer.copies", "a1", "x_y.z", "A" + "b" * 63])
def test_a_key_is_a_slug(key):
    assert validate_key(key) == key


@pytest.mark.parametrize(
    "key", ["", "a", "1abc", "_abc", ".abc", "has space", "מפתח", "a-b", "A" + "b" * 64, None, 5]
)
def test_a_key_that_is_not_a_slug_is_refused(key):
    with pytest.raises(TillParameterValueError):
        validate_key(key)


def test_create_trims_the_key_and_label():
    body = TillParameterCreate(key=" printCopies ", label=" עותקים ", valueType="integer")
    assert body.key == "printCopies"
    assert body.label == "עותקים"
    assert body.is_active is True
    assert body.default_value is None
    assert body.enum_options is None


def test_create_refuses_an_unknown_type():
    with pytest.raises(ValidationError):
        TillParameterCreate(key="k1", label="L", valueType="date")


def test_an_enum_needs_options_and_other_types_may_not_have_them():
    with pytest.raises(ValidationError):
        TillParameterCreate(key="k1", label="L", valueType="enum")
    with pytest.raises(ValidationError):
        TillParameterCreate(key="k1", label="L", valueType="enum", enumOptions=[])
    with pytest.raises(ValidationError):
        TillParameterCreate(key="k1", label="L", valueType="string", enumOptions=["a"])
    # An empty list on a non-enum is just "none".
    assert TillParameterCreate(key="k1", label="L", valueType="string", enumOptions=[]).enum_options is None


def test_enum_options_are_trimmed_unique_and_non_empty():
    assert clean_enum_options("enum", [" a ", "b"]) == ["a", "b"]
    for bad in (["a", "a"], ["a", ""], ["a", 3], "a"):
        with pytest.raises(TillParameterValueError):
            clean_enum_options("enum", bad)


@pytest.mark.parametrize(
    "value_type, default, options",
    [
        ("integer", "5", None),
        ("integer", 2.5, None),
        ("integer", True, None),
        ("decimal", "1.5", None),
        ("boolean", 1, None),
        ("boolean", "true", None),
        ("string", 5, None),
        ("enum", "c", ["a", "b"]),
    ],
)
def test_the_default_must_fit_the_type(value_type, default, options):
    with pytest.raises(ValidationError):
        TillParameterCreate(
            key="k1", label="L", valueType=value_type, enumOptions=options, defaultValue=default
        )


def test_a_default_that_fits_is_kept():
    body = TillParameterCreate(
        key="k1", label="L", valueType="enum", enumOptions=["a", "b"], defaultValue="b"
    )
    assert body.default_value == "b"
    assert TillParameterCreate(key="k2", label="L", valueType="integer", defaultValue=3.0).default_value == 3


# ── Value validation per type ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value_type, value, expected",
    [
        ("string", "hello", "hello"),
        ("string", "", ""),
        ("integer", 7, 7),
        ("integer", -3, -3),
        ("integer", 4.0, 4),
        ("decimal", 1.25, 1.25),
        ("decimal", 3, 3),
        ("boolean", True, True),
        ("boolean", False, False),
    ],
)
def test_values_that_fit_their_type(value_type, value, expected):
    result = validate_value(value_type, value)
    assert result == expected and type(result) is type(expected)


@pytest.mark.parametrize(
    "value_type, value",
    [
        ("string", 5),
        ("string", "x" * (TP.STRING_VALUE_MAX + 1)),
        ("integer", "7"),
        ("integer", 7.5),
        ("integer", True),
        ("integer", 2**60),
        ("decimal", "1.5"),
        ("decimal", False),
        ("decimal", float("nan")),
        ("boolean", 0),
        ("boolean", "false"),
        ("string", None),
    ],
)
def test_values_that_do_not_fit_their_type(value_type, value):
    with pytest.raises(TillParameterValueError):
        validate_value(value_type, value)


def test_an_enum_value_must_be_one_of_its_options():
    assert validate_value("enum", "b", ["a", "b"]) == "b"
    with pytest.raises(TillParameterValueError):
        validate_value("enum", "c", ["a", "b"])
    with pytest.raises(TillParameterValueError):
        validate_value("enum", "B", ["a", "b"])


def test_the_value_body_refuses_an_unknown_level():
    with pytest.raises(ValidationError):
        TillParameterValueIn(scopeType="tenant", scopeId=uuid.uuid4(), value=1)


# ── Resolution (pure) ────────────────────────────────────────────────────────


def _param(key, value_type="integer", default=None, active=True, options=None, stamp=0):
    return SimpleNamespace(
        id=uuid.uuid4(),
        key=key,
        value_type=value_type,
        enum_options=options,
        default_value=default,
        is_active=active,
        updated_at=_ts(stamp),
    )


def _value(param, scope_type, scope_id, value, stamp=0):
    return SimpleNamespace(
        parameter_id=param.id,
        scope_type=scope_type,
        scope_id=scope_id,
        value=value,
        updated_at=_ts(stamp),
    )


@pytest.fixture
def chain():
    return TillScopeChain(
        machine_id=uuid.uuid4(), area_id=uuid.uuid4(), shop_id=uuid.uuid4(), company_id=uuid.uuid4()
    )


def _levels(param, chain, which):
    ids = {
        "machine": chain.machine_id,
        "area": chain.area_id,
        "shop": chain.shop_id,
        "company": chain.company_id,
    }
    values = {"machine": 1, "area": 2, "shop": 3, "company": 4}
    return [_value(param, level, ids[level], values[level]) for level in which]


@pytest.mark.parametrize(
    "levels, expected",
    [
        (["company", "shop", "area", "machine"], 1),
        (["company", "shop", "area"], 2),
        (["company", "shop"], 3),
        (["company"], 4),
        ([], 99),
        (["company", "machine"], 1),
        (["company", "area"], 2),
    ],
)
def test_the_most_specific_level_wins(chain, levels, expected):
    p = _param("copies", default=99)
    resolved = resolve_till_parameters([p], _levels(p, chain, levels), chain)
    assert resolved.parameters == {"copies": expected}


def test_values_of_other_tills_and_shops_do_not_count(chain):
    p = _param("copies", default=99)
    foreign = [
        _value(p, "machine", uuid.uuid4(), 1),
        _value(p, "shop", uuid.uuid4(), 3),
        # The right id at the wrong level is not this till's either.
        _value(p, "shop", chain.machine_id, 5),
    ]
    assert resolve_till_parameters([p], foreign, chain).parameters == {"copies": 99}


def test_an_inactive_parameter_is_not_sent(chain):
    p = _param("copies", default=99, active=False)
    resolved = resolve_till_parameters([p], _levels(p, chain, ["machine"]), chain)
    assert resolved.parameters == {}


def test_no_value_and_no_default_is_left_out(chain):
    p = _param("copies")
    other = _param("label", value_type="string")
    resolved = resolve_till_parameters([p, other], _levels(p, chain, ["shop"]), chain)
    assert resolved.parameters == {"copies": 3}


def test_falsy_values_still_win(chain):
    flag = _param("beep", value_type="boolean", default=True)
    zero = _param("copies", default=5)
    values = [
        _value(flag, "machine", chain.machine_id, False),
        _value(zero, "shop", chain.shop_id, 0),
    ]
    assert resolve_till_parameters([flag, zero], values, chain).parameters == {"beep": False, "copies": 0}


def test_a_stored_value_the_type_no_longer_accepts_falls_through(chain):
    mode = _param("mode", value_type="enum", options=["a", "b"], default="a")
    values = [
        _value(mode, "machine", chain.machine_id, "gone"),
        _value(mode, "shop", chain.shop_id, "b"),
    ]
    assert resolve_till_parameters([mode], values, chain).parameters == {"mode": "b"}


def test_a_till_without_shop_or_area_gets_its_own_values_and_defaults():
    machine_id = uuid.uuid4()
    lone = TillScopeChain(machine_id=machine_id)
    p = _param("copies", default=2)
    q = _param("label", value_type="string")
    values = [_value(q, "machine", machine_id, "x")]
    assert resolve_till_parameters([p, q], values, lone).parameters == {"copies": 2, "label": "x"}


def test_the_watermark_is_the_newest_definition_or_applicable_value(chain):
    p = _param("copies", default=1, stamp=5)
    inactive = _param("old", default=1, active=False, stamp=20)
    values = [
        _value(p, "shop", chain.shop_id, 3, stamp=30),
        # Another till's value is newer still, but is not this till's business.
        _value(p, "machine", uuid.uuid4(), 3, stamp=90),
    ]
    resolved = resolve_till_parameters([p, inactive], values, chain)
    assert resolved.updated_at == _ts(30)
    # An inactive definition still moves it: deactivating changed what the till gets.
    assert resolve_till_parameters([p, inactive], [], chain).updated_at == _ts(20)


def test_no_parameters_means_no_watermark(chain):
    resolved = resolve_till_parameters([], [], chain)
    assert resolved.parameters == {} and resolved.updated_at is None


# ── Handlers on a real (SQLite) world ────────────────────────────────────────


@pytest.fixture
def world(monkeypatch):
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.db.commit()
    w.area = area
    return w


@pytest.fixture
def published(monkeypatch):
    sent = []
    monkeypatch.setattr(
        TP, "publish_settings_notify", lambda tenant_id, machine_id, reason: sent.append((machine_id, reason))
    )
    return sent


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN)


def _create(world, **fields):
    tasks = BackgroundTasks()
    out = R.create_till_parameter(
        body=TillParameterCreate(**fields), background_tasks=tasks, _admin=_admin(), db=world.db
    )
    _run(tasks)
    return out


def _set(world, parameter_id, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=parameter_id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    _run(tasks)
    return out


def _pull(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)


def test_a_till_gets_its_resolved_parameters(world, published):
    copies = _create(world, key="printCopies", label="עותקים", valueType="integer", defaultValue=1)
    mode = _create(world, key="mode", label="מצב", valueType="enum", enumOptions=["a", "b"])
    _create(world, key="hidden", label="X", valueType="boolean", defaultValue=True, isActive=False)

    _set(world, copies.id, "company", world.company.id, 4)
    _set(world, copies.id, "shop", world.shop.id, 3)
    _set(world, copies.id, "area", world.area.id, 2)
    _set(world, mode.id, "machine", world.tills[0].id, "b")

    in_area = _pull(world, world.tills[0])
    assert set(in_area) == {"parameters", "updatedAt"}
    assert in_area["parameters"] == {"printCopies": 2, "mode": "b"}
    assert in_area["updatedAt"] is not None

    # Same shop, no area, no own value: the shop's 3 and no `mode` (no default).
    assert _pull(world, world.tills[1])["parameters"] == {"printCopies": 3}
    # The other shop of the same company: the company's 4.
    assert _pull(world, world.other_till)["parameters"] == {"printCopies": 4}

    _set(world, copies.id, "machine", world.tills[0].id, 9)
    assert _pull(world, world.tills[0])["parameters"]["printCopies"] == 9


def test_setting_a_value_again_replaces_it(world, published):
    p = _create(world, key="copies", label="L", valueType="integer")
    first = _set(world, p.id, "shop", world.shop.id, 2)
    second = _set(world, p.id, "shop", world.shop.id, 5)
    assert first.id == second.id
    assert second.value == 5
    assert world.db.query(TillParameterValue).count() == 1


def test_a_value_that_does_not_fit_is_a_422(world, published):
    p = _create(world, key="copies", label="L", valueType="integer")
    with pytest.raises(HTTPException) as exc:
        _set(world, p.id, "shop", world.shop.id, "two")
    assert exc.value.status_code == 422


def test_a_value_on_a_missing_entity_is_a_404(world, published):
    p = _create(world, key="copies", label="L", valueType="integer")
    for scope_type in ("company", "shop", "area", "machine"):
        with pytest.raises(HTTPException) as exc:
            _set(world, p.id, scope_type, uuid.uuid4(), 1)
        assert exc.value.status_code == 404
        assert exc.value.detail == f"{scope_type}_not_found"


def test_values_are_listed_with_their_entity_names(world, published):
    p = _create(world, key="copies", label="L", valueType="integer")
    _set(world, p.id, "machine", world.tills[0].id, 1)
    _set(world, p.id, "area", world.area.id, 2)
    _set(world, p.id, "company", world.company.id, 4)
    _set(world, p.id, "shop", world.shop.id, 3)

    rows = R.list_till_parameter_values(parameter_id=p.id, _admin=_admin(), db=world.db)
    assert [(r.scope_type, r.scope_name, r.scope_context) for r in rows] == [
        ("company", "Acme", None),
        ("shop", "Center", "Acme"),
        ("area", "Bar", "Center"),
        ("machine", "קופה מס׳ 1 · Till 1", "Center"),
    ]
    listed = R.list_till_parameters(_admin=_admin(), db=world.db)
    assert [(x.key, x.value_count) for x in listed] == [("copies", 4)]


def test_deleting_a_value_falls_back_a_level(world, published):
    p = _create(world, key="copies", label="L", valueType="integer", defaultValue=1)
    _set(world, p.id, "shop", world.shop.id, 3)
    own = _set(world, p.id, "machine", world.tills[0].id, 9)
    tasks = BackgroundTasks()
    R.delete_till_parameter_value(
        parameter_id=p.id, value_id=own.id, background_tasks=tasks, _admin=_admin(), db=world.db
    )
    _run(tasks)
    assert _pull(world, world.tills[0])["parameters"] == {"copies": 3}


def test_deleting_a_parameter_removes_its_values(world, published):
    p = _create(world, key="copies", label="L", valueType="integer", defaultValue=1)
    _set(world, p.id, "shop", world.shop.id, 3)
    tasks = BackgroundTasks()
    R.delete_till_parameter(parameter_id=p.id, background_tasks=tasks, _admin=_admin(), db=world.db)
    _run(tasks)
    assert world.db.query(TillParameter).count() == 0
    assert world.db.query(TillParameterValue).count() == 0
    assert _pull(world, world.tills[0]) == {"parameters": {}, "updatedAt": None}


def test_a_duplicate_key_is_a_409_in_any_case(world, published):
    _create(world, key="printCopies", label="L", valueType="integer")
    with pytest.raises(HTTPException) as exc:
        _create(world, key="PRINTCOPIES", label="L", valueType="integer")
    assert exc.value.status_code == 409


def _update(world, parameter_id, **fields):
    tasks = BackgroundTasks()
    out = R.update_till_parameter(
        parameter_id=parameter_id,
        body=TillParameterUpdate(**fields),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    _run(tasks)
    return out


def test_update_is_partial_and_can_clear_the_default(world, published):
    p = _create(world, key="copies", label="L", valueType="integer", defaultValue=1)
    out = _update(world, p.id, label="New")
    assert (out.label, out.default_value, out.value_type) == ("New", 1, "integer")
    out = _update(world, p.id, defaultValue=None)
    assert out.default_value is None
    assert _pull(world, world.tills[0])["parameters"] == {}


def test_a_type_change_must_still_accept_the_values_already_set(world, published):
    p = _create(world, key="copies", label="L", valueType="integer")
    _set(world, p.id, "shop", world.shop.id, 3)
    with pytest.raises(HTTPException) as exc:
        _update(world, p.id, valueType="boolean")
    assert exc.value.status_code == 409
    # Integer → decimal keeps every integer valid.
    assert _update(world, p.id, valueType="decimal").value_type == "decimal"


def test_a_type_change_must_still_accept_the_default(world, published):
    p = _create(world, key="copies", label="L", valueType="integer", defaultValue=1)
    with pytest.raises(HTTPException) as exc:
        _update(world, p.id, valueType="string")
    assert exc.value.status_code == 422
    out = _update(world, p.id, valueType="string", defaultValue="one")
    assert (out.value_type, out.default_value) == ("string", "one")


def test_switching_away_from_an_enum_drops_its_options(world, published):
    p = _create(world, key="mode", label="L", valueType="enum", enumOptions=["a", "b"])
    out = _update(world, p.id, valueType="string")
    assert out.enum_options is None


# ── Notify ───────────────────────────────────────────────────────────────────


def test_a_value_notifies_the_tills_under_its_level(world, published):
    p = _create(world, key="copies", label="L", valueType="integer")
    assert published == []  # no default: a new parameter changes no till yet

    _set(world, p.id, "area", world.area.id, 2)
    assert published == [(str(world.tills[0].id), TP.NOTIFY_REASON)]

    published.clear()
    _set(world, p.id, "shop", world.shop.id, 2)
    assert sorted(m for m, _ in published) == sorted(str(t.id) for t in world.tills)

    published.clear()
    _set(world, p.id, "company", world.company.id, 2)
    assert len(published) == 3

    published.clear()
    _set(world, p.id, "machine", world.other_till.id, 2)
    assert published == [(str(world.other_till.id), TP.NOTIFY_REASON)]


def test_a_definition_change_notifies_every_active_till(world, published):
    world.tills[1].is_active = False
    world.db.commit()
    p = _create(world, key="copies", label="L", valueType="integer", defaultValue=1)
    assert sorted(m for m, _ in published) == sorted([str(world.tills[0].id), str(world.other_till.id)])
    published.clear()
    _update(world, p.id, label="New")
    assert len(published) == 2
    assert {reason for _, reason in published} == {"till_parameters_updated"}


# ── Over HTTP: the sync wire shape, and super admin only ─────────────────────


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: MagicMock()
    try:
        yield app, TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_the_sync_endpoint_sends_parameters_and_an_iso_watermark(client):
    from app.middleware.auth import get_pos_machine_for_sync_path

    app, http = client
    machine = MagicMock(id=uuid.uuid4())
    app.dependency_overrides[get_pos_machine_for_sync_path] = lambda: machine
    resolved = TP.ResolvedParameters(
        parameters={"printCopies": 2, "rate": 1.5, "beep": False, "mode": "b"},
        updated_at=_ts(30),
    )
    with patch("app.routers.sync.till_parameters_for_machine", return_value=resolved):
        resp = http.get(f"/api/v1/sync/{machine.id}/parameters")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "parameters": {"printCopies": 2, "rate": 1.5, "beep": False, "mode": "b"},
        "updatedAt": body["updatedAt"],
    }
    assert datetime.fromisoformat(body["updatedAt"].replace("Z", "+00:00")) == _ts(30)

    empty = TP.ResolvedParameters(parameters={}, updated_at=None)
    with patch("app.routers.sync.till_parameters_for_machine", return_value=empty):
        assert http.get(f"/api/v1/sync/{machine.id}/parameters").json() == {
            "parameters": {},
            "updatedAt": None,
        }


_ROUTES = [
    ("get", "/api/v1/till-parameters", None),
    ("post", "/api/v1/till-parameters", {"key": "k1", "label": "L", "valueType": "string"}),
    ("put", f"/api/v1/till-parameters/{uuid.uuid4()}", {"label": "L"}),
    ("delete", f"/api/v1/till-parameters/{uuid.uuid4()}", None),
    ("get", f"/api/v1/till-parameters/{uuid.uuid4()}/values", None),
    (
        "put",
        f"/api/v1/till-parameters/{uuid.uuid4()}/values",
        {"scopeType": "shop", "scopeId": str(uuid.uuid4()), "value": "x"},
    ),
    ("delete", f"/api/v1/till-parameters/{uuid.uuid4()}/values/{uuid.uuid4()}", None),
    # The change log (app/services/till_parameter_audit.py).
    ("get", f"/api/v1/till-parameters/{uuid.uuid4()}/changes", None),
]


@pytest.mark.parametrize(
    "role", [r for r in UserRole if r != UserRole.SUPER_ADMIN], ids=lambda r: r.value
)
def test_everyone_but_a_super_admin_gets_403(client, role):
    from app.middleware.auth import get_current_user

    app, http = client
    app.dependency_overrides[get_current_user] = lambda: MagicMock(spec=User, role=role)
    for method, url, body in _ROUTES:
        kwargs = {"json": body} if body is not None else {}
        resp = http.request(method.upper(), url, **kwargs)
        assert resp.status_code == 403, (method, url, resp.text)
        assert resp.json()["detail"] == "Super admin access required"


def test_every_dashboard_route_hangs_on_the_super_admin_gate():
    from app.middleware.auth import get_current_super_admin

    def calls(dependant):
        yield dependant.call
        for sub in dependant.dependencies:
            yield from calls(sub)

    routes = [r for r in R.router.routes if hasattr(r, "dependant")]
    assert len(routes) == 8
    for route in routes:
        assert get_current_super_admin in set(calls(route.dependant)), route.path
