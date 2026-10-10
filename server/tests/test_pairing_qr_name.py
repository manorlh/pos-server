"""
Pairing by QR, and the optional device name (docs/SPEC_PAIRING_QR.md).

* The QR format is written once, in the spec, and pinned by a golden fixture with the same bytes in
  pos-android (`pairing_qr_golden.json`). The dashboard's `pairingCodeQr.ts` builds it, the till's
  `DashboardPairingQr.kt` reads it; this file pins the bytes and checks the fixture against the spec
  written out a third time, here, so a case nobody implements cannot sit in it unnoticed.
* The name: cleaned by one rule, optional in the add-device form, carried on the code to the machine,
  the default "קופה N" for a till that arrived with none, and a till renaming itself.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote, unquote

import pytest
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.models.audit_exception import TillEvent
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.routers import sync as sync_router
from app.schemas.pairing_code import PairingCodeGenerateRequest, PairingCodeResponse
from app.services import machine_names as MN
from app.services import pairing as P
from app.services import register_number
from shift_world import accept_str_uuids, make_world

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "pairing_qr_golden.json"
#: The LF-normalised bytes' SHA-256 — pos-android's DashboardPairingQrTest pins the same value.
GOLDEN_SHA256 = "084bf292182c974a623f4cf752c4a4a763c096644eeabcb29b2a5cec79ea9d1c"


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


# ── The format, written out once more (the spec §2) ──────────────────────────


_PREFIX = "r2mpos://pair?"
_AUTHORITY = re.compile(r"^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$")
_SERVER = re.compile(r"^(?i:https?)://([^/?#@\x00-\x20\x7f]+)((?:/[^\x00-\x20\x7f?#]*)?)$")


def _server_ok(server: str) -> Optional[str]:
    """The address as the format carries it (trailing slashes dropped), or None when it is not one."""
    m = _SERVER.match(server)
    if m is None or _AUTHORITY.match(m.group(1)) is None:
        return None
    return server.rstrip("/")


def _loopback(server: str) -> bool:
    authority = _SERVER.match(server).group(1)
    host = authority[1:authority.index("]")] if authority.startswith("[") else authority.split(":")[0]
    host = host.lower()
    return host in ("localhost", "::1", "0.0.0.0") or host.endswith(".localhost") or host.startswith("127.")


def _enc(text: str) -> str:
    return quote(text, safe="")


def build_reference(server: str, code: str, exp: int) -> Optional[str]:
    normal = _server_ok(server)
    if normal is None or _loopback(normal):
        return None
    if re.fullmatch(r"[A-Z0-9]{4,32}", code) is None or not (0 < exp < 10**12):
        return None
    return f"r2mpos://pair?v=1&server={_enc(normal)}&code={code}&exp={exp}"


def _decode(value: str) -> str:
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        raise ValueError("bad percent escape")
    return unquote(value, errors="strict")


def parse_reference(text: str, now: int) -> dict:
    refused = {"outcome": "unrecognized"}
    text = text.strip()
    if not text or len(text) > 600 or text[: len(_PREFIX)].lower() != _PREFIX:
        return refused
    seen = {}
    for part in text[len(_PREFIX):].split("&"):
        if "=" not in part:
            continue
        key, _, value = part.partition("=")
        if key in ("v", "server", "code", "exp"):
            if key in seen:
                return refused
            seen[key] = value
    try:
        values = {k: _decode(v) for k, v in seen.items()}
    except (ValueError, UnicodeDecodeError):
        return refused
    if set(values) != {"v", "server", "code", "exp"} or values["v"] != "1":
        return refused
    server = _server_ok(values["server"])
    code = values["code"]
    if server is None or re.fullmatch(r"[A-Za-z0-9]{4,32}", code) is None:
        return refused
    if re.fullmatch(r"[0-9]{1,12}", values["exp"]) is None or int(values["exp"]) <= 0:
        return refused
    exp = int(values["exp"])
    if now > exp:
        return {"outcome": "expired"}
    return {"outcome": "valid", "server": server, "code": code.upper(), "exp": exp}


class TestGoldenQr:
    def test_the_golden_cases_are_the_bytes_pos_android_pins(self):
        data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
        assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256

    @pytest.mark.parametrize("case", _golden()["build"], ids=lambda c: c["name"])
    def test_what_the_dashboard_draws(self, case):
        assert build_reference(case["server"], case["code"], case["exp"]) == case["payload"]
        # And the till reads back exactly what was put in (the address as normalised).
        read = parse_reference(case["payload"], case["exp"] - 1)
        assert read == {
            "outcome": "valid", "server": case["server"].rstrip("/"), "code": case["code"], "exp": case["exp"],
        }

    @pytest.mark.parametrize("case", _golden()["refusedBuild"], ids=lambda c: c["name"])
    def test_what_the_dashboard_refuses_to_draw(self, case):
        assert case["payload"] is None
        assert build_reference(case["server"], case["code"], case["exp"]) is None

    @pytest.mark.parametrize("case", _golden()["parse"], ids=lambda c: c["name"])
    def test_what_the_till_decides(self, case):
        assert parse_reference(case["payload"], case["now"]) == case["result"]

    def test_the_fixture_covers_every_outcome_and_the_refusals_that_matter(self):
        outcomes = {c["result"]["outcome"] for c in _golden()["parse"]}
        assert outcomes == {"valid", "expired", "unrecognized"}
        names = " | ".join(c["name"] for c in _golden()["parse"])
        for needle in ("installer-phone", "newer version", "javascript", "credentials", "repeated", "milliseconds"):
            assert needle in names, needle


# ── One rule for a name ──────────────────────────────────────────────────────


class TestCleanName:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("קופה בר", "קופה בר"),
            ("  קופה   בר  ", "קופה בר"),
            ("בר\tפנימי\nשתיים", "בר פנימי שתיים"),
            ("a b", "a b"),
            ("", None),
            ("   ", None),
            (None, None),
            ("x" * MN.MACHINE_NAME_MAX, "x" * MN.MACHINE_NAME_MAX),
        ],
    )
    def test_trims_collapses_and_calls_blank_none(self, raw, expected):
        assert MN.clean_machine_name(raw) == expected

    def test_too_long(self):
        with pytest.raises(MN.MachineNameRefused) as e:
            MN.clean_machine_name("x" * (MN.MACHINE_NAME_MAX + 1))
        assert (e.value.status_code, e.value.body["detail"]) == (422, "name_too_long")
        assert "100" in e.value.body["message"]

    def test_the_length_is_counted_in_characters_not_bytes(self):
        assert MN.clean_machine_name("א" * MN.MACHINE_NAME_MAX) is not None
        assert MN.clean_machine_name("😀" * MN.MACHINE_NAME_MAX) is not None

    @pytest.mark.parametrize("raw", ["a\u0000b", "a​b", "a‮b", "a⁦b", "a\u007fb", "a﻿b"])
    def test_hidden_and_control_characters_are_refused(self, raw):
        with pytest.raises(MN.MachineNameRefused) as e:
            MN.clean_machine_name(raw)
        assert e.value.body["detail"] == "name_invalid"

    def test_a_till_may_not_blank_its_name(self):
        with pytest.raises(MN.MachineNameRefused) as e:
            MN.require_machine_name("   ")
        assert e.value.body["detail"] == "name_required"

    def test_the_default_name_is_the_register_label(self):
        assert MN.default_machine_name("4") == "קופה 4"
        assert MN.default_machine_name(None) is None
        assert MN.default_machine_name("") is None
        assert MN.default_machine_name("A1") is None

    def test_only_the_names_the_server_made_up_are_generated(self):
        assert MN.is_generated_name("POS Machine MACHINE-AB12CD34")
        assert not MN.is_generated_name("POS Machine MACHINE-ab12cd34")
        assert not MN.is_generated_name("POS Machine MACHINE-AB12CD3")
        assert not MN.is_generated_name("Nova 55F")
        assert not MN.is_generated_name("קופה 3")
        assert not MN.is_generated_name(None)

    def test_the_names_create_pos_machine_makes_are_generated_ones(self):
        # The generator and the pattern that recognises it must not drift apart.
        w = make_world()
        machine = P.create_pos_machine(w.db, distributor_id=w.admin.id, tenant_id=w.tenant.id)
        assert MN.is_generated_name(machine.name), machine.name


# ── The add-device form: the name rides on the code ──────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    # The counter row needs Postgres' ON CONFLICT; the number itself is not what is tested here.
    numbers = iter(range(10, 99))
    monkeypatch.setattr(
        register_number, "assign_register_number",
        lambda db, m: setattr(m, "pos_number", str(next(numbers))) if m.shop_id and m.is_fiscal else None,
    )
    world.db.commit()
    return world


def _generate(w, **body):
    return pairing_router.generate_pairing_code(
        body=PairingCodeGenerateRequest(**body), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _code(w, *, name=None, role=None, shop=True) -> PairingCode:
    code = PairingCode(
        id=uuid.uuid4(), code=f"N{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
        tenant_id=w.tenant.id, shop_id=w.shop.id if shop else None, device_role=role, machine_name=name,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


class TestGenerate:
    def test_the_name_is_optional_and_cleaned(self, w):
        assert _generate(w, deviceRole="till").machine_name is None
        assert _generate(w, deviceRole="till", name="   ").machine_name is None
        assert _generate(w, deviceRole="till", name="  קופה   בר ").machine_name == "קופה בר"
        assert PairingCodeGenerateRequest().name is None

    def test_the_response_says_it(self, w):
        out = PairingCodeResponse.model_validate(_generate(w, deviceRole="till", name="בר")).model_dump(by_alias=True)
        assert out["machineName"] == "בר"
        out = PairingCodeResponse.model_validate(_generate(w, deviceRole="till")).model_dump(by_alias=True)
        assert out["machineName"] is None

    def test_a_name_with_no_role_is_a_tills(self, w):
        assert _generate(w, name="בר").machine_name == "בר"

    def test_a_kiosk_or_a_screen_has_its_own_name_not_this_one(self, w):
        code = _generate(w, shopId=w.shop.id, deviceRole="order_status_board", name="בר")
        assert code.machine_name is None

    @pytest.mark.parametrize("name", ["x" * 101, "a​b", "a‮b"])
    def test_a_name_the_cloud_does_not_take_is_refused(self, w, name):
        with pytest.raises(ValidationError):
            PairingCodeGenerateRequest(name=name)


class TestRedeem:
    def test_the_name_from_the_form_is_the_machines(self, w):
        code = _code(w, name="קופה בר")
        machine = P.validate_pairing_code(w.db, code.code, {}, None)
        assert machine.name == "קופה בר"

    def test_it_wins_over_the_name_an_older_till_sends(self, w):
        code = _code(w, name="קופה בר")
        machine = P.validate_pairing_code(w.db, code.code, {}, "Nova 55F")
        assert machine.name == "קופה בר"

    def test_an_older_till_that_names_itself_keeps_its_name(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(w.db, code.code, {}, "Nova 55F")
        assert machine.name == "Nova 55F"

    def test_no_name_at_all_is_the_register_label_once_it_has_a_number(self, w):
        code = _code(w)
        machine = P.validate_pairing_code(w.db, code.code, {}, None)
        assert machine.pos_number is not None
        assert machine.name == f"קופה {machine.pos_number}"
        # Stored, not only returned.
        assert w.db.get(POSMachine, machine.id).name == f"קופה {machine.pos_number}"

    def test_without_a_shop_the_name_waits_for_the_number(self, w):
        code = _code(w, shop=False)
        machine = P.validate_pairing_code(w.db, code.code, {}, None)
        assert machine.pos_number is None and MN.is_generated_name(machine.name)
        # The dashboard puts it in a shop: now it has a number, and the name follows.
        assigned = pairing_router.assign_machine(
            str(machine.id), types_assign(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert assigned.name == f"קופה {assigned.pos_number}"

    def test_a_name_somebody_typed_is_never_renamed_on_assignment(self, w):
        code = _code(w, shop=False, name="בר פנימי")
        machine = P.validate_pairing_code(w.db, code.code, {}, None)
        assigned = pairing_router.assign_machine(
            str(machine.id), types_assign(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert assigned.name == "בר פנימי"

    def test_a_kiosk_is_not_a_register(self, w):
        machine = P.create_pos_machine(w.db, distributor_id=w.admin.id, tenant_id=w.tenant.id)
        machine.pos_number = "7"
        assert MN.settle_default_name(machine, role="kiosk") is False
        assert MN.is_generated_name(machine.name)

    def test_a_screen_has_no_number_to_be_named_by(self, w):
        machine = P.create_pos_machine(w.db, distributor_id=w.admin.id, tenant_id=w.tenant.id, is_fiscal=False)
        assert MN.settle_default_name(machine) is False

    def test_a_replacement_keeps_its_rows_name(self, w):
        till = w.tills[0]
        till.name = "קופה ראשית"
        code = _code(w)
        code.target_machine_id = till.id
        w.db.flush()
        machine = P.validate_pairing_code(w.db, code.code, {"model": "F20"}, None)
        assert machine.id == till.id and machine.name == "קופה ראשית"


def types_assign(shop_id):
    from app.schemas.pairing_code import MachineAssignRequest

    return MachineAssignRequest(shopId=shop_id)


# ── A till renaming itself ───────────────────────────────────────────────────


def _rename(w, machine, name, **extra):
    return sync_router.machine_set_name(
        str(machine.id), sync_router.MachineNameIn(name=name, **extra), machine=machine, db=w.db,
    )


def _events(w, machine):
    return w.db.query(TillEvent).filter(TillEvent.machine_id == machine.id, TillEvent.event_type == MN.RENAME_EVENT).all()


class TestTillRenamesItself:
    def test_the_name_is_stored_and_audited(self, w):
        till = w.tills[0]
        out = _rename(
            w, till, "  קופה   בר ", operatorId="u-1", approvedById="u-2", changedAt="2026-10-10T09:30:00+03:00",
        )
        assert out == {"name": "קופה בר", "previousName": "Till 1", "unchanged": False}
        assert w.db.get(POSMachine, till.id).name == "קופה בר"
        (event,) = _events(w, till)
        assert (event.tenant_id, event.shop_id, event.pos_user_id) == (till.tenant_id, till.shop_id, "u-1")
        assert event.details["from"] == "Till 1" and event.details["to"] == "קופה בר"
        assert event.details["approvedById"] == "u-2" and event.details["source"] == "till"
        assert event.details["tillChangedAt"].startswith("2026-10-10T09:30:00")

    def test_the_same_name_again_changes_nothing_and_writes_nothing(self, w):
        till = w.tills[0]
        assert _rename(w, till, "בר")["unchanged"] is False
        again = _rename(w, till, "  בר ")
        assert again == {"name": "בר", "previousName": "בר", "unchanged": True}
        assert len(_events(w, till)) == 1

    def test_last_write_wins(self, w):
        till = w.tills[0]
        _rename(w, till, "ראשון")
        _rename(w, till, "שני")
        assert w.db.get(POSMachine, till.id).name == "שני"
        assert [e.details["to"] for e in sorted(_events(w, till), key=lambda e: e.received_at or e.occurred_at)] == ["ראשון", "שני"]

    def test_the_dashboard_and_the_till_read_the_new_name(self, w):
        till = w.tills[0]
        _rename(w, till, "בר")
        assert machines_router.get_my_machine(machine=till)["machineName"] == "בר"

    @pytest.mark.parametrize(
        "name, code",
        [("   ", "name_required"), ("", "name_required"), ("x" * 101, "name_too_long"), ("a​b", "name_invalid")],
    )
    def test_a_name_the_cloud_does_not_take_is_refused_in_hebrew(self, w, name, code):
        till = w.tills[0]
        out = _rename(w, till, name)
        assert isinstance(out, JSONResponse) and out.status_code == 422
        body = json.loads(out.body)
        assert body["detail"] == code and re.search(r"[א-ת]", body["message"])
        assert w.db.get(POSMachine, till.id).name == "Till 1"
        assert _events(w, till) == []

    def test_a_screen_may_name_itself_too(self, w):
        screen = w.tills[1]
        screen.is_fiscal = False
        assert _rename(w, screen, "מסך גריל")["name"] == "מסך גריל"

    def test_it_is_a_machine_token_route(self):
        from fastapi.routing import APIRoute

        from app.main import app
        from app.middleware import auth

        route = next(
            r for r in app.routes
            if isinstance(r, APIRoute) and r.path.endswith("/sync/{machine_id}/name") and "PATCH" in r.methods
        )

        def calls(dependant, out):
            for d in dependant.dependencies:
                out.add(d.call)
                calls(d, out)
            return out

        found = calls(route.dependant, set())
        assert auth.get_pos_machine_from_sync_machine_token in found
        # Never the dashboard's own token: nobody at a desk renames a till through the till's path.
        assert auth.get_pos_machine_for_sync_path not in found


def test_a_machine_in_pairing_status_paired_has_a_name_too(w):
    machine = P.create_pos_machine(w.db, distributor_id=w.admin.id, tenant_id=w.tenant.id)
    assert machine.pairing_status == PairingStatus.PAIRED
    assert _rename(w, machine, "בר")["name"] == "בר"
