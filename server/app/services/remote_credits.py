"""
"זיכוי מרחוק" — a credit for a document, asked for from the dashboard and issued by a till
(docs/SPEC_REMOTE_CREDIT.md).

The owner: "תאפשר ליצור עסקת זיכוי בעסקאות ולבחור לאיזה מכשיר פתוח העסקה תיכנס" — e.g. a
sale whose card payment was in fact declined: without a credit the business pays tax on a
sale that never happened.

**The cloud never issues the document.** Only a till does: numbers are per till series,
saved before use, never reused. So the dashboard records a request (`RemoteCreditRequest`)
for a till of the same business with an open shift; the till receives it the way it
receives a remote shift close — the `remote-credit` Ably event while online,
`pendingRemoteCredits` on every heartbeat, the details from `GET /sync/{m}/remote-credits`
— issues the credit with its own refund code inside its open shift, and answers with
`POST /sync/{m}/remote-credits/{id}/ack`. The credit document itself also names the
request (`remoteCreditRequestId`), so it completes the request on arrival as well.

Two modes (`RemoteCreditMode`):

* `no_money` — "העסקה לא בוצעה בפועל": issued at once by the till, its tender the
  original's, marked `noMoneyMovement` — no pinpad, no drawer, no refund expected.
* `prepared` — "להשלמה בקופה": a waiting refund on the till that the cashier completes with
  the till's normal refund flow and any tender. Expires after `remoteCreditExpiryHours`.

What may be credited is what the till's own refund flow allows (`RefundMath` in
pos-android): per original line, the quantity sold less what earlier credit notes took
(by `refund_of_item_id`, the product as the legacy fallback) — and here also less what
other pending requests hold. The money per line is the till's own rule, ported:
`collected_per_line` (the line less its own discounts, less its share of the basket
discount by largest remainder) and `credit_for` (cumulative rounding).
"""
from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.remote_credit import (
    PENDING_REMOTE_CREDIT_STATUSES,
    REMOTE_CREDIT_MODES,
    RemoteCreditEvent,
    RemoteCreditMode as M,
    RemoteCreditRequest,
    RemoteCreditStatus as S,
)
from app.models.shop import Shop
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.services.machine_status import is_online
from app.services.tenders import (
    EXCHANGE_PAYMENT_METHOD,
    UNKNOWN_PAYMENT_METHOD,
    expected_tender_total,
    is_refund_document,
)

logger = logging.getLogger(__name__)

# ── Rules and words ───────────────────────────────────────────────────────────

#: A request for mode 1 lives as long as a remote close (a till off overnight still gets it).
NO_MONEY_TTL_HOURS = 36
#: Mode 2: the till parameter, else this many hours.
EXPIRY_PARAMETER_KEY = "remoteCreditExpiryHours"
DEFAULT_PREPARED_TTL_HOURS = 24
MIN_TTL_HOURS = 1
MAX_TTL_HOURS = 168
#: Read by the till: print the credit it issued for a mode-1 request (default yes).
PRINT_PARAMETER_KEY = "remoteCreditPrint"

REASON_MAX = 300
#: The quick reasons the dashboard offers; the text itself is always stored.
REASONS: Tuple[Tuple[str, str], ...] = (
    ("declined_at_terminal", "העסקה נדחתה במסוף"),
    ("not_charged", "החיוב לא בוצע בפועל"),
    ("not_transmitted", "העסקה לא שודרה לחברת האשראי"),
    ("customer_did_not_pay", "הלקוח לא שילם"),
    ("duplicate_document", "מסמך כפול"),
    ("other", "אחר"),
)
REASON_CODES = {code for code, _ in REASONS}

#: What the credit and every report says of a mode-1 credit.
NO_MONEY_LABEL = "ללא החזר כספי — עסקה שלא בוצעה"

QUANTITY_TOLERANCE = Decimal("0.0005")
CENT = Decimal("0.01")

