"""
Which hardware a till is: a Nova 55F (built-in printer) or a Modo (none).

* The model is chosen when the pairing code is generated, stored on the code, and copied
  onto the machine the code pairs — a new one, or the row a replacement adopts.
* It can be changed afterwards (`PUT /machines/{id}`), and cleared to unknown.
* `GET /machines/me` tells the till: `deviceModel` and `hasPrinter`, true for a 55F and
  for an unknown model (every till from before the column has a printer).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine, device_has_printer
from app.routers import machines as machines_router
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse
from app.schemas.pairing_mobile import MobileClaimRequest
from app.schemas.pos_machine import POSMachineResponse, POSMachineUpdate
from app.services import pairing as P
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(machines_router, "refuse_leaving_shop_with_shifts", lambda db, m: None)
    return world


def _code(w, *, device_model=None, target=None, shop_id=None) -> PairingCode:
    # Added rather than made by `create_pairing_code`, whose commit reloads `expires_at`
    # naive from SQLite; the pairing compares it with an aware now. Callers keep the
    # returned row referenced, so the session hands back this instance, not a reload.
    code = PairingCode(
        id=uuid.uuid4(),
        code=f"C{uuid.uuid4().hex[:7].upper()}",
        distributor_id=w.admin.id,
        tenant_id=w.tenant.id,
        shop_id=shop_id,
        target_machine_id=target,
        device_model=device_model,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


class TestHasPrinter:
    @pytest.mark.parametrize(
        "model, expected", [("N55F", True), (None, True), ("MODO", False)]
    )
    def test_only_a_modo_has_no_printer(self, model, expected):
        assert device_has_printer(model) is expected
        assert POSMachine(device_model=model).has_printer is expected


class TestPairing:
    def test_the_code_stores_the_model(self, w):
        code = P.create_pairing_code(w.db, w.admin.id, tenant_id=w.tenant.id, device_model="MODO")
        assert code.device_model == "MODO"
        assert PairingCodeResponse.model_validate(code).model_dump(by_alias=True)["deviceModel"] == "MODO"

    def test_the_request_accepts_only_known_models(self):
        assert PairingCodeGenerateRequest(deviceModel="N55F").device_model == "N55F"
        assert PairingCodeGenerateRequest().device_model is None
        with pytest.raises(ValidationError):
            PairingCodeGenerateRequest(deviceModel="X9")

    def test_a_new_machine_gets_the_codes_model(self, w):
        code = _code(w, device_model="MODO")
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert machine.device_model == "MODO"
        assert machine.has_printer is False

    def test_a_code_without_a_model_leaves_it_unknown(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert machine.device_model is None and machine.has_printer is True

    def test_a_pre_assigned_code_still_copies_it(self, w, monkeypatch):
        # The register number's regex is Postgres-only; the shop step is not the point.
        def _assign(db, machine_id, shop_id):
            machine = db.get(POSMachine, machine_id)
            machine.shop_id = shop_id
            return machine

        monkeypatch.setattr(P, "assign_machine_to_shop", _assign)
        code = _code(w, device_model="N55F", shop_id=w.shop.id)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Bar")
        assert machine.shop_id == w.shop.id and machine.device_model == "N55F"

    def test_a_replacement_takes_the_new_units_model(self, w):
        till = w.tills[0]
        till.device_model = "N55F"
        code = _code(w, device_model="MODO", target=till.id)
        machine = P.validate_pairing_code(w.db, code.code, {}, None)
        assert machine is till and till.device_model == "MODO"

    def test_a_replacement_code_without_a_model_keeps_the_tills(self, w):
        till = w.tills[0]
        till.device_model = "MODO"
        code = _code(w, target=till.id)
        P.validate_pairing_code(w.db, code.code, {}, None)
        assert till.device_model == "MODO"

    def test_the_field_install_claim_accepts_it(self):
        body = MobileClaimRequest(
            deviceNonce="n", companyId=uuid.uuid4(), shopId=uuid.uuid4(), deviceModel="MODO"
        )
        assert body.device_model == "MODO"


class TestEditing:
    def _put(self, w, till, **body):
        return machines_router.update_machine(
            machine_id=str(till.id),
            machine_data=POSMachineUpdate(**body),
            current_user=w.admin,
            active_tenant_id=w.tenant.id,
            db=w.db,
        )

    def test_the_model_is_changed(self, w):
        till = w.tills[0]
        out = POSMachineResponse.model_validate(self._put(w, till, deviceModel="MODO"))
        dumped = out.model_dump(by_alias=True)
        assert (dumped["deviceModel"], dumped["hasPrinter"]) == ("MODO", False)

    def test_null_clears_it_and_omitted_leaves_it(self, w):
        till = w.tills[0]
        till.device_model = "MODO"
        self._put(w, till, name="Renamed")
        assert till.device_model == "MODO"
        self._put(w, till, deviceModel=None)
        assert till.device_model is None and till.has_printer is True

    def test_an_unknown_model_is_refused(self):
        with pytest.raises(ValidationError):
            POSMachineUpdate(deviceModel="55F")

    def test_the_machines_list_carries_it(self, w):
        w.tills[0].device_model = "MODO"
        rows = {r["id"]: r for r in machines_router._enrich_machines_batch(list(w.tills), w.db)}
        assert (rows[w.tills[0].id]["deviceModel"], rows[w.tills[0].id]["hasPrinter"]) == ("MODO", False)
        assert (rows[w.tills[1].id]["deviceModel"], rows[w.tills[1].id]["hasPrinter"]) == (None, True)


class TestMachinesMe:
    def _me(self, till):
        # Realtime info is not what this is about.
        return machines_router.get_my_machine(machine=till)

    @pytest.mark.parametrize(
        "model, has_printer", [("N55F", True), ("MODO", False), (None, True)]
    )
    def test_the_till_is_told_its_model_and_whether_it_prints(self, w, model, has_printer):
        till = w.tills[0]
        till.device_model = model
        out = self._me(till)
        assert out["deviceModel"] == model
        assert out["hasPrinter"] is has_printer
