"""
"הסתרת אפשרויות מתפריט הקופה" (P:/specs/till-menu-hide.md): `hiddenMenuItems`, the till's menu items
hidden on that till for everyone — a manager and a super admin too — whatever their permissions.

One till parameter (registered in app/services/till_parameters.py), a string of menu keys separated by
commas (`"catalog_admin,till_z"`), set per company → shop → point of sale → till like every till
parameter: the most specific level that sets a list wins whole, so a lower level both adds items and
gives them back (an empty list there = nothing hidden). Empty by default: the menu as today. The tills
get it with their other parameters (`GET /sync/{machine_id}/parameters`) and hide the item, its
shortcuts and the way to it (a deep link, a remote command); "הגדרות" stays open with the technician
code (spec §2).

The keys are the till's (§5), stable whatever the menu's names or order, kept here in the menu's order.
A key the cloud does not know is dropped on the way in, with a warning: never stored, never sent (the
till, for its part, skips a key it does not know).

Edited in three places, one value:

* "פרמטרים לקופות" — the super admin's page (`PUT /till-parameters/{id}/values`), with checkboxes.
* The device page's card "תפריט הקופה" — `GET / PUT /till-menu-hide?level=&id=`, by the settings
  writers of the level (app/routers/till_menu.py).
* "עיצוב קופה" — `GET / PUT /till-design/menu-hide?level=&id=`, by whoever edits the till design there.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

KEY = "hiddenMenuItems"

#: The longest list the till takes — every key once, with room for keys a newer till adds.
MAX_ITEMS = 64
KEY_MAX = 64


@dataclass(frozen=True)
class MenuItem:
    key: str
    #: The item's name in the till's menu (§5 "שם בתפריט").
    label: str
    #: What else the till hides with it — its shortcuts and ways in (§5), for the dashboard's hint.
    also: Optional[str] = None
    #: Said on the dashboard when the item is hidden: the critical items (§2).
    warning: Optional[str] = None


QUICK_ORDER_KEY = "quick_order"
TABLES_ITEM_KEY = "tables"

#: Every item that may be hidden, in the order of the till's menu (spec §5 — the keys are the till's
#: and never change; pinned with the dashboard by tests/fixtures/till_menu_items_golden.json).
ITEMS: Tuple[MenuItem, ...] = (
    MenuItem("catalog_admin", "ניהול קטלוג", also="\"פתח בניהול קטלוג\" מלחיצה ארוכה על מוצר במסך המכירה"),
    MenuItem("shop_z", "סגירת Z סניפי", also="כניסה מ\"סגירת משמרת ו-Z\" במסך \"סניף לא פעיל\""),
    MenuItem("shift", "משמרת (דו״ח X)"),
    MenuItem(
        "shift_close",
        "סגירת משמרת",
        also="כניסה מ\"סגירת משמרת ו-Z\" במסך \"סניף לא פעיל\"",
        warning="בקופה הזו לא יהיה אפשר לסגור משמרת. ודאו שהמשמרות נסגרות בקופה אחרת או בענן.",
    ),
    MenuItem(
        "till_z",
        "הפק Z",
        also="כפתור \"הפק Z\" במסך המשמרת; כניסה מ\"סגירת משמרת ו-Z\"",
        warning="בקופה הזו לא יהיה אפשר לבצע Z. ודאו ש-Z נעשה בקופה אחרת או בענן.",
    ),
    MenuItem("open_cash_drawer", "פתיחת מגירה"),
    MenuItem("cash_menu", "מזומן במגירה (הכנסה, הוצאה, הפקדה, ספירה, יומן)"),
    MenuItem("refund", "זיכוי"),
    MenuItem("transmission", "פעולות אשראי (שידור)"),
    MenuItem("attendance", "נוכחות"),
    MenuItem("sync_now", "סנכרון מול הענן"),
    MenuItem("ready_orders", "הזמנות להכנה"),
    MenuItem("kiosk_orders", "הזמנות קיוסק לתשלום"),
    MenuItem("voucher_station", "עמדת שובר: יציאה למסך רגיל / חזרה לעמדת שובר"),
    MenuItem("voucher_balance", "בירור יתרת שובר"),
    MenuItem("app_update", "עדכון גרסה", also="התקנה אוטומטית ופקודה מהדשבורד ממשיכות לעבוד"),
    MenuItem("history", "היסטוריה"),
    MenuItem("recent", "24 השעות האחרונות", also="הכפתור במסך ההיסטוריה"),
    MenuItem("shift_history", "היסטוריית משמרות"),
    MenuItem("till_z_history", "דוחות Z של הקופה"),
    MenuItem("product_sales", "מכירות לפי מוצר"),
    MenuItem("workers", "דוח לפי עובד"),
    MenuItem("tips", "דוח תשר"),
    MenuItem("tables_reports", "דוחות שולחנות"),
    MenuItem("z_reports", "דוחות Z (מהענן)"),
    MenuItem(
        "settings",
        "הגדרות",
        warning="בקופה הזו ההגדרות יהיו נגישות רק בקוד טכנאי, דרך \"אבחון\" (מסך הטכנאי).",
    ),
    MenuItem("printers", "מדפסות"),
    MenuItem("print_queue", "תור הדפסה"),
    MenuItem("screen_edit", "עריכת מסך"),
    MenuItem("diagnostics", "אבחון (מסך טכנאי)"),
    MenuItem("kiosk_mode", "חזרה למצב קיוסק / מעבר לקיוסק"),
    MenuItem("alerts", "התראות", also="הפעמון בסרגל"),
    MenuItem("blocks_now", "חסומים כעת"),
    MenuItem("managed_kiosks", "קיוסקים (קופה שולטת)", also="\"קיוסקים\" מתוך התראה"),
    MenuItem("lock", "נעילת קופה: יציאה מנעילת קופה / נעילת הקופה מחדש"),
    MenuItem("support", "תמיכה מרחוק"),
    MenuItem("switch_user", "יציאה מהמשתמש (החלפת משתמש)"),
    MenuItem(
        "tables",
        "שולחנות (בסרגל, לא בתפריט)",
        also="פתיחה אוטומטית על השולחנות; חזרה לשולחנות אחרי תשלום",
    ),
    MenuItem(
        "training",
        "מצב הדרכה: \"הפק Z\" של הדרכה",
        also="הפס הכתום לא מוסתר. בקופה אין כניסה להדרכה מהתפריט, הענן מדליק אותה",
    ),
    # §5א "מכשיר לשולחנות בלבד" (the owner, 14.10): the till opens on its tables, and every way to the sale
    # screen that is not through a table goes. Not with "שולחנות" hidden or the tables off — see `sell_warning`.
    MenuItem(
        QUICK_ORDER_KEY,
        "הזמנה מהירה (בסרגל, לא בתפריט)",
        also=(
            "הקופה נפתחת על מסך השולחנות; הלשונית \"הזמנה מהירה\", כל מעבר למסך המכירה שלא דרך שולחן, "
            "\"מכירה מהירה\" במסך השולחנות ו\"החזר הזמנה\""
        ),
    ),
)

#: The reports in the menu's "דוחות" folder (§5 18–25): all of them hidden, the folder goes too.
REPORT_KEYS: Tuple[str, ...] = (
    "recent", "shift_history", "till_z_history", "product_sales", "workers", "tips", "tables_reports", "z_reports",
)
KNOWN_KEYS: Tuple[str, ...] = tuple(item.key for item in ITEMS)
_LABELS: Dict[str, str] = {item.key: item.label for item in ITEMS}
_ORDER: Dict[str, int] = {key: i for i, key in enumerate(KNOWN_KEYS)}
#: The items whose hiding the dashboard warns about (§2): no close of the shift, no Z, settings by code.
CRITICAL_KEYS: Tuple[str, ...] = tuple(item.key for item in ITEMS if item.warning)

_DESCRIPTION = (
    "פריטים שלא יוצגו בתפריט של הקופה — לאף עובד, גם לא למנהל או למנהל-על, בלי קשר להרשאות. גם קיצורי "
    "הדרך אליהם בקופה מוסתרים (למשל כפתור ה-Z במסך המשמרת), וגם הניווט אליהם חסום. פקודות מרחוק מהדשבורד "
    "(נעילה, סנכרון, Z, סגירת משמרת, ניתוק משתמש, התקנת עדכון) ממשיכות לעבוד. ריק (ברירת מחדל) — התפריט כמו "
    "היום. הרמה הספציפית ביותר שקבעה רשימה גוברת: רמה נמוכה יכולה להסתיר עוד פריטים או להחזיר אותם (רשימה "
    "ריקה = הכל מוצג). כש\"הגדרות\" מוסתרות, הן נפתחות בקוד טכנאי מ\"אבחון\", שנשאר אז בתפריט. "
    "\"הזמנה מהירה\" מוסתרת — מכשיר לשולחנות בלבד: הקופה נפתחת על מסך השולחנות; כשאין בה שולחנות (כבויים "
    "או מוסתרים) היא מתעלמת מזה ומציגה את מסך המכירה. "
    "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה — כאן, בכרטיס \"תפריט הקופה\" בעמוד המכשיר, "
    "ובעיצוב הקופה."
)

#: The built-in (app/services/till_parameters.py `BUILTIN_PARAMETERS`). Created at startup like every
#: built-in (`ensure_builtin_parameters`) — no migration.
PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=KEY,
        label="הסתרת פריטים מתפריט הקופה",
        value_type="string",
        default_value="",
        description=_DESCRIPTION,
    ),
)


class MenuKeysError(ValueError):
    """A value that is not a list of menu keys at all (not text, or far too long)."""


# ── The value ────────────────────────────────────────────────────────────────


def split(value: Any) -> List[str]:
    """
    The keys in a stored value or a request, as given: trimmed, lower-case, without empties or
    repeats. Text is split on commas; a list is taken as it is. Anything else: `MenuKeysError`.
    """
    if value is None:
        return []
    if isinstance(value, str):
        parts: Iterable[Any] = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = value
    else:
        raise MenuKeysError(f"{KEY} must be a comma-separated list of menu keys")
    out: List[str] = []
    for part in parts:
        if not isinstance(part, str):
            raise MenuKeysError(f"{KEY} must be a list of menu keys (text)")
        key = part.strip().lower()
        if len(key) > KEY_MAX:
            raise MenuKeysError(f"a menu key is at most {KEY_MAX} characters")
        if key and key not in out:
            out.append(key)
    if len(out) > MAX_ITEMS:
        raise MenuKeysError(f"{KEY} takes at most {MAX_ITEMS} keys")
    return out


@dataclass(frozen=True)
class Cleaned:
    #: The known keys, in the till's order.
    keys: Tuple[str, ...]
    #: What was dropped because the cloud does not know it.
    ignored: Tuple[str, ...]

    @property
    def value(self) -> str:
        """As stored and sent: the keys joined by commas ("" = nothing hidden)."""
        return ",".join(self.keys)


def clean(value: Any) -> Cleaned:
    """
    The value the cloud stores for `value` (text or a list): only known keys, each once, in the till's
    order — so the same choice is always the same text — and the unknown ones it dropped.
    """
    given = split(value)
    known = sorted((k for k in given if k in _ORDER), key=_ORDER.__getitem__)
    ignored = tuple(k for k in given if k not in _ORDER)
    return Cleaned(keys=tuple(known), ignored=ignored)


def clean_value(value: Any) -> str:
    """For `validate_keyed_value`: the stored text, with a warning in the log for keys dropped."""
    cleaned = clean(value)
    if cleaned.ignored:
        logger.warning("%s: ignoring unknown menu keys %s", KEY, ", ".join(cleaned.ignored))
    return cleaned.value


def warnings_for(keys: Iterable[str]) -> List[Dict[str, str]]:
    """The critical items among `keys`, each with what the dashboard says about it, in the till's order."""
    wanted = set(keys)
    return [{"key": item.key, "label": item.label, "warning": item.warning} for item in ITEMS if item.warning and item.key in wanted]


