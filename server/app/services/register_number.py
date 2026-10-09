"""
Per-shop register numbers: Dizengoff has tills 1, 2, 3; Ramat Aviv has 1, 2.

`pos_machines.pos_number` is what a document says it was issued on — `transactions`
copies it at sync time — so it has to name one physical till for as long as that
document exists. Three rules follow, and each one is easy to lose:

* **Never reused.** Numbers come from a per-shop counter that only moves forward. When a
  shop's top till is retired or removed its number stays spent; `max(pos_number) + 1`
  would hand it to the next till, and "register 3" would then mean two machines.
* **Rollback-safe.** The counter row is incremented under `SELECT … FOR UPDATE` inside
  the transaction that assigns the number, exactly like `z_sequence`. A pairing that
  fails rolls its number back with it; a Postgres SEQUENCE would burn it.
* **Belongs to the current shop.** A number is only meaningful inside a shop's run, so a
  machine that changes shop gives its number up (it stays spent in the old shop) and
  draws the new shop's next one. Every write of `POSMachine.shop_id` therefore goes
  through `set_machine_shop`, which is what keeps "a machine that already has a number
  keeps it" true: a non-null `pos_number` is always a number from the current shop.

A replacement for a dead till is the *same register*. `adopt_machine` hands the new
device the existing row, so the number survives without being copied anywhere.

A display device — a KDS screen or the "מוכן / לא מוכן" board — is not a register at all
(`pos_machines.is_fiscal` false, app/services/display_devices.py): it never draws a
number, nor a document prefix, in any shop.
"""
from __future__ import annotations

import uuid
from typing import Optional, Union

from sqlalchemy import BigInteger, cast, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop_register_sequence import (
    DEFAULT_SHOP_REGISTER_SEQUENCE_START,
    ShopRegisterSequence,
)
from app.models.transaction import Transaction

ShopId = Union[uuid.UUID, str, None]

#: What counts as a register number when reading one back. Bounded so a cast to
#: BIGINT can never overflow on some hand-entered value.
_NUMERIC = "^[0-9]{1,9}$"


def _same_shop(a: ShopId, b: ShopId) -> bool:
    """UUID and its string form are the same shop; callers pass either."""
    if a is None or b is None:
        return a is None and b is None
    try:
        return uuid.UUID(str(a)) == uuid.UUID(str(b))
    except ValueError:
        return str(a) == str(b)


def _highest_issued(db: Session, shop_id: ShopId) -> int:
    """
    The number to continue from when a shop has no counter row yet.

    Only a safety net: the migration seeds a counter for every shop that has numbered
    machines, and every allocation creates one. It reads back both the machines and the
    documents, because a document is the record that a number was used — a machine that
    has since moved away no longer carries it, but its receipts still do.
    """
    highest = 0
    for column, owner in (
        (POSMachine.pos_number, POSMachine.shop_id),
        (Transaction.pos_number, Transaction.shop_id),
    ):
        value = (
            db.query(func.max(cast(column, BigInteger)))
            .filter(owner == shop_id, column.op("~")(_NUMERIC))
            .scalar()
        )
        if value is not None and int(value) > highest:
            highest = int(value)
    return highest + 1 if highest else DEFAULT_SHOP_REGISTER_SEQUENCE_START


def _locked_counter(db: Session, shop_id: ShopId) -> ShopRegisterSequence:
    """
    The shop's counter row, locked for the rest of the transaction.

    A missing row is created with `ON CONFLICT DO NOTHING` and then read back under the
    lock, so two tills paired into a brand-new shop at the same moment serialise on the
    row instead of one of them failing on the primary key.
    """
    row = (
        db.query(ShopRegisterSequence)
        .filter(ShopRegisterSequence.shop_id == shop_id)
        .with_for_update()
        .first()
    )
    if row is not None:
        return row

    db.execute(
        pg_insert(ShopRegisterSequence)
        .values(shop_id=shop_id, next_value=_highest_issued(db, shop_id))
        .on_conflict_do_nothing(index_elements=["shop_id"])
    )
    return (
        db.query(ShopRegisterSequence)
        .filter(ShopRegisterSequence.shop_id == shop_id)
        .with_for_update()
        .one()
    )


