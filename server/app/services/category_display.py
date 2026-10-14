"""
"צבע ותמונה למחלקה" (P:/specs/category-color-image.md §2): how the till's order screens show a
category's own colour (`categories.color`) and picture (`categories.image_url`).

Three till parameters — company → shop → point of sale → till like every till parameter, the most
specific wins (registered in app/services/till_parameters.py), sent with the others in
`GET /sync/{machine_id}/parameters` — and edited on the parameters page and in "עיצוב קופה"
(`GET / PUT /till-design/category-display`, app/routers/till_design.py), by whoever edits the till
design at that level:

    categoryColors     off | chip | accent     off   — as today: the design system's colours
    categoryImages     off | bar | landing     off   — as today: no pictures
    categoryImageSize  s | m | l               m

Read by the till only (pos-android), on every order screen with a category bar: phone, tablet, a
table's order and every designed template. **Nothing set = today's screens.**

`chip`: the category's button in the bar is filled with its colour, the text white or black by the
colour's brightness (`readable_text_on`, the dashboard's lib/categoryLook.ts `readableTextOn` — the
one rule, so the preview and the till agree). `accent`: a stripe of the colour at the button's side
and under the category's heading. A category with no colour of its own looks as today.

`bar`: a small picture in the category's button. `landing`: the order opens on a page of the
categories with their pictures before the items; a category with no picture shows its first letter
on its colour. The till keeps the pictures in its local cache (`localImagePath`), as product
pictures, so they show without a network.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

COLORS_KEY = "categoryColors"
COLORS_OFF = "off"
COLORS_CHIP = "chip"
COLORS_ACCENT = "accent"
COLORS_OPTIONS = (COLORS_OFF, COLORS_CHIP, COLORS_ACCENT)
COLORS_LABELS = {
    COLORS_OFF: "כבוי — כמו היום",
    COLORS_CHIP: "רקע הכפתור בסרגל",
    COLORS_ACCENT: "פס צבע בצד הכפתור ובכותרת",
}

IMAGES_KEY = "categoryImages"
IMAGES_OFF = "off"
IMAGES_BAR = "bar"
IMAGES_LANDING = "landing"
IMAGES_OPTIONS = (IMAGES_OFF, IMAGES_BAR, IMAGES_LANDING)
IMAGES_LABELS = {
    IMAGES_OFF: "כבוי — כמו היום",
    IMAGES_BAR: "תמונה קטנה בכפתור המחלקה",
    IMAGES_LANDING: "עמוד פתיחה של מחלקות עם תמונות",
}

IMAGE_SIZE_KEY = "categoryImageSize"
SIZE_S = "s"
SIZE_M = "m"
SIZE_L = "l"
SIZE_OPTIONS = (SIZE_S, SIZE_M, SIZE_L)
SIZE_LABELS = {SIZE_S: "קטן", SIZE_M: "בינוני", SIZE_L: "גדול"}

#: The keys, in the order the dashboard's card shows them.
KEYS: Tuple[str, ...] = (COLORS_KEY, IMAGES_KEY, IMAGE_SIZE_KEY)
#: The codes the till knows for each key — and no other, even if a definition's options are re-edited.
CODES: Dict[str, Tuple[str, ...]] = {
    COLORS_KEY: COLORS_OPTIONS,
    IMAGES_KEY: IMAGES_OPTIONS,
    IMAGE_SIZE_KEY: SIZE_OPTIONS,
}
DEFAULTS: Dict[str, str] = {COLORS_KEY: COLORS_OFF, IMAGES_KEY: IMAGES_OFF, IMAGE_SIZE_KEY: SIZE_M}

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה, וגם בכרטיס \"עיצוב קופה\"."
_SCREENS = "בכל מסכי ההזמנה בקופה — בטלפון, בטאבלט, בהזמנת שולחן ובכל התבניות המעוצבות"

#: The built-ins (app/services/till_parameters.py `BUILTIN_PARAMETERS`).
PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=COLORS_KEY,
        label="צבע מחלקה בהזמנה",
        value_type="enum",
        enum_options=COLORS_OPTIONS,
        enum_labels=COLORS_LABELS,
        default_value=COLORS_OFF,
        description=(
            f"איך צבע המחלקה (שנקבע בעריכת המחלקה בדשבורד) מוצג {_SCREENS}. "
            f"«{COLORS_LABELS[COLORS_OFF]}» (ברירת מחדל) — הצבעים של עיצוב הקופה, כמו היום. "
            f"«{COLORS_LABELS[COLORS_CHIP]}» — כפתור המחלקה בסרגל צבוע בצבע שלה, והטקסט לבן או שחור "
            "לפי בהירות הצבע, כך שהוא קריא גם בערכה כהה. "
            f"«{COLORS_LABELS[COLORS_ACCENT]}» — פס בצבע המחלקה בצד הכפתור ומתחת לכותרת המחלקה. "
            f"מחלקה בלי צבע נראית כמו היום. {_LEVELS}"
        ),
    ),
    dict(
        key=IMAGES_KEY,
        label="תמונת מחלקה בהזמנה",
        value_type="enum",
        enum_options=IMAGES_OPTIONS,
        enum_labels=IMAGES_LABELS,
        default_value=IMAGES_OFF,
        description=(
            f"איך תמונת המחלקה (שהועלתה בעריכת המחלקה בדשבורד) מוצגת {_SCREENS}. "
            f"«{IMAGES_LABELS[IMAGES_OFF]}» (ברירת מחדל) — בלי תמונות, כמו היום. "
            f"«{IMAGES_LABELS[IMAGES_BAR]}» — תמונה קטנה בתוך כפתור המחלקה בסרגל. "
            f"«{IMAGES_LABELS[IMAGES_LANDING]}» — ההזמנה נפתחת על עמוד של המחלקות עם התמונות שלהן, "
            "ובחירה במחלקה פותחת את הפריטים שלה; מחלקה בלי תמונה מוצגת באות הראשונה שלה על הצבע שלה. "
            f"התמונות נשמרות בקופה ומוצגות גם בלי רשת. {_LEVELS}"
        ),
    ),
    dict(
        key=IMAGE_SIZE_KEY,
        label="גודל תמונת מחלקה",
        value_type="enum",
        enum_options=SIZE_OPTIONS,
        enum_labels=SIZE_LABELS,
        default_value=SIZE_M,
        description=(
            "גודל תמונת המחלקה בכפתור ובעמוד הפתיחה של המחלקות (כשתמונת מחלקה בהזמנה מופעלת): "
            f"«{SIZE_LABELS[SIZE_S]}», «{SIZE_LABELS[SIZE_M]}» (ברירת מחדל) או «{SIZE_LABELS[SIZE_L]}». {_LEVELS}"
        ),
    ),
)


def clean_value(key: str, value: Any) -> Any:
    """`value` for `key` if it is one of the codes the till knows, else ValueError. Other keys pass."""
    codes = CODES.get(key)
    if codes is None or value is None:
        return value
    if value not in codes:
        raise ValueError(f"{key} must be one of {', '.join(codes)}")
    return value


# ── The colour's text (the till's and the dashboard's one rule) ───────────────

_HEX = re.compile(r"^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$")
WHITE = "#FFFFFF"
BLACK = "#000000"


def _channel(c: int) -> float:
    s = c / 255.0
    return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4


def relative_luminance(hex_color: str) -> Optional[float]:
    """WCAG relative luminance of `#RGB` / `#RRGGBB`, or None for anything else."""
    match = _HEX.match((hex_color or "").strip())
    if match is None:
        return None
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    r, g, b = (int(digits[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def readable_text_on(hex_color: str) -> Optional[str]:
    """
    The text colour on a `chip` of this colour: white or black, whichever contrasts more (WCAG), so a
    dark blue gets white and a yellow black. None for a colour that is not one (the chip is not drawn).
    """
    lum = relative_luminance(hex_color)
    if lum is None:
        return None
    on_white = 1.05 / (lum + 0.05)
    on_black = (lum + 0.05) / 0.05
    return WHITE if on_white >= on_black else BLACK


# ── One level, as "עיצוב קופה" edits it ───────────────────────────────────────


def level_view(db, scope_type: str, scope_id: Any) -> Dict[str, Any]:
    """
    What one level sets itself (`own`), what it inherits from the levels above or the default
    (`inherited`), and the three definitions with each code's Hebrew (`enumLabels`).
    """
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.kds_workflow import chain_for_scope
    from app.services.till_parameters import as_uuid, enum_labels, ensure_builtin_parameters, resolve_till_parameters

    ensure_builtin_parameters(db)
    params = db.query(TillParameter).filter(TillParameter.key.in_(KEYS)).all()
    by_key = {p.key: p for p in params}
    by_id = {p.id: p for p in params}
    ident = as_uuid(scope_id)
    own_rows = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_(list(by_id)),
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == ident,
        )
        .all()
        if params
        else []
    )
    own = {by_id[r.parameter_id].key: r.value for r in own_rows if r.parameter_id in by_id}
    above, _shop = chain_for_scope(db, scope_type, ident, above_only=True)
    scopes = above.scopes()
    values = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_(list(by_id)),
            or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
        )
        .all()
        if scopes and params
        else []
    )
    inherited = resolve_till_parameters(params, values, above).parameters
    return {
        "scopeType": scope_type,
        "scopeId": str(ident),
        "own": own,
        "inherited": inherited,
        "parameters": [
            {
                "key": key,
                "label": by_key[key].label,
                "description": by_key[key].description,
                "valueType": by_key[key].value_type,
                # The codes the till knows, whatever the definition's options were re-edited to.
                "enumOptions": [o for o in (by_key[key].enum_options or []) if o in CODES[key]] or list(CODES[key]),
                "enumLabels": enum_labels(key),
                "defaultValue": by_key[key].default_value,
            }
            for key in KEYS
            if key in by_key and by_key[key].is_active
        ],
    }


def save_values(
    db, scope_type: str, scope_id: Any, values: Dict[str, Any], *, user: Any, now: Optional[datetime] = None,
) -> List[Tuple[str, str]]:
    """
    Write `values` (key → code; None clears the level's own value, so it inherits) at one level, each
    change with its row in `till_parameter_changes`, in the caller's transaction. Raises
    `TillParameterValueError` on a key that is not one of the three or a code the till does not know.
    Returns the tills to notify (`till_parameters_updated`).
    """
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import (
        TillParameterValueError,
        as_uuid,
        ensure_builtin_parameters,
        notify_targets_for_scope,
        validate_keyed_value,
        validate_value,
        write_value,
    )

    if not isinstance(values, dict):
        raise TillParameterValueError("values must be an object")
    unknown = [k for k in values if k not in KEYS]
    if unknown:
        raise TillParameterValueError(f"unknown parameter {unknown[0]}")
    ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(KEYS)).all()}
    ident = as_uuid(scope_id)
    now = now or datetime.now(timezone.utc)
    # Every value checked before any is written: one bad code leaves the level as it was.
    stored: Dict[str, Any] = {}
    for key, value in values.items():
        parameter = params.get(key)
        if parameter is None:
            continue
        stored[key] = (
            None
            if value is None
            else validate_keyed_value(key, validate_value(parameter.value_type, value, parameter.enum_options))
        )
    for key, value in stored.items():
        write_value(db, params[key], scope_type, ident, value, user=user, now=now)
    db.flush()
    return list(notify_targets_for_scope(db, scope_type, ident))
