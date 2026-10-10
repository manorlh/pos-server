"""
"זיכוי באשראי מהענן — חובה לפני ה-Z הבא" (docs/SPEC_REMOTE_CREDIT.md §11.8–§11.11).

The owner (09.10.2026): "אם יש Z-Credit, לאפשר זיכוי דרך הענן ושייכנס אוטומטית למשמרת הפתוחה או
למשמרת הבאה — אבל חובה שייכנס ל-Z הבא".

**Three till parameters**, resolved like every till parameter (company → shop → area → till, the
most specific winning — `till_parameters_for_machine`), so a business decides per layer:

* `cloudCardRefundsEnabled` (off): the dashboard offers "זיכוי באשראי (Z-Credit)" for sales of the
  tills under that layer — read for the sale's till. The env switch `ZCREDIT_CLOUD_REFUNDS_ENABLED`
  stays the global kill switch: both must be on.
* `cloudCardRefundLanding` — `open_shift_only` (default, as before: a till with an open shift, or
  no refund at all) or `open_or_next_shift`: the open shift if the till has one, else the refund
  goes ahead and the till holds the credit note for its next shift, issuing it automatically as
  that shift's FIRST document, before any sale. Read for the target till (it reaches the till
  through the parameter sync, so the till knows whether to hold or to fail a request).
* `cloudCardRefundBlocksNextZ` (on): the Z gate below. Off: no gate — the note lands in whatever
  Z its shift falls in, and the dashboard warns on the refund. Read for the target till.

**The gate.** No Z is produced while a cloud card refund that is `refunded` and whose credit note
has not reached the cloud targets a till inside that Z — a till's own Z (machine), an area Z
(the area's tills in the shop Z), a shop Z (the shop's tills in the shop Z) — whatever produces
it: the cloud's Z run (its start and its build), a till's Z (`POST /sync/{m}/till-z`), the
dashboard's / remote control's request for a till's Z, support's Z, and the main till's local
shop Z (it asks first, `GET /sync/{m}/shop-z/cloud-refund-guard`). A till whose open shift the Z
itself closes is not a blocker at the start: the till issues its pending notes into the closing
shift before it closes (pos-android, ShiftRepository.close) — and the build checks again.

**The force** — the pattern of "חסימת Z כשיש משמרות פתוחות" (app/services/z_shift_guard.py): only a
super admin, only with a typed reason, recorded as an exception (`z_forced_pending_cloud_refund`)
and on the refund's audit trail. It releases the refund from ONE Z: the next Z in its till's
scope goes ahead without it (and uses the release up), and the refund goes into the Z after —
which the gate holds again until the note lands or another release.

Z numbering is never touched here: a Z the gate holds is simply not built yet (no number drawn).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

KEY_ENABLED = "cloudCardRefundsEnabled"
KEY_LANDING = "cloudCardRefundLanding"
KEY_BLOCKS_Z = "cloudCardRefundBlocksNextZ"
LANDING_OPEN_ONLY = "open_shift_only"
LANDING_NEXT_SHIFT = "open_or_next_shift"
LANDINGS = (LANDING_OPEN_ONLY, LANDING_NEXT_SHIFT)

#: What a till's heartbeat says when its build holds a `card_refunded` request for its next shift,
#: issues it first thing in that shift and before every close (pos-android). Only such a till is
#: ever sent a refund's note while it has no open shift.
NEXT_SHIFT_CAPABILITY = "card_refund_next_shift"
#: The till's `waiting` ack while it holds the request for its next shift.
WAITING_CODE = "waiting_next_shift"
WAITING_WORDS = "ממתין למשמרת הבאה"

ENABLED_LABEL = "זיכוי באשראי מהענן (Z-Credit) — הפעלה"
LANDING_LABEL = "זיכוי באשראי מהענן — לאיזו משמרת נכנס מסמך הזיכוי"
BLOCKS_Z_LABEL = "זיכוי באשראי מהענן — חובה לפני ה-Z הבא"

#: Registered with the till parameters (app/services/till_parameters.py).
PARAMETER_SPECS = (
    dict(
        key=KEY_ENABLED,
        label=ENABLED_LABEL,
        value_type="boolean",
        default_value=False,
        description=(
            "מופעל: בעסקאות של הקופות בשכבה הזו הדשבורד מציע \"זיכוי באשראי (Z-Credit)\" — הענן מזכה את "
            "הכרטיס דרך Z-Credit וקופה מפיקה את מסמך הזיכוי. כבוי (ברירת מחדל): האפשרות לא מוצעת. "
            "פועל רק כשגם המתג הכללי בשרת (ZCREDIT_CLOUD_REFUNDS_ENABLED) מופעל. נקבע לפי הקופה שהפיקה את "
            "המכירה; ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=KEY_LANDING,
        label=LANDING_LABEL,
        value_type="enum",
        enum_options=LANDINGS,
        default_value=LANDING_OPEN_ONLY,
        description=(
            "open_shift_only (ברירת מחדל) — מסמך הזיכוי מופק רק בקופה עם משמרת פתוחה; בלי קופה כשירה עם "
            "משמרת פתוחה — לא מזכים את הכרטיס. open_or_next_shift — למשמרת הפתוחה אם יש; אם אין, הכרטיס "
            "מזוכה מיד ומסמך הזיכוי ממתין בקופה (\"ממתין למשמרת הבאה\") ומופק אוטומטית, בלי פעולת קופאי, "
            "כמסמך הראשון במשמרת הבאה שלה — לפני כל מכירה. נקבע לפי קופת היעד; ניתן לקבוע לפי חברה, סניף, "
            "נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=KEY_BLOCKS_Z,
        label=BLOCKS_Z_LABEL,
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): כל עוד מסמך הזיכוי של זיכוי באשראי מהענן לא הופק — לא מפיקים את ה-Z שהוא "
            "אמור להיכנס אליו (Z של הקופה, של נקודת המכירה או ה-Z הסניפי, מהענן, מהקופה או מהקופה הראשית). "
            "רק סופר אדמין (תמיכה) יכול לכפות הפקה, עם סיבה; אז הזיכוי ייכנס ל-Z שאחריו. כבוי: אין חסימה — "
            "המסמך נכנס ל-Z של המשמרת שבה הופק, והדשבורד מזהיר על כך. בכל מקרה, לפני סגירת משמרת או Z הקופה "
            "מפיקה קודם את הזיכויים הממתינים לה. נקבע לפי קופת היעד; ניתן לקבוע לפי חברה, סניף, נקודת מכירה "
            "או קופה."
        ),
    ),
)

REFUSED_CODE = "pending_cloud_card_refund"
EXCEPTION_TYPE = "z_forced_pending_cloud_refund"
EXCEPTION_LABEL = "Z הופק בכפייה לפני שזיכוי אשראי מהענן הופק"
MIN_REASON = 5

#: The refund's audit trail: released from one Z by a super admin, and that release used by a Z.
RELEASED = "z_gate_released"
RELEASE_USED = "z_gate_release_used"


# ── Parameters ────────────────────────────────────────────────────────────────


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "כן")


def _param(db: Session, machine: Optional[POSMachine], key: str, default: Any, *, shop: Any = None) -> Any:
    """The till's resolved value (company → shop → area → till), the shop's when there is no till."""
    from app.services.till_parameters import resolve_for_shop, till_parameters_for_machine

    try:
        if machine is not None:
            value = till_parameters_for_machine(db, machine).parameters.get(key)
        elif shop is not None:
            value = resolve_for_shop(db, shop).get(key)
        else:
            value = None
    except Exception:  # noqa: BLE001 - a parameter read never breaks a refund or a Z; logged
        logger.exception("till parameter %s unreadable for machine %s", key, getattr(machine, "id", None))
        value = None
    return default if value is None else value


def refunds_on_for(db: Session, machine: Optional[POSMachine], *, shop: Any = None) -> bool:
    """`cloudCardRefundsEnabled` for the sale's till (its shop's when the till is gone)."""
    return _truthy(_param(db, machine, KEY_ENABLED, False, shop=shop))


def landing_of(db: Session, machine: Optional[POSMachine]) -> str:
    raw = _param(db, machine, KEY_LANDING, LANDING_OPEN_ONLY)
    return raw if raw in LANDINGS else LANDING_OPEN_ONLY


def blocks_next_z(db: Session, machine: Optional[POSMachine]) -> bool:
    """`cloudCardRefundBlocksNextZ` for the target till (on when it cannot be read: fail closed)."""
    if machine is None:
        return True
    return _truthy(_param(db, machine, KEY_BLOCKS_Z, True))


def holds_next_shift(machine: Optional[POSMachine]) -> bool:
    """The till's build holds a refund's note for its next shift and issues it before any close."""
    caps = getattr(machine, "capabilities", None) or []
    return NEXT_SHIFT_CAPABILITY in caps


def enabled() -> bool:
    from app.services import cloud_card_refunds

    return cloud_card_refunds.enabled()


# ── Words ─────────────────────────────────────────────────────────────────────


def _money(value: Any) -> str:
    return str(Decimal(str(value or 0)).quantize(Decimal("0.01")))


def till_name(machine: Optional[POSMachine]) -> str:
    if machine is None:
        return "?"
    return machine.name or (f"קופה {machine.pos_number}" if machine.pos_number else str(machine.id)[:8])


def pending_words(amount: Any) -> str:
    """The line on every close / Z screen: "זיכוי אשראי מהענן ממתין להפקה (₪X)"."""
    return f"זיכוי אשראי מהענן ממתין להפקה (₪{_money(amount)})"


def blocker_message(amount: Any, document_number: Optional[str], till: str) -> str:
    return (
        f"זיכוי אשראי מהענן ₪{_money(amount)} (מסמך מקור {document_number or '—'}) ממתין להפקה בקופה {till} — "
        f"פתחו משמרת בקופה {till} או שלחו את הזיכוי לקופה אחרת"
    )


def landing_words(landing: str, till: str, *, blocks: bool) -> str:
    """Where a refund's credit note lands, as the refund dialog says it."""
    if landing == "open_shift":
        return f"ייכנס למשמרת הפתוחה בקופה {till}"
    if blocks:
        return f"ייכנס למשמרת הבאה בקופה {till} — חובה לפני ה-Z הבא"
    return f"ייכנס למשמרת הבאה בקופה {till}"


