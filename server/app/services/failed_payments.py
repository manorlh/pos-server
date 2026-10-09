"""
"עסקאות שלא הושלמו" — failed payment attempts (docs/SPEC_FAILED_PAYMENTS.md).

The owner: "a sale of ₪140 that did not go through — why is it not reported?" A payment
that fails on the terminal issues no tax document, so no report showed it. The till now
records every failed or aborted attempt and pushes it here; this module stores it, lists
it for the dashboard and lays it out on the cloud Z's paper.

* **Ingest** (`upsert`): idempotent by the till's id. A re-send whose content changed is
  applied only when its `updatedAt` is not older than the stored one — an old re-send
  never clobbers a newer link to the paying sale. Another till's id is a conflict. A
  training till's attempts ("מצב הדרכה") are quarantined like its events (`training_route`).
* **Read** (`list_response`): scoped like the transactions; filtered by till, shop,
  shift, Z (every shift / till / window the Z covers), dates, outcome. With them the
  **cancelled sales** of the same scope ("מכירות שבוטלו" — e.g. a declined card sale that
  left a `cancelled` document) that no attempt already accounts for: not an attempt's
  voided document, not in a basket of one — so one failure is never listed twice.
* **Paper** (`with_print_sections`): an informational section on the cloud Z's print
  document. Never part of any total: nothing here touches a fiscal figure.

Money is integer agorot throughout (a cancelled document's `totalAmount` stays in shekels
as stored, with `totalAgorot` beside it).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, case, exists, false, func, or_
from sqlalchemy.orm import Query, Session, aliased

from app.models.failed_payment import (
    KIND_PAYOUT,
    NOT_FAILED_OUTCOMES,
    OUTCOME_APPROVED_LATE,
    OUTCOME_UNRESOLVED,
    FailedPaymentAttempt,
)
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.transaction import Transaction, TransactionStatus
from app.models.z_report import ZReport

logger = logging.getLogger(__name__)

# ── The till parameter ────────────────────────────────────────────────────────

#: Read by the till: "לא" / false hides the sections on PAPER (the screen always shows them).
PRINT_PARAMETER_KEY = "printFailedPayments"

FAILED_PAYMENTS_PARAMETER_SPECS = (
    dict(
        key=PRINT_PARAMETER_KEY,
        label="הדפסת עסקאות שלא הושלמו בדוחות",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): דוח המשמרת, דוח X, דוח הסגירה ודוח Z המודפסים בקופה כוללים את "
            "\"עסקאות שלא הושלמו\" — תשלומים שנכשלו במסוף (נדחו, בוטלו, ללא תשובה, תקלת מסוף, "
            "אשראי נעול) — ואת \"מכירות שבוטלו\". מידע בלבד: לא נכלל בסה״כ המכירות. כבוי — "
            "החלקים לא מודפסים על הנייר; במסך הקופה ובדשבורד הם מוצגים תמיד. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)

# ── Labels (Hebrew, as the dashboard and the till show them) ──────────────────

OUTCOME_LABELS = {
    "declined": "נדחתה",
    "cancelled_terminal": "בוטלה במסוף",
    "cancelled_cashier": "בוטלה ע״י הקופאי",
    "no_answer": "אין תשובה מהמסוף — לא חויב",
    "terminal_error": "תקלת מסוף",
    "card_locked": "אשראי נעול",
    # The card's result not known yet: possibly charged, the till's documents wait for a decision.
    OUTCOME_UNRESOLVED: "לא הוכרע",
    # Found charged on a check: the sale was completed — not a failed payment.
    OUTCOME_APPROVED_LATE: "אושר בבדיקה",
}
#: The explanation beside an unresolved attempt (the dashboard, the paper).
UNRESOLVED_EXPLANATION = (
    "תוצאת התשלום באשראי לא ידועה — ייתכן שהלקוח חויב. בדקו במסוף או הכריעו כאן; "
    "המסמכים בקופה ממתינים עד ההכרעה."
)
METHOD_LABELS = {
    "card": "אשראי", "cash": "מזומן", "voucher": "שובר הפקה", "production_voucher": "שובר הפקה", "mixed": "מעורב",
}
#: "שולם בהמשך במזומן / באשראי / בשובר / (מעורב)".
PAID_LATER_WORDS = {
    "cash": "במזומן", "card": "באשראי", "voucher": "בשובר", "production_voucher": "בשובר", "mixed": "(מעורב)",
}

SECTION_TITLE = "עסקאות שלא הושלמו"
CANCELLED_TITLE = "מכירות שבוטלו"
INFO_ONLY = "מידע בלבד — לא נכלל בסה״כ המכירות"
#: The `key` of each section on the print document: the till drops them on paper when
#: `printFailedPayments` is off (the renderer ignores keys it does not know).
SECTION_KEY = "failed_payments"
CANCELLED_KEY = "cancelled_sales"

DEFAULT_WINDOW_DAYS = 30
PAGE_SIZE_MAX = 500
CANCELLED_ITEMS_MAX = 500
#: On 80 mm paper: the widest attempt label kept on one line, and rows listed per section.
PRINT_LABEL_MAX = 40
PRINT_ROWS_MAX = 40


class IdConflict(Exception):
    """The attempt's id is already another till's."""


# ── Small helpers ─────────────────────────────────────────────────────────────


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def to_agorot(amount: Any) -> int:
    """Shekels (a stored `Numeric(12, 2)`) as integer agorot."""
    if amount is None:
        return 0
    return int((Decimal(str(amount)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def outcome_label(code: Optional[str]) -> str:
    return OUTCOME_LABELS.get(code or "", code or "—")


def method_label(code: Optional[str]) -> str:
    return METHOD_LABELS.get(code or "", code or "—")


def paid_later_label(method: Optional[str]) -> str:
    words = PAID_LATER_WORDS.get((method or "").strip().lower())
    return f"שולם בהמשך {words}" if words else "שולם בהמשך"


# ── Ingest ────────────────────────────────────────────────────────────────────

#: The columns the till's body sets (everything but where it came from and when received).
_CONTENT = (
    "shift_id", "business_date", "pos_user_id", "employee_name", "occurred_at", "resolved_at",
    "amount_agorot", "method", "kind", "channel", "terminal_type", "terminal_id", "outcome",
    "reason_code", "reason_message", "card_brand", "card_last4", "line_count", "vuid",
    "transaction_id", "paid_by_transaction_id", "paid_by_method", "paid_at",
)


def _values(body) -> Dict[str, Any]:
    occurred = _utc(body.occurred_at)
    resolved = _utc(body.resolved_at)
    values = {name: getattr(body, name) for name in _CONTENT}
    values.update(occurred_at=occurred, resolved_at=resolved, paid_at=_utc(body.paid_at))
    values["updated_at"] = _utc(body.updated_at) or resolved or occurred
    return values


def _same(stored: Any, sent: Any) -> bool:
    if isinstance(stored, datetime) or isinstance(sent, datetime):
        return _utc(stored) == _utc(sent)
    if isinstance(stored, uuid.UUID) or isinstance(sent, uuid.UUID):
        return _uuid(stored) == _uuid(sent)
    return stored == sent


def upsert(db: Session, machine: POSMachine, body) -> Tuple[FailedPaymentAttempt, str]:
    """
    Store one attempt (the caller commits). `(row, "accepted")` the first time;
    `(row, "updated")` when the content changed and the body is not older than the row
    (`updatedAt`); `(row, "duplicate")` otherwise. `IdConflict` for another till's id.
    """
    values = _values(body)
    row = db.get(FailedPaymentAttempt, body.id)
    if row is not None:
        if row.machine_id != machine.id:
            raise IdConflict(str(body.id))
        changed = [k for k in _CONTENT if not _same(getattr(row, k), values[k])]
        stored_at = _utc(row.updated_at)
        newer = stored_at is None or values["updated_at"] >= stored_at
        if not changed or not newer:
            return row, "duplicate"
        for name in _CONTENT:
            setattr(row, name, values[name])
        row.updated_at = values["updated_at"]
        db.flush()
        return row, "updated"
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    row = FailedPaymentAttempt(
        id=body.id,
        tenant_id=machine.tenant_id,
        company_id=getattr(shop, "company_id", None),
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
        created_at=datetime.now(timezone.utc),
        **values,
    )
    db.add(row)
    db.flush()
    return row, "accepted"


# ── Training mode ("מצב הדרכה") ───────────────────────────────────────────────


def training_route(db: Session, machine: POSMachine, body) -> str:
    """
    REAL, QUARANTINE or DROP (app/services/training_mode.py) for one attempt: flagged
    `training`, or — the shop in training mode — of a quarantined training shift or naming
    a quarantined training document. Anything else is real, as for the till's events.
    """
    from app.services import training_mode as TM

    shop = TM.shop_of(db, machine)
    flagged = getattr(body, "training", False) is True
    known = False
    if not flagged and TM.is_on(shop):
        if body.shift_id is not None and TM.find(db, machine, "shift", str(body.shift_id)) is not None:
            known = True
        for doc_id in (body.transaction_id, body.paid_by_transaction_id):
            if not known and doc_id is not None and TM.find(db, machine, "transaction", str(doc_id)) is not None:
                known = True
    return TM.route(shop, flagged=flagged, known_training=known)


def divert_training(db: Session, machine: POSMachine, body, decision: str) -> str:
    """A training attempt: quarantined (or dropped and logged) — the answer a real one gets."""
    from app.services import training_mode as TM

    shop = TM.shop_of(db, machine)
    if decision == TM.DROP:
        TM.log_dropped(db, machine, shop, "other", [body.id])
        return "accepted"
    payload = {"failedPayment": body.model_dump(mode="json", by_alias=True)}
    row, created = TM.store(db, machine, shop, "other", body.id, payload)
    if created:
        return "accepted"
    if row.payload != payload:
        row.payload = payload
        row.updated_at = datetime.now(timezone.utc)
        return "updated"
    return "duplicate"


# ── What a Z covers ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Coverage:
    """The shifts a Z took, its tills, and its window (for rows that name no shift)."""

    shift_ids: Tuple[uuid.UUID, ...]
    machine_ids: Tuple[uuid.UUID, ...]
    start: Optional[datetime]
    end: Optional[datetime]


def z_coverage(db: Session, z: ZReport) -> Coverage:
    shifts = db.query(Shift.id, Shift.machine_id).filter(Shift.z_report_id == z.id).all()
    machines = {m for _s, m in shifts if m is not None}
    for s in z.per_machine or []:
        if isinstance(s, dict):
            ident = _uuid(s.get("machineId"))
            if ident is not None:
                machines.add(ident)
    if z.machine_id is not None:
        machines.add(z.machine_id)
    return Coverage(
        shift_ids=tuple(s for s, _m in shifts),
        machine_ids=tuple(sorted(machines, key=str)),
        start=_utc(z.period_start),
        end=_utc(z.period_end),
    )


def _covered(cov: Coverage, shift_col, machine_col, time_col):
    """In one of the Z's shifts; or, naming no shift, of one of its tills inside its window."""
    clauses = []
    if cov.shift_ids:
        clauses.append(shift_col.in_(cov.shift_ids))
    if cov.machine_ids and cov.start is not None and cov.end is not None:
        clauses.append(
            and_(
                shift_col.is_(None),
                machine_col.in_(cov.machine_ids),
                time_col >= cov.start,
                time_col <= cov.end,
            )
        )
    if not clauses:
        return false()
    return or_(*clauses) if len(clauses) > 1 else clauses[0]


