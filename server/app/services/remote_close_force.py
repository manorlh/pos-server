"""
"כפה סגירה" — a remote close or Z forced from the moment the manager sends it (the owner, 09.10.2026:
"ברירת המחדל לכפות סגירה מרגע ששלח המנהל. אפשר לבטל בפרמטרים").

The till parameter `remoteCloseForceByDefault` (company → shop → area → till, default **on**) decides
each till's mode for remote control's closes — its shift close, its own Z, and the shop's or a point
of sale's day close that closes it. The dashboard's dialog shows that mode and the manager may untick
"כפה סגירה" (or tick it) for that one request: the request carries `remote_force` either way.

On the wire the request stays `waitForRest: true` and gains `remoteForce: true`. A till without the
`remote_close_force_v1` capability ignores the new key and waits for rest, exactly as before — so an
old build is never forced by surprise. A till that has it:

* an open basket — parked as a held sale at once, by the safe park (never over a payment screen, a
  card in flight or a voucher in use);
* held sales — never hold the close: they stay held into the next shift; a "בטל מכירות מושהות וסגור"
  the manager confirmed (`remoteCancelHeldSales` on) is carried out as always;
* the payment screen open with nothing sent to the card terminal yet — left exactly as a cashier's
  "ביטול" leaves it, then the basket parked;
* **never forced**: a card in flight or whose result is unknown (the card's own wait, then deferred
  `card_in_flight` and asked again), and documents not yet written (waited up to the till's bound,
  then deferred `documents_pending` and asked again);
* the close is logged as forced with the manager's name (the till's `forced_z_close` event, resolved
  to the request here) and the notices say "נסגר בכפייה מרחוק ע״י <מנהל>".

Off: remote control's close waits for rest, as before the parameter.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

KEY = "remoteCloseForceByDefault"
LABEL = "כפיית סגירה מרחוק כברירת מחדל"
#: The dashboard's checkbox, per request.
CHECKBOX_LABEL = "כפה סגירה"
#: What a till's heartbeat says when its build carries the forced remote close.
CAPABILITY = "remote_close_force_v1"
#: Words for a close done in the forced mode ("נסגר בכפייה מרחוק ע״י דנה").
FORCED_WORDS = "נסגר בכפייה מרחוק"
#: A deferral of a forced close: documents not yet written after the till's bounded wait.
DOCUMENTS_PENDING_CODE = "documents_pending"
DOCUMENTS_PENDING_WORDS = "ממתין למסמכים שטרם נכתבו בקופה"

PARAMETER_SPECS = (
    dict(
        key=KEY,
        label=LABEL,
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל): סגירת משמרת או Z שמנהל שולח מרחוק (מקופה אחת, מסגירת יום סניפית או "
            "מסגירה לפי נקודת מכירה) נכפית מרגע השליחה — עגלה פתוחה נשמרת כמכירה מושהית; מסך תשלום שעוד לא "
            "נשלח בו דבר למסוף האשראי מבוטל כמו \"ביטול\" של הקופאי והעגלה נשמרת; מכירות מושהות לא עוצרות "
            "את הסגירה ונשארות מושהות למשמרת הבאה. לעולם לא נכפית מעל עסקת אשראי בדרך או שתוצאתה לא ידועה, "
            "ולא מעל מסמכים שטרם נכתבו — עליהם הקופה ממתינה זמן מוגבל ומדווחת. הסגירה נרשמת ככפויה עם שם "
            "המנהל. בחלון הסגירה בדשבורד אפשר לבטל את \"כפה סגירה\" (או לסמן אותו) לבקשה אחת. כשכבוי: הקופה "
            "ממתינה שלא תהיה בה מכירה פתוחה, כמו קודם. קיוסק — לפי כללי הקיוסק (לקוח שמזמין או משלם תמיד "
            "ממתין). נקבע לחברה, לסניף, לנקודת מכירה או לקופה."
        ),
    ),
)


def default_on(db: Session, machine: POSMachine) -> bool:
    """`remoteCloseForceByDefault` as resolved for this till (till › area › shop › company › on)."""
    from app.services.held_sales_close import _param

    return _param(db, machine, KEY, True)


def effective(db: Session, machine: POSMachine, override: Optional[bool] = None) -> bool:
    """This request's mode: the manager's tick for it, else the till's parameter."""
    if override is not None:
        return bool(override)
    return default_on(db, machine)


def supported(machine: POSMachine) -> bool:
    """The till's build carries the forced remote close (else it waits for rest whatever is asked)."""
    return CAPABILITY in (getattr(machine, "capabilities", None) or [])


def mode_out(db: Session, machine: POSMachine, *, kiosk: bool = False) -> Dict[str, Any]:
    """What the dialog shows for this till: its default mode, and whether its build can force."""
    on = default_on(db, machine)
    able = supported(machine)
    if kiosk:
        note = "קיוסק — לפי כללי הקיוסק: לקוח שמזמין או משלם תמיד ממתין"
    elif not able:
        note = "גרסת הקופה לא תומכת בכפייה — תמתין שלא תהיה בה מכירה פתוחה"
    else:
        note = None
    return {"key": KEY, "label": CHECKBOX_LABEL, "forceByDefault": on, "supported": able, "note": note}


def forced_words(by: Optional[str]) -> str:
    """"נסגר בכפייה מרחוק ע״י דנה"."""
    who = (by or "").strip()
    return f"{FORCED_WORDS} ע״י {who}" if who else FORCED_WORDS


def done_words(target: Any) -> Optional[str]:
    """For a request completed in the forced mode: the notice's words; else None."""
    if not bool(getattr(target, "remote_force", False)):
        return None
    return forced_words(getattr(target, "initiated_by", None) or _creator_name(target))


def _creator_name(target: Any) -> Optional[str]:
    from sqlalchemy.orm import object_session

    from app.models.user import User

    user_id = getattr(target, "created_by_user_id", None)
    if user_id is None:
        run = getattr(target, "run", None)
        user_id = getattr(run, "created_by_user_id", None) if run is not None else None
    session = object_session(target)
    if user_id is None or session is None:
        return None
    user = session.get(User, user_id)
    return (user.username or user.email) if user is not None else None