#: §5א: "quick_order" hidden with no tables to sell through — the till ignores it (the sale screen stays),
#: and the dashboard says so when saving. A warning, never a refusal.
NO_WAY_TO_SELL = "בקופה הזו לא תישאר דרך למכור"


def sell_warning(keys: Iterable[str], tables_off: Optional[bool]) -> Optional[Dict[str, str]]:
    """
    §5א: "הזמנה מהירה" hidden while "שולחנות" is hidden too, or the tables are off where the list applies
    (`tables_off`; None = not known) — no way left to sell. The till then ignores "quick_order".
    """
    hidden = set(keys)
    if QUICK_ORDER_KEY not in hidden:
        return None
    if TABLES_ITEM_KEY in hidden:
        reason = "גם \"שולחנות\" מוסתר"
    elif tables_off:
        reason = "ניהול השולחנות כבוי"
    else:
        return None
    return {
        "key": QUICK_ORDER_KEY,
        "label": _LABELS[QUICK_ORDER_KEY],
        "warning": (
            f"{NO_WAY_TO_SELL}: {reason}. הקופה תתעלם מהסתרת \"הזמנה מהירה\" ותציג את מסך המכירה, "
            "עד שיהיו בה שולחנות."
        ),
    }


def items_out() -> List[Dict[str, Any]]:
    return [
        {
            "key": item.key,
            "label": item.label,
            "also": item.also,
            "critical": item.warning is not None,
            "warning": item.warning,
            "report": item.key in REPORT_KEYS,
        }
        for item in ITEMS
    ]


