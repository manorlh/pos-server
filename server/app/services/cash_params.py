"""
"מכשיר מזומן" — the cash parameters (P:/specs/cash-paylink.md §6, §9, contract §11.10).

Every setting of the cash stations is a built-in till parameter, resolved like any other (company →
shop → point of sale → device); a station overrides its own ones (`cash_stations.settings`). Who reads
which (`KIOSK_KEYS`, `STATION_KEYS`, `HOST_KEYS`): a kiosk (or a till, stage 3) its own — whether it takes
cash and at which station; the cash host each station's (the coins and notes, the change policy, the
timers, the float levels, the lamps and switches…) and its own driver paths. Delivered resolved and
TYPED by `GET /sync/{m}/cash` (`typed`): a list as a JSON list, a map as a JSON object.

Lists and maps are stored as `string` parameters and checked on every write (`VALIDATED_KEYS`,
`clean_value`, wired in app/services/till_parameters.py `validate_keyed_value`), like `remotePrintHosts`:

* `cashCoinsAccepted` / `cashNotesAccepted` — agorot, comma separated, of the shekel's coins / notes;
* `cashAlertTills` — till ids, comma separated ('' = the shop's main till);
* `cashStation` — a station id, or '' (the shop's only station);
* `cashFloatLevels`, `cashCashboxCapacity`, `cashLampMap`, `cashSwitchMap` — JSON objects.

A value that does not parse is refused on save (422, the parameters page shows it); what reaches a
device is always canonical.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional, Tuple

# ── The keys ──────────────────────────────────────────────────────────────────

ENABLED_KEY = "cashEnabled"
STATION_KEY = "cashStation"
COINS_KEY = "cashCoinsAccepted"
NOTES_KEY = "cashNotesAccepted"
MAX_CHANGE_KEY = "cashMaxChangeAgorot"
EXACT_BELOW_KEY = "cashExactChangeBelowAgorot"
SHORTFALL_KEY = "cashChangeShortfall"
ALERT_TILLS_KEY = "cashAlertTills"
INSERT_TIMEOUT_KEY = "cashInsertTimeoutSec"
IDLE_TIMEOUT_KEY = "cashIdleTimeoutSec"
QUEUE_TIMEOUT_KEY = "cashQueueTimeoutSec"
REFUND_GRACE_KEY = "cashRefundGraceSec"
ROUNDING_KEY = "cashRounding"
SPLIT_KEY = "cashSplitWithCard"
FLOAT_LEVELS_KEY = "cashFloatLevels"
CASHBOX_KEY = "cashCashboxCapacity"
LAMP_MAP_KEY = "cashLampMap"
SWITCH_MAP_KEY = "cashSwitchMap"
RECEIPT_LINES_KEY = "cashReceiptLines"
SIMULATOR_KEY = "cashSimulator"
DRIVER_PATH_KEY = "cashDriverPath"
DLL_PATH_KEY = "cashDllPath"
SETTLE_KEY = "cashSettleMs"
PAYOUT_TIMEOUT_KEY = "cashPayoutTimeoutSec"
ESCROW_KEY = "cashExtendedEscrow"
HOPPER_FEEDS_KEY = "cashHopperFeeds"
UNACKED_KEY = "cashUnackedHoldMin"
#: Stage 2 (P:/specs/cash-paylink.md §11.15): the kiosk's "חסר עודף" choice wait, the station's wait for the card.
OWED_CHOICE_KEY = "cashOwedChoiceSec"
SPLIT_WAIT_KEY = "cashSplitWaitSec"

#: The shekel's coins and notes, in agorot (10 אג' – 10 ₪; 20 / 50 / 100 / 200 ₪).
ILS_COINS: Tuple[int, ...] = (10, 50, 100, 200, 500, 1000)
ILS_NOTES: Tuple[int, ...] = (2000, 5000, 10000, 20000)

SHORTFALL_PREVENT = "prevent"
SHORTFALL_NOTIFY = "notify"
SHORTFALL_ASK = "ask"
SHORTFALL_OPTIONS = (SHORTFALL_PREVENT, SHORTFALL_NOTIFY, SHORTFALL_ASK)
SHORTFALL_LABELS = {
    SHORTFALL_PREVENT: "חסימה מראש בלבד (\"סכום מדויק\" כשהעודף נמוך)",
    SHORTFALL_NOTIFY: "פתק \"עודף חייב\" + התראה למנהל ולקופה (ברירת מחדל)",
    SHORTFALL_ASK: "לשאול את הלקוח: פתק לקופה, זיכוי להזמנה הבאה או טיפ",
}
ROUNDING_NONE = "none"
ROUNDING_NEAREST_10 = "nearest_10"
ROUNDING_OPTIONS = (ROUNDING_NONE, ROUNDING_NEAREST_10)
ROUNDING_LABELS = {
    ROUNDING_NONE: "ללא עיגול",
    ROUNDING_NEAREST_10: "לעשרות אגורות: 1–4 למטה, 5–9 למעלה (ברירת מחדל)",
}
HOPPER_FEEDS_OPTIONS = ("auto", "all", "none")
HOPPER_FEEDS_LABELS = {
    "auto": "אוטומטי (ברירת מחדל)",
    "all": "כל המטבעות למכונות העודף",
    "none": "אף מטבע — הכל לקופסה",
}
DOOR_MEANS = ("closed", "open")
CASHBOX_MEANS = ("present", "removed")
#: A PayLink has 16 inputs and 16 outputs; the driver numbers up to 64.
IO_MAX = 63

#: A kiosk's (or a till's) own: whether it takes cash, at which station, its receipt lines.
KIOSK_KEYS: Tuple[str, ...] = (ENABLED_KEY, STATION_KEY, SPLIT_KEY, RECEIPT_LINES_KEY, OWED_CHOICE_KEY)
#: Read by both the station (on the host) and the kiosk.
SHARED_KEYS: Tuple[str, ...] = (INSERT_TIMEOUT_KEY, IDLE_TIMEOUT_KEY, QUEUE_TIMEOUT_KEY, REFUND_GRACE_KEY)
#: A station's: overridable on the station itself.
STATION_ONLY_KEYS: Tuple[str, ...] = (
    COINS_KEY, NOTES_KEY, MAX_CHANGE_KEY, EXACT_BELOW_KEY, SHORTFALL_KEY, ALERT_TILLS_KEY, ROUNDING_KEY,
    FLOAT_LEVELS_KEY, CASHBOX_KEY, LAMP_MAP_KEY, SWITCH_MAP_KEY, SIMULATOR_KEY, SETTLE_KEY, PAYOUT_TIMEOUT_KEY,
    ESCROW_KEY, HOPPER_FEEDS_KEY, UNACKED_KEY, SPLIT_WAIT_KEY,
)
STATION_KEYS: Tuple[str, ...] = STATION_ONLY_KEYS + SHARED_KEYS
#: The host box's own: where the maker's driver and DLL are ('' = the maker's install path).
HOST_KEYS: Tuple[str, ...] = (DRIVER_PATH_KEY, DLL_PATH_KEY)
#: Every §11.10 key, in the table's order.
ALL_KEYS: Tuple[str, ...] = (
    ENABLED_KEY, STATION_KEY, COINS_KEY, NOTES_KEY, MAX_CHANGE_KEY, EXACT_BELOW_KEY, SHORTFALL_KEY, ALERT_TILLS_KEY,
    INSERT_TIMEOUT_KEY, IDLE_TIMEOUT_KEY, QUEUE_TIMEOUT_KEY, REFUND_GRACE_KEY, ROUNDING_KEY, SPLIT_KEY,
    FLOAT_LEVELS_KEY, CASHBOX_KEY, LAMP_MAP_KEY, SWITCH_MAP_KEY, RECEIPT_LINES_KEY, SIMULATOR_KEY,
    DRIVER_PATH_KEY, DLL_PATH_KEY, SETTLE_KEY, PAYOUT_TIMEOUT_KEY, ESCROW_KEY, HOPPER_FEEDS_KEY, UNACKED_KEY,
    OWED_CHOICE_KEY, SPLIT_WAIT_KEY,
)

#: Integer keys and their ranges.
RANGES: Dict[str, Tuple[int, int]] = {
    MAX_CHANGE_KEY: (0, 1_000_000),
    EXACT_BELOW_KEY: (0, 1_000_000),
    INSERT_TIMEOUT_KEY: (20, 1800),
    IDLE_TIMEOUT_KEY: (10, 600),
    QUEUE_TIMEOUT_KEY: (10, 1800),
    REFUND_GRACE_KEY: (10, 1800),
    SETTLE_KEY: (0, 10_000),
    PAYOUT_TIMEOUT_KEY: (5, 600),
    UNACKED_KEY: (1, 1440),
    OWED_CHOICE_KEY: (10, 300),
    SPLIT_WAIT_KEY: (60, 1800),
}
ENUMS: Dict[str, Tuple[str, ...]] = {
    SHORTFALL_KEY: SHORTFALL_OPTIONS,
    ROUNDING_KEY: ROUNDING_OPTIONS,
    HOPPER_FEEDS_KEY: HOPPER_FEEDS_OPTIONS,
}
LIST_KEYS = (COINS_KEY, NOTES_KEY, ALERT_TILLS_KEY)
MAP_KEYS = (FLOAT_LEVELS_KEY, CASHBOX_KEY, LAMP_MAP_KEY, SWITCH_MAP_KEY)
PATH_KEYS = (DRIVER_PATH_KEY, DLL_PATH_KEY)
#: Checked beyond their type on every write (app/services/till_parameters.py `validate_keyed_value`).
VALIDATED_KEYS = frozenset((STATION_KEY,) + LIST_KEYS + MAP_KEYS + PATH_KEYS + tuple(RANGES) + tuple(ENUMS))
TILLS_MAX = 50
PATH_MAX = 260

DEFAULT_COINS = ",".join(str(c) for c in ILS_COINS)
DEFAULT_NOTES = ",".join(str(n) for n in ILS_NOTES)
DEFAULT_CASHBOX = '{"coins":1500,"notes":500}'

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או מכשיר"
_STATION = f"{_LEVELS}; עמדת מזומן יכולה לדרוס אותו בעמוד עמדות המזומן."
_KIOSK = f"{_LEVELS} (בדרך כלל בקיוסק עצמו)."


def _spec(key, label, value_type, default, description, *, options=None, labels=None) -> Dict[str, Any]:
    out = dict(key=key, label=label, value_type=value_type, default_value=default, description=description)
    if options is not None:
        out["enum_options"] = options
    if labels is not None:
        out["enum_labels"] = labels
    return out


#: The built-ins (app/services/till_parameters.py `BUILTIN_PARAMETERS`).
PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    _spec(ENABLED_KEY, "מזומן בקיוסק (עמדת מזומן)", "boolean", False,
          "כשמופעל, הקיוסק מציע \"מזומן\" (אמצעי התשלום \"עמדת מזומן\" ברשימת אמצעי התשלום של הקיוסק): הלקוח "
          "מכניס כסף במכשיר המזומן (PayLink) שמנוהל ע\"י שרת המזומן ברשת המקומית, ומקבל עודף. האריח מוצג רק "
          f"כשיש לקיוסק עמדה עם שרת שדיווח כתובת, והעמדה מוכנה. {_KIOSK}"),
    _spec(STATION_KEY, "מזומן — עמדת המזומן של הקיוסק", "string", "",
          "איזו עמדת מזומן (יחידת PayLink אחת) משרתת את הקיוסק: מזהה העמדה (בעמוד עמדות המזומן בוחרים אותה "
          "ברשימה). ריק (ברירת מחדל) — העמדה היחידה בסניף; בסניף עם כמה עמדות חובה לבחור. כמה קיוסקים יכולים "
          f"לבחור אותה עמדה — הם ממתינים בתור. {_KIOSK}"),
    _spec(COINS_KEY, "מזומן — מטבעות שמתקבלים", "string", DEFAULT_COINS,
          "אילו מטבעות עמדת המזומן מקבלת, באגורות ומופרדים בפסיק (10, 50, 100, 200, 500, 1000 — 10 אג' עד 10 ₪). "
          f"ברירת מחדל: כולם. {_STATION}"),
    _spec(NOTES_KEY, "מזומן — שטרות שמתקבלים", "string", DEFAULT_NOTES,
          "אילו שטרות עמדת המזומן מקבלת, באגורות ומופרדים בפסיק (2000, 5000, 10000, 20000 — 20 עד 200 ₪). "
          f"ברירת מחדל: כולם. {_STATION}"),
    _spec(MAX_CHANGE_KEY, "מזומן — עודף מקסימלי (אגורות)", "integer", 10000,
          "העודף הגדול ביותר שהעמדה נותנת בעסקה אחת. שטר שהיה מחייב עודף גדול מזה נחסם מראש (\"מגבלת שטר ביחס "
          f"לסכום\"). ברירת מחדל 10000 (100 ₪). {_STATION}"),
    _spec(EXACT_BELOW_KEY, "מזומן — \"סכום מדויק\" מתחת לעודף (אגורות)", "integer", 3000,
          "כשהעודף שבמכשיר יורד מתחת לסכום הזה, הקיוסק מציג \"סכום מדויק בלבד\". ברירת מחדל 3000 (30 ₪). "
          + _STATION),
    _spec(SHORTFALL_KEY, "מזומן — כשאין מספיק עודף", "enum", SHORTFALL_NOTIFY,
          "מה קורה כשאי אפשר לתת את כל העודף. חסימה מראש של שטרות גדולים פועלת תמיד ראשונה. "
          f"«{SHORTFALL_LABELS[SHORTFALL_PREVENT]}» — רק החסימה. "
          f"«{SHORTFALL_LABELS[SHORTFALL_NOTIFY]}» — הקיוסק מדפיס פתק \"עודף חייב\" עם קוד, והמנהל והקופות של "
          "\"מזומן — קופות להתראות\" מקבלים התראה; בקופה \"שולם ללקוח\" רושם הוצאת מזומן ומבטל את החוב. "
          f"«{SHORTFALL_LABELS[SHORTFALL_ASK]}» — הקיוסק שואל את הלקוח: פתק \"עודף חייב\" לקופה, זיכוי להזמנה "
          f"הבאה (פתק עם קוד ו-QR, ממומש בקופה או בקיוסק) או טיפ (רק כשטיפים מופעלים בקיוסק). {_STATION}",
          options=SHORTFALL_OPTIONS, labels=SHORTFALL_LABELS),
    _spec(ALERT_TILLS_KEY, "מזומן — קופות להתראות ולעודף חייב", "string", "",
          "אילו קופות מקבלות את התראות עמדת המזומן (עודף נמוך, קופסה מלאה, תקיעה, דלת פתוחה, שרת מנותק, זיכוי "
          "מוחזק) ואת רשימת \"עודף חייב\" עם \"שולם ללקוח\": מזהי הקופות מופרדים בפסיק. ריק (ברירת מחדל) — "
          f"הקופה הראשית של הסניף. {_STATION}"),
    _spec(INSERT_TIMEOUT_KEY, "מזומן — זמן להכנסת כסף (שניות)", "integer", 180,
          f"כמה זמן יש ללקוח להשלים את הסכום לפני שהעסקה מבוטלת והכסף מוחזר (20–1800). {_STATION}"),
    _spec(IDLE_TIMEOUT_KEY, "מזומן — זמן חוסר פעילות (שניות)", "integer", 60,
          f"בלי הכנסת כסף בזמן הזה העסקה מבוטלת והכסף מוחזר (10–600). {_STATION}"),
    _spec(QUEUE_TIMEOUT_KEY, "מזומן — זמן המתנה בתור (שניות)", "integer", 120,
          "קיוסק שממתין בתור לעמדה תפוסה יותר מזה מציג \"ההמתנה ארוכה מהרגיל\" (ואפשר לעבור לאשראי או לתשלום "
          f"בקופה) (10–1800). {_STATION}"),
    _spec(REFUND_GRACE_KEY, "מזומן — זמן חסד לפני החזר (שניות)", "integer", 120,
          "קיוסק שנעלם באמצע עסקה: השרת ממתין כך לפני שהוא מחזיר את הכסף ללקוח שליד המכשיר; מה שלא הוחזר נשמר "
          f"כ\"זיכוי מוחזק\" עם התראה (10–1800). {_STATION}"),
    _spec(ROUNDING_KEY, "מזומן — עיגול", "enum", ROUNDING_NEAREST_10,
          f"«{ROUNDING_LABELS[ROUNDING_NEAREST_10]}» — הסכום לתשלום במזומן מעוגל לעשרות אגורות. "
          f"«{ROUNDING_LABELS[ROUNDING_NONE]}». {_STATION}",
          options=ROUNDING_OPTIONS, labels=ROUNDING_LABELS),
    _spec(SPLIT_KEY, "מזומן — מזומן + אשראי ליתרה", "boolean", False,
          "כשמופעל, בזמן הכנסת הכסף הקיוסק מציע \"להשלים באשראי\": מה שהוכנס נשאר במכשיר, והיתרה (והטיפ) "
          "מחויבת במסופון האשראי של הקיוסק; המסמך יוצא עם שתי רגלי תשלום. נדחה — המזומן מוחזר. דורש מסופון "
          f"אשראי בקיוסק. כבוי (ברירת מחדל). {_KIOSK}"),
    _spec(OWED_CHOICE_KEY, "מזומן — זמן לבחירה כשחסר עודף (שניות)", "integer", 45,
          "במדיניות \"לשאול את הלקוח\": כמה זמן מסך \"חסר עודף\" ממתין לבחירה; בלי בחירה — פתק \"עודף חייב\" "
          f"לקופה (10–300). {_KIOSK}"),
    _spec(SPLIT_WAIT_KEY, "מזומן — המתנה לאשראי במזומן + אשראי (שניות)", "integer", 300,
          "כמה זמן העמדה מחזיקה את המזומן שהוכנס בזמן שהקיוסק מחייב את היתרה באשראי; אחרי זה המזומן נשמר "
          f"כ\"זיכוי מוחזק\" עם התראה (לא מוחזר — ייתכן שהאשראי חויב) (60–1800). {_STATION}"),
    _spec(FLOAT_LEVELS_KEY, "מזומן — מלאי עודף לכל ערך (JSON)", "string", "{}",
          "לכל ערך (באגורות) — היעד והרף הנמוך במכונת העודף, למשל {\"100\":{\"target\":200,\"low\":30}}. מתחת "
          f"לרף: התראת \"עודף נמוך\". ריק {{}} — לפי המכשיר. {_STATION}"),
    _spec(CASHBOX_KEY, "מזומן — קיבולת קופסת השטרות והמטבעות (JSON)", "string", DEFAULT_CASHBOX,
          "כמה שטרות ומטבעות הקופסה מחזיקה, למשל {\"notes\":500,\"coins\":1500}: לקראת המילוי — \"קופסה כמעט "
          f"מלאה\". {_STATION}"),
    _spec(LAMP_MAP_KEY, "מזומן — מיפוי נורות (JSON)", "string", "{}",
          "יציאות ה-PayLink לנורות: {\"busy\":0,\"fault\":1,\"ready\":2,\"clients\":{\"<מזהה קיוסק>\":3}} — "
          f"נורה או חץ מעל המכשיר שמצביעים על הקיוסק. ריק — בלי נורות. {_STATION}"),
    _spec(SWITCH_MAP_KEY, "מזומן — מיפוי מתגים (JSON)", "string", "{}",
          "כניסות ה-PayLink למתגים: {\"door\":{\"n\":0,\"closedMeans\":\"closed\"},\"cashbox\":{\"n\":1,"
          f"\"closedMeans\":\"present\"}} — דלת פתוחה, קופסה הוסרה. ריק — בלי מתגים. {_STATION}"),
    _spec(RECEIPT_LINES_KEY, "מזומן — שורות \"שולם / עודף\" בקבלה", "boolean", True,
          "כשמופעל, קבלת הקיוסק מציגה \"שולם במזומן\", \"עודף\", \"עודף חייב\" עם הקוד ו\"עיגול מזומן\". "
          + _KIOSK),
    _spec(SIMULATOR_KEY, "מזומן — מצב סימולטור", "boolean", False,
          f"לבדיקות בלבד: שרת המזומן מפעיל מכשיר מדומה במקום ה-PayLink. {_STATION}"),
    _spec(DRIVER_PATH_KEY, "מזומן — נתיב הדרייבר (Paylink.exe)", "string", "",
          "איפה מותקן Paylink.exe בשרת המזומן. ריק (ברירת מחדל) — נתיב ההתקנה של היצרן. לא נמצא — התראה "
          f"\"דרייבר מזומן לא מותקן\". {_LEVELS}."),
    _spec(DLL_PATH_KEY, "מזומן — נתיב הספרייה (AESImhei64.dll)", "string", "",
          f"איפה נמצאת AESImhei64.dll בשרת המזומן. ריק (ברירת מחדל) — נתיב ההתקנה של היצרן. {_LEVELS}."),
    _spec(SETTLE_KEY, "מזומן — המתנה למטבע באוויר (מ\"ש)", "integer", 1000,
          f"אחרי שהסכום הושלם והקבלה נסגרה: כמה לחכות לפני העודף (0–10000). {_STATION}"),
    _spec(PAYOUT_TIMEOUT_KEY, "מזומן — זמן לתשלום עודף (שניות)", "integer", 60,
          f"שטר עודף שלא נלקח בזמן הזה חוזר למכשיר (5–600). {_STATION}"),
    _spec(ESCROW_KEY, "מזומן — החזקת שטרות לפני קבלה", "boolean", True,
          "כשמופעל ויש במכשיר אפשרות, שטר נשאר בהחזקה עד שהעסקה מושלמת — בביטול הלקוח מקבל את השטר שלו. "
          + _STATION),
    _spec(HOPPER_FEEDS_KEY, "מזומן — מטבעות למכונות העודף", "enum", "auto",
          f"האם מטבעות שהוכנסו ממלאים את מכונות העודף. {_STATION}",
          options=HOPPER_FEEDS_OPTIONS, labels=HOPPER_FEEDS_LABELS),
    _spec(UNACKED_KEY, "מזומן — עסקה ששולמה ולא אושרה (דקות)", "integer", 30,
          "עסקה ששולמה במלואה והקיוסק לא אישר שהפיק עליה מסמך בזמן הזה עוברת ל\"זיכוי מוחזק\" עם התראה "
          f"(1–1440). {_STATION}"),
)


# ── Cleaning (the parameters page's writes, a station's overrides) ────────────


def _ids(value: str, key: str, what: str) -> List[str]:
    out: List[str] = []
    for part in value.replace(";", ",").replace("\n", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ident = str(uuid.UUID(part))
        except ValueError:
            raise ValueError(f"{key} must be {what} separated by commas") from None
        if ident not in out:
            out.append(ident)
    if len(out) > TILLS_MAX:
        raise ValueError(f"{key}: at most {TILLS_MAX}")
    return out


def _denominations(value: str, key: str, allowed: Tuple[int, ...]) -> List[int]:
    out: List[int] = []
    for part in value.replace(";", ",").replace(" ", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            raise ValueError(f"{key} must be agorot separated by commas") from None
        if n not in allowed:
            raise ValueError(f"{key}: {n} is not one of {', '.join(str(a) for a in allowed)}")
        if n not in out:
            out.append(n)
    return sorted(out)


def _int(value: Any, lo: int, hi: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi


def _io(value: Any) -> bool:
    return value is None or _int(value, 0, IO_MAX)


def _json_object(value: Any, key: str) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a JSON object")
    text = value.strip() or "{}"
    try:
        parsed = json.loads(text)
    except ValueError:
        raise ValueError(f"{key} must be a JSON object") from None
    if not isinstance(parsed, dict):
        raise ValueError(f"{key} must be a JSON object")
    return parsed


def _clean_map(key: str, obj: Dict[str, Any]) -> Dict[str, Any]:
    if key == FLOAT_LEVELS_KEY:
        out: Dict[str, Any] = {}
        for denom, level in obj.items():
            if not str(denom).isdigit() or int(denom) not in ILS_COINS + ILS_NOTES:
                raise ValueError(f"{key}: {denom!r} is not a coin or a note in agorot")
            if not isinstance(level, dict) or set(level) - {"target", "low"}:
                raise ValueError(f"{key}: each value is {{\"target\": n, \"low\": n}}")
            if any(not _int(level.get(f, 0), 0, 100_000) for f in ("target", "low")):
                raise ValueError(f"{key}: target and low are counts 0–100000")
            out[str(int(denom))] = {f: level[f] for f in ("target", "low") if f in level}
        return dict(sorted(out.items(), key=lambda kv: int(kv[0])))
    if key == CASHBOX_KEY:
        if set(obj) - {"notes", "coins"} or any(not _int(v, 0, 1_000_000) for v in obj.values()):
            raise ValueError(f"{key} is {{\"notes\": n, \"coins\": n}}")
        return dict(sorted(obj.items()))
    if key == LAMP_MAP_KEY:
        if set(obj) - {"busy", "fault", "ready", "clients"}:
            raise ValueError(f"{key} takes busy, fault, ready and clients")
        for f in ("busy", "fault", "ready"):
            if f in obj and not _io(obj[f]):
                raise ValueError(f"{key}.{f} is an output 0–{IO_MAX} or null")
        clients = obj.get("clients", {})
        if not isinstance(clients, dict):
            raise ValueError(f"{key}.clients is {{\"<device id>\": output}}")
        cleaned: Dict[str, Any] = {}
        for ident, n in clients.items():
            try:
                ident = str(uuid.UUID(str(ident)))
            except ValueError:
                raise ValueError(f"{key}.clients: {ident!r} is not a device id") from None
            if not _int(n, 0, IO_MAX):
                raise ValueError(f"{key}.clients: outputs are 0–{IO_MAX}")
            cleaned[ident] = n
        out = {f: obj[f] for f in ("busy", "fault", "ready") if f in obj}
        if "clients" in obj:
            out["clients"] = cleaned
        return out
    if key == SWITCH_MAP_KEY:
        if set(obj) - {"door", "cashbox"}:
            raise ValueError(f"{key} takes door and cashbox")
        out = {}
        for f, means in (("door", DOOR_MEANS), ("cashbox", CASHBOX_MEANS)):
            if f not in obj:
                continue
            item = obj[f]
            if item is None:
                out[f] = None
                continue
            if (not isinstance(item, dict) or set(item) - {"n", "closedMeans"} or not _int(item.get("n"), 0, IO_MAX)
                    or item.get("closedMeans", means[0]) not in means):
                raise ValueError(f"{key}.{f} is {{\"n\": 0–{IO_MAX}, \"closedMeans\": {' | '.join(means)}}}")
            out[f] = {"n": item["n"], "closedMeans": item.get("closedMeans", means[0])}
        return out
    return obj


def clean_value(key: str, value: Any) -> Any:
    """`value` as stored for `key` (canonical text for the lists and maps), else ValueError."""
    if value is None or key not in VALIDATED_KEYS:
        return value
    if key in RANGES:
        lo, hi = RANGES[key]
        if not _int(value, lo, hi):
            raise ValueError(f"{key} must be a whole number {lo}–{hi}")
        return value
    if key in ENUMS:
        if value not in ENUMS[key]:
            raise ValueError(f"{key} must be one of {', '.join(ENUMS[key])}")
        return value
    if key in MAP_KEYS:
        obj = _clean_map(key, _json_object(value, key))
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=key != SWITCH_MAP_KEY)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be text")
    if key == STATION_KEY:
        text = value.strip()
        if not text:
            return ""
        try:
            return str(uuid.UUID(text))
        except ValueError:
            raise ValueError(f"{STATION_KEY} must be a cash station id, or empty") from None
    if key == COINS_KEY:
        return ",".join(str(n) for n in _denominations(value, key, ILS_COINS))
    if key == NOTES_KEY:
        return ",".join(str(n) for n in _denominations(value, key, ILS_NOTES))
    if key == ALERT_TILLS_KEY:
        return ",".join(_ids(value, key, "till ids"))
    if key in PATH_KEYS:
        text = value.strip()
        if len(text) > PATH_MAX or any(c in text for c in "\r\n\t\0"):
            raise ValueError(f"{key} must be a Windows path of at most {PATH_MAX} characters")
        return text
    return value


# ── Typed, for the devices ─────────────────────────────────────────────────────


def _default_of(key: str) -> Any:
    for spec in PARAMETER_SPECS:
        if spec["key"] == key:
            return spec["default_value"]
    return None


def typed_value(key: str, value: Any) -> Any:
    """A resolved parameter as a device reads it: the lists as JSON lists, the maps as JSON objects."""
    if value is None:
        value = _default_of(key)
    try:
        if key in (COINS_KEY, NOTES_KEY):
            if isinstance(value, list):
                return [int(v) for v in value]
            return [int(p) for p in str(value or "").split(",") if p.strip()]
        if key == ALERT_TILLS_KEY:
            if isinstance(value, list):
                return [str(v) for v in value]
            return [p.strip() for p in str(value or "").split(",") if p.strip()]
        if key in MAP_KEYS:
            return _json_object(value, key)
    except (TypeError, ValueError):
        return typed_value(key, _default_of(key)) if value != _default_of(key) else None
    return value


def typed(params: Dict[str, Any], keys: Tuple[str, ...] = ALL_KEYS) -> Dict[str, Any]:
    """`keys` of a resolved parameter map, typed (`typed_value`); a key the map lacks takes its default."""
    return {key: typed_value(key, params.get(key)) for key in keys}


def clean_overrides(raw: Any) -> Dict[str, Any]:
    """
    A station's own settings (`cash_stations.settings`) from the dashboard: only station keys, each checked
    as the parameters page checks it, stored typed. ValueError naming the key otherwise. Null: none.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("settings must be an object of station parameters")
    from app.services.till_parameters import TillParameterValueError, validate_value

    kinds = {spec["key"]: spec for spec in PARAMETER_SPECS}
    out: Dict[str, Any] = {}
    for key, value in raw.items():
        if key not in STATION_KEYS:
            raise ValueError(f"{key} is not a station setting")
        if value is None:
            continue  # "inherit"
        spec = kinds[key]
        stored = value
        if key in (COINS_KEY, NOTES_KEY, ALERT_TILLS_KEY) and isinstance(value, list):
            stored = ",".join(str(v) for v in value)
        try:
            stored = clean_value(key, stored)
            validate_value(spec["value_type"], stored, spec.get("enum_options"))
        except (ValueError, TillParameterValueError) as exc:
            raise ValueError(f"{key}: {exc}") from None
        out[key] = typed_value(key, stored)
    return out
