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

from app.models.machine_z_sequence import MachineZSequence
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


# ── Per-till numbering (till Zs, docs/SHIFTS_API.md §5) ───────────────────────


def _highest_machine_number(db: Session, machine_id: uuid.UUID, epoch: Optional[int] = None) -> int:
    """The last till Z number of this till already on file (0 if none) — as above, so a
    lost counter row continues the run rather than reissuing printed numbers. Within one
    run (`epoch`, the till's current one when not given): an independent till starts at 1
    (docs/SPEC_INDEPENDENT_TILL.md §3.1)."""
    if epoch is None:
        epoch = current_machine_epoch(db, machine_id)[0]
    highest = (
        db.query(ZReport.machine_sequence_number)
        .filter(
            ZReport.machine_id == machine_id,
            ZReport.machine_sequence_epoch == epoch,
            ZReport.machine_sequence_number.isnot(None),
        )
        .order_by(ZReport.machine_sequence_number.desc())
        .first()
    )
    return int(highest[0]) if highest and highest[0] else 0


def current_machine_epoch(db: Session, machine_id: uuid.UUID):
    """The till's current run: `(epoch, started_at)` — `(0, None)` before it has a counter."""
    row = (
        db.query(MachineZSequence.epoch, MachineZSequence.started_at)
        .filter(MachineZSequence.machine_id == machine_id)
        .first()
    )
    return (int(row[0] or 0), row[1]) if row else (0, None)


def start_new_machine_sequence(db: Session, machine_id: uuid.UUID, now) -> MachineZSequence:
    """
    A new run of this till's Zs, starting at 1 — the till was made independent (the owner:
    "מעבר בין קופה בסניפי לעצמאי מתחיל את הקופה מ-Z אחד"). Under the counter lock; the
    caller ran the switch's checks (nothing waiting for a Z, nothing unsynced).
    """
    row = lock_machine_z_sequence(db, machine_id)
    row.epoch = int(row.epoch or 0) + 1
    row.last_number = 0
    row.started_at = now
    db.flush()
    return row


