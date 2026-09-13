"""
Closing a trading day whose terminal can no longer close it.

A Z report is normally issued by the terminal: `apply_z_report` is reachable only from
the till-facing sync endpoint, with that machine's own token. That is the right default —
the terminal is the only thing that knows what it rang up. It also means a terminal that
dies mid-day leaves a day nobody can end, and the machine is then stuck with an open day
forever. There are five such days in this system's own database.

This module builds the Z from the documents the cloud already holds, and is careful to
say so. Three things make the result readable rather than merely plausible:

* `reconstructed = True` on the row, so no reader can mistake it for a document the
  terminal produced and printed.
* `actual_cash` and `discrepancy` stay NULL. Nobody counted a drawer. The existing
  `unattended` flag is set for the same reason, so every consumer that already withholds
  a variance for an uncounted close — the day summary among them — does so here too
  without being taught a new rule.
* `reconstruction_basis` records what it was built from: how many documents, when the
  terminal was last heard from, and the backlog it last reported. A reader judging
  whether to trust the figure needs that, and "the cloud held 41 documents and the
  terminal last reported nothing outstanding" is a very different statement from "the
  cloud held 41 documents and the terminal was holding 7 it never sent".

What this cannot do is invent the documents that never arrived. Sales are pushed within
seconds of each checkout, so in practice the cloud has everything unless the terminal was
offline — but "in practice" is not "always", which is exactly why the basis is recorded
instead of asserted.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.trading_day import TradingDay, TradingDayStatus
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.models.z_report import ZReport
from app.services.dashboard_stats import SALE_STATUSES
from app.services.machine_status import is_online
from app.services.tenders import CREDIT_NOTE_DOCUMENT_TYPE
from app.services.z_sequence import allocate_shop_z_number

#: How long a terminal must have been silent before its day can be closed from the cloud.
#:
#: Guards against ending the day of a till that is merely between heartbeats and still
#: serving customers — that would leave the cashier selling into a day the cloud thinks
#: is closed. Two hours is far beyond any ordinary network blip and well inside the span
#: of a shift, so a genuinely dead terminal does not hold up the evening.
SILENT_BEFORE_CLOSE = timedelta(hours=2)


def _cash_movement(db: Session, trading_day_id: uuid.UUID) -> Decimal:
    """
    Cash that entered the drawer, net of cash refunds.

    Read from the tender legs rather than from `payment_method`, because a split-tender
    document is part cash and part card and attributing the whole of it to either would
    misstate the drawer in both directions at once.
    """
    rows = (
        db.query(TransactionPayment.method, TransactionPayment.amount, Transaction.document_type)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.trading_day_id == trading_day_id,
            Transaction.status.in_(SALE_STATUSES),
        )
        .all()
    )
    total = Decimal("0")
    for method, amount, doc_type in rows:
        if method != "cash" or amount is None:
            continue
        total += -amount if doc_type == CREDIT_NOTE_DOCUMENT_TYPE else amount
    return total


def _totals(db: Session, trading_day_id: uuid.UUID) -> Dict[str, Any]:
    """The day's figures, from the documents the cloud holds."""
    sales = Decimal("0")
    refunds = Decimal("0")
    tips = Decimal("0")
    cash_tips = Decimal("0")
    card_tips = Decimal("0")
    count = 0

    documents = (
        db.query(Transaction)
        .filter(
            Transaction.trading_day_id == trading_day_id,
            Transaction.status.in_(SALE_STATUSES),
        )
        .all()
    )
    for tx in documents:
        count += 1
        gross = (tx.total_amount or Decimal("0")) - (tx.document_discount or Decimal("0"))
        if tx.document_type == CREDIT_NOTE_DOCUMENT_TYPE or tx.refund_of_transaction_id:
            refunds += gross
        else:
            sales += gross
        tip = tx.tip_amount or Decimal("0")
        if tip:
            tips += tip
            if tx.tip_payment_method == "cash":
                cash_tips += tip
            elif tx.tip_payment_method == "card":
                card_tips += tip

    cash = _cash_movement(db, trading_day_id)

    # Card takings are what is left once cash is accounted for. Derived rather than summed
    # separately so the two halves cannot disagree with the documents they came from.
    card = (sales - refunds) - cash

    return {
        "total_sales": sales,
        "total_refunds": refunds,
        "total_cash_sales": cash,
        "total_card_sales": card,
        "total_tips": tips,
        "total_cash_tips": cash_tips,
        "total_card_tips": card_tips,
        "transactions_count": count,
        "_documents": documents,
    }


