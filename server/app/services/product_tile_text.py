"""
"שם פריט מלא על הכפתור, ותג i" (P:/specs/product-tile-text.md): how the till writes a product's name
and price on its button, and the "i" badge that opens the item's full description.

Four till parameters — company → shop → point of sale → till like every till parameter, the most
specific wins (registered in app/services/till_parameters.py), sent with the others in
`GET /sync/{machine_id}/parameters` — and the same four as fields of "עיצוב קופה" under "מראה"
(`productText.<key>` of the design, app/services/till_design.py), where the design wins over the
parameter (§5):

    productNameFit          fit | wrap | clip       fit   — §3
    productNameMaxLines     1–4                     3
    productNameMinTextSize  s | m | l               s     — the floor of the shrink
    productInfoBadge        auto | always | off     auto  — §4

Read by the till (pos-android), the web till and the Windows till — on every order screen and in
every template, the table's order, the favourites and the categories' landing (its category names);
never the kiosk, which has a description view of its own.

**The rules** (one for every surface; the dashboard's lib/productTileText.ts is the reference
implementation the preview runs, and the tills mirror it):

* `fit` — the largest type size between the tile's own and the floor (`MIN_TEXT_SP`) at which the
  whole name, wrapped at words, takes at most `productNameMaxLines` lines and the tile's height;
  "…" only when not even the floor holds it. `wrap` — the tile's own size, the name wrapped to at
  most `productNameMaxLines` lines, the tile as tall as that needs (a row of tiles takes its
  tallest). `clip` — as today: the tile's own size, at most `productNameMaxLines` lines, "…".
* Worked out once per product and tile width (and kept), never per frame.
* The price is never cut (§2, no setting): its size shrinks to `PRICE_MIN_SP`; if it still does not
  fit, a trailing ".00" goes; the amount itself is always written whole.
* The "i" badge: `auto` — on a product with a description, or whose name did not fit whole;
  `always` — on every product; `off` — never. Top-left corner of the tile (the right one holds the
  count), a touch target of at least 32 dp; a tap opens the item's sheet and adds nothing; not shown
  while the screen is being arranged ("עריכת מסך"). A long press stays as today.

**In the design** a field set to one of the codes wins over the parameter; absent (nothing set at any
level), null or `"params"` — "לפי פרמטרי הקופה", which undoes a value a level above set — leaves the
parameter's value (`resolve`). A till reading the design treats anything that is not one of the
codes as not set, so an older till simply follows the parameters.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Tuple

NAME_FIT_KEY = "productNameFit"
FIT = "fit"
WRAP = "wrap"
CLIP = "clip"
NAME_FITS = (FIT, WRAP, CLIP)
NAME_FIT_LABELS = {
    FIT: "התאמה — כל השם נכנס (ברירת מחדל)",
    WRAP: "שבירת שורות — הכפתור גדל",
    CLIP: "קיצור עם \"…\" — כמו היום",
}

MAX_LINES_KEY = "productNameMaxLines"
MAX_LINES_MIN = 1
MAX_LINES_MAX = 4
MAX_LINES_DEFAULT = 3

MIN_TEXT_SIZE_KEY = "productNameMinTextSize"
SIZE_S = "s"
SIZE_M = "m"
SIZE_L = "l"
MIN_TEXT_SIZES = (SIZE_S, SIZE_M, SIZE_L)
MIN_TEXT_SIZE_LABELS = {SIZE_S: "קטן", SIZE_M: "בינוני", SIZE_L: "גדול"}
#: The floor of the shrink, in sp (CSS px on the web): a size below it is not "readable".
MIN_TEXT_SP: Dict[str, int] = {SIZE_S: 11, SIZE_M: 13, SIZE_L: 15}
#: The price's floor (§2, no setting): the same as the smallest name floor.
PRICE_MIN_SP = 11

INFO_BADGE_KEY = "productInfoBadge"
BADGE_AUTO = "auto"
BADGE_ALWAYS = "always"
BADGE_OFF = "off"
INFO_BADGES = (BADGE_AUTO, BADGE_ALWAYS, BADGE_OFF)
INFO_BADGE_LABELS = {
    BADGE_AUTO: "אוטומטי — כשיש תיאור או שהשם לא נכנס",
    BADGE_ALWAYS: "תמיד",
    BADGE_OFF: "כבוי",
}
#: The badge's touch target, in dp, whatever the size of its icon.
INFO_BADGE_TOUCH_DP = 32

#: The keys, in the order the dashboard shows them.
KEYS: Tuple[str, ...] = (NAME_FIT_KEY, MAX_LINES_KEY, MIN_TEXT_SIZE_KEY, INFO_BADGE_KEY)
#: The codes the till knows for each enum key — and no other, even if a definition's options are re-edited.
CODES: Dict[str, Tuple[str, ...]] = {
    NAME_FIT_KEY: NAME_FITS,
    MIN_TEXT_SIZE_KEY: MIN_TEXT_SIZES,
    INFO_BADGE_KEY: INFO_BADGES,
}
DEFAULTS: Dict[str, Any] = {
    NAME_FIT_KEY: FIT,
    MAX_LINES_KEY: MAX_LINES_DEFAULT,
    MIN_TEXT_SIZE_KEY: SIZE_S,
    INFO_BADGE_KEY: BADGE_AUTO,
}

#: The design's section (`productText.<key>`) and its "לפי פרמטרי הקופה" over a level above's value.
DESIGN_SECTION = "productText"
DESIGN_PARAMS = "params"

_LEVELS = (
    "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה, וגם בכרטיס \"עיצוב קופה\" תחת \"מראה\" — "
    "ושם העיצוב גובר על הפרמטר."
)
_SCREENS = (
    "בכל מסכי ההזמנה בקופה — בטלפון, בטאבלט, במכשיר הנייד, בהזמנת שולחן, במועדפים ובכל התבניות "
    "המעוצבות, וגם בקופת Windows ובקופת web (לא בקיוסק)"
)

#: The built-ins (app/services/till_parameters.py `BUILTIN_PARAMETERS`).
PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=NAME_FIT_KEY,
        label="שם הפריט על הכפתור",
        value_type="enum",
        enum_options=NAME_FITS,
        enum_labels=NAME_FIT_LABELS,
        default_value=FIT,
        description=(
            f"איך שם הפריט נכתב על הכפתור {_SCREENS}. "
            f"«{NAME_FIT_LABELS[FIT]}» — הגופן קטן עד גודל קריא מינימלי, והשם נשבר לעד "
            "\"מספר שורות מרבי\"; \"…\" רק כמוצא אחרון, אם השם עדיין לא נכנס. "
            f"«{NAME_FIT_LABELS[WRAP]}» — גודל הגופן קבוע, השם נשבר לעד \"מספר שורות מרבי\", וגובה "
            "הכפתור גדל לפי הצורך (כל השורה מתיישרת לגובה אחד). "
            f"«{NAME_FIT_LABELS[CLIP]}» — מספר שורות קבוע, והשם נקטע עם \"…\". "
            "המחיר תמיד מוצג במלואו, בכל מצב: כשאין מקום הגופן שלו קטן, ואם עדיין אין מקום האגורות \".00\" יורדות. "
            f"החישוב נעשה פעם אחת לכל פריט ולכל רוחב כפתור. {_LEVELS}"
        ),
    ),
    dict(
        key=MAX_LINES_KEY,
        label="שם הפריט: מספר שורות מרבי",
        value_type="integer",
        default_value=MAX_LINES_DEFAULT,
        description=(
            "עד כמה שורות שם הפריט נשבר על הכפתור "
            f"({MAX_LINES_MIN}–{MAX_LINES_MAX}, ברירת מחדל {MAX_LINES_DEFAULT}). "
            f"חל על כל שלושת המצבים של \"שם הפריט על הכפתור\". {_LEVELS}"
        ),
    ),
    dict(
        key=MIN_TEXT_SIZE_KEY,
        label="שם הפריט: גודל גופן מינימלי",
        value_type="enum",
        enum_options=MIN_TEXT_SIZES,
        enum_labels=MIN_TEXT_SIZE_LABELS,
        default_value=SIZE_S,
        description=(
            "עד איזה גודל הגופן של שם הפריט קטן במצב «התאמה», לפני שהשם נקטע: "
            f"«{MIN_TEXT_SIZE_LABELS[SIZE_S]}» (ברירת מחדל, {MIN_TEXT_SP[SIZE_S]}), "
            f"«{MIN_TEXT_SIZE_LABELS[SIZE_M]}» ({MIN_TEXT_SP[SIZE_M]}) או "
            f"«{MIN_TEXT_SIZE_LABELS[SIZE_L]}» ({MIN_TEXT_SP[SIZE_L]}). {_LEVELS}"
        ),
    ),
    dict(
        key=INFO_BADGE_KEY,
        label="תג i לתיאור הפריט",
        value_type="enum",
        enum_options=INFO_BADGES,
        enum_labels=INFO_BADGE_LABELS,
        default_value=BADGE_AUTO,
        description=(
            "תג i בפינה העליונה השמאלית של כפתור הפריט, שפותח לעובד את פרטי הפריט: השם המלא והמחלקה, "
            "התיאור המלא, המחיר (או טווח המחירים, וגדלים ווריאציות אם יש), תגיות תזונה ואלרגנים, תמונה, "
            "מצב \"אזל\" או \"חסום\" עם הסיבה, וכפתור \"הוסף לסל\" (כפוף להרשאות ולחסימות כמו לחיצה רגילה). "
            "בטלפון ובמכשיר הנייד חלון תחתון, בטאבלט חלון קטן. לחיצה על התג לא מוסיפה לסל, "
            "ובמצב עריכת מסך התג לא מוצג. "
            f"«{INFO_BADGE_LABELS[BADGE_AUTO]}» (ברירת מחדל) — על פריט שיש לו תיאור, או ששמו לא נכנס במלואו. "
            f"«{INFO_BADGE_LABELS[BADGE_ALWAYS]}» — על כל פריט. «{INFO_BADGE_LABELS[BADGE_OFF]}» — לא מוצג. {_LEVELS}"
        ),
    ),
)


def _is_lines(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and MAX_LINES_MIN <= value <= MAX_LINES_MAX


def clean_value(key: str, value: Any) -> Any:
    """`value` for `key` if the till knows it (a code, or 1–4 lines), else ValueError. Other keys pass."""
    if value is None:
        return value
    if key == MAX_LINES_KEY:
        if not _is_lines(value):
            raise ValueError(f"{MAX_LINES_KEY} must be a whole number {MAX_LINES_MIN}–{MAX_LINES_MAX}")
        return value
    codes = CODES.get(key)
    if codes is not None and value not in codes:
        raise ValueError(f"{key} must be one of {', '.join(codes)}")
    return value


def is_code(key: str, value: Any) -> bool:
    """Whether `value` is one the till knows for `key` (a design field set to it wins over the parameter)."""
    if key == MAX_LINES_KEY:
        return _is_lines(value)
    codes = CODES.get(key)
    return codes is not None and isinstance(value, str) and value in codes


def from_parameters(parameters: Mapping[str, Any]) -> Dict[str, Any]:
    """The four as the till parameters set them, each that is not one the till knows at its default."""
    return {key: parameters.get(key) if is_code(key, parameters.get(key)) else DEFAULTS[key] for key in KEYS}


def resolve(design: Optional[Mapping[str, Any]], parameters: Mapping[str, Any]) -> Dict[str, Any]:
    """
    What a till uses (§5 "העיצוב גובר על הפרמטר"): the design's `productText.<key>` when it is one of
    the codes, else the parameter's value, else the default. `"params"`, null or absent: the parameter.
    """
    own = design if isinstance(design, Mapping) else {}
    params = from_parameters(parameters)
    return {key: own.get(key) if is_code(key, own.get(key)) else params[key] for key in KEYS}
