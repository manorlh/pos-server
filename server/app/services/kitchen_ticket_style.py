"""
"עיצוב בון" — how a kitchen ticket ("בון") looks: the `ticketStyle` contract
(P:/specs/kitchen-ticket-designs.md §1, §6–§10; the shared golden
tests/fixtures/kitchen_ticket_designs_golden.json, byte-identical in pos-android).

Pure rules, no database (app/services/kitchen_ticket_designs.py stores and assigns):

* **Templates** (`TEMPLATES`): `classic` — the default (§7: smaller and aligned — a fixed quantity
  column, wrapped names / choices / notes hang under the name); `classic_legacy` — "קלאסי (ישן)", the
  ticket exactly as the till drew it before, kept to compare with; `large`, `compact`, `courses`,
  `modern`. `template_style` is each one's full look before the ink saver.
* **No solid black in any default look** (§8 "בלי השחור הזה"): frames, double frames, bold text. A
  fill is only ever an explicit element choice in a named design (with the ink saver off there);
  `classic_legacy` keeps today's fills, and the ink saver (on by default) frames them too.
* **One line where it fits, never huge** (§8): `fit` — each item line (quantity + name) shrinks from
  `itemName.maxSize` down to `itemName.minSize` to stay on one line at the paper's real width, and
  only then wraps with a hanging indent; `wrap` — a fixed size that wraps. Choices, removals and a
  short note go on the item's line after " · " when they fit there (`mods.layout` `inline`), else on
  indented lines. The header in one line as far as it fits. Sizes are capped by the paper
  (`METRICS`: an item ≈ 32 characters a line at 80 mm, ≈ 24 at 58 mm; the table at most twice that).
* **A named design** ("עיצוב בון", `kitchen_ticket_designs`) is a template plus per-element
  overrides — a partial `ticketStyle` (`clean_overrides` refuses anything else).
* **The cloud resolves** (`resolve_style`) one full `ticketStyle` per printer and till and sends it in
  the printers config; the till draws by it alone. In order: the template; the till parameters SET at
  some level (`LEVEL_OPTION_KEYS` — their defaults never beat a template's own look) and
  `kitchenTicketInkSaver` (default on); the design's overrides; the printer's own options; the
  mandatory information; then the ink saver.
* **Mandatory information is never hidden** — the bands ("תוספת", "הוצא", "לקחת" / "לשבת", "העתק",
  "הדפסה חוזרת", "הופנה מ:", "הערה לשולחן", "הדרכה"), allergies, notes and the table: the schema has
  no "hidden" value for any of them, and the table stays in the header whatever the lists say.
* **The ink saver** (`kitchenTicketInkSaver`, §6ב): a filled band becomes a double frame, an inverted
  header a frame, the black quantity box a frame, the allergy box a frame with ⚠, an important note
  a frame; separators thin. Off (a design's choice): its explicit fills print as chosen.

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
    CLASSIC: "ברירת המחדל: קטן ומיושר — עמודת כמות קבועה, שורה אחת לפריט ככל שנכנס",
    CLASSIC_LEGACY: "הבון של עד היום, להשוואה",
    LARGE: "מטבח עמוס, קריאה מרחוק: שולחן וכמות במסגרת, שמות גדולים",
    COMPACT: "בר וקפה, חיסכון בנייר: כותרת בשורה אחת, גופן קטן",
    COURSES: "מסעדה עם מנות לפי סדר: קבוצה לכל קורס, לפי מושב, תיבות סימון",
    MODERN: "מראה נקי: שולחן במסגרת עם הזמן מאז הפתיחה, תגים מעוגלים, קווים מקווקווים",
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

#: Text sizes, smallest first; an item's line runs between `minSize` and `maxSize`.
TEXT_SIZES: Tuple[str, ...] = ("xs", "s", "m", "l")
MIN_TEXT_SIZES: Tuple[str, ...] = ("xs", "s", "m")
MAX_TEXT_SIZES: Tuple[str, ...] = ("s", "m", "l")
HEADER_SIZES: Tuple[str, ...] = ("s", "m", "l")
SIZE_LABELS = {"xs": "קטן מאוד", "s": "קטן", "m": "בינוני", "l": "גדול"}
#: `fit`: shrink to one line, then wrap; `wrap`: a fixed size that wraps.
FITS: Tuple[str, ...] = ("fit", "wrap")
FIT_LABELS = {"fit": "שורה אחת ככל האפשר (מקטין ואז שובר)", "wrap": "גודל קבוע ושבירת שורות"}
HEADER_FILLS: Tuple[str, ...] = ("none", "outline", "fill")
HEADER_FILL_LABELS = {"none": "טקסט בלבד", "outline": "מסגרת", "fill": "בהיפוך (לבן על שחור)"}
#: `inline`: one line as far as it fits, the rest under it; `stacked`: the headline, the rest under it.
LINE_LAYOUTS: Tuple[str, ...] = ("inline", "stacked")
LINE_LAYOUT_LABELS = {"inline": "שורה אחת ככל שנכנס", "stacked": "כותרת ושורת משנה"}

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
#: How a band is drawn — never hidden. `double`: a double frame (═ תוספת ═); `pill`: a rounded
#: frame; `stars`: `*** תוספת ***`; `plain`: bold text ("— ראשונות —"); `fill`: white on black.
BAND_STYLES: Tuple[str, ...] = ("double", "outline", "pill", "underline", "stars", "plain", "fill")
BAND_STYLE_LABELS = {
    "double": "מסגרת כפולה",
    "outline": "מסגרת",
    "pill": "מסגרת מעוגלת",
    "underline": "קו תחתון",
    "stars": "כוכביות",
    "plain": "טקסט מודגש",
    "fill": "מילוי (לבן על שחור)",
}
QTY_STYLES: Tuple[str, ...] = ("plain", "box_outline", "box_fill")
QTY_LABELS = {"plain": "רגילה (2×)", "box_outline": "ריבוע עם מסגרת", "box_fill": "ריבוע מלא"}
#: `inline`: on the item's line after " · " when they fit there, else indented; `indent`: indented lines.
MOD_LAYOUTS: Tuple[str, ...] = ("inline", "indent")
MOD_LAYOUT_LABELS = {"inline": "באותה שורה אחרי · כשיש מקום", "indent": "מוזחות מתחת לשם"}
#: `asis`: as the till wrote them ("+ גבינה", "בלי בצל"); `plusminus`: "+ גבינה", "− בצל";
#: `words`: "עם גבינה", "בלי בצל"; `bullets`: "• גבינה", "• בלי בצל".
MOD_MARKS: Tuple[str, ...] = ("asis", "plusminus", "words", "bullets")
MOD_MARK_LABELS = {"asis": "כפי שנרשמו", "plusminus": "+ ו־−", "words": "עם / בלי", "bullets": "נקודות"}
IMPORTANT_NOTE_STYLES: Tuple[str, ...] = ("outline", "fill")
ALLERGY_STYLES: Tuple[str, ...] = ("outline_warn", "fill")
ALLERGY_LABELS = {"outline_warn": "מסגרת עם ⚠", "fill": "מילוי"}
SEPARATORS: Tuple[str, ...] = ("solid", "dashed", "none")
SEPARATOR_LABELS = {"solid": "קו מלא", "dashed": "קו מקווקו", "none": "בלי"}
WEIGHTS: Tuple[str, ...] = ("thin", "normal", "thick")
WEIGHT_LABELS = {"thin": "דק", "normal": "רגיל", "thick": "עבה"}
ITEM_DIVIDERS: Tuple[str, ...] = ("none", "thin", "dashed")
SPACINGS: Tuple[str, ...] = ("tight", "normal")
SPACING_LABELS = {"tight": "צפוף", "normal": "רגיל"}
#: Within each group of `order`: `none` — as added; `seat` — by seat ("מ1", "מ2"), as added within it.
GROUPINGS: Tuple[str, ...] = ("none", "seat")
HELD_COURSE_STYLES: Tuple[str, ...] = ("plain", "dashed")

#: §9 "מה להציג קודם בבון": `added` — as added (today); `course` — by the courses' order (FIRE v2's
#: menu courses), as added within each; `category` — by the catalog's category order; `custom` — by
#: `order.list` (courses and categories as the manager dragged them), the rest at the end.
ORDER_BYS: Tuple[str, ...] = ("added", "course", "category", "custom")
ORDER_LABELS = {
    "added": "לפי סדר ההוספה (כמו היום)",
    "course": "לפי סדר הקורסים",
    "category": "לפי סדר המחלקות בקטלוג",
    "custom": "סדר שלי (גרירה)",
}
#: A thin heading for each group ("── ראשונות ──", in `bands.course`): `auto` — on unless `added`.
GROUP_HEADERS: Tuple[str, ...] = ("auto", "on", "off")
GROUP_HEADER_LABELS = {"auto": "אוטומטי (מופעל כשממיינים)", "on": "מופעל", "off": "כבוי"}
#: Where an item with no course goes when ordering by course.
NO_COURSE: Tuple[str, ...] = ("last", "first")
NO_COURSE_LABELS = {"last": "בסוף", "first": "בהתחלה"}
ORDER_LIST_KINDS: Tuple[str, ...] = ("course", "category")
ORDER_LIST_MAX = 40

FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_DEFAULT = 80, 150, 100
FEED_LINES_MIN, FEED_LINES_MAX = 0, 6
MAX_LINES_MAX = 4

#: The paper's real width (§8 "לפי גודל הבון"). Sizes are in dots at each width, before
#: `fontScale`: an item at `m` takes ≈ 24 characters a line at 58 mm and ≈ 32 at 80 mm (an average
#: character ≈ `avgCharEm` of the size); the table `headerRatio` times the item's largest size;
#: details (choices, notes, seats) `detailRatio` of the item's size. `classic_legacy` keeps the
#: till's sizes of before (×1.5 at 80 mm). The till and the dashboard's preview use these numbers.
METRICS: Dict[str, Any] = {
    "dotsPerMm": 8,
    "paper": {"58": {"dots": 384, "pad": 10}, "80": {"dots": 576, "pad": 15}},
    "avgCharEm": 0.5,
    "itemSize": {"58": {"xs": 21, "s": 26, "m": 30, "l": 36}, "80": {"xs": 24, "s": 29, "m": 34, "l": 42}},
    "charsPerLine": {"58": {"xs": 34, "s": 28, "m": 24, "l": 20}, "80": {"xs": 46, "s": 38, "m": 32, "l": 26}},
    "headerRatio": {"s": 1.3, "m": 1.6, "l": 2.0},
    "detailRatio": 0.8,
    "smallSize": {"58": 18, "80": 22},
    "fitStep": 1,
    "lineGap": {"tight": 2, "normal": 6},
    "separatorWidth": {"thin": 1, "normal": 3, "thick": 5},
    "feedLineDots": 24,
}

# ── The templates' looks (before the ink saver) ──────────────────────────────

#: No fill anywhere (§8): the bands framed (double where the kitchen must not miss it) or bold.
_BANDS_FRAMED: Dict[str, str] = {
    "addition": "double",
    "fire": "outline",
    "dining": "double",
    "eatIn": "outline",
    "copy": "outline",
    "resent": "double",
    "redirected": "outline",
    "tableNote": "outline",
    "notice": "outline",
    "training": "double",
    "course": "plain",
}
#: Today's ticket (KitchenTicketRenderer before 14.10): white on black for these.
_BANDS_LEGACY: Dict[str, str] = {
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
    """The new `classic` (§7, §8), with `changes` laid over it (one level deep for the groups)."""
    base: Dict[str, Any] = {
        "fontScale": FONT_SCALE_DEFAULT,
        "fit": "fit",
        "header": {
            "size": "m",
            "fill": "none",
            "layout": "inline",
            "fields": ["table", "customer", "guests", "waiter", "time"],
        },
        "bands": dict(_BANDS_FRAMED),
        "itemName": {"maxSize": "m", "minSize": "s", "maxLines": 0},
        "qty": "plain",
        "mods": {"layout": "inline", "marks": "asis"},
        "note": {"frame": True, "important": "outline"},
        "allergy": "outline_warn",
        "separators": "solid",
        "separatorWeight": "thin",
        "itemDivider": "thin",
        "spacing": "tight",
        "layout": {"qtyColumn": True, "hangingIndent": True},
        "order": {"by": "added", "groupHeaders": "auto", "noCourse": "last", "list": []},
        "grouping": "none",
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
        fit="wrap",
        header={"size": "l", "layout": "stacked", "fields": ["table", "customer", "order", "guests"]},
        bands=dict(_BANDS_LEGACY),
        itemName={"maxSize": "l", "minSize": "m"},
        mods={"layout": "indent"},
        note={"important": "fill"},
        allergy="fill",
        separatorWeight="normal",
        itemDivider="none",
        spacing="normal",
        layout={"qtyColumn": False, "hangingIndent": False},
        # Today's: as added, the course's name where it changes.
        order={"groupHeaders": "on"},
        footer={"layout": "stacked", "fields": ["time", "waiter", "order", "till", "printer"]},
        feedLines=3,
    ),
    LARGE: _look(
        header={"size": "l", "fill": "outline", "layout": "stacked"},
        bands={**{k: "double" for k in BAND_KEYS}, "eatIn": "outline"},
        itemName={"maxSize": "l", "minSize": "m", "maxLines": 2},
        qty="box_outline",
        mods={"layout": "indent", "marks": "plusminus"},
        separatorWeight="thick",
        itemDivider="none",
        spacing="normal",
        footer={"layout": "stacked"},
        feedLines=3,
    ),
    COMPACT: _look(
        header={"size": "s", "fields": ["table", "customer", "guests", "time", "waiter"]},
        bands={**{k: "stars" for k in BAND_KEYS}, "eatIn": "underline", "course": "underline"},
        itemName={"maxSize": "s", "minSize": "xs"},
        note={"frame": False},
        separators="dashed",
        itemDivider="none",
    ),
    COURSES: _look(
        bands={"course": "double"},
        spacing="normal",
        itemDivider="none",
        order={"by": "course"},
        grouping="seat",
        heldCourse="dashed",
        totals=True,
        checkboxes=True,
    ),
    MODERN: _look(
        header={"fill": "outline", "layout": "stacked"},
        bands={
            "addition": "double", "fire": "outline", "dining": "pill", "eatIn": "pill", "copy": "outline",
            "resent": "double", "redirected": "outline", "tableNote": "outline", "notice": "outline",
            "training": "outline", "course": "underline",
        },
        mods={"layout": "indent", "marks": "bullets"},
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


def black_parts(style: Dict[str, Any]) -> List[str]:
    """The elements of a look drawn in solid black (none in any default look, §8)."""
    out = [f"bands.{k}" for k, v in style["bands"].items() if v == "fill"]
    if style["header"]["fill"] == "fill":
        out.append("header.fill")
    if style["qty"] == "box_fill":
        out.append("qty")
    if style["allergy"] == "fill":
        out.append("allergy")
    if style["note"]["important"] == "fill":
        out.append("note.important")
    return out


# ── A design's overrides: a partial ticketStyle ──────────────────────────────

_ENUM = "enum"
_BOOL = "bool"
_INT = "int"
_FIELDS = "fields"
_ORDER_LIST = "order_list"

#: What a design may set, and how each value is checked. Groups are objects of the same.
OVERRIDE_SPEC: Dict[str, Any] = {
    "inkSaver": (_BOOL,),
    "fontScale": (_INT, FONT_SCALE_MIN, FONT_SCALE_MAX),
    "fit": (_ENUM, FITS),
    "header": {
        "size": (_ENUM, HEADER_SIZES),
        "fill": (_ENUM, HEADER_FILLS),
        "layout": (_ENUM, LINE_LAYOUTS),
        "fields": (_FIELDS, INFO_FIELDS),
    },
    "bands": {key: (_ENUM, BAND_STYLES) for key in BAND_KEYS},
    "itemName": {
        "maxSize": (_ENUM, MAX_TEXT_SIZES),
        "minSize": (_ENUM, MIN_TEXT_SIZES),
        "maxLines": (_INT, 0, MAX_LINES_MAX),
    },
    "qty": (_ENUM, QTY_STYLES),
    "mods": {"layout": (_ENUM, MOD_LAYOUTS), "marks": (_ENUM, MOD_MARKS)},
    "note": {"frame": (_BOOL,), "important": (_ENUM, IMPORTANT_NOTE_STYLES)},
    "allergy": (_ENUM, ALLERGY_STYLES),
    "separators": (_ENUM, SEPARATORS),
    "separatorWeight": (_ENUM, WEIGHTS),
    "itemDivider": (_ENUM, ITEM_DIVIDERS),
    "spacing": (_ENUM, SPACINGS),
    "layout": {"qtyColumn": (_BOOL,), "hangingIndent": (_BOOL,)},
    "order": {
        "by": (_ENUM, ORDER_BYS),
        "groupHeaders": (_ENUM, GROUP_HEADERS),
        "noCourse": (_ENUM, NO_COURSE),
        "list": (_ORDER_LIST,),
    },
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
    if kind == _ORDER_LIST:
        return clean_order_list(value, path)
    return _clean_fields(value, path, rule[1])


def clean_order_list(value: Any, path: str = "order.list") -> List[Dict[str, str]]:
    """
    `custom`'s order: `[{kind: course|category, id}]` (or "course:<id>,category:<id>" text), each
    once, at most `ORDER_LIST_MAX`. StyleError otherwise.
    """
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",") if part.strip()]
    if not isinstance(value, list):
        raise StyleError(f"{path}: a list of courses and categories")
    out: List[Dict[str, str]] = []
    seen = set()
    for entry in value:
        if isinstance(entry, str) and ":" in entry:
            kind, _, ident = entry.partition(":")
        elif isinstance(entry, dict):
            kind, ident = entry.get("kind"), entry.get("id")
        else:
            raise StyleError(f"{path}: each entry a course or a category")
        if kind not in ORDER_LIST_KINDS:
            raise StyleError(f"{path}: kind one of {', '.join(ORDER_LIST_KINDS)}")
        try:
            ident = str(uuid.UUID(str(ident).strip()))
        except ValueError as exc:
            raise StyleError(f"{path}: an id") from exc
        if (kind, ident) in seen:
            raise StyleError(f"{path}: listed twice")
        seen.add((kind, ident))
        out.append({"kind": kind, "id": ident})
    if len(out) > ORDER_LIST_MAX:
        raise StyleError(f"{path}: at most {ORDER_LIST_MAX}")
    return out


def order_list_text(entries: Sequence[Dict[str, str]]) -> str:
    """The till parameter's stored form: "course:<id>,category:<id>"."""
    return ",".join(f"{e['kind']}:{e['id']}" for e in entries)


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


