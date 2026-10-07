"""
The cash drawer's exception kinds (the owner's drawer spec §10–§11), in one small table.

Each kind is detected by `app/services/cash_drawer.py` from the drawer events and cash
movements the tills upload, and written as an `audit_exceptions` row (exception_type =
the key, `details.source = "cash_drawer"`) through the exceptions module's `Detector` —
so it is reviewed on "חריגות", switched on / off per level on "הגדרות חריגות" (its
`RuleSpec` is generated below from this table), and idempotent per source event.
The thresholds are the drawer's till parameters (§17, the roles page's "פרמטרי מגירה").

**Hook for the shared exceptions log** ("יומן חריגות", branch feat/exception-alerts): that
log captures every `audit_exceptions` row already (its `audit_exception` source). To name
these kinds there, add each of `DRAWER_EXCEPTION_KINDS` to its
`app/services/exception_alerts/catalog.py` `KINDS` at merge:

    Kind(k.key, k.label, k.severity, "audit_exception", amount=k.amount, link=k.link)

(`alert_kinds()` below returns exactly those tuples' fields.)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple


@dataclass(frozen=True)
class DrawerExceptionKind:
    key: str
    label: str
    severity: str
    #: Carries a money amount (a "≥ ₪X" alert threshold applies there).
    amount: bool
    #: Where a log entry links: shift | document | none.
    link: str
    description: str


DRAWER_EXCEPTION_KINDS: Tuple[DrawerExceptionKind, ...] = (
    DrawerExceptionKind(
        "drawer_after_close", "פתיחת מגירה לאחר סגירה / Z", "high", False, "shift",
        "המגירה נפתחה כשאין משמרת פתוחה (אחרי סגירת קופה או Z). תמיד חריגה.",
    ),
    DrawerExceptionKind(
        "drawer_manual_burst", "ריבוי פתיחות מגירה ידניות", "medium", False, "shift",
        "X פתיחות ידניות של אותו עובד בתוך Y דקות (פרמטרי המגירה).",
    ),
    DrawerExceptionKind(
        "drawer_manual_over_max", "מעל מקסימום פתיחות ידניות במשמרת", "medium", False, "shift",
        "עובד פתח ידנית יותר מהמקסימום למשמרת (MAX_MANUAL_OPENS_PER_SHIFT).",
    ),
    DrawerExceptionKind(
        "cash_out_over_threshold", "הוצאת מזומן מעל הסף", "medium", True, "shift",
        "Cash Out בסכום מעל \"התראה על Cash Out מעל\".",
    ),
    DrawerExceptionKind(
        "drawer_count_variance", "פער בספירת מגירה", "high", True, "shift",
        "ספירת מגירה (או ספירה בסגירת משמרת) עם פער מעל \"התראה על פער מגירה מעל\".",
    ),
    DrawerExceptionKind(
        "drawer_open_near_variance", "פתיחה ידנית בסמוך לפער מזומן", "high", False, "shift",
        "פתיחה ידנית בדקות שלפני ספירה שנמצא בה פער מעל הסף.",
    ),
    DrawerExceptionKind(
        "drawer_open_no_reason", "פתיחה ידנית ללא סיבה / הערה נדרשת", "low", False, "shift",
        "פתיחה ידנית בלי סיבה כשהסניף דורש סיבה, או בסיבה \"אחר\" בלי הערה.",
    ),
    DrawerExceptionKind(
        "drawer_open_denied", "ניסיון פתיחת מגירה שנחסם", "medium", False, "shift",
        "ניסיון לפתוח מגירה או לבצע תנועת מזומן שנחסם (הרשאה, הגדרה או מגבלה). לא נשלחה פקודת פתיחה.",
    ),
)

KINDS_BY_KEY: Dict[str, DrawerExceptionKind] = {k.key: k for k in DRAWER_EXCEPTION_KINDS}
SOURCE = "cash_drawer"


def alert_kinds() -> List[Tuple[str, str, str, str, bool, str]]:
    """(key, label, severity, source, amount, link) — the exceptions log's `Kind` fields."""
    return [(k.key, k.label, k.severity, "audit_exception", k.amount, k.link) for k in DRAWER_EXCEPTION_KINDS]
