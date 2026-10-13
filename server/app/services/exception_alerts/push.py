"""
"התראות לטלפון" — the exception alerts' Web Push channel (the dashboard is a PWA).

Built on the SMS alerts, not beside them: every alert is an `exception_log` entry (whatever
detected it), a push preference is an `exception_alert_rules` row with `channel = "push"`
(one per dashboard user and tenant, `owner_user_id`), and every attempt is an
`exception_alert_dispatches` row (`channel = "push"`, one per device) — with the same quiet
hours, per-rule rate limit, digest, staleness and "never twice" as the SMS rules (engine.py
calls `process_entry` for each new entry, and `flush_rule` from its digest pass).

What a user receives (`entry_matches`):

* the alert types they chose (`CATEGORIES`) — each a set of exception kinds:
  * `till_offline` — a till or a kiosk that went offline while trading;
  * `card_terminal` — a card terminal not answering or failing: a failed payment the till
    reported as "no answer" / "terminal error" / "unresolved", the kiosks' terminal alerts,
    a card transmission that failed at the Z;
  * `large_void` — a refund, a cancelled basket or document, a voided line, a cancelled table
    or an over-credited credit note of at least `min_amount` (₪200 by default);
  * `drawer_no_sale` — the drawer opened without a sale (and the drawer's other opening
    exceptions);
  * `till_low_sales` — a till barely selling against its peers (the insights' anomaly rules
    report it through external.py);
  * `target_reached` — a sales target reached ("יעדים ותחרות", an event's target included);
  * `z_shift`, `card_transmission`, `till_printer` — the board's lights as alerts (a Z not made,
    a shift open too long, card sales not transmitted, the till's printer; status_watch.py);
* only from what the user may see in the exceptions log (the same scoping), and only with the
  dashboard sections "alerts" / "reports" / "exception_alerts" — a producer never;
* narrowed to the chosen shops and / or events (an event = its tills inside its window).

Two gates (P:/specs/push-more.md §0): the organization's — each kind's exception rule says
"שלח התראה לטלפון" (`push`) where it happened, per tenant / company / shop / point of sale / till,
and its amount floor (`minAmount` / `amount`) — then the user's own preferences above (types,
places, their personal `min_amount` floor on top of the rule's, quiet hours). A kind with no rule
is the user's alone. Urgent alerts (`integrity`, a critical battery) skip the rate limit and the
digest; quiet hours still hold them, and they go one by one once the quiet hours end.

`integrity` ("שלמות נתונים": a refused document, a numbering conflict, Z / shift totals that
differ, offline Z gaps and conflicts) is apart: super admins only, from every organization,
never by a tenant's rules (`integrity_recipients`); their own switch, companies and muted devices
live in their user preferences (`integrity_prefs`).

Delivery: the dispatch row is written first (unique per entry, rule and device), then the
message is encrypted and posted by a background sender thread (webpush.py), which records
sent / failed and turns off a device the push service says is gone. Nothing here sends SMS
or WhatsApp.
"""
from __future__ import annotations

import hashlib
import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.exception_alerts import (
    CHANNEL_PUSH,
    DELIVERED_STATUSES,
    DISPATCH_ALERT,
    DISPATCH_DIGEST,
    DISPATCH_TEST,
    ST_FAILED,
    ST_QUEUED,
    ST_SENT,
    ST_SUPPRESSED_QUIET,
    ST_SUPPRESSED_RATE,
    ST_SUPPRESSED_STALE,
    SUPPRESSED_STATUSES,
    ExceptionAlertDispatch,
    ExceptionAlertRule,
    ExceptionLogEntry,
    PushSubscription,
)
from app.services.exception_alerts import messages as M
from app.services.exception_alerts.catalog import label_of
from app.services.exception_alerts.log import aware, utcnow
from app.services.exception_alerts.rules import RuleError, _number, parse_time

logger = logging.getLogger(__name__)


# ── The alert types ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    hint: str
    kinds: Tuple[str, ...]
    #: `min_amount` applies.
    amount: bool = False


#: A failed payment that is the terminal's fault, not the card's.
TERMINAL_OUTCOMES = frozenset({"no_answer", "terminal_error", "unresolved"})

CATEGORIES: Tuple[Category, ...] = (
    Category("till_offline", "קופה התנתקה",
             "קופה או קיוסק עם משמרת פתוחה שלא מחוברים לענן, ושרת מקומי שהענן העביר לבד (גיבוי אוטומטי).",
             ("till_offline", "kiosk_offline", "local_server_failover")),
    Category("card_terminal", "מסוף אשראי לא עונה / נכשל",
             "המסוף לא ענה או החזיר שגיאה בעסקה, תקלת מסוף בקיוסק, שידור אשראי שנכשל ב-Z.",
             ("failed_payment", "kiosk_terminal", "terminal_mismatch", "card_unresolved", "z_transmission_failed")),
    Category("large_void", "ביטול / זיכוי גדול",
             "זיכוי, ביטול עסקה או שורה, ביטול שולחן — מעל הסכום של חוק החריגה ומעל הסכום שבחרת. עם העובד, המאשר והסיבה.",
             ("refund", "basket_cancel", "line_void", "table_cancelled", "over_credited"), amount=True),
    Category("drawer_no_sale", "מגירה נפתחה ללא מכירה",
             "פתיחת מגירה ללא מכירה, אחרי סגירה, ריבוי פתיחות ידניות, ניסיון פתיחה שנחסם, הוצאת מזומן מעל הסף ופער בספירה.",
             ("drawer_open", "drawer_after_close", "drawer_manual_burst", "drawer_manual_over_max",
              "drawer_open_near_variance", "drawer_open_no_reason", "drawer_open_denied", "cash_out_over_threshold",
              "drawer_count_variance")),
    Category("till_low_sales", "קופה כמעט לא מוכרת", "קופה שמוכרת הרבה פחות מהקופות שלידה (חריגות בקופות).",
             ("till_low_sales",)),
    Category("target_reached", "יעד הושג", "יעד מכירות שהושג — של אירוע, של הסניף, של נקודת מכירה או של עובד.",
             ("target_reached",)),
    Category("card_reconcile", "אי-התאמה מול Z-Credit",
             "התאמת האשראי הלילית מול Z-Credit: חיוב במסוף בלי מסמך שלנו, או מסמך שלנו בלי עסקה במסוף.",
             ("zcredit_recon",)),
    Category("bon_unprinted", "בון לא הודפס",
             "בון שלא הודפס במדפסת מטבח / בר, או שלא התקבל במסך המטבח — מכל קופה וקיוסק.",
             ("bon_unprinted",)),
    # The board's lights as alerts (status_watch.py, P:/specs/manager-problems.md §2); each kind can
    # be switched off per company / shop / till in "הגדרות חריגות".
    Category("z_shift", "Z / משמרת",
             "Z שלא בוצע אחרי סוף יום העסקים, ומשמרת שפתוחה יותר מדי שעות או מעבר לתאריך שלה.",
             ("z_missing", "shift_open_overdue")),
    Category("card_transmission", "שידור אשראי באיחור",
             "עסקאות אשראי שלא שודרו בזמן: בינונית אחרי השעות שנקבעו, גבוהה כשמתקרבים לסירוב חברות האשראי.",
             ("card_transmission_overdue",)),
    Category("till_printer", "מדפסת קופה",
             "בקופה עם משמרת פתוחה: אין נייר, התחממות או שגיאת מדפסת יותר מכמה דקות.",
             ("till_printer",)),
    # P:/specs/push-more.md §A: a device's battery (on: the rule's push switch is on by default).
    Category("device_battery", "סוללה חלשה",
             "מסופון, טאבלט, קיוסק או מסך מטבח עם סוללה שירדו מתחת לסף; הסף הקריטי באדום. נסגרת בטעינה.",
             ("device_battery",)),
    # §B: kinds the log always had; sent only where a level turns "שלח התראה לטלפון" on.
    Category("discounts", "הנחות, מחירים ועל חשבון הבית", "הנחה ידנית, שינוי מחיר ועל חשבון הבית — מעל הסף של חוק החריגה.",
             ("discount", "price_override", "oth"), amount=True),
    Category("cash_difference", "הפרש בספירת קופה", "הפרש בספירת המזומן בסגירת משמרת, מעל הסכום של חוק החריגה.",
             ("cash_difference",), amount=True),
    Category("high_tip", "טיפ גבוה", "טיפ מעל האחוז שבחוק החריגה.", ("high_tip",)),
    Category("high_sale", "עסקה גדולה", "עסקה מעל הסכום שבחוק החריגה.", ("high_amount",), amount=True),
    Category("after_hours", "מכירה מחוץ לשעות", "מכירה בשעות שבחוק החריגה.", ("after_hours",)),
    Category("sensitive_actions", "פעולות רגישות",
             "הכרעת אשראי ידנית, עקיפת בדיקת מסוף, איפוס או החלפת קופה, Z בכפייה או מהתמיכה, מצב הדרכה.",
             ("card_decision_override", "terminal_check_bypass", "till_reset", "till_replaced", "forced_z_close",
              "support_z_produced", "z_forced_open_shifts", "z_forced_pending_cloud_refund", "shop_z_producer_forced",
              "training_mode", "training_dropped")),
    Category("staff_actions", "עובדים ונוכחות",
             "שינוי נוכחות ידני, שחרור עובד מקופה אחרת, הדפסה חוזרת וסגירה עם מכירות מושהות.",
             ("attendance_manual", "user_session_release", "reprint", "close_keep_held_sales")),
    Category("stock", "מלאי", "מוצר שהמלאי שלו נמוך או אזל, לפי הספים של המלאי.", ("stock_low", "stock_out")),
    Category("slow_order", "הזמנה ארוכה", "הזמנה שלקחה יותר מהדקות שבחוק החריגה.", ("long_order",)),
)
#: "שלמות נתונים" (manager-problems §1): the cloud and a till disagree about what was sold. Only a
#: super admin receives it — from every organization, past the organizations' scoping (a super
#: admin is not a member of each); a company never does, and cannot switch it off for them. Its
#: switch, companies and devices are the super admin's own (`integrity_prefs`), the quiet hours
#: and the rate limit those of their preferences (`governing_rule`).
INTEGRITY_KINDS = (
    "document_refused", "document_number_conflict", "z_totals_mismatch", "shift_totals_mismatch",
    "local_shop_z_mismatch", "offline_z_gap", "offline_z_conflict",
)
INTEGRITY = Category("integrity", "שלמות נתונים",
                     "מסמך שנדחה בענן, מספור כפול, פער בסכומי Z או משמרת, חור או התנגשות במספור Z אופליין — מכל הארגונים. למנהל-על בלבד.",
                     INTEGRITY_KINDS)
