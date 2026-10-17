"""
"גודל תצוגה" — the till parameter `displayScale` (P:/specs/display-scale.md).

The owner (16.10.2026, "אפשר בענן להגדיר וגם בקיוסק עצמו בהגדרות ולשמור"): the size of everything on a till's or a
kiosk's screen — Android and Windows — set in the cloud per company / shop / point of sale / till, and on the device
itself (its technician / local settings), saved there and winning over the cloud.

- `auto` (the default): exactly today — 100% of the size the device computes for its screen.
- a whole percent 70–150 in steps of 5: that share of the automatic size (Windows: × the window's page zoom,
  kiosk-desktop core/windowZoom.ts; Android: × the display profile's scale in ui/common/DisplayFrame.kt).

The parsing and the precedence (local > till > point of sale > shop > company > auto) are ONE rule in three places —
here, kiosk-desktop core/displayScale.ts and pos-android domain/DisplayScale.kt — pinned by the shared golden fixture
display_scale_golden.json (tests/fixtures; the same bytes in kiosk-desktop test/fixtures and the Android test
resources). The cloud itself only stores and resolves the parameter; the devices apply it.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, Mapping, Optional, Tuple, Union

KEY = "displayScale"
AUTO = "auto"
MIN_PERCENT = 70
MAX_PERCENT = 150
STEP = 5
#: Below this a number is not a percent at all (a factor such as 1.5, a slip) — not set.
MIN_READ = 10

PERCENT_OPTIONS: Tuple[str, ...] = tuple(str(p) for p in range(MIN_PERCENT, MAX_PERCENT + 1, STEP))
OPTIONS: Tuple[str, ...] = (AUTO,) + PERCENT_OPTIONS
DEFAULT = AUTO
LABELS: Dict[str, str] = {AUTO: "אוטומטי (ברירת מחדל)", **{p: f"{p}%" for p in PERCENT_OPTIONS}}

#: The cloud's levels, the most specific first (the device's own local choice is above them all).
LEVELS: Tuple[str, ...] = ("device", "area", "shop", "company")

SOURCE_LOCAL = "local"
SOURCE_CLOUD = "cloud"
SOURCE_AUTO = "auto"

_NUMBER = re.compile(r"^-?\d+(?:\.\d+)?%?$")
_AUTO_WORDS = frozenset({"auto", "אוטומטי"})

Setting = Union[str, int]

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=KEY,
        label="גודל תצוגה",
        value_type="enum",
        enum_options=OPTIONS,
        enum_labels=LABELS,
        default_value=DEFAULT,
        description=(
            "הגודל של כל מה שעל המסך — טקסט, כפתורים ומרווחים — בקופה ובקיוסק. "
            f"«{LABELS[AUTO]}» — כמו היום: המכשיר מחשב לבד את הגודל שמתאים למסך שלו. "
            f"אחוז ({MIN_PERCENT}%–{MAX_PERCENT}%) — חלק מהגודל האוטומטי: 120% מגדיל הכול בחמישית, "
            "85% מקטין ומכניס יותר למסך. "
            "בכל מכשיר אפשר גם לקבוע גודל מקומי במסך הטכנאי (הגדרות מקומיות) — הוא נשמר במכשיר וגובר על הענן; "
            "שם מוצג הגודל בפועל ומקורו (ענן / מקומי / אוטומטי). "
            "חל על קופות וקיוסקים, באנדרואיד וב-Windows. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)


def parse(value: Any) -> Optional[Setting]:
    """
    A level's (or the device's local) value as `auto`, a percent 70–150 in steps of 5, or None (not set / not valid).
    A number or a numeric text (a trailing `%` allowed) is rounded to the nearest 5 (half up) and clamped.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if text.lower() in _AUTO_WORDS:
            return AUTO
        if not _NUMBER.match(text):
            return None
        number = float(text.rstrip("%"))
    else:
        return None
    if not math.isfinite(number) or number < MIN_READ:
        return None
    stepped = int(math.floor(number / STEP + 0.5)) * STEP
    return max(MIN_PERCENT, min(MAX_PERCENT, stepped))


def percent_of(setting: Optional[Setting]) -> int:
    """The percent a setting means: `auto` (or nothing) is 100."""
    return setting if isinstance(setting, int) else 100


def effective(levels: Mapping[str, Any], local: Any = None) -> Dict[str, Any]:
    """
    What the device shows: the local choice when it has one; else the most specific cloud level with a valid value;
    else automatic. `source`: local / cloud (a percent from the cloud) / auto (automatic, from a level or by default).
    """
    mine = parse(local)
    if mine is not None:
        setting, level, source = mine, SOURCE_LOCAL, SOURCE_LOCAL
    else:
        setting, level = AUTO, None
        for name in LEVELS:
            parsed = parse(levels.get(name))
            if parsed is not None:
                setting, level = parsed, name
                break
        source = SOURCE_CLOUD if isinstance(setting, int) else SOURCE_AUTO
    percent = percent_of(setting)
    return {
        "setting": setting,
        "percent": percent,
        "factor": percent / 100,
        "source": source,
        "level": level,
    }