# ── The till parameters (§2, §6ב, §8) ─────────────────────────────────────────

DESIGN_KEY = "kitchenTicketDesign"
INK_SAVER_KEY = "kitchenTicketInkSaver"
FONT_SCALE_KEY = "kitchenTicketFontScale"
HEADER_KEY = "kitchenTicketHeader"
CHECKBOXES_KEY = "kitchenTicketCheckboxes"
ELAPSED_KEY = "kitchenTicketElapsed"
FIT_KEY = "kitchenTicketFit"
MIN_TEXT_KEY = "kitchenTicketMinTextSize"
MAX_TEXT_KEY = "kitchenTicketMaxTextSize"
HEADER_SIZE_KEY = "kitchenTicketHeaderSize"
INLINE_MODS_KEY = "kitchenTicketInlineMods"
ORDER_KEY = "kitchenTicketOrder"
ORDER_LIST_KEY = "kitchenTicketOrderList"
GROUP_HEADERS_KEY = "kitchenTicketGroupHeaders"
NO_COURSE_KEY = "kitchenTicketNoCourse"
#: Set at some level, they lay over the template; their defaults never do (a template's own
#: checkboxes / elapsed / sizes / fields / order stay).
LEVEL_OPTION_KEYS: Tuple[str, ...] = (
    FONT_SCALE_KEY, HEADER_KEY, CHECKBOXES_KEY, ELAPSED_KEY,
    FIT_KEY, MIN_TEXT_KEY, MAX_TEXT_KEY, HEADER_SIZE_KEY, INLINE_MODS_KEY,
    ORDER_KEY, ORDER_LIST_KEY, GROUP_HEADERS_KEY, NO_COURSE_KEY,
)
PARAMETER_KEYS: Tuple[str, ...] = (DESIGN_KEY, INK_SAVER_KEY) + LEVEL_OPTION_KEYS
#: The level / printer options by their short names (the printer's `ticket*` fields).
OPTION_NAMES: Dict[str, str] = {
    FONT_SCALE_KEY: "fontScale",
    HEADER_KEY: "header",
    CHECKBOXES_KEY: "checkboxes",
    ELAPSED_KEY: "elapsed",
    FIT_KEY: "fit",
    MIN_TEXT_KEY: "minTextSize",
    MAX_TEXT_KEY: "maxTextSize",
    HEADER_SIZE_KEY: "headerSize",
    INLINE_MODS_KEY: "inlineMods",
    ORDER_KEY: "order",
    ORDER_LIST_KEY: "orderList",
    GROUP_HEADERS_KEY: "groupHeaders",
    NO_COURSE_KEY: "noCourse",
}
_LEVELS_TEXT = "כשנקבע ברמה כלשהי, גובר על התבנית; עיצוב בון ומדפסת גוברים עליו. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."

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
            "כשמופעל (ברירת מחדל): שום שטח שחור מלא בבון — פסים, כותרת, ריבוע כמות ותיבת אלרגיה במסגרת, וקווי "
            "הפרדה דקים: פחות חום על ראש ההדפסה, נייר שמחזיק והדפסה מהירה יותר. העיצובים המוכנים בלי שחור בכל מקרה; "
            "כבוי משפיע רק על מילוי שנבחר במפורש בעיצוב בון (ועל \"קלאסי (ישן)\")."
        ),
    ),
    dict(
        key=FONT_SCALE_KEY,
        label="בון מטבח — גודל גופן (%)",
        value_type="integer",
        default_value=FONT_SCALE_DEFAULT,
        description=(
            f"הגדלה או הקטנה של כל הטקסט בבון, {FONT_SCALE_MIN}–{FONT_SCALE_MAX} אחוז "
            f"(ברירת מחדל {FONT_SCALE_DEFAULT}). {_LEVELS_TEXT}"
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
            + f". ברירת מחדל: הכל ({HEADER_DEFAULT}). השולחן מודפס תמיד. {_LEVELS_TEXT}"
        ),
    ),
    dict(
        key=CHECKBOXES_KEY,
        label="בון מטבח — תיבת סימון ☐ ליד כל שורה",
        value_type="boolean",
        default_value=False,
        description=(
            "תיבת ☐ ליד כל פריט, לסימון במטבח (בתבנית \"לפי קורסים ומושבים\" התיבות מופעלות). " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=ELAPSED_KEY,
        label="בון מטבח — \"פתוח X דק'\" בראש הבון",
        value_type="boolean",
        default_value=False,
        description=(
            "כמה זמן השולחן פתוח, בראש הבון (\"פתוח 25 דק'\"; בתבנית \"מודרני\" מופעל). " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=FIT_KEY,
        label="בון מטבח — שורה אחת לפריט",
        value_type="enum",
        enum_options=FITS,
        enum_labels=FIT_LABELS,
        default_value="fit",
        description=(
            "«fit» (ברירת מחדל): כל שורת פריט (כמות ושם) נכנסת בשורה אחת ברוחב הבון (58 או 80 מ\"מ) — קודם "
            "הגופן קטן עד \"גודל טקסט מינימלי\", ורק אז השורה נשברת, עם המשך מתחת לשם. «wrap»: גודל קבוע "
            "ושבירת שורות. " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=MIN_TEXT_KEY,
        label="בון מטבח — גודל טקסט מינימלי",
        value_type="enum",
        enum_options=MIN_TEXT_SIZES,
        enum_labels={k: SIZE_LABELS[k] for k in MIN_TEXT_SIZES},
        default_value="s",
        description="עד כמה שם פריט יכול לקטון כדי להיכנס בשורה אחת: xs, s (ברירת מחדל) או m. " + _LEVELS_TEXT,
    ),
    dict(
        key=MAX_TEXT_KEY,
        label="בון מטבח — גודל טקסט מקסימלי",
        value_type="enum",
        enum_options=MAX_TEXT_SIZES,
        enum_labels={k: SIZE_LABELS[k] for k in MAX_TEXT_SIZES},
        default_value="m",
        description=(
            "הגודל של שם פריט כשהוא נכנס: s, m (ברירת מחדל — בערך 32 תווים בשורה ב-80 מ\"מ ו-24 ב-58 מ\"מ) "
            "או l. " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=HEADER_SIZE_KEY,
        label="בון מטבח — גודל מספר השולחן",
        value_type="enum",
        enum_options=HEADER_SIZES,
        enum_labels={k: SIZE_LABELS[k] for k in HEADER_SIZES},
        default_value="m",
        description="גודל השולחן בראש הבון: s, m (ברירת מחדל) או l — לכל היותר פי 2 מגודל פריט. " + _LEVELS_TEXT,
    ),
    dict(
        key=INLINE_MODS_KEY,
        label="בון מטבח — תוספות באותה שורה",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת מחדל): תוספות, הורדות והערה קצרה באותה שורה של הפריט אחרי \" · \" כשיש מקום, "
            "אחרת בשורה מוזחת מתחת לשם. כבוי: תמיד בשורות מוזחות. " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=ORDER_KEY,
        label="בון מטבח — סדר הפריטים",
        value_type="enum",
        enum_options=ORDER_BYS,
        enum_labels=ORDER_LABELS,
        default_value="added",
        description=(
            "מה מופיע קודם בבון. «added» (ברירת מחדל): לפי סדר ההוספה, כמו היום. «course»: לפי סדר הקורסים "
            "(ראשונות, עיקריות, קינוחים…). «category»: לפי סדר המחלקות בקטלוג. «custom»: לפי \"בון מטבח — סדר "
            "שלי\". בתוך כל קבוצה — לפי סדר ההוספה. בון ביטול, העתק והדפסה חוזרת באותו סדר. " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=ORDER_LIST_KEY,
        label="בון מטבח — סדר שלי",
        value_type="string",
        default_value="",
        description=(
            "לסדר «custom»: קורסים ומחלקות בסדר הרצוי, רשימה מופרדת בפסיקים של course:<מזהה> ו-category:<מזהה> "
            f"(עד {ORDER_LIST_MAX}). מה שלא ברשימה יורד לסוף. נוח יותר לסדר בגרירה במסך המדפסות. " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=GROUP_HEADERS_KEY,
        label="בון מטבח — כותרת לכל קבוצה",
        value_type="enum",
        enum_options=GROUP_HEADERS,
        enum_labels=GROUP_HEADER_LABELS,
        default_value="auto",
        description=(
            "כותרת דקה לכל קבוצה (\"── ראשונות ──\"), בלי שחור. «auto» (ברירת מחדל): מופעל כשהסדר לפי קורסים, "
            "מחלקות או סדר שלי. כשאין כותרת, הקורס מודפס קטן ליד הפריט. " + _LEVELS_TEXT
        ),
    ),
    dict(
        key=NO_COURSE_KEY,
        label="בון מטבח — פריט בלי קורס",
        value_type="enum",
        enum_options=NO_COURSE,
        enum_labels=NO_COURSE_LABELS,
        default_value="last",
        description="בסדר לפי קורסים: פריט בלי קורס בסוף («last», ברירת מחדל) או בהתחלה («first»). " + _LEVELS_TEXT,
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


def printer_header(value: Any) -> List[str]:
    """A printer's own info fields (a list or comma text; empty — the table alone), in `INFO_FIELDS` order."""
    fields = _clean_fields(value, "ticketHeader", INFO_FIELDS)
    chosen = set(fields) | {MANDATORY_HEADER_FIELD}
    return [f for f in INFO_FIELDS if f in chosen]


_ENUM_PARAMS: Dict[str, Tuple[str, ...]] = {
    FIT_KEY: FITS,
    MIN_TEXT_KEY: MIN_TEXT_SIZES,
    MAX_TEXT_KEY: MAX_TEXT_SIZES,
    HEADER_SIZE_KEY: HEADER_SIZES,
    ORDER_KEY: ORDER_BYS,
    GROUP_HEADERS_KEY: GROUP_HEADERS,
    NO_COURSE_KEY: NO_COURSE,
}
_BOOL_PARAMS = (INK_SAVER_KEY, CHECKBOXES_KEY, ELAPSED_KEY, INLINE_MODS_KEY)


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key` (normalised), or ValueError. Other keys pass as they are."""
    if value is None:
        return None
    if key == DESIGN_KEY:
        return parse_design_value(value)[1]
    if key in _BOOL_PARAMS:
        if not isinstance(value, bool):
            raise StyleError(f"{key}: true or false")
        return value
    if key == FONT_SCALE_KEY:
        return _whole(value, key, FONT_SCALE_MIN, FONT_SCALE_MAX)
    if key == HEADER_KEY:
        return ",".join(parse_header(value))
    if key == ORDER_LIST_KEY:
        return order_list_text(clean_order_list(value, key))
    if key in _ENUM_PARAMS:
        if value not in _ENUM_PARAMS[key]:
            raise StyleError(f"{key}: one of {', '.join(_ENUM_PARAMS[key])}")
        return value
    return value


# ── Resolving ────────────────────────────────────────────────────────────────


def _filter_fields(style: Dict[str, Any], allowed: Iterable[str]) -> None:
    """Only the info fields `allowed` stay in the header and the foot (the printer's name always may)."""
    keep = set(allowed) | {MANDATORY_HEADER_FIELD}
    style["header"]["fields"] = [f for f in style["header"]["fields"] if f in keep]
    style["footer"]["fields"] = [f for f in style["footer"]["fields"] if f in keep or f == "printer"]


def _apply_options(style: Dict[str, Any], options: Dict[str, Any]) -> None:
    """The options a level or a printer sets (`OPTION_NAMES`' short names); None = inherit."""
    if options.get("fontScale") is not None:
        style["fontScale"] = options["fontScale"]
    if options.get("header") is not None:
        _filter_fields(style, options["header"])
    if options.get("checkboxes") is not None:
        style["checkboxes"] = bool(options["checkboxes"])
    if options.get("elapsed") is not None:
        style["elapsed"] = bool(options["elapsed"])
    if options.get("fit") in FITS:
        style["fit"] = options["fit"]
    if options.get("minTextSize") in MIN_TEXT_SIZES:
        style["itemName"]["minSize"] = options["minTextSize"]
    if options.get("maxTextSize") in MAX_TEXT_SIZES:
        style["itemName"]["maxSize"] = options["maxTextSize"]
    if options.get("headerSize") in HEADER_SIZES:
        style["header"]["size"] = options["headerSize"]
    if options.get("inlineMods") is not None:
        style["mods"]["layout"] = "inline" if options["inlineMods"] else "indent"
    if options.get("order") in ORDER_BYS:
        style["order"]["by"] = options["order"]
    if options.get("orderList") is not None:
        style["order"]["list"] = [dict(e) for e in options["orderList"]]
    if options.get("groupHeaders") in GROUP_HEADERS:
        style["order"]["groupHeaders"] = options["groupHeaders"]
    if options.get("noCourse") in NO_COURSE:
        style["order"]["noCourse"] = options["noCourse"]


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
    """The level options as `_apply_options` takes them, from parameters SET at some level."""
    out: Dict[str, Any] = {}
    for key, name in OPTION_NAMES.items():
        value = params.get(key)
        if value is None:
            continue
        try:
            value = clean_value(key, value)
        except StyleError:
            continue  # a stored value the look no longer takes: inherit
        if key == HEADER_KEY:
            value = parse_header(value)
        elif key == ORDER_LIST_KEY:
            value = clean_order_list(value, key)
        out[name] = value
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
    names: Optional[Dict[Tuple[str, str], str]] = None,
) -> Dict[str, Any]:
    """
    The full `ticketStyle` the till draws by. `level`: the till parameters SET on the till's levels
    (`level_options` of them); `ink_saver`: `kitchenTicketInkSaver` as it resolves (default on);
    `overrides`: the design's; `printer`: the printer's own options (the short names of
    `OPTION_NAMES`; None = inherit); `names`: (kind, id) → the course's / category's name, for
    `order.list` (an entry not found keeps a null name — the till matches by id).
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
    item = look["itemName"]
    if TEXT_SIZES.index(item["minSize"]) > TEXT_SIZES.index(item["maxSize"]):
        item["minSize"] = item["maxSize"]
    order = look["order"]
    headers = order["groupHeaders"]
    order["groupHeaders"] = headers == "on" or (headers == "auto" and order["by"] != "added")
    order["list"] = [
        {"kind": e["kind"], "id": e["id"], "name": (names or {}).get((e["kind"], e["id"]))} for e in order["list"]
    ]
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
    names: Optional[Dict[Tuple[str, str], str]] = None,
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
        names=names,
    )


# ── The order of the lines (§9) — the till's rule, and the dashboard's preview ──


def category_positions(categories: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    """
    Each category's place in the catalog: the tree depth first, siblings by (sortOrder, name).
    `categories`: `[{id, name, parentId, sortOrder}]` as the till holds them.
    """
    children: Dict[Optional[str], List[Dict[str, Any]]] = {}
    ids = {c["id"] for c in categories}
    for c in categories:
        parent = c.get("parentId") if c.get("parentId") in ids else None
        children.setdefault(parent, []).append(c)
    out: Dict[str, int] = {}

    def walk(parent: Optional[str]) -> None:
        for c in sorted(children.get(parent, []), key=lambda c: (c.get("sortOrder") or 0, c.get("name") or "")):
            if c["id"] in out:
                continue
            out[c["id"]] = len(out)
            walk(c["id"])

    walk(None)
    return out


def seat_key(seat: Optional[str]) -> Tuple[Any, ...]:
    """"מ2" before "מ10": the digits as a number, the rest as text."""
    import re

    parts = re.split(r"(\d+)", (seat or "").strip())
    return tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in parts if p)


def _ancestors(category_id: Optional[str], categories: Sequence[Dict[str, Any]]) -> List[str]:
    parents = {c["id"]: c.get("parentId") for c in categories}
    chain: List[str] = []
    current = category_id
    while current and current not in chain:
        chain.append(current)
        current = parents.get(current)
    return chain


def order_lines(
    lines: Sequence[Dict[str, Any]],
    style: Dict[str, Any],
    courses: Sequence[Dict[str, Any]],
    categories: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    The ticket's lines in the order the style prints them, in groups: `[{key, kind, title, lines:
    [index…]}]` (`kind`: course | category | none). `courses`: the till's menu courses `[{id, name,
    sortOrder}]`; `categories`: its catalog's `[{id, name, parentId, sortOrder}]`. A line's course is
    its `course` name (or `courseId`); its category its `categoryId` (or an ancestor of it). Within a
    group: as added, by seat when `grouping` is `seat`. Stable: a reprint prints in the same order.
    """
    order = style["order"]
    by = order["by"]
    course_rank = {}
    course_by_name = {}
    for c in sorted(courses, key=lambda c: (c.get("sortOrder") or 0, c.get("name") or "")):
        course_rank[c["id"]] = len(course_rank)
        course_by_name.setdefault(c["name"], c)
    cat_rank = category_positions(categories)
    cat_names = {c["id"]: c.get("name") for c in categories}
    no_course_first = order.get("noCourse") == "first"
    # A course the till does not know keeps its place among the unknown ones: as first added.
    first_seen: Dict[str, int] = {}
    for i, ln in enumerate(lines):
        first_seen.setdefault((ln.get("course") or "").strip(), i)

    def course_of(line: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        cid = line.get("courseId")
        if cid:
            for c in courses:
                if c["id"] == cid:
                    return c
        name = (line.get("course") or "").strip()
        if not name:
            return None
        return course_by_name.get(name) or {"id": None, "name": name}

    groups: List[Dict[str, Any]] = []

    def group_for(key: Tuple[Any, ...], kind: str, title: Optional[str]) -> Dict[str, Any]:
        for g in groups:
            if g["key"] == key:
                return g
        g = {"key": key, "kind": kind, "title": title, "lines": []}
        groups.append(g)
        return g

    keyed: List[Tuple[Tuple[Any, ...], str, Optional[str], Tuple[Any, ...], int]] = []
    for index, line in enumerate(lines):
        course = course_of(line)
        if by == "added":
            # As added; a group runs while the course stays the same (today's "— ראשונות —").
            title = course["name"] if course else None
            if keyed and keyed[-1][2] == title:
                key = keyed[-1][0]
            else:
                key = ("run", len({k[0] for k in keyed}), title)
            keyed.append((key, "course" if course else "none", title, (len(keyed),), index))
        elif by == "course":
            if course is None:
                rank = (-1 if no_course_first else 10**6,)
                keyed.append((("none",), "none", None, rank, index))
            else:
                known = course.get("id") in course_rank
                rank = (course_rank[course["id"]], 0) if known else (10**5, first_seen.get(course["name"], 0))
                keyed.append((("course", course["name"]), "course", course["name"], rank, index))
        elif by == "category":
            cid = line.get("categoryId")
            rank = (cat_rank.get(cid, 10**6),)
            keyed.append((("category", cid), "category" if cid else "none", cat_names.get(cid), rank, index))
        else:  # custom
            chain = _ancestors(line.get("categoryId"), categories)
            hit = None
            for position, entry in enumerate(order.get("list") or []):
                if entry["kind"] == "course" and course is not None and (
                    entry["id"] == course.get("id") or (entry.get("name") and entry.get("name") == course["name"])
                ):
                    hit = (position, entry, course["name"])
                    break
                if entry["kind"] == "category" and entry["id"] in chain:
                    hit = (position, entry, entry.get("name") or cat_names.get(entry["id"]))
                    break
            if hit is None:
                keyed.append((("rest",), "none", None, (10**6,), index))
            else:
                position, entry, title = hit
                keyed.append(((entry["kind"], entry["id"]), entry["kind"], title, (position,), index))
    for key, kind, title, _rank, index in sorted(keyed, key=lambda k: (k[3], k[4])):
        group_for(key, kind, title)["lines"].append(index)
    if style.get("grouping") == "seat":
        for g in groups:
            g["lines"].sort(key=lambda i: (lines[i].get("seat") is None, seat_key(lines[i].get("seat")), i))
    return [{"key": "|".join(str(p) for p in g["key"]), "kind": g["kind"], "title": g["title"], "lines": g["lines"]} for g in groups]


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
            "seat": "מ1", "course": "ראשונות", "mealName": None, "refill": None, "held": None,
        },
        {
            "productId": None, "categoryId": None, "name": "קרפצ'יו בקר", "quantity": 1.0, "notes": "רוטב בצד",
            "mods": None, "removals": None, "important": None, "allergies": None,
            "seat": "מ2", "course": "ראשונות", "mealName": None, "refill": None, "held": None,
        },
        {
            "productId": None, "categoryId": None, "name": "המבורגר 250 גרם", "quantity": 1.0, "notes": None,
            "mods": ["מדיום"], "removals": ["בלי עגבנייה"], "important": None, "allergies": ["אגוזים"],
            "seat": "מ1", "course": "עיקריות", "mealName": "ארוחה עסקית", "refill": None, "held": True,
        },
        {
            "productId": None, "categoryId": None, "name": "פסטה ארביאטה", "quantity": 2.0, "notes": "ללא גלוטן",
            "mods": None, "removals": None, "important": True, "allergies": None,
            "seat": "מ2", "course": "עיקריות", "mealName": None, "refill": None, "held": True,
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
