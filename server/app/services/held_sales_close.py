"""
"מכירות מושהות" at a shift close or Z — the owner: "לגבי מכירה מושהית בסגירת זד או משמרת — תתריע,
ובלחיצה הצג מכירות מושהות, והעובד יחליט לבטל או לשלם אותם".

The till warns before every close (its own, its Z, the main till's local shop Z round, a remote
close or Z), lists the held sales, and the employee pays or cancels each one (cancelling needs the
basket-cancel permission and a reason, recorded as the till event `held_sale_cancelled`). The close
goes on only once none is left — or, where the shop allows it, keeping them:

* the till parameter `allowCloseWithHeldSales` (company → shop → area, default off);
* a remote close / Z / day close: the till defers with `held_sales` (its message: how many), the
  dashboard shows "ממתין — מכירות מושהות (N)", and a manager may "סגור בכל זאת — המכירות המושהות
  יישמרו" — only where the parameter is on, or a super admin with a typed reason; recorded
  (`close_keep_held_sales`). The till then hears `keepHeldSales` on that request and closes.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

KEY = "allowCloseWithHeldSales"
LABEL = "סגירה עם מכירות מושהות"
#: "בטל מכירות מושהות וסגור" from the dashboard — on unless the shop turns it off.
REMOTE_CANCEL_KEY = "remoteCancelHeldSales"
REMOTE_CANCEL_LABEL = "ביטול מכירות מושהות מהענן בסגירה מרחוק"
CANCEL_LABEL = "בטל מכירות מושהות וסגור"
#: The owner: "אין בעיה שתיסגר עם עגלה פתוחה — שינוי פרמטר, לאפשר או לא". On, a remote close parks a
#: basket being composed as a held sale (never a payment, a card in flight or a held tender; never at a
#: kiosk) and closes; that basket never holds the close it was parked for. Off (default): it waits.
PARK_KEY = "remoteCloseParkOpenBasket"
PARK_LABEL = "סגירה מרחוק גם עם עגלה פתוחה (העגלה נשמרת כמכירה מושהית)"
PARK_WORDS = "עגלה פתוחה — תישמר כמכירה מושהית"
DEFER_CODE = "held_sales"
EXCEPTION_TYPE = "close_keep_held_sales"
KEEP_LABEL = "סגור בכל זאת — המכירות המושהות יישמרו"

PARAMETER_SPECS = (
    dict(
        key=KEY,
        label=LABEL,
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בסגירת משמרת או Z עם מכירות מושהות, העובד רשאי לסגור ולהשאיר אותן מושהות (אחרי ההתראה "
            "והרשימה), ומהדשבורד אפשר \"סגור בכל זאת — המכירות המושהות יישמרו\". כשכבוי (ברירת המחדל): הסגירה "
            "ממשיכה רק אחרי שכל המכירות המושהות שולמו או בוטלו; מרחוק — רק סופר אדמין, עם סיבה. "
            "נקבע לחברה, לסניף או לנקודת מכירה."
        ),
    ),
    dict(
        key=REMOTE_CANCEL_KEY,
        label=REMOTE_CANCEL_LABEL,
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל): בסגירה מרחוק (משמרת, Z או סגירת יום סניפית) שקופה ממתינה בה בגלל מכירות "
            "מושהות, מנהל עם הרשאת Z יכול \"בטל מכירות מושהות וסגור\" — אחרי שראה את הרשימה שהקופה דיווחה, "
            "ועם סיבה. הקופה מבטלת רק את המכירות שברשימה שאושרה (חדשות — לא), רושמת כל ביטול, וסוגרת. "
            "כשכבוי: האפשרות לא מוצעת והקופה מתעלמת מפקודה כזו. נקבע לחברה, לסניף או לנקודת מכירה."
        ),
    ),
    dict(
        key=PARK_KEY,
        label=PARK_LABEL,
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: סגירה מרחוק (משמרת, Z או סגירת יום סניפית) לא ממתינה לעגלה שנבנית בקופה — הקופה שומרת "
            "אותה כמכירה מושהית (נרשם: מי ביקש, מתי, הפריטים והסכום), מציגה לקופאי \"העגלה נשמרה כמכירה "
            "מושהית — בוצעה סגירה מרחוק\" וממשיכה בסגירה. לעולם לא כשמסך התשלום פתוח, עסקת אשראי בדרך או "
            "אמצעי תשלום ממתין, ולעולם לא בקיוסק. העגלה שנשמרה כך לא עוצרת את הסגירה שבשבילה נשמרה. "
            "כשכבוי (ברירת המחדל): הקופה ממתינה למנוחה כמו היום. נקבע לחברה, לסניף או לנקודת מכירה."
        ),
    ),
)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "כן")


def allowed(db: Session, machine: POSMachine) -> bool:
    """`allowCloseWithHeldSales` at the till's area → its shop → its company → the default (off)."""
    return _param(db, machine, KEY, False)


