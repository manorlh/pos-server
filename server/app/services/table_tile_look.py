"""
"עיצוב השולחנות" in the till design's "שולחנות ומפה" tab (P:/specs/till-design-tables.md §1, the
contract §5): how the till draws each table on its tables screen — till parameters, per company →
shop → point of sale → till like every till parameter (`PARAMETER_SPECS`, registered in
app/services/till_parameters.py), edited in "עיצוב קופה" beside the map's legend and display
(app/services/table_map_display.py; app/routers/till_design.py `/till-design/table-display`) and on
the parameters page. Read by the till only. Nothing set: the till looks exactly as today.

* `tableTileStyle` — `soft` (today's: a light tint of the state's colour and a ring in it; the
  default) | `filled` (the whole table in the state's colour) | `outline` (a frame in it only).
* `tableTileInfo` — what is written on a table, as a comma list of `guests`, `time`, `amount`,
  `waiter`, `course` (the next course to fire), `seats`, stored in that order; `none` — the number
  only. Default `guests,time,amount`.
* `tableStateColors` — a JSON object, a `#rrggbb` per state: `free`, `occupied`, `kitchen`, `toPay`,
  `otherTill`, `overdue`, `reserved`. Stored whole (a key left out gets its default), lower case,
  compact, in that order. The defaults are the till's colours today (pos-android
  ui/tables/TableVisuals.kt, the classic look); a state at its default is drawn as today in both looks.
* `tableOverdueMinutes` — minutes with no action on an open table before it shows "מתעכב", 5–600 (45).
* `tableNumberSize` — `s` | `m` (today's, the default) | `l`.

`clean_value` refuses anything else (ValueError), whatever route writes it.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Tuple

STYLE_KEY = "tableTileStyle"
INFO_KEY = "tableTileInfo"
COLORS_KEY = "tableStateColors"
OVERDUE_KEY = "tableOverdueMinutes"
NUMBER_SIZE_KEY = "tableNumberSize"

STYLE_SOFT = "soft"
STYLE_FILLED = "filled"
STYLE_OUTLINE = "outline"
STYLE_OPTIONS = (STYLE_SOFT, STYLE_FILLED, STYLE_OUTLINE)
STYLE_LABELS = {
    STYLE_SOFT: "רך — גוון בהיר ומסגרת בצבע המצב (כמו היום)",
    STYLE_FILLED: "מלא — כל השולחן בצבע המצב",
    STYLE_OUTLINE: "מסגרת — רק מסגרת בצבע המצב",
}

#: What may be written on a table, in the order the till writes them.
INFO_FIELDS = ("guests", "time", "amount", "waiter", "course", "seats")
INFO_LABELS = {
    "guests": "סועדים",
    "time": "זמן ישיבה",
    "amount": "סכום",
    "waiter": "מלצר",
    "course": "השלב הבא",
    "seats": "מקומות",
}
#: The number only (an empty list, written so it is never mistaken for "not set").
INFO_NONE = "none"
INFO_DEFAULT = "guests,time,amount"

#: The states and their colours today (TableVisuals.kt: classicBadgeColor / stateRing).
STATES = ("free", "occupied", "kitchen", "toPay", "otherTill", "overdue", "reserved")
STATE_LABELS = {
    "free": "פנוי",
    "occupied": "תפוס",
    "kitchen": "נשלח למטבח",
    "toPay": "לתשלום",
    "otherTill": "בקופה אחרת",
    "overdue": "מתעכב",
    "reserved": "שמור",
}
DEFAULT_COLORS: Dict[str, str] = {
    "free": "#34c759",
    "occupied": "#3b82f6",
    "kitchen": "#f97316",
    "toPay": "#ff9500",
    "otherTill": "#af52de",
    "overdue": "#ff3b30",
    "reserved": "#30b0c7",
}
HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")

OVERDUE_MIN = 5
OVERDUE_MAX = 600
OVERDUE_DEFAULT = 45

NUMBER_SIZES = ("s", "m", "l")
NUMBER_SIZE_LABELS = {"s": "קטן", "m": "רגיל", "l": "גדול"}
NUMBER_SIZE_DEFAULT = "m"


def colors_text(colors: Dict[str, str]) -> str:
    """The stored form: every state, in `STATES` order, compact."""
    return json.dumps({state: colors[state] for state in STATES}, separators=(",", ":"))


COLORS_DEFAULT = colors_text(DEFAULT_COLORS)

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=STYLE_KEY,
        label="מפת שולחנות — סגנון השולחן",
        value_type="enum",
        enum_options=STYLE_OPTIONS,
        enum_labels=STYLE_LABELS,
        default_value=STYLE_SOFT,
        description=(
            "איך צבע המצב (פנוי, תפוס, לתשלום...) מופיע על השולחן במסך השולחנות בקופה. "
            f"«{STYLE_LABELS[STYLE_SOFT]}» (ברירת מחדל). "
            f"«{STYLE_LABELS[STYLE_FILLED]}» — המספר בלבן, או בכהה על צבע בהיר. "
            f"«{STYLE_LABELS[STYLE_OUTLINE]}» — השולחן בצבעו הרגיל. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=INFO_KEY,
        label="מפת שולחנות — מידע על השולחן",
        value_type="string",
        default_value=INFO_DEFAULT,
        description=(
            "מה כתוב על שולחן תפוס מתחת למספר, לפי הסדר, כמה שנכנס: "
            + ", ".join(f"{code} ({INFO_LABELS[code]})" for code in INFO_FIELDS)
            + f". רשימה מופרדת בפסיקים, או {INFO_NONE} — רק המספר. ברירת מחדל: {INFO_DEFAULT}. "
            "המילה של המצב (פנוי, שלי, לתשלום...) נשארת תמיד."
        ),
    ),
    dict(
        key=COLORS_KEY,
        label="מפת שולחנות — צבע לכל מצב",
        value_type="string",
        default_value=COLORS_DEFAULT,
        description=(
            "צבע (#RRGGBB) לכל מצב של שולחן, כאובייקט JSON: "
            + ", ".join(f"{s} ({STATE_LABELS[s]})" for s in STATES)
            + ". ברירת המחדל היא הצבעים של היום; מצב שצבעו לא שונה מצויר בדיוק כמו היום."
        ),
    ),
    dict(
        key=OVERDUE_KEY,
        label="מפת שולחנות — \"מתעכב\" אחרי (דקות בלי פעולה)",
        value_type="integer",
        default_value=OVERDUE_DEFAULT,
        description=(
            "אחרי כמה דקות בלי פעולה (פתיחה, הוספת פריט, שליחה למטבח) שולחן פתוח נצבע בצבע \"מתעכב\" "
            f"({OVERDUE_MIN}–{OVERDUE_MAX}, ברירת מחדל {OVERDUE_DEFAULT})."
        ),
    ),
    dict(
        key=NUMBER_SIZE_KEY,
        label="מפת שולחנות — גודל מספר השולחן",
        value_type="enum",
        enum_options=NUMBER_SIZES,
        enum_labels=NUMBER_SIZE_LABELS,
        default_value=NUMBER_SIZE_DEFAULT,
        description=(
            "גודל המספר על השולחן במסך השולחנות בקופה. "
            f"«{NUMBER_SIZE_LABELS['m']}» (ברירת מחדל) — כמו היום, לפי \"גודל שם שולחן\"; "
            f"«{NUMBER_SIZE_LABELS['s']}» ו«{NUMBER_SIZE_LABELS['l']}» גוברים עליו."
        ),
    ),
)

#: The keys, in the order the dashboard lists them.
LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
#: The keys whose value is checked beyond its type (`clean_value`).
VALIDATED_KEYS = frozenset(LEVEL_KEYS)

#: The till design's "שולחנות ומפה" card (`/till-design/table-display`): these, then the map's legend
#: and display (app/services/table_map_display.py, the tables page's `mapDisplay` group too).
TILE_LOOK_GROUP = "tileLook"


def till_design_groups() -> Tuple[Tuple[str, str, Tuple[str, ...]], ...]:
    """(key, label, keys) of each group of the till design's card, in its order."""
    from app.services import table_map_display
    from app.services.table_restore import MAP_DISPLAY_GROUP

    return (
        (TILE_LOOK_GROUP, "עיצוב השולחנות", LEVEL_KEYS),
        (MAP_DISPLAY_GROUP, "מפת השולחנות בקופה — מקרא ותצוגה", table_map_display.LEVEL_KEYS),
    )


