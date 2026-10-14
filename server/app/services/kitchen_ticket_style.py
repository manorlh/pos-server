"""
"עיצוב בון" — how a kitchen ticket ("בון") looks: the `ticketStyle` contract
(P:/specs/kitchen-ticket-designs.md §1, §6–§8; the shared golden
tests/fixtures/kitchen_ticket_designs_golden.json, byte-identical in pos-android).

Pure rules, no database (app/services/kitchen_ticket_designs.py stores and assigns):

* **Templates** (`TEMPLATES`): `classic` — the default since 14.10 §7, smaller and aligned (a fixed
  quantity column, wrapped names / choices / notes hang under the name); `classic_legacy` — "קלאסי
  (ישן)", the ticket exactly as the till drew it before; `large`, `compact`, `courses`, `modern`.
  `template_style` is each one's full look before the ink saver.
* **A named design** ("עיצוב בון", `kitchen_ticket_designs`) is a template plus per-element
  overrides — a partial `ticketStyle` (`clean_overrides` refuses anything else).
* **The cloud resolves** (`resolve_style`) one full `ticketStyle` per printer and till and sends it in
  the printers config; the till draws by it alone. In order: the template; the till parameters SET at
  some level (`kitchenTicketFontScale`, `kitchenTicketHeader`, `kitchenTicketCheckboxes`,
  `kitchenTicketElapsed` — their defaults never beat a template's own look) and
  `kitchenTicketInkSaver` (default on); the design's overrides; the printer's own options; the
  mandatory information; then the ink saver.
* **Mandatory information is never hidden** — the bands ("תוספת", "הוצא", "לקחת" / "לשבת", "העתק",
  "הדפסה חוזרת", "הופנה מ:", "הערה לשולחן", "הדרכה"), allergies, notes and the table: the schema has
  no "hidden" value for any of them, and the table stays in the header whatever the lists say.
* **The ink saver** (`kitchenTicketInkSaver`, §6ב): every filled band becomes a double frame, the
  inverted header a thick frame, the black quantity box a frame, the allergy box a frame with ⚠, an
  important note a frame; separators thin. Off: the fills as designed.

The dashboard's preview (client/src/lib/kitchenTicketStyle.ts) is a port of these rules, pinned by
the same golden.
"""
from __future__ import annotations

import copy
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

STYLE_VERSION = 1

# ── Templates ───────────────────────────────────────────────────────────────

CLASSIC = "classic"
CLASSIC_LEGACY = "classic_legacy"
LARGE = "large"
COMPACT = "compact"
COURSES = "courses"
MODERN = "modern"
TEMPLATES: Tuple[str, ...] = (CLASSIC, CLASSIC_LEGACY, LARGE, COMPACT, COURSES, MODERN)
DEFAULT_TEMPLATE = CLASSIC
TEMPLATE_LABELS: Dict[str, str] = {
    CLASSIC: "קלאסי",
    CLASSIC_LEGACY: "קלאסי (ישן)",
    LARGE: "גדול וברור",
    COMPACT: "חסכוני",
    COURSES: "לפי קורסים ומושבים",
    MODERN: "מודרני",
}
TEMPLATE_HINTS: Dict[str, str] = {
    CLASSIC: "ברירת המחדל: קטן ומיושר — עמודת כמות קבועה, המשך השורה מתחת לשם",
    CLASSIC_LEGACY: "הבון של עד היום, בלי שינוי",
    LARGE: "מטבח עמוס, קריאה מרחוק: שולחן ענק, כמות בריבוע, שמות גדולים",
    COMPACT: "בר וקפה, חיסכון בנייר: כותרת בשורה אחת, תוספות באותה שורה",
    COURSES: "מסעדה עם מנות לפי סדר: קבוצה לכל קורס, לפי מושב, תיבות סימון",
    MODERN: "מראה נקי: בלוק שולחן עם הזמן מאז הפתיחה, תגים מעוגלים, קווים מקווקווים",
}

# ── The vocabulary ──────────────────────────────────────────────────────────

