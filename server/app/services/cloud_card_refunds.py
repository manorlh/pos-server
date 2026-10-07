"""
"זיכוי באשראי (Z-Credit)" — the cloud refunds a card sale charged through Z-Credit, and a till
issues the credit note (docs/SPEC_REMOTE_CREDIT.md §11).

The owner (07.10.2026): "אפשר לזכות אשראי מהענן עם Z-Credit, כי הם Web — בהנחה שיש בסניף
Z-Credit; בסניף יכול להיות גם וגם".

**Only a Z-Credit leg.** A card leg whose acquirer reply says `provider: zcredit` and carries
the sale's gateway reference. A shop may have Z-Credit tills and others ("גם וגם"): a leg of
another terminal keeps today's path — a remote credit the cashier completes at a till.

**The money, once.** The refund row is written and committed *before* the gateway is called;
then:

1. `GetTransactionStatusByReferenceId` on the sale: still refundable? (not voided / refunded
   at the gateway, no partial refund outside the system, no partial refund before the deposit —
   Z-Credit voids before the deposit, and whether a partial amount voids the whole sale is an
   open question to Z-Credit, so it is refused).
2. `refund_sent_at` committed, then `RefundTransaction` — sent once, never retried.
3. The answer: approved → `refunded`; refused → `declined` (no money moved). No readable
   answer while the request may have gone out → `unknown`, and the status query decides —
   now (three tries) and later on demand: the sale now voided / refunded where it was not →
   refunded; still untouched once the gateway had time to settle → declined; anything else
   stays `unknown` until an operator, having checked Z-Credit's report, records the outcome.
   **An unknown refund is never sent again.**

The dashboard's request id is the row's id: the same id is the same refund (a double click, a
retry after a lost answer); the same id with other content is a 409.

**The document, by a till.** The cloud never issues a fiscal document (§1): numbers are per
till series. A refunded row asks a till for the credit note through the remote-credit path —
mode `card_refunded`, by default to the sale's own till when it has an open shift (any eligible
till of the same business otherwise) — and the till issues it at once, in its own series, in
its open shift (so in that shift's X and the Z its Z mode puts it in), its tender the card leg
the request carries (the refund's reference, approval, the card's last digits), never touching
a pinpad or the drawer. A till that refuses it (no open shift, an old version) fails the
request; the dashboard sends it to another till. Until the note reaches the cloud the refund
keeps holding its lines and its money, so nothing is refunded twice meanwhile.

**Credentials:** the Z-Credit terminal number and password of the sale's till, resolved on its
settings layers (tenant → company → shop → area → till, the most specific winning) — the same
resolution its own settings sync uses.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cloud_card_refund import (
    HOLDING_CARD_REFUND_STATUSES,
    CloudCardRefund,
    CloudCardRefundEvent,
    CloudCardRefundStatus as CS,
)
from app.models.pos_machine import POSMachine
from app.models.remote_credit import PENDING_REMOTE_CREDIT_STATUSES, RemoteCreditRequest
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.services import remote_credits as rc
from app.services import zcredit_gateway as zg
from app.services.transmissions import approval_number_of, card_last4_of

logger = logging.getLogger(__name__)

PROVIDER = "zcredit"
CARD_METHOD = "card"

#: What the dashboard and the credit note call it.
LABEL = "זוכה באשראי מהענן (Z-Credit)"

#: A row left `in_flight` this long after it started is a crash, not a call in progress.
STALE_IN_FLIGHT = timedelta(seconds=zg.REFUND_TIMEOUT_S + zg.QUERY_TIMEOUT_S + 60)
#: Status queries right after a lost reply, and the pause between them.
RESOLVE_ATTEMPTS = 3
RESOLVE_PAUSE_S = 2.0
#: "Not refunded" is only concluded from the sale still untouched this long after the refund
#: went out — a refund the gateway was still processing must not be called "never happened".
SETTLE_AFTER = timedelta(minutes=5)
#: A user's "check again" at most this often.
CHECK_MIN_INTERVAL = timedelta(seconds=10)

REASON_MAX = 300
#: The quick reasons of a card refund; the text itself is always stored.
REASONS: Tuple[Tuple[str, str], ...] = (
    ("product_returned", "החזרת מוצר"),
    ("customer_complaint", "תלונת לקוח"),
    ("charged_twice", "חיוב כפול"),
    ("wrong_amount", "חיוב בסכום שגוי"),
    ("order_cancelled", "ההזמנה בוטלה"),
    ("other", "אחר"),
)
REASON_CODES = {code for code, _ in REASONS}

#: The Z-Credit settings a cloud refund needs (app/services/payment_integration.py).
TERMINAL_KEY = "zcreditTerminalNumber"


# ── The gateway (tests swap the factory; nothing else ever builds one) ────────


def _default_gateway() -> zg.ZCreditGateway:
    return zg.HttpZCreditGateway()


gateway_factory: Callable[[], zg.ZCreditGateway] = _default_gateway
#: The pause between status queries (tests make it instant).
sleep: Callable[[float], None] = time.sleep


def enabled() -> bool:
    from app.config import get_settings

    return bool(getattr(get_settings(), "zcredit_cloud_refunds_enabled", False))


DISABLED_MESSAGE = (
    "זיכוי באשראי מהענן כבוי בשרת הזה (ZCREDIT_CLOUD_REFUNDS_ENABLED). "
    "הוא יופעל כשהקופות יתמכו בהפקת מסמך הזיכוי שלו. בינתיים — זיכוי מרחוק להשלמה בקופה."
)


# ── Small things ──────────────────────────────────────────────────────────────


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


def _agorot(shekels: Any) -> int:
    return rc._agorot(shekels)


def _shekels(agorot: int) -> Decimal:
    return rc._shekels(agorot)


def _money(value: Any) -> str:
    return str(_dec(value).quantize(rc.CENT))


# ── The leg ───────────────────────────────────────────────────────────────────


def _meta(leg: Any) -> dict:
    meta = getattr(leg, "nayax_meta", None)
    return meta if isinstance(meta, dict) else {}


def _result(meta: dict) -> dict:
    result = meta.get("result")
    return result if isinstance(result, dict) else {}


def _text(value: Any) -> Optional[str]:
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    text = str(value).strip()
    return text if text and text.lower() != "null" else None


def leg_provider(meta: Any) -> Optional[str]:
    """`zcredit`, `synqpay`… as the till's acquirer reply names it; None for Agamento / Nayax."""
    if not isinstance(meta, dict):
        return None
    raw = _text(_result(meta).get("provider")) or _text(meta.get("provider"))
    return raw.lower() if raw else None