def park_open_basket_on(db: Session, machine: POSMachine) -> bool:
    """`remoteCloseParkOpenBasket` at the till's area → its shop → its company → the default (off)."""
    return _param(db, machine, PARK_KEY, False)


def remote_cancel_on(db: Session, machine: POSMachine) -> bool:
    """`remoteCancelHeldSales` at the till's area → its shop → its company → the default (on)."""
    return _param(db, machine, REMOTE_CANCEL_KEY, True)


def _param(db: Session, machine: POSMachine, key: str, missing: bool) -> bool:
    """
    The till's own resolved value — till › area › shop › company › default, as every till parameter
    (till_parameters_for_machine: inactive and invalid values handled there). Not registered yet:
    `missing` (the parameter's default). Deactivated by a super admin: off.
    """
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import till_parameters_for_machine

    if db.query(TillParameter.id).filter(TillParameter.key == key).first() is None:
        return missing
    value = till_parameters_for_machine(db, machine).parameters.get(key)
    return False if value is None else _truthy(value)


def held_count(error_code: Optional[str], error_message: Optional[str]) -> Optional[int]:
    """How many held sales a `held_sales` deferral named (its message: the count), else None."""
    if error_code != DEFER_CODE:
        return None
    found = re.search(r"\d+", error_message or "")
    return int(found.group(0)) if found else None


def words(error_message: Optional[str]) -> str:
    n = held_count(DEFER_CODE, error_message)
    return f"ממתין — מכירות מושהות ({n})" if n is not None else "ממתין — מכירות מושהות"


def keep_offer(db: Session, machine: POSMachine, user: Any) -> Dict[str, Any]:
    """Whether this user may "סגור בכל זאת" for this till, and whether a reason is needed."""
    from app.models.user import UserRole

    if allowed(db, machine):
        return {"allowed": True, "needsReason": False}
    if getattr(user, "role", None) == UserRole.SUPER_ADMIN:
        return {"allowed": True, "needsReason": True}
    return {"allowed": False, "needsReason": False,
            "whyNot": f"בסניף לא מופעל \"{LABEL}\" — רק סופר אדמין (תמיכה) יכול, עם סיבה"}