#: What the ticket says about the order, as `kitchenTicketHeader` lists it (P:/specs §2).
INFO_FIELDS: Tuple[str, ...] = ("table", "guests", "waiter", "time", "till", "order", "customer")
INFO_LABELS: Dict[str, str] = {
    "table": "שולחן (ואזור)",
    "guests": "סועדים",
    "waiter": "מלצר",
    "time": "שעה",
    "till": "קופה",
    "order": "מספר הזמנה",
    "customer": "שם לקוח",
}
HEADER_DEFAULT = ",".join(INFO_FIELDS)
#: The table is the kitchen's anchor: always in the header, whatever a list leaves out.
MANDATORY_HEADER_FIELD = "table"
#: The foot may also name the printer (with "עותק 1/2" when it prints more than one).
FOOTER_FIELDS: Tuple[str, ...] = INFO_FIELDS + ("printer",)

SIZES: Tuple[str, ...] = ("s", "m", "l", "xl")
SIZE_LABELS = {"s": "קטן", "m": "בינוני", "l": "גדול", "xl": "ענק"}
HEADER_FILLS: Tuple[str, ...] = ("none", "outline", "fill")
HEADER_FILL_LABELS = {"none": "טקסט בלבד", "outline": "מסגרת עבה", "fill": "בהיפוך (לבן על שחור)"}
#: `stacked`: the headline on its own line, the other fields in one line under it; `inline`: one line.
LINE_LAYOUTS: Tuple[str, ...] = ("stacked", "inline")
LINE_LAYOUT_LABELS = {"stacked": "כותרת ושורת משנה", "inline": "שורה אחת"}

#: The bands. `dining`: "לקחת"; `eatIn`: "לשבת"; `notice`: any other notice ("זרז", "לא שולם",
#: "הדפסת ניסיון"); `course`: a course's heading.
BAND_KEYS: Tuple[str, ...] = (
    "addition", "fire", "dining", "eatIn", "copy", "resent", "redirected", "tableNote", "notice", "training", "course",
)
BAND_LABELS: Dict[str, str] = {
    "addition": "תוספת",
    "fire": "הוצא",
    "dining": "לקחת",
    "eatIn": "לשבת",
    "copy": "העתק",
    "resent": "הדפסה חוזרת",
    "redirected": "הופנה מ:",
    "tableNote": "הערה לשולחן",
    "notice": "הודעה אחרת (זרז…)",
    "training": "הדרכה",
    "course": "כותרת קורס",
}
#: How a band is drawn — never hidden. `double`: the ink saver's double frame (═ תוספת ═);
#: `pill`: a rounded frame; `stars`: `*** תוספת ***`; `plain`: bold text ("— ראשונות —").
BAND_STYLES: Tuple[str, ...] = ("fill", "double", "outline", "pill", "underline", "stars", "plain")
BAND_STYLE_LABELS = {
    "fill": "מילוי (לבן על שחור)",
    "double": "מסגרת כפולה",
    "outline": "מסגרת",
    "pill": "מסגרת מעוגלת",
    "underline": "קו תחתון",
    "stars": "כוכביות",
    "plain": "טקסט מודגש",
}
QTY_STYLES: Tuple[str, ...] = ("plain", "box_outline", "box_fill")
QTY_LABELS = {"plain": "רגילה (2×)", "box_outline": "ריבוע עם מסגרת", "box_fill": "ריבוע מלא"}
MOD_LAYOUTS: Tuple[str, ...] = ("indent", "inline")
MOD_LAYOUT_LABELS = {"indent": "מוזחות מתחת לשם", "inline": "באותה שורה, אחרי פסיק"}
#: `asis`: as the till wrote them ("+ גבינה", "בלי בצל"); `plusminus`: "+ גבינה", "− בצל";
#: `words`: "עם גבינה", "בלי בצל"; `bullets`: "• גבינה", "• בלי בצל".
MOD_MARKS: Tuple[str, ...] = ("asis", "plusminus", "words", "bullets")
MOD_MARK_LABELS = {"asis": "כפי שנרשמו", "plusminus": "+ ו־−", "words": "עם / בלי", "bullets": "נקודות"}
IMPORTANT_NOTE_STYLES: Tuple[str, ...] = ("fill", "outline")
ALLERGY_STYLES: Tuple[str, ...] = ("fill", "outline_warn")
ALLERGY_LABELS = {"fill": "מילוי", "outline_warn": "מסגרת עם ⚠"}
SEPARATORS: Tuple[str, ...] = ("solid", "dashed", "none")
SEPARATOR_LABELS = {"solid": "קו מלא", "dashed": "קו מקווקו", "none": "בלי"}
WEIGHTS: Tuple[str, ...] = ("thin", "normal", "thick")
WEIGHT_LABELS = {"thin": "דק", "normal": "רגיל", "thick": "עבה"}
ITEM_DIVIDERS: Tuple[str, ...] = ("none", "thin", "dashed")
SPACINGS: Tuple[str, ...] = ("tight", "normal")
SPACING_LABELS = {"tight": "צפוף", "normal": "רגיל"}
#: `inline`: in the ticket's order, a course's name where it changes; `course_seat`: grouped by
#: course (a band each), then by seat.
GROUPINGS: Tuple[str, ...] = ("inline", "course_seat")
HELD_COURSE_STYLES: Tuple[str, ...] = ("plain", "dashed")

FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_DEFAULT = 80, 150, 100
FEED_LINES_MIN, FEED_LINES_MAX = 0, 6
MAX_LINES_MAX = 4

#: Sizes in dots on a 384-dot (58 mm) head, before `fontScale`; ×1.5 on 576 (80 mm). The till and
#: the dashboard's preview use the same numbers. `classic_legacy` keeps the till's sizes of before.
METRICS: Dict[str, Any] = {
    "baseWidthDots": 384,
    "dotsPerMm": 8,
    "tableSize": {"s": 28, "m": 40, "l": 56, "xl": 72},
    "itemSize": {"s": 22, "m": 27, "l": 36, "xl": 44},
    "detailSize": {"s": 18, "m": 22, "l": 26, "xl": 30},
    "bandSize": {"s": 22, "m": 26, "l": 34, "xl": 40},
    "smallSize": 20,
    "lineGap": {"tight": 2, "normal": 6},
    "separatorWidth": {"thin": 1, "normal": 3, "thick": 5},
    "feedLineDots": 24,
}

# ── The templates' looks (before the ink saver) ──────────────────────────────

_BANDS_CLASSIC: Dict[str, str] = {
    "addition": "fill",
    "fire": "outline",
    "dining": "fill",
    "eatIn": "outline",
    "copy": "fill",
    "resent": "fill",
    "redirected": "fill",
    "tableNote": "fill",
    "notice": "fill",
    "training": "outline",
    "course": "plain",
}


def _look(**changes: Any) -> Dict[str, Any]:
    """The new `classic` (§7), with `changes` laid over it (one level deep for the groups)."""
    base: Dict[str, Any] = {
        "fontScale": FONT_SCALE_DEFAULT,
        "header": {
            "tableSize": "m",
            "fill": "none",
            "layout": "stacked",
            "fields": ["table", "customer", "guests", "waiter", "time"],
        },
        "bands": dict(_BANDS_CLASSIC),
        "itemName": {"size": "m", "maxLines": 0},
        "qty": "plain",
        "mods": {"layout": "indent", "marks": "asis"},
        "note": {"frame": True, "important": "fill"},
        "allergy": "fill",
        "separators": "solid",
        "separatorWeight": "thin",
        "itemDivider": "thin",
        "spacing": "tight",
        "layout": {"qtyColumn": True, "hangingIndent": True},
        "grouping": "inline",
        "heldCourse": "plain",
        "totals": False,
        "checkboxes": False,
        "elapsed": False,
        "footer": {"layout": "inline", "fields": ["order", "till", "printer"]},
        "feedLines": 2,
    }
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


_TEMPLATE_LOOKS: Dict[str, Dict[str, Any]] = {
    CLASSIC: _look(),
    CLASSIC_LEGACY: _look(
        header={"tableSize": "l", "fields": ["table", "customer", "order", "guests"]},
        itemName={"size": "l"},
        separatorWeight="normal",
        itemDivider="none",
        spacing="normal",
        layout={"qtyColumn": False, "hangingIndent": False},
        footer={"layout": "stacked", "fields": ["time", "waiter", "order", "till", "printer"]},
        feedLines=3,
    ),
    LARGE: _look(
        header={"tableSize": "xl", "fill": "fill"},
        bands={**{k: "fill" for k in BAND_KEYS}, "eatIn": "outline", "training": "outline"},
        itemName={"size": "xl", "maxLines": 2},
        qty="box_fill",
        mods={"marks": "plusminus"},
        separatorWeight="thick",
        itemDivider="none",
        spacing="normal",
        footer={"layout": "stacked"},
        feedLines=3,
    ),
    COMPACT: _look(
        header={"tableSize": "s", "layout": "inline", "fields": ["table", "customer", "guests", "time", "waiter"]},
        bands={**{k: "stars" for k in BAND_KEYS}, "eatIn": "underline", "course": "underline"},
        itemName={"size": "s"},
        mods={"layout": "inline"},
        note={"frame": False, "important": "outline"},
        allergy="outline_warn",
        separators="dashed",
        itemDivider="none",
    ),
    COURSES: _look(
        bands={"course": "fill"},
        spacing="normal",
        itemDivider="none",
        grouping="course_seat",
        heldCourse="dashed",
        totals=True,
        checkboxes=True,
    ),
    MODERN: _look(
        header={"tableSize": "xl", "fill": "fill"},
        bands={
            "addition": "fill", "fire": "outline", "dining": "pill", "eatIn": "pill", "copy": "outline",
            "resent": "outline", "redirected": "outline", "tableNote": "outline", "notice": "outline",
            "training": "outline", "course": "underline",
        },
        mods={"marks": "bullets"},
        note={"frame": True, "important": "outline"},
        allergy="outline_warn",
        separators="dashed",
        itemDivider="none",
        spacing="normal",
        elapsed=True,
    ),
}