def leg_reference(meta: Any) -> Optional[str]:
    """
    The sale's gateway reference (`ReferenceNumber`): what RefundTransaction takes. The till
    stores it as `zcreditReferenceNumber`, `transactionId` and `uid` (pos-android
    `ZCreditReplies.toAshraitJson`); "0" is the gateway's "none".
    """
    if not isinstance(meta, dict):
        return None
    result = _result(meta)
    for raw in (result.get("zcreditReferenceNumber"), result.get("transactionId"), result.get("uid"), meta.get("uid")):
        text = _text(raw)
        if text and any(c != "0" for c in text):
            return text[:64]
    return None


def leg_terminal(meta: Any) -> Optional[str]:
    """The terminal the sale was charged on, when the reply says (a newer till may)."""
    if not isinstance(meta, dict):
        return None
    result = _result(meta)
    for raw in (result.get("zcreditTerminalNumber"), result.get("terminalNumber"),
                meta.get("zcreditTerminalNumber"), meta.get("terminalNumber")):
        text = _text(raw)
        if text:
            return text
    return None


def is_zcredit_leg(leg: Any) -> bool:
    return leg_refusal(leg) is None


def leg_refusal(leg: Any) -> Optional[Tuple[str, str]]:
    """Why this leg cannot be refunded from the cloud, or None."""
    if (getattr(leg, "method", None) or "").strip().lower() != CARD_METHOD:
        return "not_a_card_leg", "רק תשלום באשראי מזוכה לכרטיס."
    if bool(getattr(leg, "no_money_movement", False)):
        return "no_money_leg", "בתשלום הזה לא עבר כסף — אין מה להחזיר לכרטיס."
    meta = _meta(leg)
    if leg_provider(meta) != PROVIDER:
        return (
            "not_zcredit",
            "התשלום הזה לא חויב דרך Z-Credit — זיכוי שלו נעשה בקופה (\"צור זיכוי\" → להשלמה בקופה).",
        )
    if leg_reference(meta) is None:
        return "no_gateway_reference", "לתשלום אין אסמכתת Z-Credit (ReferenceNumber) — אי אפשר לזכות אותו מהענן."
    if _agorot(getattr(leg, "amount", 0)) <= 0:
        return "nothing_on_leg", "בתשלום הזה אין סכום לזיכוי."
    return None


@dataclass
class LegState:
    leg: TransactionPayment
    amount: int
    #: Refunded from the cloud already (agorot).
    refunded: int
    #: Cloud refunds in flight or of unknown outcome.
    in_progress: int
    #: Card legs of credit notes the tills issued against this sale (their own card refunds).
    till_card_credits: int

    @property
    def remaining(self) -> int:
        return max(0, self.amount - self.refunded - self.in_progress - self.till_card_credits)


def _refund_document_ids(db: Session, original: Transaction) -> Tuple[set, set]:
    """The requests and credit notes that belong to cloud refunds of `original`."""
    req_ids = {
        r[0]
        for r in db.query(RemoteCreditRequest.id)
        .filter(
            RemoteCreditRequest.original_transaction_id == original.id,
            RemoteCreditRequest.card_refund_id.isnot(None),
        )
        .all()
    }
    doc_ids = {
        r[0]
        for r in db.query(CloudCardRefund.credit_transaction_id)
        .filter(
            CloudCardRefund.original_transaction_id == original.id,
            CloudCardRefund.credit_transaction_id.isnot(None),
        )
        .all()
    }
    return req_ids, doc_ids


def till_card_credits(db: Session, original: Transaction) -> int:
    """
    Agorot the tills already gave back on a card for `original` — the card legs (money that
    moved) of its credit notes, the cloud's own refunds' notes excepted. Counted against every
    Z-Credit leg of the sale: a till's refund does not say which leg it took back, and
    assuming the worst can only refuse a refund, never allow one too many.
    """
    item_ids = [r[0] for r in db.query(TransactionItem.id).filter(TransactionItem.transaction_id == original.id).all()]
    credits = rc._credit_notes_of(db, original, item_ids)
    if not credits:
        return 0
    req_ids, doc_ids = _refund_document_ids(db, original)
    ids = [c.id for c in credits if c.id not in doc_ids and c.remote_credit_request_id not in req_ids]
    if not ids:
        return 0
    legs = (
        db.query(TransactionPayment)
        .filter(TransactionPayment.transaction_id.in_(ids), TransactionPayment.method == CARD_METHOD)
        .all()
    )
    return sum(abs(_agorot(l.amount)) for l in legs if not bool(l.no_money_movement))


def leg_state(db: Session, original: Transaction, leg: TransactionPayment, *, exclude_refund_id=None) -> LegState:
    rows = (
        db.query(CloudCardRefund)
        .filter(
            CloudCardRefund.original_payment_id == leg.id,
            CloudCardRefund.status.in_(HOLDING_CARD_REFUND_STATUSES),
        )
        .all()
    )
    refunded = sum(_agorot(r.amount) for r in rows if r.status == CS.REFUNDED and r.id != exclude_refund_id)
    in_progress = sum(_agorot(r.amount) for r in rows if r.status != CS.REFUNDED and r.id != exclude_refund_id)
    return LegState(
        leg=leg,
        amount=_agorot(leg.amount),
        refunded=refunded,
        in_progress=in_progress,
        till_card_credits=till_card_credits(db, original),
    )


def _landed(db: Session, row: CloudCardRefund) -> bool:
    """Its credit note is in the cloud (and counted with the credit notes)."""
    if row.credit_transaction_id is None:
        return False
    return (
        db.query(Transaction.id)
        .filter(Transaction.id == row.credit_transaction_id, Transaction.status != TransactionStatus.CANCELLED)
        .first()
        is not None
    )


def unlanded_refund_holds(
    db: Session,
    original: Transaction,
    *,
    counted_request_ids: Iterable[uuid.UUID] = (),
    exclude_request_id=None,
) -> List[Tuple[Any, Any]]:
    """
    `(amount, lines)` of `original`'s cloud refunds whose money may be gone and whose credit
    note has not reached the cloud — for `remote_credits.creditable`, which already counts the
    pending requests named in `counted_request_ids`.
    """
    counted = set(counted_request_ids)
    rows = (
        db.query(CloudCardRefund)
        .filter(
            CloudCardRefund.original_transaction_id == original.id,
            CloudCardRefund.status.in_(HOLDING_CARD_REFUND_STATUSES),
        )
        .all()
    )
    out: List[Tuple[Any, Any]] = []
    for row in rows:
        if row.remote_credit_request_id is not None and (
            row.remote_credit_request_id in counted or row.remote_credit_request_id == exclude_request_id
        ):
            continue
        if _landed(db, row):
            continue
        out.append((row.amount, row.lines))
    return out


# ── Credentials ───────────────────────────────────────────────────────────────