def waiting_words(till: str) -> str:
    return f"{WAITING_WORDS} בקופה {till}"


def not_blocking_warning(till: str) -> str:
    return (
        f"הזיכוי לא חוסם Z בקופה {till} (הפרמטר \"{BLOCKS_Z_LABEL}\" כבוי): מסמך הזיכוי ייכנס ל-Z של המשמרת "
        "שבה יופק."
    )


# ── Which refunds are waiting ─────────────────────────────────────────────────


def _request_ids(db: Session, row: Any) -> List[uuid.UUID]:
    from app.models.remote_credit import RemoteCreditRequest

    ids = [r[0] for r in db.query(RemoteCreditRequest.id).filter(RemoteCreditRequest.card_refund_id == row.id).all()]
    if row.remote_credit_request_id is not None and row.remote_credit_request_id not in ids:
        ids.append(row.remote_credit_request_id)
    return ids


def landed(db: Session, row: Any) -> bool:
    """Its credit note is in the cloud: linked to the refund, or any note naming one of its requests."""
    from app.models.transaction import Transaction, TransactionStatus
    from app.services.cloud_card_refunds import _landed

    if _landed(db, row):
        return True
    ids = _request_ids(db, row)
    if not ids:
        return False
    return (
        db.query(Transaction.id)
        .filter(Transaction.remote_credit_request_id.in_(ids), Transaction.status != TransactionStatus.CANCELLED)
        .first()
        is not None
    )


