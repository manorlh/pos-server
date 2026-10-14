"""
"שחזור שולחן עם התשלומים שלו, וזיכוי או ביטול תשלומים בתוך השולחן" (P:/specs/table-restore-payments.md):
the cloud's part. The till does the flow; here are

* **the till parameters** (§3, §5) — per company → shop → point of sale → till, like every till
  parameter (`PARAMETER_SPECS`, registered in app/services/till_parameters.py), edited on the
  dashboard's tables page (`level_view` / `save_values`, app/routers/table_restore.py);
* **the exceptions** (§3) — `payment_reversed` and `table_restored`, from the till's events
  (`POST /sync/{id}/events`) and, for a restore, from the cloud's own claim of the closed order
  (`record_restore_exception`, called by app/services/tables.py `mark_restored`);
* **the Z line** (§3) — "זיכויים וביטולי תשלום בשולחנות: N · ₪" (`z_reversals`), frozen on the Z's
  header and on each till's section at build time. Presentation only: the Z's figures are the
  documents' — the credit note in the table and the new payment net per tender by themselves.

**Values the till reads.** `restoreWindow` is `same_z` | `same_shift` | `any` | `hours:N`;
`reverseMethods` a comma list of `cash`, `card`, `voucher`, `external` (empty: none); the enums
`printCreditNote` (`ask` | `always` | `never`) and `billTipBase` (`balance` | `total`) are codes, with
their Hebrew for the dashboard (`enum_labels`). `clean_value` refuses anything else, whatever route
writes it.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# ── The till parameters (§3, §5) ──────────────────────────────────────────────

PREFIX_KEY = "restoredTablePrefix"
WINDOW_KEY = "restoreWindow"
PRINT_CREDIT_KEY = "printCreditNote"
METHODS_KEY = "reverseMethods"
CARD_VOID_KEY = "cardVoidWhenUntransmitted"
REVERSE_ALL_KEY = "reverseAllButton"
TIP_BASE_KEY = "billTipBase"
SHOW_PAID_ITEMS_KEY = "billShowPaidItems"

PREFIX_DEFAULT = "ש-"
PREFIX_MAX = 10

WINDOW_SAME_Z = "same_z"
WINDOW_SAME_SHIFT = "same_shift"
WINDOW_ANY = "any"
WINDOW_HOURS = "hours"
WINDOW_HOURS_MAX = 720
WINDOW_PATTERN = re.compile(r"^(same_z|same_shift|any|hours:([1-9][0-9]{0,2}))$")

PRINT_ASK = "ask"
PRINT_ALWAYS = "always"
PRINT_NEVER = "never"
PRINT_OPTIONS = (PRINT_ASK, PRINT_ALWAYS, PRINT_NEVER)
PRINT_LABELS = {
    PRINT_ASK: "לשאול — \"להדפיס חשבונית זיכוי?\"",
    PRINT_ALWAYS: "תמיד להדפיס",
    PRINT_NEVER: "לא להדפיס",
}

METHOD_CASH = "cash"
METHOD_CARD = "card"
METHOD_VOUCHER = "voucher"
METHOD_EXTERNAL = "external"
METHODS = (METHOD_CASH, METHOD_CARD, METHOD_VOUCHER, METHOD_EXTERNAL)
METHOD_LABELS = {
    METHOD_CASH: "מזומן",
    METHOD_CARD: "אשראי",
    METHOD_VOUCHER: "שובר / תשלום מראש",
    METHOD_EXTERNAL: "אמצעי חיצוני",
}
METHODS_DEFAULT = ",".join(METHODS)

TIP_BALANCE = "balance"
TIP_TOTAL = "total"
TIP_OPTIONS = (TIP_BALANCE, TIP_TOTAL)
TIP_LABELS = {TIP_BALANCE: "לפי היתרה לתשלום", TIP_TOTAL: "לפי הסכום הכולל"}

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=PREFIX_KEY,
        label="שחזור שולחן — קידומת כשהשולחן תפוס",
        value_type="string",
        default_value=PREFIX_DEFAULT,
        description=(
            "\"שחזר שולחן\" מרשימת \"נסגרו\": כשהשולחן פנוי, השחזור חוזר לאותו מספר. כשהוא תפוס, נפתח "
            f"שולחן חדש עם הקידומת הזו לפני המספר (\"{PREFIX_DEFAULT}12\"), ליד השולחן המקורי במפה או ברשימה. "
            f"עד {PREFIX_MAX} תווים. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=WINDOW_KEY,
        label="שחזור שולחן — עד מתי מותר",
        value_type="string",
        default_value=WINDOW_SAME_Z,
        description=(
            "מתי מותר לשחזר שולחן שנסגר. «same_z» (ברירת מחדל) — כל עוד ה-Z של המכירה המקורית לא נסגר; "
            "«same_shift» — באותה משמרת; «hours:N» — עד N שעות מסגירת השולחן (1–720); «any» — תמיד, "
            "כל עוד השולחן ברשימת \"נסגרו\". אחרי Z השחזור חסום כברירת מחדל. שולחן שבוטל בלי תשלום — "
            "חוזר כמו היום."
        ),
    ),
    dict(
        key=PRINT_CREDIT_KEY,
        label="זיכוי תשלום בשולחן — הדפסת חשבונית זיכוי",
        value_type="enum",
        enum_options=PRINT_OPTIONS,
        enum_labels=PRINT_LABELS,
        default_value=PRINT_ASK,
        description=(
            "כל זיכוי או ביטול של תשלום בתוך השולחן יוצר חשבונית זיכוי, מקושרת לחשבונית של אותו תשלום. "
            f"«{PRINT_LABELS[PRINT_ASK]}» (ברירת מחדל) — הקופה שואלת, כן או לא. "
            f"«{PRINT_LABELS[PRINT_ALWAYS]}» / «{PRINT_LABELS[PRINT_NEVER]}» — בלי לשאול."
        ),
    ),
    dict(
        key=METHODS_KEY,
        label="זיכוי תשלום בשולחן — אמצעים מותרים",
        value_type="string",
        default_value=METHODS_DEFAULT,
        description=(
            "אילו תשלומים אפשר לזכות או לבטל מתוך השולחן: cash (מזומן — המגירה נפתחת להחזרה), card (אשראי — "
            "ביטול עסקה שלא שודרה או זיכוי לכרטיס דרך המסוף), voucher (שובר או תשלום מראש — היתרה חוזרת "
            "לשובר), external (אמצעי חיצוני בלי חיבור — \"סמן כמוחזר\" עם הערה). רשימה מופרדת בפסיקים; "
            "ברירת מחדל — כולם. ריק — אף אחד."
        ),
    ),
    dict(
        key=CARD_VOID_KEY,
        label="זיכוי תשלום בשולחן — ביטול אשראי שלא שודר",
        value_type="boolean",
        default_value=True,
        description=(
            "דלוק (ברירת מחדל) — תשלום באשראי שעוד לא שודר מבוטל במסוף (\"בטל עסקה\") ויוצא מהשידור, בלי עמלה; "
            "אם המסוף לא תומך בביטול, הקופה מזכה לכרטיס. כבוי — תמיד זיכוי לכרטיס."
        ),
    ),
    dict(
        key=REVERSE_ALL_KEY,
        label="זיכוי תשלום בשולחן — כפתור \"בטל את כל התשלומים\"",
        value_type="boolean",
        default_value=True,
        description=(
            "דלוק (ברירת מחדל) — בשולחן עם תשלומים מוצג כפתור אחד שמבצע את כל הזיכויים והביטולים לפי הסדר, "
            "אשראי תמיד ראשון. כבוי — רק פעולה לכל תשלום."
        ),
    ),
    dict(
        key=TIP_BASE_KEY,
        label="חשבון שולחן — בסיס לטיפ המומלץ",
        value_type="enum",
        enum_options=TIP_OPTIONS,
        enum_labels=TIP_LABELS,
        default_value=TIP_BALANCE,
        description=(
            "החשבון המודפס של שולחן ששולם בו חלק מציג את הסכום הכולל, את מה ששולם ואת \"יתרה לתשלום\". "
            f"הטיפ המומלץ: «{TIP_LABELS[TIP_BALANCE]}» (ברירת מחדל) או «{TIP_LABELS[TIP_TOTAL]}»."
        ),
    ),
    dict(
        key=SHOW_PAID_ITEMS_KEY,
        label="חשבון שולחן — רשימת פריטים ששולמו",
        value_type="boolean",
        default_value=False,
        description=(
            "פריט ששולם בפיצול לפי פריט יוצא מהשולחן. דלוק — החשבון המודפס מציג גם את רשימת \"פריטים ששולמו\". "
            "כבוי (ברירת מחדל) — לא מוצגת."
        ),
    ),
)

#: The keys, in the order the dashboard lists them.
LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
SCOPE_TYPES = ("company", "shop", "area", "machine")
#: The keys whose value is checked beyond its type (`clean_value`).
VALIDATED_KEYS = frozenset({PREFIX_KEY, WINDOW_KEY, PRINT_CREDIT_KEY, METHODS_KEY, TIP_BASE_KEY})

#: The tables page's level card ("הגדרות שולחנות"): its groups, in the order it shows them — the staff /
#: managers' tables (app/services/table_policies.py, P:/specs/owner-decisions-1410.md §1), these, then the
#: map's legend and display (app/services/table_map_display.py, P:/specs/table-map-decor-v3.md §3), and
#: last the courses' auto-fire.
STAFF_TABLES_GROUP = "staffTables"
RESTORE_GROUP = "restore"
MAP_DISPLAY_GROUP = "mapDisplay"
#: "הוצאה אוטומטית של השלב הבא" (app/services/course_auto_fire.py, P:/specs/courses-fire-v2.md §1).
COURSES_GROUP = "courses"
#: "FIRE כמו במסעדות" and scheduled items (app/services/fire_flow.py, P:/specs/fire-restaurant-flow.md §8.1).
FIRE_FLOW_GROUP = "fireFlow"


def _page_groups() -> Tuple[Tuple[str, str, Tuple[str, ...]], ...]:
    from app.services import course_auto_fire, fire_flow, table_assignments, table_map_display, table_policies

    return (
        (STAFF_TABLES_GROUP, "שולחן עובדים / מנהלים", table_policies.LEVEL_KEYS),
        (RESTORE_GROUP, "שחזור שולחן ותשלומים בשולחן", LEVEL_KEYS),
        (MAP_DISPLAY_GROUP, "מפת השולחנות בקופה — מקרא ותצוגה", table_map_display.LEVEL_KEYS),
        # "שיוך מלצרים ושולחן תפוס" (P:/specs/table-waiter-assignment.md §1, §5, §8).
        (table_assignments.PAGE_GROUP, table_assignments.PAGE_GROUP_LABEL, table_assignments.LEVEL_KEYS),
        (COURSES_GROUP, "שלבי הגשה: הוצאה אוטומטית", course_auto_fire.LEVEL_KEYS),
        (FIRE_FLOW_GROUP, "שלבי הגשה: \"מתי עיקריות?\", שיגור מתוזמן והסבר לעובד", fire_flow.LEVEL_KEYS),
    )


Groups = Tuple[Tuple[str, str, Tuple[str, ...]], ...]


def page_keys(groups: Optional[Groups] = None) -> Tuple[str, ...]:
    """Every key the tables page's level card edits (or `groups`' keys), in its order."""
    return tuple(key for _group, _label, keys in (groups or _page_groups()) for key in keys)


def _group_of(key: str, groups: Optional[Groups] = None) -> Optional[str]:
    return next((group for group, _label, keys in (groups or _page_groups()) if key in keys), None)


def parse_methods(value: Any) -> List[str]:
    """`"card,cash"` → the methods in the catalogue's order; ValueError on an unknown or repeated one."""
    if not isinstance(value, str):
        raise ValueError(f"{METHODS_KEY} must be text")
    parts = [p.strip().lower() for p in value.split(",") if p.strip()]
    unknown = [p for p in parts if p not in METHODS]
    if unknown:
        raise ValueError(f"{METHODS_KEY}: unknown method {unknown[0]!r} (one of {', '.join(METHODS)})")
    if len(set(parts)) != len(parts):
        raise ValueError(f"{METHODS_KEY}: a method is listed twice")
    return [m for m in METHODS if m in parts]