def till_design_keys() -> Tuple[str, ...]:
    """Every key of the till design's card, in its order."""
    return tuple(key for _group, _label, keys in till_design_groups() for key in keys)


def parse_info(value: Any) -> List[str]:
    """`"time, guests"` → ['guests', 'time'] (the till's order); `none` → []. ValueError otherwise."""
    if not isinstance(value, str):
        raise ValueError(f"{INFO_KEY} must be text")
    text = value.strip().lower()
    if text == INFO_NONE:
        return []
    parts = [p.strip() for p in text.split(",")]
    if not text or any(not p for p in parts):
        raise ValueError(f"{INFO_KEY}: a comma list of {', '.join(INFO_FIELDS)}, or {INFO_NONE}")
    unknown = [p for p in parts if p not in INFO_FIELDS]
    if unknown:
        raise ValueError(f"{INFO_KEY}: unknown item {unknown[0]!r} (one of {', '.join(INFO_FIELDS)})")
    if len(set(parts)) != len(parts):
        raise ValueError(f"{INFO_KEY}: an item is listed twice")
    return [f for f in INFO_FIELDS if f in parts]


def parse_colors(value: Any) -> Dict[str, str]:
    """
    A JSON object (as text, or already an object) → every state's colour, lower case; a state left
    out gets its default. ValueError on anything that is not an object of known states and `#RRGGBB`.
    """
    data = value
    if isinstance(value, str):
        try:
            data = json.loads(value)
        except ValueError as exc:
            raise ValueError(f"{COLORS_KEY} must be a JSON object") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{COLORS_KEY} must be a JSON object")
    unknown = [k for k in data if k not in STATES]
    if unknown:
        raise ValueError(f"{COLORS_KEY}: unknown state {unknown[0]!r} (one of {', '.join(STATES)})")
    out = dict(DEFAULT_COLORS)
    for state, color in data.items():
        if not isinstance(color, str) or not HEX_PATTERN.match(color.strip()):
            raise ValueError(f"{COLORS_KEY}: {state} must be a colour #RRGGBB")
        out[state] = color.strip().lower()
    return out


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key` (normalised), or ValueError. Other keys pass as they are."""
    if value is None:
        return None
    if key == STYLE_KEY:
        if value not in STYLE_OPTIONS:
            raise ValueError(f"{STYLE_KEY} must be one of {', '.join(STYLE_OPTIONS)}")
        return value
    if key == NUMBER_SIZE_KEY:
        if value not in NUMBER_SIZES:
            raise ValueError(f"{NUMBER_SIZE_KEY} must be one of {', '.join(NUMBER_SIZES)}")
        return value
    if key == INFO_KEY:
        fields = parse_info(value)
        return ",".join(fields) if fields else INFO_NONE
    if key == COLORS_KEY:
        return colors_text(parse_colors(value))
    if key == OVERDUE_KEY:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{OVERDUE_KEY} must be a whole number")
        if isinstance(value, float):
            if not value.is_integer():
                raise ValueError(f"{OVERDUE_KEY} must be a whole number")
            value = int(value)
        if not OVERDUE_MIN <= value <= OVERDUE_MAX:
            raise ValueError(f"{OVERDUE_KEY} must be {OVERDUE_MIN}–{OVERDUE_MAX}")
        return value
    return value