# ── Filters ───────────────────────────────────────────────────────────────────


@dataclass
class Filters:
    machine_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    shift_id: Optional[uuid.UUID] = None
    coverage: Optional[Coverage] = None
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    outcomes: Sequence[str] = field(default_factory=tuple)
    card_last4: Optional[str] = None

    def window(self, today: Optional[date] = None) -> Tuple[Optional[datetime], Optional[datetime]]:
        """
        Days as the transactions list reads them (UTC midnight). With no shift, no Z and no
        date: the last 30 days, like the transactions.
        """
        start_day, end_day = self.from_date, self.to_date
        if start_day is None and end_day is None and self.shift_id is None and self.coverage is None:
            start_day = (today or datetime.now(timezone.utc).date()) - timedelta(days=DEFAULT_WINDOW_DAYS)
        start = datetime.combine(start_day, time.min, tzinfo=timezone.utc) if start_day else None
        end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=timezone.utc) if end_day else None
        return start, end


def _scoped(query: Query, user, db: Session, shop_column, machine_column) -> Optional[Query]:
    if user is None:
        return query
    from app.services.scoping import scope_query_by_user

    return scope_query_by_user(query, user, db, shop_column=shop_column, machine_column=machine_column)


def attempts_query(db: Session, tenant_id: Any, user, f: Filters) -> Optional[Query]:
    """The attempts in scope (`user` None: unscoped, for the till's own paper). None: no access."""
    A = FailedPaymentAttempt
    query = db.query(A)
    if tenant_id is not None:
        query = query.filter(A.tenant_id == tenant_id)
    query = _scoped(query, user, db, A.shop_id, A.machine_id)
    if query is None:
        return None
    if f.machine_id is not None:
        query = query.filter(A.machine_id == f.machine_id)
    if f.shop_id is not None:
        query = query.filter(A.shop_id == f.shop_id)
    if f.shift_id is not None:
        query = query.filter(A.shift_id == f.shift_id)
    if f.coverage is not None:
        query = query.filter(_covered(f.coverage, A.shift_id, A.machine_id, A.occurred_at))
    start, end = f.window()
    if start is not None:
        query = query.filter(A.occurred_at >= start)
    if end is not None:
        query = query.filter(A.occurred_at < end)
    if f.outcomes:
        query = query.filter(A.outcome.in_(list(f.outcomes)))
    if f.card_last4:
        query = query.filter(A.card_last4 == f.card_last4)
    return query