def unlanded(db: Session, machine_ids: Iterable[Any]) -> List[Any]:
    """The `refunded` cloud card refunds targeting these tills whose credit note has not landed."""
    from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundStatus as CS

    ids = [i if isinstance(i, uuid.UUID) else uuid.UUID(str(i)) for i in machine_ids if i is not None]
    if not ids:
        return []
    rows = (
        db.query(CloudCardRefund)
        .filter(
            CloudCardRefund.status == CS.REFUNDED,
            CloudCardRefund.credit_transaction_id.is_(None),
            CloudCardRefund.target_machine_id.in_(ids),
        )
        .order_by(CloudCardRefund.refunded_at.asc(), CloudCardRefund.created_at.asc())
        .all()
    )
    return [r for r in rows if not landed(db, r)]


def released(db: Session, row: Any) -> bool:
    """
    A super admin released it from the next Z, and no Z has used that release yet: every release
    is used by exactly one Z, so more releases than uses (never a clock's order — two events of
    one transaction share a moment).
    """
    from sqlalchemy import func

    from app.models.cloud_card_refund import CloudCardRefundEvent

    counts = dict(
        db.query(CloudCardRefundEvent.action, func.count(CloudCardRefundEvent.id))
        .filter(CloudCardRefundEvent.refund_id == row.id, CloudCardRefundEvent.action.in_((RELEASED, RELEASE_USED)))
        .group_by(CloudCardRefundEvent.action)
        .all()
    )
    return counts.get(RELEASED, 0) > counts.get(RELEASE_USED, 0)