def check_can_reconstruct(
    machine: POSMachine, day: TradingDay, *, force: bool, now: Optional[datetime] = None
) -> None:
    """Raise if this day must not be closed from the cloud. Called before any write."""
    if day.status != TradingDayStatus.OPEN:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="trading_day_not_open",
        )
    if is_online(machine.last_heartbeat_at, now=now) and not force:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "terminal_is_online — it can close its own day. Use the remote close, "
                "or pass force if the terminal is known to be unusable."
            ),
        )
    reference = now or datetime.now(timezone.utc)
    last = machine.last_heartbeat_at
    if last is not None and not force:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if reference - last < SILENT_BEFORE_CLOSE:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "terminal_recently_seen — wait for it to be silent for "
                    f"{int(SILENT_BEFORE_CLOSE.total_seconds() // 3600)}h, or pass force."
                ),
            )


def reconstruct_z_report(
    db: Session,
    machine: POSMachine,
    day: TradingDay,
    user: User,
    *,
    force: bool = False,
    note: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Tuple[ZReport, bool]:
    """
    Close `day` with a Z built from the cloud's own records.

    Returns `(z_report, created)`. Idempotent: a day that already has a Z returns it
    untouched rather than filing a second one, so a double-click cannot produce two
    fiscal documents for one day or burn a second shop Z number.
    """
    existing = db.query(ZReport).filter(ZReport.trading_day_id == day.id).first()
    if existing is not None:
        return existing, False

    check_can_reconstruct(machine, day, force=force, now=now)

    reference = now or datetime.now(timezone.utc)
    totals = _totals(db, day.id)
    documents = totals.pop("_documents")

    opening = day.opening_cash or Decimal("0")
    expected = opening + totals["total_cash_sales"] + totals["total_cash_tips"]

    basis = {
        "documentsOnCloud": len(documents),
        "lastHeartbeatAt": (
            machine.last_heartbeat_at.isoformat() if machine.last_heartbeat_at else None
        ),
        # What the terminal last said it was still holding. The honest measure of how
        # much this reconstruction might be missing; null means it never reported.
        "lastReportedPendingDocuments": machine.pending_documents,
        "lastReportedPendingAt": (
            machine.pending_count_at.isoformat() if machine.pending_count_at else None
        ),
        "forced": bool(force),
        "note": note,
        "reconstructedAt": reference.isoformat(),
    }

    who = user.username or user.email or str(user.id)

    zr = ZReport(
        id=uuid.uuid4(),
        trading_day_id=day.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        day_date=day.day_date,
        shop_sequence_number=allocate_shop_z_number(db, machine.shop_id),
        opening_cash=opening,
        expected_cash=expected,
        # Nobody opened a drawer. Left unknown rather than set to `expected`, which would
        # assert a variance of zero that no one verified.
        closing_cash=None,
        actual_cash=None,
        discrepancy=None,
        unattended=True,
        reconstructed=True,
        reconstructed_by=who,
        reconstruction_basis=basis,
        payload=None,
        closed_at=reference,
        **totals,
    )
    db.add(zr)

    day.status = TradingDayStatus.CLOSED
    day.closed_at = reference
    day.expected_cash = expected
    day.closed_by = who
    db.flush()
    return zr, True
