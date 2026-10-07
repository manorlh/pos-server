"""
The waiters' part of a Z ("פירוט לפי מלצר"): per waiter, what the Z's documents took.

A document is its table's waiter's when it paid a table — the order's sale, or a part
of it paid on its own ("פיצול חשבון", `extras_json.partials[].tx`) — the table's waiter
being the one it was handed to, else whoever opened it (as in the tables report). Any
other document is its cashier's (`cashier_id`, the till user who rang it up). A credit
note goes with the document it refunds when that one paid a table.

Built from the same documents as the Z's figures (`app.services.shift_totals`): the
counted statuses only, and only the shift's own till's — so the rows add up to the Z.
Frozen on the Z's header at build time (`byWaiter`), like its other breakdowns.

Each row: {waiterId, waiter, salesCount, sales, refundsCount, refunds, net, cash, card,
other, tips, tables, guests} — money as decimal strings. `waiter` is null for documents
with no one on them.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.pos_user import PosUser
from app.models.shift import Shift
from app.models.tables import TableOrder
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.services.dashboard_stats import SALE_STATUSES
from app.services.tenders import EXCHANGE_PAYMENT_METHOD, expected_tender_total, is_refund_document

ZERO = Decimal("0")
CENT = Decimal("0.01")
_CASH = {"cash"}
_CARD = {"card", "credit"}


def _dec(value: Any) -> Decimal:
    if value is None:
        return ZERO
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _uuid_text(raw: Any) -> Optional[str]:
    try:
        return str(uuid.UUID(str(raw)))
    except (TypeError, ValueError, AttributeError):
        return None


def _part_tx_ids(order: TableOrder) -> List[str]:
    """The sales of the order's parts paid on their own."""
    try:
        extras = json.loads(order.extras_json) if order.extras_json else None
    except ValueError:
        return []
    parts = extras.get("partials") if isinstance(extras, dict) else None
    out = []
    for part in parts if isinstance(parts, list) else []:
        tx = _uuid_text(part.get("tx")) if isinstance(part, dict) else None
        if tx:
            out.append(tx)
    return out


def _orders_by_tx(db: Session, shop_id: Any, documents: List[Transaction]) -> Dict[str, TableOrder]:
    """Each table sale (and the original of a credit note) → the table order it paid."""
    if shop_id is None or not documents:
        return {}
    wanted = {str(d.id) for d in documents}
    wanted |= {t for t in (_uuid_text(d.refund_of_transaction_id) for d in documents) if t}
    found: Dict[str, TableOrder] = {}
    for order in (
        db.query(TableOrder)
        .filter(TableOrder.shop_id == shop_id, TableOrder.transaction_id.in_(sorted(wanted)))
        .all()
    ):
        tx = _uuid_text(order.transaction_id)
        if tx:
            found[tx] = order
    # Parts paid on their own: on orders opened since a little before the first document.
    moments = [d.created_at for d in documents if d.created_at is not None]
    if moments:
        since = min(moments) - timedelta(days=2)
        for order in (
            db.query(TableOrder)
            .filter(
                TableOrder.shop_id == shop_id,
                TableOrder.opened_at >= since,
                TableOrder.extras_json.like('%"partials"%'),
            )
            .all()
        ):
            for tx in _part_tx_ids(order):
                if tx in wanted:
                    found.setdefault(tx, order)
    return found


def _names(db: Session, ids: Iterable[str]) -> Dict[str, str]:
    """The till users' display names by id (a cashier id that is no pos user stays as is)."""
    valid = sorted({u for u in (_uuid_text(i) for i in ids if i) if u})
    if not valid:
        return {}
    out = {}
    for pu in db.query(PosUser).filter(PosUser.id.in_([uuid.UUID(u) for u in valid])).all():
        name = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
        out[str(pu.id)] = name or pu.username
    return out


def _money(value: Decimal) -> str:
    return str(value.quantize(CENT))