def parse_window(value: Any) -> Tuple[str, Optional[int]]:
    """`"hours:6"` → ("hours", 6); `"same_z"` → ("same_z", None). ValueError otherwise."""
    if not isinstance(value, str):
        raise ValueError(f"{WINDOW_KEY} must be text")
    match = WINDOW_PATTERN.match(value.strip())
    if match is None:
        raise ValueError(f"{WINDOW_KEY} must be same_z, same_shift, any or hours:N (N 1–{WINDOW_HOURS_MAX})")
    if match.group(2) is None:
        return match.group(1), None
    hours = int(match.group(2))
    if hours > WINDOW_HOURS_MAX:
        raise ValueError(f"{WINDOW_KEY}: at most hours:{WINDOW_HOURS_MAX}")
    return WINDOW_HOURS, hours


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key` (normalised), or ValueError. Other keys pass as they are."""
    if value is None:
        return None
    if key == PREFIX_KEY:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{PREFIX_KEY} must be non-empty text")
        if len(value) > PREFIX_MAX:
            raise ValueError(f"{PREFIX_KEY} is at most {PREFIX_MAX} characters")
        return value
    if key == WINDOW_KEY:
        kind, hours = parse_window(value)
        return f"{WINDOW_HOURS}:{hours}" if kind == WINDOW_HOURS else kind
    if key == METHODS_KEY:
        return ",".join(parse_methods(value))
    if key == PRINT_CREDIT_KEY and value not in PRINT_OPTIONS:
        raise ValueError(f"{PRINT_CREDIT_KEY} must be one of {', '.join(PRINT_OPTIONS)}")
    if key == TIP_BASE_KEY and value not in TIP_OPTIONS:
        raise ValueError(f"{TIP_BASE_KEY} must be one of {', '.join(TIP_OPTIONS)}")
    return value


# ── One level, as the dashboard's tables page edits it ─────────────────────────


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def level_view(db, scope_type: str, scope_id: Any, groups: Optional[Groups] = None) -> Dict[str, Any]:
    """
    What one level sets itself (`own`), what it inherits from the levels above or the default
    (`inherited`), and the definitions — the tables page's "הגדרות שולחנות" card: the staff / managers'
    tables' `staffTableDiscountCheck`, the eight of restoring and reversing, and the map's four of legend
    and display (`mapDecor`…), each with its `group`. `groups` (key, label, keys): another card's — the
    till design's "שולחנות ומפה" (app/routers/till_design.py `/till-design/table-display`).
    """
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.kds_workflow import chain_for_scope
    from app.services.till_parameters import (
        enum_labels,
        ensure_builtin_parameters,
        option_warnings,
        resolve_till_parameters,
    )

    ensure_builtin_parameters(db)
    keys = page_keys(groups)
    params = db.query(TillParameter).filter(TillParameter.key.in_(keys)).all()
    by_key = {p.key: p for p in params}
    by_id = {p.id: p for p in params}
    ident = _uuid(scope_id)
    own_rows = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_(list(by_id)),
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == ident,
        )
        .all()
    ) if params else []
    own = {by_id[r.parameter_id].key: r.value for r in own_rows if r.parameter_id in by_id}
    above, _shop = chain_for_scope(db, scope_type, ident, above_only=True)
    scopes = above.scopes()
    values = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_(list(by_id)),
            or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
        )
        .all()
    ) if scopes and params else []
    inherited = resolve_till_parameters(params, values, above).parameters
    return {
        "scopeType": scope_type,
        "scopeId": str(ident),
        "own": own,
        "inherited": inherited,
        "parameters": [
            {
                "key": key,
                "label": by_key[key].label,
                "description": by_key[key].description,
                "valueType": by_key[key].value_type,
                "enumOptions": by_key[key].enum_options,
                "enumLabels": enum_labels(key),
                "optionWarnings": option_warnings(key),
                "defaultValue": by_key[key].default_value,
                "group": _group_of(key, groups),
            }
            for key in keys
            if key in by_key and by_key[key].is_active
        ],
        "groups": [{"key": group, "label": label} for group, label, _keys in (groups or _page_groups())],
        "methods": [{"key": m, "label": METHOD_LABELS[m]} for m in METHODS],
    }


def save_values(
    db, scope_type: str, scope_id: Any, values: Dict[str, Any], *, user: Any, groups: Optional[Groups] = None,
) -> list:
    """
    Write `values` (key → value; None clears the level's own value) at one level, each with its
    row in the change log (`till_parameter_changes`), in the caller's transaction. Returns the
    tills to notify. Raises `TillParameterValueError` on a value its definition refuses, or on a
    key outside the card (`groups`, else the tables page's).
    """
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import (
        TillParameterValueError,
        ensure_builtin_parameters,
        notify_targets_for_scope,
        validate_keyed_value,
        validate_value,
        write_value,
    )

    keys = page_keys(groups)
    unknown = [k for k in values if k not in keys]
    if unknown:
        raise TillParameterValueError(f"unknown parameter {unknown[0]}")
    ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(keys)).all()}
    ident = _uuid(scope_id)
    now = datetime.now(timezone.utc)
    for key, value in values.items():
        parameter = params.get(key)
        if parameter is None:
            continue
        stored = None
        if value is not None:
            stored = validate_keyed_value(key, validate_value(parameter.value_type, value, parameter.enum_options))
        write_value(db, parameter, scope_type, ident, stored, user=user, now=now)
    db.flush()
    return notify_targets_for_scope(db, scope_type, ident)


# ── The restore window, as the cloud knows it (§1 "מתי מותר לשחזר") ─────────────


def payment_state(db, orders: Sequence[Any], ids_of) -> Dict[str, Dict[str, Any]]:
    """
    Per closed order (by id): where its payment documents stand — `zClosed` (one of them is in a
    Z: `same_z` refuses), `paymentShiftsOpen` (every one of them is in a shift still open:
    `same_shift` allows) and `paymentShiftIds`. What the till cannot know of a sale another till
    took. An order with no payment document known here: not in a Z, no shift.
    """
    from app.models.shift import Shift, ShiftStatus
    from app.models.transaction import Transaction

    wanted: Dict[str, List[uuid.UUID]] = {}
    for order in orders:
        wanted[str(order.id)] = [i for i in (_uuid(t) for t in ids_of(order)) if i is not None]
    every = {i for ids in wanted.values() for i in ids}
    shift_of: Dict[uuid.UUID, Optional[uuid.UUID]] = {}
    if every:
        for tx_id, shift_id in db.query(Transaction.id, Transaction.shift_id).filter(Transaction.id.in_(every)).all():
            shift_of[tx_id] = shift_id
    shift_ids = {s for s in shift_of.values() if s is not None}
    shifts = {
        row[0]: (row[1], row[2])
        for row in db.query(Shift.id, Shift.status, Shift.z_report_id).filter(Shift.id.in_(shift_ids)).all()
    } if shift_ids else {}
    out: Dict[str, Dict[str, Any]] = {}
    for order_id, ids in wanted.items():
        mine = [shift_of.get(i) for i in ids if shift_of.get(i) is not None]
        known = [shifts[s] for s in mine if s in shifts]
        status_of = lambda s: getattr(s, "value", s)  # noqa: E731 - the enum or its string (SQLite)
        out[order_id] = {
            "zClosed": any(z is not None for _st, z in known),
            "paymentShiftsOpen": bool(known) and all(status_of(st) == ShiftStatus.OPEN.value and z is None for st, z in known),
            "paymentShiftIds": sorted({str(s) for s in mine}),
        }
    return out


# ── Exceptions (§3 "יומן חריגים") ──────────────────────────────────────────────

REVERSED_KIND = "payment_reversed"
RESTORED_KIND = "table_restored"
KINDS = (REVERSED_KIND, RESTORED_KIND)

#: What each reversal is called in a line (`details.action`, else by tender).
ACTION_LABELS = {
    "cash_refund": "זיכוי מזומן",
    "card_void": "ביטול עסקת אשראי",
    "card_refund": "זיכוי לכרטיס",
    "voucher_refund": "החזר לשובר",
    "mark_refunded": "סומן כמוחזר",
}
TENDER_ACTIONS = {
    METHOD_CASH: "cash_refund",
    METHOD_CARD: "card_refund",
    METHOD_VOUCHER: "voucher_refund",
    METHOD_EXTERNAL: "mark_refunded",
}

#: A namespace for the till event a restore claimed in the cloud is recorded under (one per order).
_EVENT_NAMESPACE = uuid.UUID("7d3f1c2a-9b84-4e61-a5d0-2c6e8f1b4a93")

_CENT = Decimal("0.01")


def _dec(value: Any) -> Optional[Decimal]:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError):
        return None


def _shekels(value: Optional[Decimal]) -> str:
    return f"₪{abs(value):,.2f}" if value is not None else "—"


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _table_words(details: Dict[str, Any]) -> Optional[str]:
    number = _text(details.get("tableNumber"))
    name = _text(details.get("tableName"))
    if name and number and name != number:
        return f"שולחן {name} ({number})"
    if name or number:
        return f"שולחן {name or number}"
    return None


def reversal_summary(details: Dict[str, Any], amount: Optional[Decimal]) -> str:
    """
    "שולחן 12 · זיכוי לכרטיס ₪180.00 (טיפ ₪10.00) · ביקש: דנה · אישר: רותי · חשבונית 1001 → זיכוי 2001"
    — the line the exceptions log shows.
    """
    tender = (_text(details.get("tender")) or "").lower()
    action = _text(details.get("action")) or TENDER_ACTIONS.get(tender)
    what = ACTION_LABELS.get(action or "", METHOD_LABELS.get(tender, "זיכוי תשלום"))
    money = _shekels(amount if amount is not None else _dec(details.get("amount")))
    head = f"{what} {money}"
    tip = _dec(details.get("tip"))
    if tip:
        head += f" (טיפ {_shekels(tip)})"
    if details.get("partial") is True:
        head += " — חלקי"
    parts = [_table_words(details), head]
    requested = _text(details.get("requestedBy"))
    approved = _text(details.get("approvedBy"))
    performed = _text(details.get("performedBy"))
    if requested:
        parts.append(f"ביקש: {requested}")
    if approved:
        parts.append(f"אישר: {approved}")
    if performed and performed not in (requested, approved):
        parts.append(f"ביצע: {performed}")
    original = _text(details.get("originalTransactionNumber"))
    credit = _text(details.get("creditTransactionNumber"))
    if original and credit:
        parts.append(f"חשבונית {original} → זיכוי {credit}")
    elif original:
        parts.append(f"חשבונית {original}")
    elif credit:
        parts.append(f"זיכוי {credit}")
    note = _text(details.get("note"))
    if note:
        parts.append(note[:120])
    return " · ".join(p for p in parts if p)


def restore_summary(details: Dict[str, Any], amount: Optional[Decimal]) -> str:
    """"שולחן 12 → ש-12 · שולם ₪180.00 · 2 תשלומים · שחזר: דנה · אישר: רותי" — the log's line."""
    head = _table_words(details) or "שולחן"
    restored_as = _text(details.get("restoredAs"))
    if restored_as and restored_as != _text(details.get("tableNumber")) and restored_as != _text(details.get("tableName")):
        head += f" → {restored_as}"
    parts = [head]
    if amount:
        parts.append(f"שולם {_shekels(amount)}")
    elif details.get("status") == "cancelled":
        parts.append("בוטל בלי תשלום")
    ids = details.get("transactionIds")
    if isinstance(ids, list) and ids:
        parts.append("תשלום אחד" if len(ids) == 1 else f"{len(ids)} תשלומים")
    who = _text(details.get("restoredBy")) or _text(details.get("requestedBy"))
    if who:
        parts.append(f"שחזר: {who}")
    approved = _text(details.get("approvedBy"))
    if approved:
        parts.append(f"אישר: {approved}")
    return " · ".join(parts)


def dedupe_key(kind: str, event) -> str:
    """
    One exception per reversal's credit document (a till that sends it twice under two ids is
    still one), and per restored order (the cloud's claim and the till's own event are one).
    """
    details = event.details if isinstance(event.details, dict) else {}
    if kind == REVERSED_KIND:
        ident = event.transaction_id or _uuid(details.get("creditTransactionId"))
        return f"{kind}:{ident or event.id}"
    order = _text(details.get("orderId"))
    return f"{kind}:{order or event.id}"


def detect_event(event, rules: Dict[str, Any]) -> list:
    """`payment_reversed` (≥ the rule's ₪) and `table_restored`, as `exceptions.Found`s."""
    from app.services.exceptions import Found, _meets, _utc

    kind = event.event_type
    rule = rules.get(kind)
    if rule is None or not rule.enabled:
        return []
    details = dict(event.details) if isinstance(event.details, dict) else {}
    amount = abs(_dec(event.amount)) if _dec(event.amount) is not None else None
    if amount is None and _dec(details.get("amount")) is not None:
        amount = abs(_dec(details.get("amount")))
    threshold = None
    if kind == REVERSED_KIND:
        minimum = rule.params.get("minAmount", 0)
        if not _meets(amount or Decimal("0"), minimum):
            return []
        threshold = _dec(minimum)
        details["summary"] = reversal_summary(details, amount)
    else:
        details["summary"] = restore_summary(details, amount)
    return [Found(
        type=kind, key=dedupe_key(kind, event)[:200], amount=amount, threshold=threshold, details=details,
        occurred_at=_utc(event.occurred_at) or datetime.now(timezone.utc), pos_user_id=event.pos_user_id,
        transaction_id=event.transaction_id, shift_id=event.shift_id, till_event_id=event.id,
    )]


def merged_details(db, found) -> Dict[str, Any]:
    """
    A restore reported twice — by the cloud when the till claimed the order and by the till
    after it opened it: what the first one said, with what the second adds on top.
    """
    from app.models.audit_exception import AuditException

    existing = db.query(AuditException.details).filter(AuditException.dedupe_key == found.key).first()
    before = existing[0] if existing is not None and isinstance(existing[0], dict) else {}
    merged = {**before, **{k: v for k, v in (found.details or {}).items() if v is not None}}
    amount = found.amount if found.amount is not None else _dec(merged.get("amount"))
    merged["summary"] = restore_summary(merged, amount)
    return merged


def record_restore_exception(
    db, machine, order, *, restored_by: Optional[str], approved_by: Optional[str], restored_by_id: Optional[str] = None,
) -> None:
    """
    The cloud's own record of a restore it let a till claim ("שחזור שולחן", `mark_restored`): a till
    event `table_restored` (one per order) and its exception. Never fails the restore.
    """
    try:
        from app.models.audit_exception import TillEvent
        from app.services import exceptions as EX
        from app.services.tables import _transaction_ids

        if RESTORED_KIND not in EX.RULES_BY_TYPE:
            return
        event_id = uuid.uuid5(_EVENT_NAMESPACE, f"{RESTORED_KIND}:{order.id}")
        event = db.get(TillEvent, event_id)
        paid = order.paid_total if order.status == "paid" and order.paid_total is not None else None
        if event is None:
            event = TillEvent(
                id=event_id,
                tenant_id=machine.tenant_id,
                machine_id=machine.id,
                shop_id=machine.shop_id,
                area_id=machine.area_id,
                shift_id=None,
                event_type=RESTORED_KIND,
                occurred_at=order.restored_at or datetime.now(timezone.utc),
                pos_user_id=restored_by_id,
                amount=paid,
                transaction_id=None,
                details={
                    "source": "tables",
                    "orderId": str(order.id),
                    "tableNumber": order.table_number,
                    "tableName": order.table_name,
                    "status": order.status,
                    "paidTotal": float(paid) if paid is not None else None,
                    "transactionIds": _transaction_ids(order),
                    "transactionNumber": order.transaction_number,
                    "restoredBy": restored_by,
                    "approvedBy": approved_by,
                },
                received_at=datetime.now(timezone.utc),
            )
            with db.begin_nested():
                db.add(event)
                db.flush()
        EX.Detector(db).event(event)
    except Exception:  # noqa: BLE001 - an exception missed is found by a rescan
        logger.exception("could not report restored table %s to the exceptions", getattr(order, "id", None))


# ── The Z line (§3 "דוחות ו-Z") ────────────────────────────────────────────────

#: The key on a Z's header and on each till's section: `{count, amount}` — only when there were any.
Z_KEY = "tablePaymentReversals"
Z_LABEL = "זיכויים וביטולי תשלום בשולחנות"


def _block(count: int, amount: Decimal) -> Optional[Dict[str, Any]]:
    if count <= 0:
        return None
    return {"count": count, "amount": str(amount.quantize(_CENT, rounding=ROUND_HALF_UP))}


def reversals_by_machine(db, shift_ids: Iterable[Any]) -> Dict[Any, Tuple[int, Decimal]]:
    """
    Per till: the `payment_reversed` events of these shifts' documents — each reversal's credit
    note is a document of the shifts (counted once per credit note, whatever the till re-sent),
    or, for an event that names no document, its own shift. The amount is what the till reversed.
    """
    from app.models.audit_exception import TillEvent
    from app.models.transaction import Transaction
    from app.services.dashboard_stats import SALE_STATUSES

    ids = [i for i in (_uuid(s) for s in shift_ids) if i is not None]
    if not ids:
        return {}
    documents = {
        row[0]: (row[1], row[2])
        for row in db.query(Transaction.id, Transaction.machine_id, Transaction.total_amount)
        .filter(
            Transaction.shift_id.in_(ids),
            Transaction.status.in_(SALE_STATUSES),
            Transaction.duplicate_copy.is_(False),
        )
        .all()
    }
    events = []
    if documents:
        doc_ids = list(documents)
        for start in range(0, len(doc_ids), 500):
            events += (
                db.query(TillEvent)
                .filter(TillEvent.event_type == REVERSED_KIND, TillEvent.transaction_id.in_(doc_ids[start:start + 500]))
                .all()
            )
    events += (
        db.query(TillEvent)
        .filter(
            TillEvent.event_type == REVERSED_KIND,
            TillEvent.transaction_id.is_(None),
            TillEvent.shift_id.in_(ids),
        )
        .all()
    )
    seen = set()
    out: Dict[Any, Tuple[int, Decimal]] = {}
    for event in sorted(events, key=lambda e: (str(e.occurred_at), str(e.id))):
        key = event.transaction_id or event.id
        if key in seen:
            continue
        seen.add(key)
        if event.transaction_id is not None:
            machine_id, total = documents[event.transaction_id]
        else:
            machine_id, total = event.machine_id, None
        amount = _dec(event.amount)
        if amount is None:
            amount = _dec(total) or Decimal("0")
        count, summed = out.get(machine_id, (0, Decimal("0")))
        out[machine_id] = (count + 1, summed + abs(amount))
    return out


def z_reversals(db, per_machine: Sequence[Tuple[Any, Sequence[Any]]]) -> Tuple[Optional[Dict[str, Any]], List[Optional[Dict[str, Any]]]]:
    """
    The Z's line and each till's — `({count, amount} | None, [per till])` — over the shifts a Z
    takes. Never fails the Z: on any error the line is left out (it is presentation only).
    """
    try:
        # In a savepoint: a failed read must not leave the Z's own transaction aborted.
        with db.begin_nested():
            found = reversals_by_machine(db, [s.id for _m, shifts in per_machine for s in shifts])
    except Exception:  # noqa: BLE001 - a Z never waits for, or fails over, this line
        logger.exception("could not count the table payment reversals of a Z")
        return None, [None for _ in per_machine]
    parts: List[Optional[Dict[str, Any]]] = []
    for machine, _shifts in per_machine:
        count, amount = found.get(machine.id, (0, Decimal("0")))
        parts.append(_block(count, amount))
    total_count = sum(c for c, _a in found.values())
    total_amount = sum((a for _c, a in found.values()), Decimal("0"))
    return _block(total_count, total_amount), parts


def z_line(block: Any) -> Optional[str]:
    """"2 · ₪230.00" — the value of the Z's line, or None when there is none."""
    if not isinstance(block, dict):
        return None
    try:
        count = int(block.get("count") or 0)
    except (TypeError, ValueError):
        return None
    if count <= 0:
        return None
    return f"{count} · {_shekels(_dec(block.get('amount')) or Decimal('0'))}"
