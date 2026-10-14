"""
"מקרא ותצוגה" of the tables map (P:/specs/table-map-decor-v3.md §3): how the till shows the
decor on its tables map — till parameters, per company → shop → point of sale → till like every
till parameter (`PARAMETER_SPECS`, registered in app/services/till_parameters.py), edited on the
dashboard's tables page beside the restore settings (app/services/table_restore.py `page_keys`,
group `mapDisplay`) and on the parameters page. Read by the till only.

* `mapDecor` — `full` (everything drawn, the default) | `symbols` (the symbols without the room's
  frame: no walls, windows, columns, sofa, logo or free drawings — `STRUCTURE_KINDS`) | `off`.
* `mapLegend` — `off` | `button` ("מקרא", the default) | `always`: the legend lists only the kinds
  the zone's plan has, by their Hebrew names; on a phone or a handheld it opens as a sheet.
* `mapSymbolLabels` — `auto` (the names where they fit, none on a phone or a handheld; the
  default) | `always` | `never`.
* `mapSymbolScale` — the symbols' size, 70–150 percent (100, the default).

The enums are codes, with their Hebrew for the dashboard (`enum_labels`); `clean_value` refuses
anything else, whatever route writes it.
"""
from __future__ import annotations

from typing import Any, Dict, Tuple

DECOR_KEY = "mapDecor"
LEGEND_KEY = "mapLegend"
LABELS_KEY = "mapSymbolLabels"
SCALE_KEY = "mapSymbolScale"

DECOR_FULL = "full"
DECOR_SYMBOLS = "symbols"
DECOR_OFF = "off"
DECOR_OPTIONS = (DECOR_FULL, DECOR_SYMBOLS, DECOR_OFF)
DECOR_LABELS = {
    DECOR_FULL: "הכל — סמלים ומבנה",
    DECOR_SYMBOLS: "רק סמלים, בלי מבנה",
    DECOR_OFF: "בלי — רק השולחנות",
}

LEGEND_OFF = "off"
LEGEND_BUTTON = "button"
LEGEND_ALWAYS = "always"
LEGEND_OPTIONS = (LEGEND_OFF, LEGEND_BUTTON, LEGEND_ALWAYS)
LEGEND_LABELS = {
    LEGEND_OFF: "בלי מקרא",
    LEGEND_BUTTON: "כפתור \"מקרא\"",
    LEGEND_ALWAYS: "תמיד מוצג",
}

LABELS_AUTO = "auto"
LABELS_ALWAYS = "always"
LABELS_NEVER = "never"
LABELS_OPTIONS = (LABELS_AUTO, LABELS_ALWAYS, LABELS_NEVER)
LABELS_LABELS = {
    LABELS_AUTO: "כשיש מקום",
    LABELS_ALWAYS: "תמיד",
    LABELS_NEVER: "אף פעם — רק הסמל",
}

SCALE_MIN = 70
SCALE_MAX = 150
SCALE_DEFAULT = 100

#: What `symbols` leaves out: the room's frame and ornament (the till's fit leaves the same out
#: of its landmarks — pos-android DecorFit.kt). Everything else — the symbols, the bars, the
#: kitchen, the stairs, labels, arrows and coloured areas — stays.
STRUCTURE_KINDS = ("wall", "window", "column", "sofa", "logo", "line", "polyline", "freehand", "rect")

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=DECOR_KEY,
        label="מפת שולחנות — סמלים ומבנה",
        value_type="enum",
        enum_options=DECOR_OPTIONS,
        enum_labels=DECOR_LABELS,
        default_value=DECOR_FULL,
        description=(
            "מה מצויר מתחת לשולחנות במפה בקופה מתוך הסקיצה שעוצבה בדשבורד. "
            f"«{DECOR_LABELS[DECOR_FULL]}» (ברירת מחדל) — כל הסקיצה. "
            f"«{DECOR_LABELS[DECOR_SYMBOLS]}» — הסמלים (שירותים, כניסה, בר, עמדות, צמחייה, אזורים צבועים, "
            "חצים וטקסט) בלי הקירות, החלונות, העמודים, הספות, הלוגו והציור החופשי. "
            f"«{DECOR_LABELS[DECOR_OFF]}» — רק השולחנות. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=LEGEND_KEY,
        label="מפת שולחנות — מקרא",
        value_type="enum",
        enum_options=LEGEND_OPTIONS,
        enum_labels=LEGEND_LABELS,
        default_value=LEGEND_BUTTON,
        description=(
            "המקרא מציג רק את הסמלים שמופיעים באזור, עם השם בעברית. "
            f"«{LEGEND_LABELS[LEGEND_BUTTON]}» (ברירת מחדל) — המקרא נפתח בלחיצה. "
            f"«{LEGEND_LABELS[LEGEND_ALWAYS]}» — מוצג ליד המפה. "
            f"«{LEGEND_LABELS[LEGEND_OFF]}» — אין מקרא. "
            "בטלפון ובמסופון המקרא נפתח כחלון."
        ),
    ),
    dict(
        key=LABELS_KEY,
        label="מפת שולחנות — שמות הסמלים",
        value_type="enum",
        enum_options=LABELS_OPTIONS,
        enum_labels=LABELS_LABELS,
        default_value=LABELS_AUTO,
        description=(
            "האם השם נכתב מתחת לסמל במפה בקופה. "
            f"«{LABELS_LABELS[LABELS_AUTO]}» (ברירת מחדל) — כשיש לו מקום בצורה; בטלפון ובמסופון בלי שמות. "
            f"«{LABELS_LABELS[LABELS_ALWAYS]}» — תמיד, גם במסך קטן. "
            f"«{LABELS_LABELS[LABELS_NEVER]}» — רק הסמלים."
        ),
    ),
    dict(
        key=SCALE_KEY,
        label="מפת שולחנות — גודל הסמלים (%)",
        value_type="integer",
        default_value=SCALE_DEFAULT,
        description=(
            f"כמה גדולים הסמלים במפה בקופה, באחוזים ({SCALE_MIN}–{SCALE_MAX}, ברירת מחדל {SCALE_DEFAULT}). "
            "הצורות עצמן (גודל השירותים, הבר…) לא משתנות — רק הסמל שבתוכן."
        ),
    ),
)

#: The keys, in the order the dashboard lists them.
LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
#: The keys whose value is checked beyond its type (`clean_value`).
VALIDATED_KEYS = frozenset(LEVEL_KEYS)

_OPTIONS = {DECOR_KEY: DECOR_OPTIONS, LEGEND_KEY: LEGEND_OPTIONS, LABELS_KEY: LABELS_OPTIONS}


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key`, or ValueError. Other keys pass as they are."""
    if value is None:
        return None
    if key in _OPTIONS:
        if value not in _OPTIONS[key]:
            raise ValueError(f"{key} must be one of {', '.join(_OPTIONS[key])}")
        return value
    if key == SCALE_KEY:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{SCALE_KEY} must be a whole number")
        if isinstance(value, float):
            if not value.is_integer():
                raise ValueError(f"{SCALE_KEY} must be a whole number")
            value = int(value)
        if not SCALE_MIN <= value <= SCALE_MAX:
            raise ValueError(f"{SCALE_KEY} must be {SCALE_MIN}–{SCALE_MAX}")
        return value
    return value
