"""
The Windows kiosk (`kiosk-desktop/`) speaks the till sync API like any till. What it SENDS is
pinned as golden fixtures — built by its own code (kiosk-desktop/test/syncContract.test.ts writes
them; the same bytes are kept here in tests/fixtures/kiosk_desktop/ and that test checks both
copies are equal) — and validated here against the server's own schemas and rules:

  - a card sale (320) and a declined one (cancelled, number kept): each document validates on its
    own (`validate_documents`), with no reference dropped, and its tender legs reconcile with the
    collectable amount (tips apart);
  - the shift open and close (with the open repeated, the till's own X);
  - the kiosk orders.

No database: pure schema and rule checks.
"""

from __future__ import annotations

import json
import pathlib
from typing import get_args

import pytest
from pydantic import ValidationError

from app.schemas.kiosk import KioskOrderIn, KioskOrdersIn
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services.tenders import expected_tender_total, reconciliation_error
from app.services.transactions import validate_documents

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "kiosk_desktop"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", ["transaction_card_sale_320", "transaction_cancelled_320"])
def test_documents_validate_one_by_one_without_dropping_a_link(name):
    env = TransactionsBatchEnvelope.model_validate(load(name))
    valid, rejected, unidentified = validate_documents(env.transactions)
    assert rejected == [] and unidentified == []
    assert len(valid) == 1
    _, tx, warnings = valid[0]
    assert warnings == []
    assert tx.document_type == 320
    # The bare counter goes on the wire; the prefix apart ("קידומת מסמכים").
    assert tx.transaction_number == "57"
    assert tx.document_prefix == "4"
    assert tx.cashier_id.startswith("kiosk:")


def test_the_card_leg_reconciles_and_the_tip_stays_out_of_it():
    env = TransactionsBatchEnvelope.model_validate(load("transaction_card_sale_320"))
    (_, tx, _), = validate_documents(env.transactions)[0]
    expected = expected_tender_total(
        total_amount=tx.total_amount,
        document_discount=tx.document_discount,
        document_type=tx.document_type,
        refund_of_transaction_id=tx.refund_of_transaction_id,
    )
    assert reconciliation_error(expected, [p.amount for p in tx.payments]) is None
    assert [p.method for p in tx.payments] == ["card"]
    # VAT once per document, prices include it.
    assert tx.net_amount + tx.vat_amount == tx.total_amount - (tx.document_discount or 0)
    # The terminal's uid rides on the leg's meta: the day's transmission matches the legs by it.
    meta = tx.payments[0].nayax_meta
    meta = json.loads(meta) if isinstance(meta, str) else meta
    assert meta["uid"]


def test_a_declined_sale_keeps_its_number_and_carries_no_tender():
    env = TransactionsBatchEnvelope.model_validate(load("transaction_cancelled_320"))
    (_, tx, _), = validate_documents(env.transactions)[0]
    assert tx.status == "cancelled"
    assert tx.payments == []


def test_the_shift_open_and_close_validate():
    opened = ShiftOpenIn.model_validate(load("shift_open"))
    closed = ShiftCloseIn.model_validate(load("shift_close"))
    assert closed.till and closed.till["transactionsCount"] == 1
    assert closed.unattended is False
    assert str(closed.counted_cash) in {"0", "0.0", "0.00"}
    # The open is repeated in the close, so a close whose open was lost still lands.
    assert closed.sequence_number == opened.sequence_number
    assert closed.opened_by_user_id == opened.opened_by_user_id


def test_the_kiosk_orders_validate():
    body = KioskOrdersIn.model_validate(load("kiosk_orders"))
    orders = [KioskOrderIn.model_validate(o) for o in body.orders]
    assert orders[0].pickup_label == "A-17"
    assert orders[0].transaction_number == "40000057"


def _literal_values(field: str) -> set:
    return set(get_args(KioskOrderIn.model_fields[field].annotation))