# ── One level ────────────────────────────────────────────────────────────────


def _parameter(db):
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    return db.query(TillParameter).filter(TillParameter.key == KEY).first()


def _usable(parameter, value: Any) -> bool:
    from app.services.till_parameters import _is_valid

    return _is_valid(parameter.value_type, value, parameter.enum_options)


def level_view(db, scope_type: str, scope_id: Any) -> Dict[str, Any]:
    """
    One level: its own list (`own`; null = it sets none and inherits), what it inherits and from where
    (`inherited`, `inheritedFrom`: the nearest level above that sets a list, else null — the default),
    what its tills get (`effective`), the warnings for that, and every item with its name.
    """
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameterValue
    from app.services.kds_workflow import chain_for_scope
    from app.services.till_parameters import as_uuid, scope_labels

    parameter = _parameter(db)
    ident = as_uuid(scope_id)
    above, _shop = chain_for_scope(db, scope_type, ident, above_only=True)
    own: Optional[List[str]] = None
    inherited: List[str] = []
    inherited_from: Optional[Dict[str, Any]] = None
    if parameter is not None:
        own_row = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == scope_type,
                TillParameterValue.scope_id == ident,
            )
            .first()
        )
        if own_row is not None and _usable(parameter, own_row.value):
            own = list(clean(own_row.value).keys)
        scopes = above.scopes()
        rows = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
            )
            .all()
            if scopes
            else []
        )
        by_scope = {(r.scope_type, as_uuid(r.scope_id)): r for r in rows}
        source = next(
            (by_scope[s] for s in scopes if s in by_scope and _usable(parameter, by_scope[s].value)), None
        )
        if source is not None:
            inherited = list(clean(source.value).keys)
            label = scope_labels(db, [source]).get((source.scope_type, as_uuid(source.scope_id)))
            inherited_from = {
                "level": source.scope_type,
                "id": str(source.scope_id),
                "name": label.name if label else None,
            }
        elif parameter.default_value is not None and _usable(parameter, parameter.default_value):
            inherited = list(clean(parameter.default_value).keys)
    effective = own if own is not None else inherited
    tables_off = _tables_off(db, scope_type, ident)
    warnings = warnings_for(effective)
    selling = sell_warning(effective, tables_off)
    if selling is not None:
        warnings.append(selling)
    return {
        "key": KEY,
        "level": scope_type,
        "id": str(ident),
        "own": own,
        "inherited": inherited,
        "inheritedFrom": inherited_from,
        "effective": effective,
        "warnings": warnings,
        # Where the list applies, as the level resolves `tablesMode` ("כבוי" — the default — is off). A
        # till's own answer counts its place in the shop's LAN; above a till, a lower level may differ.
        "tablesOff": tables_off,
        "items": items_out(),
        # Off: the tills get nothing for it — every item shows.
        "active": bool(parameter.is_active) if parameter is not None else False,
    }


