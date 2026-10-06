"""
Terminal configuration is never inherited onto an external pinpad (app/services/terminal_config_guard.py).

On 06.10.2026 the kiosk "קיוסק רויאל" logged "clearing server: SHVA → PELECARD waits for 1
untransmitted": the shop's `clearingServer` (meant for another till's terminal) was on its
way to the kiosk's network pinpad. For a kiosk — and any till that charges on an external
pinpad — the sync now sends `clearingServer`, `expectedTerminalNumber` and
`forceTerminalNumber` only from the machine's own layer, and says where each comes from.
"""
from __future__ import annotations

import pytest

from app.database import Base
from app.models.pos_machine import set_kiosk_cache
from app.routers import machines as machines_router
from app.routers import sync as sync_router
from app.services import settings_notify
from app.services import terminal_config_guard as G
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    if "sync_logs" in Base.metadata.tables:
        Base.metadata.tables["sync_logs"].create(world.db.get_bind(), checkfirst=True)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *_a, **_k: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return world


def _pull(w, till):
    return sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db)


def _shop_sets(w, **values):
    w.shop.settings = {**(w.shop.settings or {}), **values}
    w.db.commit()


# ── The pure rule ────────────────────────────────────────────────────────────


class _M:
    def __init__(self, kiosk=False, builtin=True, settings=None):
        self.is_kiosk = kiosk
        self.has_builtin_terminal = builtin
        self.settings = settings or {}


def test_who_charges_on_an_external_pinpad():
    assert G.charges_on_external_pinpad(_M(kiosk=True), {}) is True
    assert G.charges_on_external_pinpad(_M(builtin=False), {}) is True
    assert G.charges_on_external_pinpad(_M(), {"nayaxEnabled": True}) is True
    assert G.charges_on_external_pinpad(_M(), {"paymentIntegration": "zcredit"}) is True
    assert G.charges_on_external_pinpad(_M(), {}) is False


def test_an_inherited_value_is_dropped_for_an_external_pinpad_only():
    effective = {"clearingServer": "PELECARD", "expectedTerminalNumber": "1807770", "forceTerminalNumber": True}
    layers = [("shop", {"clearingServer": "PELECARD", "expectedTerminalNumber": "1807770", "forceTerminalNumber": True}),
              ("machine", {})]
    out, where = G.guard(effective, machine=_M(kiosk=True), merged=effective, layers=layers)
    assert "clearingServer" not in out and "expectedTerminalNumber" not in out
    assert out["forceTerminalNumber"] is False
    assert where == {"clearingServer": "shop", "expectedTerminalNumber": "shop", "forceTerminalNumber": "shop"}
    # A till with its own terminal keeps the shop's values, as before.
    kept, _ = G.guard(effective, machine=_M(), merged=effective, layers=layers)
    assert kept == effective


def test_the_machines_own_value_goes_out():
    effective = {"clearingServer": "SHVA", "forceTerminalNumber": False}
    layers = [("shop", {"clearingServer": "PELECARD"}), ("machine", {"clearingServer": "SHVA"})]
    out, where = G.guard(effective, machine=_M(kiosk=True), merged=effective, layers=layers)
    assert out["clearingServer"] == "SHVA"
    assert where["clearingServer"] == "machine"


# ── Through the till's sync ──────────────────────────────────────────────────


def test_the_kiosk_never_gets_the_shops_clearing_server(w):
    kiosk = w.tills[0]
    set_kiosk_cache(kiosk, True)
    _shop_sets(w, clearingServer="PELECARD", expectedTerminalNumber="1807770", forceTerminalNumber=True)
    out = _pull(w, kiosk)
    assert "clearingServer" not in out.settings
    assert "expectedTerminalNumber" not in out.settings
    assert out.settings["forceTerminalNumber"] is False
    assert out.terminal_config_sources == {
        "clearingServer": "shop", "expectedTerminalNumber": "shop", "forceTerminalNumber": "shop",
    }
    # Serialized for the till by alias.
    body = out.model_dump(by_alias=True)
    assert body["terminalConfigSources"]["clearingServer"] == "shop"


def test_the_kiosks_own_machine_value_is_sent(w):
    # The owner's stopgap: the kiosk's machine layer says SHVA, its pinpad's own server.
    kiosk = w.tills[0]
    set_kiosk_cache(kiosk, True)
    _shop_sets(w, clearingServer="PELECARD")
    kiosk.settings = {"clearingServer": "SHVA"}
    w.db.commit()
    out = _pull(w, kiosk)
    assert out.settings["clearingServer"] == "SHVA"
    assert out.terminal_config_sources["clearingServer"] == "machine"


def test_a_till_on_a_network_pinpad_is_guarded_too(w):
    till = w.tills[1]
    _shop_sets(w, clearingServer="PELECARD", nayaxEnabled=True, nayaxDeviceHost="192.168.0.167")
    out = _pull(w, till)
    assert "clearingServer" not in out.settings


def test_a_p18_is_guarded_too(w):
    till = w.tills[1]
    till.device_model = "P18"
    _shop_sets(w, clearingServer="PELECARD")
    w.db.commit()
    assert "clearingServer" not in _pull(w, till).settings


def test_a_till_with_its_own_terminal_still_inherits(w):
    till = w.tills[1]
    _shop_sets(w, clearingServer="PELECARD", expectedTerminalNumber="1807770", forceTerminalNumber=True)
    out = _pull(w, till)
    assert out.settings["clearingServer"] == "PELECARD"
    assert out.settings["expectedTerminalNumber"] == "1807770"
    assert out.settings["forceTerminalNumber"] is True
    assert out.terminal_config_sources["clearingServer"] == "shop"


def test_nothing_set_anywhere_sends_no_sources(w):
    out = _pull(w, w.tills[1])
    assert out.terminal_config_sources == {}