def peek_next_register_number(db: Session, shop_id: ShopId) -> int:
    """
    The number the shop's next till would get, **without** taking it.

    For prefilling "קופה 3" in a pairing form. No lock and no write: reading this must
    never advance the counter, or opening and cancelling a dialog would leave a hole in
    the shop's numbering. It is a forecast — another till paired first gets this number
    and the next one gets the one after.
    """
    row = (
        db.query(ShopRegisterSequence)
        .filter(ShopRegisterSequence.shop_id == shop_id)
        .first()
    )
    if row is not None:
        return int(row.next_value)
    return _highest_issued(db, shop_id)


def assign_register_number(db: Session, machine: POSMachine) -> Optional[str]:
    """
    Give `machine` its shop's next register number, or keep the one it has.

    Idempotent: a machine that already has a number keeps it, so calling this on a
    re-pair, a replacement or a repeated assignment never advances the shop's run. That
    is only sound because `set_machine_shop` clears the number whenever the shop
    changes — a number that is present always belongs to the current shop.

    A machine with no shop has no number, nor has a display device (not a till). Must be
    called inside the transaction that persists the machine; the caller commits.
    """
    if machine.shop_id is None or getattr(machine, "is_fiscal", True) is False:
        machine.pos_number = None
        return None
    if machine.pos_number is not None:
        return machine.pos_number

    row = _locked_counter(db, machine.shop_id)
    assigned = int(row.next_value)
    row.next_value = assigned + 1
    machine.pos_number = str(assigned)
    db.flush()
    return machine.pos_number


def set_machine_shop(db: Session, machine: POSMachine, shop_id: ShopId) -> Optional[str]:
    """
    Put `machine` in `shop_id` (or in no shop) and settle its register number.

    The one way `POSMachine.shop_id` is written. Moving shop releases the old number —
    it stays spent in the old shop's run, because that shop's counter never goes back —
    and draws the new shop's next one. Setting the shop it is already in changes
    nothing, so a till re-assigned to its own shop is still the same register.

    The till's area goes with its old shop for the same reason: an area is one shop's,
    so a till that leaves the shop leaves the area (`area.shop_id == machine.shop_id`).
    Its past shifts keep their stamped area.

    So does its "קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): one chosen in the old shop
    is given up, and the till starts from the new shop's default — its new register
    number, or the lowest free prefix when that number is already held there
    (`document_prefix.settle_default`). Its documents keep the prefix frozen on them.
    """
    if not _same_shop(machine.shop_id, shop_id):
        machine.shop_id = shop_id
        # A till holding a voucher batch offline (the production vouchers contract §7) loses it with
        # its shop — never downloads vouchers it may no longer redeem (review 09.10).
        # Never a reason to fail the move itself: the device's next download / sync drops them too.
        try:
            from app.services.prepaid_voucher_offline import released_on_machine_move

            released_on_machine_move(db, machine)
        except Exception:  # noqa: BLE001
            import logging

            logging.getLogger(__name__).exception("machine %s moved: its offline assignments were not released now",
                                                  getattr(machine, "id", None))
        machine.pos_number = None
        if getattr(machine, "document_prefix", None) is not None:
            machine.document_prefix = None
        if getattr(machine, "area_id", None) is not None:
            from app.services.areas import set_machine_area

            set_machine_area(machine, None)
    number = assign_register_number(db, machine)
    if getattr(machine, "is_fiscal", True) is False:
        # A display device issues no documents: no prefix either.
        machine.document_prefix = None
        return number
    from app.services.document_prefix import settle_default

    settle_default(db, machine)
    return number

