"""
Transaction + Z-report sync service.

Idempotency contract:
- Transaction PKs are client-generated UUIDs.
- upsert_transactions does INSERT ... ON CONFLICT (id) DO UPDATE.
- Items are replaced atomically per transaction (delete-then-insert by transaction_id).
- A timed-out POST that retries hits the same id and gets back status='duplicate'.
- z_reports.trading_day_id is UNIQUE — a retried Z-close returns 'duplicate', not a duplicate row.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.trading_day import TradingDay, TradingDayStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.issued_voucher import IssuedVoucher, IssuedVoucherStatus
from app.models.stock_movement import StockMovementReason
from app.models.z_report import ZReport
from app.schemas.transaction import TransactionIn, TransactionPaymentIn, TransactionUpsertResult
from app.schemas.z_report import ZReportIn
from app.services.stock import apply_movement
from app.services.tenders import (
    UNKNOWN_PAYMENT_METHOD,
    derive_payment_method,
    expected_tender_total,
    reconciliation_error,
)

logger = logging.getLogger(__name__)


def _safe_item_product_id(db: Session, pid: Optional[uuid.UUID]) -> Optional[uuid.UUID]:
    """
    POS SQLite `products.id` can diverge from cloud PK after SKU-based merge; invalid UUIDs
    would break INSERT into transaction_items (FK → products). Snapshot fields preserve lines.
    """
    if pid is None:
        return None
    row = db.query(Product.id).filter(Product.id == pid).first()
    return pid if row else None


def _safe_voucher_id(db: Session, vid: Optional[uuid.UUID]) -> Optional[uuid.UUID]:
    if vid is None:
        return None
    from app.models.voucher import Voucher
    row = db.query(Voucher.id).filter(Voucher.id == vid).first()
    return vid if row else None


def _safe_issued_product_id(db: Session, pid: Optional[uuid.UUID]) -> Optional[uuid.UUID]:
    return _safe_item_product_id(db, pid)


def _resolve_customer_ref_id(
    db: Session, raw: Optional[str], tenant_id: Optional[uuid.UUID]
) -> Optional[uuid.UUID]:
    """
    Turn the till's free-text `customerId` into a real FK, or into nothing.

    Same shape as `_safe_item_product_id`, and for the same reason: the till's value
    is not trusted to be a key in this database. Three cases resolve to null rather
    than to an error — a non-UUID string (a legacy desktop wrote a name there), a
    UUID naming no customer, and a UUID naming a customer of a *different* tenant.
    The last one is the one that matters: without the tenant predicate a machine
    could staple another merchant's customer, name and ח.פ. included, onto its own
    tax invoice by guessing a UUID.

    Deleted customers deliberately still resolve. A till that has been offline for a
    week can push a sale for a customer removed yesterday, and the document must not
    lose the identity it was issued to — which is why deletion is a tombstone on the
    row rather than a DELETE (see `app/models/customer.py`).
    """
    if not raw or tenant_id is None:
        return None
    try:
        candidate = uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None
    row = (
        db.query(Customer.id)
        .filter(Customer.id == candidate, Customer.tenant_id == tenant_id)
        .first()
    )
    return candidate if row else None


def _normalized_payment_legs(tx: TransactionIn) -> List[TransactionPaymentIn]:
    """
    The tender legs to persist for one document — always at least one.

    A till that sends only `paymentMethod` gets a single synthesised leg for the
    document's whole collectable amount. That is the entire point of doing it here:
    every reporting and export path downstream then has exactly one code path, and
    "does this document have legs?" never becomes a branch in an aggregation.

    The synthesised leg's id is derived deterministically from the document id via
    UUID5, not randomly. Pushes are idempotent by document id and the legs are
    replaced on every push, so a random id would mint a new primary key on each
    retry — harmless today, but it makes the same document look different every time
    it is re-pushed, and that is the sort of thing that turns a duplicate-detection
    question into an afternoon.
    """
    if tx.payments:
        return sorted(tx.payments, key=lambda p: (p.sequence, str(p.id)))
    return [
        TransactionPaymentIn(
            id=uuid.uuid5(uuid.NAMESPACE_URL, f"tender:{tx.id}:1"),
            sequence=1,
            method=(tx.payment_method or UNKNOWN_PAYMENT_METHOD),
            amount=expected_tender_total(
                total_amount=tx.total_amount or 0,
                document_discount=tx.document_discount,
                document_type=tx.document_type,
                refund_of_transaction_id=tx.refund_of_transaction_id,
            ),
            nayax_meta=tx.nayax_meta,
        )
    ]


def _tender_rejection_reason(tx: TransactionIn) -> Optional[str]:
    """
    Why this document's `payments` array cannot be accepted, or None.

    Only checked when the till actually sent an array. A synthesised leg cannot
    mismatch by construction, so an older till build is never rejected by a rule it
    has never heard of.
    """
    if not tx.payments:
        return None
    expected = expected_tender_total(
        total_amount=tx.total_amount or 0,
        document_discount=tx.document_discount,
        document_type=tx.document_type,
        refund_of_transaction_id=tx.refund_of_transaction_id,
    )
    return reconciliation_error(expected, [p.amount for p in tx.payments])


# ── Trading day helpers ──────────────────────────────────────────────────────

def find_open_trading_day(db: Session, machine_id: uuid.UUID) -> Optional[TradingDay]:
    """Return the currently-open trading day for a machine, if any."""
    return (
        db.query(TradingDay)
        .filter(
            TradingDay.machine_id == machine_id,
            TradingDay.status == TradingDayStatus.OPEN,
        )
        .order_by(TradingDay.opened_at.desc())
        .first()
    )


def get_or_create_trading_day(
    db: Session,
    machine: POSMachine,
    *,
    trading_day_id: Optional[uuid.UUID],
    day_date: Optional[date],
    opened_at: Optional[datetime] = None,
    opening_cash=None,
    opened_by: Optional[str] = None,
    sequence_number: Optional[int] = None,
    status: TradingDayStatus = TradingDayStatus.OPEN,
) -> TradingDay:
    """
    Resolve a TradingDay **by its id only**, creating it if unknown.

    Idempotent by id, exactly like a transaction: the till generates the id, so a
    retried upload lands on the same row and a day the cloud has not heard of yet is
    simply created.

    There is deliberately no fallback to `(machine_id, day_date)`. That fallback is
    what silently merged two shifts on one calendar date: the evening's sales matched
    the morning's already-closed day, and the evening's Z then came back `duplicate`
    — which the till read as success before purging the documents behind it. A date
    is a reporting attribute, never an identity.

    An unknown id with no `day_date` still falls back to today in UTC, which is only
    reachable for a payload carrying neither — the till always sends both.
    """
    td: Optional[TradingDay] = None
    if trading_day_id:
        td = db.query(TradingDay).filter(TradingDay.id == trading_day_id).first()
    if td is not None:
        return td

    # No id at all — an older sale, or one written in the window between a day
    # closing and the next opening. It belongs to whatever day this machine has open,
    # which is what the till meant. Creating a fresh open day for it instead would
    # manufacture a phantom that no Z will ever close, and would collide with the
    # one-open-day rule the moment the real day is reported.
    if trading_day_id is None:
        open_day = (
            db.query(TradingDay)
            .filter(
                TradingDay.machine_id == machine.id,
                TradingDay.status == TradingDayStatus.OPEN,
            )
            .order_by(TradingDay.opened_at.desc())
            .first()
        )
        if open_day is not None:
            return open_day

    if day_date is None:
        # Last resort: today in UTC.
        day_date = datetime.now(timezone.utc).date()

    new_td = TradingDay(
        id=trading_day_id or uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        day_date=day_date,
        sequence_number=sequence_number,
        opened_at=opened_at or datetime.now(timezone.utc),
        opening_cash=opening_cash,
        opened_by=opened_by,
        status=status,
    )
    db.add(new_td)
    try:
        db.flush()
    except IntegrityError:
        # The only unique rule here is "one open day per machine". Losing that race
        # means another request created this machine's open day first; adopting it is
        # correct and is what the caller wanted. Never a 500.
        db.rollback()
        existing = (
            db.query(TradingDay)
            .filter(
                TradingDay.machine_id == machine.id,
                TradingDay.status == TradingDayStatus.OPEN,
            )
            .order_by(TradingDay.opened_at.desc())
            .first()
        )
        if existing is None:
            raise
        return existing
    return new_td


# ── Transactions upsert ──────────────────────────────────────────────────────

def _serialize_tx_for_upsert(
    tx: TransactionIn,
    machine: POSMachine,
    trading_day_id: uuid.UUID,
    *,
    payment_method: Optional[str] = None,
    customer_ref_id: Optional[uuid.UUID] = None,
) -> Dict:
    """
    Flatten one incoming document into the row the upsert writes.

    `payment_method` and `customer_ref_id` are the two values the *server* decides
    rather than copies: the first is derived from the tender legs, the second is the
    till's `customer_id` after it has been checked against this tenant's customers.
    Both default to the pre-split behaviour — the till's own `payment_method`, and no
    customer link — so a caller that has neither still produces the row this function
    produced before split tender existed.
    """
    return {
        "id": tx.id,
        "tenant_id": machine.tenant_id,
        "machine_id": machine.id,
        "shop_id": machine.shop_id,
        "trading_day_id": trading_day_id,
        "transaction_number": tx.transaction_number,
        "status": tx.status,
        "document_type": tx.document_type,
        "document_production_date": tx.document_production_date,
        # Derived from the tender legs, not copied from the till: a document with two
        # tenders must not keep claiming to be a cash sale. Falls back to whatever the
        # till sent when there are no legs at all.
        "payment_method": payment_method if payment_method is not None else tx.payment_method,
        "amount_tendered": tx.amount_tendered,
        "change_amount": tx.change_amount,
        "total_amount": tx.total_amount or 0,
        "tip_amount": tx.tip_amount or 0,
        "tip_payment_method": tx.tip_payment_method,
        "total_discount": tx.total_discount,
        "document_discount": tx.document_discount,
        "wht_deduction": tx.wht_deduction,
        "customer_id": tx.customer_id,
        "customer_ref_id": customer_ref_id,
        "cashier_id": tx.cashier_id,
        "branch_id": tx.branch_id,
        "notes": tx.notes,
        "refund_of_transaction_id": tx.refund_of_transaction_id,
        "nayax_meta": tx.nayax_meta,
        "created_at": tx.created_at,
        "updated_at": tx.updated_at,
    }


def upsert_transactions(
    db: Session,
    machine: POSMachine,
    transactions: List[TransactionIn],
) -> List[TransactionUpsertResult]:
    """
    Idempotently upsert a batch of transactions and their items.

    For each tx:
      - Reject the document outright if its `payments` array does not reconcile.
      - Resolve / auto-open trading_day.
      - INSERT ... ON CONFLICT (id) DO UPDATE SET ... — `status` reports 'accepted' for new rows
        and 'duplicate' for rows that already existed at the same updated_at.
      - Replace items atomically: DELETE existing items by transaction_id, then INSERT the new list.
      - Replace tender legs the same way, synthesising one from `paymentMethod` when the
        till sent no array.

    **Why an unbalanced `payments` array is rejected rather than stored with a flag.**
    A document whose tenders do not sum to its total cannot be audited: it is either
    money the shop took and cannot account for, or an amount it never took. Stored, it
    goes straight into the next OpenFormat filing, where the payment records (D120)
    would no longer add up to the document record (C100) — and a validator that
    rejects the file rejects the whole period, not the one bad row. A boolean flag on
    the row would only help if something queried it, and nothing does.

    Rejecting costs nothing here because of how the two halves of this system already
    behave. The result is per-document, so the rest of the batch still lands. The till
    keeps its own copy: `OutboxSync` marks a rejected row failed and does **not**
    clear it, so the document survives locally with its trace intact, and because the
    upsert is keyed on the client-generated id, a corrected client can re-push the
    same document and have it accepted. The reason string travels back in the batch
    response and into `sync_logs.conflict_note`, so the failure is visible rather than
    sitting in a column nobody reads.

    The legacy path is deliberately exempt: a till that sends only `paymentMethod` has
    its single leg synthesised from the document's own amount, so it cannot fail a
    reconciliation rule it has never heard of.
    """
    results: List[TransactionUpsertResult] = []
    if not transactions:
        return results

    # Pre-load existing rows in one query so we can classify accepted vs duplicate.
    incoming_ids = [tx.id for tx in transactions]
    existing_map: Dict[uuid.UUID, Transaction] = {
        t.id: t for t in db.query(Transaction).filter(Transaction.id.in_(incoming_ids)).all()
    }

    for tx in transactions:
        # Each transaction gets its own SAVEPOINT. Without one, a single failure left
        # the session in a rolled-back state: every later transaction in the batch was
        # then rejected with a PendingRollbackError, and the router's commit raised —
        # turning one bad row into a 500 the till retries forever, which blocks the
        # outbox and therefore the day's close.
        savepoint = db.begin_nested()
        try:
            # Before anything is written, so a rejected document leaves no trace at
            # all — not even an auto-opened trading day.
            tender_problem = _tender_rejection_reason(tx)
            if tender_problem is not None:
                logger.warning("Rejecting transaction %s: %s", tx.id, tender_problem)
                results.append(TransactionUpsertResult(
                    id=tx.id,
                    status="rejected",
                    reason=tender_problem,
                ))
                continue

            legs = _normalized_payment_legs(tx)

            day_date_value: Optional[date] = None
            if tx.day_date:
                try:
                    day_date_value = date.fromisoformat(tx.day_date)
                except ValueError:
                    day_date_value = tx.created_at.date() if tx.created_at else None
            else:
                day_date_value = tx.created_at.date() if tx.created_at else None

            td = get_or_create_trading_day(
                db,
                machine,
                trading_day_id=tx.trading_day_id,
                day_date=day_date_value,
                opened_at=tx.created_at,
            )

            previous = existing_map.get(tx.id)

            row = _serialize_tx_for_upsert(
                tx,
                machine,
                td.id,
                payment_method=derive_payment_method(
                    [leg.method for leg in legs], fallback=tx.payment_method
                ),
                customer_ref_id=_resolve_customer_ref_id(
                    db, tx.customer_id, machine.tenant_id
                ),
            )
            stmt = pg_insert(Transaction).values(**row)
            update_cols = {
                k: stmt.excluded[k]
                for k in row.keys()
                if k not in ("id", "tenant_id", "machine_id", "server_received_at")
            }
            stmt = stmt.on_conflict_do_update(index_elements=[Transaction.id], set_=update_cols)
            db.execute(stmt)

            # Replace items atomically.
            db.query(TransactionItem).filter(
                TransactionItem.transaction_id == tx.id
            ).delete(synchronize_session=False)
            if tx.items:
                db.bulk_save_objects([
                    TransactionItem(
                        id=it.id,
                        transaction_id=tx.id,
                        product_id=_safe_item_product_id(db, it.product_id),
                        product_name=it.product_name,
                        sku=it.sku,
                        quantity=it.quantity,
                        unit_price=it.unit_price,
                        total_price=it.total_price,
                        discount=it.discount,
                        discount_type=it.discount_type,
                        transaction_type=it.transaction_type,
                        line_discount=it.line_discount,
                        notes=it.notes,
                    )
                    for it in tx.items
                ])

            # Tender legs are replaced atomically, exactly like items: a re-push is
            # the whole document, so the legs it carries are the whole truth about
            # how it was paid. Merging would leave a leg from a superseded attempt
            # behind and break the reconciliation the push was just checked against.
            db.query(TransactionPayment).filter(
                TransactionPayment.transaction_id == tx.id
            ).delete(synchronize_session=False)
            db.bulk_save_objects([
                TransactionPayment(
                    id=leg.id,
                    transaction_id=tx.id,
                    sequence=leg.sequence,
                    # Lower-cased and trimmed on the way in, so the stored tender is
                    # canonical. The schema's min_length lets a whitespace-only
                    # string through, and the column is NOT NULL; more usefully,
                    # every consumer that matches a tender by name — the payment-type
                    # code in the OpenFormat export most of all — compares against
                    # lower case, and a till sending "Card" must not quietly file its
                    # card money as cash.
                    method=((leg.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD)[:50],
                    amount=leg.amount,
                    nayax_meta=leg.nayax_meta,
                )
                for leg in legs
            ])

            db.query(IssuedVoucher).filter(
                IssuedVoucher.transaction_id == tx.id
            ).delete(synchronize_session=False)
            if tx.issued_vouchers:
                db.bulk_save_objects([
                    IssuedVoucher(
                        id=iv.id,
                        tenant_id=machine.tenant_id,
                        shop_id=machine.shop_id,
                        machine_id=machine.id,
                        transaction_id=tx.id,
                        transaction_item_id=iv.transaction_item_id,
                        voucher_id=_safe_voucher_id(db, iv.voucher_id),
                        product_id=_safe_issued_product_id(db, iv.product_id),
                        product_name=iv.product_name,
                        quantity=iv.quantity,
                        unit_value=iv.unit_value,
                        face_value=iv.face_value,
                        issued_at=iv.issued_at,
                        expires_at=iv.expires_at,
                        status=IssuedVoucherStatus(iv.status) if iv.status else IssuedVoucherStatus.ISSUED,
                        reprint_count=iv.reprint_count,
                        last_printed_at=iv.last_printed_at,
                    )
                    for iv in tx.issued_vouchers
                ])

            if tx.stock_movements and machine.shop_id and machine.tenant_id:
                for sm in tx.stock_movements:
                    reason = StockMovementReason(sm.reason)
                    apply_movement(
                        db,
                        movement_id=sm.id,
                        tenant_id=machine.tenant_id,
                        shop_id=machine.shop_id,
                        product_id=sm.product_id,
                        delta=sm.delta,
                        reason=reason,
                        occurred_at=sm.occurred_at,
                        transaction_id=tx.id,
                        transaction_item_id=sm.transaction_item_id,
                        machine_id=machine.id,
                        note=sm.note,
                    )

            is_duplicate = previous is not None and (
                previous.updated_at is not None
                and tx.updated_at is not None
                and previous.updated_at >= tx.updated_at
            )
            savepoint.commit()
            results.append(TransactionUpsertResult(
                id=tx.id,
                status="duplicate" if is_duplicate else "accepted",
                server_received_at=datetime.now(timezone.utc),
            ))
        except Exception as exc:
            if savepoint.is_active:
                savepoint.rollback()
            logger.exception("Failed to upsert transaction %s: %s", tx.id, exc)
            results.append(TransactionUpsertResult(
                id=tx.id,
                status="rejected",
                reason=str(exc),
            ))

    return results


# ── Z-report ─────────────────────────────────────────────────────────────────

def check_z_report_preconditions(
    db: Session,
    machine: POSMachine,
    z: ZReportIn,
) -> Tuple[List[uuid.UUID], List[uuid.UUID]]:
    """
    Verify all transaction ids referenced by the Z report exist for this machine.
    Returns (missing_ids, stale_ids).
    """
    if not z.transaction_ids:
        return [], []

    rows = (
        db.query(Transaction.id)
        .filter(
            Transaction.machine_id == machine.id,
            Transaction.id.in_(z.transaction_ids),
        )
        .all()
    )
    present = {r[0] for r in rows}
    missing = [tx_id for tx_id in z.transaction_ids if tx_id not in present]
    return missing, []  # staleness check left as future work


def apply_z_report(
    db: Session,
    machine: POSMachine,
    z: ZReportIn,
) -> Tuple[ZReport, str]:
    """
    Idempotent close: returns (z_report, status) where status is 'accepted' or 'duplicate'.
    Caller must check_z_report_preconditions first; this assumes preconditions hold.
    """
    td = get_or_create_trading_day(
        db,
        machine,
        trading_day_id=z.trading_day_id,
        day_date=z.day_date,
        opened_at=z.opened_at,
        # A day the cloud never heard of is being closed right now, so it is created
        # closed. Inserting it open and closing it one statement later would trip the
        # one-open-day rule on a machine that already has a day open.
        status=TradingDayStatus.CLOSED,
    )

    existing = db.query(ZReport).filter(ZReport.trading_day_id == td.id).first()
    if existing is not None:
        return existing, "duplicate"

    zr = ZReport(
        id=uuid.uuid4(),
        trading_day_id=td.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        day_date=z.day_date,
        total_sales=z.total_sales,
        total_refunds=z.total_refunds,
        total_cash_sales=z.total_cash_sales,
        total_card_sales=z.total_card_sales,
        total_tips=z.total_tips,
        total_cash_tips=z.total_cash_tips,
        total_card_tips=z.total_card_tips,
        transactions_count=z.transactions_count,
        opening_cash=z.opening_cash,
        closing_cash=z.closing_cash,
        expected_cash=z.expected_cash,
        # Nobody counted the drawer on an unattended close, so the count and the
        # variance are stored as unknown rather than as the expected figure. The till
        # used to send expected-as-counted, which made every remote Z assert a variance
        # of exactly zero — a shop with a real shortfall got a document saying it
        # balanced. Enforced here and not only on the device, so an older till build
        # cannot reintroduce the lie.
        actual_cash=None if z.unattended else z.actual_cash,
        discrepancy=None if z.unattended else z.discrepancy,
        unattended=z.unattended,
        payload=z.payload,
        closed_at=z.closed_at,
    )
    db.add(zr)

    td.status = TradingDayStatus.CLOSED
    td.closed_at = z.closed_at
    if z.closing_cash is not None and not z.unattended:
        td.closing_cash = z.closing_cash
    if z.expected_cash is not None:
        td.expected_cash = z.expected_cash
    # Same rule as the Z row above: an unattended close leaves the count and the
    # variance unknown on the day as well, or the dashboard would show a reconciled
    # drawer nobody opened.
    if z.actual_cash is not None and not z.unattended:
        td.actual_cash = z.actual_cash
    if z.discrepancy is not None and not z.unattended:
        td.discrepancy = z.discrepancy
    if z.opened_by:
        td.opened_by = td.opened_by or z.opened_by
    if z.closed_by:
        td.closed_by = z.closed_by

    db.flush()
    return zr, "accepted"


# ── MQTT publish helpers (server -> dashboard heads-up) ──────────────────────

def publish_transactions_synced(tenant_id: Optional[uuid.UUID], machine_id: uuid.UUID, count: int) -> None:
    """Lightweight signal for future dashboard live updates."""
    from app.services.ably_notify import publish_transactions_synced as ably_tx_synced

    if not tenant_id:
        return
    ably_tx_synced(str(tenant_id), str(machine_id), count)


def publish_z_report_closed(
    tenant_id: Optional[uuid.UUID],
    machine_id: uuid.UUID,
    z_report_id: uuid.UUID,
    trading_day_id: uuid.UUID,
) -> None:
    from app.services.ably_notify import publish_z_report_closed as ably_z_closed

    if not tenant_id:
        return
    ably_z_closed(str(tenant_id), str(machine_id), str(z_report_id), str(trading_day_id))