def test_the_kiosk_orders_cover_every_state_the_server_takes():
    """
    Every receipt / bon state and order status, each one validated by the server: the Windows
    kiosk once sent receipt "none" / "queued", which this schema refuses, and those orders were
    sent again on every sync, forever (PARITY.md gap 4). The Android kiosk sends the same values
    (domain/KioskOrders.kt KioskReceiptStatus / KioskBonStatus).
    """
    orders = [KioskOrderIn.model_validate(o) for o in load("kiosk_orders")["orders"]]
    assert {o.receipt_status for o in orders} == _literal_values("receipt_status")
    assert {o.bon_status for o in orders} == _literal_values("bon_status")
    assert {o.status for o in orders} == _literal_values("status")
    assert {o.fulfillment_mode for o in orders} == {"BON", "KDS"}
    assert {o.service_type for o in orders} == {"take_away", "eat_in"}


def test_a_refused_receipt_value_is_still_refused():
    """The kiosk maps the old values itself; the server's vocabulary does not widen for them."""
    raw = dict(load("kiosk_orders")["orders"][0], receiptStatus="none")
    with pytest.raises(ValidationError):
        KioskOrderIn.model_validate(raw)


def test_the_kds_release_is_the_kitchen_engines_and_idempotent_by_the_document():
    """A paid KDS-mode order of the Windows kiosk (kiosk-desktop src/main/kiosk/kdsRelease.ts)."""
    import hashlib
    import uuid

    from app.schemas.kds import KdsReleaseIn

    body = KdsReleaseIn.model_validate(load("kds_release"))
    assert (body.source, body.trigger, body.paid) == ("kiosk", "payment", True)
    assert body.pickup_number == 17 and body.transaction_number == "40000057"
    assert [i.line_key for i in body.items] == ["l1:0", "l2:0"]
    # Java's UUID.nameUUIDFromBytes of "kds-release:sale:<document>" — the till's derivation too.
    raw = bytearray(hashlib.md5(f"kds-release:sale:{body.source_ref}".encode("utf-8")).digest())
    raw[6] = (raw[6] & 0x0F) | 0x30
    raw[8] = (raw[8] & 0x3F) | 0x80
    assert body.id == str(uuid.UUID(bytes=bytes(raw)))


def test_the_kiosk_part_of_a_local_shop_z_is_the_clouds_own_computation():
    """
    The Windows kiosk's answer to the main till's local shop Z (`POST shop-z/remote-part`,
    kiosk-desktop src/main/fiscal/shopZPart.ts, PARITY.md gap 5): the section the main till prints
    and uploads, with its manifest. The manifest must be the one the cloud computes over the same
    documents as it ingests them (`shop_z_manifest.manifest_of` of the kiosk's own wire, the card
    sale fixture above), and the printed section must be its manifest — so `verify` can only find
    the paper and the cloud the same.
    """
    from types import SimpleNamespace

    from app.services import shop_z_manifest as M
    from app.services.local_shop_z import REMOTE_FINAL_OUTCOMES, LocalShopZTill, _paper_vs_manifest

    report = load("shop_z_remote_part")
    assert report["outcome"] in REMOTE_FINAL_OUTCOMES
    section = report["section"]
    part = LocalShopZTill.model_validate(section)
    assert [str(s) for s in part.shift_ids] == [report["shiftId"]]

    env = TransactionsBatchEnvelope.model_validate(load("transaction_card_sale_320"))
    (_, tx, _), = validate_documents(env.transactions)[0]
    row = SimpleNamespace(
        id=tx.id, transaction_number=tx.transaction_number, document_type=tx.document_type,
        status=tx.status, refund_of_transaction_id=tx.refund_of_transaction_id,
        total_amount=tx.total_amount, document_discount=tx.document_discount, vat_amount=tx.vat_amount,
        tip_amount=tx.tip_amount, payment_method=tx.payment_method,
    )
    legs = [SimpleNamespace(method=p.method, amount=p.amount) for p in tx.payments]
    cloud = M.manifest_of([M.canonical_of_row(row, legs)])
    printed = dict(section["manifest"])
    assert printed.pop("machineId") == report["machineId"]
    assert printed.pop("shiftIds") == section["shiftIds"]
    assert M.compare(printed, cloud) == []
    assert printed == cloud
    assert _paper_vs_manifest(section["report"], cloud) == []
    # A kiosk's part says so, with its system operator (SPEC_INDEPENDENT_TILL §8.13).
    assert section["report"]["deviceRole"] == "kiosk"
    assert section["report"]["operator"]["id"].startswith("kiosk:")
