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
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.trading_day import TradingDay, TradingDayStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.z_report import ZReport
from app.schemas.transaction import TransactionIn, TransactionUpsertResult
from app.schemas.z_report import ZReportIn

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
) -> TradingDay:
    """
    Resolve a TradingDay by id (preferred) or by (machine_id, day_date).
    If no row exists, auto-open one. Idempotent thanks to UNIQUE (machine_id, day_date).
    """
    td: Optional[TradingDay] = None
    if trading_day_id:
        td = db.query(TradingDay).filter(TradingDay.id == trading_day_id).first()
    if td is None and day_date is not None:
        td = (
            db.query(TradingDay)
            .filter(
                TradingDay.machine_id == machine.id,
                TradingDay.day_date == day_date,
            )
            .first()
        )
    if td is not None:
        return td

    if day_date is None:
        # Last resort: today in UTC.
        day_date = datetime.now(timezone.utc).date()

    new_td = TradingDay(
        id=trading_day_id or uuid.uuid4(),
        tenant_id=machine.tenant_id,
        merchant_id=machine.merchant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        day_date=day_date,
        opened_at=opened_at or datetime.now(timezone.utc),
        status=TradingDayStatus.OPEN,
    )
    db.add(new_td)
    db.flush()
    return new_td


# ── Transactions upsert ──────────────────────────────────────────────────────

def _serialize_tx_for_upsert(
    tx: TransactionIn,
    machine: POSMachine,
    trading_day_id: uuid.UUID,
) -> Dict:
    return {
        "id": tx.id,
        "tenant_id": machine.tenant_id,
        "machine_id": machine.id,
        "merchant_id": machine.merchant_id,
        "shop_id": machine.shop_id,
        "trading_day_id": trading_day_id,
        "transaction_number": tx.transaction_number,
        "status": tx.status,
        "document_type": tx.document_type,
        "document_production_date": tx.document_production_date,
        "payment_method": tx.payment_method,
        "amount_tendered": tx.amount_tendered,
        "change_amount": tx.change_amount,
        "total_amount": tx.total_amount or 0,
        "total_discount": tx.total_discount,
        "document_discount": tx.document_discount,
        "wht_deduction": tx.wht_deduction,
        "customer_id": tx.customer_id,
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
      - Resolve / auto-open trading_day.
      - INSERT ... ON CONFLICT (id) DO UPDATE SET ... — `status` reports 'accepted' for new rows
        and 'duplicate' for rows that already existed at the same updated_at.
      - Replace items atomically: DELETE existing items by transaction_id, then INSERT the new list.
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
        try:
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

            row = _serialize_tx_for_upsert(tx, machine, td.id)
            stmt = pg_insert(Transaction).values(**row)
            update_cols = {
                k: stmt.excluded[k]
                for k in row.keys()
                if k not in ("id", "tenant_id", "machine_id", "merchant_id", "server_received_at")
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

            is_duplicate = previous is not None and (
                previous.updated_at is not None
                and tx.updated_at is not None
                and previous.updated_at >= tx.updated_at
            )
            results.append(TransactionUpsertResult(
                id=tx.id,
                status="duplicate" if is_duplicate else "accepted",
                server_received_at=datetime.now(timezone.utc),
            ))
        except Exception as exc:
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
    )

    existing = db.query(ZReport).filter(ZReport.trading_day_id == td.id).first()
    if existing is not None:
        return existing, "duplicate"

    zr = ZReport(
        id=uuid.uuid4(),
        trading_day_id=td.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        merchant_id=machine.merchant_id,
        shop_id=machine.shop_id,
        day_date=z.day_date,
        total_sales=z.total_sales,
        total_refunds=z.total_refunds,
        total_cash_sales=z.total_cash_sales,
        total_card_sales=z.total_card_sales,
        transactions_count=z.transactions_count,
        opening_cash=z.opening_cash,
        closing_cash=z.closing_cash,
        expected_cash=z.expected_cash,
        actual_cash=z.actual_cash,
        discrepancy=z.discrepancy,
        payload=z.payload,
        closed_at=z.closed_at,
    )
    db.add(zr)

    td.status = TradingDayStatus.CLOSED
    td.closed_at = z.closed_at
    if z.closing_cash is not None:
        td.closing_cash = z.closing_cash
    if z.expected_cash is not None:
        td.expected_cash = z.expected_cash
    if z.actual_cash is not None:
        td.actual_cash = z.actual_cash
    if z.discrepancy is not None:
        td.discrepancy = z.discrepancy
    if z.opened_by:
        td.opened_by = td.opened_by or z.opened_by
    if z.closed_by:
        td.closed_by = z.closed_by

    db.flush()
    return zr, "accepted"


# ── MQTT publish helpers (server -> dashboard heads-up) ──────────────────────

def publish_transactions_synced(merchant_id: Optional[uuid.UUID], machine_id: uuid.UUID, count: int) -> None:
    """Lightweight signal for future dashboard live updates."""
    from app.services.mqtt import mqtt_service

    if not merchant_id:
        return
    topic = f"pos/{merchant_id}/{machine_id}/transactions/synced"
    mqtt_service._publish(topic, {
        "serverTime": datetime.now(timezone.utc).isoformat(),
        "count": count,
    })


def publish_z_report_closed(
    merchant_id: Optional[uuid.UUID],
    machine_id: uuid.UUID,
    z_report_id: uuid.UUID,
    trading_day_id: uuid.UUID,
) -> None:
    from app.services.mqtt import mqtt_service

    if not merchant_id:
        return
    topic = f"pos/{merchant_id}/{machine_id}/z-report/closed"
    mqtt_service._publish(topic, {
        "serverTime": datetime.now(timezone.utc).isoformat(),
        "zReportId": str(z_report_id),
        "tradingDayId": str(trading_day_id),
    })
