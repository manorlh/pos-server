"""
"תצורת עבודה של הסניף" — the profile's fields, their values, the ready-made templates and the
strict check of a profile as the dashboard sends it (P:/specs/shop-work-config.md §2, §7ב).

Pure: no database, no request. The templates are pinned by a golden file the dashboard may import
as is (tests/fixtures/shop_work_templates.json), so both sides offer the same six.

A profile (stored on the shop as `settings.workProfile`):

    {"templateId": "restaurant_tables" | ... | null,
     "zType": "per_till" | "shop_cloud" | "shop_local",
     "shopZFrom": "main_only" | "main_and_dashboard" | "any_and_dashboard",
     "localServer": bool,
     "tablesMode": "off" | "single" | "synced" | "lan",
     "kitchen": "printer" | "kds" | "both",
     "customerDisplay": bool,
     "attendance": bool,
     "tips": {"enabled": bool, "distribution": "direct" | "equal_pool" | "by_sales"},
     "vouchers": {"station": bool, "balanceCheck": "auto" | "on" | "off"}}

Two rules tie the fields together, because the system has no other way to run them: a local
server is the shop's main till with "רשת מקומית" on, and with it on the main till produces the
shop Z — so `localServer` is true exactly when `zType` is `shop_local`; and the tables over the
LAN («רשת מקומית (קופה ראשית)») live on that main till, so `tablesMode: "lan"` needs it.
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Sequence, Tuple

SETTINGS_KEY = "workProfile"

# ── The fields and their values ───────────────────────────────────────────────

Z_PER_TILL, Z_SHOP_CLOUD, Z_SHOP_LOCAL = "per_till", "shop_cloud", "shop_local"
Z_TYPES = (Z_PER_TILL, Z_SHOP_CLOUD, Z_SHOP_LOCAL)

FROM_MAIN, FROM_MAIN_AND_DASHBOARD, FROM_ANY = "main_only", "main_and_dashboard", "any_and_dashboard"
SHOP_Z_FROM = (FROM_MAIN, FROM_MAIN_AND_DASHBOARD, FROM_ANY)

TABLES_OFF, TABLES_SINGLE, TABLES_SYNCED, TABLES_LAN = "off", "single", "synced", "lan"
TABLES = (TABLES_OFF, TABLES_SINGLE, TABLES_SYNCED, TABLES_LAN)

KITCHEN_PRINTER, KITCHEN_KDS, KITCHEN_BOTH = "printer", "kds", "both"
KITCHENS = (KITCHEN_PRINTER, KITCHEN_KDS, KITCHEN_BOTH)

TIP_DISTRIBUTIONS = ("direct", "equal_pool", "by_sales")
BALANCE_CHECKS = ("auto", "on", "off")

FIELDS = (
    "templateId", "zType", "shopZFrom", "localServer", "tablesMode", "kitchen",
    "customerDisplay", "attendance", "tips", "vouchers",
)
#: The fields that carry a status (all but the template's name).
STATUS_FIELDS = FIELDS[1:]
#: The Z and the local server: applied to the tills, so they wait for one.
TILL_FIELDS = ("zType", "localServer")
#: Changed only by the super admin once the shop has tills (spec §5).
Z_FIELDS = ("zType", "localServer", "shopZFrom")

LABELS: Dict[str, str] = {
    "templateId": "תבנית",
    "zType": "סוג Z",
    "shopZFrom": "מי מפיק Z סניפי",
    "localServer": "שרת מקומי (קופה ראשית)",
    "tablesMode": "ניהול שולחנות",
    "kitchen": "מטבח",
    "customerDisplay": "מסך לקוח",
    "attendance": "נוכחות עובדים",
    "tips": "טיפים",
    "vouchers": "שוברי הפקה",
}

VALUE_LABELS: Dict[str, Dict[Any, str]] = {
    "zType": {Z_PER_TILL: "Z לכל קופה", Z_SHOP_CLOUD: "Z סניפי מהענן", Z_SHOP_LOCAL: "Z סניפי בשרת מקומי"},
    "shopZFrom": {
        FROM_MAIN: "הקופה הראשית בלבד",
        FROM_MAIN_AND_DASHBOARD: "הקופה הראשית והדשבורד",
        FROM_ANY: "כל קופה בסניף והדשבורד",
    },
    "tablesMode": {
        TABLES_OFF: "כבוי",
        TABLES_SINGLE: "קופה אחת",
        TABLES_SYNCED: "מסונכרן בין הקופות",
        TABLES_LAN: "רשת מקומית (דרך הקופה הראשית)",
    },
    "kitchen": {KITCHEN_PRINTER: "בונים במדפסת", KITCHEN_KDS: "מסך מטבח (KDS)", KITCHEN_BOTH: "בונים ומסך מטבח"},
    "distribution": {"direct": "ישירה", "equal_pool": "שווה", "by_sales": "לפי מכירות"},
    "balanceCheck": {"auto": "אוטומטי", "on": "כן", "off": "לא"},
}

#: Spec §2.1's defaults: what a field is when nobody chose otherwise.
DEFAULT_PROFILE: Dict[str, Any] = {
    "templateId": None,
    "zType": Z_SHOP_CLOUD,
    "shopZFrom": FROM_MAIN,
    "localServer": False,
    "tablesMode": TABLES_OFF,
    "kitchen": KITCHEN_PRINTER,
    "customerDisplay": False,
    "attendance": False,
    "tips": {"enabled": False, "distribution": "direct"},
    "vouchers": {"station": False, "balanceCheck": "auto"},
}


def value_label(field: str, value: Any) -> str:
    """A value as the dashboard words it."""
    if isinstance(value, bool):
        return ("כן" if value else "לא") if field == "localServer" else ("דלוק" if value else "כבוי")
    if field == "tips" and isinstance(value, dict):
        if not value.get("enabled"):
            return "כבוי"
        return f"דלוק, חלוקה {VALUE_LABELS['distribution'].get(value.get('distribution'), value.get('distribution'))}"
    if field == "vouchers" and isinstance(value, dict):
        station = "עמדת שובר דלוקה" if value.get("station") else "בלי עמדת שובר"
        check = VALUE_LABELS["balanceCheck"].get(value.get("balanceCheck"), value.get("balanceCheck"))
        return f"{station}, בירור יתרה: {check}"
    return VALUE_LABELS.get(field, {}).get(value, str(value))


# ── The templates (spec §2.2) ─────────────────────────────────────────────────


def _profile(template_id: str, **fields: Any) -> Dict[str, Any]:
    out = copy.deepcopy(DEFAULT_PROFILE)
    out.update(fields)
    out["templateId"] = template_id
    return out


TEMPLATES: Tuple[Dict[str, Any], ...] = (
    {
        "id": "restaurant_tables",
        "name": "מסעדה עם שולחנות",
        "description": (
            "Z סניפי בשרת מקומי: הקופה הראשית מנהלת את השולחנות ברשת המקומית ומפיקה את ה-Z של כל הסניף, "
            "גם בלי אינטרנט. הבונים יוצאים במדפסות."
        ),
        "profile": _profile(
            "restaurant_tables", zType=Z_SHOP_LOCAL, localServer=True, tablesMode=TABLES_LAN, kitchen=KITCHEN_PRINTER,
        ),
    },
    {
        "id": "restaurant_kds",
        "name": "מסעדה עם מסך מטבח",
        "description": (
            "כמו מסעדה עם שולחנות — שרת מקומי ושולחנות ברשת המקומית — וההזמנות מגיעות למסך מטבח (KDS) "
            "במקום לבונים."
        ),
        "profile": _profile(
            "restaurant_kds", zType=Z_SHOP_LOCAL, localServer=True, tablesMode=TABLES_LAN, kitchen=KITCHEN_KDS,
        ),
    },
    {
        "id": "quick_counter",
        "name": "דוכן / קופה מהירה",
        "description": "מכירה מהירה בלי שולחנות. Z סניפי אחד לכל הקופות מהענן, והבונים יוצאים במדפסות.",
        "profile": _profile(
            "quick_counter", zType=Z_SHOP_CLOUD, localServer=False, tablesMode=TABLES_OFF, kitchen=KITCHEN_PRINTER,
        ),
    },
    {
        "id": "kiosks",
        "name": "קיוסקים",
        "description": (
            "עמדות הזמנה עצמית בלי שולחנות. Z סניפי מהענן, וההזמנות מגיעות למסך מטבח (KDS)."
        ),
        "profile": _profile(
            "kiosks", zType=Z_SHOP_CLOUD, localServer=False, tablesMode=TABLES_OFF, kitchen=KITCHEN_KDS,
        ),
    },
    {
        "id": "independent_till",
        "name": "קופה עצמאית",
        "description": "כל קופה מפיקה Z משלה ומנהלת את השולחנות שלה בעצמה. הבונים יוצאים במדפסות.",
        "profile": _profile(
            "independent_till", zType=Z_PER_TILL, localServer=False, tablesMode=TABLES_SINGLE, kitchen=KITCHEN_PRINTER,
        ),
    },
    {
        "id": "event",
        "name": "אירוע / הפקה",
        "description": (
            "אירוע או הפקה עם שוברים: עמדת שובר דלוקה, Z סניפי מהענן, בלי שולחנות, והבונים יוצאים במדפסות."
        ),
        "profile": _profile(
            "event", zType=Z_SHOP_CLOUD, localServer=False, tablesMode=TABLES_OFF, kitchen=KITCHEN_PRINTER,
            vouchers={"station": True, "balanceCheck": "auto"},
        ),
    },
)

TEMPLATE_IDS = tuple(t["id"] for t in TEMPLATES)


def templates() -> List[Dict[str, Any]]:
    """`GET /work-profile/templates`: `[{id, name, description, profile}]` (a copy)."""
    return copy.deepcopy(list(TEMPLATES))


# ── The strict check ──────────────────────────────────────────────────────────


class ProfileInvalid(ValueError):
    """A profile the dashboard sent that is not one: the field, the value and why (Hebrew)."""

    def __init__(self, field: str, message: str, *, value: Any = None, allowed: Optional[Sequence[Any]] = None):
        super().__init__(message)
        self.field = field
        self.message = message
        self.value = value
        self.allowed = list(allowed) if allowed is not None else None

    def body(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"code": "work_profile_invalid", "field": self.field, "message": self.message}
        if self.value is not None:
            out["value"] = self.value
        if self.allowed is not None:
            out["allowed"] = self.allowed
        return out


def _name(field: str) -> str:
    label = LABELS.get(field.split(".")[0])
    if "." in field:
        sub = field.split(".", 1)[1]
        return f"\"{label} — {sub}\" ({field})" if label else f"({field})"
    return f"\"{label}\" ({field})" if label else f"({field})"


def _shown(value: Any) -> str:
    text = repr(value) if not isinstance(value, str) else value
    return text if len(text) <= 60 else text[:57] + "..."


def _choice(field: str, value: Any, allowed: Sequence[str]) -> str:
    if isinstance(value, str) and value in allowed:
        return value
    raise ProfileInvalid(
        field,
        f"השדה {_name(field)}: הערך \"{_shown(value)}\" לא מוכר. אפשר רק: {', '.join(allowed)}.",
        value=value, allowed=allowed,
    )


def _bool(field: str, value: Any) -> bool:
    if isinstance(value, bool):
        return value
    raise ProfileInvalid(
        field,
        f"השדה {_name(field)}: הערך \"{_shown(value)}\" לא תקין — צריך true או false.",
        value=value, allowed=[True, False],
    )


def _object(field: str, value: Any, keys: Sequence[str]) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ProfileInvalid(
            field,
            f"השדה {_name(field)}: צריך אובייקט עם {', '.join(keys)}, והתקבל \"{_shown(value)}\".",
            value=value,
        )
    unknown = [k for k in value if k not in keys]
    if unknown:
        raise ProfileInvalid(
            f"{field}.{unknown[0]}",
            f"בשדה {_name(field)} יש שדה לא מוכר: \"{unknown[0]}\". אפשר רק: {', '.join(keys)}.",
            value=unknown[0], allowed=keys,
        )
    missing = [k for k in keys if k not in value]
    if missing:
        raise ProfileInvalid(
            f"{field}.{missing[0]}",
            f"בשדה {_name(field)} חסר \"{missing[0]}\" (צריך את כל אלה: {', '.join(keys)}).",
            allowed=keys,
        )
    return value


def validate(raw: Any) -> Dict[str, Any]:
    """
    The profile as stored — every field present, each one of its values, the two rules between
    them kept — or `ProfileInvalid` with the field, the value and what it may be (Hebrew).
    `templateId` may be left out or null (a profile of one's own).
    """
    if not isinstance(raw, dict):
        raise ProfileInvalid("profile", f"תצורת העבודה צריכה להיות אובייקט, והתקבל \"{_shown(raw)}\".", value=raw)
    unknown = [k for k in raw if k not in FIELDS]
    if unknown:
        raise ProfileInvalid(
            unknown[0],
            f"השדה \"{unknown[0]}\" לא מוכר בתצורת העבודה. השדות: {', '.join(FIELDS)}.",
            value=unknown[0], allowed=FIELDS,
        )
    missing = [k for k in STATUS_FIELDS if k not in raw]
    if missing:
        raise ProfileInvalid(
            missing[0],
            f"חסר השדה {_name(missing[0])}. תצורת עבודה כוללת את כל השדות: {', '.join(STATUS_FIELDS)}.",
            allowed=STATUS_FIELDS,
        )
    template = raw.get("templateId")
    if template is not None:
        _choice("templateId", template, TEMPLATE_IDS)
    tips = _object("tips", raw["tips"], ("enabled", "distribution"))
    vouchers = _object("vouchers", raw["vouchers"], ("station", "balanceCheck"))
    out = {
        "templateId": template,
        "zType": _choice("zType", raw["zType"], Z_TYPES),
        "shopZFrom": _choice("shopZFrom", raw["shopZFrom"], SHOP_Z_FROM),
        "localServer": _bool("localServer", raw["localServer"]),
        "tablesMode": _choice("tablesMode", raw["tablesMode"], TABLES),
        "kitchen": _choice("kitchen", raw["kitchen"], KITCHENS),
        "customerDisplay": _bool("customerDisplay", raw["customerDisplay"]),
        "attendance": _bool("attendance", raw["attendance"]),
        "tips": {
            "enabled": _bool("tips.enabled", tips["enabled"]),
            "distribution": _choice("tips.distribution", tips["distribution"], TIP_DISTRIBUTIONS),
        },
        "vouchers": {
            "station": _bool("vouchers.station", vouchers["station"]),
            "balanceCheck": _choice("vouchers.balanceCheck", vouchers["balanceCheck"], BALANCE_CHECKS),
        },
    }
    if out["zType"] == Z_SHOP_LOCAL and not out["localServer"]:
        raise ProfileInvalid(
            "localServer",
            "\"Z סניפי בשרת מקומי\" מחייב שרת מקומי (קופה ראשית): הקופה הראשית היא שמפיקה את ה-Z. "
            "הערך localServer=false לא אפשרי עם zType=shop_local — סמנו שרת מקומי, או בחרו סוג Z אחר.",
            value=False, allowed=[True],
        )
    if out["localServer"] and out["zType"] != Z_SHOP_LOCAL:
        raise ProfileInvalid(
            "localServer",
            f"שרת מקומי (קופה ראשית) פועל רק עם \"Z סניפי בשרת מקומי\": כשהרשת המקומית דלוקה, הקופה הראשית "
            f"מפיקה את ה-Z של הסניף. הערך localServer=true לא אפשרי עם zType={out['zType']} — בחרו "
            "\"Z סניפי בשרת מקומי\", או כבו את השרת המקומי.",
            value=True, allowed=[False],
        )
    if out["tablesMode"] == TABLES_LAN and not out["localServer"]:
        raise ProfileInvalid(
            "tablesMode",
            "ניהול שולחנות \"רשת מקומית\" עובד דרך הקופה הראשית, ולכן מחייב שרת מקומי. הערך tablesMode=lan לא "
            "אפשרי עם localServer=false — בחרו \"מסונכרן בין הקופות\" או \"קופה אחת\", או הפעילו שרת מקומי.",
            value=TABLES_LAN, allowed=[TABLES_OFF, TABLES_SINGLE, TABLES_SYNCED],
        )
    return out


def stored(settings: Any) -> Optional[Dict[str, Any]]:
    """The profile a shop's settings hold, or None (never set, or no longer valid)."""
    if not isinstance(settings, dict):
        return None
    raw = settings.get(SETTINGS_KEY)
    if not isinstance(raw, dict):
        return None
    try:
        return validate(raw)
    except ProfileInvalid:
        return None
