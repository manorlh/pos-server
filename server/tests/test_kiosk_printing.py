"""
The kiosk's printing, as the owner asked on 07.10.2026 after testing the Royal kiosk — the cloud's part:

* "בון מטבח במדפסת הקיוסק" (`printing.bonOnKiosk`) — in test_kiosks.py with the rest of the config.
* "שוברי פריט" — the till parameter `itemTicketMode` above each product's ticket mode
  (app/services/item_ticket.py), the same words and rule as the devices (item_ticket_cases.json,
  shared with kiosk-desktop and pos-android).
* Where a printer is set (`scope`), so a till's own receipt printer wins over the shop's.
* Every document copy the cloud renders says where it was issued: "סניף הרצליה · קופה 3 · קיוסק רויאל"
  (receipt_place_cases.json, the same bytes in pos-android and kiosk-desktop).
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import uuid
from types import SimpleNamespace

from app.services import item_ticket as IT
from app.services import print_documents as PD
from app.services import printers as K
from app.services.till_parameters import BUILTIN_PARAMETERS

TESTS = pathlib.Path(__file__).resolve().parent
REPO = TESTS.parent.parent
PLACE_FIXTURE = TESTS / "fixtures" / "receipt_place_cases.json"
DESKTOP_FIXTURES = REPO / "kiosk-desktop" / "test" / "fixtures"
ITEM_TICKETS_FIXTURE = DESKTOP_FIXTURES / "item_ticket_cases.json"

#: The LF-normalised SHA-256 the Android and Windows tests pin too.
PLACE_SHA256 = "eab9011b51428a3f797ffb7df3792a2a6e103b1dcd7450667fa8c63cdd7d2a4f"
ITEM_TICKETS_SHA256 = "a743a959ea2942cfb7a8534c91815b1e780e4f78921553465bb2c941d9cd09f7"


def _text(path: pathlib.Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── The place line ─────────────────────────────────────────────────────────────


def test_the_place_line_is_the_devices_one():
    text = _text(PLACE_FIXTURE)
    assert _sha(text) == PLACE_SHA256
    # The Windows kiosk's copy is the same file.
    assert _text(DESKTOP_FIXTURES / "receipt_place_cases.json") == text
    for case in json.loads(text)["cases"]:
        assert PD.place_line(case["shopName"], case["posNumber"], case["deviceName"]) == case["line"], case["name"]


def test_the_document_copy_carries_the_place_under_the_business(monkeypatch):
    machine = SimpleNamespace(pos_number="3", name="קיוסק רויאל")
    tx = SimpleNamespace(shop=object(), document_type=320, pos_number=None, machine=machine)
    monkeypatch.setattr(PD, "snapshot_header", lambda db, shop: {
        "businessName": "רויאל ספיריט", "vatNumber": "515555555", "shopName": "הרצליה", "branchId": "7",
    })
    name, lines = PD._header(None, tx)
    assert name == "רויאל ספיריט"
    assert lines[-1] == "סניף הרצליה · קופה 3 · קיוסק רויאל · מס׳ סניף 7"
    # The document's own till number wins over the machine's today.
    tx.pos_number = "12"
    assert PD._header(None, tx)[1][-1].startswith("סניף הרצליה · קופה 12 · ")
    # Nothing known: no line.
    monkeypatch.setattr(PD, "snapshot_header", lambda db, shop: {"businessName": "X"})
    assert PD._header(None, SimpleNamespace(shop=None, document_type=320, pos_number=None, machine=None))[1] == []


# ── "שוברי פריט" ─────────────────────────────────────────────────────────────────


def test_the_item_ticket_parameter_is_built_in_with_the_devices_words():
    text = _text(ITEM_TICKETS_FIXTURE)
    assert _sha(text) == ITEM_TICKETS_SHA256
    fixture = json.loads(text)
    spec = next(p for p in BUILTIN_PARAMETERS if p.key == IT.DEVICE_PARAMETER_KEY)
    assert spec.key == fixture["parameter"]["key"] == "itemTicketMode"
    assert spec.label == "שוברי פריט"
    assert spec.value_type == "enum"
    assert list(spec.enum_options) == fixture["parameter"]["options"]
    assert spec.default_value == fixture["parameter"]["default"] == IT.DEVICE_BY_PRODUCT


def test_the_device_rule_matches_the_devices():
    fixture = json.loads(_text(ITEM_TICKETS_FIXTURE))
    word_of = {c["setting"]: c["value"] for c in fixture["settings"] if c["value"] in IT.DEVICE_OPTIONS}
    assert set(word_of) == {"by_product", "off", "per_unit", "per_line", "per_sale"}
    for case in fixture["override"]:
        got = IT.device_mode(case["product"], word_of[case["setting"]])
        assert got == case["mode"], case
    # Unknown or unset: by the product.
    assert IT.device_mode("per_line", None) == "per_line"
    assert IT.device_mode("per_line", "משהו אחר") == "per_line"
    assert IT.device_mode(None, IT.DEVICE_PER_UNIT) == "off"


# ── Where a printer is set ─────────────────────────────────────────────────────


def test_printer_scope():
    assert K.printer_scope(SimpleNamespace(machine_id=uuid.uuid4(), area_id=None)) == "machine"
    assert K.printer_scope(SimpleNamespace(machine_id=None, area_id=uuid.uuid4())) == "area"
    assert K.printer_scope(SimpleNamespace(machine_id=None, area_id=None)) == "shop"
