"""
SynqPay terminals as till hardware (docs/SPEC_SYNQPAY.md §1.5, app/models/synqpay_devices.py):
the till runs ON the terminal and charges on its own reader, like an F20 — a terminal of its
own; its printer waits for SynqPay's SDK ("בקרוב"); recognised by the till's own report.
"""
from __future__ import annotations

import pytest

from app.models.pos_machine import DEVICE_MODELS, POSMachine, detect_device_model, device_capabilities
from app.models.synqpay_devices import SYNQPAY_DEVICE_MODEL_IDS, SYNQPAY_DEVICE_MODELS, detect_synqpay, synqpay_device_model
from app.schemas.device_profile import DeviceProfileIn
from app.schemas.pos_machine import POSMachineUpdate
from app.services import payment_integration as PI


def test_every_synqpay_model_is_a_device_model_with_a_terminal_of_its_own():
    for model_id in SYNQPAY_DEVICE_MODEL_IDS:
        assert model_id in DEVICE_MODELS
        assert len(model_id) <= 16  # pos_machines.device_model is String(16)
        caps = device_capabilities(model_id)
        assert caps["builtinTerminal"] is True, model_id
        # The head needs SynqPay's PAL (SDK-only): no receipts there yet, "בקרוב".
        assert (caps["builtinPrinter"], caps["driverPending"], caps["cashDrawerPort"]) == (False, True, False)
        assert POSMachine(device_model=model_id).has_builtin_terminal is True
    # A kiosk never charges on a terminal of its own, whatever the model.
    assert device_capabilities("SYNQPAY_DX8000", kiosk=True)["builtinTerminal"] is False


def test_each_maps_to_a_synqpay_model_the_settings_know():
    for row in SYNQPAY_DEVICE_MODELS:
        assert row.synqpay_model in PI.SYNQPAY_MODELS


@pytest.mark.parametrize(
    "info, expected",
    [
        ({"synqpay": "true", "model": "DX8000", "manufacturer": "Ingenico"}, "SYNQPAY_DX8000"),
        ({"synqpay": "true", "model": "Axium RX5000", "manufacturer": "INGENICO"}, "SYNQPAY_RX5000"),
        ({"synqpay": True, "model": "S1U2-M4", "manufacturer": "Castles"}, "SYNQPAY_S1U2_M4"),
        ({"synqpay": "true", "model": "X990", "manufacturer": "Verifone"}, "SYNQPAY_VERIFONE"),
        ({"synqpay": "true", "model": "T9", "manufacturer": "Acme"}, "SYNQPAY"),
        # Without SynqPay's app an Ingenico is not one of these.
        ({"model": "DX8000", "manufacturer": "Ingenico"}, None),
        ({"synqpay": "false", "model": "DX8000"}, None),
    ],
)
def test_detected_from_what_the_till_reports(info, expected):
    assert detect_synqpay(info) == expected
    if expected is not None:
        assert detect_device_model(info) == expected


def test_a_synqpay_report_wins_over_the_model_tables():
    # A SynqPay app on a device that would otherwise read as a P18 is still a SynqPay terminal.
    assert detect_device_model({"synqpay": "true", "model": "P18"}) == "SYNQPAY"
    assert synqpay_device_model("SYNQPAY_EX8000").synqpay_model == "ex8000"
    assert synqpay_device_model("N55F") is None


def test_the_dashboard_may_choose_one():
    assert POSMachineUpdate(deviceModel="SYNQPAY_DX8000").device_model == "SYNQPAY_DX8000"
    assert DeviceProfileIn(deviceModel="SYNQPAY").device_model == "SYNQPAY"


def test_automatic_on_a_synqpay_terminal_is_its_own_terminal():
    # The till charges on its built-in terminal (SynqPay on the device) as an F20 on Agamento.
    res = PI.resolve([("machine", {})], has_builtin_terminal=POSMachine(device_model="SYNQPAY_RX5000").has_builtin_terminal)
    assert (res.integration, res.automatic) == ("agamento", True)


def test_the_built_in_choice_is_named_synqpay_on_a_synqpay_terminal():
    from app.routers import payment_integration as pi_router

    on_synqpay = {o["value"]: o for o in pi_router._options(POSMachine(device_model="SYNQPAY_DX8000"))}
    assert on_synqpay["agamento"]["label"] == "מובנה — SynqPay במכשיר"
    assert on_synqpay["agamento"]["selectable"] is True
    on_55f = {o["value"]: o for o in pi_router._options(POSMachine(device_model="N55F"))}
    assert on_55f["agamento"]["label"] == PI.LABELS_HE["agamento"]


def test_an_external_synqpay_terminal_takes_the_network_pinpads_identity_rule():
    # docs/SPEC_SYNQPAY.md §2.1: expected number on the machine itself; card locked, not the till.
    from datetime import datetime, timezone

    from app.services.terminal_status import LOCK_MISMATCH, LOCK_NOT_CONFIGURED, LOCK_UNKNOWN, card_lock_of

    at = datetime(2026, 10, 6, tzinfo=timezone.utc)
    assert card_lock_of("synqpay", "0883198", "machine", False, "0883198", at) is None
    assert card_lock_of("synqpay", "0883198", "machine", False, "0884401", at) == LOCK_MISMATCH
    assert card_lock_of("synqpay", "0883198", "shop", False, "0883198", at) == LOCK_NOT_CONFIGURED
    assert card_lock_of("synqpay", "0883198", "machine", False, None, None) == LOCK_UNKNOWN
