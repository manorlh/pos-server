"""
Per-shop Z-report numbering.

A Z report already has a globally unique `id`, but a UUID is not something a bookkeeper
can read off a report and check against the one before it. This gives each shop its own
gapless run of Z numbers — 1, 2, 3 … — so "shop X's Z 47" names a document, and a
missing number means a missing close rather than nothing at all.

Two properties matter and both are easy to lose:

* **Gapless.** Allocated by incrementing a locked row inside the same transaction that
  inserts the Z, so a rolled-back close un-allocates its number. A Postgres SEQUENCE
  would be simpler and wrong: `nextval()` is non-transactional and a failed close would
  leave a hole indistinguishable from a lost Z.
* **Allocated once.** `apply_z_report` returns early on a duplicate close, so a retried
  close reuses the number already stored rather than drawing a new one. A till that
  retries because it never saw the acknowledgement must not advance the shop's numbering.
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy.orm import Session

from app.models.shop_z_sequence import DEFAULT_SHOP_Z_SEQUENCE_START, ShopZSequence
from app.models.z_report import ZReport


def _highest_existing(db: Session, shop_id: uuid.UUID) -> int:
    """
    The number to continue from when a shop has no counter row yet.

    Reads the Z reports rather than assuming 1, so a shop whose numbers were backfilled
    by migration — or whose counter row was somehow lost — continues its run instead of
    reissuing numbers that are already printed against other closes.
    """
    highest = (
        db.query(ZReport.shop_sequence_number)
        .filter(
            ZReport.shop_id == shop_id,
            ZReport.shop_sequence_number.isnot(None),
        )
        .order_by(ZReport.shop_sequence_number.desc())
        .first()
    )
    return (highest[0] + 1) if highest and highest[0] else DEFAULT_SHOP_Z_SEQUENCE_START


def ensure_shop_z_sequence(db: Session, shop_id: uuid.UUID) -> None:
    """
    Make sure the shop has its counter row, without racing another build for it.

    `INSERT … ON CONFLICT DO NOTHING`: two first Zs of one shop at the same moment would
    otherwise both find no row and both insert one, and the loser's build fails on the
    primary key. Afterwards the row exists and is locked with `FOR UPDATE` as before.
    """
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:  # pragma: no cover - no other database is used
        if db.query(ShopZSequence).filter(ShopZSequence.shop_id == shop_id).first() is None:
            db.add(ShopZSequence(shop_id=shop_id, next_value=_highest_existing(db, shop_id)))
            db.flush()
        return
    db.execute(
        insert(ShopZSequence.__table__)
        .values(shop_id=shop_id, next_value=_highest_existing(db, shop_id))
        .on_conflict_do_nothing(index_elements=["shop_id"])
    )


def allocate_shop_z_number(db: Session, shop_id: Optional[uuid.UUID]) -> Optional[int]:
    """
    The next Z number for `shop_id`, or None when the machine has no shop.

    The caller must be inside the transaction that inserts the Z, and must not call this
    for a close it is about to reject as a duplicate.

    `shop_id` is nullable on both `pos_machines` and `z_reports`, so an unassigned
    terminal closes days without a shop number. Returning None rather than inventing a
    shop keeps that terminal able to trade, and the Z is still identified by its id.
    """
    if shop_id is None:
        return None

    row = (
        db.query(ShopZSequence)
        .filter(ShopZSequence.shop_id == shop_id)
        .with_for_update()
        .first()
    )
    if row is None:
        row = ShopZSequence(shop_id=shop_id, next_value=_highest_existing(db, shop_id))
        db.add(row)
        db.flush()

    assigned = int(row.next_value)
    row.next_value = assigned + 1
    db.flush()
    return assigned
