"""
"קישור מסופון מחדש" — the till moves its own pinpad to a new address on its LAN
(`PUT /sync/{machine_id}/pinpad-host`, app/services/payment_terminal.py `relink_pinpad`).

The owner (07.10): the Royal kiosk's pinpad ("מגנום בר") got a new address from DHCP and the
kiosk stayed on "המסופון לא זמין". The kiosk now finds it again — on the technician screen, or
by itself when the same terminal answers at a new address — and writes the new address here,
with its machine token alone: nobody at a kiosk is a manager. So the endpoint is narrow:

* only `nayaxDeviceHost` / `nayaxDevicePort` on this machine's own layer — never `nayaxEnabled`,
  the path, another key, another till;
* only for a till already charging on a network Nayax pinpad with an address;
* only a private IPv4 address;
* a move the till made by itself only to its own terminal (`terminal_mismatch`);
* every move a till event (`pinpad_host_set`), a no-op none;
* a fiscal till write, machine token only (tests/test_display_devices.py classifies it).
"""
from __future__ import annotations

import json

import pytest

from app.models.audit_exception import TillEvent
from app.routers import sync as sync_router
from app.services import kiosk_ops
from app.services import payment_terminal as PT
from app.services import settings_notify
from shift_world import accept_str_uuids, make_world

ROYAL = {
    "nayaxEnabled": True,
    "clearingServer": "SHVA",
    "nayaxSpicyPath": "/SPICy",
    "nayaxDeviceHost": "192.168.0.167",
    "nayaxDevicePort": "8080",
    "expectedTerminalNumber": "1730030",
}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.woken = []
    monkeypatch.setattr(
        settings_notify, "notify_machine_settings",
        lambda _db, m, reason: world.woken.append((str(m.id), reason)),
    )
    world.kiosk = world.tills[0]
    world.kiosk.settings = dict(ROYAL)
    world.db.commit()
    return world


def _put(w, till=None, **body):
    till = till or w.kiosk
    out = sync_router.machine_set_pinpad_host(
        str(till.id), sync_router.PinpadHostIn.model_validate(body), machine=till, db=w.db,
    )
    if hasattr(out, "status_code") and hasattr(out, "body"):
        return out.status_code, json.loads(out.body)
    return 200, out


def _events(w):
    return w.db.query(TillEvent).filter(TillEvent.event_type == PT.PINPAD_HOST_EVENT).all()


def test_the_technicians_pick_moves_only_the_host_on_the_tills_own_layer(w):
    code, out = _put(w, host="192.168.0.171", reason="technician", terminalNumber="01730030", serial="N4C001")

    assert code == 200
    assert out == {
        "host": "192.168.0.171", "port": 8080, "previousHost": "192.168.0.167", "reason": "technician",
        "terminalMatches": True, "unchanged": False,
    }
    w.db.refresh(w.kiosk)
    # Only the host changed; every other key as it was.
    assert w.kiosk.settings == {**ROYAL, "nayaxDeviceHost": "192.168.0.171"}
    assert w.woken == [(str(w.kiosk.id), "pinpad_host")]
    (event,) = _events(w)
    assert event.machine_id == w.kiosk.id
    assert (event.details["from"], event.details["to"], event.details["reason"]) == ("192.168.0.167", "192.168.0.171", "technician")
    assert (event.details["terminalNumber"], event.details["serial"]) == ("01730030", "N4C001")


def test_a_port_is_written_only_when_given(w):
    code, out = _put(w, host="192.168.0.171", port=8443, reason="technician")
    assert code == 200 and out["port"] == 8443 and out["terminalMatches"] is None
    w.db.refresh(w.kiosk)
    assert (w.kiosk.settings["nayaxDeviceHost"], w.kiosk.settings["nayaxDevicePort"]) == ("192.168.0.171", "8443")


def test_a_move_the_till_made_by_itself_must_be_its_own_terminal(w):
    code, out = _put(w, host="192.168.0.180", reason="relocated", terminalNumber="9999999")
    assert (code, out["detail"]) == (409, "terminal_mismatch")
    code, out = _put(w, host="192.168.0.180", reason="relocated")
    assert (code, out["detail"]) == (422, "terminal_number_required")
    w.db.refresh(w.kiosk)
    assert w.kiosk.settings == ROYAL and _events(w) == []
    # Its own terminal: moved.
    code, out = _put(w, host="192.168.0.180", reason="relocated", terminalNumber="1730030", mac="aa:bb:cc:dd:ee:ff")
    assert code == 200 and out["terminalMatches"] is True
    (event,) = _events(w)
    assert (event.details["reason"], event.details["mac"]) == ("relocated", "aa:bb:cc:dd:ee:ff")


@pytest.mark.parametrize("host, detail", [
    ("8.8.8.8", "host_not_private"),
    ("pinpad.example.com", "host_not_private"),
    ("192.168.0.300", "host_invalid"),
    ("https://192.168.0.5", "host_invalid"),
])
def test_only_a_private_ipv4_address(w, host, detail):
    code, out = _put(w, host=host, reason="technician")
    assert (code, out["detail"]) == (422, detail)
    w.db.refresh(w.kiosk)
    assert w.kiosk.settings == ROYAL


def test_it_never_sets_up_a_pinpad_on_a_till_without_one(w):
    till = w.tills[1]  # a till charging on its own terminal: no pinpad, no address
    code, out = _put(w, till, host="192.168.0.171", reason="technician")
    assert (code, out["detail"]) == (409, "pinpad_not_in_use")
    w.db.refresh(till)
    assert not (till.settings or {}).get("nayaxDeviceHost")
    assert _events(w) == []


def test_the_same_address_again_changes_nothing(w):
    code, out = _put(w, host="192.168.0.167", port=8080, reason="relocated", terminalNumber="1730030")
    assert code == 200 and out["unchanged"] is True
    assert _events(w) == [] and w.woken == []


def test_an_unknown_reason_is_refused(w):
    code, out = _put(w, host="192.168.0.171", reason="dashboard")
    assert (code, out["detail"]) == (422, "reason_invalid")


def test_the_kiosks_moved_alert_reads_as_news_and_wakes_nobody(monkeypatch, w):
    import types

    text = kiosk_ops.alert_text("קיוסק רויאל", "terminal", "moved", {"address": "192.168.0.171:8080"})
    assert text == "קיוסק רויאל — המסופון עבר לכתובת חדשה (192.168.0.171:8080)"
    woken = []
    monkeypatch.setattr(kiosk_ops, "targets", lambda *a, **k: ["till-2"])
    monkeypatch.setattr(kiosk_ops, "_wake", lambda tills: woken.extend(tills))
    device = types.SimpleNamespace(name="קיוסק רויאל")
    moved = {"kind": "terminal", "key": "terminal:moved", "reason": "moved", "detail": {"address": "192.168.0.171:8080", "from": "192.168.0.167:8080"}}
    kiosk_ops.reconcile(w.db, w.kiosk, device, {}, [moved])
    assert woken == []  # informational: listed on the tills, nobody woken for it
    row = w.db.query(kiosk_ops.KioskAlert).filter(kiosk_ops.KioskAlert.key == "terminal:moved").one()
    assert (row.reason, row.text) == ("moved", text)
    # A real problem still wakes them.
    unreachable = {"kind": "terminal", "key": "terminal", "reason": "unreachable", "detail": {"address": "192.168.0.171:8080"}}
    kiosk_ops.reconcile(w.db, w.kiosk, device, {}, [moved, unreachable])
    assert woken == ["till-2"]
