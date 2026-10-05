"""
The till's network pinpad (app/services/payment_terminal.py).

* A P18 has no card terminal of its own (`device_has_builtin_terminal`); a 55F, a Modo
  and an unknown model do. `GET /machines/me` and the machines list say so.
* A till that needs a pinpad (no terminal of its own, or `nayaxEnabled`) and has no
  merged address is flagged on the machines list (`pinpadAddressMissing`).
* `PUT /sync/{machine_id}/payment-terminal` validates the address a manager typed at the
  till and writes the till's own settings layer, which the till then pulls.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.database import Base
from app.middleware.auth import CatalogActor
from app.models.pos_machine import device_has_builtin_terminal
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.services import payment_terminal as PT
from app.services import settings_notify
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    if "sync_logs" in Base.metadata.tables:
        Base.metadata.tables["sync_logs"].create(world.db.get_bind(), checkfirst=True)
    world.woken = []
    monkeypatch.setattr(
        settings_notify, "notify_machine_settings",
        lambda _db, m, reason: world.woken.append((str(m.id), reason)),
    )
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return world


def _actor():
    import uuid

    return CatalogActor(pos_user_id=uuid.uuid4())


def _put(w, till, **body):
    return sync_router.machine_set_payment_terminal(
        str(till.id), sync_router.PaymentTerminalIn(**body), machine=till, actor=_actor(), db=w.db,
    )


def _pulled(w, till):
    out = sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db)
    return out.settings


def _row(w, till):
    rows = {r["id"]: r for r in machines_router._enrich_machines_batch(list(w.tills), w.db)}
    return rows[till.id]


# ── Which tills have a terminal of their own ─────────────────────────────────


@pytest.mark.parametrize("model, expected", [("N55F", True), ("MODO", True), (None, True), ("P18", False)])
def test_only_a_p18_has_no_terminal_of_its_own(model, expected):
    assert device_has_builtin_terminal(model) is expected


def test_the_till_is_told_whether_it_has_a_terminal(w):
    till = w.tills[0]
    till.device_model = "P18"
    assert machines_router.get_my_machine(machine=till)["hasBuiltinTerminal"] is False
    till.device_model = None
    assert machines_router.get_my_machine(machine=till)["hasBuiltinTerminal"] is True


# ── The address ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, cleaned",
    [(" 192.168.1.20 ", "192.168.1.20"), ("C4-Pinpad.local", "c4-pinpad.local"), ("pinpad", "pinpad")],
)
def test_an_ipv4_address_or_a_host_name_is_accepted(raw, cleaned):
    assert PT.clean_pinpad_host(raw) == cleaned


@pytest.mark.parametrize(
    "raw, code",
    [
        ("", "host_required"),
        ("   ", "host_required"),
        (None, "host_required"),
        ("192.168.1.300", "host_invalid"),
        ("192.168.1", "host_invalid"),
        ("https://192.168.1.20", "host_invalid"),
        ("192.168.1.20:8080", "host_invalid"),
        ("pin pad", "host_invalid"),
        ("-pinpad", "host_invalid"),
        ("pinpad..local", "host_invalid"),
        ("a" * 254, "host_invalid"),
    ],
)
def test_anything_else_is_refused_with_a_reason(raw, code):
    with pytest.raises(PT.PinpadAddressError) as exc:
        PT.clean_pinpad_host(raw)
    assert exc.value.code == code


def test_port_and_path_default_to_spicys_own():
    assert PT.clean_pinpad_port(None) == 8080
    assert PT.clean_pinpad_path(None) == "/SPICy"
    assert PT.clean_pinpad_path("  ") == "/SPICy"
    assert PT.clean_pinpad_path("/TC") == "/TC"
    for bad in ("SPICy", "/a b", "/x?y=1", "/" + "a" * 100):
        with pytest.raises(PT.PinpadAddressError):
            PT.clean_pinpad_path(bad)
    for bad in (0, 65536, True):
        with pytest.raises(PT.PinpadAddressError):
            PT.clean_pinpad_port(bad)


def test_the_request_refuses_a_port_out_of_range():
    with pytest.raises(ValidationError):
        sync_router.PaymentTerminalIn(host="10.0.0.5", port=0)
    with pytest.raises(ValidationError):
        sync_router.PaymentTerminalIn(host="10.0.0.5", port=70000)


# ── PUT /sync/{machine_id}/payment-terminal ──────────────────────────────────


def test_the_address_lands_on_the_tills_own_layer_and_reaches_the_till(w):
    till, other = w.tills
    out = _put(w, till, host=" 192.168.1.20 ")
    assert out == {"nayaxEnabled": True, "host": "192.168.1.20", "port": 8080, "path": "/SPICy"}
    assert till.settings == {
        "nayaxEnabled": True,
        "nayaxDeviceHost": "192.168.1.20",
        "nayaxDevicePort": "8080",
        "nayaxSpicyPath": "/SPICy",
    }
    assert till.settings_updated_at is not None
    assert w.woken == [(str(till.id), "payment_terminal")]

    pulled = _pulled(w, till)
    assert pulled["nayaxEnabled"] is True
    assert (pulled["nayaxDeviceHost"], pulled["nayaxDevicePort"], pulled["nayaxSpicyPath"]) == (
        "192.168.1.20", "8080", "/SPICy",
    )
    # The other till of the shop is not touched.
    assert "nayaxDeviceHost" not in _pulled(w, other)


def test_a_port_and_path_are_kept_and_other_settings_survive(w):
    till = w.tills[0]
    till.settings = {"tipPresets": [10, 15]}
    w.db.commit()
    _put(w, till, host="c4.local", port=8443, path="/TC")
    assert till.settings["tipPresets"] == [10, 15]
    assert (till.settings["nayaxDevicePort"], till.settings["nayaxSpicyPath"]) == ("8443", "/TC")


def test_a_bad_address_is_a_422_and_writes_nothing(w):
    till = w.tills[0]
    with pytest.raises(HTTPException) as exc:
        _put(w, till, host="192.168.1.999")
    assert (exc.value.status_code, exc.value.detail) == (422, "host_invalid")
    assert not till.settings
    assert w.woken == []


def test_a_till_without_a_shop_cannot_set_one(w):
    till = w.tills[0]
    till.shop_id = None
    with pytest.raises(HTTPException) as exc:
        _put(w, till, host="10.0.0.5")
    assert exc.value.status_code == 400


# ── The machines list ────────────────────────────────────────────────────────


def test_a_p18_without_an_address_is_flagged_until_it_has_one(w):
    p18, n55f = w.tills
    p18.device_model = "P18"
    w.db.commit()
    row = _row(w, p18)
    assert row["hasBuiltinTerminal"] is False
    assert (row["pinpadRequired"], row["pinpadAddressMissing"], row["pinpadHost"]) == (True, True, None)
    # A 55F with nothing set needs none.
    plain = _row(w, n55f)
    assert (plain["hasBuiltinTerminal"], plain["pinpadRequired"], plain["pinpadAddressMissing"]) == (True, False, False)

    _put(w, p18, host="192.168.1.20")
    row = _row(w, p18)
    assert (row["pinpadAddressMissing"], row["pinpadHost"], row["pinpadPort"]) == (False, "192.168.1.20", "8080")


def test_nayax_enabled_without_an_address_on_a_shop_flags_its_tills(w):
    w.shop.settings = {"nayaxEnabled": True}
    w.db.commit()
    row = _row(w, w.tills[0])
    assert (row["pinpadEnabled"], row["pinpadRequired"], row["pinpadAddressMissing"]) == (True, True, True)
    w.shop.settings = {"nayaxEnabled": True, "nayaxDeviceHost": "  "}
    w.db.commit()
    assert _row(w, w.tills[0])["pinpadAddressMissing"] is True
    w.shop.settings = {"nayaxEnabled": True, "nayaxDeviceHost": "10.0.0.7"}
    w.db.commit()
    assert _row(w, w.tills[0])["pinpadAddressMissing"] is False