#: The full key order of a `ticketStyle` (the golden's, the wire's).
STYLE_KEYS: Tuple[str, ...] = ("version", "template", "designId", "designName", "inkSaver") + tuple(_look())


def template_style(template: str) -> Dict[str, Any]:
    """A template's whole look before the ink saver (a fresh copy). ValueError for an unknown one."""
    if template not in _TEMPLATE_LOOKS:
        raise ValueError(f"template must be one of {', '.join(TEMPLATES)}")
    return copy.deepcopy(_TEMPLATE_LOOKS[template])


# ── A design's overrides: a partial ticketStyle ──────────────────────────────

_ENUM = "enum"
_BOOL = "bool"
_INT = "int"
_FIELDS = "fields"

#: What a design may set, and how each value is checked. Groups are objects of the same.
OVERRIDE_SPEC: Dict[str, Any] = {
    "inkSaver": (_BOOL,),
    "fontScale": (_INT, FONT_SCALE_MIN, FONT_SCALE_MAX),
    "header": {
        "tableSize": (_ENUM, SIZES),
        "fill": (_ENUM, HEADER_FILLS),
        "layout": (_ENUM, LINE_LAYOUTS),
        "fields": (_FIELDS, INFO_FIELDS),
    },
    "bands": {key: (_ENUM, BAND_STYLES) for key in BAND_KEYS},
    "itemName": {"size": (_ENUM, SIZES), "maxLines": (_INT, 0, MAX_LINES_MAX)},
    "qty": (_ENUM, QTY_STYLES),
    "mods": {"layout": (_ENUM, MOD_LAYOUTS), "marks": (_ENUM, MOD_MARKS)},
    "note": {"frame": (_BOOL,), "important": (_ENUM, IMPORTANT_NOTE_STYLES)},
    "allergy": (_ENUM, ALLERGY_STYLES),
    "separators": (_ENUM, SEPARATORS),
    "separatorWeight": (_ENUM, WEIGHTS),
    "itemDivider": (_ENUM, ITEM_DIVIDERS),
    "spacing": (_ENUM, SPACINGS),
    "layout": {"qtyColumn": (_BOOL,), "hangingIndent": (_BOOL,)},
    "grouping": (_ENUM, GROUPINGS),
    "heldCourse": (_ENUM, HELD_COURSE_STYLES),
    "totals": (_BOOL,),
    "checkboxes": (_BOOL,),
    "elapsed": (_BOOL,),
    "footer": {"layout": (_ENUM, LINE_LAYOUTS), "fields": (_FIELDS, FOOTER_FIELDS)},
    "feedLines": (_INT, FEED_LINES_MIN, FEED_LINES_MAX),
}


class StyleError(ValueError):
    """An override, a template or a parameter value the ticket's look does not take."""


def _whole(value: Any, path: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StyleError(f"{path}: a whole number {low}–{high}")
    if isinstance(value, float):
        if not value.is_integer():
            raise StyleError(f"{path}: a whole number {low}–{high}")
        value = int(value)
    if not low <= value <= high:
        raise StyleError(f"{path}: {low}–{high}")
    return value


def _clean_fields(value: Any, path: str, allowed: Sequence[str]) -> List[str]:
    """A list (or a comma text) of known fields, each once, in the order given."""
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",") if part.strip()]
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise StyleError(f"{path}: a list of {', '.join(allowed)}")
    unknown = [v for v in value if v not in allowed]
    if unknown:
        raise StyleError(f"{path}: unknown field {unknown[0]!r} (one of {', '.join(allowed)})")
    if len(set(value)) != len(value):
        raise StyleError(f"{path}: a field is listed twice")
    return list(value)