def _tables_off(db, scope_type: str, ident) -> bool:
    """Whether the tables are off at this level (`tablesMode` as it resolves there)."""
    from sqlalchemy import and_, or_

    from app.models.pos_machine import POSMachine
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.kds_workflow import chain_for_scope
    from app.services.tables import MODE_OFF, TABLES_MODE_KEY, _MODES
    from app.services.till_parameters import resolve_till_parameters, till_parameters_for_machine

    if scope_type == "machine":
        machine = db.query(POSMachine).filter(POSMachine.id == ident).first()
        mode = till_parameters_for_machine(db, machine).parameters.get(TABLES_MODE_KEY) if machine else None
    else:
        chain, _shop = chain_for_scope(db, scope_type, ident)
        parameters = db.query(TillParameter).filter(TillParameter.key == TABLES_MODE_KEY).all()
        scopes = chain.scopes()
        values = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id.in_([p.id for p in parameters]),
                or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
            )
            .all()
            if scopes and parameters
            else []
        )
        mode = resolve_till_parameters(parameters, values, chain).parameters.get(TABLES_MODE_KEY)
    return _MODES.get(mode, MODE_OFF) == MODE_OFF if isinstance(mode, str) else True


@dataclass
class Saved:
    changed: bool
    ignored: Tuple[str, ...]
    #: The tills to tell (`till_parameters_updated`).
    targets: List[Tuple[str, str]]


