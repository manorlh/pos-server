"""
"מכשיר מזומן (CashMag)" — the till parameters of the CashMag (CMC Monetic) cash recycler (P:/specs/cashmag.md §4.1).

The till pays at the vendor's own software on a Windows PC on the shop's LAN — no cash host of ours — so these are
read by the till alone (pos-android `domain/CashMag.kt` `CashMagConfig`, as `param.<key>`), resolved like every
till parameter (company → shop → point of sale → till). Every default keeps today's till: CashMag OFF, nothing
of the vendor's touched. A device's own settings (`cashmag.local.*`, never
synced) win over these on a KIOSK only (the owner 15.10: everything from the cloud; a kiosk standing next to its
machine may set its address locally) — a till shows them, never edits them.

Set like the cash station's parameters (app/services/cash_params.py), by whoever may set till parameters.
`clean_value` (wired in app/services/till_parameters.py `validate_keyed_value`) refuses what the till could not
use — the user code digits only, the currency three letters, the host one word, the ranges.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Tuple

ENABLED_KEY = "cashmagEnabled"
PROTOCOL_KEY = "cashmagProtocol"
HOST_KEY = "cashmagHost"
PORT_KEY = "cashmagPort"
TERMINAL_KEY = "cashmagTerminal"
USER_CODE_KEY = "cashmagUserCode"
CURRENCY_KEY = "cashmagCurrency"
ROUNDING_KEY = "cashmagRounding"
QUEUE_TIMEOUT_KEY = "cashmagQueueTimeoutSec"
AUTO_CANCEL_KEY = "cashmagAutoCancelSec"
CALL_TIMEOUT_KEY = "cashmagCallTimeoutSec"

PROTOCOL_JAR = "jar"
PROTOCOL_JSON = "json"
PROTOCOL_RLP = "rlp"
PROTOCOL_OPTIONS: Tuple[str, ...] = (PROTOCOL_JAR, PROTOCOL_JSON, PROTOCOL_RLP)
PROTOCOL_LABELS: Dict[str, str] = {
    PROTOCOL_JAR: "ספריית היצרן (jar)",
    PROTOCOL_JSON: "JSON-RPC ברשת (בלי ספריית היצרן) — עוד לא נתמך",
    PROTOCOL_RLP: "RLP — עוד לא נתמך",
}

ROUNDING_NEAREST_10 = "nearest_10"
ROUNDING_NONE = "none"
ROUNDING_OPTIONS: Tuple[str, ...] = (ROUNDING_NEAREST_10, ROUNDING_NONE)
ROUNDING_LABELS: Dict[str, str] = {
    ROUNDING_NEAREST_10: "לעשרות אגורות (1–4 למטה, 5–9 למעלה)",
    ROUNDING_NONE: "בלי עיגול",
}

DEFAULT_CURRENCY = "ILS"

#: The whole-number ranges the till reads (outside them it keeps its default).
RANGES: Dict[str, Tuple[int, int]] = {
    PORT_KEY: (1, 65535),
    QUEUE_TIMEOUT_KEY: (0, 1800),
    AUTO_CANCEL_KEY: (0, 1800),
    CALL_TIMEOUT_KEY: (5, 120),
}

VALIDATED_KEYS = frozenset({HOST_KEY, TERMINAL_KEY, USER_CODE_KEY, CURRENCY_KEY, *RANGES.keys()})

_USER_CODE = re.compile(r"^[0-9]{1,12}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_HOST = re.compile(r"^[A-Za-z0-9._:\-\[\]]{1,253}$")
TERMINAL_MAX = 40

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה; קיוסק יכול לדרוס כתובת, פורט ושם בהגדרות המקומיות שלו."


def _spec(key: str, label: str, value_type: str, default: Any, description: str, **extra: Any) -> Dict[str, Any]:
    return dict(key=key, label=label, value_type=value_type, default_value=default, description=description, **extra)


PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    _spec(ENABLED_KEY, "מכשיר מזומן CashMag — פעיל בקופה", "boolean", False,
          "כשמופעל, במסך התשלום של הקופה יש \"מזומן במכשיר\": הלקוח משלם ומקבל עודף במכונת המזומן של CashMag "
          "(CMC Monetic), דרך תוכנת היצרן במחשב Windows ברשת המקומית. כבוי (ברירת מחדל) — הקופה כמו היום, בלי שום "
          f"פנייה למכונה. דורש גרסת קופה שכוללת את ספריית היצרן. {_LEVELS}"),
    _spec(PROTOCOL_KEY, "מכשיר מזומן CashMag — פרוטוקול", "enum", PROTOCOL_JAR,
          f"איך הקופה מדברת עם תוכנת היצרן במחשב CashMag. «{PROTOCOL_LABELS[PROTOCOL_JAR]}» (ברירת מחדל). "
          f"«{PROTOCOL_LABELS[PROTOCOL_JSON]}» ו-«{PROTOCOL_LABELS[PROTOCOL_RLP]}» — יופעלו כשיהיה להם דרייבר; עד אז "
          f"התשלום \"לא זמין\". {_LEVELS}",
          enum_options=PROTOCOL_OPTIONS, enum_labels=PROTOCOL_LABELS),
    _spec(HOST_KEY, "מכשיר מזומן CashMag — כתובת השרת", "string", None,
          f"כתובת המחשב של היצרן ברשת המקומית (IP או שם), למשל 192.168.1.40. ריק — לא מוגדר. {_LEVELS}"),
    _spec(PORT_KEY, "מכשיר מזומן CashMag — פורט", "integer", None,
          f"הפורט של תוכנת היצרן (1–65535). ריק — לא מוגדר (ב-RLP ברירת המחדל 55110). {_LEVELS}"),
    _spec(TERMINAL_KEY, "מכשיר מזומן CashMag — שם הקופה", "string", None,
          f"השם שהקופה מציגה לתוכנת היצרן (עד {TERMINAL_MAX} תווים). ריק — שם הקופה. {_LEVELS}"),
    _spec(USER_CODE_KEY, "מכשיר מזומן CashMag — קוד משתמש", "string", None,
          f"הקוד המספרי של המשתמש בהגדרות CashMag (ספרות בלבד, עד 12). ריק — לא מוגדר. {_LEVELS}"),
    _spec(CURRENCY_KEY, "מכשיר מזומן CashMag — מטבע", "string", DEFAULT_CURRENCY,
          f"קוד המטבע שנשלח למכונה (3 אותיות). ברירת מחדל ILS — שקלים, וחייב להיות מוגדר גם בתוכנת היצרן. {_LEVELS}"),
    _spec(ROUNDING_KEY, "מכשיר מזומן CashMag — עיגול", "enum", ROUNDING_NEAREST_10,
          "עיגול הסכום שהלקוח משלם במכונה (המסמך נשאר בסכום המדויק, והעיגול מופיע בקבלה). "
          f"«{ROUNDING_LABELS[ROUNDING_NEAREST_10]}» (ברירת מחדל) או «{ROUNDING_LABELS[ROUNDING_NONE]}». {_LEVELS}",
          enum_options=ROUNDING_OPTIONS, enum_labels=ROUNDING_LABELS),
    _spec(QUEUE_TIMEOUT_KEY, "מכשיר מזומן CashMag — המתנה למכונה תפוסה (שניות)", "integer", 0,
          "מכונה אחת לכמה קופות וקיוסקים — מי שהתחיל ראשון ממשיך עד הסוף. כשעמדה אחרת משתמשת בה, הקופה מציגה "
          "\"עמדת המזומן בשימוש כרגע על ידי עמדה אחרת — יש להמתין לסיום\" וממשיכה לבד לתשלום כשהמכונה מתפנה "
          f"(עם \"חזרה\"). 0 (ברירת מחדל) — ממתינים בלי הגבלה; אחרת עד מספר השניות הזה (עד 1800). {_LEVELS}"),
    _spec(AUTO_CANCEL_KEY, "מכשיר מזומן CashMag — ביטול אוטומטי במכונה", "integer", 0,
          "0 (ברירת מחדל) — קריאת התשלום הבסיסית. יותר מ-0 — הקריאה המפורטת של היצרן עם זמן ביטול אוטומטי "
          f"(0–1800) — רק אחרי שהיצרן יאשר את היחידה. {_LEVELS}"),
    _spec(CALL_TIMEOUT_KEY, "מכשיר מזומן CashMag — זמן לקריאה (שניות)", "integer", 30,
          f"הזמן המקסימלי לקריאה שאינה תשלום (חיבור, רישיון, הפעלה) (5–120). ברירת מחדל 30. {_LEVELS}"),
)


def clean_value(key: str, value: Any) -> Any:
    """`value` as stored for `key`, else ValueError (the parameters page shows it)."""
    if value is None or key not in VALIDATED_KEYS:
        return value
    if key in RANGES:
        lo, hi = RANGES[key]
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise ValueError(f"{key} must be a whole number {lo}–{hi}")
        return value
    if not isinstance(value, str):
        raise ValueError(f"{key} must be text")
    text = value.strip()
    if key == USER_CODE_KEY:
        if text and not _USER_CODE.match(text):
            raise ValueError(f"{USER_CODE_KEY} must be 1–12 digits")
        return text
    if key == CURRENCY_KEY:
        upper = text.upper()
        if not _CURRENCY.match(upper):
            raise ValueError(f"{CURRENCY_KEY} must be a three-letter currency code (ILS)")
        return upper
    if key == HOST_KEY:
        if text and not _HOST.match(text):
            raise ValueError(f"{HOST_KEY} must be an address or a host name, without spaces")
        return text
    if key == TERMINAL_KEY:
        if len(text) > TERMINAL_MAX or any(c in text for c in "\r\n\t\0"):
            raise ValueError(f"{TERMINAL_KEY} must be one line of at most {TERMINAL_MAX} characters")
        return text
    return value