def blocker_out(db: Session, row: Any, machine: Optional[POSMachine], *, lands_now: bool = False) -> Dict[str, Any]:
    till = till_name(machine)
    return {
        "refundId": str(row.id),
        "transactionId": str(row.original_transaction_id),
        "amount": _money(row.amount),
        "originalDocumentNumber": row.original_document_number,
        "machineId": str(row.target_machine_id),
        "machineName": machine.name if machine is not None else None,
        "posNumber": machine.pos_number if machine is not None else None,
        "cardLast4": row.card_last4,
        "refundedAt": row.refunded_at.isoformat() if row.refunded_at else None,
        #: The till's open shift is closed by this Z: the till issues the note into it first.
        "landsInThisZ": bool(lands_now),
        "words": pending_words(row.amount),
        "message": blocker_message(row.amount, row.original_document_number, till),
    }


def pending(db: Session, machine_ids: Iterable[Any], *, closing: Iterable[Any] = ()) -> List[Dict[str, Any]]:
    """
    Every unlanded refund of these tills the gate would look at (its till's
    `cloudCardRefundBlocksNextZ` on, not released) — with `landsInThisZ` for the tills whose open
    shift this Z closes (`closing`): shown, not blocking. Empty with the switch off.
    """
    if not enabled():
        return []
    closing_ids = {str(i) for i in closing}
    rows = unlanded(db, machine_ids)
    if not rows:
        return []
    machines = {
        m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_([r.target_machine_id for r in rows])).all()
    }
    out = []
    for row in rows:
        machine = machines.get(row.target_machine_id)
        if not blocks_next_z(db, machine) or released(db, row):
            continue
        out.append(blocker_out(db, row, machine, lands_now=str(row.target_machine_id) in closing_ids))
    return out


def blockers(db: Session, machine_ids: Iterable[Any], *, closing: Iterable[Any] = ()) -> List[Dict[str, Any]]:
    """The refunds that hold a Z of these tills now (those landing in its closing shifts are not)."""
    return [b for b in pending(db, machine_ids, closing=closing) if not b["landsInThisZ"]]


def notes_left_behind(db: Session, machine: POSMachine, taken_shift_ids: Iterable[Any]) -> List[Dict[str, Any]]:
    """
    Credit notes of cloud card refunds this till already issued in a shift no Z took yet that THIS
    Z does not take (the operator stopped at an earlier shift, or left the open one out): the Z
    would go without them, so it is held as for a note not issued yet.
    """
    from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundStatus as CS
    from app.models.shift import Shift
    from app.models.transaction import Transaction

    if not enabled():
        return []
    taken = {str(i) for i in taken_shift_ids}
    rows = (
        db.query(CloudCardRefund, Transaction)
        .join(Transaction, Transaction.id == CloudCardRefund.credit_transaction_id)
        .join(Shift, Shift.id == Transaction.shift_id)
        .filter(
            CloudCardRefund.status == CS.REFUNDED,
            Transaction.machine_id == machine.id,
            Shift.z_report_id.is_(None),
        )
        .all()
    )
    out = []
    for row, note in rows:
        if str(note.shift_id) in taken:
            continue
        if not blocks_next_z(db, machine) or released(db, row):
            continue
        item = blocker_out(db, row, machine)
        item["message"] = (
            f"מסמך הזיכוי של זיכוי אשראי מהענן ₪{_money(row.amount)} (מסמך מקור {row.original_document_number or '—'}) "
            f"הופק בקופה {till_name(machine)} במשמרת שה-Z הזה לא כולל — כללו את המשמרת ב-Z"
        )
        out.append(item)
    return out