def cancelled_query(db: Session, tenant_id: Any, user, f: Filters) -> Optional[Query]:
    """
    `cancelled` documents in the same scope and filters that no attempt accounts for: not
    an attempt's voided document, and not in the basket of an attempt's voided or paying
    document. The outcome / card filters are the attempts': they narrow these to none.
    """
    T = Transaction
    A = FailedPaymentAttempt
    if f.outcomes or f.card_last4:
        return None
    query = db.query(T).filter(T.status == TransactionStatus.CANCELLED)
    if tenant_id is not None:
        query = query.filter(T.tenant_id == tenant_id)
    query = _scoped(query, user, db, T.shop_id, T.machine_id)
    if query is None:
        return None
    if f.machine_id is not None:
        query = query.filter(T.machine_id == f.machine_id)
    if f.shop_id is not None:
        query = query.filter(T.shop_id == f.shop_id)
    if f.shift_id is not None:
        query = query.filter(T.shift_id == f.shift_id)
    if f.coverage is not None:
        query = query.filter(_covered(f.coverage, T.shift_id, T.machine_id, T.created_at))
    start, end = f.window()
    if start is not None:
        query = query.filter(T.created_at >= start)
    if end is not None:
        query = query.filter(T.created_at < end)
    linked = aliased(Transaction)
    query = query.filter(~exists().where(A.transaction_id == T.id))
    query = query.filter(
        or_(
            T.basket_id.is_(None),
            ~exists().where(
                linked.basket_id == T.basket_id,
                or_(A.transaction_id == linked.id, A.paid_by_transaction_id == linked.id),
            ),
        )
    )
    return query


