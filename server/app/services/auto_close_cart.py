"""
"סגירת משמרת אוטומטית גם עם עגלה פתוחה" (P:/specs/auto-close-open-cart.md, the owner 14.10.2026: "בהגדרות
ענן, אפשר סגירה אוטומטית גם אם המכשיר עם עסקה פתוחה או עגלה עם פריטים", "דינמי").

`autoCloseShiftAt` closes a till's shift at its time, never in the middle of a payment. Four till parameters
(company → shop → area → till, like every parameter) say what that close does about what is open then — the
till does it (pos-android domain/AutoCloseOpenCart.kt):

* `autoCloseOpenCart` — a basket with items, not paid: `wait` (default: as always), `hold` (parked as a held
  sale "הושהתה בסגירה אוטומטית", back with "החזר הזמנה" in the next shift) or `discard` (voided — an exception
  with its items and amount);
* `autoCloseHeldSales` — the held sales already on the till: `keep` (default: into the next shift) or `cancel`
  (cancelled — one exception);
* `autoCloseMaxWaitMin` (10) — a card payment is never interrupted; past these minutes the close goes on all the
  same (a card with no answer stays "unresolved" as always; an unfinished cash payment is the basket's);
* `autoCloseIgnoreTables` (off) — on, the close does not wait for open tables ("חסימת סגירת יום עם שולחנות
  פתוחים" still holds every other close); they go on into the next shift.

The till reports what it did as till events (`POST /sync/{machine}/events`): a basket held or discarded and the
held sales cancelled become exceptions (app/services/exceptions.py) — the manager is alerted on the phone (the
"staff_actions" alert type, push on by default) — and every automatic close writes its journal line
`shift_auto_closed` ("נסגרה אוטומטית ב-23:30", what was done with the basket), recorded, feeding no rule.
"""
from __future__ import annotations

from typing import Any, Dict

OPEN_CART_KEY = "autoCloseOpenCart"
OPEN_CART_WAIT = "wait"
OPEN_CART_HOLD = "hold"
OPEN_CART_DISCARD = "discard"
OPEN_CART_OPTIONS = (OPEN_CART_WAIT, OPEN_CART_HOLD, OPEN_CART_DISCARD)
OPEN_CART_LABELS = {
    OPEN_CART_WAIT: "לחכות (ברירת מחדל)",
    OPEN_CART_HOLD: "להשהות את העגלה ולסגור",
    OPEN_CART_DISCARD: "לבטל את העגלה ולסגור",
}

HELD_SALES_KEY = "autoCloseHeldSales"
HELD_SALES_KEEP = "keep"
HELD_SALES_CANCEL = "cancel"
HELD_SALES_OPTIONS = (HELD_SALES_KEEP, HELD_SALES_CANCEL)
HELD_SALES_LABELS = {
    HELD_SALES_KEEP: "להשאיר למשמרת הבאה (ברירת מחדל)",
    HELD_SALES_CANCEL: "לבטל",
}

MAX_WAIT_KEY = "autoCloseMaxWaitMin"
MAX_WAIT_DEFAULT = 10
MAX_WAIT_MIN = 0
MAX_WAIT_MAX = 240

IGNORE_TABLES_KEY = "autoCloseIgnoreTables"

#: The held sale's label of a basket the automatic close parked (the till's AUTO_CLOSE_PARK_LABEL).
PARK_LABEL = "הושהתה בסגירה אוטומטית"

# ── What the till reports ────────────────────────────────────────────────────

#: A basket parked as a held sale by the automatic close — an exception, the manager alerted.
CART_HELD = "auto_close_cart_held"
#: A basket voided by the automatic close — an exception with its items and amount, the manager alerted.
CART_DISCARDED = "auto_close_cart_discarded"
#: The held sales the automatic close cancelled (`autoCloseHeldSales` = cancel) — one exception.
HELD_CANCELLED = "auto_close_held_sales_cancelled"
#: The journal's line of every automatic close: when, and what was done. Recorded, feeds no rule.
SHIFT_AUTO_CLOSED = "shift_auto_closed"

#: The till events that are exceptions — each feeds the rule of the same name.
EXCEPTION_EVENTS = (CART_HELD, CART_DISCARDED, HELD_CANCELLED)
TILL_EVENTS = EXCEPTION_EVENTS + (SHIFT_AUTO_CLOSED,)