def not_blocking(db: Session, machine_ids: Iterable[Any]) -> List[Dict[str, Any]]:
    """Unlanded refunds of these tills that do NOT hold their Z (the parameter is off): a warning."""
    if not enabled():
        return []
    rows = unlanded(db, machine_ids)
    out = []
    for row in rows:
        machine = db.get(POSMachine, row.target_machine_id)
        if not blocks_next_z(db, machine):
            item = blocker_out(db, row, machine)
            item["warning"] = not_blocking_warning(till_name(machine))
            out.append(item)
    return out


def message_of(found: Sequence[Dict[str, Any]]) -> str:
    return "; ".join(b["message"] for b in found)


def refusal(found: Sequence[Dict[str, Any]], *, user: Any = None, can_force: Optional[bool] = None) -> HTTPException:
    """409 `pending_cloud_card_refund` — the refunds, the message, and whether this user may force."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=refusal_body(found, user=user, can_force=can_force))


def refusal_body(found: Sequence[Dict[str, Any]], *, user: Any = None, can_force: Optional[bool] = None) -> Dict[str, Any]:
    return {
        "code": REFUSED_CODE,
        "message": message_of(found),
        "refunds": list(found),
        "canForce": _is_super_admin(user) if can_force is None else bool(can_force),
    }


# ── Scope ─────────────────────────────────────────────────────────────────────


def shop_scope(db: Session, shop: Any, area_id: Any = None) -> List[POSMachine]:
    """The tills a shop Z (an area's, with `area_id`) takes: the shop's, never its own-Z tills."""
    from app.services import z_runs as ZR

    tills = ZR.shop_tills(db, shop.id)
    own = ZR.per_till_ids(db, tills)
    return [
        m for m in tills
        if m.id not in own and (area_id is None or (str(m.area_id) == str(area_id) and ZR.is_seated_in(m, shop.id)))
    ]


def run_scope_ids(db: Session, run: Any) -> List[uuid.UUID]:
    from app.models.shop import Shop

    shop = db.get(Shop, run.shop_id)
    ids = {m.id for m in shop_scope(db, shop, run.area_id)} if shop is not None else set()
    ids |= {i.machine_id for i in run.items}
    return list(ids)


def closes_open_shift(db: Session, machine: POSMachine) -> bool:
    """The till has an open shift (the cloud's, or as it reports it) and issues its notes before closing it."""
    from app.services.remote_credits import open_shift_of

    return holds_next_shift(machine) and open_shift_of(db, machine) is not None


# ── The force ─────────────────────────────────────────────────────────────────


def _is_super_admin(user: Any) -> bool:
    from app.models.user import UserRole

    return getattr(user, "role", None) == UserRole.SUPER_ADMIN


def check_force(user: Any, reason: Optional[str]) -> str:
    """Only a super admin, and only with a typed reason (403 / 422)."""
    if not _is_super_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "force_super_admin_only",
            "message": "רק סופר אדמין (תמיכה) יכול לכפות הפקת Z לפני שזיכוי אשראי מהענן הופק",
        })
    text = " ".join((reason or "").split())
    if len(text) < MIN_REASON:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "code": "force_reason_required",
            "message": "יש להקליד את סיבת הכפייה",
        })
    return text[:300]


def _who(user: Any) -> str:
    return getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))