def summarize(query: Optional[Query]) -> Dict[str, int]:
    """
    Sales (sale + keyed) and payouts apart; how many sales were paid later. An attempt found
    charged later (`approved_late`) is not a failed payment: left out of every figure (and
    counted apart, `approvedLateCount`). The unresolved ones (`unresolved`) are open, not
    completed: in the figures, and also counted apart.
    """
    out = {
        "count": 0, "totalAgorot": 0, "payoutCount": 0, "payoutTotalAgorot": 0, "paidLaterCount": 0,
        "unresolvedCount": 0, "unresolvedTotalAgorot": 0, "approvedLateCount": 0,
    }
    if query is None:
        return out
    A = FailedPaymentAttempt
    failed = A.outcome.notin_(list(NOT_FAILED_OUTCOMES))
    sale = and_(failed, A.kind != KIND_PAYOUT)
    payout = and_(failed, A.kind == KIND_PAYOUT)
    unresolved = A.outcome == OUTCOME_UNRESOLVED
    row = query.order_by(None).with_entities(
        func.coalesce(func.sum(case((sale, 1), else_=0)), 0),
        func.coalesce(func.sum(case((sale, A.amount_agorot), else_=0)), 0),
        func.coalesce(func.sum(case((payout, 1), else_=0)), 0),
        func.coalesce(func.sum(case((payout, A.amount_agorot), else_=0)), 0),
        func.coalesce(func.sum(case((and_(sale, A.paid_by_transaction_id.isnot(None)), 1), else_=0)), 0),
        func.coalesce(func.sum(case((unresolved, 1), else_=0)), 0),
        func.coalesce(func.sum(case((unresolved, A.amount_agorot), else_=0)), 0),
        func.coalesce(func.sum(case((A.outcome == OUTCOME_APPROVED_LATE, 1), else_=0)), 0),
    ).one()
    return dict(zip(out.keys(), (int(v or 0) for v in row)))