REMOTE_CREDIT_PARAMETER_SPECS = (
    dict(
        key=PRINT_PARAMETER_KEY,
        label="זיכוי מרחוק — הדפסה בקופה",
        value_type="boolean",
        default_value=True,
        description=(
            "זיכוי שנשלח מהדשבורד במצב \"העסקה לא בוצעה בפועל\" (ללא החזר כספי) מופק בקופה "
            "אוטומטית. מופעל (ברירת מחדל) — הקופה מדפיסה את מסמך הזיכוי. כבוי — הזיכוי מופק "
            "ומוצג בהודעה בקופה, בלי הדפסה (אפשר להדפיס מההיסטוריה). "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=EXPIRY_PARAMETER_KEY,
        label="זיכוי מרחוק — תוקף זיכוי להשלמה בקופה (שעות)",
        value_type="integer",
        default_value=DEFAULT_PREPARED_TTL_HOURS,
        description=(
            "זיכוי שנשלח מהדשבורד במצב \"להשלמה בקופה\" ממתין בקופה עד שהקופאי משלים אותו. "
            "אם לא הושלם בתוך מספר השעות הזה (ברירת מחדל 24, בין 1 ל-168) — הוא פג ויורד "
            "מהקופה. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)


def _refuse(code: str, message: str, status_code: int = status.HTTP_409_CONFLICT) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _dec(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _round_half_up(value: Decimal) -> int:
    """Kotlin's `Math.round` for the non-negative amounts here."""
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _agorot(shekels: Any) -> int:
    return _round_half_up(_dec(shekels) * 100)


def _shekels(agorot: int) -> Decimal:
    return (Decimal(agorot) / 100).quantize(CENT)


# ── The till's refund arithmetic, ported (pos-android domain/RefundMath.kt) ────


def collected_per_line(items: Sequence[TransactionItem], document_discount: Any) -> Dict[uuid.UUID, int]:
    """
    What the customer paid for each line, in agorot: the line's gross less its own
    discounts (the cashier's and its promotions'), less its share of the basket discount
    — `document_discount` less the lines' own — shared by value after the lines' own,
    the agorot that do not divide going to the largest remainders.
    """

    def own(item) -> int:
        return abs(_agorot(item.discount)) + abs(_agorot(getattr(item, "promotion_discount", None)))

    after_line: Dict[uuid.UUID, int] = {}
    for item in items:
        gross = _round_half_up(Decimal(_agorot(item.unit_price)) * abs(_dec(item.quantity)))
        after_line[item.id] = gross - own(item)
    line_discounts = sum(own(i) for i in items)
    sum_after = sum(after_line.values())
    basket = max(0, min(_agorot(document_discount) - line_discounts, max(sum_after, 0)))
    if basket == 0 or sum_after <= 0:
        return after_line
    exact = {k: Decimal(v) * basket / sum_after for k, v in after_line.items()}
    floors = {k: int(math.floor(e)) for k, e in exact.items()}
    leftover = basket - sum(floors.values())
    extra: Dict[uuid.UUID, int] = {}
    for key, _e in sorted(exact.items(), key=lambda kv: kv[1] - floors[kv[0]], reverse=True):
        if leftover <= 0:
            break
        extra[key] = 1
        leftover -= 1
    return {k: v - floors.get(k, 0) - extra.get(k, 0) for k, v in after_line.items()}


def credit_for(collected: int, original_qty: Decimal, already: Decimal, quantity: Decimal) -> int:
    """Agorot for crediting `quantity` of a line (cumulative rounding, as the till does)."""
    if quantity <= 0 or original_qty <= 0:
        return 0
    before = min(max(already, Decimal("0")), original_qty)
    after = min(before + quantity, original_qty)

    def share(q: Decimal) -> int:
        return _round_half_up(Decimal(collected) * (q / original_qty))

    return share(after) - share(before)


# ── What is still creditable ──────────────────────────────────────────────────


@dataclass
class LineState:
    item: TransactionItem
    sold: Decimal
    #: Taken by credit notes already issued (any status but cancelled, as the till counts).
    credited: Decimal
    #: Held by other pending requests.
    pending: Decimal
    collected: int

    @property
    def remaining(self) -> Decimal:
        return max(Decimal("0"), self.sold - self.credited - self.pending)


@dataclass
class Creditable:
    original: Transaction
    lines: List[LineState]
    #: What the original collected (total − document discount).
    collected: Decimal
    #: Σ credit notes already issued against it.
    credited_amount: Decimal
    #: Σ other pending requests.
    pending_amount: Decimal
    pending_requests: List[RemoteCreditRequest] = field(default_factory=list)

    @property
    def remaining_amount(self) -> Decimal:
        return max(Decimal("0"), self.collected - self.credited_amount - self.pending_amount)

    def line(self, item_id: uuid.UUID) -> Optional[LineState]:
        return next((l for l in self.lines if l.item.id == item_id), None)


def _credit_notes_of(db: Session, original: Transaction, item_ids: Sequence[uuid.UUID]) -> List[Transaction]:
    by_line = select(TransactionItem.transaction_id).where(TransactionItem.refund_of_item_id.in_(list(item_ids)))
    q = db.query(Transaction).filter(
        Transaction.tenant_id == original.tenant_id,
        Transaction.id != original.id,
        Transaction.status != TransactionStatus.CANCELLED,
    )
    if item_ids:
        q = q.filter(or_(Transaction.refund_of_transaction_id == original.id, Transaction.id.in_(by_line)))
    else:
        q = q.filter(Transaction.refund_of_transaction_id == original.id)
    return q.all()


def creditable(
    db: Session, original: Transaction, *, exclude_request_id: Optional[uuid.UUID] = None
) -> Creditable:
    # Lines carry no position of their own: by name, then id — the same order every read.
    items = sorted(
        db.query(TransactionItem).filter(TransactionItem.transaction_id == original.id).all(),
        key=lambda i: ((i.product_name or ""), str(i.id)),
    )
    item_ids = [i.id for i in items]
    credits = _credit_notes_of(db, original, item_ids)
    credit_lines = (
        db.query(TransactionItem).filter(TransactionItem.transaction_id.in_([c.id for c in credits])).all()
        if credits
        else []
    )
    # Keyed by the original line, the product as the legacy fallback (RefundMath.refundedQuantities).
    refunded: Dict[str, Decimal] = {}
    for line in credit_lines:
        key = str(line.refund_of_item_id or line.product_id)
        refunded[key] = refunded.get(key, Decimal("0")) + abs(_dec(line.quantity))
    credited_amount = Decimal("0")
    for credit in credits:
        if credit.refund_of_transaction_id == original.id:
            credited_amount += abs(_dec(credit.total_amount))
        else:
            credited_amount += sum(
                (abs(_dec(l.total_price)) for l in credit_lines
                 if l.transaction_id == credit.id and l.refund_of_item_id in set(item_ids)),
                Decimal("0"),
            )

    pending_q = db.query(RemoteCreditRequest).filter(
        RemoteCreditRequest.original_transaction_id == original.id,
        RemoteCreditRequest.status.in_(PENDING_REMOTE_CREDIT_STATUSES),
    )
    if exclude_request_id is not None:
        pending_q = pending_q.filter(RemoteCreditRequest.id != exclude_request_id)
    pending_requests = pending_q.all()
    pending_qty: Dict[str, Decimal] = {}
    pending_amount = Decimal("0")
    for req in pending_requests:
        pending_amount += _dec(req.amount)
        for line in req.lines or []:
            key = str(line.get("itemId"))
            pending_qty[key] = pending_qty.get(key, Decimal("0")) + _dec(line.get("quantity"))

    collected_map = collected_per_line(items, original.document_discount)
    states = []
    for item in items:
        already = refunded.get(str(item.id))
        if already is None:
            already = refunded.get(str(item.product_id), Decimal("0"))
        states.append(
            LineState(
                item=item,
                sold=abs(_dec(item.quantity)),
                credited=min(already, abs(_dec(item.quantity))),
                pending=pending_qty.get(str(item.id), Decimal("0")),
                collected=collected_map.get(item.id, 0),
            )
        )
    collected = expected_tender_total(
        total_amount=original.total_amount,
        document_discount=original.document_discount,
        document_type=original.document_type,
        refund_of_transaction_id=original.refund_of_transaction_id,
    )
    return Creditable(
        original=original,
        lines=states,
        collected=_dec(collected),
        credited_amount=credited_amount,
        pending_amount=pending_amount,
        pending_requests=pending_requests,
    )


def plan_lines(cr: Creditable, *, full: bool, requested: Sequence[Tuple[uuid.UUID, Decimal]]) -> List[dict]:
    """
    The request's lines with the money for each, or a 409.

    `full`: every line's remaining quantity. Otherwise each `(itemId, quantity)` must name
    a line of the original and stay within what is left on it.
    """
    wanted: Dict[uuid.UUID, Decimal] = {}
    if full:
        for state in cr.lines:
            if state.remaining > QUANTITY_TOLERANCE:
                wanted[state.item.id] = state.remaining
    else:
        for item_id, qty in requested:
            state = cr.line(item_id)
            if state is None:
                raise _refuse("unknown_line", "שורה שנבחרה אינה שייכת למסמך.", status.HTTP_422_UNPROCESSABLE_ENTITY)
            if qty <= 0:
                continue
            wanted[item_id] = wanted.get(item_id, Decimal("0")) + qty
        for item_id, qty in wanted.items():
            state = cr.line(item_id)
            if qty > state.remaining + QUANTITY_TOLERANCE:
                raise _refuse(
                    "over_credit",
                    f"אי אפשר לזכות {_qty_text(qty)} מ\"{state.item.product_name or ''}\": "
                    f"נשארו לזיכוי {_qty_text(state.remaining)} בלבד (כולל זיכויים קודמים ובקשות ממתינות).",
                )
    if not wanted:
        raise _refuse("nothing_to_credit", "לא נשאר מה לזכות במסמך הזה.")
    lines = []
    for state in cr.lines:
        qty = wanted.get(state.item.id)
        if qty is None:
            continue
        qty = min(qty, state.remaining)
        amount = credit_for(state.collected, state.sold, state.credited + state.pending, qty)
        lines.append(
            {
                "itemId": str(state.item.id),
                "productId": str(state.item.product_id) if state.item.product_id else None,
                "productName": state.item.product_name,
                "quantity": float(qty),
                "amount": str(_shekels(amount)),
            }
        )
    total = sum((_dec(l["amount"]) for l in lines), Decimal("0"))
    if total <= 0:
        raise _refuse("nothing_to_credit", "סכום הזיכוי יוצא 0 — אין מה לזכות.")
    if total > cr.remaining_amount + CENT * len(lines):
        raise _refuse(
            "over_credit",
            f"הזיכוי ({total} ₪) גדול ממה שנשאר לזכות במסמך ({cr.remaining_amount} ₪).",
        )
    return lines


def _qty_text(qty: Decimal) -> str:
    q = _dec(qty).normalize()
    return format(q, "f")


def mirror_tenders(db: Session, original: Transaction, amount: Decimal) -> List[dict]:
    """
    Mode 1's tender: the original's real tenders (never `exchange`), the credit's amount
    shared over them in proportion, the leftover agorot to the largest remainders — the
    same rule the till applies (pos-android domain/RemoteCredit.kt `mirrorTenders`).
    """
    legs = (
        db.query(TransactionPayment)
        .filter(TransactionPayment.transaction_id == original.id)
        .order_by(TransactionPayment.sequence, TransactionPayment.id)
        .all()
    )
    real = [
        ((l.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD, _agorot(l.amount))
        for l in legs
        if (l.method or "").strip().lower() != EXCHANGE_PAYMENT_METHOD and _agorot(l.amount) > 0
    ]
    if not legs:
        real = [((original.payment_method or UNKNOWN_PAYMENT_METHOD).strip().lower(), _agorot(amount))]
    return split_over(real, _agorot(amount))


def split_over(legs: Sequence[Tuple[str, int]], amount: int) -> List[dict]:
    """`amount` agorot over `legs` by their amounts (largest remainder, ties to the first)."""
    base = sum(a for _, a in legs)
    if not legs or base <= 0 or amount <= 0:
        return []
    exact = [Decimal(a) * amount / base for _, a in legs]
    floors = [int(math.floor(e)) for e in exact]
    leftover = amount - sum(floors)
    order = sorted(range(len(legs)), key=lambda i: (-(exact[i] - floors[i]), i))
    for i in order:
        if leftover <= 0:
            break
        floors[i] += 1
        leftover -= 1
    merged: Dict[str, int] = {}
    for (method, _), share in zip(legs, floors):
        merged[method] = merged.get(method, 0) + share
    return [{"method": m, "amount": str(_shekels(a))} for m, a in merged.items() if a > 0]


# ── The original ──────────────────────────────────────────────────────────────


def original_refusal(original: Transaction) -> Optional[HTTPException]:
    if is_refund_document(
        document_type=original.document_type, refund_of_transaction_id=original.refund_of_transaction_id
    ):
        return _refuse("not_a_sale", "זה מסמך זיכוי — אפשר לזכות רק מסמך מכירה.")
    if original.status == TransactionStatus.REFUNDED:
        return _refuse("already_refunded", "המסמך כבר זוכה במלואו.")
    if original.status not in (TransactionStatus.COMPLETED, TransactionStatus.PARTIAL_REFUND):
        return _refuse("not_a_completed_sale", "המסמך לא הושלם (ממתין או בוטל) — אין מה לזכות.")
    return None


def _company_of_shop(db: Session, shop_id) -> Optional[Company]:
    if shop_id is None:
        return None
    return (
        db.query(Company).join(Shop, Shop.company_id == Company.id).filter(Shop.id == shop_id).first()
    )


def original_company(db: Session, original: Transaction) -> Optional[Company]:
    shop_id = original.shop_id
    if shop_id is None and original.machine_id is not None:
        row = db.query(POSMachine.shop_id).filter(POSMachine.id == original.machine_id).first()
        shop_id = row[0] if row else None
    return _company_of_shop(db, shop_id)


def same_business(a: Optional[Company], b: Optional[Company]) -> bool:
    """The same company, or two companies filed under the same VAT number (ח.פ / ע.מ)."""
    if a is None or b is None:
        return False
    if a.id == b.id:
        return True
    va, vb = (a.vat_number or "").strip(), (b.vat_number or "").strip()
    return bool(va) and va == vb


# ── Target tills ──────────────────────────────────────────────────────────────


def open_shift_of(db: Session, machine: POSMachine) -> Optional[dict]:
    """The till's open shift: the cloud's, else the one its heartbeat claims."""
    from app.services.shifts import find_open_shift

    shift = find_open_shift(db, machine.id)
    if shift is not None:
        return {"id": str(shift.id), "openedAt": _utc(shift.opened_at), "sequenceNumber": shift.sequence_number}
    claimed = getattr(machine, "reported_open_shift_id", None)
    if claimed is not None:
        return {
            "id": str(claimed),
            "openedAt": _utc(getattr(machine, "reported_open_shift_opened_at", None)),
            "sequenceNumber": None,
        }
    return None


def target_refusal(db: Session, original: Transaction, machine: POSMachine) -> Optional[HTTPException]:
    """Why `machine` cannot issue a credit for `original`, or None."""
    from app.services import device_profile
    from app.services import display_devices as DD

    if machine.tenant_id != original.tenant_id or not machine.is_active:
        return _refuse("target_not_found", "הקופה לא נמצאה.", status.HTTP_404_NOT_FOUND)
    if machine.pairing_status != PairingStatus.ASSIGNED or machine.shop_id is None:
        return _refuse("target_not_assigned", "הקופה אינה משויכת לסניף.")
    if not DD.is_fiscal(machine) or device_profile.effective_role(db, machine) != device_profile.ROLE_TILL:
        return _refuse("target_not_a_till", "רק קופה מפיקה זיכויים — לא קיוסק ולא מסך תצוגה.")
    if not same_business(original_company(db, original), _company_of_shop(db, machine.shop_id)):
        return _refuse("target_other_business", "הקופה שייכת לעסק אחר (מספר עוסק שונה) — אפשר לזכות רק באותו עסק.")
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if shop is not None and getattr(shop, "training_mode", False):
        return _refuse("target_in_training", "הסניף במצב הדרכה — זיכוי אמיתי לא יוצא מקופה בהדרכה.")
    if open_shift_of(db, machine) is None:
        return _refuse("target_no_open_shift", "אין בקופה משמרת פתוחה. פתחו משמרת בקופה או בחרו קופה אחרת.")
    return None


def eligible_targets(db: Session, original: Transaction, may_use, *, now: Optional[datetime] = None) -> List[dict]:
    """The tills that may issue this credit, the original's own first, then by shop and number."""
    now = _now(now)
    company = original_company(db, original)
    if company is None:
        return []
    companies = [company.id]
    vat = (company.vat_number or "").strip()
    if vat:
        companies = [
            r[0]
            for r in db.query(Company.id)
            .filter(Company.tenant_id == original.tenant_id, Company.vat_number == vat)
            .all()
        ] or [company.id]
    shops = {s.id: s for s in db.query(Shop).filter(Shop.company_id.in_(companies)).all()}
    if not shops:
        return []
    machines = (
        db.query(POSMachine)
        .filter(
            POSMachine.tenant_id == original.tenant_id,
            POSMachine.shop_id.in_(list(shops)),
            POSMachine.is_active.is_(True),
        )
        .all()
    )
    out = []
    for m in machines:
        if target_refusal(db, original, m) is not None or not may_use(m):
            continue
        shop = shops.get(m.shop_id)
        out.append(
            {
                "machineId": str(m.id),
                "name": m.name,
                "posNumber": m.pos_number,
                "shopId": str(m.shop_id),
                "shopName": shop.name if shop is not None else None,
                "online": is_online(m.last_heartbeat_at, now=now),
                "lastHeartbeatAt": _utc(m.last_heartbeat_at),
                "openShift": open_shift_of(db, m),
                "isOriginalTill": m.id == original.machine_id,
            }
        )
    out.sort(key=lambda t: (not t["isOriginalTill"], t["shopName"] or "", _pos_key(t["posNumber"]), t["name"] or ""))
    return out


def _pos_key(pos: Optional[str]):
    p = (pos or "").strip()
    return (0, int(p), "") if p.isdigit() else (1, 0, p)


# ── Lifecycle ─────────────────────────────────────────────────────────────────


def _event(
    db: Session,
    req: RemoteCreditRequest,
    action: str,
    *,
    actor: str,
    user: Optional[User] = None,
    machine_id=None,
    detail: Optional[str] = None,
    data: Optional[dict] = None,
    now: Optional[datetime] = None,
) -> None:
    db.add(
        RemoteCreditEvent(
            id=uuid.uuid4(),
            request_id=req.id,
            tenant_id=req.tenant_id,
            at=_now(now),
            actor=actor,
            user_id=user.id if user is not None else None,
            machine_id=machine_id,
            action=action,
            detail=detail,
            data=data,
        )
    )


def _initiator(user: User) -> str:
    return (
        getattr(user, "full_name", None)
        or getattr(user, "username", None)
        or getattr(user, "email", None)
        or str(user.id)
    )


def prepared_ttl_hours(db: Session, machine: POSMachine) -> int:
    """The till's `remoteCreditExpiryHours`, else 24 — clamped to 1–168."""
    try:
        from app.services.till_parameters import till_parameters_for_machine

        raw = till_parameters_for_machine(db, machine).parameters.get(EXPIRY_PARAMETER_KEY)
    except Exception:  # noqa: BLE001 - a parameter never blocks a credit
        logger.exception("could not read %s for %s", EXPIRY_PARAMETER_KEY, machine.id)
        raw = None
    try:
        hours = int(raw) if raw is not None and not isinstance(raw, bool) else DEFAULT_PREPARED_TTL_HOURS
    except (TypeError, ValueError):
        hours = DEFAULT_PREPARED_TTL_HOURS
    return max(MIN_TTL_HOURS, min(MAX_TTL_HOURS, hours))


def expire_overdue(db: Session, *, now: Optional[datetime] = None) -> int:
    """Lazy, from every read and write path."""
    now = _now(now)
    rows = (
        db.query(RemoteCreditRequest)
        .filter(
            RemoteCreditRequest.status.in_(PENDING_REMOTE_CREDIT_STATUSES),
            RemoteCreditRequest.expires_at < now,
        )
        .all()
    )
    for req in rows:
        req.status = S.EXPIRED
        req.error_code = "expired"
        req.error_message = "הזיכוי לא בוצע בקופה בזמן"
        req.failed_at = now
        req.updated_at = now
        _event(db, req, "expired", actor="system", now=now)
    if rows:
        db.flush()
    return len(rows)


def _clean_reason(reason: Optional[str], code: Optional[str]) -> Tuple[Optional[str], str]:
    code = (code or "").strip() or None
    if code is not None and code not in REASON_CODES:
        raise _refuse("unknown_reason", "סיבה לא מוכרת.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    text = " ".join((reason or "").split())
    if not text and code is not None and code != "other":
        text = dict(REASONS)[code]
    if len(text) < 2:
        raise _refuse("reason_required", "חובה לציין סיבה לזיכוי.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    return code, text[:REASON_MAX]


@dataclass
class NewRequest:
    original_id: uuid.UUID
    machine_id: uuid.UUID
    mode: str
    full: bool
    lines: List[Tuple[uuid.UUID, Decimal]]
    reason: Optional[str]
    reason_code: Optional[str]
    request_id: Optional[uuid.UUID] = None


def _same_request(req: RemoteCreditRequest, new: NewRequest) -> bool:
    if (
        req.original_transaction_id != new.original_id
        or req.machine_id != new.machine_id
        or req.mode != new.mode
        or bool(req.full_credit) != bool(new.full)
    ):
        return False
    if new.full:
        return True
    stored = sorted((str(l.get("itemId")), _dec(l.get("quantity"))) for l in (req.lines or []))
    asked = sorted((str(i), q) for i, q in new.lines if q > 0)
    return len(stored) == len(asked) and all(
        a[0] == b[0] and abs(a[1] - b[1]) <= QUANTITY_TOLERANCE for a, b in zip(stored, asked)
    )


def create(
    db: Session,
    user: User,
    original: Transaction,
    machine: POSMachine,
    new: NewRequest,
    *,
    now: Optional[datetime] = None,
) -> Tuple[RemoteCreditRequest, bool]:
    """
    `(request, created)`. Idempotent by the command id: the same id with the same content
    is the stored request again; with other content, 409 `remote_credit_id_conflict`.
    """
    now = _now(now)
    expire_overdue(db, now=now)
    if new.request_id is not None:
        existing = db.query(RemoteCreditRequest).filter(RemoteCreditRequest.id == new.request_id).first()
        if existing is not None:
            if existing.tenant_id == original.tenant_id and _same_request(existing, new):
                return existing, False
            raise _refuse("remote_credit_id_conflict", "מזהה הבקשה כבר בשימוש לבקשה אחרת.")
    if new.mode not in REMOTE_CREDIT_MODES:
        raise _refuse("unknown_mode", "מצב זיכוי לא מוכר.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    reason_code, reason = _clean_reason(new.reason, new.reason_code)
    # One request at a time per original: the row lock serialises two managers.
    locked = (
        db.query(Transaction).filter(Transaction.id == original.id).with_for_update().populate_existing().first()
    )
    original = locked or original
    refusal = original_refusal(original)
    if refusal is not None:
        raise refusal
    refusal = target_refusal(db, original, machine)
    if refusal is not None:
        raise refusal
    cr = creditable(db, original)
    if not cr.lines:
        raise _refuse("original_has_no_lines", "למסמך אין שורות — אי אפשר להפיק לו זיכוי מרחוק.")
    lines = plan_lines(cr, full=new.full, requested=new.lines)
    amount = sum((_dec(l["amount"]) for l in lines), Decimal("0"))
    tenders = None
    if new.mode == M.NO_MONEY:
        tenders = mirror_tenders(db, original, amount)
        if not tenders:
            raise _refuse(
                "no_tender_to_mirror",
                "למסמך המקורי אין אמצעי תשלום להעתיק (שולם בהחלפה בלבד). בחרו \"להשלמה בקופה\".",
            )
    ttl = NO_MONEY_TTL_HOURS if new.mode == M.NO_MONEY else prepared_ttl_hours(db, machine)
    company = original_company(db, original)
    req = RemoteCreditRequest(
        id=new.request_id or uuid.uuid4(),
        tenant_id=original.tenant_id,
        company_id=company.id if company is not None else None,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        original_transaction_id=original.id,
        original_machine_id=original.machine_id,
        original_document_number=original.document_number,
        original_document_type=original.document_type,
        original_issued_at=_utc(original.created_at),
        mode=new.mode,
        full_credit=bool(new.full),
        lines=lines,
        amount=amount,
        tenders=tenders,
        reason_code=reason_code,
        reason=reason,
        status=S.QUEUED,
        expires_at=now + timedelta(hours=ttl),
        created_by_user_id=user.id,
        initiated_by=_initiator(user),
        created_at=now,
        updated_at=now,
    )
    db.add(req)
    db.flush()
    _event(
        db, req, "created", actor="user", user=user, detail=reason,
        data={"mode": new.mode, "machineId": str(machine.id), "amount": str(amount), "full": bool(new.full)},
        now=now,
    )
    _notify(machine, req, now)
    db.flush()
    return req, True


def _notify(machine: POSMachine, req: RemoteCreditRequest, now: datetime, *, cancelled: bool = False) -> None:
    """The fast path: wake the till. Offline (or no Ably) is a delay — the heartbeat hands it over."""
    from app.services import ably_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now) or not ably_notify.is_enabled():
        return
    ably_notify.publish_remote_credit_notify(
        str(machine.tenant_id), str(machine.id), str(req.id), req.initiated_by or "", cancelled=cancelled
    )
    if not cancelled and req.status == S.QUEUED:
        req.status = S.SENT
        req.sent_at = now
        req.updated_at = now


def cancel(
    db: Session, req: RemoteCreditRequest, user: User, *, reason: Optional[str] = None, now: Optional[datetime] = None
) -> RemoteCreditRequest:
    now = _now(now)
    expire_overdue(db, now=now)
    if req.status not in PENDING_REMOTE_CREDIT_STATUSES:
        raise _refuse("request_not_pending", "אפשר לבטל רק בקשה שעדיין לא בוצעה.")
    req.status = S.CANCELLED
    req.error_code = "cancelled"
    req.cancelled_at = now
    req.cancelled_by_user_id = user.id
    req.cancel_reason = (" ".join((reason or "").split()) or None)
    req.updated_at = now
    _event(db, req, "cancelled", actor="user", user=user, detail=req.cancel_reason, now=now)
    machine = req.machine or db.query(POSMachine).filter(POSMachine.id == req.machine_id).first()
    if machine is not None:
        _notify(machine, req, now, cancelled=True)
    db.flush()
    return req


def get_request(db: Session, request_id, tenant_id) -> Optional[RemoteCreditRequest]:
    return (
        db.query(RemoteCreditRequest)
        .filter(RemoteCreditRequest.id == request_id, RemoteCreditRequest.tenant_id == tenant_id)
        .first()
    )


# ── Till side ─────────────────────────────────────────────────────────────────


def _pending_for(db: Session, machine: POSMachine):
    return (
        db.query(RemoteCreditRequest)
        .filter(
            RemoteCreditRequest.machine_id == machine.id,
            RemoteCreditRequest.tenant_id == machine.tenant_id,
            RemoteCreditRequest.status.in_(PENDING_REMOTE_CREDIT_STATUSES),
        )
        .order_by(RemoteCreditRequest.created_at.asc(), RemoteCreditRequest.id.asc())
    )


def _mark_sent(db: Session, rows: Iterable[RemoteCreditRequest], machine: POSMachine, how: str, now: datetime) -> None:
    for req in rows:
        if req.status == S.QUEUED:
            req.status = S.SENT
            req.sent_at = now
            req.updated_at = now
            _event(db, req, "sent", actor="system", machine_id=machine.id, detail=how, now=now)


def take_pending(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[List[str]]:
    """`pendingRemoteCredits` for the heartbeat: the ids of this till's pending requests, oldest first."""
    now = _now(now)
    expire_overdue(db, now=now)
    rows = _pending_for(db, machine).all()
    if not rows:
        return None
    _mark_sent(db, rows, machine, "heartbeat", now)
    return [str(r.id) for r in rows]


def _money(value: Any) -> Optional[float]:
    return None if value is None else float(_dec(value))


def _original_payload(db: Session, req: RemoteCreditRequest) -> Optional[dict]:
    original = (
        db.query(Transaction)
        .filter(Transaction.id == req.original_transaction_id, Transaction.tenant_id == req.tenant_id)
        .first()
    )
    if original is None:
        return None
    cr = creditable(db, original, exclude_request_id=req.id)
    legs = (
        db.query(TransactionPayment)
        .filter(TransactionPayment.transaction_id == original.id)
        .order_by(TransactionPayment.sequence, TransactionPayment.id)
        .all()
    )
    return {
        "id": str(original.id),
        "machineId": str(original.machine_id),
        "documentNumber": original.document_number,
        "transactionNumber": original.transaction_number,
        "documentPrefix": original.document_prefix,
        "documentType": original.document_type,
        "createdAt": _utc(original.created_at).isoformat() if original.created_at else None,
        "paymentMethod": original.payment_method,
        "totalAmount": _money(original.total_amount),
        "documentDiscount": _money(original.document_discount),
        "vatRate": _money(original.vat_rate),
        "status": original.status.value if hasattr(original.status, "value") else str(original.status),
        "nayaxMeta": original.nayax_meta,
        "items": [
            {
                "id": str(s.item.id),
                "productId": str(s.item.product_id) if s.item.product_id else None,
                "productName": s.item.product_name,
                "quantity": float(_dec(s.item.quantity)),
                "unitPrice": _money(s.item.unit_price),
                "totalPrice": _money(s.item.total_price),
                "discount": _money(s.item.discount),
                "discountType": s.item.discount_type,
                "promotionDiscount": _money(getattr(s.item, "promotion_discount", None)),
                # Credited by credit notes already issued (any till) — not by pending requests.
                "credited": float(s.credited),
            }
            for s in cr.lines
        ],
        "payments": [
            {
                "method": (l.method or "").strip().lower() or UNKNOWN_PAYMENT_METHOD,
                "amount": _money(l.amount),
                "nayaxMeta": l.nayax_meta,
            }
            for l in legs
        ],
    }


def till_payload(db: Session, req: RemoteCreditRequest) -> dict:
    return {
        "requestId": str(req.id),
        "mode": req.mode,
        "status": req.status,
        "createdAt": _utc(req.created_at).isoformat() if req.created_at else None,
        "expiresAt": _utc(req.expires_at).isoformat() if req.expires_at else None,
        "initiatedBy": req.initiated_by,
        "reasonCode": req.reason_code,
        "reason": req.reason,
        "fullCredit": bool(req.full_credit),
        "amount": _money(req.amount),
        "lines": [
            {
                "itemId": l.get("itemId"),
                "productId": l.get("productId"),
                "productName": l.get("productName"),
                "quantity": float(_dec(l.get("quantity"))),
                "amount": float(_dec(l.get("amount"))),
            }
            for l in (req.lines or [])
        ],
        "tenders": [
            {"method": t.get("method"), "amount": float(_dec(t.get("amount")))} for t in (req.tenders or [])
        ],
        "original": _original_payload(db, req),
    }


def for_till(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> dict:
    """`GET /sync/{m}/remote-credits`: every pending request of this till, whole."""
    now = _now(now)
    expire_overdue(db, now=now)
    rows = _pending_for(db, machine).all()
    _mark_sent(db, rows, machine, "pull", now)
    return {"serverTime": now.isoformat(), "requests": [till_payload(db, r) for r in rows]}


ACK_PHASES = ("received", "deferred", "waiting", "completed", "failed")


def _complete(
    db: Session,
    req: RemoteCreditRequest,
    machine: POSMachine,
    *,
    credit_id,
    number: Optional[str],
    document_type: Optional[int],
    amount: Any,
    how: str,
    now: datetime,
) -> None:
    if req.credit_transaction_id is not None and credit_id is not None and str(req.credit_transaction_id) != str(credit_id):
        # Two credits for one command: never expected (the till dedupes) — kept and flagged.
        logger.error("remote credit %s answered by a second credit %s (first %s)", req.id, credit_id, req.credit_transaction_id)
        _event(
            db, req, "duplicate_credit", actor="till", machine_id=machine.id,
            detail="זיכוי נוסף לאותה בקשה", data={"creditTransactionId": str(credit_id)}, now=now,
        )
        return
    was = req.status
    req.credit_transaction_id = credit_id or req.credit_transaction_id
    req.credit_document_number = number or req.credit_document_number
    req.credit_document_type = document_type if document_type is not None else req.credit_document_type
    if amount is not None:
        req.credit_amount = _dec(amount)
    if was != S.COMPLETED:
        if was in (S.CANCELLED, S.EXPIRED, S.FAILED):
            # A fiscal document exists: the request is completed whatever the cloud said meanwhile.
            req.error_code = f"completed_after_{was}"
            req.error_message = "הזיכוי הופק בקופה אחרי שהבקשה בוטלה / פגה — המסמך קיים ונרשם."
        else:
            req.error_code = None
            req.error_message = None
        req.status = S.COMPLETED
        req.completed_at = now
        req.received_at = req.received_at or now
        _event(
            db, req, "completed", actor="till" if how == "ack" else "system", machine_id=machine.id,
            detail=number, data={"creditTransactionId": str(credit_id) if credit_id else None, "via": how}, now=now,
        )
    req.updated_at = now


def apply_ack(
    db: Session,
    machine: POSMachine,
    request_id,
    *,
    phase: str,
    credit_transaction_id=None,
    credit_document_number: Optional[str] = None,
    credit_document_type: Optional[int] = None,
    credit_amount: Any = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> RemoteCreditRequest:
    now = _now(now)
    req = (
        db.query(RemoteCreditRequest)
        .filter(
            RemoteCreditRequest.id == request_id,
            RemoteCreditRequest.machine_id == machine.id,
            RemoteCreditRequest.tenant_id == machine.tenant_id,
        )
        .first()
    )
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="remote_credit_not_found")
    if phase not in ACK_PHASES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_phase")
    expire_overdue(db, now=now)
    if phase == "completed":
        if credit_transaction_id is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="credit_transaction_id_required")
        _complete(
            db, req, machine, credit_id=credit_transaction_id, number=credit_document_number,
            document_type=credit_document_type, amount=credit_amount, how="ack", now=now,
        )
        db.flush()
        return req
    if req.status not in PENDING_REMOTE_CREDIT_STATUSES:
        return req  # ended: accepted, changes nothing
    if phase in ("received", "deferred", "waiting"):
        first = req.status != S.RECEIVED
        req.status = S.RECEIVED
        req.sent_at = req.sent_at or now
        req.received_at = req.received_at or now
        if phase == "deferred":
            req.error_code = (error_code or "deferred")[:64]
            req.error_message = error_message
        else:
            req.error_code = None
            req.error_message = None
        if first or phase == "deferred":
            _event(
                db, req, phase, actor="till", machine_id=machine.id,
                detail=error_message or error_code, now=now,
            )
    elif phase == "failed":
        req.status = S.FAILED
        req.failed_at = now
        req.error_code = (error_code or "failed")[:64]
        req.error_message = error_message
        _event(db, req, "failed", actor="till", machine_id=machine.id, detail=error_message or error_code, now=now)
    req.updated_at = now
    db.flush()
    return req


def on_documents(db: Session, machine: POSMachine, document_ids: Sequence[uuid.UUID], *, now: Optional[datetime] = None) -> None:
    """Credits that name their request complete it (the ack may still be on its way)."""
    ids = [i for i in document_ids if i is not None]
    if not ids:
        return
    docs = (
        db.query(Transaction)
        .filter(Transaction.id.in_(ids), Transaction.remote_credit_request_id.isnot(None))
        .all()
    )
    if not docs:
        return
    now = _now(now)
    for doc in docs:
        req = (
            db.query(RemoteCreditRequest)
            .filter(
                RemoteCreditRequest.id == doc.remote_credit_request_id,
                RemoteCreditRequest.tenant_id == machine.tenant_id,
            )
            .first()
        )
        if req is None or req.machine_id != machine.id:
            logger.warning("document %s names remote credit %s, which is not this till's", doc.id, doc.remote_credit_request_id)
            continue
        if doc.status == TransactionStatus.CANCELLED:
            continue
        if req.credit_transaction_id is not None and str(req.credit_transaction_id) == str(doc.id) and req.status == S.COMPLETED:
            if req.credit_document_number is None:
                req.credit_document_number = doc.document_number
            continue
        _complete(
            db, req, machine, credit_id=doc.id, number=doc.document_number, document_type=doc.document_type,
            amount=doc.total_amount, how="document", now=now,
        )
    db.flush()


# ── Out ───────────────────────────────────────────────────────────────────────


def request_to_out(db: Session, req: RemoteCreditRequest, *, events: bool = False, now: Optional[datetime] = None) -> dict:
    machine = req.machine or db.query(POSMachine).filter(POSMachine.id == req.machine_id).first()
    shop = db.query(Shop).filter(Shop.id == req.shop_id).first() if req.shop_id else None
    original_machine = (
        db.query(POSMachine).filter(POSMachine.id == req.original_machine_id).first()
        if req.original_machine_id
        else None
    )
    creator = db.query(User).filter(User.id == req.created_by_user_id).first()
    canceller = db.query(User).filter(User.id == req.cancelled_by_user_id).first() if req.cancelled_by_user_id else None
    out = {
        "id": str(req.id),
        "transactionId": str(req.original_transaction_id),
        "originalDocumentNumber": req.original_document_number,
        "originalDocumentType": req.original_document_type,
        "originalIssuedAt": _utc(req.original_issued_at),
        "originalMachineId": str(req.original_machine_id) if req.original_machine_id else None,
        "originalMachineName": original_machine.name if original_machine is not None else None,
        "machineId": str(req.machine_id),
        "machineName": machine.name if machine is not None else None,
        "posNumber": machine.pos_number if machine is not None else None,
        "shopId": str(req.shop_id) if req.shop_id else None,
        "shopName": shop.name if shop is not None else None,
        "online": is_online(machine.last_heartbeat_at, now=now) if machine is not None else False,
        "mode": req.mode,
        "fullCredit": bool(req.full_credit),
        "lines": req.lines or [],
        "amount": str(_dec(req.amount).quantize(CENT)),
        "tenders": req.tenders or [],
        "reasonCode": req.reason_code,
        "reason": req.reason,
        "status": req.status,
        "errorCode": req.error_code,
        "errorMessage": req.error_message,
        "creditTransactionId": str(req.credit_transaction_id) if req.credit_transaction_id else None,
        "creditDocumentNumber": req.credit_document_number,
        "creditDocumentType": req.credit_document_type,
        "creditAmount": str(_dec(req.credit_amount).quantize(CENT)) if req.credit_amount is not None else None,
        "createdAt": _utc(req.created_at),
        "updatedAt": _utc(req.updated_at),
        "expiresAt": _utc(req.expires_at),
        "sentAt": _utc(req.sent_at),
        "receivedAt": _utc(req.received_at),
        "completedAt": _utc(req.completed_at),
        "failedAt": _utc(req.failed_at),
        "cancelledAt": _utc(req.cancelled_at),
        "createdByUserId": str(req.created_by_user_id),
        "createdBy": req.initiated_by or (_initiator(creator) if creator is not None else None),
        "cancelledBy": _initiator(canceller) if canceller is not None else None,
        "cancelReason": req.cancel_reason,
    }
    if events:
        rows = (
            db.query(RemoteCreditEvent)
            .filter(RemoteCreditEvent.request_id == req.id)
            .order_by(RemoteCreditEvent.at.asc(), RemoteCreditEvent.id.asc())
            .all()
        )
        users = {
            u.id: u
            for u in db.query(User).filter(User.id.in_([r.user_id for r in rows if r.user_id])).all()
        } if rows else {}
        out["events"] = [
            {
                "at": _utc(r.at),
                "actor": r.actor,
                "action": r.action,
                "by": _initiator(users[r.user_id]) if r.user_id in users else None,
                "detail": r.detail,
            }
            for r in rows
        ]
    return out


def prepare_out(db: Session, original: Transaction, targets: List[dict]) -> dict:
    """What the dashboard's dialog needs: the lines left, the money, the tenders, the tills."""
    refusal = original_refusal(original)
    cr = creditable(db, original)
    lines = []
    for s in cr.lines:
        remaining_amount = credit_for(s.collected, s.sold, s.credited + s.pending, s.remaining)
        lines.append(
            {
                "itemId": str(s.item.id),
                "productId": str(s.item.product_id) if s.item.product_id else None,
                "productName": s.item.product_name,
                "quantity": float(s.sold),
                "credited": float(s.credited),
                "pending": float(s.pending),
                "remaining": float(s.remaining),
                "unitPrice": str(_dec(s.item.unit_price).quantize(CENT)),
                "collected": str(_shekels(s.collected)),
                "remainingAmount": str(_shekels(remaining_amount)),
            }
        )
    legs = (
        db.query(TransactionPayment)
        .filter(TransactionPayment.transaction_id == original.id)
        .order_by(TransactionPayment.sequence, TransactionPayment.id)
        .all()
    )
    return {
        "transactionId": str(original.id),
        "documentNumber": original.document_number,
        "documentType": original.document_type,
        "machineId": str(original.machine_id),
        "createdAt": _utc(original.created_at),
        "status": original.status.value if hasattr(original.status, "value") else str(original.status),
        "creditable": refusal is None and any(l["remaining"] > 0 for l in lines),
        "refusal": refusal.detail if refusal is not None else None,
        "collected": str(cr.collected.quantize(CENT)),
        "creditedAmount": str(cr.credited_amount.quantize(CENT)),
        "pendingAmount": str(cr.pending_amount.quantize(CENT)),
        "remainingAmount": str(cr.remaining_amount.quantize(CENT)),
        "lines": lines,
        "tenders": [
            {"method": (l.method or "").strip().lower(), "amount": str(_dec(l.amount).quantize(CENT))} for l in legs
        ] or [{"method": (original.payment_method or "other").lower(), "amount": str(cr.collected.quantize(CENT))}],
        "targets": targets,
        "pendingRequests": [request_to_out(db, r) for r in cr.pending_requests],
        "reasons": [{"code": c, "label": l} for c, l in REASONS],
        "preparedExpiryHours": DEFAULT_PREPARED_TTL_HOURS,
    }