CATEGORY_BY_KEY: Dict[str, Category] = {c.key: c for c in (*CATEGORIES, INTEGRITY)}
#: What any user may choose (and what "everything" means for a new user). Not `integrity`.
CATEGORY_KEYS = tuple(c.key for c in CATEGORIES)
#: Added with manager-problems §2: on for a user whose saved types hold every one the phone alerts
#: started with (the data migration 3c9e5a7b1d24 adds them), off for one who had left some out; on
#: for a new user (no preferences = every type).
NEW_CATEGORY_KEYS = ("z_shift", "card_transmission", "till_printer")
#: Added with push-more §A / §B, the same way (the data migration 8d4f2a6c1e93). Their kinds are
#: sent only where the organization's rule says "שלח התראה לטלפון" (off by default but the battery).
PUSH_MORE_CATEGORY_KEYS = (
    "device_battery", "discounts", "cash_difference", "high_tip", "high_sale", "after_hours",
    "sensitive_actions", "staff_actions", "stock", "slow_order",
)
_CATEGORY_OF_KIND: Dict[str, str] = {kind: c.key for c in (*CATEGORIES, INTEGRITY) for kind in c.kinds}

DEFAULT_MIN_AMOUNT = Decimal("200.00")
DEFAULT_RATE_LIMIT = 2
MAX_RATE_LIMIT = 24 * 60
MAX_IDS = 200
#: Push is personal: the sections that make an alert something this user may know about.
SECTIONS = ("alerts", "reports", "exception_alerts")
#: "שליחת התראת בדיקה" at most once per this, per user.
TEST_MIN_GAP = timedelta(seconds=30)
#: A dispatch still `queued` this long after it was written: its process died — sent again.
RETRY_AFTER = timedelta(minutes=2)
MAX_ATTEMPTS = 3
#: Stop sending to a device after this many failures in a row (the push service never said "gone").
MAX_FAILURES = 10


def category_of(entry: ExceptionLogEntry) -> Optional[str]:
    """The alert type of a log entry (pure). A failed payment counts only when the terminal failed."""
    key = _CATEGORY_OF_KIND.get(entry.kind)
    if key == "card_terminal" and entry.kind == "failed_payment":
        outcome = (entry.details or {}).get("outcome") if isinstance(entry.details, dict) else None
        return key if outcome in TERMINAL_OUTCOMES else None
    return key


def is_super_admin(user: Any) -> bool:
    from app.models.user import UserRole

    return user is not None and getattr(user, "role", None) == UserRole.SUPER_ADMIN


def categories_for(user: Any = None) -> Tuple[Category, ...]:
    """The alert types this user may choose: every type, and "שלמות נתונים" for a super admin."""
    return (*CATEGORIES, INTEGRITY) if is_super_admin(user) else CATEGORIES


def categories_json(user: Any = None) -> List[Dict[str, Any]]:
    return [{"key": c.key, "label": c.label, "hint": c.hint, "amount": c.amount} for c in categories_for(user)]


# ── "שלמות נתונים": the super admin's own switch ──────────────────────────────

#: In `users.preferences` (the user's own settings, app/services/user_preferences.py keeps any key it
#: does not know): `{"enabled": bool, "companyIds": [..] | absent, "mutedDeviceIds": [..]}`. Absent = on,
#: every company, every device.
INTEGRITY_PREFS_KEY = "pushIntegrity"


def integrity_prefs(user: Any) -> Dict[str, Any]:
    raw = getattr(user, "preferences", None)
    stored = raw.get(INTEGRITY_PREFS_KEY) if isinstance(raw, dict) else None
    stored = stored if isinstance(stored, dict) else {}
    companies = stored.get("companyIds")
    muted = stored.get("mutedDeviceIds")
    return {
        "enabled": stored.get("enabled", True) is not False,
        "companyIds": [str(c) for c in companies] if isinstance(companies, list) and companies else None,
        "mutedDeviceIds": [str(d) for d in muted] if isinstance(muted, list) else [],
    }