def is_failed(a: FailedPaymentAttempt) -> bool:
    """A failed or not-completed attempt (not one found charged later)."""
    return (a.outcome or "") not in NOT_FAILED_OUTCOMES


# ── Labels for the rows ───────────────────────────────────────────────────────


def _machines(db: Session, ids: Iterable[Any]) -> Dict[uuid.UUID, POSMachine]:
    ids = {i for i in ids if i is not None}
    return {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids))} if ids else {}


def _shops(db: Session, ids: Iterable[Any]) -> Dict[uuid.UUID, str]:
    ids = {i for i in ids if i is not None}
    return {s.id: s.name for s in db.query(Shop.id, Shop.name).filter(Shop.id.in_(ids))} if ids else {}


def _documents(db: Session, tenant_id: Any, ids: Iterable[Any]) -> Dict[uuid.UUID, str]:
    """Document numbers as printed (`20000057`, docs/SPEC_DOCUMENT_PREFIX.md), in the tenant."""
    from app.services.document_prefix import document_number_from

    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    query = db.query(
        Transaction.id, Transaction.transaction_number, Transaction.document_prefix, Transaction.pos_number
    ).filter(Transaction.id.in_(ids))
    if tenant_id is not None:
        query = query.filter(Transaction.tenant_id == tenant_id)
    return {t.id: document_number_from(t.transaction_number, t.document_prefix, t.pos_number) for t in query}


def _shift_numbers(db: Session, ids: Iterable[Any]) -> Dict[uuid.UUID, Optional[int]]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return {s.id: s.sequence_number for s in db.query(Shift.id, Shift.sequence_number).filter(Shift.id.in_(ids))}


def _cashier_names(db: Session, ids: Iterable[Any]) -> Dict[str, str]:
    wanted = {str(i): _uuid(i) for i in ids if i}
    real = {u for u in wanted.values() if u is not None}
    if not real:
        return {}
    out: Dict[str, str] = {}
    for pu in db.query(PosUser).filter(PosUser.id.in_(real)):
        full = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
        out[str(pu.id)] = full or pu.username
    return out


def _pos_number(machine: Optional[POSMachine]) -> Optional[str]:
    if machine is None:
        return None
    return machine.pos_number or machine.machine_code


def attempt_out(row: FailedPaymentAttempt, labels: Dict[str, Dict[Any, Any]]) -> Dict[str, Any]:
    machine = labels["machines"].get(row.machine_id)
    return {
        "id": row.id,
        "occurred_at": _utc(row.occurred_at),
        "resolved_at": _utc(row.resolved_at),
        "received_at": _utc(row.created_at),
        "updated_at": _utc(row.updated_at),
        "shop_id": row.shop_id,
        "shop_name": labels["shops"].get(row.shop_id),
        "machine_id": row.machine_id,
        "machine_name": machine.name if machine is not None else None,
        "pos_number": _pos_number(machine),
        "shift_id": row.shift_id,
        "shift_number": labels["shifts"].get(row.shift_id),
        "business_date": row.business_date,
        "pos_user_id": row.pos_user_id,
        "employee_name": row.employee_name,
        "amount_agorot": int(row.amount_agorot or 0),
        "method": row.method,
        "kind": row.kind,
        "channel": row.channel,
        "terminal_type": row.terminal_type,
        "terminal_id": row.terminal_id,
        "outcome": row.outcome,
        "reason_code": row.reason_code,
        "reason_message": row.reason_message,
        "card_brand": row.card_brand,
        "card_last4": row.card_last4,
        "line_count": row.line_count,
        "vuid": row.vuid,
        "transaction_id": row.transaction_id,
        "transaction_number": labels["documents"].get(row.transaction_id),
        "paid_by_transaction_id": row.paid_by_transaction_id,
        "paid_by_transaction_number": labels["documents"].get(row.paid_by_transaction_id),
        "paid_by_method": row.paid_by_method,
        "paid_at": _utc(row.paid_at),
        # "תשלום לא מוכרע": the manager's latest command to the till about it, and what it said;
        # and the latest answered check (what the terminal said), whatever came after it.
        "card_command": _command_out(labels.get("commands", {}).get(row.id)),
        "card_check": _command_out(labels.get("checks", {}).get(row.id)),
    }


def _command_out(cmd) -> Optional[Dict[str, Any]]:
    from app.services.card_attempt_commands import command_out

    return command_out(cmd)