def keep(db: Session, user: Any, machine: POSMachine, *, run_id: Optional[uuid.UUID] = None,
         reason: Optional[str] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    "סגור בכל זאת — המכירות המושהות יישמרו": the till's pending close (the run's item, or its own
    close / Z request) is marked `keep_held_sales` and told again (after the commit). Refused unless
    the parameter is on, or a super admin with a typed reason. Recorded. The caller commits.
    """
    from app.models.z_run import ZRun, ZRunItem, ZRunStatus
    from app.services import shift_close_requests as close_requests
    from app.services import till_z
    from app.services import z_runs as ZR

    now = now or datetime.now(timezone.utc)
    offer = keep_offer(db, machine, user)
    if not offer["allowed"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "keep_held_sales_not_allowed",
                                                                            "message": offer["whyNot"]})
    text = (reason or "").strip()
    if offer["needsReason"] and len(text) < 5:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "code": "keep_held_sales_reason_required", "message": "יש להקליד את הסיבה"})
    target = None
    if run_id is not None:
        target = (
            db.query(ZRunItem).join(ZRun, ZRun.id == ZRunItem.run_id)
            .filter(ZRunItem.run_id == run_id, ZRunItem.machine_id == machine.id,
                    ZRunItem.status.in_(ZR.PENDING_ITEM_STATUSES), ZRun.status == ZRunStatus.WAITING)
            .first()
        )
    else:
        target = close_requests._pending_query(db, machine.id).first() or till_z._pending_query(db, machine.id).first()
    if target is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": "nothing_pending", "message": "אין לקופה סגירה ממתינה"})
    target.keep_held_sales = True
    db.flush()
    _resend(machine, target, user, now)
    _record(db, machine, user, target, text, offer, now)
    return {"keptFor": str(target.id), "kind": type(target).__name__}


# ── The list the till reported, and "בטל מכירות מושהות וסגור" ───────────────────


def clean_list(raw: Any) -> list:
    """The till's held sales as reported: id, time, cashier, item count, total, item names."""
    out = []
    for sale in (raw if isinstance(raw, list) else [])[:100]:
        if not isinstance(sale, dict) or not sale.get("id"):
            continue
        items = sale.get("items") if isinstance(sale.get("items"), list) else []
        out.append({
            "id": str(sale["id"])[:64],
            "at": str(sale.get("at") or "")[:40] or None,
            "cashier": str(sale.get("cashier") or "")[:120] or None,
            "itemCount": sale.get("itemCount") if isinstance(sale.get("itemCount"), int) else len(items),
            "total": str(sale.get("total") or "")[:24] or None,
            "items": [str(i)[:80] for i in items[:30]],
        })
    return out


def _target_by_id(db: Session, machine: POSMachine, request_id: Any):
    from app.models.shift_close_request import ShiftCloseRequest
    from app.models.till_z_request import TillZRequest
    from app.models.z_run import ZRunItem

    for model in (ZRunItem, ShiftCloseRequest, TillZRequest):
        row = db.query(model).filter(model.id == request_id, model.machine_id == machine.id).first()
        if row is not None:
            return row
    return None


def note_reported(db: Session, machine: POSMachine, request_id: Any, raw: Any) -> None:
    """A `held_sales` deferral's list, kept on the request it answers (replaced on every deferral)."""
    target = _target_by_id(db, machine, request_id)
    if target is not None:
        target.held_sales = clean_list(raw)
        db.flush()