def waiter_breakdown(db: Session, shift_ids: Iterable[uuid.UUID], shop_id: Any) -> List[Dict[str, Any]]:
    """The rows over every counted document of `shift_ids`, the largest net first."""
    ids = list(shift_ids)
    if not ids:
        return []
    documents: List[Transaction] = [
        d
        for d in (
            db.query(Transaction)
            .join(Shift, Shift.id == Transaction.shift_id)
            .filter(Transaction.shift_id.in_(ids), Transaction.machine_id == Shift.machine_id)
            .all()
        )
        # A duplicate copy is counted once, by the document holding its number (SHIFTS_API §1.2d).
        if d.status in SALE_STATUSES and not getattr(d, "duplicate_copy", False)
    ]
    if not documents:
        return []
    orders = _orders_by_tx(db, shop_id, documents)
    legs: Dict[Any, List[TransactionPayment]] = {}
    for leg in db.query(TransactionPayment).filter(TransactionPayment.transaction_id.in_([d.id for d in documents])).all():
        legs.setdefault(leg.transaction_id, []).append(leg)
    names = _names(db, [d.cashier_id for d in documents if d.cashier_id])

    rows: Dict[str, Dict[str, Any]] = {}
    seen_orders: Dict[str, set] = {}

    def owner(doc: Transaction, refund: bool) -> Tuple[Optional[str], Optional[str], Optional[TableOrder]]:
        order = orders.get(str(doc.id))
        if order is None and refund:
            order = orders.get(_uuid_text(doc.refund_of_transaction_id) or "")
        if order is not None:
            wid = order.waiter_pos_user_id or order.opened_by_pos_user_id
            name = order.waiter_pos_user_name or order.opened_by_pos_user_name
            return wid, name or (names.get(_uuid_text(wid) or "") if wid else None), order
        raw = (doc.cashier_id or "").strip() or None
        return raw, (names.get(_uuid_text(raw) or "") or raw) if raw else None, None

    for doc in documents:
        refund = is_refund_document(
            document_type=doc.document_type, refund_of_transaction_id=doc.refund_of_transaction_id
        )
        wid, name, order = owner(doc, refund)
        key = str(_uuid_text(wid) or wid or name or "")
        r = rows.setdefault(key, {
            "waiterId": wid, "waiter": name, "salesCount": 0, "sales": ZERO, "refundsCount": 0,
            "refunds": ZERO, "cash": ZERO, "card": ZERO, "other": ZERO, "tips": ZERO,
            "tables": 0, "guests": 0,
        })
        if r["waiter"] is None and name:
            r["waiter"] = name
        collected = expected_tender_total(
            total_amount=doc.total_amount,
            document_discount=doc.document_discount,
            document_type=doc.document_type,
            refund_of_transaction_id=doc.refund_of_transaction_id,
        )
        sign = Decimal("-1") if refund else Decimal("1")
        if refund:
            r["refundsCount"] += 1
            r["refunds"] += collected
        else:
            r["salesCount"] += 1
            r["sales"] += collected
            if order is not None and str(order.id) not in seen_orders.setdefault(key, set()):
                seen_orders[key].add(str(order.id))
                r["tables"] += 1
                r["guests"] += order.guests or 0
        for method, amount in (
            [((leg.method or "").strip().lower(), _dec(leg.amount)) for leg in legs[doc.id]]
            if legs.get(doc.id)
            else [((doc.payment_method or "").strip().lower(), collected)]
        ):
            if method == EXCHANGE_PAYMENT_METHOD:
                continue
            bucket = "cash" if method in _CASH else "card" if method in _CARD else "other"
            r[bucket] += sign * amount
        tip = _dec(doc.tip_amount)
        if tip:
            r["tips"] += tip

    out = []
    for r in rows.values():
        net = r["sales"] - r["refunds"]
        out.append({
            **r,
            "sales": _money(r["sales"]),
            "refunds": _money(r["refunds"]),
            "net": _money(net),
            "cash": _money(r["cash"]),
            "card": _money(r["card"]),
            "other": _money(r["other"]),
            "tips": _money(r["tips"]),
        })
    out.sort(key=lambda r: (-Decimal(r["net"]), r["waiter"] is None, r["waiter"] or ""))
    return out