def cancelled_out(tx: Transaction, machines: Dict[uuid.UUID, POSMachine], cashiers: Dict[str, str]) -> Dict[str, Any]:
    from app.services.document_prefix import document_number_from

    machine = machines.get(tx.machine_id)
    return {
        "id": tx.id,
        "document_number": document_number_from(tx.transaction_number, tx.document_prefix, tx.pos_number),
        "transaction_number": tx.transaction_number,
        "document_type": tx.document_type,
        "total_amount": float(tx.total_amount or 0),
        "total_agorot": to_agorot(tx.total_amount),
        "payment_method": tx.payment_method,
        "created_at": _utc(tx.created_at),
        "shop_id": tx.shop_id,
        "machine_id": tx.machine_id,
        "machine_name": machine.name if machine is not None else None,
        "pos_number": _pos_number(machine) if machine is not None else tx.pos_number,
        "shift_id": tx.shift_id,
        "cashier_id": tx.cashier_id,
        "cashier_name": cashiers.get(str(tx.cashier_id)) if tx.cashier_id else None,
    }


def cancelled_block(db: Session, query: Optional[Query], limit: int = CANCELLED_ITEMS_MAX) -> Dict[str, Any]:
    """`{count, totalAgorot, items}` of the cancelled sales (newest first, at most `limit`)."""
    if query is None:
        return {"count": 0, "total_agorot": 0, "items": []}
    count, total = query.order_by(None).with_entities(
        func.count(Transaction.id), func.coalesce(func.sum(Transaction.total_amount), 0)
    ).one()
    rows = (
        query.order_by(Transaction.created_at.desc(), Transaction.id).limit(limit).all() if count else []
    )
    machines = _machines(db, (r.machine_id for r in rows))
    cashiers = _cashier_names(db, (r.cashier_id for r in rows))
    return {
        "count": int(count or 0),
        "total_agorot": to_agorot(total),
        "items": [cancelled_out(r, machines, cashiers) for r in rows],
    }


def labels_for(db: Session, tenant_id: Any, rows: Sequence[FailedPaymentAttempt]) -> Dict[str, Dict[Any, Any]]:
    from app.services.card_attempt_commands import latest_by_attempt, latest_checks_by_attempt

    unresolved = [r.id for r in rows if r.outcome == OUTCOME_UNRESOLVED]
    return {
        "commands": latest_by_attempt(db, unresolved),
        "checks": latest_checks_by_attempt(db, unresolved),
        "machines": _machines(db, (r.machine_id for r in rows)),
        "shops": _shops(db, (r.shop_id for r in rows)),
        "shifts": _shift_numbers(db, (r.shift_id for r in rows)),
        "documents": _documents(
            db, tenant_id, [r.transaction_id for r in rows] + [r.paid_by_transaction_id for r in rows]
        ),
    }


class ZNotFound(Exception):
    """The Z named by `zReportId` is not this tenant's."""


def filters_for(
    db: Session,
    tenant_id: Any,
    *,
    machine_id: Optional[uuid.UUID] = None,
    shop_id: Optional[uuid.UUID] = None,
    shift_id: Optional[uuid.UUID] = None,
    z_report_id: Optional[uuid.UUID] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    outcome: Optional[str] = None,
    card_last4: Optional[str] = None,
) -> Filters:
    coverage = None
    if z_report_id is not None:
        query = db.query(ZReport).filter(ZReport.id == z_report_id)
        if tenant_id is not None:
            query = query.filter(ZReport.tenant_id == tenant_id)
        z = query.first()
        if z is None:
            raise ZNotFound(str(z_report_id))
        coverage = z_coverage(db, z)
    outcomes = tuple(p.strip().lower() for p in (outcome or "").split(",") if p.strip())
    return Filters(
        machine_id=machine_id,
        shop_id=shop_id,
        shift_id=shift_id,
        coverage=coverage,
        from_date=from_date,
        to_date=to_date,
        outcomes=outcomes,
        card_last4=card_last4 or None,
    )