def credentials_for(db: Session, machine: Optional[POSMachine], original: Optional[Transaction] = None):
    """
    `(Credentials, None)`, or `(None, (code, message))`: the Z-Credit terminal number and password
    of the sale's till on its settings layers — the most specific layer that has each wins.
    """
    from app.models.company import Company
    from app.models.shop import Shop
    from app.services import payment_integration as PI
    from app.services import payment_secrets as PS

    if machine is not None:
        from app.routers.settings import _machine_parents

        area, shop, company, tenant = _machine_parents(db, machine)
    else:
        # The till is gone: its shop's layers still say which terminal the shop charges on.
        from app.routers.settings import _tenant_of

        shop = db.query(Shop).filter(Shop.id == original.shop_id).first() if original and original.shop_id else None
        company = db.query(Company).filter(Company.id == shop.company_id).first() if shop else None
        tenant = _tenant_of(company, db) if company else None
        area = None
    layers = PI.settings_layers(tenant, company, shop, area, machine)
    merged: Dict[str, Any] = {}
    for _, settings in layers:
        if isinstance(settings, dict):
            merged.update(settings)
    try:
        terminal = PI.validate_terminal_number(merged.get(TERMINAL_KEY))
    except ValueError:
        terminal = None
    if not terminal:
        return None, ("zcredit_terminal_missing", "לא הוגדר מספר מסוף Z-Credit לקופה של העסקה — אי אפשר לזכות מהענן.")
    ids = PI.secret_layers(tenant, company, shop, area, machine)
    hit = PS.merged_secret_sources(ids, PS.secrets_for_layers(db, ids)).get(PS.ZCREDIT_PASSWORD)
    password = PS.decrypt(hit[1].ciphertext) if hit else None
    if not password:
        return None, ("zcredit_password_missing", "לא שמורה סיסמת מסוף Z-Credit לקופה של העסקה — אי אפשר לזכות מהענן.")
    return zg.Credentials(terminal_number=terminal, password=password, source=hit[0]), None


def _original_machine(db: Session, original: Transaction) -> Optional[POSMachine]:
    if original.machine_id is None:
        return None
    return db.query(POSMachine).filter(POSMachine.id == original.machine_id).first()


# ── Audit ─────────────────────────────────────────────────────────────────────


def _event(
    db: Session,
    row: CloudCardRefund,
    action: str,
    *,
    actor: str,
    user: Optional[User] = None,
    detail: Optional[str] = None,
    data: Optional[dict] = None,
    now: Optional[datetime] = None,
) -> None:
    db.add(
        CloudCardRefundEvent(
            id=uuid.uuid4(),
            refund_id=row.id,
            tenant_id=row.tenant_id,
            at=_now(now),
            actor=actor,
            user_id=user.id if user is not None else None,
            action=action,
            detail=detail,
            data=data,
        )
    )


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


# ── Create and run ────────────────────────────────────────────────────────────


@dataclass
class NewCardRefund:
    refund_id: uuid.UUID
    original_id: uuid.UUID
    payment_id: uuid.UUID
    machine_id: uuid.UUID
    full: bool
    lines: List[Tuple[uuid.UUID, Decimal]]
    reason: Optional[str]
    reason_code: Optional[str]


def _same(row: CloudCardRefund, new: NewCardRefund) -> bool:
    if (
        row.original_transaction_id != new.original_id
        or row.original_payment_id != new.payment_id
        or row.target_machine_id != new.machine_id
        or bool(row.full_credit) != bool(new.full)
    ):
        return False
    if new.full:
        return True
    stored = sorted((str(l.get("itemId")), _dec(l.get("quantity"))) for l in (row.lines or []))
    asked = sorted((str(i), q) for i, q in new.lines if q > 0)
    return len(stored) == len(asked) and all(
        a[0] == b[0] and abs(a[1] - b[1]) <= rc.QUANTITY_TOLERANCE for a, b in zip(stored, asked)
    )


def create(
    db: Session,
    user: User,
    original: Transaction,
    target: POSMachine,
    new: NewCardRefund,
    *,
    gateway: Optional[zg.ZCreditGateway] = None,
    now: Optional[datetime] = None,
) -> Tuple[CloudCardRefund, bool]:
    """
    `(row, created)`: check, write the row, refund through the gateway, and ask a till for the
    credit note — committing between the steps (no gateway call inside a database transaction).
    The same id again is the stored row (a stale `in_flight` one is resolved first).
    """
    existing = db.query(CloudCardRefund).filter(CloudCardRefund.id == new.refund_id).first()
    if existing is not None:
        return _again(db, existing, original, new, gateway=gateway, now=now), False

    try:
        row, creds = _start(db, user, original, target, new, now=now)
        db.commit()
    except IntegrityError:
        # The same id raced in from a second click: that one is the refund.
        db.rollback()
        existing = db.query(CloudCardRefund).filter(CloudCardRefund.id == new.refund_id).first()
        if existing is None:
            raise
        return _again(db, existing, original, new, gateway=gateway, now=now), False
    _run(db, row, creds, user, gateway=gateway or gateway_factory())
    return row, True


def _again(
    db: Session,
    row: CloudCardRefund,
    original: Transaction,
    new: NewCardRefund,
    *,
    gateway: Optional[zg.ZCreditGateway],
    now: Optional[datetime],
) -> CloudCardRefund:
    if row.tenant_id != original.tenant_id or not _same(row, new):
        raise _refuse("card_refund_id_conflict", "מזהה הבקשה כבר בשימוש לזיכוי אחר.")
    if row.status == CS.IN_FLIGHT and _stale(row, _now(now)):
        recover(db, row, gateway=gateway, now=now)
    return row


