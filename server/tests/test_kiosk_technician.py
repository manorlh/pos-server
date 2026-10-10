"""
"בדיקות ומידע קיוסק" — the kiosk technician screen's cloud half (app/services/kiosk_technician.py,
app/routers/kiosk_technician.py; pos-android ui/kiosk/KioskTechnician.kt).

* `technicianCode` is a built-in till parameter, "1995" by default, 4–8 digits, set through
  the super-admin-only till parameters router like every other.
* The till never gets the code in clear: it gets PBKDF2-SHA256 salted with its own id — the
  same bytes pos-android's KioskTechnicianCode computes (the golden vector below is pinned in
  both test suites: KioskTechnicianTest on the till).
* `GET /sync/{m}/kiosk/technician`: tenant, company, shop + branch code, the till's number and
  prefix, its role and Z, and for a kiosk its controlling tills.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import kiosk_technician as KR
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.kiosk import KioskCreateIn
from app.schemas.till_parameter import TillParameterValueIn
from app.services import kiosk_technician as K
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

KEY = "technicianCode"

#: Pinned in pos-android KioskTechnicianTest too: the same code on the same till hashes the same.
GOLDEN_MACHINE = "de93de29-19bb-4480-ab06-f73af2876841"
GOLDEN_1995 = "pbkdf2-sha256$10000$21802f21a7b5d44d5bb054d0b77447f571029bbf4f3e634aa46c33a193f60dd3"


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    w = make_world()
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN)


def _definition(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == KEY).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def _pulled(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(KEY)


# ── The code ─────────────────────────────────────────────────────────────────


def test_it_is_a_builtin_string_1995_by_default():
    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == KEY]
    assert spec.value_type == "string"
    assert spec.default_value == "1995"
    assert "טכנאי" in spec.label


def test_the_hash_is_the_tills_golden_vector():
    assert K.code_hash(GOLDEN_MACHINE, "1995") == GOLDEN_1995
    # The id as the till holds it: case and spaces do not change the salt.
    assert K.code_hash(" " + GOLDEN_MACHINE.upper() + " ", "1995") == GOLDEN_1995
    assert K.code_hash(GOLDEN_MACHINE, "1996") != GOLDEN_1995
    assert K.code_hash(str(uuid.uuid4()), "1995") != GOLDEN_1995


def test_a_till_gets_the_hash_never_the_code(world):
    till = world.tills[0]
    got = _pulled(world, till)
    assert got == K.code_hash(till.id, "1995")
    assert "1995" not in got
    # Salted per till: the same code reads differently on another till.
    assert _pulled(world, world.tills[1]) != got


def test_levels_resolve_and_the_till_gets_the_hash_of_its_own_value(world):
    _set(world, "company", world.company.id, "4321")
    _set(world, "machine", world.tills[0].id, "24680")
    assert _pulled(world, world.tills[0]) == K.code_hash(world.tills[0].id, "24680")
    assert _pulled(world, world.tills[1]) == K.code_hash(world.tills[1].id, "4321")


@pytest.mark.parametrize("bad", ["12", "123456789", "19a5", "", "  "])
def test_a_code_that_is_not_4_to_8_digits_is_a_422(world, bad):
    with pytest.raises(HTTPException) as caught:
        _set(world, "shop", world.shop.id, bad)
    assert caught.value.status_code == 422


def test_a_code_is_stored_trimmed(world):
    out = _set(world, "shop", world.shop.id, " 5555 ")
    assert out.value == "5555"


def test_only_a_super_admin_sets_it():
    # Every route of the till parameters router takes the super admin and nobody else.
    for fn in (R.set_till_parameter_value, R.create_till_parameter, R.update_till_parameter):
        default = inspect.signature(fn).parameters["_admin"].default
        assert getattr(default, "dependency", None) is R.get_current_super_admin


# ── Where the till stands ────────────────────────────────────────────────────


def test_identity_of_a_regular_till(world):
    till = world.tills[1]
    world.shop.branch_id = "7"
    world.shop.shop_number = 2
    world.db.commit()
    out = KR.get_kiosk_technician_identity(machine_id=str(till.id), machine=till, db=world.db)
    assert out["tenant"]["name"] == world.tenant.name
    assert out["company"]["name"] == world.company.name
    assert out["shop"] == {"id": str(world.shop.id), "name": "Center", "number": 2, "branchCode": "7"}
    assert out["machine"]["id"] == str(till.id)
    assert out["machine"]["posNumber"] == till.pos_number
    assert out["machine"]["documentPrefix"] == till.effective_document_prefix
    assert out["machine"]["role"] == "till"
    assert out["machine"]["zRole"] == "shop_z"
    assert out["machine"]["independentTill"] is False
    assert out["kiosk"] is None


def test_identity_of_a_kiosk_names_its_controlling_tills(world):
    from app.routers import kiosks as kiosks_router
    from app.services import ably_notify

    for name in ("publish_settings_notify", "publish_notify"):
        if hasattr(ably_notify, name):
            setattr(ably_notify, name, lambda *a, **k: None)
    kiosk, controller = world.tills
    kiosks_router.create_kiosk(
        body=KioskCreateIn(machineId=kiosk.id, name="קיוסק רויאל", controllerMachineIds=[str(controller.id)], lockDevice=False),
        current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )
    out = KR.get_kiosk_technician_identity(machine_id=str(kiosk.id), machine=kiosk, db=world.db)
    assert out["machine"]["role"] == "kiosk"
    assert out["kiosk"]["name"] == "קיוסק רויאל"
    assert out["kiosk"]["controllers"] == [
        {"id": str(controller.id), "name": controller.name, "posNumber": controller.pos_number, "active": True},
    ]


def test_an_independent_till_says_so(world):
    till = world.tills[0]
    till.z_mode = "till"
    till.independent_till = True
    world.db.commit()
    out = K.identity(world.db, till)
    assert out["machine"]["independentTill"] is True
    assert out["machine"]["zRole"] == "independent"
    assert out["machine"]["zMode"] == "till"