def list_response(
    db: Session,
    user,
    tenant_id: Any,
    f: Filters,
    *,
    page: int = 1,
    page_size: int = 50,
) -> Dict[str, Any]:
    """The dashboard's list: a page of attempts (newest first), the summary, the cancelled sales."""
    page = max(1, int(page))
    page_size = max(1, min(PAGE_SIZE_MAX, int(page_size)))
    query = attempts_query(db, tenant_id, user, f)
    out: Dict[str, Any] = {
        "page": page,
        "page_size": page_size,
        "total": 0,
        "summary": summarize(None),
        "items": [],
        "cancelled_sales": cancelled_block(db, None),
    }
    if query is None:
        return out
    total = query.order_by(None).count()
    A = FailedPaymentAttempt
    rows = (
        # The unresolved first ("לא הוכרע": possibly charged, the till waits), then newest first.
        query.order_by(case((A.outcome == OUTCOME_UNRESOLVED, 0), else_=1), A.occurred_at.desc(), A.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    labels = labels_for(db, tenant_id, rows)
    out.update(
        total=total,
        summary=summarize(query),
        items=[attempt_out(r, labels) for r in rows],
        cancelled_sales=cancelled_block(db, cancelled_query(db, tenant_id, user, f)),
    )
    return out


# ── The Z on paper ────────────────────────────────────────────────────────────


def _line(label: str, value: str = "", emphasis: bool = False) -> Dict[str, Any]:
    """A print row whose label may run wider than a figure's (an attempt's line)."""
    return {"label": label, "value": value, "emphasis": bool(emphasis)}


def _shekels(agorot: int) -> str:
    from app.services.z_print import money

    return money(Decimal(int(agorot or 0)) / 100)


def _hhmm(moment: Optional[datetime], tzinfo) -> str:
    moment = _utc(moment)
    if moment is None:
        return "--:--"
    return (moment.astimezone(tzinfo) if tzinfo is not None else moment).strftime("%H:%M")


def attempt_rows(a: FailedPaymentAttempt, tzinfo) -> List[Dict[str, Any]]:
    """
    `HH:MM · אשראי · נדחתה · ****1234` with the amount; too wide for 80 mm, the outcome goes
    on its own line under it. Then "שולם בהמשך …" when the basket was paid later.
    """
    head = [_hhmm(a.occurred_at, tzinfo), method_label(a.method)]
    if a.channel == "kiosk":
        head.append("קיוסק")
    card = f"****{a.card_last4}" if a.card_last4 else None
    full = " · ".join([*head, outcome_label(a.outcome), *([card] if card else [])])
    amount = _shekels(a.amount_agorot)
    if len(full) <= PRINT_LABEL_MAX:
        rows = [_line(full, amount)]
    else:
        rows = [
            _line(" · ".join([*head, *([card] if card else [])]), amount),
            _line("  " + outcome_label(a.outcome)),
        ]
    if a.paid_by_transaction_id is not None or a.paid_by_method:
        rows.append(_line("  " + paid_later_label(a.paid_by_method)))
    return rows


def _pos_label(machine: Optional[POSMachine], machine_id: Any) -> str:
    pos = _pos_number(machine)
    if pos:
        return f"קופה {pos}"
    return f"קופה {machine.name}" if machine is not None and machine.name else f"קופה {str(machine_id)[:8]}"


def _till_order(machines: Dict[uuid.UUID, POSMachine]):
    """Tills in till-number order (2 before 10), then by name."""

    def key(item):
        machine = machines.get(item[0])
        pos = str(_pos_number(machine) or "").strip()
        return (0, int(pos), "") if pos.isdigit() else (1, 0, pos or str(item[0]))

    return key


def print_sections(
    db: Session, z: ZReport, tzinfo, *, machine_id: Any = None
) -> List[Dict[str, Any]]:
    """
    "עסקאות שלא הושלמו" and "מכירות שבוטלו" for a Z's paper — of one till (`machine_id`, a
    shop Z's till detail), else of the whole Z: listed line by line for one till, one line
    per till for a Z over several. Each section omitted when empty; informational only.
    """
    cov = z_coverage(db, z)
    f = Filters(machine_id=_uuid(machine_id), coverage=cov)
    query = attempts_query(db, z.tenant_id, None, f)
    attempts = query.order_by(FailedPaymentAttempt.occurred_at, FailedPaymentAttempt.id).all() if query is not None else []
    # One found charged later completed its sale: not a payment that did not go through.
    attempts = [a for a in attempts if is_failed(a)]
    cancelled_q = cancelled_query(db, z.tenant_id, None, f)
    cancelled = (
        cancelled_q.order_by(Transaction.created_at, Transaction.id).all() if cancelled_q is not None else []
    )
    per_till = f.machine_id is None and len({a.machine_id for a in attempts} | {t.machine_id for t in cancelled}) > 1
    machines = _machines(db, [a.machine_id for a in attempts] + [t.machine_id for t in cancelled]) if per_till else {}

    sections: List[Dict[str, Any]] = []
    sales = [a for a in attempts if a.kind != KIND_PAYOUT]
    payouts = [a for a in attempts if a.kind == KIND_PAYOUT]
    if attempts:
        rows: List[Dict[str, Any]] = [_line(INFO_ONLY)]
        if sales:
            rows.append(_line("מספר / סה״כ", f"{len(sales)} / {_shekels(sum(a.amount_agorot for a in sales))}", True))
            if per_till:
                by_till: Dict[Any, List[FailedPaymentAttempt]] = {}
                for a in sales:
                    by_till.setdefault(a.machine_id, []).append(a)
                for mid, items in sorted(by_till.items(), key=_till_order(machines)):
                    rows.append(_line(
                        _pos_label(machines.get(mid), mid),
                        f"{len(items)} / {_shekels(sum(a.amount_agorot for a in items))}",
                    ))
            else:
                for a in sales[:PRINT_ROWS_MAX]:
                    rows.extend(attempt_rows(a, tzinfo))
                if len(sales) > PRINT_ROWS_MAX:
                    rows.append(_line(f"ועוד {len(sales) - PRINT_ROWS_MAX}"))
        if payouts:
            rows.append(_line(
                "זיכויים שלא הושלמו",
                f"{len(payouts)} / {_shekels(sum(a.amount_agorot for a in payouts))}",
                True,
            ))
        sections.append({"title": SECTION_TITLE, "key": SECTION_KEY, "informational": True, "rows": rows})
    if cancelled:
        from app.services.document_prefix import document_number_from

        total = sum(to_agorot(t.total_amount) for t in cancelled)
        rows = [_line("מספר / סה״כ", f"{len(cancelled)} / {_shekels(total)}", True)]
        if per_till:
            by_till_tx: Dict[Any, List[Transaction]] = {}
            for t in cancelled:
                by_till_tx.setdefault(t.machine_id, []).append(t)
            for mid, items in sorted(by_till_tx.items(), key=_till_order(machines)):
                rows.append(_line(
                    _pos_label(machines.get(mid), mid),
                    f"{len(items)} / {_shekels(sum(to_agorot(t.total_amount) for t in items))}",
                ))
        else:
            for t in cancelled[:PRINT_ROWS_MAX]:
                number = document_number_from(t.transaction_number, t.document_prefix, t.pos_number)
                rows.append(_line(f"{_hhmm(t.created_at, tzinfo)} · {number}", _shekels(to_agorot(t.total_amount))))
            if len(cancelled) > PRINT_ROWS_MAX:
                rows.append(_line(f"ועוד {len(cancelled) - PRINT_ROWS_MAX}"))
        sections.append({"title": CANCELLED_TITLE, "key": CANCELLED_KEY, "informational": True, "rows": rows})
    return sections


def with_print_sections(
    db: Session, z: ZReport, doc: Optional[Dict[str, Any]], tzinfo, *, machine_id: Any = None
) -> Optional[Dict[str, Any]]:
    """
    The print document with the sections appended (after every fiscal block, before the
    footer). Read live at print time, so an attempt that arrived after the Z still shows.
    Never fails the print: on any error the document goes out without them.
    """
    if not isinstance(doc, dict):
        return doc
    try:
        extra = print_sections(db, z, tzinfo, machine_id=machine_id)
    except Exception:  # noqa: BLE001 - informational; the Z prints regardless
        logger.exception("Failed payments section for Z %s", getattr(z, "id", None))
        return doc
    if extra:
        doc["sections"] = [*(doc.get("sections") or []), *extra]
    return doc


# ── One attempt, for the dashboard's actions ──────────────────────────────────


def attempt_for_user(db: Session, tenant_id: Any, user, attempt_id: Any) -> Optional[FailedPaymentAttempt]:
    """The attempt when it is in the tenant and the user's scope (as the list reads it), else None."""
    A = FailedPaymentAttempt
    ident = _uuid(attempt_id)
    if ident is None:
        return None
    query = db.query(A).filter(A.id == ident)
    if tenant_id is not None:
        query = query.filter(A.tenant_id == tenant_id)
    query = _scoped(query, user, db, A.shop_id, A.machine_id)
    return query.first() if query is not None else None