def _clean_leaf(rule: Tuple[Any, ...], value: Any, path: str) -> Any:
    kind = rule[0]
    if kind == _BOOL:
        if not isinstance(value, bool):
            raise StyleError(f"{path}: true or false")
        return value
    if kind == _INT:
        return _whole(value, path, rule[1], rule[2])
    if kind == _ENUM:
        if value not in rule[1]:
            raise StyleError(f"{path}: one of {', '.join(rule[1])}")
        return value
    return _clean_fields(value, path, rule[1])


def _clean_group(spec: Dict[str, Any], value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise StyleError(f"{path or 'overrides'}: an object")
    out: Dict[str, Any] = {}
    for key in spec:  # the spec's order, so a stored design reads the same every time
        if key not in value or value[key] is None:
            continue
        rule = spec[key]
        where = f"{path}.{key}" if path else key
        if isinstance(rule, dict):
            group = _clean_group(rule, value[key], where)
            if group:
                out[key] = group
        else:
            out[key] = _clean_leaf(rule, value[key], where)
    unknown = [k for k in value if k not in spec]
    if unknown:
        raise StyleError(f"{path + '.' if path else ''}{unknown[0]}: not a part of the ticket's look")
    return out


def clean_overrides(value: Any) -> Dict[str, Any]:
    """A design's overrides, checked and in a stable order (null / empty = inherit). StyleError otherwise."""
    if value is None:
        return {}
    return _clean_group(OVERRIDE_SPEC, value, "")


def _merge(base: Dict[str, Any], over: Dict[str, Any]) -> None:
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)


# ── The till parameters (§2, §6ב) ────────────────────────────────────────────

DESIGN_KEY = "kitchenTicketDesign"
INK_SAVER_KEY = "kitchenTicketInkSaver"
FONT_SCALE_KEY = "kitchenTicketFontScale"
HEADER_KEY = "kitchenTicketHeader"
CHECKBOXES_KEY = "kitchenTicketCheckboxes"
ELAPSED_KEY = "kitchenTicketElapsed"
#: Set at some level, they lay over the template; their defaults never do (a template's own
#: checkboxes / elapsed / fields stay).
LEVEL_OPTION_KEYS: Tuple[str, ...] = (FONT_SCALE_KEY, HEADER_KEY, CHECKBOXES_KEY, ELAPSED_KEY)
PARAMETER_KEYS: Tuple[str, ...] = (DESIGN_KEY, INK_SAVER_KEY) + LEVEL_OPTION_KEYS

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=DESIGN_KEY,
        label="בון מטבח — עיצוב",
        value_type="string",
        default_value=DEFAULT_TEMPLATE,
        description=(
            "העיצוב של בוני המטבח והבר במדפסות שאין להן עיצוב משלהן (\"עיצוב בון\" במסך המדפסת גובר). "
            + ", ".join(f"{key} ({TEMPLATE_LABELS[key]})" for key in TEMPLATES)
            + ", או מזהה של \"עיצוב בון\" של החברה. ברירת מחדל: classic — קטן ומיושר. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=INK_SAVER_KEY,
        label="בון מטבח — חיסכון בהדפסה",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת מחדל): פסים מלאים (תוספת, הוצא, לקחת, העתק, הדפסה חוזרת…) מודפסים במסגרת כפולה, "
            "כותרת בהיפוך במסגרת עבה, ריבוע כמות ותיבת אלרגיה במסגרת, וקווי הפרדה דקים — פחות חום על ראש "
            "ההדפסה, נייר שמחזיק והדפסה מהירה יותר. כבוי: מילוי שחור כמו בעבר. עיצוב בון יכול לקבוע אחרת."
        ),
    ),
    dict(
        key=FONT_SCALE_KEY,
        label="בון מטבח — גודל גופן (%)",
        value_type="integer",
        default_value=FONT_SCALE_DEFAULT,
        description=(
            f"הגדלה או הקטנה של כל הטקסט בבון, {FONT_SCALE_MIN}–{FONT_SCALE_MAX} אחוז "
            f"(ברירת מחדל {FONT_SCALE_DEFAULT}). כשנקבע ברמה כלשהי, גובר על גודל התבנית; עיצוב בון ומדפסת גוברים עליו."
        ),
    ),
    dict(
        key=HEADER_KEY,
        label="בון מטבח — פרטי ההזמנה בבון",
        value_type="string",
        default_value=HEADER_DEFAULT,
        description=(
            "אילו פרטים מודפסים בראש הבון ובתחתיתו, רשימה מופרדת בפסיקים: "
            + ", ".join(f"{code} ({INFO_LABELS[code]})" for code in INFO_FIELDS)
            + f". ברירת מחדל: הכל ({HEADER_DEFAULT}). השולחן מודפס תמיד."
        ),
    ),
    dict(
        key=CHECKBOXES_KEY,
        label="בון מטבח — תיבת סימון ☐ ליד כל שורה",
        value_type="boolean",
        default_value=False,
        description=(
            "תיבת ☐ ליד כל פריט, לסימון במטבח. כשנקבע ברמה כלשהי, גובר על התבנית "
            "(בתבנית \"לפי קורסים ומושבים\" התיבות מופעלות)."
        ),
    ),
    dict(
        key=ELAPSED_KEY,
        label="בון מטבח — \"פתוח X דק'\" בראש הבון",
        value_type="boolean",
        default_value=False,
        description=(
            "כמה זמן השולחן פתוח, בראש הבון (\"פתוח 25 דק'\"). כשנקבע ברמה כלשהי, גובר על התבנית "
            "(בתבנית \"מודרני\" מופעל)."
        ),
    ),
)
VALIDATED_KEYS = frozenset(PARAMETER_KEYS)