def cancel_offer(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """"בטל מכירות מושהות וסגור": the Z section's (the remote close's own permission), a typed reason."""
    if not remote_cancel_on(db, machine):
        return {"allowed": False, "needsReason": True,
                "whyNot": f"בסניף כבוי \"{REMOTE_CANCEL_LABEL}\""}
    return {"allowed": True, "needsReason": True}


def _pending_target(db: Session, machine: POSMachine, run_id: Optional[uuid.UUID]):
    from app.models.z_run import ZRun, ZRunItem, ZRunStatus
    from app.services import shift_close_requests as close_requests
    from app.services import till_z
    from app.services import z_runs as ZR

    if run_id is not None:
        return (
            db.query(ZRunItem).join(ZRun, ZRun.id == ZRunItem.run_id)
            .filter(ZRunItem.run_id == run_id, ZRunItem.machine_id == machine.id,
                    ZRunItem.status.in_(ZR.PENDING_ITEM_STATUSES), ZRun.status == ZRunStatus.WAITING)
            .first()
        )
    return close_requests._pending_query(db, machine.id).first() or till_z._pending_query(db, machine.id).first()


def cancel(db: Session, user: Any, machine: POSMachine, *, run_id: Optional[uuid.UUID] = None,
           sale_ids: Optional[list] = None, reason: Optional[str] = None,
           now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    "בטל מכירות מושהות וסגור": the till discards exactly the confirmed held sales (by id, from the list
    it reported — never one added since: it defers again with the new list) and closes, once at rest.
    It records a till event (`held_sale_cancelled`) per sale. The caller commits.
    """
    now = now or datetime.now(timezone.utc)
    offer = cancel_offer(db, machine)
    if not offer["allowed"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": "remote_cancel_held_sales_off", "message": offer["whyNot"]})
    text = (reason or "").strip()
    if len(text) < 5:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "code": "cancel_held_sales_reason_required", "message": "יש להקליד את סיבת הביטול"})
    target = _pending_target(db, machine, run_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": "nothing_pending", "message": "אין לקופה סגירה ממתינה"})
    reported = {s["id"] for s in (target.held_sales or []) if isinstance(s, dict) and s.get("id")}
    wanted = [str(x) for x in (sale_ids or [])]
    if not wanted or not set(wanted) <= reported:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": "held_sales_list_changed",
            "message": "רשימת המכירות המושהות השתנתה — רעננו ואשרו שוב",
            "heldSales": target.held_sales or [],
        })
    who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    target.cancel_held_sales = {"ids": wanted, "reason": text[:300], "by": who, "at": now.isoformat()}
    db.flush()
    _resend(machine, target, user, now)
    return {"requestId": str(target.id), "ids": wanted}


def cancelled_events(db: Session, request_ids: list, machine_ids: list) -> Dict[str, list]:
    """The tills' `held_sale_cancelled` events per request id — the run's log (these tills, these requests)."""
    from app.models.audit_exception import TillEvent

    ids = {str(r) for r in request_ids}
    out: Dict[str, list] = {}
    if not ids or not machine_ids:
        return out
    rows = (
        db.query(TillEvent)
        .filter(
            TillEvent.machine_id.in_(list(machine_ids)),
            TillEvent.event_type == "held_sale_cancelled",
            TillEvent.details["requestId"].as_string().in_(list(ids)),
        )
        .all()
    )
    for ev in rows:
        d = ev.details or {}
        rid = str(d.get("requestId") or "")
        if rid in ids:
            out.setdefault(rid, []).append({
                "heldSaleId": d.get("heldSaleId"), "reason": d.get("reason"), "by": d.get("by"),
                "total": d.get("total"), "items": d.get("items"), "at": d.get("at"),
            })
    return out


def _resend(machine: POSMachine, target: Any, user: Any, now: datetime) -> None:
    from app.models.till_z_request import TillZRequest
    from app.models.z_run import ZRunItem
    from app.services import shift_close_requests as close_requests
    from app.services import till_z
    from app.services import z_runs as ZR

    try:
        if isinstance(target, ZRunItem):
            ZR._send_close(machine, target, user, now)
        elif isinstance(target, TillZRequest):
            till_z._send(machine, target, now)
        else:
            close_requests._send(machine, target, user, now)
    except Exception:  # noqa: BLE001 - the heartbeat carries it anyway
        logger.exception("re-sending the close with keepHeldSales failed for %s", machine.id)


def _record(db: Session, machine: POSMachine, user: Any, target: Any, reason: str, offer: Dict[str, Any], now: datetime) -> None:
    from app.services.exceptions import Detector, Found

    who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    Detector(db)._record(machine, Found(
        type=EXCEPTION_TYPE,
        key=f"close_keep_held_sales:{target.id}",
        occurred_at=now,
        details={
            "requestId": str(target.id),
            "kind": type(target).__name__,
            "by": who,
            "reason": reason or None,
            "byParameter": not offer["needsReason"],
            "summary": f"{KEEP_LABEL} — ע״י {who}" + (f": {reason}" if reason else f" (\"{LABEL}\" מופעל)"),
        },
    ))