def _start(
    db: Session, user: User, original: Transaction, target: POSMachine, new: NewCardRefund, *, now: Optional[datetime]
) -> Tuple[CloudCardRefund, zg.Credentials]:
    """Every check, then the row (`in_flight`) — not committed."""
    now = _now(now)
    if not enabled():
        raise _refuse("cloud_refunds_disabled", DISABLED_MESSAGE)
    reason_code, reason = _clean_reason(new.reason, new.reason_code)
    # One refund decision at a time per sale: the row lock serialises two managers.
    locked = (
        db.query(Transaction).filter(Transaction.id == original.id).with_for_update().populate_existing().first()
    )
    original = locked or original
    refusal = rc.original_refusal(original)
    if refusal is not None:
        raise refusal
    leg = (
        db.query(TransactionPayment)
        .filter(TransactionPayment.id == new.payment_id, TransactionPayment.transaction_id == original.id)
        .first()
    )
    if leg is None:
        raise _refuse("unknown_payment", "התשלום לא שייך למסמך.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    why = leg_refusal(leg)
    if why is not None:
        raise _refuse(*why)
    refusal = rc.target_refusal(db, original, target)
    if refusal is not None:
        raise refusal
    machine = _original_machine(db, original)
    creds, missing = credentials_for(db, machine, original)
    if creds is None:
        raise _refuse(*missing)
    charged_on = leg_terminal(_meta(leg))
    if charged_on and charged_on.lstrip("0") != creds.terminal_number.lstrip("0"):
        raise _refuse(
            "terminal_changed",
            f"העסקה חויבה במסוף {zg.mask_terminal(charged_on)} והקופה מוגדרת היום על מסוף "
            f"{creds.masked_terminal} — זיכוי מהענן רק במסוף שחייב.",
        )
    cr = rc.creditable(db, original)
    if not cr.lines:
        raise _refuse("original_has_no_lines", "למסמך אין שורות — אי אפשר להפיק לו מסמך זיכוי.")
    lines = rc.plan_lines(cr, full=new.full, requested=new.lines)
    amount = sum((_dec(l["amount"]) for l in lines), Decimal("0"))
    state = leg_state(db, original, leg)
    if _agorot(amount) > state.remaining:
        raise _refuse(
            "over_card_leg",
            f"הזיכוי ({_money(amount)} ₪) גדול ממה שנשאר להחזיר לכרטיס בתשלום הזה "
            f"({_money(_shekels(state.remaining))} ₪). בחרו פחות שורות, או זיכוי מרחוק להשלמה בקופה ליתרה.",
        )
    meta = _meta(leg)
    company = rc.original_company(db, original)
    row = CloudCardRefund(
        id=new.refund_id,
        tenant_id=original.tenant_id,
        company_id=company.id if company is not None else None,
        shop_id=original.shop_id,
        original_machine_id=original.machine_id,
        original_transaction_id=original.id,
        original_payment_id=leg.id,
        original_document_number=original.document_number,
        original_document_type=original.document_type,
        original_leg_amount=_dec(leg.amount),
        card_last4=card_last4_of(meta),
        card_brand=leg.card_brand,
        card_acquirer=leg.card_acquirer,
        card_issuer=leg.card_issuer,
        provider=PROVIDER,
        terminal_number=creds.terminal_number,
        credential_source=creds.source,
        original_reference=leg_reference(meta),
        full_credit=bool(new.full),
        lines=lines,
        amount=amount,
        reason_code=reason_code,
        reason=reason,
        target_machine_id=target.id,
        status=CS.IN_FLIGHT,
        attempt_started_at=now,
        query_count=0,
        created_by_user_id=user.id,
        initiated_by=rc._initiator(user),
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _event(
        db, row, "created", actor="user", user=user, detail=reason,
        data={
            "amount": _money(amount), "paymentId": str(leg.id), "machineId": str(target.id),
            "full": bool(new.full), "terminal": creds.masked_terminal, "credentialSource": creds.source,
        },
        now=now,
    )
    return row, creds


def _preflight_refusal(db: Session, row: CloudCardRefund, before: zg.Reply) -> Optional[Tuple[str, str]]:
    """Why the sale, as the gateway sees it now, must not be refunded — or None."""
    terminal = zg.mask_terminal(row.terminal_number)
    if before.credentials_refused:
        return "zcredit_credentials_refused", f"Z-Credit דחה את פרטי המסוף {terminal} (קוד {before.return_code})."
    if before.not_found:
        return (
            "original_not_found_at_gateway",
            f"העסקה לא נמצאה במסוף Z-Credit {terminal} — ייתכן שהקופה עברה למסוף אחר.",
        )
    if before.has_error:
        return "gateway_error", f"Z-Credit: {before.return_message or f'קוד {before.return_code}'}"
    code = before.status_code
    if code == zg.TxStatus.VOIDED:
        return "already_voided_at_gateway", "העסקה כבר בוטלה ב-Z-Credit. בדקו בדוח העסקאות של Z-Credit."
    if code == zg.TxStatus.REFUNDED:
        return "already_refunded_at_gateway", "העסקה כבר זוכתה במלואה ב-Z-Credit. בדקו בדוח העסקאות של Z-Credit."
    if code not in (zg.TxStatus.APPROVED_NOT_DEPOSITED, zg.TxStatus.APPROVED_DEPOSITED, zg.TxStatus.PARTIALLY_REFUNDED):
        return "gateway_status_unclear", f"מצב העסקה ב-Z-Credit לא ברור (StatusCode {code if code is not None else '?'})."
    original = db.query(Transaction).filter(Transaction.id == row.original_transaction_id).first()
    leg = db.query(TransactionPayment).filter(TransactionPayment.id == row.original_payment_id).first()
    state = leg_state(db, original, leg, exclude_refund_id=row.id) if original is not None and leg is not None else None
    if code == zg.TxStatus.PARTIALLY_REFUNDED and state is not None and state.refunded == 0 and state.till_card_credits == 0:
        return (
            "refunded_outside_system",
            "העסקה כבר זוכתה חלקית ב-Z-Credit שלא דרך המערכת — בדקו בדוח של Z-Credit לפני זיכוי נוסף.",
        )
    amount = _agorot(row.amount)
    charged = before.transaction_agorot
    if charged is not None and amount > charged:
        return "over_gateway_amount", f"ב-Z-Credit העסקה על {_money(_shekels(charged))} ₪ בלבד."
    if code == zg.TxStatus.APPROVED_NOT_DEPOSITED and amount < (charged if charged is not None else _agorot(row.original_leg_amount)):
        return (
            "partial_before_deposit",
            "העסקה עוד לא הופקדה ב-Z-Credit. לפני הפקדה Z-Credit מבטל את העסקה, וזיכוי חלקי עלול לבטל "
            "את כולה — המתינו להפקדה (בדרך כלל בלילה) או זכו את מלוא הסכום.",
        )
    return None


def _run(db: Session, row: CloudCardRefund, creds: zg.Credentials, user: Optional[User], *, gateway: zg.ZCreditGateway) -> None:
    """The gateway part: the sale's state, the refund once, the answer. Commits as it goes."""
    try:
        before = gateway.status_by_reference(creds, row.original_reference)
    except zg.GatewayError as e:
        _decline(db, row, "gateway_unreachable", f"לא ניתן לבדוק את העסקה מול Z-Credit ({e}). לא בוצע זיכוי.")
        db.commit()
        return
    row.before_status_code = before.status_code
    _event(
        db, row, "preflight", actor="gateway", detail=before.return_message,
        data={"statusCode": before.status_code, "returnCode": before.return_code,
              "transactionSum": _money(_shekels(before.transaction_agorot)) if before.transaction_agorot else None},
    )
    why = _preflight_refusal(db, row, before)
    if why is not None:
        _decline(db, row, *why)
        db.commit()
        return

    # The point of no return: once this is committed the refund may be out.
    row.refund_sent_at = datetime.now(timezone.utc)
    row.updated_at = row.refund_sent_at
    _event(db, row, "sent", actor="system", data={"amount": _money(row.amount)})
    db.commit()
    try:
        reply = gateway.refund(creds, row.original_reference, _agorot(row.amount))
    except zg.GatewayError as e:
        if not e.maybe_sent:
            _decline(db, row, "not_sent", f"לא נוצר חיבור ל-Z-Credit ({e}). הזיכוי לא נשלח — לא בוצע זיכוי.")
            db.commit()
            return
        row.status = CS.UNKNOWN
        row.error_code = "no_reply"
        row.error_message = f"לא התקבלה תשובה מ-Z-Credit לזיכוי ({e}). בודקים מול Z-Credit — לא שולחים שוב."
        row.attempt_finished_at = datetime.now(timezone.utc)
        row.updated_at = row.attempt_finished_at
        _event(db, row, "unknown", actor="system", detail=row.error_message)
        db.commit()
        _resolve(db, row, creds, gateway, user=None, attempts=RESOLVE_ATTEMPTS)
        return
    row.return_code = reply.return_code
    row.return_message = (reply.return_message or "")[:1000] or None
    row.attempt_finished_at = datetime.now(timezone.utc)
    if reply.ok:
        _mark_refunded(db, row, reply=reply, by="gateway", user=None)
    else:
        code = "not_refundable" if reply.return_code == zg.Codes.NOT_REFUNDABLE else (
            "zcredit_credentials_refused" if reply.credentials_refused else "gateway_declined"
        )
        _decline(db, row, code, f"Z-Credit לא אישר את הזיכוי: {reply.return_message or f'קוד {reply.return_code}'}",
                 actor="gateway")
    db.commit()


def _decline(db: Session, row: CloudCardRefund, code: str, message: str, *, actor: str = "system",
             user: Optional[User] = None) -> None:
    now = datetime.now(timezone.utc)
    row.status = CS.DECLINED
    row.error_code = code[:64]
    row.error_message = message
    row.attempt_finished_at = row.attempt_finished_at or now
    row.updated_at = now
    _event(db, row, "declined", actor=actor, user=user, detail=message, data={"code": code})


def _mark_refunded(
    db: Session,
    row: CloudCardRefund,
    *,
    reply: Optional[zg.Reply],
    by: str,
    user: Optional[User],
    note: Optional[str] = None,
) -> None:
    now = datetime.now(timezone.utc)
    row.status = CS.REFUNDED
    row.error_code = None
    row.error_message = None
    row.resolved_by = by
    row.refunded_at = now
    row.updated_at = now
    row.voided = row.before_status_code == zg.TxStatus.APPROVED_NOT_DEPOSITED
    if reply is not None:
        row.refund_reference = reply.reference_number
        row.approval_number = (reply.approval_number or "")[:32] or None
        row.voucher_number = (reply.voucher_number or "")[:32] or None
        if reply.card_last4 and not row.card_last4:
            row.card_last4 = reply.card_last4
    if user is not None:
        row.resolved_by_user_id = user.id
        row.resolution_note = note
    _event(
        db, row, "refunded" if by == "gateway" else ("resolved" if by == "status_query" else "resolved_manually"),
        actor="gateway" if by != "manual" else "user", user=user, detail=note,
        data={"by": by, "refundReference": row.refund_reference, "approvalNumber": row.approval_number,
              "voided": row.voided},
    )
    # The money moved: that is recorded before anything else is tried.
    db.commit()
    try:
        _request_document(db, row, user=user)
        db.commit()
    except Exception as e:  # noqa: BLE001 - the refund stands; the note is asked for again from the dashboard
        db.rollback()
        logger.exception("cloud card refund %s: could not ask a till for the credit note", row.id)
        _event(db, row, "document_failed", actor="system", detail=f"הבקשה לקופה לא נוצרה: {type(e).__name__}")
        db.commit()


# ── Unknown outcomes ──────────────────────────────────────────────────────────


def _stale(row: CloudCardRefund, now: datetime) -> bool:
    started = _utc(row.attempt_started_at) or _utc(row.created_at)
    return started is not None and now - started > STALE_IN_FLIGHT


def _verdict(db: Session, row: CloudCardRefund, q: zg.Reply, now: datetime) -> str:
    """`refunded`, `not_refunded`, `wait` (too early to say no), or `ambiguous`."""
    if q.has_error or q.status_code is None:
        return "ambiguous"
    before, after = row.before_status_code, q.status_code
    if before in zg.TxStatus.UNTOUCHED:
        if after in zg.TxStatus.TAKEN_BACK:
            return "refunded"
        if after in zg.TxStatus.UNTOUCHED:
            sent = _utc(row.refund_sent_at) or now
            return "not_refunded" if now - sent >= SETTLE_AFTER else "wait"
        return "ambiguous"
    if before == zg.TxStatus.PARTIALLY_REFUNDED and after == zg.TxStatus.REFUNDED:
        # Refunded in full now: ours, if it took exactly what was left of the leg.
        original = db.query(Transaction).filter(Transaction.id == row.original_transaction_id).first()
        leg = db.query(TransactionPayment).filter(TransactionPayment.id == row.original_payment_id).first()
        if original is not None and leg is not None:
            left = leg_state(db, original, leg, exclude_refund_id=row.id).remaining
            if left == _agorot(row.amount):
                return "refunded"
    return "ambiguous"


def _resolve(
    db: Session,
    row: CloudCardRefund,
    creds: zg.Credentials,
    gateway: zg.ZCreditGateway,
    *,
    user: Optional[User],
    attempts: int,
) -> None:
    """Ask the gateway what became of the sale; never send the refund again. Commits."""
    if row.refund_sent_at is None:
        _decline(db, row, "not_sent", "הזיכוי לא נשלח ל-Z-Credit (נעצר לפני השליחה). לא בוצע זיכוי.", user=user)
        db.commit()
        return
    for attempt in range(attempts):
        if attempt:
            sleep(RESOLVE_PAUSE_S)
        now = datetime.now(timezone.utc)
        row.query_count = (row.query_count or 0) + 1
        row.last_query_at = now
        try:
            q = gateway.status_by_reference(creds, row.original_reference)
        except zg.GatewayError as e:
            _event(db, row, "query", actor="system", user=user, detail=str(e), data={"reached": False})
            db.commit()
            continue
        row.after_status_code = q.status_code
        verdict = _verdict(db, row, q, now)
        _event(
            db, row, "query", actor="gateway", user=user, detail=q.return_message,
            data={"statusCode": q.status_code, "returnCode": q.return_code, "verdict": verdict},
        )
        if verdict == "refunded":
            _mark_refunded(db, row, reply=None, by="status_query", user=None)
            db.commit()
            return
        if verdict == "not_refunded":
            _decline(
                db, row, "not_refunded_by_query",
                "בבדיקה מול Z-Credit: העסקה לא זוכתה — הזיכוי לא בוצע. אפשר לזכות שוב בבקשה חדשה.",
                actor="gateway", user=user,
            )
            db.commit()
            return
        if verdict == "ambiguous":
            break
        db.commit()
    row.status = CS.UNKNOWN
    if row.after_status_code in zg.TxStatus.UNTOUCHED and row.before_status_code in zg.TxStatus.UNTOUCHED:
        row.error_message = (
            "Z-Credit עדיין לא מראה זיכוי לעסקה. בודקים שוב בעוד כמה דקות (\"בדוק שוב\") — לא שולחים שוב."
        )
    else:
        row.error_message = (
            "לא ניתן לקבוע מול Z-Credit אם הזיכוי בוצע. בדקו בדוח העסקאות של Z-Credit ורשמו את התוצאה "
            "(\"בוצע\" / \"לא בוצע\") — לא שולחים שוב."
        )
    row.updated_at = datetime.now(timezone.utc)
    db.commit()


def recover(db: Session, row: CloudCardRefund, *, gateway: Optional[zg.ZCreditGateway] = None,
            user: Optional[User] = None, now: Optional[datetime] = None) -> CloudCardRefund:
    """A row left `in_flight` (the process died): never sent → declined; maybe sent → resolved."""
    if row.status != CS.IN_FLIGHT:
        return row
    if row.refund_sent_at is None:
        _decline(db, row, "not_sent", "הזיכוי לא הושלם ולא נשלח ל-Z-Credit (נעצר באמצע). לא בוצע זיכוי.", user=user)
        db.commit()
        return row
    row.status = CS.UNKNOWN
    row.error_code = "interrupted"
    row.error_message = "הזיכוי נקטע אחרי השליחה ל-Z-Credit. בודקים מול Z-Credit — לא שולחים שוב."
    _event(db, row, "unknown", actor="system", detail=row.error_message)
    db.commit()
    try:
        return check(db, row, user, gateway=gateway, now=now, rate_limit=False)
    except HTTPException:
        return row  # cannot ask now (no credentials): stays unknown, "בדוק שוב" later


def check(
    db: Session,
    row: CloudCardRefund,
    user: Optional[User],
    *,
    gateway: Optional[zg.ZCreditGateway] = None,
    now: Optional[datetime] = None,
    rate_limit: bool = True,
) -> CloudCardRefund:
    """"בדוק שוב": one status query for an unknown (or crashed) refund."""
    now = _now(now)
    if row.status == CS.IN_FLIGHT:
        if not _stale(row, now):
            raise _refuse("refund_in_progress", "הזיכוי עדיין בביצוע מול Z-Credit.")
        return recover(db, row, gateway=gateway, user=user, now=now)
    if row.status != CS.UNKNOWN:
        raise _refuse("refund_not_unknown", "רק זיכוי שתוצאתו לא ידועה נבדק מול Z-Credit.")
    last = _utc(row.last_query_at)
    if rate_limit and last is not None and now - last < CHECK_MIN_INTERVAL:
        raise _refuse("check_too_soon", "נבדק לפני רגע — נסו שוב בעוד כמה שניות.", status.HTTP_429_TOO_MANY_REQUESTS)
    original = db.query(Transaction).filter(Transaction.id == row.original_transaction_id).first()
    creds, missing = credentials_for(db, _original_machine(db, original) if original else None, original)
    if creds is None:
        raise _refuse(*missing)
    if creds.terminal_number != row.terminal_number:
        raise _refuse(
            "terminal_changed",
            "מסוף Z-Credit של הקופה הוחלף מאז הזיכוי — בדקו בדוח של Z-Credit ורשמו את התוצאה ידנית.",
        )
    _resolve(db, row, creds, gateway or gateway_factory(), user=user, attempts=1)
    return row


def resolve_manually(
    db: Session, row: CloudCardRefund, user: User, *, outcome: str, note: Optional[str], now: Optional[datetime] = None
) -> CloudCardRefund:
    """An operator, having checked Z-Credit's report, records what happened to an unknown refund."""
    if row.status != CS.UNKNOWN:
        # A row stuck `in_flight` is first recovered by "בדוק שוב" (it may never have been sent).
        raise _refuse("refund_not_unknown", "רק זיכוי שתוצאתו לא ידועה נרשם ידנית.")
    text = " ".join((note or "").split())
    if len(text) < 2:
        raise _refuse("note_required", "חובה לכתוב מה נבדק (למשל: נמצא בדוח Z-Credit, אסמכתא …).",
                      status.HTTP_422_UNPROCESSABLE_ENTITY)
    text = text[:REASON_MAX]
    if outcome == "refunded":
        _mark_refunded(db, row, reply=None, by="manual", user=user, note=text)
    elif outcome == "not_refunded":
        row.resolved_by = "manual"
        row.resolved_by_user_id = user.id
        row.resolution_note = text
        _decline(db, row, "not_refunded_manual", f"נרשם ידנית: הזיכוי לא בוצע — {text}", actor="user", user=user)
    else:
        raise _refuse("unknown_outcome", "תוצאה לא מוכרת.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    db.commit()
    return row


# ── The credit note (a till issues it) ────────────────────────────────────────


def card_tender(db: Session, row: CloudCardRefund) -> dict:
    """
    The credit note's tender: the card, the refund's money, and an acquirer reply the till
    files as is. No `uid`: no batch of any till carries a refund the gateway made, so the leg
    never waits for a transmission (the gateway deposits it with the terminal's own batch).
    """
    leg = db.query(TransactionPayment).filter(TransactionPayment.id == row.original_payment_id).first()
    original_result = _result(_meta(leg)) if leg is not None else {}
    agorot = _agorot(row.amount)
    result: Dict[str, Any] = {
        "provider": PROVIDER,
        "cloudRefund": True,
        "statusCode": 0,
        "statusMessage": "זיכוי בוצע מהענן",
        "amount": agorot,
        "originalReferenceNumber": row.original_reference,
        "voided": bool(row.voided),
    }
    if row.refund_reference:
        result["zcreditReferenceNumber"] = row.refund_reference
    if row.approval_number:
        result["issuerAuthNum"] = row.approval_number
    if row.voucher_number:
        result["voucherNumber"] = row.voucher_number
    if row.card_last4:
        result["cardNumber"] = "************" + row.card_last4
    for key in ("mutag", "solek", "manpik", "cardName"):
        if original_result.get(key) is not None:
            result[key] = original_result[key]
    meta: Dict[str, Any] = {
        "cloudCardRefundId": str(row.id),
        "outcome": "approved",
        "statusCode": 0,
        "result": result,
    }
    if row.approval_number:
        meta["authNum"] = row.approval_number
    if row.card_last4:
        meta["cardLast4"] = row.card_last4
    tender: Dict[str, Any] = {
        "method": CARD_METHOD,
        "amount": _money(row.amount),
        "cardRefundId": str(row.id),
        "nayaxMeta": meta,
    }
    for key, value in (("cardBrand", row.card_brand), ("cardAcquirer", row.card_acquirer), ("cardIssuer", row.card_issuer)):
        if value:
            tender[key] = value
    return tender


def _request_document(db: Session, row: CloudCardRefund, *, user: Optional[User], machine: Optional[POSMachine] = None) -> RemoteCreditRequest:
    machine = machine or db.query(POSMachine).filter(POSMachine.id == row.target_machine_id).first()
    req = rc.create_for_card_refund(db, row, machine, [card_tender(db, row)], user=user)
    row.remote_credit_request_id = req.id
    row.target_machine_id = machine.id
    _event(
        db, row, "document_requested", actor="system" if user is None else "user", user=user,
        detail=machine.name, data={"requestId": str(req.id), "machineId": str(machine.id)},
    )
    db.flush()
    return req


def resend(
    db: Session, row: CloudCardRefund, user: User, target: POSMachine, *, force: bool = False,
    now: Optional[datetime] = None,
) -> CloudCardRefund:
    """
    Ask (another) till for the credit note of a refunded card: the earlier till refused it, it
    expired, or — `force`, confirmed by the user — it waits at a till that is not coming back.
    """
    now = _now(now)
    rc.expire_overdue(db, now=now)
    if row.status != CS.REFUNDED:
        raise _refuse("refund_not_refunded", "אפשר לשלוח למסמך זיכוי רק זיכוי שבוצע בכרטיס.")
    if _landed(db, row) or row.credit_transaction_id is not None:
        raise _refuse("document_already_issued", "מסמך הזיכוי כבר הופק.")
    original = db.query(Transaction).filter(Transaction.id == row.original_transaction_id).first()
    if original is None:
        raise _refuse("original_unknown", "המסמך המקורי לא נמצא.", status.HTTP_404_NOT_FOUND)
    refusal = rc.target_refusal(db, original, target)
    if refusal is not None:
        raise refusal
    latest = (
        db.query(RemoteCreditRequest).filter(RemoteCreditRequest.id == row.remote_credit_request_id).first()
        if row.remote_credit_request_id
        else None
    )
    if latest is not None and latest.status in PENDING_REMOTE_CREDIT_STATUSES:
        if not force:
            raise _refuse(
                "document_request_pending",
                "מסמך הזיכוי עדיין ממתין בקופה. לשלוח לקופה אחרת? אם הקופה הראשונה כבר הפיקה אותו "
                "בלי חיבור — יהיו שני מסמכי זיכוי, והמערכת תסמן זאת.",
            )
        rc.cancel_pending(db, latest, user, reason=f"נשלח לקופה אחרת ({target.name})", now=now)
    _request_document(db, row, user=user, machine=target)
    _event(db, row, "resent", actor="user", user=user, detail=target.name, data={"machineId": str(target.id)}, now=now)
    db.commit()
    return row


def on_document_request(db: Session, req: RemoteCreditRequest, what: str, *, now: datetime, credit_id=None) -> None:
    """What became of a `card_refunded` request (remote_credits calls this)."""
    row = (
        db.query(CloudCardRefund)
        .filter(CloudCardRefund.id == req.card_refund_id, CloudCardRefund.tenant_id == req.tenant_id)
        .first()
    )
    if row is None:
        return
    if what == "completed":
        if req.credit_transaction_id is None:
            return
        if row.credit_transaction_id is not None and row.credit_transaction_id != req.credit_transaction_id:
            _event(
                db, row, "duplicate_document", actor="system", detail=req.credit_document_number,
                data={"creditTransactionId": str(req.credit_transaction_id), "requestId": str(req.id)}, now=now,
            )
            return
        first = row.credit_transaction_id is None
        row.credit_transaction_id = req.credit_transaction_id
        row.credit_document_number = req.credit_document_number or row.credit_document_number
        row.credit_document_type = req.credit_document_type if req.credit_document_type is not None else row.credit_document_type
        row.updated_at = now
        if first:
            _event(
                db, row, "document_issued", actor="till", detail=req.credit_document_number,
                data={"creditTransactionId": str(req.credit_transaction_id), "requestId": str(req.id),
                      "machineId": str(req.machine_id)},
                now=now,
            )
            # An earlier till issued it after all: the later ask is not needed any more.
            if row.remote_credit_request_id not in (None, req.id):
                later = db.query(RemoteCreditRequest).filter(RemoteCreditRequest.id == row.remote_credit_request_id).first()
                if later is not None and later.status in PENDING_REMOTE_CREDIT_STATUSES:
                    rc.cancel_pending(db, later, None, reason="מסמך הזיכוי כבר הופק בקופה אחרת", now=now)
            row.remote_credit_request_id = req.id
    elif what in ("failed", "expired"):
        if req.id == row.remote_credit_request_id and row.credit_transaction_id is None:
            _event(
                db, row, "document_failed", actor="till" if what == "failed" else "system",
                detail=req.error_message or req.error_code, data={"requestId": str(req.id), "what": what}, now=now,
            )
    elif what == "duplicate":
        _event(
            db, row, "duplicate_document", actor="till", detail="מסמך זיכוי נוסף לאותו זיכוי בכרטיס",
            data={"creditTransactionId": str(credit_id) if credit_id else None, "requestId": str(req.id)}, now=now,
        )


def till_block(db: Session, refund_id) -> Optional[dict]:
    """`cardRefund` in the till's payload of a `card_refunded` request."""
    row = db.query(CloudCardRefund).filter(CloudCardRefund.id == refund_id).first()
    if row is None:
        return None
    return {
        "id": str(row.id),
        "provider": row.provider,
        "label": LABEL,
        "amount": float(_dec(row.amount)),
        "refundedAt": _utc(row.refunded_at).isoformat() if row.refunded_at else None,
        "originalReferenceNumber": row.original_reference,
        "refundReferenceNumber": row.refund_reference,
        "approvalNumber": row.approval_number,
        "voucherNumber": row.voucher_number,
        "cardLast4": row.card_last4,
        "voided": bool(row.voided),
    }


# ── Out ───────────────────────────────────────────────────────────────────────

#: What still needs a person: why, in the dashboard's words.
ATTENTION = {
    "unknown": "לא ידוע אם הכרטיס זוכה — בדקו מול Z-Credit",
    "document_missing": "הכרטיס זוכה אבל מסמך הזיכוי לא הופק — שלחו לקופה",
    "document_pending": "ממתין להפקת מסמך הזיכוי בקופה",
}


def attention_of(db: Session, row: CloudCardRefund, req: Optional[RemoteCreditRequest], now: datetime) -> Optional[str]:
    if row.status == CS.UNKNOWN or (row.status == CS.IN_FLIGHT and _stale(row, now)):
        return "unknown"
    if row.status != CS.REFUNDED or row.credit_transaction_id is not None:
        return None
    if req is not None and req.status in PENDING_REMOTE_CREDIT_STATUSES:
        return "document_pending"
    return "document_missing"


def refund_to_out(db: Session, row: CloudCardRefund, *, events: bool = False, now: Optional[datetime] = None) -> dict:
    from app.services.machine_status import is_online

    now = _now(now)
    req = (
        db.query(RemoteCreditRequest).filter(RemoteCreditRequest.id == row.remote_credit_request_id).first()
        if row.remote_credit_request_id
        else None
    )
    machine_ids = {i for i in (row.target_machine_id, row.original_machine_id) if i is not None}
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(list(machine_ids))).all()} if machine_ids else {}
    target = machines.get(row.target_machine_id)
    original_machine = machines.get(row.original_machine_id)
    attention = attention_of(db, row, req, now)
    out = {
        "id": str(row.id),
        "transactionId": str(row.original_transaction_id),
        "paymentId": str(row.original_payment_id),
        "originalDocumentNumber": row.original_document_number,
        "originalMachineId": str(row.original_machine_id) if row.original_machine_id else None,
        "originalMachineName": original_machine.name if original_machine is not None else None,
        "provider": row.provider,
        "terminal": zg.mask_terminal(row.terminal_number),
        "credentialSource": row.credential_source,
        "originalReference": row.original_reference,
        "originalLegAmount": _money(row.original_leg_amount),
        "cardLast4": row.card_last4,
        "cardBrand": row.card_brand,
        "amount": _money(row.amount),
        "fullCredit": bool(row.full_credit),
        "lines": row.lines or [],
        "reasonCode": row.reason_code,
        "reason": row.reason,
        "status": row.status,
        "errorCode": row.error_code,
        "errorMessage": row.error_message,
        "beforeStatusCode": row.before_status_code,
        "afterStatusCode": row.after_status_code,
        "returnCode": row.return_code,
        "returnMessage": row.return_message,
        "refundReference": row.refund_reference,
        "approvalNumber": row.approval_number,
        "voucherNumber": row.voucher_number,
        "voided": bool(row.voided),
        "resolvedBy": row.resolved_by,
        "resolutionNote": row.resolution_note,
        "queryCount": row.query_count or 0,
        "lastQueryAt": _utc(row.last_query_at),
        "refundSentAt": _utc(row.refund_sent_at),
        "refundedAt": _utc(row.refunded_at),
        "createdAt": _utc(row.created_at),
        "updatedAt": _utc(row.updated_at),
        "createdBy": row.initiated_by,
        "targetMachineId": str(row.target_machine_id),
        "targetMachineName": target.name if target is not None else None,
        "targetOnline": is_online(target.last_heartbeat_at, now=now) if target is not None else False,
        "attention": attention,
        "attentionLabel": ATTENTION.get(attention) if attention else None,
        "document": {
            "requestId": str(req.id) if req is not None else None,
            "requestStatus": req.status if req is not None else None,
            "requestErrorCode": req.error_code if req is not None else None,
            "requestErrorMessage": req.error_message if req is not None else None,
            "machineId": str(req.machine_id) if req is not None else None,
            "creditTransactionId": str(row.credit_transaction_id) if row.credit_transaction_id else None,
            "creditDocumentNumber": row.credit_document_number,
            "creditDocumentType": row.credit_document_type,
            "landed": _landed(db, row),
        },
    }
    if events:
        rows = (
            db.query(CloudCardRefundEvent)
            .filter(CloudCardRefundEvent.refund_id == row.id)
            .order_by(CloudCardRefundEvent.at.asc(), CloudCardRefundEvent.id.asc())
            .all()
        )
        users = {
            u.id: u for u in db.query(User).filter(User.id.in_([r.user_id for r in rows if r.user_id])).all()
        } if rows else {}
        out["events"] = [
            {
                "at": _utc(r.at),
                "actor": r.actor,
                "action": r.action,
                "by": rc._initiator(users[r.user_id]) if r.user_id in users else None,
                "detail": r.detail,
            }
            for r in rows
        ]
    return out


def leg_out(db: Session, original: Transaction, leg: TransactionPayment) -> dict:
    why = leg_refusal(leg)
    meta = _meta(leg)
    out = {
        "paymentId": str(leg.id),
        "method": (leg.method or "").strip().lower(),
        "amount": _money(leg.amount),
        "provider": leg_provider(meta),
        "cardLast4": card_last4_of(meta),
        "cardBrand": leg.card_brand,
        "approvalNumber": approval_number_of(meta),
        "zcredit": why is None or why[0] not in ("not_a_card_leg", "not_zcredit", "no_money_leg"),
        "refundable": why is None,
        "refusal": {"code": why[0], "message": why[1]} if why else None,
        "refundedAmount": "0.00",
        "inProgressAmount": "0.00",
        "tillCardCredits": "0.00",
        "remainingAmount": "0.00",
    }
    if why is None:
        state = leg_state(db, original, leg)
        out.update(
            refundedAmount=_money(_shekels(state.refunded)),
            inProgressAmount=_money(_shekels(state.in_progress)),
            tillCardCredits=_money(_shekels(state.till_card_credits)),
            remainingAmount=_money(_shekels(state.remaining)),
        )
        if state.remaining <= 0:
            out["refundable"] = False
            out["refusal"] = {"code": "nothing_left_on_leg", "message": "בתשלום הזה כבר זוכה הכול לכרטיס."}
    return out


def prepare_out(db: Session, original: Transaction, targets: List[dict], *, now: Optional[datetime] = None) -> dict:
    """What the dialog needs: the switch, the legs, the credentials' state, the lines and the tills."""
    now = _now(now)
    legs = (
        db.query(TransactionPayment)
        .filter(TransactionPayment.transaction_id == original.id)
        .order_by(TransactionPayment.sequence, TransactionPayment.id)
        .all()
    )
    legs_out = [leg_out(db, original, l) for l in legs]
    creds, missing = (None, None)
    if any(l["zcredit"] for l in legs_out):
        creds, missing = credentials_for(db, _original_machine(db, original), original)
    document = rc.prepare_out(db, original, targets)
    document["reasons"] = [{"code": c, "label": l} for c, l in REASONS]
    rows = (
        db.query(CloudCardRefund)
        .filter(CloudCardRefund.original_transaction_id == original.id)
        .order_by(CloudCardRefund.created_at.desc())
        .all()
    )
    return {
        "enabled": enabled(),
        "disabledMessage": None if enabled() else DISABLED_MESSAGE,
        "label": LABEL,
        "legs": legs_out,
        "credentials": {
            "available": creds is not None,
            "terminal": creds.masked_terminal if creds is not None else None,
            "source": creds.source if creds is not None else None,
            "refusal": {"code": missing[0], "message": missing[1]} if missing else None,
        },
        "document": document,
        "refunds": [refund_to_out(db, r, now=now) for r in rows],
    }


def needs_attention(db: Session, rows: Sequence[CloudCardRefund], now: Optional[datetime] = None) -> List[CloudCardRefund]:
    now = _now(now)
    out = []
    for row in rows:
        req = (
            db.query(RemoteCreditRequest).filter(RemoteCreditRequest.id == row.remote_credit_request_id).first()
            if row.remote_credit_request_id
            else None
        )
        if attention_of(db, row, req, now) is not None:
            out.append(row)
    return out