def save_integrity_prefs(user: Any, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Merge `enabled` / `companyIds` / `mutedDeviceIds` (validated) into the user's own preferences. The caller commits."""
    current = integrity_prefs(user)
    if "enabled" in patch:
        current["enabled"] = patch["enabled"] is not False
    if "companyIds" in patch:
        current["companyIds"] = _ids(patch["companyIds"], "integrity.companyIds")
    if "mutedDeviceIds" in patch:
        current["mutedDeviceIds"] = _ids(patch["mutedDeviceIds"], "integrity.mutedDeviceIds") or []
    stored = {"enabled": current["enabled"], "mutedDeviceIds": current["mutedDeviceIds"]}
    if current["companyIds"]:
        stored["companyIds"] = current["companyIds"]
    raw = getattr(user, "preferences", None)
    prefs = dict(raw) if isinstance(raw, dict) else {}
    prefs[INTEGRITY_PREFS_KEY] = stored
    user.preferences = prefs  # a new dict: the JSON column is seen as changed
    return current


# ── Preferences (the push rule) ──────────────────────────────────────────────


def _ids(raw: Any, field: str) -> Optional[List[str]]:
    if raw in (None, ""):
        return None
    if not isinstance(raw, list):
        raise RuleError("ids_invalid", field)
    out: List[str] = []
    for item in raw:
        try:
            text = str(uuid.UUID(str(item)))
        except (TypeError, ValueError):
            raise RuleError("ids_invalid", field) from None
        if text not in out:
            out.append(text)
    if len(out) > MAX_IDS:
        raise RuleError("too_many_ids", field, str(MAX_IDS))
    return out or None


def clean(body: Dict[str, Any], *, partial_of: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The preferences from a request body (camelCase), validated; fields left out keep their value."""
    src = dict(partial_of or {})
    src.update({k: v for k, v in (body or {}).items()})
    raw = src.get("categories")
    if raw is None:
        raw = list(CATEGORY_KEYS)
    if not isinstance(raw, list):
        raise RuleError("categories_invalid", "categories")
    cats: List[str] = []
    for c in raw:
        if c not in CATEGORY_BY_KEY:
            raise RuleError("category_unknown", "categories", str(c))
        if c not in cats:
            cats.append(c)
    quiet_from = parse_time(src.get("quietFrom"), "quietFrom")
    quiet_to = parse_time(src.get("quietTo"), "quietTo")
    if (quiet_from is None) != (quiet_to is None):
        raise RuleError("quiet_needs_both", "quietFrom" if quiet_from is None else "quietTo")
    if quiet_from is not None and quiet_from == quiet_to:
        raise RuleError("quiet_empty", "quietTo")
    min_amount = _number(src.get("minAmount", DEFAULT_MIN_AMOUNT), "minAmount", minimum=0, maximum=1_000_000)
    rate = _number(src.get("rateLimitMinutes", DEFAULT_RATE_LIMIT), "rateLimitMinutes",
                   minimum=0, maximum=MAX_RATE_LIMIT, integer=True)
    return {
        "enabled": src.get("enabled", True) is not False,
        "categories": cats,
        "shopIds": _ids(src.get("shopIds"), "shopIds"),
        "eventIds": _ids(src.get("eventIds"), "eventIds"),
        "minAmount": DEFAULT_MIN_AMOUNT if min_amount is None else min_amount,
        "quietFrom": quiet_from,
        "quietTo": quiet_to,
        "rateLimitMinutes": DEFAULT_RATE_LIMIT if rate is None else rate,
        "digestEnabled": src.get("digestEnabled", True) is not False,
    }


def apply(rule: ExceptionAlertRule, fields: Dict[str, Any]) -> None:
    rule.enabled = fields["enabled"]
    rule.categories = list(fields["categories"])
    rule.kinds = []
    rule.shop_ids = list(fields["shopIds"]) if fields["shopIds"] else None
    rule.event_ids = list(fields["eventIds"]) if fields["eventIds"] else None
    rule.min_amount = fields["minAmount"]
    rule.quiet_from = fields["quietFrom"]
    rule.quiet_to = fields["quietTo"]
    rule.rate_limit_minutes = fields["rateLimitMinutes"]
    rule.digest_enabled = fields["digestEnabled"]


def as_json(rule: Optional[ExceptionAlertRule]) -> Dict[str, Any]:
    """The preferences on the wire; no rule yet reads as the defaults (all types, everything)."""
    if rule is None:
        out = clean({})
        out["minAmount"] = float(out["minAmount"])
        return {**out, "exists": False}
    return {
        "exists": True,
        "enabled": bool(rule.enabled),
        "categories": [c for c in (rule.categories or []) if c in CATEGORY_BY_KEY],
        "shopIds": list(rule.shop_ids or []) or None,
        "eventIds": list(rule.event_ids or []) or None,
        "minAmount": float(rule.min_amount) if rule.min_amount is not None else float(DEFAULT_MIN_AMOUNT),
        "quietFrom": rule.quiet_from,
        "quietTo": rule.quiet_to,
        "rateLimitMinutes": rule.rate_limit_minutes if rule.rate_limit_minutes is not None else DEFAULT_RATE_LIMIT,
        "digestEnabled": bool(rule.digest_enabled),
    }


def rule_for_user(db: Session, user_id: Any, tenant_id: Any) -> Optional[ExceptionAlertRule]:
    return (
        db.query(ExceptionAlertRule)
        .filter(
            ExceptionAlertRule.channel == CHANNEL_PUSH,
            ExceptionAlertRule.owner_user_id == user_id,
            ExceptionAlertRule.tenant_id == tenant_id,
            ExceptionAlertRule.deleted_at.is_(None),
        )
        .order_by(ExceptionAlertRule.created_at)
        .first()
    )


def _split_integrity(user: Any, body: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    The body's "שלמות נתונים" part (a super admin's own switch, not the tenant's rule): `integrity`
    in `categories` turns it on, `categories` without it off; `integrity: {companyIds, mutedDeviceIds}`.
    Anyone else naming it is refused.
    """
    body = dict(body or {})
    patch: Dict[str, Any] = {}
    cats = body.get("categories")
    extra = body.pop("integrity", None)
    if not is_super_admin(user):
        if extra is not None or (isinstance(cats, list) and INTEGRITY.key in cats):
            raise RuleError("category_unknown", "categories", INTEGRITY.key)
        return body, patch
    if isinstance(cats, list):
        patch["enabled"] = INTEGRITY.key in cats
        body["categories"] = [c for c in cats if c != INTEGRITY.key]
    if extra is not None:
        if not isinstance(extra, dict):
            raise RuleError("integrity_invalid", "integrity")
        for key in ("companyIds", "mutedDeviceIds"):
            if key in extra:
                patch[key] = extra[key]
    return body, patch


def preferences_json(db: Session, user: Any, tenant_id: Any) -> Dict[str, Any]:
    """The preferences on the wire; a super admin's carry "שלמות נתונים" (in `categories`, and `integrity`)."""
    out = as_json(rule_for_user(db, user.id, tenant_id))
    if is_super_admin(user):
        own = integrity_prefs(user)
        if own["enabled"]:
            out["categories"] = [*out["categories"], INTEGRITY.key]
        out["integrity"] = {"companyIds": own["companyIds"], "mutedDeviceIds": own["mutedDeviceIds"]}
    return out


def save_preferences(db: Session, user: Any, tenant_id: Any, body: Dict[str, Any]) -> ExceptionAlertRule:
    """Create or update the user's push rule in this tenant (validated). The caller commits."""
    body, integrity_patch = _split_integrity(user, body)
    rule = rule_for_user(db, user.id, tenant_id)
    fields = clean(body, partial_of=as_json(rule) if rule is not None else None)
    if integrity_patch:
        save_integrity_prefs(user, integrity_patch)
    if rule is None:
        rule = ExceptionAlertRule(
            id=uuid.uuid4(), tenant_id=tenant_id, company_id=None, shop_id=None, channel=CHANNEL_PUSH,
            owner_user_id=user.id, name=f"התראות לטלפון — {getattr(user, 'username', None) or getattr(user, 'email', '')}"[:120],
            kinds=[], recipients=[], created_by=user.id,
        )
        db.add(rule)
    apply(rule, fields)
    rule.updated_by = user.id
    db.flush()
    return rule


# ── Who receives what ────────────────────────────────────────────────────────


def push_rules_for(db: Session, entry: ExceptionLogEntry) -> List[ExceptionAlertRule]:
    if entry.tenant_id is None:
        return []
    return (
        db.query(ExceptionAlertRule)
        .filter(
            ExceptionAlertRule.tenant_id == entry.tenant_id,
            ExceptionAlertRule.channel == CHANNEL_PUSH,
            ExceptionAlertRule.enabled.is_(True),
            ExceptionAlertRule.deleted_at.is_(None),
            ExceptionAlertRule.owner_user_id.isnot(None),
        )
        .order_by(ExceptionAlertRule.created_at, ExceptionAlertRule.id)
        .all()
    )


def owner_may_see(db: Session, owner: Any, entry: ExceptionLogEntry) -> bool:
    """The owner could read this entry in the exceptions log (its scoping), with an alerts-type section."""
    from fastapi import HTTPException

    from app.models.user import UserRole
    from app.routers.exception_log import scoped
    from app.services import dashboard_access

    if owner is None or not getattr(owner, "is_active", False):
        return False
    if getattr(owner, "role", None) == getattr(UserRole, "PRODUCER_VIEW", object()):
        return False
    access = dashboard_access.effective_access(db, owner)
    if not any(access.allows(s, "view") for s in SECTIONS if s in _known_sections()):
        return False
    try:
        q = scoped(db, owner, entry.tenant_id)
    except HTTPException:
        return False
    if q is None:
        return False
    return q.filter(ExceptionLogEntry.id == entry.id).first() is not None


def _known_sections() -> Set[str]:
    from app.services.dashboard_sections import SECTION_IDS

    return set(SECTION_IDS)


def _event_covers(db: Session, event_ids: Sequence[str], entry: ExceptionLogEntry) -> bool:
    from app.models.report_event import ReportEvent, ReportEventMachine

    wanted = []
    for raw in event_ids:
        try:
            wanted.append(uuid.UUID(str(raw)))
        except (TypeError, ValueError):
            continue
    if not wanted:
        return False
    details = entry.details if isinstance(entry.details, dict) else {}
    if details.get("eventId") and str(details.get("eventId")) in {str(w) for w in wanted}:
        return True
    if entry.machine_id is None:
        return False
    at = aware(entry.occurred_at)
    hit = (
        db.query(ReportEvent.id)
        .join(ReportEventMachine, ReportEventMachine.event_id == ReportEvent.id)
        .filter(
            ReportEvent.id.in_(wanted),
            ReportEventMachine.machine_id == entry.machine_id,
            ReportEvent.starts_at <= at,
            ReportEvent.ends_at > at,
        )
        .first()
    )
    return hit is not None


def place_matches(db: Session, rule: ExceptionAlertRule, entry: ExceptionLogEntry) -> bool:
    """The chosen shops / events (either, when both are set); none chosen = everywhere."""
    shops = [str(s) for s in (rule.shop_ids or [])]
    events = [str(e) for e in (rule.event_ids or [])]
    if not shops and not events:
        return True
    if shops and entry.shop_id is not None and str(entry.shop_id) in shops:
        return True
    return bool(events) and _event_covers(db, events, entry)


@dataclass(frozen=True)
class OrgGate:
    """The organization's word on one entry: sent at all, and the amount floor of its kind's rule."""

    allowed: bool
    floor: Decimal = Decimal("0")


#: The threshold a kind's rule sets on its amount (the first of these its rule has).
AMOUNT_PARAMS = ("minAmount", "amount")


def org_gate(db: Session, entry: ExceptionLogEntry) -> OrgGate:
    """
    "שלח התראה לטלפון" of the entry's kind where it happened (push-more §0) — its till's rule, else its
    shop's — and that rule's amount floor. "שלמות נתונים" is the super admins' alone: no company
    switches it off. A kind with no rule: always (the user's preferences decide). A battery also
    by its device's `batteryPushLevel` (all / critical / off).
    """
    from app.services import exceptions as EX

    spec = EX.RULES_BY_TYPE.get(entry.kind)
    if spec is None or category_of(entry) == INTEGRITY.key:
        return OrgGate(True)
    try:
        rules = EX.rules_where(db, tenant_id=entry.tenant_id, company_id=entry.company_id, shop_id=entry.shop_id,
                               area_id=entry.area_id, machine_id=entry.machine_id)
    except Exception:  # noqa: BLE001 - a rule that cannot be read: the defaults
        logger.exception("push: the rules of entry %s could not be read", entry.id)
        return OrgGate(spec.push_default)
    rule = rules.get(entry.kind)
    if rule is None or not rule.push:
        return OrgGate(False)
    if entry.kind == "device_battery" and not _battery_level_allows(db, entry):
        return OrgGate(False)
    floor = next((rule.params[k] for k in AMOUNT_PARAMS if rule.params.get(k) is not None), 0)
    return OrgGate(True, Decimal(str(floor or 0)))


def gated_kind(kind: str) -> bool:
    """A kind that is an alert only where a level turns its "שלח התראה לטלפון" on (off by default)."""
    from app.services import exceptions as EX

    spec = EX.RULES_BY_TYPE.get(kind)
    return spec is not None and not spec.push_default


class GateCache:
    """`org_gate`'s push switch for many entries at once (the alerts feed): the rules per place, read once."""

    def __init__(self, db: Session):
        self.db = db
        self._rules: Dict[Tuple[Any, ...], Dict[str, Any]] = {}

    def allows(self, entry: ExceptionLogEntry) -> bool:
        from app.services import exceptions as EX

        key = (entry.tenant_id, entry.company_id, entry.shop_id, entry.area_id, entry.machine_id)
        if key not in self._rules:
            self._rules[key] = EX.rules_where(self.db, tenant_id=entry.tenant_id, company_id=entry.company_id,
                                              shop_id=entry.shop_id, area_id=entry.area_id, machine_id=entry.machine_id)
        rule = self._rules[key].get(entry.kind)
        return rule is not None and rule.push


def _battery_level_allows(db: Session, entry: ExceptionLogEntry) -> bool:
    from app.models.pos_machine import POSMachine
    from app.services import battery_alerts as BA

    machine = db.get(POSMachine, entry.machine_id) if entry.machine_id else None
    level = BA.push_level_of(db, machine) if machine is not None else BA.PUSH_ALL
    if level == BA.PUSH_OFF:
        return False
    return level != BA.PUSH_CRITICAL or _battery_critical(entry)


def _battery_critical(entry: ExceptionLogEntry) -> bool:
    details = entry.details if isinstance(entry.details, dict) else {}
    return entry.kind == "device_battery" and details.get("severity") == "critical"


def is_urgent(entry: ExceptionLogEntry) -> bool:
    """Past the shared rate limit and the digest (push-more §B2): "שלמות נתונים", a critical battery."""
    return category_of(entry) == INTEGRITY.key or _battery_critical(entry)


def entry_matches(db: Session, rule: ExceptionAlertRule, entry: ExceptionLogEntry, owner: Any = None,
                  gate: Optional[OrgGate] = None) -> bool:
    category = category_of(entry)
    if category is None or category == INTEGRITY.key or category not in (rule.categories or []):
        return False  # "שלמות נתונים" never goes by a tenant's rules (`integrity_recipients`)
    if CATEGORY_BY_KEY[category].amount:
        # The rule's floor where it happened, and the user's own above it (push-more §B, §B2).
        floor = gate.floor if gate is not None else Decimal("0")
        if rule.min_amount is not None:
            floor = max(floor, Decimal(str(rule.min_amount)))
        if entry.amount is None or abs(Decimal(str(entry.amount))) < floor:
            return False
    if not place_matches(db, rule, entry):
        return False
    if owner is None:
        from app.models.user import User

        owner = db.get(User, rule.owner_user_id)
    return owner_may_see(db, owner, entry)


def devices_of(db: Session, user_id: Any) -> List[PushSubscription]:
    return (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user_id, PushSubscription.disabled_at.is_(None))
        .order_by(PushSubscription.created_at)
        .all()
    )


def governing_rule(db: Session, user: Any, tenant_id: Any) -> Optional[ExceptionAlertRule]:
    """
    The preferences a super admin's "שלמות נתונים" alert from `tenant_id` goes by (the on / off of
    all their phone alerts, the quiet hours, the rate limit, the digest): theirs in that
    organization, else their home ones — of their own organization, else the first they made.
    """
    rule = rule_for_user(db, user.id, tenant_id)
    if rule is not None:
        return rule
    rows = (
        db.query(ExceptionAlertRule)
        .filter(
            ExceptionAlertRule.channel == CHANNEL_PUSH,
            ExceptionAlertRule.owner_user_id == user.id,
            ExceptionAlertRule.deleted_at.is_(None),
        )
        .order_by(ExceptionAlertRule.created_at, ExceptionAlertRule.id)
        .all()
    )
    home = [r for r in rows if getattr(user, "tenant_id", None) is not None and r.tenant_id == user.tenant_id]
    return (home or rows or [None])[0]


def _company_chosen(db: Session, company_id: Any, chosen: Sequence[str]) -> bool:
    """The entry's company, or a company above it, is one of the chosen ones."""
    from app.services.company_hierarchy import ancestor_company_ids

    if company_id is None:
        return False
    line = [company_id, *ancestor_company_ids(db, company_id)]
    return any(str(c) in set(chosen) for c in line)


def integrity_recipients(db: Session, entry: ExceptionLogEntry) -> List[Tuple[Any, ExceptionAlertRule, List[PushSubscription]]]:
    """
    Who receives a "שלמות נתונים" alert: every active super admin — whatever organization it came
    from, none of them a member there — whose own switch is on, whose companies (if chosen) include
    its company, with their devices but the ones they muted for it, under their governing rule.
    Never anyone else.
    """
    from app.models.user import User, UserRole

    out: List[Tuple[Any, ExceptionAlertRule, List[PushSubscription]]] = []
    admins = (
        db.query(User)
        .filter(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True))
        .order_by(User.created_at, User.id)
        .all()
    )
    for admin in admins:
        own = integrity_prefs(admin)
        if not own["enabled"]:
            continue
        if own["companyIds"] and not _company_chosen(db, entry.company_id, own["companyIds"]):
            continue
        devices = [d for d in devices_of(db, admin.id) if str(d.id) not in set(own["mutedDeviceIds"])]
        if not devices:
            continue
        rule = governing_rule(db, admin, entry.tenant_id)
        if rule is None:
            continue
        out.append((admin, rule, devices))
    return out