def parse_design_value(value: Any) -> Tuple[str, str]:
    """`kitchenTicketDesign`: ("template", key) or ("design", uuid text). StyleError otherwise."""
    if not isinstance(value, str) or not value.strip():
        raise StyleError(f"{DESIGN_KEY}: a template ({', '.join(TEMPLATES)}) or a design's id")
    text = value.strip()
    if text in TEMPLATES:
        return "template", text
    try:
        return "design", str(uuid.UUID(text))
    except ValueError as exc:
        raise StyleError(f"{DESIGN_KEY}: a template ({', '.join(TEMPLATES)}) or a design's id") from exc


def parse_header(value: Any) -> List[str]:
    """`kitchenTicketHeader` → the fields, in `INFO_FIELDS` order (the table always among them)."""
    fields = _clean_fields(value, HEADER_KEY, INFO_FIELDS)
    if not fields:
        raise StyleError(f"{HEADER_KEY}: at least one of {', '.join(INFO_FIELDS)}")
    chosen = set(fields) | {MANDATORY_HEADER_FIELD}
    return [f for f in INFO_FIELDS if f in chosen]


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key` (normalised), or ValueError. Other keys pass as they are."""
    if value is None:
        return None
    if key == DESIGN_KEY:
        kind, text = parse_design_value(value)
        return text
    if key == INK_SAVER_KEY or key == CHECKBOXES_KEY or key == ELAPSED_KEY:
        if not isinstance(value, bool):
            raise StyleError(f"{key}: true or false")
        return value
    if key == FONT_SCALE_KEY:
        return _whole(value, key, FONT_SCALE_MIN, FONT_SCALE_MAX)
    if key == HEADER_KEY:
        return ",".join(parse_header(value))
    return value


# ── Resolving ────────────────────────────────────────────────────────────────


def _filter_fields(style: Dict[str, Any], allowed: Iterable[str]) -> None:
    """Only the info fields `allowed` stay in the header and the foot (the printer's name always may)."""
    keep = set(allowed) | {MANDATORY_HEADER_FIELD}
    style["header"]["fields"] = [f for f in style["header"]["fields"] if f in keep]
    style["footer"]["fields"] = [f for f in style["footer"]["fields"] if f in keep or f == "printer"]


def _apply_options(style: Dict[str, Any], options: Dict[str, Any]) -> None:
    """Font scale / info fields / checkboxes / elapsed, as a level or a printer sets them."""
    if options.get("fontScale") is not None:
        style["fontScale"] = options["fontScale"]
    if options.get("header") is not None:
        _filter_fields(style, options["header"])
    if options.get("checkboxes") is not None:
        style["checkboxes"] = options["checkboxes"]
    if options.get("elapsed") is not None:
        style["elapsed"] = options["elapsed"]


def apply_ink_saver(style: Dict[str, Any]) -> Dict[str, Any]:
    """§6ב, in place: no filled area left but the text itself."""
    for key, value in style["bands"].items():
        if value == "fill":
            style["bands"][key] = "double"
    if style["header"]["fill"] == "fill":
        style["header"]["fill"] = "outline"
    if style["qty"] == "box_fill":
        style["qty"] = "box_outline"
    if style["allergy"] == "fill":
        style["allergy"] = "outline_warn"
    if style["note"]["important"] == "fill":
        style["note"]["important"] = "outline"
    if style["separatorWeight"] != "thin":
        style["separatorWeight"] = "thin"
    return style


def level_options(params: Dict[str, Any]) -> Dict[str, Any]:
    """The four level options as `_apply_options` takes them, from parameters SET at some level."""
    out: Dict[str, Any] = {}
    if params.get(FONT_SCALE_KEY) is not None:
        out["fontScale"] = clean_value(FONT_SCALE_KEY, params[FONT_SCALE_KEY])
    if params.get(HEADER_KEY) is not None:
        out["header"] = parse_header(params[HEADER_KEY])
    if params.get(CHECKBOXES_KEY) is not None:
        out["checkboxes"] = bool(params[CHECKBOXES_KEY])
    if params.get(ELAPSED_KEY) is not None:
        out["elapsed"] = bool(params[ELAPSED_KEY])
    return out


def resolve_style(
    template: str = DEFAULT_TEMPLATE,
    *,
    overrides: Optional[Dict[str, Any]] = None,
    design_id: Optional[str] = None,
    design_name: Optional[str] = None,
    level: Optional[Dict[str, Any]] = None,
    ink_saver: bool = True,
    printer: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    The full `ticketStyle` the till draws by. `level`: the till parameters SET on the till's levels
    (`level_options` of them); `ink_saver`: `kitchenTicketInkSaver` as it resolves (default on);
    `overrides`: the design's; `printer`: the printer's own options (`fontScale`, `header`,
    `checkboxes`, `elapsed`; None = inherit).
    """
    if template not in TEMPLATES:
        template = DEFAULT_TEMPLATE
    look = template_style(template)
    _apply_options(look, level or {})
    look["inkSaver"] = bool(ink_saver)
    _merge(look, clean_overrides(overrides) if overrides else {})
    _apply_options(look, printer or {})
    fields = look["header"]["fields"]
    if MANDATORY_HEADER_FIELD not in fields:
        fields.insert(0, MANDATORY_HEADER_FIELD)
    if look["inkSaver"]:
        apply_ink_saver(look)
    meta = {
        "version": STYLE_VERSION,
        "template": template,
        "designId": design_id,
        "designName": design_name,
        "inkSaver": look.pop("inkSaver"),
    }
    out = {**meta, **look}
    return {key: out[key] for key in STYLE_KEYS}


def resolve_with_params(
    template: str = DEFAULT_TEMPLATE,
    *,
    params: Optional[Dict[str, Any]] = None,
    overrides: Optional[Dict[str, Any]] = None,
    design_id: Optional[str] = None,
    design_name: Optional[str] = None,
    printer: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """`resolve_style` from the till parameters SET on the till's levels (`params`, key → value)."""
    params = params or {}
    ink = params.get(INK_SAVER_KEY)
    return resolve_style(
        template,
        overrides=overrides,
        design_id=design_id,
        design_name=design_name,
        level=level_options(params),
        ink_saver=True if ink is None else bool(ink),
        printer=printer,
    )


# ── The notice's parts and the bands they print in ─────────────────────────────

#: A ticket's `notice` is " · "-joined parts (pos-android KitchenFailover.notice). Each part prints in
#: the band of the first kind whose prefix it starts with; anything else in `notice`'s band.
NOTICE_SEPARATOR = " · "
NOTICE_KINDS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("tableNote", ("הערה לשולחן:", "TABLE NOTE:")),
    ("redirected", ("הופנה מ:", "Redirected from:")),
    ("resent", ("הדפסה חוזרת", "PRINTED AGAIN")),
    ("copy", ("העתק", "COPY", "עותק ", "Copy ")),
)


def notice_parts(notice: Optional[str]) -> List[Tuple[str, str]]:
    """[(band kind, text)] of a ticket's notice, in its order."""
    out: List[Tuple[str, str]] = []
    for part in (notice or "").split(NOTICE_SEPARATOR):
        text = part.strip()
        if not text:
            continue
        kind = next((k for k, prefixes in NOTICE_KINDS if any(text.startswith(p) for p in prefixes)), "notice")
        out.append((kind, text))
    return out


# ── The sample ticket (the preview, and the dashboard's test print) ──────────────

#: The golden's `preview_table` ticket: a table, two courses, seats, choices and removals, a note,
#: an important note, an allergy, "תוספת", "לקחת" and a table note (P:/specs §4). `openedAt` is
#: the table's opening ("פתוח 25 דק'"), optional on the ticket.
SAMPLE_TICKET: Dict[str, Any] = {
    "source": "table",
    "tableName": "12",
    "zoneName": "גן",
    "guests": 4,
    "waiterName": "דנה",
    "createdAt": "2026-10-14T17:14:00Z",
    "isAddition": True,
    "lines": [
        {
            "productId": None, "categoryId": None, "name": "סלט ירוק", "quantity": 1.0, "notes": None,
            "mods": ["+ אבוקדו"], "removals": ["בלי בצל"], "important": None, "allergies": None,
            "seat": "מ1", "course": "ראשונות", "mealName": None, "refill": None,
        },
        {
            "productId": None, "categoryId": None, "name": "קרפצ'יו בקר", "quantity": 1.0, "notes": "רוטב בצד",
            "mods": None, "removals": None, "important": None, "allergies": None,
            "seat": "מ2", "course": "ראשונות", "mealName": None, "refill": None,
        },
        {
            "productId": None, "categoryId": None, "name": "המבורגר 250 גרם", "quantity": 1.0, "notes": None,
            "mods": ["מדיום"], "removals": ["בלי עגבנייה"], "important": None, "allergies": ["אגוזים"],
            "seat": "מ1", "course": "עיקריות", "mealName": "ארוחה עסקית", "refill": None,
        },
        {
            "productId": None, "categoryId": None, "name": "פסטה ארביאטה", "quantity": 2.0, "notes": "ללא גלוטן",
            "mods": None, "removals": None, "important": True, "allergies": None,
            "seat": "מ2", "course": "עיקריות", "mealName": None, "refill": None,
        },
    ],
    "orderRef": "4471",
    "sourceName": "קופה 1",
    "fire": None,
    "customerName": None,
    "dining": "take_away",
    "notice": "הערה לשולחן: יום הולדת — להביא נר",
    "training": None,
    "openedAt": "2026-10-14T16:49:00Z",
}
SAMPLE_PRINTER_NAME = "מטבח"
#: The band a design test print opens with, so the kitchen never cooks it.
TEST_PRINT_NOTICE = "הדפסת ניסיון — לא להכנה"


def test_print_ticket(now: Optional[datetime] = None, waiter: Optional[str] = None, till: Optional[str] = None) -> Dict[str, Any]:
    """The sample ticket for a design's test print: now, opened 25 minutes ago, marked a test."""
    now = now or datetime.now(timezone.utc)
    ticket = copy.deepcopy(SAMPLE_TICKET)
    ticket["createdAt"] = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    ticket["openedAt"] = (now - timedelta(minutes=25)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if waiter:
        ticket["waiterName"] = waiter
    if till:
        ticket["sourceName"] = till
    ticket["notice"] = NOTICE_SEPARATOR.join(p for p in (TEST_PRINT_NOTICE, ticket.get("notice")) if p)
    return ticket


def catalog() -> Dict[str, Any]:
    """What the dashboard's designer offers: the templates with their looks, the vocabulary, the labels."""
    return {
        "version": STYLE_VERSION,
        "defaultTemplate": DEFAULT_TEMPLATE,
        "templates": [
            {"key": key, "label": TEMPLATE_LABELS[key], "hint": TEMPLATE_HINTS[key], "look": template_style(key)}
            for key in TEMPLATES
        ],
        "infoFields": [{"key": key, "label": INFO_LABELS[key]} for key in INFO_FIELDS],
        "bands": [{"key": key, "label": BAND_LABELS[key]} for key in BAND_KEYS],
        "bandStyles": [{"key": key, "label": BAND_STYLE_LABELS[key]} for key in BAND_STYLES],
        "metrics": copy.deepcopy(METRICS),
        "sample": copy.deepcopy(SAMPLE_TICKET),
        "samplePrinterName": SAMPLE_PRINTER_NAME,
    }

