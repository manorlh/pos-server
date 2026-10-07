"""
Exceptions ("חריגות"): detection, configuration and review.

**What is detected, and from what.** Server-side, from what the tills already push, so
it works for every till and for history (`rescan`):

* documents (`transactions`) — discount, refund (credit note 330), a cancelled
  document, a high tip, a high amount, a sale after hours;
* shift closes — a cash difference at close;
* till events (`till_events`, pushed by the till through its outbox) — what no
  document carries: a line voided before payment, a basket cancelled without a sale,
  the time a basket took from its first line to payment, a drawer opened without a
  sale.

**Configuration.** Each type is on or off and has thresholds (`RULES`). Both can be set
at the tenant, a company, a shop, an area (נקודת מכירה) or a till; field by field, the
most specific level that sets one wins (`resolve_rules`), else the default here — the
same "till → area → shop → company" order as the till parameters
(`app.services.till_parameters`), with the tenant above the company.

**Idempotent.** Every exception has a `dedupe_key` (`<type>:<source id>`), unique in
the table. A re-pushed document or a rescan finds the row and, while it is still
`new`, refreshes its figures; it never creates a second one and never reopens one a
manager already reviewed or dismissed.

Detection runs after the sync request has committed and never fails it
(`detect_safely`): an exception missed is found by the next rescan; a document refused
over one would be lost.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.audit_exception import AuditException, ExceptionRuleValue, TillEvent
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction, TransactionStatus
from app.services.document_prefix import document_number_from

logger = logging.getLogger(__name__)

CREDIT_NOTE = 330
#: An exempt dealer's receipt refund (app/services/tenders.RECEIPT_REFUND_DOCUMENT_TYPE).
RECEIPT_REFUND = -400

# ── The catalog ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ParamSpec:
    key: str
    default: float
    minimum: float = 0
    maximum: float = 1_000_000
    integer: bool = False


@dataclass(frozen=True)
class RuleSpec:
    type: str
    default_enabled: bool
    params: Tuple[ParamSpec, ...]
    severity: str
    #: Where it is detected from: document | shift | till_event.
    source: str
    #: False: listed so the dashboard can show it as planned, never detected yet.
    available: bool = True


RULES: Tuple[RuleSpec, ...] = (
    # Any manual discount on a line or the whole sale. Both thresholds 0 = any discount;
    # a threshold set must be met (≥ X% of the price and ≥ ₪X).
    RuleSpec("discount", True, (ParamSpec("minPercent", 0, 0, 100), ParamSpec("minAmount", 0)), "low", "document"),
    # OTH ("על חשבון הבית", till parameter `othEnabled`): a line given free, with its reason
    # and approver — one per line, at its list price. Not counted as a "discount" above.
    RuleSpec("oth", True, (), "medium", "document"),
    # A credit note (זיכוי / החזר), ≥ ₪X.
    RuleSpec("refund", True, (ParamSpec("minAmount", 0),), "medium", "document"),
    # The drawer opened without a sale. Reported by the till (no drawer on the current
    # hardware, so none arrive yet).
    RuleSpec("drawer_open", True, (), "medium", "till_event"),
    # A line removed from the basket after it was rung up, ≥ ₪X.
    RuleSpec("line_void", True, (ParamSpec("minAmount", 0),), "low", "till_event"),
    # A basket cancelled without a sale (till event), or a cancelled document, ≥ ₪X.
    RuleSpec("basket_cancel", True, (ParamSpec("minAmount", 0),), "medium", "till_event"),
    # An open table cancelled with a reason and a manager's approval (app/services/tables.py
    # records it as a till event), ≥ ₪X.
    RuleSpec("table_cancelled", True, (ParamSpec("minAmount", 0),), "high", "till_event"),
    # "הדפסה חוזרת" at a table — the bill or the kitchen tickets again — with the manager
    # who approved it (till event).
    RuleSpec("reprint", True, (), "medium", "till_event"),
    # An employee signed in at another till released by a manager's PIN, so they could
    # sign in at this one ("עובד מחובר בקופה אחת בלבד"; app/services/user_sessions.py
    # records it as a till event).
    RuleSpec("user_session_release", True, (), "medium", "till_event"),
    # "שינוי נוכחות ידני" (spec §28): a manager's correction or close of an employee's
    # attendance, or a clock-out a manager approved over open tables
    # (app/services/attendance.py records it, with the old and the new times).
    RuleSpec("attendance_manual", True, (), "medium", "attendance"),
    # From the first line to payment, ≥ X minutes.
    RuleSpec("long_order", True, (ParamSpec("minutes", 10, 1, 24 * 60, integer=True),), "low", "till_event"),
    # A tip above X% of what the sale collected.
    RuleSpec("high_tip", True, (ParamSpec("percent", 15, 0, 1000),), "medium", "document"),
    # A sale of ≥ ₪X.
    RuleSpec("high_amount", False, (ParamSpec("amount", 1000),), "low", "document"),
    # Counted − expected at shift close, |difference| ≥ ₪X.
    RuleSpec("cash_difference", True, (ParamSpec("amount", 20),), "high", "shift"),
    # A till Z closed with no connection to the cloud whose figures, document range, shifts
    # or number differ from what the cloud built from the documents on upload
    # ("Z שנסגר ללא חיבור — פער מול הענן", docs/SPEC_OFFLINE_TILL_Z.md §6.1).
    RuleSpec("offline_z_gap", True, (), "high", "z"),
    # The shop's Z production moved by force by a super admin, although the main till
    # holding it might still have shop Zs the cloud does not (SPEC_INDEPENDENT_TILL §8.10).
    # (A shop Z that cannot be filed as printed is an `offline_z_conflict`, like a till Z.)
    RuleSpec("shop_z_producer_forced", True, (), "high", "z"),
    # A shop Z the main till printed in local mode that does not verify against the cloud's
    # documents ("אי-התאמה בין Z מקומי לנתוני הענן — לבדיקת התמיכה", SPEC_INDEPENDENT_TILL
    # §8.12): every document its tills' manifests name has arrived, and the same computation
    # disagrees — a bug, never a till still syncing. The Z is stored as printed.
    RuleSpec("local_shop_z_mismatch", True, (), "high", "z"),
    # A till's part of a local shop Z that will not complete ("קופה N לא השלימה סנכרון",
    # §8.12): its documents or shifts never reached the cloud — it died, was removed, support
    # closed it, or a day went by. The only allowed gap: support closes it, recording what is
    # missing. Never a mismatch.
    RuleSpec("local_shop_z_till_unsynced", True, (), "medium", "z"),
    # A Z closed at the till with no connection that the cloud could not take as it is —
    # a number out of sequence or taken, a shift in another Z, a till no longer in its
    # mode. Never renumbered: the till keeps it as printed, held for support
    # ("התנגשות — פנו לתמיכה", docs/SPEC_OFFLINE_TILL_Z.md §4.5). Supposed to be impossible.
    RuleSpec("offline_z_conflict", True, (), "high", "z"),
    # Support produced a dead till's Z from the cloud ("הפקת Z מהענן ע״י התמיכה",
    # docs/SPEC_OFFLINE_TILL_Z.md §4.6): who, when, why, the basis, the Z, the numbers the
    # device printed and never sent, the document counters' gaps, and what came later.
    RuleSpec("support_z_produced", True, (), "high", "z"),
    # Support ordered a reset of a till's data from the cloud — the only way there is
    # ("איפוס נתוני קופה (תמיכה)", docs/SPEC_OFFLINE_TILL_Z.md §4.7): who, when, why, what
    # the cloud saw before, and what the till did or why it refused.
    RuleSpec("till_reset", True, (), "high", "z"),
    # "הוחלפה קופה": a replacement device took over a till (§4.6.2) — the old and the new
    # device, who, when, why, and whether support produced its Z first.
    RuleSpec("till_replaced", True, (), "medium", "z"),
    # A till Z closed although the card batch transmission before it failed — on the
    # cashier's explicit confirmation, or unattended ("שידור אשראי נכשל בסגירת Z", §7.3).
    RuleSpec("z_transmission_failed", True, (), "high", "z"),
    # A remote Z close forced "even mid-sale": who forced it, and the basket the till
    # parked for it ("סגירת Z כפויה", §9; a till event).
    RuleSpec("forced_z_close", True, (), "high", "till_event"),
    # A self-order kiosk out of touch with the cloud for ≥ X minutes during its opening hours
    # ("קיוסק לא מחובר"; app/services/kiosk_offline.py records it, and when it came back).
    RuleSpec("kiosk_offline", True, (ParamSpec("offlineMinutes", 5, 1, 240, integer=True),), "high", "kiosk"),
    # A sale between fromHour and toHour local time (wraps midnight when from > to).
    RuleSpec(
        "after_hours",
        False,
        (ParamSpec("fromHour", 0, 0, 23, integer=True), ParamSpec("toHour", 6, 0, 24, integer=True)),
        "medium",
        "document",
    ),
    # Planned: the till has no manual re-pricing of a catalog item, and failed card
    # charges are not reported to the cloud.
    RuleSpec("price_override", False, (), "medium", "till_event", available=False),
    RuleSpec("card_failures", False, (ParamSpec("count", 3, 1, 100, integer=True),), "medium", "till_event", available=False),
)

RULES_BY_TYPE: Dict[str, RuleSpec] = {r.type: r for r in RULES}
EXCEPTION_TYPES = tuple(RULES_BY_TYPE)

#: Till event types this server accepts, and the rule each one feeds.
TILL_EVENT_TYPES = ("drawer_open", "line_void", "basket_cancel", "basket_completed", "reprint", "forced_z_close")


class RuleValueError(ValueError):
    pass


def clean_params(rule: RuleSpec, params: Any) -> Dict[str, float]:
    """The thresholds a level sets, validated; unknown keys and nulls are refused/dropped."""
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise RuleValueError("params must be an object")
    known = {p.key: p for p in rule.params}
    out: Dict[str, float] = {}
    for key, value in params.items():
        spec = known.get(key)
        if spec is None:
            raise RuleValueError(f"{rule.type}: unknown threshold {key!r}")
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RuleValueError(f"{rule.type}.{key} must be a number")
        if value != value or value < spec.minimum or value > spec.maximum:  # NaN, range
            raise RuleValueError(f"{rule.type}.{key} must be between {spec.minimum:g} and {spec.maximum:g}")
        if spec.integer and float(value) != int(value):
            raise RuleValueError(f"{rule.type}.{key} must be a whole number")
        out[key] = int(value) if spec.integer else float(value)
    return out


# ── Resolution ───────────────────────────────────────────────────────────────

Scope = Tuple[str, uuid.UUID]


@dataclass
class EffectiveRule:
    type: str
    enabled: bool
    params: Dict[str, float]
    #: Per field ("enabled" and each param key), the level whose value is used; None = default.
    sources: Dict[str, Optional[str]] = field(default_factory=dict)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def resolve_rules(rows: Iterable[ExceptionRuleValue], chain: Sequence[Scope]) -> Dict[str, EffectiveRule]:
    """
    Per type, field by field: the most specific level on `chain` (most specific first)
    that sets it, else the default. Rows off the chain are ignored.
    """
    rank = {(kind, _uuid(ident)): i for i, (kind, ident) in enumerate(chain)}
    by_type: Dict[str, List[Tuple[int, ExceptionRuleValue]]] = {}
    for row in rows:
        position = rank.get((row.scope_type, _uuid(row.scope_id)))
        if position is not None:
            by_type.setdefault(row.exception_type, []).append((position, row))

    out: Dict[str, EffectiveRule] = {}
    for spec in RULES:
        candidates = [r for _, r in sorted(by_type.get(spec.type, []), key=lambda c: c[0])]
        enabled, enabled_source = spec.default_enabled, None
        for r in candidates:
            if r.enabled is not None:
                enabled, enabled_source = bool(r.enabled), r.scope_type
                break
        params: Dict[str, float] = {}
        sources: Dict[str, Optional[str]] = {"enabled": enabled_source}
        for p in spec.params:
            value, source = p.default, None
            for r in candidates:
                own = r.params if isinstance(r.params, dict) else {}
                if own.get(p.key) is not None:
                    value, source = own[p.key], r.scope_type
                    break
            params[p.key] = value
            sources[p.key] = source
        out[spec.type] = EffectiveRule(
            type=spec.type, enabled=enabled and spec.available, params=params, sources=sources
        )
    return out


def company_of_shop(db: Session, shop_id) -> Optional[uuid.UUID]:
    if shop_id is None:
        return None
    row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
    return row[0] if row else None


def chain_for(
    *,
    tenant_id=None,
    company_id=None,
    shop_id=None,
    area_id=None,
    machine_id=None,
) -> List[Scope]:
    ordered = (
        ("machine", machine_id),
        ("area", area_id),
        ("shop", shop_id),
        ("company", company_id),
        ("tenant", tenant_id),
    )
    return [(kind, _uuid(ident)) for kind, ident in ordered if ident is not None]


def chain_for_machine(db: Session, machine: POSMachine) -> List[Scope]:
    return chain_for(
        tenant_id=machine.tenant_id,
        company_id=company_of_shop(db, machine.shop_id),
        shop_id=machine.shop_id,
        area_id=machine.area_id,
        machine_id=machine.id,
    )


def rules_on_chain(db: Session, chain: Sequence[Scope]) -> List[ExceptionRuleValue]:
    if not chain:
        return []
    ids = [ident for _, ident in chain]
    rows = db.query(ExceptionRuleValue).filter(ExceptionRuleValue.scope_id.in_(ids)).all()
    wanted = set(chain)
    return [r for r in rows if (r.scope_type, _uuid(r.scope_id)) in wanted]


def rules_for_machine(db: Session, machine: POSMachine) -> Dict[str, EffectiveRule]:
    chain = chain_for_machine(db, machine)
    return resolve_rules(rules_on_chain(db, chain), chain)


# ── Detection ────────────────────────────────────────────────────────────────

_CENT = Decimal("0.01")


def _dec(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _money(value: Any) -> Decimal:
    return _dec(value).quantize(_CENT, rounding=ROUND_HALF_UP)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _parse_time(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return _utc(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return _utc(datetime.fromisoformat(value.strip().replace("Z", "+00:00")))
    except ValueError:
        return None


SALE_STATUSES = (TransactionStatus.COMPLETED, TransactionStatus.REFUNDED, TransactionStatus.PARTIAL_REFUND)


def _status(tx: Transaction) -> str:
    s = tx.status
    return s.value if hasattr(s, "value") else str(s)


@dataclass
class Found:
    """One exception a detector found; written by `Detector._record`."""

    type: str
    key: str
    occurred_at: datetime
    amount: Optional[Decimal] = None
    value: Optional[Decimal] = None
    threshold: Optional[Decimal] = None
    details: Dict[str, Any] = field(default_factory=dict)
    pos_user_id: Optional[str] = None
    transaction_id: Optional[uuid.UUID] = None
    shift_id: Optional[uuid.UUID] = None
    till_event_id: Optional[uuid.UUID] = None
    severity: Optional[str] = None


def _meets(value: Decimal, threshold: float) -> bool:
    return value >= _dec(threshold)


def _hour_in_window(hour: int, from_hour: int, to_hour: int) -> bool:
    if from_hour == to_hour:
        return False
    if from_hour < to_hour:
        return from_hour <= hour < to_hour
    return hour >= from_hour or hour < to_hour


def detect_transaction(
    tx: Transaction, rules: Dict[str, EffectiveRule], tzinfo=None
) -> List[Found]:
    """The exceptions one document raises under `rules`. Pure: no database."""
    found: List[Found] = []
    status = _status(tx)
    occurred = _utc(tx.created_at) or datetime.now(timezone.utc)
    common = dict(occurred_at=occurred, pos_user_id=tx.cashier_id, transaction_id=tx.id, shift_id=tx.shift_id)
    approver = str(tx.approved_by_pos_user_id or tx.approved_by_user_id or "") or None

    if status == TransactionStatus.CANCELLED.value:
        rule = rules.get("basket_cancel")
        amount = abs(_money(tx.total_amount))
        if rule and rule.enabled and _meets(amount, rule.params.get("minAmount", 0)):
            found.append(Found(
                type="basket_cancel", key=f"basket_cancel:tx:{tx.id}", amount=amount,
                threshold=_dec(rule.params.get("minAmount", 0)),
                details={"source": "document", "transactionNumber": tx.transaction_number},
                **common,
            ))
        return found
    if status not in {s.value for s in SALE_STATUSES}:
        return found

    items = list(tx.items or [])
    # A credit note, or an exempt dealer's receipt refund (-400, SPEC_BUSINESS_TYPE.md).
    if tx.document_type in (CREDIT_NOTE, RECEIPT_REFUND):
        rule = rules.get("refund")
        amount = abs(_money(tx.total_amount))
        if rule and rule.enabled and amount > 0 and _meets(amount, rule.params.get("minAmount", 0)):
            found.append(Found(
                type="refund", key=f"refund:{tx.id}", amount=amount,
                threshold=_dec(rule.params.get("minAmount", 0)),
                details={
                    "transactionNumber": tx.transaction_number,
                    "refundOfTransactionId": str(tx.refund_of_transaction_id) if tx.refund_of_transaction_id else None,
                    "lines": [
                        {"name": it.product_name, "quantity": float(_dec(it.quantity)), "total": float(abs(_money(it.total_price)))}
                        for it in items[:20]
                    ],
                    "approvedBy": approver,
                },
                **common,
            ))
        return found

    # ── A sale ──
    total = _money(tx.total_amount)
    # OTH lines ("על חשבון הבית") are an exception of their own (below).
    oth_items = [it for it in items if getattr(it, "oth_reason", None)]
    line_discounts = [
        (it, abs(_money(it.discount))) for it in items
        if it.discount is not None and _dec(it.discount) != 0 and not getattr(it, "oth_reason", None)
    ]
    line_sum = sum((d for _, d in line_discounts), Decimal("0"))
    document_discount = abs(_money(tx.document_discount))
    collected = total - document_discount if total >= document_discount else total
    # Promotions ("מבצעים") are inside `document_discount` but are no one's decision at
    # the till: what is left without them is the discount the cashier gave.
    promotion_sum = sum((abs(_money(getattr(it, "promotion_discount", None))) for it in items), Decimal("0"))
    # Nor are discount vouchers ("שוברי הנחה"): the customer's voucher, checked by the cloud.
    promotion_sum += sum((abs(_money(getattr(it, "voucher_discount", None))) for it in items), Decimal("0"))
    # Nor are the OTH lines (reported as "oth"), nor the club button's fixed rate ("הנחת
    # מועדון", till parameter `clubButtonEnabled`) — the shop's own policy, in its report.
    oth_sum = sum((abs(_money(it.discount)) for it in oth_items), Decimal("0"))
    club_sum = (
        abs(_money(getattr(tx, "basket_discount", None)))
        if getattr(tx, "basket_discount_kind", None) == "club" else Decimal("0")
    )
    document_discount = max(document_discount - promotion_sum - oth_sum - club_sum, Decimal("0"))
    discount = max(document_discount, line_sum)

    rule = rules.get("discount")
    if rule and rule.enabled and discount > 0:
        base = total if total > 0 else sum((abs(_money(_dec(it.unit_price) * _dec(it.quantity))) for it in items), Decimal("0"))
        percent = (discount / base * 100).quantize(_CENT) if base > 0 else Decimal("100")
        min_pct = rule.params.get("minPercent", 0)
        min_amount = rule.params.get("minAmount", 0)
        if _meets(percent, min_pct) and _meets(discount, min_amount):
            found.append(Found(
                type="discount", key=f"discount:{tx.id}", amount=discount, value=percent,
                threshold=_dec(min_pct) if min_pct else (_dec(min_amount) if min_amount else None),
                details={
                    "transactionNumber": tx.transaction_number,
                    "documentDiscount": float(document_discount),
                    "basketDiscount": float(max(document_discount - line_sum, Decimal("0"))),
                    "lineDiscounts": [
                        {"name": it.product_name, "quantity": float(_dec(it.quantity)), "discount": float(d)}
                        for it, d in line_discounts[:20]
                    ],
                    "saleTotal": float(total),
                    "approvedBy": approver,
                },
                **common,
            ))

    rule = rules.get("oth")
    if rule and rule.enabled:
        for it in oth_items:
            # At its list price: what the shop gave away, whatever the line was rung at.
            value = abs(_money(_dec(it.unit_price) * _dec(it.quantity)))
            found.append(Found(
                type="oth", key=f"oth:{it.id}", amount=value,
                details={
                    "transactionNumber": tx.transaction_number,
                    "productName": it.product_name,
                    "productId": str(it.product_id) if it.product_id else None,
                    "quantity": float(_dec(it.quantity)),
                    "unitPrice": float(_money(it.unit_price)),
                    "reason": it.oth_reason,
                    "othBy": getattr(it, "oth_by", None),
                    "approvedBy": getattr(it, "oth_approved_by", None),
                },
                occurred_at=occurred,
                # Who gave it (a table line may be given by its waiter, paid at another till).
                pos_user_id=getattr(it, "oth_by", None) or tx.cashier_id,
                transaction_id=tx.id,
                shift_id=tx.shift_id,
            ))

    rule = rules.get("high_tip")
    tip = _money(tx.tip_amount)
    if rule and rule.enabled and tip > 0:
        legs = sum((_money(p.amount) for p in (tx.payments or [])), Decimal("0"))
        base = legs if legs > 0 else collected
        percent = (tip / base * 100).quantize(_CENT) if base > 0 else Decimal("100")
        limit = _dec(rule.params.get("percent", 15))
        if percent > limit:
            found.append(Found(
                type="high_tip", key=f"high_tip:{tx.id}", amount=tip, value=percent, threshold=limit,
                details={"transactionNumber": tx.transaction_number, "saleTotal": float(base),
                         "tipMethod": tx.tip_payment_method},
                **common,
            ))

    rule = rules.get("high_amount")
    if rule and rule.enabled and collected > 0 and _meets(collected, rule.params.get("amount", 1000)):
        found.append(Found(
            type="high_amount", key=f"high_amount:{tx.id}", amount=collected,
            threshold=_dec(rule.params.get("amount", 1000)),
            details={"transactionNumber": tx.transaction_number},
            **common,
        ))

    rule = rules.get("after_hours")
    if rule and rule.enabled and tzinfo is not None:
        local = occurred.astimezone(tzinfo)
        from_hour = int(rule.params.get("fromHour", 0))
        to_hour = int(rule.params.get("toHour", 6))
        if _hour_in_window(local.hour, from_hour, to_hour):
            found.append(Found(
                type="after_hours", key=f"after_hours:{tx.id}", amount=collected,
                value=_dec(local.hour),
                details={"transactionNumber": tx.transaction_number, "localTime": local.strftime("%H:%M"),
                         "fromHour": from_hour, "toHour": to_hour},
                **common,
            ))
    return found


def detect_shift(shift: Shift, rules: Dict[str, EffectiveRule]) -> List[Found]:
    rule = rules.get("cash_difference")
    if not rule or not rule.enabled or shift.discrepancy is None:
        return []
    if (shift.status.value if hasattr(shift.status, "value") else shift.status) != ShiftStatus.CLOSED.value:
        return []
    difference = _money(shift.discrepancy)
    limit = _dec(rule.params.get("amount", 20))
    if difference == 0 or abs(difference) < limit:
        return []
    return [Found(
        type="cash_difference", key=f"cash_difference:{shift.id}", amount=difference, value=difference,
        threshold=limit, occurred_at=_utc(shift.closed_at or shift.close_accepted_at or shift.opened_at),
        pos_user_id=shift.closed_by_pos_user_id, shift_id=shift.id,
        details={
            "expectedCash": float(_money(shift.expected_cash)) if shift.expected_cash is not None else None,
            "countedCash": float(_money(shift.counted_cash)) if shift.counted_cash is not None else None,
            "closedBy": shift.closed_by,
            "sequenceNumber": shift.sequence_number,
        },
        severity="high" if difference < 0 else "medium",
    )]


def detect_event(event: TillEvent, rules: Dict[str, EffectiveRule]) -> List[Found]:
    details = dict(event.details) if isinstance(event.details, dict) else {}
    occurred = _utc(event.occurred_at) or datetime.now(timezone.utc)
    common = dict(
        occurred_at=occurred, pos_user_id=event.pos_user_id, transaction_id=event.transaction_id,
        shift_id=event.shift_id, till_event_id=event.id,
    )
    amount = abs(_money(event.amount)) if event.amount is not None else None
    kind = event.event_type

    if kind in ("drawer_open", "reprint", "user_session_release", "forced_z_close"):
        rule = rules.get(kind)
        if rule and rule.enabled:
            return [Found(type=kind, key=f"{kind}:{event.id}", amount=amount, details=details, **common)]
    elif kind in ("line_void", "basket_cancel", "table_cancelled"):
        rule = rules.get(kind)
        if rule and rule.enabled and _meets(amount or Decimal("0"), rule.params.get("minAmount", 0)):
            return [Found(type=kind, key=f"{kind}:{event.id}", amount=amount,
                          threshold=_dec(rule.params.get("minAmount", 0)), details=details, **common)]
    elif kind == "basket_completed":
        rule = rules.get("long_order")
        started = _parse_time(details.get("startedAt"))
        ended = _parse_time(details.get("completedAt")) or occurred
        if rule and rule.enabled and started is not None and ended > started:
            minutes = Decimal((ended - started).total_seconds() / 60).quantize(_CENT)
            limit = _dec(rule.params.get("minutes", 10))
            if minutes >= limit:
                return [Found(type="long_order", key=f"long_order:{event.id}", amount=amount, value=minutes,
                              threshold=limit, details=details, **common)]
    return []


def record_z_exception(
    db: Session,
    machine: POSMachine,
    *,
    exception_type: str,
    key: str,
    occurred_at: datetime,
    details: Dict[str, Any],
    amount: Any = None,
    pos_user_id: Optional[str] = None,
) -> bool:
    """
    Record an exception about a Z (`offline_z_gap`, `z_transmission_failed`), unless the
    till's rules switch it off. Idempotent by `key`; the caller commits. True if written
    or refreshed.
    """
    detector = Detector(db)
    rule = detector.rules(machine).get(exception_type)
    if rule is None or not rule.enabled:
        return False
    detector._record(machine, Found(
        type=exception_type, key=key[:200], amount=None if amount is None else _money(amount),
        occurred_at=_utc(occurred_at) or datetime.now(timezone.utc), pos_user_id=pos_user_id,
        details=details,
    ))
    return bool(detector.created or detector.updated)


# ── Writing ──────────────────────────────────────────────────────────────────


class Detector:
    """
    Detects and records, with per-request caches (rules per till, names, areas). The
    caller commits.
    """

    def __init__(self, db: Session):
        self.db = db
        self._rules: Dict[uuid.UUID, Dict[str, EffectiveRule]] = {}
        self._machines: Dict[uuid.UUID, Optional[POSMachine]] = {}
        self._companies: Dict[Any, Optional[uuid.UUID]] = {}
        self._names: Dict[str, Optional[str]] = {}
        self._shift_areas: Dict[uuid.UUID, Optional[uuid.UUID]] = {}
        self._tz: Dict[Any, Any] = {}
        self.created = 0
        self.updated = 0

    # caches
    def machine(self, machine_id) -> Optional[POSMachine]:
        key = _uuid(machine_id)
        if key not in self._machines:
            self._machines[key] = self.db.get(POSMachine, key) if key else None
        return self._machines[key]

    def rules(self, machine: POSMachine) -> Dict[str, EffectiveRule]:
        if machine.id not in self._rules:
            self._rules[machine.id] = rules_for_machine(self.db, machine)
        return self._rules[machine.id]

    def company(self, shop_id) -> Optional[uuid.UUID]:
        if shop_id not in self._companies:
            self._companies[shop_id] = company_of_shop(self.db, shop_id)
        return self._companies[shop_id]

    def tz(self, tenant_id):
        if tenant_id not in self._tz:
            from app.services.reports import _load_zoneinfo, resolve_report_timezone

            try:
                self._tz[tenant_id] = _load_zoneinfo(resolve_report_timezone(self.db, tenant_id, None))
            except Exception:  # noqa: BLE001 - an unknown zone only switches after-hours off
                self._tz[tenant_id] = None
        return self._tz[tenant_id]

    def name(self, pos_user_id: Optional[str]) -> Optional[str]:
        if not pos_user_id:
            return None
        if pos_user_id not in self._names:
            ident = _uuid(pos_user_id)
            pu = self.db.get(PosUser, ident) if ident else None
            if pu is None:
                # A self-order kiosk's own operator reads as the kiosk's name.
                from app.services import kiosk_identity

                self._names[pos_user_id] = kiosk_identity.name_of(self.db, pos_user_id)
            else:
                full = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
                self._names[pos_user_id] = full or pu.username
        return self._names[pos_user_id]

    def approver_name(self, ident: Optional[str]) -> Optional[str]:
        """A till user's name, else a cloud account's (an approver may be either)."""
        name = self.name(ident)
        if name or not ident:
            return name
        from app.models.user import User

        key = _uuid(ident)
        user = self.db.get(User, key) if key else None
        return (user.username or user.email) if user is not None else None

    def shift_area(self, shift_id) -> Optional[uuid.UUID]:
        key = _uuid(shift_id)
        if key is None:
            return None
        if key not in self._shift_areas:
            row = self.db.query(Shift.area_id).filter(Shift.id == key).first()
            self._shift_areas[key] = row[0] if row else None
        return self._shift_areas[key]

    # writing
    def _record(self, machine: POSMachine, found: Found, *, area_id=None) -> None:
        spec = RULES_BY_TYPE[found.type]
        existing = self.db.query(AuditException).filter(AuditException.dedupe_key == found.key).first()
        values = dict(
            amount=found.amount,
            value=found.value,
            threshold=found.threshold,
            details=found.details or None,
            pos_user_id=(found.pos_user_id or None) and str(found.pos_user_id)[:100],
            pos_user_name=self.name(found.pos_user_id),
            transaction_id=found.transaction_id,
            shift_id=found.shift_id,
            occurred_at=found.occurred_at,
        )
        if existing is not None:
            # A reviewed or dismissed exception is the manager's; never reopened or rewritten.
            if existing.status == "new":
                for key, value in values.items():
                    setattr(existing, key, value)
                self.updated += 1
            return
        row = AuditException(
            id=uuid.uuid4(),
            tenant_id=machine.tenant_id,
            company_id=self.company(machine.shop_id),
            shop_id=machine.shop_id,
            area_id=area_id if area_id is not None else (self.shift_area(found.shift_id) or machine.area_id),
            machine_id=machine.id,
            till_event_id=found.till_event_id,
            exception_type=found.type,
            severity=found.severity or spec.severity,
            dedupe_key=found.key,
            status="new",
            detected_at=datetime.now(timezone.utc),
            **values,
        )
        try:
            with self.db.begin_nested():
                self.db.add(row)
                self.db.flush()
        except IntegrityError:
            # A concurrent detection wrote the same key first: it is there, which is all
            # idempotency asks.
            return
        self.created += 1

    def transaction(self, tx: Transaction) -> None:
        machine = self.machine(tx.machine_id)
        if machine is None:
            return
        for found in detect_transaction(tx, self.rules(machine), self.tz(tx.tenant_id)):
            if found.type == "oth" and found.details.get("approvedBy"):
                found.details["approverName"] = self.approver_name(found.details["approvedBy"])
            self._record(machine, found)

    def shift(self, shift: Shift) -> None:
        machine = self.machine(shift.machine_id)
        if machine is None:
            return
        for found in detect_shift(shift, self.rules(machine)):
            self._record(machine, found, area_id=shift.area_id)

    def event(self, event: TillEvent) -> None:
        machine = self.machine(event.machine_id)
        if machine is None:
            return
        for found in detect_event(event, self.rules(machine)):
            if found.type == "long_order" and found.transaction_id is None:
                found.transaction_id = _nearest_document(self.db, event)
            if found.type == "forced_z_close":
                # Who forced it is the cloud's to say, from the request the till answered.
                found.details.update(forced_close_initiator(self.db, machine, found.details.get("requestId")))
                found.details["summary"] = forced_close_summary(found.details)
            self._record(machine, found, area_id=event.area_id)


def forced_close_summary(details: Dict[str, Any]) -> str:
    """"כפה: דנה · הושהתה: <שם> (3 שורות)" — the line the exceptions list shows."""
    parts = [f"כפה: {details.get('forcedBy') or 'לא ידוע'}"]
    parked = details.get("parked") if isinstance(details.get("parked"), dict) else None
    if parked and parked.get("heldSaleId"):
        parts.append(f"הושהתה: {parked.get('name') or ''} ({parked.get('lines') or 0} שורות)".strip())
    elif parked and parked.get("notParkedReason"):
        parts.append(f"לא הושהתה ({parked.get('notParkedReason')})")
    else:
        parts.append("לא הייתה הזמנה פתוחה")
    return " · ".join(parts)


def forced_close_initiator(db: Session, machine: POSMachine, request_id: Any) -> Dict[str, Any]:
    """
    `{forcedBy, forcedByUserId, requestKind}` for a forced remote Z close, from the request
    the till names: a dashboard till-Z request, or a Z run's item. Empty when neither is
    this till's.
    """
    from app.models.till_z_request import TillZRequest
    from app.models.user import User
    from app.models.z_run import ZRun, ZRunItem

    key = _uuid(request_id)
    if key is None:
        return {}
    req = db.query(TillZRequest).filter(TillZRequest.id == key, TillZRequest.machine_id == machine.id).first()
    if req is not None:
        return {
            "requestKind": "till_z",
            "forcedBy": req.initiated_by,
            "forcedByUserId": str(req.created_by_user_id) if req.created_by_user_id else None,
        }
    item = db.query(ZRunItem).filter(ZRunItem.id == key, ZRunItem.machine_id == machine.id).first()
    if item is not None:
        run = db.get(ZRun, item.run_id)
        user = db.get(User, run.created_by_user_id) if run is not None and run.created_by_user_id else None
        return {
            "requestKind": "z_run",
            "zRunId": str(item.run_id),
            "forcedBy": (user.username or user.email) if user is not None else None,
            "forcedByUserId": str(user.id) if user is not None else None,
        }
    return {}


def _nearest_document(db: Session, event: TillEvent) -> Optional[uuid.UUID]:
    """The document a completed basket most likely became: same till, within 3 minutes."""
    from datetime import timedelta

    moment = _parse_time((event.details or {}).get("completedAt")) or _utc(event.occurred_at)
    if moment is None:
        return None
    rows = (
        db.query(Transaction.id, Transaction.created_at)
        .filter(
            Transaction.machine_id == event.machine_id,
            Transaction.created_at >= moment - timedelta(minutes=3),
            Transaction.created_at <= moment + timedelta(minutes=3),
        )
        .all()
    )
    if not rows:
        return None
    return min(rows, key=lambda r: abs((_utc(r[1]) - moment).total_seconds()))[0]


def detect_transactions(db: Session, transaction_ids: Sequence[Any]) -> Detector:
    detector = Detector(db)
    ids = [i for i in (_uuid(x) for x in transaction_ids) if i is not None]
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        rows = (
            db.query(Transaction)
            .options(selectinload(Transaction.items), selectinload(Transaction.payments))
            .filter(Transaction.id.in_(chunk))
            .all()
        )
        for tx in rows:
            detector.transaction(tx)
    return detector


def detect_shift_close(db: Session, shift_id: Any) -> Detector:
    detector = Detector(db)
    shift = db.get(Shift, _uuid(shift_id))
    if shift is not None:
        detector.shift(shift)
    return detector


def detect_safely(db: Session, fn: Callable[..., Any], *args: Any) -> None:
    """Run a detection after the sync request committed; never let it fail the request."""
    try:
        fn(db, *args)
        db.commit()
    except Exception:  # noqa: BLE001 - see the module docstring
        try:
            db.rollback()
        except Exception:  # noqa: BLE001 - a session that cannot roll back has nothing to undo
            pass
        logger.exception("exception detection failed (%s)", getattr(fn, "__name__", fn))


# ── Till events ──────────────────────────────────────────────────────────────


def record_till_event(db: Session, machine: POSMachine, body) -> Tuple[TillEvent, bool]:
    """Store one till event (idempotent by id) and detect on it. The caller commits."""
    existing = db.get(TillEvent, body.id)
    if existing is not None:
        return existing, False
    event = TillEvent(
        id=body.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        area_id=machine.area_id,
        shift_id=body.shift_id,
        event_type=body.type,
        occurred_at=_utc(body.occurred_at),
        pos_user_id=body.pos_user_id,
        amount=body.amount,
        transaction_id=body.transaction_id,
        details=body.details or None,
        received_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.flush()
    return event, True


# ── Rescan ───────────────────────────────────────────────────────────────────

RESCAN_MAX_DOCUMENTS = 50_000


def rescan(
    db: Session,
    *,
    transactions_query,
    shifts_query,
    events_query,
) -> Detector:
    """Detect over history: the documents, closed shifts and till events given (already scoped)."""
    detector = Detector(db)
    rows = (
        transactions_query.options(selectinload(Transaction.items), selectinload(Transaction.payments))
        .limit(RESCAN_MAX_DOCUMENTS)
        .all()
    )
    for tx in rows:
        detector.transaction(tx)
    for shift in shifts_query.all():
        detector.shift(shift)
    for event in events_query.all():
        detector.event(event)
    return detector


# ── Scope labels ─────────────────────────────────────────────────────────────


def labels_for(db: Session, rows: Sequence[AuditException]) -> Dict[str, Dict[Any, Any]]:
    """Names of the shops, areas, tills and document numbers the rows point at."""
    shop_ids = {r.shop_id for r in rows if r.shop_id}
    area_ids = {r.area_id for r in rows if r.area_id}
    machine_ids = {r.machine_id for r in rows if r.machine_id}
    tx_ids = {r.transaction_id for r in rows if r.transaction_id}
    shift_ids = {r.shift_id for r in rows if r.shift_id}
    from app.models.user import User

    reviewer_ids = {r.reviewed_by_user_id for r in rows if r.reviewed_by_user_id}
    return {
        "shops": {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(shop_ids))} if shop_ids else {},
        "areas": {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.id.in_(area_ids))} if area_ids else {},
        "machines": {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids))} if machine_ids else {},
        # As printed, `20000057` (docs/SPEC_DOCUMENT_PREFIX.md).
        "documents": {
            t.id: document_number_from(t.transaction_number, t.document_prefix, t.pos_number)
            for t in db.query(
                Transaction.id, Transaction.transaction_number, Transaction.document_prefix, Transaction.pos_number
            ).filter(Transaction.id.in_(tx_ids))
        } if tx_ids else {},
        # A number names a document only with its type (one series per type).
        "documentTypes": {
            t.id: t.document_type
            for t in db.query(Transaction.id, Transaction.document_type).filter(Transaction.id.in_(tx_ids))
        } if tx_ids else {},
        "shifts": {
            s.id: s.sequence_number
            for s in db.query(Shift.id, Shift.sequence_number).filter(Shift.id.in_(shift_ids))
        } if shift_ids else {},
        "reviewers": {
            u.id: (u.username or u.email)
            for u in db.query(User).filter(User.id.in_(reviewer_ids))
        } if reviewer_ids else {},
    }