# ── The message ──────────────────────────────────────────────────────────────


def _names(db: Session, entry: ExceptionLogEntry) -> Tuple[Optional[str], Optional[str]]:
    from app.services.exception_alerts.engine import _names as names

    return names(db, entry)


def may_open_alerts(db: Session, user: Any) -> bool:
    """Whether "התראות" (/dashboard/alerts, the section "alerts") opens for this user."""
    from app.services import dashboard_access

    return user is not None and dashboard_access.effective_access(db, user).allows("alerts", "view")


def home_url(db: Session, user: Any) -> str:
    """Where a digest or a test leads: "התראות" when this user may open it, else the dashboard's home."""
    return "/dashboard/alerts" if may_open_alerts(db, user) else "/dashboard"


#: Kinds that describe a state of a till: a newer alert replaces the older one on the phone (a late
#: transmission turning high replaces its medium one).
STATE_KINDS = frozenset({"till_offline", "kiosk_offline", "card_transmission_overdue", "till_printer"})


#: Alert types whose message names the employee, the approver, the reason and the document.
WHO_WHY_CATEGORIES = frozenset({
    "large_void", "discounts", "cash_difference", "high_tip", "high_sale", "after_hours", "sensitive_actions",
    "staff_actions", "slow_order", "drawer_no_sale",
})


