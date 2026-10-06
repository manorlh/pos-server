"""
The shop-wide daily pickup sequence of the self-order kiosks (`pickup.scope = "shop"`).

Every kiosk of a shop draws its order's pickup number from one counter per (shop,
business date). A kiosk asks with its own order key, so a retry after a lost answer gets
the same number back (`kiosk_pickup_allocations`, unique per shop + date + key). After
`max` the sequence wraps to `start`. Offline, the kiosk falls back to its own sequence
("kiosk" scope) — that is the till's business, not this module's.

Concurrency: on Postgres the counter row is created with `INSERT … ON CONFLICT DO NOTHING`
and then read `FOR UPDATE`, so two kiosks asking at once serialise on it and never get the
same number. SQLite (the tests) ignores the lock; its writes are serialised anyway. A
same-key race that still slips through hits the allocation's unique constraint, and the
caller (the router) retries, finding the first allocation.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kiosk import KioskPickupAllocation, KioskPickupCounter


def pickup_label(prefix: Optional[str], number: int) -> str:
    """The printed pickup label: "A-17" with prefix "A", plain "17" without one."""
    prefix = (prefix or "").strip()
    return f"{prefix}-{number}" if prefix else str(number)


def next_number(last_number: Optional[int], start: int, max_number: int) -> int:
    """The number after `last_number` in [start, max]: a fresh day starts at `start`, `max` wraps."""
    if last_number is None or last_number < start or last_number >= max_number:
        return start
    return last_number + 1


@dataclass
class Allocation:
    number: int
    label: str
    created: bool


def _existing(db: Session, shop_id, business_date: date, order_key: str) -> Optional[KioskPickupAllocation]:
    return (
        db.query(KioskPickupAllocation)
        .filter(
            KioskPickupAllocation.shop_id == shop_id,
            KioskPickupAllocation.business_date == business_date,
            KioskPickupAllocation.order_key == order_key,
        )
        .first()
    )


def counter_upsert_statement(shop_id, business_date: date):
    """Postgres: create the day's counter row if missing, never failing on a concurrent create."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    return (
        pg_insert(KioskPickupCounter.__table__)
        .values(shop_id=shop_id, business_date=business_date, last_number=0)
        .on_conflict_do_nothing(index_elements=["shop_id", "business_date"])
    )


def counter_lock_query(db: Session, shop_id, business_date: date):
    """The day's counter row, `SELECT … FOR UPDATE` (serialises concurrent allocations)."""
    return (
        db.query(KioskPickupCounter)
        .filter(KioskPickupCounter.shop_id == shop_id, KioskPickupCounter.business_date == business_date)
        .with_for_update()
        .populate_existing()
    )


def _locked_counter(db: Session, shop_id, business_date: date) -> KioskPickupCounter:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(counter_upsert_statement(shop_id, business_date))
    counter = counter_lock_query(db, shop_id, business_date).first()
    if counter is None:
        counter = KioskPickupCounter(shop_id=shop_id, business_date=business_date, last_number=0)
        db.add(counter)
        db.flush()
    return counter


def allocate(
    db: Session,
    *,
    shop_id,
    business_date: date,
    order_key: str,
    start: int,
    max_number: int,
    prefix: str = "",
    machine_id=None,
) -> Allocation:
    """
    The pickup number for this order key in the shop's sequence of that day. Idempotent
    per (shop, date, key): asking again returns the first answer, even if the kiosk's
    prefix or range changed since. The caller commits.
    """
    found = _existing(db, shop_id, business_date, order_key)
    if found is not None:
        return Allocation(found.number, found.label, False)
    counter = _locked_counter(db, shop_id, business_date)
    # Another request with the same key may have allocated while we waited for the lock.
    found = _existing(db, shop_id, business_date, order_key)
    if found is not None:
        return Allocation(found.number, found.label, False)
    number = next_number(counter.last_number, start, max_number)
    counter.last_number = number
    label = pickup_label(prefix, number)
    db.add(
        KioskPickupAllocation(
            id=uuid.uuid4(),
            shop_id=shop_id,
            business_date=business_date,
            order_key=order_key,
            number=number,
            label=label,
            machine_id=machine_id,
        )
    )
    db.flush()
    return Allocation(number, label, True)