def save(db, scope_type: str, scope_id: Any, hidden: Any, *, user: Any, now: Optional[datetime] = None) -> Saved:
    """
    Set this level's own list (`hidden`: keys, as a list or comma-separated text; [] = nothing hidden
    here, whatever the levels above hide) or clear it (`hidden` None — the level inherits again), with
    its row in `till_parameter_changes`, in the caller's transaction. Unknown keys are dropped and
    returned in `ignored`. Raises `TillParameterValueError` for what is not a list of keys.
    """
    from app.services.till_parameters import (
        TillParameterValueError,
        as_uuid,
        notify_targets_for_scope,
        validate_value,
        write_value,
    )

    parameter = _parameter(db)
    if parameter is None:  # pragma: no cover - `ensure_builtin_parameters` just made it
        raise TillParameterValueError(f"unknown parameter {KEY}")
    ident = as_uuid(scope_id)
    ignored: Tuple[str, ...] = ()
    value: Optional[str] = None
    if hidden is not None:
        try:
            cleaned = clean(hidden)
        except MenuKeysError as exc:
            raise TillParameterValueError(str(exc)) from exc
        ignored = cleaned.ignored
        if ignored:
            logger.warning("%s at %s %s: ignoring unknown menu keys %s", KEY, scope_type, ident, ", ".join(ignored))
        value = validate_value(parameter.value_type, cleaned.value, parameter.enum_options)
    changed = write_value(db, parameter, scope_type, ident, value, user=user, now=now or datetime.now(timezone.utc))
    db.flush()
    targets = list(notify_targets_for_scope(db, scope_type, ident)) if changed and parameter.is_active else []
    return Saved(changed=changed, ignored=ignored, targets=targets)


def hidden_for(parameters: Dict[str, Any]) -> List[str]:
    """The keys a till's resolved parameters hide (what the till itself reads)."""
    return list(clean(parameters.get(KEY) or "").keys)