def _looks_like_id(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


def who_why(db: Session, entry: ExceptionLogEntry) -> List[str]:
    """"עובד: דנה", "אישר: יוסי", "סיבה: …", "מסמך 1007" — what the entry knows of them."""
    details = entry.details if isinstance(entry.details, dict) else {}
    parts: List[str] = []
    if entry.pos_user_name:
        parts.append(f"עובד: {entry.pos_user_name}")
    approver = details.get("approverName") or details.get("approvedByName")
    raw = details.get("approvedBy") or details.get("forcedBy")
    if not approver and raw:
        if _looks_like_id(raw):
            from app.services.exceptions import Detector

            approver = Detector(db).approver_name(str(raw))
        else:
            approver = str(raw)
    if approver and approver != entry.pos_user_name:
        parts.append(f"אישר: {approver}")
    reason = details.get("reasonText") or details.get("reason")
    if isinstance(reason, str) and reason.strip():
        parts.append(f"סיבה: {' '.join(reason.split())[:60]}")
    number = details.get("transactionNumber") or details.get("documentNumber")
    if number and (not entry.summary or str(number) not in entry.summary):
        parts.append(f"מסמך {number}")
    return parts


def _battery_line(db: Session, entry: ExceptionLogEntry, shop: Optional[str], till: Optional[str]) -> str:
    """"המסופון קופה 2, סניף X: סוללה 10%" (push-more §A)."""
    from app.models.pos_machine import POSMachine
    from app.services import battery_alerts as BA

    details = entry.details if isinstance(entry.details, dict) else {}
    machine = db.get(POSMachine, entry.machine_id) if entry.machine_id else None
    label = " ".join(p for p in (BA.device_label(db, machine) if machine is not None else "מכשיר", till) if p)
    percent = details.get("percent") if details.get("percent") is not None else entry.value
    where = f"{label}, {shop}" if shop else label
    text = f"{where}: סוללה {int(Decimal(str(percent)))}%" if percent is not None else f"{where}: סוללה חלשה"
    return text + (" (קריטי)" if _battery_critical(entry) else "")


def _company_name(db: Session, company_id: Any) -> Optional[str]:
    from app.models.company import Company

    company = db.get(Company, company_id) if company_id else None
    return company.name if company is not None else None


def may_open_log(db: Session, user: Any) -> bool:
    """Whether a tap may lead to the entry's page (`/x/<code>`, the exceptions log's section)."""
    from app.services import dashboard_access

    if user is None:
        return False
    access = dashboard_access.effective_access(db, user)
    return access.allows("reports", "view") or access.allows("exception_alerts", "view")


def payload_for(db: Session, entry: ExceptionLogEntry, tzinfo, *, open_log: bool = True,
                fallback_url: str = "/dashboard/alerts") -> Dict[str, Any]:
    """What the phone shows: title (type · till), body (shop · what · time), where a tap leads."""
    category = category_of(entry)
    shop, till = _names(db, entry)
    local = aware(entry.occurred_at).astimezone(tzinfo)
    what = M.what_of(label_of(entry.kind), entry.kind, entry.amount, None, False)
    summary = entry.summary if entry.summary and entry.kind not in ("refund", "line_void") else None
    title = " · ".join(p for p in (CATEGORY_BY_KEY[category].label if category else label_of(entry.kind), till) if p)
    if category == INTEGRITY.key:
        # From any organization: which company, what (its document / Z number is in the summary),
        # the amount or the gap.
        money = M.money(entry.amount) if entry.amount is not None and Decimal(str(entry.amount)) != 0 else None
        detail = f"{summary} ({money})" if summary and money else (summary or what)
        body = " · ".join(p for p in (_company_name(db, entry.company_id), shop, detail, local.strftime("%H:%M")) if p)
    elif entry.kind == "device_battery":
        body = " · ".join(p for p in (_battery_line(db, entry, shop, till), local.strftime("%H:%M")) if p)
    elif category in WHO_WHY_CATEGORIES:
        # Who did it, who approved, why, which document (push-more §B, §B2) — what the SMS says too.
        body = " · ".join(p for p in (shop, summary or what, *who_why(db, entry), local.strftime("%H:%M")) if p)
    else:
        body = " · ".join(p for p in (shop, summary or what, local.strftime("%H:%M")) if p)
    details = entry.details if isinstance(entry.details, dict) else {}
    if entry.kind == "target_reached" and details.get("eventId"):
        url = f"/dashboard/live-event/{details['eventId']}"
    elif open_log and entry.short_code:
        url = f"/x/{entry.short_code}"
    else:
        url = fallback_url
    # A till's state (offline) replaces its previous notice; every other alert stands on its own.
    tag = f"{entry.kind}:{entry.machine_id or entry.shop_id}" if entry.kind in STATE_KINDS else f"entry:{entry.id}"

    return {
        "title": title[:120],
        "body": body[:240],
        "url": url,
        "tag": tag[:64],
        "kind": entry.kind,
        "category": category,
        "severity": entry.severity,
        "entryId": str(entry.id),
        "at": aware(entry.occurred_at).isoformat(),
    }


def digest_payload(count: int, kinds: Sequence[str], since: str, until: str, quiet: bool,
                   url: str = "/dashboard/alerts") -> Dict[str, Any]:
    labels = ", ".join(dict.fromkeys(kinds))
    return {
        "title": f"{count} התראות חדשות",
        "body": f"{labels} · {since}–{until}" + (" (שעות שקט)" if quiet else ""),
        "url": url,
        "tag": "digest",
        "kind": "digest",
    }


# ── Sending ──────────────────────────────────────────────────────────────────

#: "thread" (production: a background sender), "inline" (tests: send in the caller), "off".
SEND_MODE = "thread"
#: The HTTP client the sender posts with (tests replace it); None = httpx.
TRANSPORT: Any = None
#: The session factory the sender records results with (None = app.database.SessionLocal).
SESSION_FACTORY: Optional[Callable[[], Session]] = None

_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()
_thread: Optional[threading.Thread] = None
_lock = threading.Lock()


def endpoint_hash(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


def _job(row: ExceptionAlertDispatch, device: PushSubscription, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "dispatchId": row.id, "subscriptionId": device.id, "endpoint": device.endpoint,
        "p256dh": device.p256dh, "auth": device.auth, "payload": payload, "topic": payload.get("tag"),
    }


def _record(db: Session, job: Dict[str, Any], result: Any, now: datetime) -> bool:
    row = db.get(ExceptionAlertDispatch, job["dispatchId"])
    if row is None:
        return False
    row.status = ST_SENT if result.ok else ST_FAILED
    row.reason = None if result.ok else (result.error or "failed")[:120]
    row.sent_at = now if result.ok else None
    device = db.get(PushSubscription, job["subscriptionId"])
    if device is not None:
        if result.ok:
            device.last_success_at = now
            device.failure_count = 0
            device.last_error = None
        else:
            device.last_failure_at = now
            device.failure_count = int(device.failure_count or 0) + 1
            device.last_error = (result.error or "failed")[:200]
            if result.gone or device.failure_count >= MAX_FAILURES:
                device.disabled_at = now
    db.flush()
    return True


def _send(job: Dict[str, Any]):
    from app.services import webpush

    vapid = webpush.config()
    if vapid is None:
        return webpush.SendResult(ok=False, status=None, error="push_not_configured")
    return webpush.send(job["endpoint"], job["p256dh"], job["auth"], job["payload"], vapid=vapid,
                        topic=job.get("topic"), client=TRANSPORT)


def _factory() -> Session:
    if SESSION_FACTORY is not None:
        return SESSION_FACTORY()
    from app.database import SessionLocal

    return SessionLocal()


def _worker_loop() -> None:
    from app.services.exception_alerts.hooks import SKIP

    while True:
        job = _queue.get()
        try:
            result = _send(job)
            db = _factory()
            db.info[SKIP] = True
            try:
                if _record(db, job, result, utcnow()):
                    db.commit()
            finally:
                db.close()
        except Exception:  # noqa: BLE001 - one message never stops the sender
            logger.exception("push: sending a message failed")


PENDING_JOBS = "push_pending_jobs"


def _enqueue(jobs: Iterable[Dict[str, Any]]) -> None:
    global _thread
    with _lock:
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_worker_loop, name="push-sender", daemon=True)
            _thread.start()
    for job in jobs:
        _queue.put(job)


def _submit(db: Session, job: Dict[str, Any]) -> None:
    """
    Inline (tests): send now. Thread (production): held on the session and handed to the sender
    only once the transaction that wrote its dispatch row commits — a rolled-back row never
    sends, and the sender always finds the row it records the result on.
    """
    if SEND_MODE == "off":
        return
    if SEND_MODE == "inline":
        _record(db, job, _send(job), utcnow())
        return
    db.info.setdefault(PENDING_JOBS, []).append(job)


def _install_session_hooks() -> None:
    from sqlalchemy import event

    def after_commit(session):
        if session.in_nested_transaction():
            return  # a savepoint's release: the real commit is still to come
        jobs = session.info.pop(PENDING_JOBS, None)
        if jobs:
            _enqueue(jobs)

    def after_rollback(session):
        if session.in_nested_transaction():
            return  # a savepoint: the engine trims what was queued inside it (engine.process_entry)
        session.info.pop(PENDING_JOBS, None)

    if not event.contains(Session, "after_commit", after_commit):
        event.listen(Session, "after_commit", after_commit)
        event.listen(Session, "after_rollback", after_rollback)


_install_session_hooks()


def _deliver(
    db: Session,
    *,
    rule: ExceptionAlertRule,
    kind: str,
    devices: Iterable[PushSubscription],
    payload: Dict[str, Any],
    status: Optional[str],
    reason: Optional[str],
    dedupe_prefix: str,
    now: datetime,
    entry: Optional[ExceptionLogEntry] = None,
    digest_count: Optional[int] = None,
) -> List[ExceptionAlertDispatch]:
    """One row per device, claimed before anything is sent; `status` given = held back."""
    out: List[ExceptionAlertDispatch] = []
    jobs: List[Dict[str, Any]] = []
    for device in devices:
        row = ExceptionAlertDispatch(
            id=uuid.uuid4(),
            tenant_id=rule.tenant_id,
            rule_id=rule.id,
            entry_id=entry.id if entry is not None else None,
            channel=CHANNEL_PUSH,
            user_id=device.user_id,
            subscription_id=device.id,
            kind=kind,
            status=status or ST_QUEUED,
            reason=reason,
            provider="webpush",
            recipient_hash=device.endpoint_hash,
            recipient_masked=(device.label or "מכשיר")[:32],
            recipient_label=device.label,
            text=f"{payload.get('title')}\n{payload.get('body')}"[:1000],
            dedupe_key=f"push:{dedupe_prefix}:{device.endpoint_hash[:16]}"[:200],
            digest_count=digest_count,
            created_by=None,
            created_at=now,
        )
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            continue  # already attempted for this device
        out.append(row)
        if status is None:
            jobs.append(_job(row, device, payload))
    db.flush()
    for job in jobs:
        _submit(db, job)
    return out


def process_entry(db: Session, entry: ExceptionLogEntry, *, now: datetime, tzinfo=None) -> List[ExceptionAlertDispatch]:
    """Every push rule the entry matches: send, or hold back (stale / quiet hours / rate limit)."""
    from app.models.user import User
    from app.services.exception_alerts import engine as E

    out: List[ExceptionAlertDispatch] = []
    category = category_of(entry)
    if entry.backfilled or category is None:
        return out
    if category == INTEGRITY.key:
        # Super admins only, from every organization (never by a tenant's rules).
        recipients = integrity_recipients(db, entry)
    else:
        gate = org_gate(db, entry)
        if not gate.allowed:
            return out  # logged; the organization does not send this kind from there
        recipients = []
        for candidate in push_rules_for(db, entry):
            owner = db.get(User, candidate.owner_user_id)
            if not entry_matches(db, candidate, entry, owner, gate):
                continue
            devices = devices_of(db, candidate.owner_user_id)
            if devices:
                recipients.append((owner, candidate, devices))
    for owner, candidate, devices in recipients:
        rule = (
            db.query(ExceptionAlertRule)
            .filter(ExceptionAlertRule.id == candidate.id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if rule is None or not rule.enabled or rule.deleted_at is not None:
            continue
        tzinfo = tzinfo or E.tz_for(db, entry.tenant_id)
        status, reason = None, None
        if now - aware(entry.occurred_at) > E.STALE_AFTER:
            status, reason = ST_SUPPRESSED_STALE, "occurred_long_ago"
        elif E.in_quiet_hours(rule, now.astimezone(tzinfo)):
            status, reason = ST_SUPPRESSED_QUIET, f"{rule.quiet_from}-{rule.quiet_to}"
        elif not is_urgent(entry) and E.rate_limited(db, rule, now):
            status, reason = ST_SUPPRESSED_RATE, f"{rule.rate_limit_minutes}m"
        out.extend(_deliver(
            db, rule=rule, kind=DISPATCH_ALERT, devices=devices,
            payload=payload_for(db, entry, tzinfo, open_log=may_open_log(db, owner), fallback_url=home_url(db, owner)),
            status=status, reason=reason, dedupe_prefix=f"alert:{entry.id}:{rule.id}", now=now, entry=entry,
        ))
    return out


def flush_rule(db: Session, rule: ExceptionAlertRule, now: datetime) -> int:
    """The digest of a push rule: what the limit / quiet hours held back, one message per device."""
    from app.services.exception_alerts import engine as E

    tzinfo = E.tz_for(db, rule.tenant_id)
    if E.in_quiet_hours(rule, now.astimezone(tzinfo)):
        return 0
    made_urgent = _flush_urgent(db, rule, now, tzinfo)
    if not rule.digest_enabled:
        # No digest: what was held back stays unsent (as before), closed so it is not looked at again.
        for d in _held(db, rule):
            d.digest_id = d.id
        db.flush()
        return made_urgent
    if E.rate_limited(db, rule, now):
        return made_urgent
    pending = _held(db, rule)
    if not pending:
        return made_urgent
    entry_ids = list(dict.fromkeys(d.entry_id for d in pending if d.entry_id is not None))
    entries = db.query(ExceptionLogEntry).filter(ExceptionLogEntry.id.in_(entry_ids)).all() if entry_ids else []
    entries.sort(key=lambda e: aware(e.occurred_at))
    devices = devices_of(db, rule.owner_user_id)
    if not entries or not devices:
        for d in pending:
            d.digest_id = d.id
        db.flush()
        return made_urgent
    from app.models.user import User

    owner = db.get(User, rule.owner_user_id)
    if len(entries) == 1:
        payload = payload_for(db, entries[0], tzinfo, open_log=may_open_log(db, owner), fallback_url=home_url(db, owner))
    else:
        payload = digest_payload(
            len(entries), [CATEGORY_BY_KEY[c].label for c in (category_of(e) for e in entries) if c],
            aware(entries[0].occurred_at).astimezone(tzinfo).strftime("%H:%M"),
            aware(entries[-1].occurred_at).astimezone(tzinfo).strftime("%H:%M"),
            all(d.status == ST_SUPPRESSED_QUIET for d in pending),
            url=home_url(db, owner),
        )
    made = _deliver(
        db, rule=rule, kind=DISPATCH_DIGEST, devices=devices, payload=payload, status=None, reason=None,
        dedupe_prefix=f"digest:{rule.id}:{pending[0].id}", now=now, digest_count=len(entries),
    )
    digest_id = made[0].id if made else pending[0].id
    for d in pending:
        d.digest_id = digest_id
    db.flush()
    return len(made) + made_urgent


def _held(db: Session, rule: ExceptionAlertRule) -> List[ExceptionAlertDispatch]:
    return (
        db.query(ExceptionAlertDispatch)
        .filter(
            ExceptionAlertDispatch.rule_id == rule.id,
            ExceptionAlertDispatch.kind == DISPATCH_ALERT,
            ExceptionAlertDispatch.status.in_(SUPPRESSED_STATUSES),
            ExceptionAlertDispatch.digest_id.is_(None),
        )
        .order_by(ExceptionAlertDispatch.created_at, ExceptionAlertDispatch.id)
        .all()
    )


def _flush_urgent(db: Session, rule: ExceptionAlertRule, now: datetime, tzinfo) -> int:
    """
    Urgent alerts the quiet hours held back (push-more §B2): each on its own, now — never folded into
    a digest, never waiting for the rate limit. Their held rows are closed on the message sent.
    """
    from app.models.user import User

    held = [d for d in _held(db, rule) if d.entry_id is not None]
    entries = {e.id: e for e in db.query(ExceptionLogEntry).filter(
        ExceptionLogEntry.id.in_(list({d.entry_id for d in held}))).all()} if held else {}
    urgent = [d for d in held if entries.get(d.entry_id) is not None and is_urgent(entries[d.entry_id])]
    if not urgent:
        return 0
    owner = db.get(User, rule.owner_user_id)
    by_entry: Dict[Any, List[ExceptionAlertDispatch]] = {}
    for d in urgent:
        by_entry.setdefault(d.entry_id, []).append(d)
    devices = {d.id: d for d in devices_of(db, rule.owner_user_id)}
    made = 0
    for entry_id, rows in by_entry.items():
        entry = entries[entry_id]
        targets = [devices[r.subscription_id] for r in rows if r.subscription_id in devices]
        sent = _deliver(
            db, rule=rule, kind=DISPATCH_ALERT, devices=targets,
            payload=payload_for(db, entry, tzinfo, open_log=may_open_log(db, owner), fallback_url=home_url(db, owner)),
            status=None, reason=None, dedupe_prefix=f"late:{entry.id}:{rule.id}", now=now, entry=entry,
        )
        for r in rows:
            r.digest_id = sent[0].id if sent else r.id
        made += len(sent)
    db.flush()
    return made


def send_test(db: Session, user: Any, tenant_id: Any, *, now: Optional[datetime] = None) -> List[ExceptionAlertDispatch]:
    """"שליחת התראת בדיקה" to every device of the user (the rule is created when missing)."""
    now = now or utcnow()
    devices = devices_of(db, user.id)
    if not devices:
        raise RuleError("no_devices", "devices")
    last = (
        db.query(ExceptionAlertDispatch.created_at)
        .filter(ExceptionAlertDispatch.user_id == user.id, ExceptionAlertDispatch.kind == DISPATCH_TEST)
        .order_by(ExceptionAlertDispatch.created_at.desc())
        .first()
    )
    if last is not None and now - aware(last[0]) < TEST_MIN_GAP:
        raise RuleError("test_too_soon", None)
    rule = rule_for_user(db, user.id, tenant_id) or save_preferences(db, user, tenant_id, {})
    payload = {"title": "התראת בדיקה", "body": "ההתראות לטלפון פועלות במכשיר הזה.", "url": home_url(db, user),
               "tag": "test", "kind": "test"}
    return _deliver(db, rule=rule, kind=DISPATCH_TEST, devices=devices, payload=payload, status=None, reason=None,
                    dedupe_prefix=f"test:{uuid.uuid4().hex}", now=now)


def retry_stale(db: Session, *, now: Optional[datetime] = None) -> int:
    """Push dispatches left `queued` (the process that wrote them died): sent again, at most MAX_ATTEMPTS."""
    now = now or utcnow()
    rows = (
        db.query(ExceptionAlertDispatch)
        .filter(
            ExceptionAlertDispatch.channel == CHANNEL_PUSH,
            ExceptionAlertDispatch.status == ST_QUEUED,
            ExceptionAlertDispatch.created_at < now - RETRY_AFTER,
            ExceptionAlertDispatch.created_at > now - timedelta(hours=6),
        )
        .limit(200)
        .all()
    )
    done = 0
    for row in rows:
        attempts = int((row.reason or "attempt:0").split(":")[-1] or 0) if (row.reason or "").startswith("attempt:") else 0
        device = db.get(PushSubscription, row.subscription_id) if row.subscription_id else None
        if device is None or device.disabled_at is not None or attempts + 1 >= MAX_ATTEMPTS:
            row.status, row.reason = ST_FAILED, "gave_up"
            continue
        row.reason = f"attempt:{attempts + 1}"
        title, _, body = (row.text or "").partition("\n")
        payload = {"title": title, "body": body, "url": "/dashboard/alerts", "tag": f"retry:{row.entry_id or row.id}"}
        _record(db, _job(row, device, payload), _send(_job(row, device, payload)), now)
        done += 1
    db.flush()
    return done


# ── Devices ──────────────────────────────────────────────────────────────────


def device_label(user_agent: Optional[str]) -> str:
    """"Chrome · Android" from a user agent (pure; good enough to tell one's devices apart)."""
    ua = user_agent or ""
    browser = (
        "Edge" if "Edg/" in ua else "Samsung Internet" if "SamsungBrowser" in ua else "Chrome" if "Chrome/" in ua
        else "Firefox" if "Firefox/" in ua else "Safari" if "Safari/" in ua else "דפדפן"
    )
    system = (
        "Android" if "Android" in ua else "iPhone" if "iPhone" in ua else "iPad" if "iPad" in ua
        else "Windows" if "Windows" in ua else "Mac" if "Mac OS X" in ua else "Linux" if "Linux" in ua else None
    )
    return f"{browser} · {system}" if system else browser


#: The browsers' push services — the only hosts the server ever posts to (a subscription is
#: an address the browser hands us; anything else would make the server call any URL).
PUSH_SERVICE_HOSTS = (
    "fcm.googleapis.com",            # Chrome, Edge (Chromium), Samsung Internet, Opera
    ".push.services.mozilla.com",    # Firefox
    ".notify.windows.com",           # legacy Edge / Windows
    ".push.apple.com",               # Safari, iOS home-screen apps
)
#: Devices per user; subscribing one more retires the least recently used.
MAX_DEVICES = 10


def push_service_endpoint(endpoint: str) -> bool:
    """An https URL on a known push service (a host name, never an address), default port."""
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.port not in (None, 443) or parts.username or parts.password:
        return False
    return any(host == h or (h.startswith(".") and host.endswith(h)) for h in PUSH_SERVICE_HOSTS)


def subscribe(db: Session, user: Any, tenant_id: Any, *, endpoint: str, p256dh: str, auth: str,
              user_agent: Optional[str] = None, label: Optional[str] = None,
              initial: Optional[Dict[str, Any]] = None) -> PushSubscription:
    """
    Add (or move to this user, or revive) a device. Validated; the caller commits. The first
    device of a user creates their preferences — `initial` narrows them (the shop / event the
    person subscribed from), else every alert type, everywhere they may see.
    """
    from app.services import webpush

    endpoint = (endpoint or "").strip()
    if len(endpoint) > 2000 or not push_service_endpoint(endpoint):
        raise RuleError("endpoint_invalid", "endpoint")
    if not webpush.valid_client_key(p256dh, auth):
        raise RuleError("keys_invalid", "keys")
    hashed = endpoint_hash(endpoint)
    row = db.query(PushSubscription).filter(PushSubscription.endpoint_hash == hashed).first()
    if row is None:
        row = PushSubscription(id=uuid.uuid4(), endpoint=endpoint, endpoint_hash=hashed, user_id=user.id)
        db.add(row)
    row.user_id = user.id
    row.tenant_id = tenant_id
    row.p256dh = p256dh.strip()
    row.auth = auth.strip()
    row.user_agent = (user_agent or "")[:300] or None
    row.label = (" ".join((label or "").split())[:120] or None) or device_label(user_agent)
    row.disabled_at = None
    row.failure_count = 0
    row.last_error = None
    db.flush()
    active = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user.id, PushSubscription.disabled_at.is_(None), PushSubscription.id != row.id)
        .order_by(func.coalesce(PushSubscription.last_success_at, PushSubscription.created_at).desc())
        .all()
    )
    for old in active[MAX_DEVICES - 1:]:
        old.disabled_at = utcnow()
    if rule_for_user(db, user.id, tenant_id) is None:
        narrowed = {k: v for k, v in (initial or {}).items() if k in ("shopIds", "eventIds") and v}
        save_preferences(db, user, tenant_id, narrowed)
    db.flush()
    return row


def device_json(row: PushSubscription, user: Any = None) -> Dict[str, Any]:
    def iso(v):
        v = aware(v)
        return v.isoformat() if v else None

    out = {
        "id": str(row.id),
        "label": row.label,
        "endpointHash": row.endpoint_hash,
        "createdAt": iso(row.created_at),
        "lastSuccessAt": iso(row.last_success_at),
        "lastFailureAt": iso(row.last_failure_at),
        "lastError": row.last_error,
        "active": row.disabled_at is None,
    }
    if is_super_admin(user):
        # "שלמות נתונים" on this device (a super admin may mute it on one of their devices).
        out["integrity"] = str(row.id) not in set(integrity_prefs(user)["mutedDeviceIds"])
    return out


def set_device_integrity(user: Any, device: PushSubscription, on: bool) -> None:
    """A super admin's "שלמות נתונים" on one of their devices, on or off. The caller commits."""
    muted = [d for d in integrity_prefs(user)["mutedDeviceIds"] if d != str(device.id)]
    if not on:
        muted.append(str(device.id))
    save_integrity_prefs(user, {"mutedDeviceIds": muted})


__all__ = [
    "CATEGORIES", "CATEGORY_KEYS", "INTEGRITY", "category_of", "categories_for", "clean", "as_json",
    "preferences_json", "save_preferences", "rule_for_user", "entry_matches", "integrity_recipients",
    "process_entry", "flush_rule", "send_test", "retry_stale", "subscribe", "device_label", "payload_for",
]