PARAMETER_SPECS = (
    dict(
        key=OPEN_CART_KEY,
        label="סגירת משמרת אוטומטית — עגלה עם פריטים",
        value_type="enum",
        enum_options=OPEN_CART_OPTIONS,
        enum_labels=OPEN_CART_LABELS,
        default_value=OPEN_CART_WAIT,
        description=(
            "מה הסגירה האוטומטית (\"סגירת משמרת אוטומטית בשעה\") עושה כשבקופה עגלה עם פריטים שלא שולמה. "
            f"«{OPEN_CART_LABELS[OPEN_CART_WAIT]}» — מחכים, כמו היום. "
            f"«{OPEN_CART_LABELS[OPEN_CART_HOLD]}» — העגלה נשמרת כעסקה מושהית עם התווית \"{PARK_LABEL}\", "
            "המשמרת נסגרת, והעסקה זמינה ב\"החזר הזמנה\" במשמרת הבאה. "
            f"«{OPEN_CART_LABELS[OPEN_CART_DISCARD]}» — העגלה מבוטלת והמשמרת נסגרת; נרשמת חריגה \"עגלה בוטלה "
            "בסגירה אוטומטית\" עם הפריטים והסכום. בהשהיה ובביטול נשלחת התראה למנהל, ובפתיחת המשמרת הבאה הקופה "
            "מציגה מה נעשה. הזמנת שולחן נשארת בשולחן. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=HELD_SALES_KEY,
        label="סגירת משמרת אוטומטית — עסקאות מושהות",
        value_type="enum",
        enum_options=HELD_SALES_OPTIONS,
        enum_labels=HELD_SALES_LABELS,
        default_value=HELD_SALES_KEEP,
        description=(
            "מה הסגירה האוטומטית עושה בעסקאות מושהות שכבר קיימות בקופה. "
            f"«{HELD_SALES_LABELS[HELD_SALES_KEEP]}» — עוברות למשמרת הבאה, כמו היום. "
            f"«{HELD_SALES_LABELS[HELD_SALES_CANCEL]}» — מבוטלות (כל אחת נרשמת ביומן), ונרשמת חריגה \"עסקאות מושהות "
            "בוטלו בסגירה אוטומטית\" עם הרשימה והסכום. עגלה שהסגירה עצמה השהתה לא מבוטלת. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=MAX_WAIT_KEY,
        label="סגירת משמרת אוטומטית — המתנה מקסימלית לתשלום (דקות)",
        value_type="integer",
        default_value=MAX_WAIT_DEFAULT,
        description=(
            "תשלום אשראי לא נקטע לעולם — הקופה מחכה לתוצאה. תשלום שלא הסתיים (מסך תשלום פתוח): אחרי מספר "
            f"הדקות הזה ({MAX_WAIT_MIN}–{MAX_WAIT_MAX}, ברירת מחדל {MAX_WAIT_DEFAULT}) הקופה סוגרת בכל זאת — אשראי "
            "בלי תשובה נשאר \"לא מוכרע\" במנגנון הקיים, ומזומן שלא הושלם מטופל לפי \"עגלה עם פריטים\" (בהמתנה — "
            "ממשיכים לחכות). ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=IGNORE_TABLES_KEY,
        label="סגירת משמרת אוטומטית — גם עם שולחנות פתוחים",
        value_type="boolean",
        default_value=False,
        description=(
            "כבוי (ברירת המחדל): חל הכלל \"חסימת סגירת יום עם שולחנות פתוחים\" — הסגירה האוטומטית מחכה. "
            "מופעל: הסגירה האוטומטית מתבצעת גם עם שולחנות פתוחים, והשולחנות עוברים למשמרת הבאה (סגירה ידנית, "
            "מרחוק ו-Z — לפי הכלל כרגיל). ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)

_ENUMS = {OPEN_CART_KEY: OPEN_CART_OPTIONS, HELD_SALES_KEY: HELD_SALES_OPTIONS}
VALIDATED_KEYS = (OPEN_CART_KEY, HELD_SALES_KEY, MAX_WAIT_KEY)


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key`, or ValueError: only the codes it knows, the minutes 0–240."""
    if value is None:
        return value
    if key in _ENUMS:
        if value not in _ENUMS[key]:
            raise ValueError(f"{key} must be one of {', '.join(_ENUMS[key])}")
        return value
    if key == MAX_WAIT_KEY:
        if isinstance(value, bool) or not isinstance(value, int) or not MAX_WAIT_MIN <= value <= MAX_WAIT_MAX:
            raise ValueError(f"{MAX_WAIT_KEY} must be {MAX_WAIT_MIN}–{MAX_WAIT_MAX} minutes")
        return value
    return value


def _money(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    return f"{number:.0f} ₪" if number == int(number) else f"{number:.2f} ₪"


def summary(event_type: str, details: Dict[str, Any]) -> str:
    """The line the exceptions list shows for an automatic close's exception."""
    at = details.get("at") or ""
    when = f" ב-{at}" if at else ""
    if event_type in (CART_HELD, CART_DISCARDED):
        verb = "הושהתה" if event_type == CART_HELD else "בוטלה"
        count = details.get("itemCount")
        what = ", ".join(p for p in (f"{count} פריטים" if count is not None else "", _money(details.get("total"))) if p)
        line = f"עגלה {verb} בסגירה אוטומטית{when}"
        if what:
            line += f" — {what}"
        if details.get("paymentAbandoned"):
            line += " · מסך התשלום בוטל (לא נגבה דבר)"
        return line
    if event_type == HELD_CANCELLED:
        count = details.get("count") or 0
        return f"בוטלו {count} עסקאות מושהות בסגירה אוטומטית{when} — {_money(details.get('total'))}".rstrip(" —")
    return ""