def release(db: Session, row: Any, user: Any, reason: Optional[str], *, where: Optional[str] = None,
            now: Optional[datetime] = None) -> bool:
    """
    A super admin lets the next Z of the refund's till go without its credit note (typed reason;
    audited on the refund and as an exception). False when it was released already.
    """
    from app.models.cloud_card_refund import CloudCardRefundEvent
    from app.services.exceptions import Detector, Found

    text = check_force(user, reason)
    if released(db, row):
        return False
    now = now or datetime.now(timezone.utc)
    who = _who(user)
    event = CloudCardRefundEvent(
        id=uuid.uuid4(), refund_id=row.id, tenant_id=row.tenant_id, at=now, actor="user",
        user_id=getattr(user, "id", None), action=RELEASED, detail=text,
        data={"forcedBy": who, "where": where, "machineId": str(row.target_machine_id)},
    )
    db.add(event)
    db.flush()
    machine = db.get(POSMachine, row.target_machine_id)
    if machine is not None:
        Detector(db)._record(machine, Found(
            type=EXCEPTION_TYPE,
            key=f"{EXCEPTION_TYPE}:{row.id}:{event.id}",
            occurred_at=now,
            amount=Decimal(str(row.amount)),
            transaction_id=row.original_transaction_id,
            details={
                "kind": "released_from_next_z",
                "refundId": str(row.id),
                "machineId": str(row.target_machine_id),
                "originalDocumentNumber": row.original_document_number,
                "amount": _money(row.amount),
                "reason": text,
                "forcedBy": who,
                "where": where,
                "summary": (
                    f"Z הופק בכפייה ע״י {who} לפני שזיכוי אשראי מהענן ₪{_money(row.amount)} (מסמך מקור "
                    f"{row.original_document_number or '—'}) הופק בקופה {till_name(machine)} — הזיכוי ייכנס ל-Z הבא: {text}"
                ),
            },
        ))
    logger.warning("cloud card refund %s released from the next Z by %s: %s", row.id, who, text)
    return True


def release_all(db: Session, refund_ids: Iterable[Any], user: Any, reason: Optional[str], *, where: str,
                now: Optional[datetime] = None) -> int:
    from app.models.cloud_card_refund import CloudCardRefund

    check_force(user, reason)
    count = 0
    for rid in refund_ids:
        row = db.get(CloudCardRefund, rid if isinstance(rid, uuid.UUID) else uuid.UUID(str(rid)))
        if row is not None and release(db, row, user, reason, where=where, now=now):
            count += 1
    return count


def consume(db: Session, machine_ids: Iterable[Any], z_report_id: Any, *, path: str,
            now: Optional[datetime] = None) -> int:
    """A Z of these tills was produced: every release it went ahead on is used up."""
    from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundEvent, CloudCardRefundStatus as CS

    if not enabled():
        return 0
    ids = [i if isinstance(i, uuid.UUID) else uuid.UUID(str(i)) for i in machine_ids if i is not None]
    if not ids:
        return 0
    now = now or datetime.now(timezone.utc)
    count = 0
    ever_released = db.query(CloudCardRefundEvent.refund_id).filter(CloudCardRefundEvent.action == RELEASED)
    rows = (
        db.query(CloudCardRefund)
        .filter(
            CloudCardRefund.status == CS.REFUNDED,
            CloudCardRefund.target_machine_id.in_(ids),
            CloudCardRefund.id.in_(ever_released),
        )
        .all()
    )
    for row in rows:
        if not released(db, row):
            continue
        db.add(CloudCardRefundEvent(
            id=uuid.uuid4(), refund_id=row.id, tenant_id=row.tenant_id, at=now, actor="system",
            action=RELEASE_USED, detail=path,
            data={"zReportId": str(z_report_id) if z_report_id else None, "path": path},
        ))
        count += 1
    if count:
        db.flush()
    return count


def retry_runs_of(db: Session, machine_ids: Iterable[Any], *, now: Optional[datetime] = None) -> int:
    """A refund was released: the cloud Z runs of its till's shop that waited for it, built now."""
    from app.models.z_run import ZRun, ZRunStatus
    from app.services import z_runs as ZR

    ids = [i for i in machine_ids if i is not None]
    if not ids:
        return 0
    machines = db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()
    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    runs = (
        db.query(ZRun).filter(ZRun.shop_id.in_(list(shop_ids)), ZRun.status == ZRunStatus.WAITING).all()
        if shop_ids else []
    )
    built = 0
    for run in runs:
        try:
            if ZR.finalise_if_ready(db, run, now=now):
                built += 1
        except Exception:  # noqa: BLE001 - never breaks the caller (a document upload, a release)
            logger.exception("Z run %s: retry after a cloud refund's note failed", run.id)
    return built