def lock_machine_z_sequence(db: Session, machine_id: uuid.UUID) -> MachineZSequence:
    """
    The till's counter row, created if missing and locked `FOR UPDATE`.

    Taken first by every till Z of the till and by a change of its `z_mode`, so those
    serialise: a second request of the same till waits here, and then reads the first's
    Z (its `clientRequestId`, its shifts) as committed.
    """
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:  # pragma: no cover - no other database is used
        insert = None
    if insert is not None:
        db.execute(
            insert(MachineZSequence.__table__)
            .values(machine_id=machine_id, last_number=_highest_machine_number(db, machine_id, 0))
            .on_conflict_do_nothing(index_elements=["machine_id"])
        )
    row = (
        db.query(MachineZSequence)
        .filter(MachineZSequence.machine_id == machine_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    if row is None:  # pragma: no cover - only without an upsert
        row = MachineZSequence(machine_id=machine_id, last_number=_highest_machine_number(db, machine_id, 0))
        db.add(row)
        db.flush()
    return row


def last_machine_z_number(db: Session, machine_id: uuid.UUID) -> int:
    """
    The last till Z number of this till (0 if none): its counter, else the highest on
    file. A read for the heartbeat (`lastTillZNumber`), so the till can number a Z it
    closes with no connection (docs/SPEC_OFFLINE_TILL_Z.md §4.1). No lock.
    """
    row = (
        db.query(MachineZSequence.last_number, MachineZSequence.epoch)
        .filter(MachineZSequence.machine_id == machine_id)
        .first()
    )
    # The current run's (an independent till starts again at 1).
    on_file = _highest_machine_number(db, machine_id, int(row[1] or 0) if row else 0)
    return max(int(row[0] or 0) if row else 0, on_file)


def machine_z_number_holder(db: Session, machine_id: uuid.UUID, number: int) -> Optional[ZReport]:
    """The Z of this till already numbered `number` in its current run, if any."""
    epoch = current_machine_epoch(db, machine_id)[0]
    return (
        db.query(ZReport)
        .filter(
            ZReport.machine_id == machine_id,
            ZReport.machine_sequence_epoch == epoch,
            ZReport.machine_sequence_number == number,
        )
        .first()
    )


class ZNumberOutOfSequence(Exception):
    """A number that is not the exact next one of the till's run."""


def claim_machine_z_number(db: Session, machine_id: uuid.UUID, number: int) -> int:
    """
    Take `number` — numbered by the till for a Z it closed with no connection — into the
    till's run (docs/SPEC_OFFLINE_TILL_Z.md §4.2), and return the counter as it was.

    Strictly the next number, or nothing: a jump or a hole would put a gap in the run,
    so anything but `last + 1` raises `ZNumberOutOfSequence` (the caller has already
    refused it with the expected number; this is the backstop under the lock).
    """
    row = lock_machine_z_sequence(db, machine_id)
    before = max(int(row.last_number or 0), _highest_machine_number(db, machine_id, int(row.epoch or 0)))
    if number != before + 1:
        raise ZNumberOutOfSequence(f"Z {number} of machine {machine_id}: expected {before + 1}")
    row.last_number = number
    db.flush()
    return before


def allocate_machine_z_number(db: Session, machine_id: uuid.UUID) -> int:
    """
    The next till Z number of `machine_id`: 1 for its first. The caller is inside the
    transaction that inserts the Z (a rollback un-allocates it) and has already answered
    a retried `clientRequestId` with the Z it has — a retry never draws a number.
    """
    row = lock_machine_z_sequence(db, machine_id)
    # Never below a number on file: a counter behind the run would issue a number twice.
    assigned = max(int(row.last_number or 0), _highest_machine_number(db, machine_id, int(row.epoch or 0))) + 1
    row.last_number = assigned
    db.flush()
    return assigned


# ── A shop Z produced on the main till (docs/SPEC_INDEPENDENT_TILL.md §8) ──────
#
# The same contract as a till Z closed with no connection (`claim_machine_z_number`,
# docs/SPEC_OFFLINE_TILL_Z.md §4): the main till numbers the shop's next Z itself — one
# after the last it knows, only as the shop's producer — and the cloud takes exactly the
# next number or nothing. Nothing is ever renumbered: a number that does not fit is kept
# as printed for support (docs/SPEC_INDEPENDENT_TILL.md §8.11).


def last_shop_z_number(db: Session, shop_id: uuid.UUID) -> int:
    """The shop's last Z number (0 if none): its counter, else the highest on file. No lock."""
    row = db.query(ShopZSequence.next_value).filter(ShopZSequence.shop_id == shop_id).first()
    by_counter = int(row[0]) - 1 if row and row[0] else 0
    highest = (
        db.query(ZReport.shop_sequence_number)
        .filter(ZReport.shop_id == shop_id, ZReport.shop_sequence_number.isnot(None))
        .order_by(ZReport.shop_sequence_number.desc())
        .first()
    )
    on_file = int(highest[0]) if highest and highest[0] else 0
    return max(by_counter, on_file)


def claim_shop_z_number(db: Session, shop_id: uuid.UUID, number: int) -> int:
    """
    Take `number` — numbered by the main till — into the shop's run, and return the last
    number before it. Strictly the next one: anything else raises `ZNumberOutOfSequence`
    (the caller has already refused it with the expected number; this is the backstop
    under the lock).
    """
    ensure_shop_z_sequence(db, shop_id)
    row = (
        db.query(ShopZSequence)
        .filter(ShopZSequence.shop_id == shop_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    before = last_shop_z_number(db, shop_id)
    if number != before + 1:
        raise ZNumberOutOfSequence(f"shop Z {number} of shop {shop_id}: expected {before + 1}")
    row.next_value = number + 1
    db.flush()
    return before
