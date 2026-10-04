"""
Till parameters ("פרמטרים לקופות"): validation, resolution per till, and who to notify.

A super admin defines a parameter once (`TillParameter`) and sets its value at any of
four levels (`TillParameterValue`). A till gets, for every active parameter, the value
of the most specific level that has one:

    the till itself → its area → its shop → the shop's company → the parameter's default

and nothing at all for a parameter with no value on that path and no default. The
choice is made by `resolve_till_parameters`, a pure function over plain rows, so the
order is tested without a database; `till_parameters_for_machine` only gathers those
rows for one till.
"""
from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.till_parameter import (
    TILL_PARAMETER_SCOPES,
    TILL_PARAMETER_VALUE_TYPES,
    TillParameter,
    TillParameterValue,
)
from app.services.ably_notify import publish_settings_notify
from app.services.areas import as_utc

#: The Ably `settings` notify reason for any change to parameters or their values.
NOTIFY_REASON = "till_parameters_updated"

#: A letter, then letters, digits, `_` or `.`; 2–64 characters in all. The till reads
#: parameters by this name, so it stays ASCII and free of spaces.
KEY_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.]{1,63}$")

STRING_VALUE_MAX = 2000
ENUM_OPTION_MAX = 100
ENUM_OPTIONS_MAX = 100
#: Integers stay within what a JavaScript number holds exactly, so the dashboard shows
#: the value the till gets.
INTEGER_LIMIT = 2**53 - 1


class TillParameterValueError(ValueError):
    """A value, default, key or option list that does not fit the parameter."""


# ── Validation ───────────────────────────────────────────────────────────────


def validate_key(key: Any) -> str:
    if not isinstance(key, str):
        raise TillParameterValueError("key must be text")
    cleaned = key.strip()
    if not KEY_PATTERN.match(cleaned):
        raise TillParameterValueError(
            "key must start with a letter and contain only letters, digits, '_' or '.' "
            "(2-64 characters)"
        )
    return cleaned


def validate_value_type(value_type: Any) -> str:
    if value_type not in TILL_PARAMETER_VALUE_TYPES:
        raise TillParameterValueError(
            f"valueType must be one of {', '.join(TILL_PARAMETER_VALUE_TYPES)}"
        )
    return value_type


def clean_enum_options(value_type: str, options: Any) -> Optional[List[str]]:
    """
    The option list an enum keeps: trimmed, non-empty, unique, in the order given.

    Required and non-empty for an enum; for any other type an empty or missing list is
    accepted and stored as null, and a non-empty one is refused rather than ignored.
    """
    if value_type != "enum":
        if options:
            raise TillParameterValueError("enumOptions are only allowed for an enum parameter")
        return None
    if not isinstance(options, list) or not options:
        raise TillParameterValueError("an enum parameter needs at least one option")
    if len(options) > ENUM_OPTIONS_MAX:
        raise TillParameterValueError(f"at most {ENUM_OPTIONS_MAX} enum options")
    cleaned: List[str] = []
    for option in options:
        if not isinstance(option, str) or not option.strip():
            raise TillParameterValueError("enum options must be non-empty text")
        option = option.strip()
        if len(option) > ENUM_OPTION_MAX:
            raise TillParameterValueError(f"an enum option is at most {ENUM_OPTION_MAX} characters")
        if option in cleaned:
            raise TillParameterValueError(f"duplicate enum option: {option}")
        cleaned.append(option)
    return cleaned


def validate_value(value_type: str, value: Any, enum_options: Optional[Sequence[str]] = None) -> Any:
    """
    `value` as the till will receive it, or `TillParameterValueError`.

    Strict about JSON types — `"5"` is not an integer and `1` is not a boolean — so
    what the dashboard shows is exactly what the till parses. The one leniency is an
    integral float (`5.0`) for an integer, which is how some JSON encoders write 5.
    """
    if value is None:
        raise TillParameterValueError("a value is required")
    if value_type == "boolean":
        if not isinstance(value, bool):
            raise TillParameterValueError("value must be true or false")
        return value
    if value_type == "integer":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TillParameterValueError("value must be a whole number")
        if isinstance(value, float):
            if not math.isfinite(value) or not value.is_integer():
                raise TillParameterValueError("value must be a whole number")
            value = int(value)
        if abs(value) > INTEGER_LIMIT:
            raise TillParameterValueError("value is out of range")
        return value
    if value_type == "decimal":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TillParameterValueError("value must be a number")
        if isinstance(value, float) and not math.isfinite(value):
            raise TillParameterValueError("value must be a finite number")
        return value
    if value_type == "string":
        if not isinstance(value, str):
            raise TillParameterValueError("value must be text")
        if len(value) > STRING_VALUE_MAX:
            raise TillParameterValueError(f"value is at most {STRING_VALUE_MAX} characters")
        return value
    if value_type == "enum":
        if not isinstance(value, str) or value not in (enum_options or ()):
            raise TillParameterValueError(
                f"value must be one of: {', '.join(enum_options or ())}"
            )
        return value
    raise TillParameterValueError(f"unknown value type {value_type!r}")


def validate_scope_type(scope_type: Any) -> str:
    if scope_type not in TILL_PARAMETER_SCOPES:
        raise TillParameterValueError(f"scopeType must be one of {', '.join(TILL_PARAMETER_SCOPES)}")
    return scope_type


def _is_valid(value_type: str, value: Any, enum_options: Optional[Sequence[str]]) -> bool:
    try:
        validate_value(value_type, value, enum_options)
    except TillParameterValueError:
        return False
    return True


def incompatible_values(
    value_type: str, enum_options: Optional[Sequence[str]], values: Iterable[TillParameterValue]
) -> List[TillParameterValue]:
    """The stored values a changed type or option list would no longer accept."""
    return [v for v in values if not _is_valid(value_type, v.value, enum_options)]


# ── Image parameters ─────────────────────────────────────────────────────────

#: The receipt logo, printed at the head of every receipt. Supersedes the branding
#: setting `brandReceiptLogoUrl`: the till prefers this when it has a value.
RECEIPT_LOGO_KEY = "receiptLogoUrl"

#: String parameters whose value is an image URL. The dashboard edits them with an
#: image picker (upload through `POST /images/branding?kind=<kind>`, preview, clear)
#: instead of a text field. Keyed by parameter key → branding upload kind, so the
#: upload gets that kind's size limits and processing. A registry rather than a new
#: value type: the stored value is an ordinary string and the till reads it as one.
#: The picture on the till's card-payment screen ("העבר כרטיס"), and faded with a red X when
#: the charge is cancelled. A distributor puts its own terminal's picture here; with no
#: value at any level the till shows the picture it ships with.
PAYMENT_IMAGE_KEY = "paymentImageUrl"

#: The screensaver's picture or short video ("שומר מסך"), uploaded through
#: `POST /images/media` (kind "media": an image or an MP4/WebM).
SCREENSAVER_MEDIA_KEY = "screensaverMediaUrl"
#: The startup screen's picture or short video ("מסך פתיחה").
SPLASH_MEDIA_KEY = "splashMediaUrl"

IMAGE_PARAMETER_KEYS: Dict[str, str] = {
    RECEIPT_LOGO_KEY: "receipt",
    PAYMENT_IMAGE_KEY: "logo",
    SCREENSAVER_MEDIA_KEY: "media",
    SPLASH_MEDIA_KEY: "media",
}

WIDGET_IMAGE = "image"


def image_kind(key: str, value_type: str) -> Optional[str]:
    """The branding upload kind of an image parameter, or None for any other."""
    if value_type != "string":
        return None
    return IMAGE_PARAMETER_KEYS.get(key)


def parameter_widget(key: str, value_type: str) -> Optional[str]:
    """How the dashboard edits the parameter, when not by its type alone."""
    return WIDGET_IMAGE if image_kind(key, value_type) else None


def validate_image_url(value: Any) -> str:
    """
    An image parameter's value: an absolute https:// URL, as the branding images are
    (Android refuses cleartext). The one exception is this server's own media store,
    which a development server without Cloudinary serves over plain http.
    """
    if not isinstance(value, str) or not value.strip():
        raise TillParameterValueError("value must be an image URL")
    value = value.strip()
    if value.startswith("https://"):
        return value
    from app.services import local_media

    if value.startswith(f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/"):
        return value
    raise TillParameterValueError("value must be an absolute https:// image URL")


# ── Resolution ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TillScopeChain:
    """The entities a till's parameters come from. Any of them may be missing."""

    machine_id: Optional[uuid.UUID]
    area_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    company_id: Optional[uuid.UUID] = None

    def scopes(self) -> List[Tuple[str, uuid.UUID]]:
        """`(scope_type, id)` most specific first, skipping the levels the till lacks."""
        ordered = (
            ("machine", self.machine_id),
            ("area", self.area_id),
            ("shop", self.shop_id),
            ("company", self.company_id),
        )
        return [(kind, as_uuid(ident)) for kind, ident in ordered if ident is not None]


@dataclass
class ResolvedParameters:
    #: key → JSON scalar, for the active parameters that have a value for this till.
    parameters: Dict[str, Any]
    #: The newest change among the definitions and this till's values; None if none.
    updated_at: Optional[datetime]


#: "No value chosen yet" — distinct from every JSON value, `false` and `0` included.
_MISSING = object()


def as_uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _later(a: Optional[datetime], b: Optional[datetime]) -> Optional[datetime]:
    a, b = as_utc(a), as_utc(b)
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def resolve_till_parameters(
    parameters: Iterable[TillParameter],
    values: Iterable[TillParameterValue],
    chain: TillScopeChain,
) -> ResolvedParameters:
    """
    The till's parameters: per active parameter, the most specific value on `chain`,
    else its default, else nothing.

    `values` may hold rows of any scope; only those on the chain count. A stored value
    the parameter's type no longer accepts is passed over, so the till falls through to
    the next level rather than receiving something it cannot parse.

    The watermark covers every definition — an inactive one too, since deactivating a
    parameter changes what the till gets — and the values on the chain.
    """
    rank = {scope: i for i, scope in enumerate(chain.scopes())}
    by_parameter: Dict[uuid.UUID, List[Tuple[int, TillParameterValue]]] = {}
    updated_at: Optional[datetime] = None

    for row in values:
        position = rank.get((row.scope_type, as_uuid(row.scope_id)))
        if position is None:
            continue
        by_parameter.setdefault(as_uuid(row.parameter_id), []).append((position, row))
        updated_at = _later(updated_at, row.updated_at)

    resolved: Dict[str, Any] = {}
    for parameter in parameters:
        updated_at = _later(updated_at, parameter.updated_at)
        if not parameter.is_active:
            continue
        candidates = sorted(by_parameter.get(as_uuid(parameter.id), []), key=lambda c: c[0])
        chosen = _MISSING
        for _, row in candidates:
            if _is_valid(parameter.value_type, row.value, parameter.enum_options):
                chosen = validate_value(parameter.value_type, row.value, parameter.enum_options)
                break
        if chosen is _MISSING and parameter.default_value is not None:
            if _is_valid(parameter.value_type, parameter.default_value, parameter.enum_options):
                chosen = validate_value(
                    parameter.value_type, parameter.default_value, parameter.enum_options
                )
        if chosen is not _MISSING:
            resolved[parameter.key] = chosen

    return ResolvedParameters(parameters=resolved, updated_at=updated_at)


def scope_chain_for_machine(db: Session, machine: POSMachine) -> TillScopeChain:
    """The till, its area, its shop and that shop's company — as they are right now."""
    company_id = None
    if machine.shop_id is not None:
        row = db.query(Shop.company_id).filter(Shop.id == machine.shop_id).first()
        company_id = row[0] if row else None
    return TillScopeChain(
        machine_id=machine.id,
        area_id=machine.area_id,
        shop_id=machine.shop_id,
        company_id=company_id,
    )


def till_parameters_for_machine(db: Session, machine: POSMachine) -> ResolvedParameters:
    chain = scope_chain_for_machine(db, machine)
    parameters = db.query(TillParameter).all()
    on_chain = [
        and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
        for kind, ident in chain.scopes()
    ]
    values = db.query(TillParameterValue).filter(or_(*on_chain)).all() if on_chain else []
    return resolve_till_parameters(parameters, values, chain)


def resolve_for_shop(db: Session, shop: Shop) -> Dict[str, Any]:
    """
    The parameters as they stand for the shop itself, for a rule the cloud applies to
    the whole shop (a shop Z): its own value, else its company's, else the default.

    Area and till values are not consulted — they speak for part of the shop only.
    """
    chain = TillScopeChain(machine_id=None, shop_id=shop.id, company_id=shop.company_id)
    parameters = db.query(TillParameter).all()
    on_chain = [
        and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
        for kind, ident in chain.scopes()
    ]
    values = db.query(TillParameterValue).filter(or_(*on_chain)).all() if on_chain else []
    return resolve_till_parameters(parameters, values, chain).parameters


# ── Built-in parameters ───────────────────────────────────────────────────────────

#: A shop Z while some of the shop's tills are left out of it with a shift still open,
#: or with closed shifts it does not take (`app.services.z_runs`).
SHOP_Z_OPEN_TILLS_KEY = "shopZOpenTills"
SHOP_Z_OPEN_TILLS_BLOCK = "חובה לסגור את כל הקופות"
SHOP_Z_OPEN_TILLS_CONFIRM = "מותר באישור העובד"


@dataclass(frozen=True)
class BuiltinParameter:
    key: str
    label: str
    value_type: str
    description: str
    default_value: Any
    enum_options: Optional[Tuple[str, ...]] = None


#: Parameters the cloud itself reads or the dashboard edits specially. Created once if
#: missing (`ensure_builtin_parameters`) and never overwritten afterwards: a super admin
#: may re-word or re-default them.
BUILTIN_PARAMETERS: Tuple[BuiltinParameter, ...] = (
    BuiltinParameter(
        key=SHOP_Z_OPEN_TILLS_KEY,
        label="Z סניפי — קופות עם משמרת פתוחה",
        value_type="enum",
        enum_options=(SHOP_Z_OPEN_TILLS_BLOCK, SHOP_Z_OPEN_TILLS_CONFIRM),
        default_value=SHOP_Z_OPEN_TILLS_CONFIRM,
        description=(
            "כשמפיקים Z סניפי וקופות של הסניף נשארות מחוץ לו עם משמרת פתוחה "
            "(או עם משמרות סגורות שלא נכללות בו). "
            f"«{SHOP_Z_OPEN_TILLS_BLOCK}» — ה-Z נדחה עד שכל הקופות נסגרות או נכללות בו. "
            f"«{SHOP_Z_OPEN_TILLS_CONFIRM}» — ה-Z מופק רק אחרי שהעובד מאשר את רשימת "
            "הקופות שנשארות בחוץ, והאישור (מי ואילו קופות) נרשם על ה-Z. "
            "חל רק על Z ברמת סניף; Z לפי קופה אינו מושפע."
        ),
    ),
    # Read by the till, not the cloud; built in because the dashboard edits it with an
    # image picker (`IMAGE_PARAMETER_KEYS`). No default: a till with no value at any
    # level keeps printing the branding receipt logo, as before.
    BuiltinParameter(
        key=RECEIPT_LOGO_KEY,
        label="לוגו בקבלה",
        value_type="string",
        default_value=None,
        description=(
            "התמונה שמודפסת בראש כל קבלה (שחור על נייר, ברוחב ראש ההדפסה — 384 נקודות). "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה; הקופה לוקחת את הרמה הספציפית ביותר. "
            "כשאין ערך באף רמה, הקופה מדפיסה את לוגו הקבלה שבמיתוג."
        ),
    ),
    BuiltinParameter(
        key=PAYMENT_IMAGE_KEY,
        label="תמונה במסך הסליקה",
        value_type="string",
        default_value=None,
        description=(
            "התמונה שמוצגת בקופה בזמן תשלום באשראי (ובביטול — מעומעמת עם X אדום). "
            "המפיץ יכול להעלות תמונה של המסוף שלו. מומלץ PNG עם רקע שקוף. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה; כשאין ערך — התמונה המובנית בקופה."
        ),
    ),
    BuiltinParameter(
        key="shopZMasterTill",
        label="קופה ראשית ל-Z סניפי",
        value_type="boolean",
        default_value=False,
        description=(
            "בקופה שמסומנת (בדרך כלל ברמת קופה) מופיע בדוחות \"סגירת Z סניפי\": כל קופות הסניף "
            "ומצבן, סגירת כולן בפקודה אחת והפקת Z סניפי. קופה שלא נסגרה — העובד מקליד \"סגור\" "
            "והמשמרת שלה עוברת ל-Z הבא (לפי הכלל \"Z סניפי — קופות עם משמרת פתוחה\")."
        ),
    ),
    # The main till ("קופה ראשית") — app/services/main_till.py reads both.
    BuiltinParameter(
        key="mainTill",
        label="קופה ראשית (שרת הסניף)",
        value_type="boolean",
        default_value=False,
        description=(
            "מסמנים קופה אחת בסניף (ברמת קופה; או בכרטיס \"תצורת עבודה — קופה ראשית\" בדף הסניף). "
            "שאר הקופות נשענות עליה: היא שרת השולחנות במצב «רשת מקומית (קופה ראשית)» — כל השולחנות, "
            "המספור וההזמנות יוצאים ממנה; היא שרת ההדפסות (בונים); והיא מפיקה את ה-Z הסניפי — Z אחד "
            "לכל הסניף, עם פירוט לכל קופה ולכל מלצר. מי שיכול להפיק את ה-Z — בפרמטר \"Z סניפי — מאיפה מפיקים\". "
            "קופה שסומנה במפורש כ\"קופה ראשית לשולחנות\" או כ\"שרת הדפסות\" גוברת עליה בתפקיד הזה."
        ),
    ),
    BuiltinParameter(
        key="shopZFrom",
        label="Z סניפי — מאיפה מפיקים",
        value_type="enum",
        enum_options=("הקופה הראשית בלבד", "הקופה הראשית והדשבורד", "כל קופה בסניף והדשבורד"),
        default_value="הקופה הראשית בלבד",
        description=(
            "כשיש בסניף קופה ראשית: «הקופה הראשית בלבד» — ה-Z הסניפי מופק רק ממנה (לא מהדשבורד ולא "
            "מקופה אחרת). «הקופה הראשית והדשבורד» — גם מאשף ה-Z בדשבורד. «כל קופה בסניף והדשבורד» — "
            "מכל קופה ומהדשבורד. בסניף בלי קופה ראשית: הדשבורד והקופות שמסומנות \"קופה ראשית ל-Z סניפי\" "
            "(ו«כל קופה» — כל קופה). קופה ראשית שהענן לא שומע ממנה (נפלה, כבויה, לא עולה) לא חוסמת: "
            "אז מותר להפיק גם מהדשבורד, או להעביר את השרת לקופה אחרת ממסך השולחנות. "
            "חל על Z סניפי בלבד; Z לכל קופה אינו מושפע."
        ),
    ),
    BuiltinParameter(
        key=SPLASH_MEDIA_KEY,
        label="מסך פתיחה — תמונה או סרטון",
        value_type="string",
        default_value=None,
        description=(
            "מה שמוצג על כל המסך בזמן שהקופה עולה: תמונה, או סרטון קצר (MP4/WebM, עד 25MB) "
            "שמתנגן פעם אחת בלי קול (עד 10 שניות; נגיעה מדלגת). נשמר בקופה ומוצג גם בלי אינטרנט, "
            "מהעלייה שאחרי הסנכרון. בלי ערך — תמונת הפתיחה שבמיתוג."
        ),
    ),
    BuiltinParameter(
        key="screensaverEnabled",
        label="שומר מסך",
        value_type="boolean",
        default_value=False,
        description=(
            "כשהקופה לא בשימוש זמן מה, היא מציגה תמונה או סרטון קצר על כל המסך. "
            "נגיעה במסך מחזירה לעבודה. לא מופעל באמצע תשלום. "
            "אחרי כמה דקות — בפרמטר \"שומר מסך — אחרי כמה דקות\" (ברירת מחדל 5); "
            "התמונה/הסרטון — בפרמטר \"שומר מסך — תמונה או סרטון\"."
        ),
    ),
    BuiltinParameter(
        key="idleLockSeconds",
        label="נעילה בחוסר שימוש — קוד מלצר",
        value_type="integer",
        default_value=0,
        description=(
            "אחרי כמה שניות בלי נגיעה במסך הקופה ננעלת, וכדי להמשיך חובה להקיש קוד מלצר/קופאי "
            "(כל עובד עם קוד — מי שמקיש הוא שממשיך). 0 — כבוי. 10–3600. "
            "לא ננעלת באמצע תשלום. שולחן פתוח נשמר לפני הנעילה; במצב מסונכרן בלי חיבור לענן "
            "הקופה ממתינה לחיבור ולא ננעלת, כדי לא לאבד את מה שלא נשמר."
        ),
    ),
    BuiltinParameter(
        key="screensaverAfterMinutes",
        label="שומר מסך — אחרי כמה דקות",
        value_type="integer",
        default_value=5,
        description="כמה דקות בלי נגיעה במסך עד ששומר המסך מופעל (1–120).",
    ),
    BuiltinParameter(
        key=SCREENSAVER_MEDIA_KEY,
        label="שומר מסך — תמונה או סרטון",
        value_type="string",
        default_value=None,
        description=(
            "תמונה (PNG/JPEG/WebP) או סרטון קצר (MP4/WebM, עד 25MB, מתנגן בלולאה בלי קול). "
            "בלי ערך — מוצג לוגו העסק."
        ),
    ),
    BuiltinParameter(
        key="fastCard",
        label="אשראי מהיר",
        value_type="boolean",
        default_value=True,
        description=(
            "כפתור \"אשראי\" בלחיצה אחת במסך התשלום (תשלום אחד, בלי בחירת תשלומים). "
            "כבוי — הכפתור לא מוצג בקופה. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    BuiltinParameter(
        key="fastCash",
        label="מזומן מהיר",
        value_type="boolean",
        default_value=True,
        description=(
            "כפתור \"מזומן\" בלחיצה אחת במסך התשלום (בדיוק הסכום לתשלום, בלי עודף). "
            "כבוי — הכפתור לא מוצג בקופה. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    BuiltinParameter(
        key="receiptPrinter",
        label="מדפסת חשבוניות",
        value_type="enum",
        enum_options=("מובנית בקופה", "רשת (IP)", "Bluetooth", "USB"),
        default_value="מובנית בקופה",
        description=(
            "לאן הקופה מדפיסה חשבוניות, העתקים, שוברים, דוחות X / Z וחשבונות שולחן. "
            "«מובנית בקופה» — המדפסת של הקופה (ברירת מחדל). "
            "«רשת (IP)» / «Bluetooth» / «USB» — מדפסת חשבוניות חיצונית (ESC/POS), למשל SNBC BTP-880: "
            "את הכתובת קובעים ב\"מדפסת חשבוניות — כתובת\" ואת הדגם ב\"מדפסת חשבוניות — דגם\". "
            "גם קופה בלי מדפסת (MODO) מדפיסה כך. מגדירים בדרך כלל לקופה בודדת."
        ),
    ),
    BuiltinParameter(
        key="receiptPrinterAddress",
        label="מדפסת חשבוניות — כתובת",
        value_type="string",
        default_value=None,
        description=(
            "רשת: כתובת ה-IP של המדפסת, ואם צריך גם פורט (למשל 192.168.1.60 או 192.168.1.60:9100). "
            "Bluetooth: כתובת ה-MAC של המדפסת (קודם מצמדים אותה בהגדרות ה-Bluetooth של הקופה). "
            "USB: ריק — הקופה מזהה את המדפסת לבד (בפעם הראשונה Android שואל אם לאשר: מסמנים \"תמיד\")."
        ),
    ),
    BuiltinParameter(
        key="receiptPrinterModel",
        label="מדפסת חשבוניות — דגם",
        value_type="enum",
        enum_options=("SNBC BTP-880 (80 מ״מ)", "ESC/POS 80 מ״מ", "ESC/POS 58 מ״מ"),
        default_value="SNBC BTP-880 (80 מ״מ)",
        description=(
            "רוחב הנייר והפקודות. SNBC BTP-880 — 80 מ״מ, חיתוך אוטומטי ושקע למגירה. "
            "ESC/POS 58 מ״מ — למדפסות צרות. חל רק על מדפסת חיצונית."
        ),
    ),
    BuiltinParameter(
        key="cashDrawer",
        label="פתיחת מגירה",
        value_type="enum",
        enum_options=("כבוי", "בתשלום מזומן", "בתשלום מזומן + כפתור פתיחה"),
        default_value="כבוי",
        description=(
            "מגירת כסף שמחוברת למדפסת החשבוניות (שקע RJ-11). «בתשלום מזומן» — נפתחת אוטומטית בכל "
            "תשלום שבו עבר מזומן (כולל עודף והחזר כספי). «+ כפתור פתיחה» — בנוסף, \"פתיחת מגירה\" "
            "בתפריט הקופה; כל פתיחה ידנית נרשמת בענן כחריגה \"מגירה נפתחה ללא מכירה\"."
        ),
    ),
    BuiltinParameter(
        key="askBeforePrint",
        label="שאל לפני הדפסה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בסיום תשלום הקופה שואלת \"להדפיס חשבונית?\" — \"הדפס\" או \"בלי הדפסה\" — "
            "ומדפיסה רק אם עונים כן. יציאה מהמסך בלי תשובה = בלי הדפסה. חשבונית שלא הודפסה "
            "נשמרת כרגיל וניתן להדפיס לה העתק מההיסטוריה. ניתן להגדיר לארגון, לחברה, לסניף, "
            "לנקודת מכירה או לקופה בודדת."
        ),
    ),
    BuiltinParameter(
        key="receipt.footer.line1",
        label="שורת תחתית בקבלה 1",
        value_type="string",
        default_value="ראנר מערכות קופות ממוחשבות",
        description="השורה הראשונה בתחתית כל קבלה ודוח מודפס. ריק — השורה לא מודפסת.",
    ),
    BuiltinParameter(
        key="receipt.footer.line2",
        label="שורת תחתית בקבלה 2",
        value_type="string",
        default_value="טלפון: 054-2666669",
        description="השורה השנייה בתחתית כל קבלה ודוח מודפס. ריק — השורה לא מודפסת.",
    ),
    BuiltinParameter(
        key="autoCloseShiftAt",
        label="סגירת משמרת אוטומטית בשעה",
        value_type="string",
        default_value=None,
        description=(
            "שעה בפורמט HH:MM (למשל 23:30). בשעה הזו הקופה סוגרת לבד את המשמרת — רק אם יש משמרת פתוחה, "
            "ולא באמצע עסקה או תשלום (אז מיד אחריהם). המזומן נספר לפי הצפוי במערכת, והסגירה נרשמת כאוטומטית. "
            "ריק — כבוי. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    # Table management ("ניהול שולחנות") — app/services/tables.py reads these keys.
    BuiltinParameter(
        key="tablesMode",
        label="ניהול שולחנות",
        value_type="enum",
        enum_options=("כבוי", "קופה אחת", "מסונכרן בין הקופות", "רשת מקומית (קופה ראשית)"),
        default_value="כבוי",
        description=(
            "«כבוי» — אין שולחנות בקופה. "
            "«קופה אחת» — השולחנות מנוהלים בקופה הזו בלבד ועובדים גם בלי אינטרנט (נשלחים לענן לדוחות). "
            "«מסונכרן בין הקופות» (ענן בלבד) — כל קופות הסניף (או נקודת המכירה) רואות אותם שולחנות, "
            "והענן הוא המקור היחיד: בכל לחיצה על שולחן הקופה מושכת מהענן את ההזמנה העדכנית ונועלת "
            "אותו לשאר הקופות, וכל שמירה נבדקת מול הגרסה בענן. במצב זה חובה חיבור לענן כדי לפתוח או לערוך שולחן. "
            "«רשת מקומית (קופה ראשית)» — כמו מסונכרן, אבל דרך קופה אחת בסניף ברשת המקומית "
            "(«קופה ראשית לשולחנות») — בלי צורך באינטרנט; היא מדווחת לענן כשיש חיבור. "
            "את האזורים והשולחנות מגדירים בדשבורד תחת «ניהול שולחנות»."
        ),
    ),
    BuiltinParameter(
        key="tablesHostTill",
        label="קופה ראשית לשולחנות (רשת מקומית)",
        value_type="boolean",
        default_value=False,
        description=(
            "במצב «רשת מקומית (קופה ראשית)»: מסמנים קופה אחת בסניף (ברמת קופה). השולחנות של כל הסניף "
            "נשמרים בה, ושאר הקופות עובדות מולה ברשת המקומית (Wi-Fi) — גם בלי אינטרנט. הקופה מדווחת "
            "לענן את כתובתה ברשת ואת השולחנות. כמה מסומנות — הנמוכה במספר; אף אחת — שרת ההדפסות של הסניף."
        ),
    ),
    BuiltinParameter(
        key="tablesDefault",
        label="ניהול שולחנות — הקופה נפתחת במסך השולחנות",
        value_type="boolean",
        default_value=False,
        description="כשמופעל, הקופה נפתחת במסך השולחנות (ולא בקטלוג) וחוזרת אליו אחרי תשלום שולחן.",
    ),
    BuiltinParameter(
        key="tablesLockMinutes",
        label="ניהול שולחנות — שחרור נעילה אחרי (דקות)",
        value_type="integer",
        default_value=2,
        description=(
            "במצב מסונכרן: שולחן שנפתח בקופה ננעל לה. אם הקופה לא מגיבה (נפלה, אין רשת) "
            "הנעילה משתחררת לבד אחרי מספר הדקות הזה (1–30). מנהל יכול לשחרר מיד עם קוד מנהל."
        ),
    ),
    BuiltinParameter(
        key="blockCloseWithOpenTables",
        label="חסימת סגירת יום עם שולחנות פתוחים",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל: אי אפשר לסגור משמרת בקופה (ידנית, אוטומטית או מרחוק מהענן) "
            "ואי אפשר להפיק Z כשיש שולחנות פתוחים — יש לשלם או לבטל אותם קודם. "
            "בקופה במצב «קופה אחת» נבדקים השולחנות שלה; במצב מסונכרן — שולחנות הסניף או נקודת המכירה."
        ),
    ),
    BuiltinParameter(
        key="tablesTileScale",
        label="גודל שולחנות במפה",
        value_type="decimal",
        default_value=1.0,
        description=(
            "מכפיל לגודל השולחנות במסך השולחנות בקופה — במפה ובתצוגת הריבועים (0.6–2.0; 1 = הגודל שנקבע בדשבורד). "
            "הטקסט בתוך השולחן גדל ומתכווץ איתו."
        ),
    ),
    BuiltinParameter(
        key="tablesWarnMinutes",
        label="ניהול שולחנות — זמן ישיבה: אזהרה (דקות)",
        value_type="integer",
        default_value=60,
        description="אחרי כמה דקות מפתיחת השולחן זמן הישיבה מוצג בכתום במסך השולחנות.",
    ),
    BuiltinParameter(
        key="tablesAlertMinutes",
        label="ניהול שולחנות — זמן ישיבה: התראה (דקות)",
        value_type="integer",
        default_value=90,
        description="אחרי כמה דקות מפתיחת השולחן זמן הישיבה מוצג באדום במסך השולחנות.",
    ),
    # Kitchen printers ("מדפסות בונים") — app/services/printers.py; also set by the shop's
    # managers from the dashboard's kitchen printers page (shop / area / till).
    BuiltinParameter(
        key="kitchenTicketsOnSale",
        label="בונים במכירה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בכל מכירה שהושלמה (שירות דלפק) יוצאים בונים במדפסות המטבח/בר לפי הניתוב "
            "שהוגדר ב\"מדפסות בונים\". תעודת זיכוי ותשלום של שולחן לא מדפיסים בון."
        ),
    ),
    BuiltinParameter(
        key="kitchenTicketsOnTill",
        label="בונים — עותק גם בקופה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בכל שליחה למדפסות הבונים יוצא עותק נוסף במדפסת הקופה, ובו כל השורות "
            "שיצאו למטבח/לבר."
        ),
    ),
    BuiltinParameter(
        key="printHostTill",
        label="שרת הדפסות (בונים)",
        value_type="boolean",
        default_value=False,
        description=(
            "מסמנים קופה אחת בסניף (ברמת קופה): היא \"שרת ההדפסות\" של הסניף. שאר הקופות שולחות "
            "אליה את הבונים למדפסות הרשת וה-Bluetooth ברשת המקומית (Wi-Fi), והיא מדפיסה אותם "
            "אחד אחרי השני — בלי התנגשויות במדפסת וגם בלי אינטרנט. הקופה מדווחת לענן את כתובתה "
            "ברשת. כשהיא לא זמינה, קופה מדפיסה ישירות אם היא מגיעה למדפסת, ואחרת דרך הענן. "
            "כבוי (ברירת מחדל) — כל קופה מדפיסה ישירות."
        ),
    ),
    # The menu layer ("תוספות ושינויים", docs/SPEC_MENU_MODIFIERS.md) — read by the till.
    BuiltinParameter(
        key="upsellEnabled",
        label="הגדלות מכירה בקופה",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל: אחרי הוספת מנה שיש לה \"הגדלת מכירה\" (למשל צ'יפס ליד המבורגר, או \"להפוך לארוחה?\") "
            "מופיע בקופה כרטיס הצעה קטן שלא עוצר את העבודה — נגיעה אחת מוסיפה, ✕ סוגר. "
            "את ההצעות מגדירים בדשבורד תחת \"הגדלות מכירה\". כבוי — לא מוצגות הצעות."
        ),
    ),
    BuiltinParameter(
        key="tableSeats",
        label="סועדים בשולחן",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בהזמנת שולחן מופיע פס \"סועד פעיל\" (כללי, 1, 2…), וכל מנה שנוספת משויכת לסועד — "
            "כך שלא צריך לחפש של מי המנה. השיוך רשות, מודפס בבון ומכין פיצול חשבון לפי סועד."
        ),
    ),
    BuiltinParameter(
        key="receiptShowUnredeemed",
        label="קבלה — פריטים שלא מומשו בארוחה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בקבלה, מתחת לארוחה, מודפס מה שהיה כלול בה ולא נלקח (למשל \"לא מומש: שתייה ×1\"). "
            "אין זיכוי על פריטים שלא מומשו."
        ),
    ),
    BuiltinParameter(
        key="coursesEnabled",
        label="מנות (ראשונות / עיקריות) בשולחן",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: כל מנה בשולחן משויכת לשלב (ראשונות, עיקריות, קינוחים…). \"שלח\" שולח למטבח רק "
            "את השלבים שהוצאו; השאר מסומנים \"בהמתנה\" עד \"הוצא\". בדלפק — הכול יוצא מיד. "
            "את השלבים מגדירים בדשבורד תחת \"תוספות ושינויים\"."
        ),
    ),
)


def ensure_builtin_parameters(db: Session) -> List[str]:
    """
    Create the built-in parameters that do not exist yet; the keys created. Idempotent,
    and leaves an existing definition exactly as a super admin last saved it. The caller
    commits.
    """
    # Keys are unique in any case (`_refuse_taken_key` in the router).
    existing = {row[0].lower() for row in db.query(TillParameter.key).all()}
    created: List[str] = []
    for spec in BUILTIN_PARAMETERS:
        if spec.key.lower() in existing:
            continue
        options = clean_enum_options(spec.value_type, list(spec.enum_options or ()))
        db.add(
            TillParameter(
                id=uuid.uuid4(),
                key=validate_key(spec.key),
                label=spec.label,
                description=spec.description,
                value_type=validate_value_type(spec.value_type),
                enum_options=options,
                default_value=(
                    None
                    if spec.default_value is None
                    else validate_value(spec.value_type, spec.default_value, options)
                ),
                is_active=True,
            )
        )
        created.append(spec.key)
    if created:
        db.flush()
    return created


# ── Scope entities ───────────────────────────────────────────────────────────

_SCOPE_MODELS = {
    "company": Company,
    "shop": Shop,
    "area": ShopArea,
    "machine": POSMachine,
}


def scope_entity(db: Session, scope_type: str, scope_id: Any):
    """The company, shop, area or till a value is set on, or None."""
    model = _SCOPE_MODELS[scope_type]
    return db.query(model).filter(model.id == scope_id).first()


@dataclass
class ScopeLabel:
    name: Optional[str]
    #: Where the entity sits, for telling two "Bar" areas apart: the shop of an area or
    #: a till, the company of a shop.
    context: Optional[str] = None


def scope_labels(db: Session, values: Sequence[TillParameterValue]) -> Dict[Tuple[str, uuid.UUID], ScopeLabel]:
    """Display names for the scopes of `values`, one query per level. Missing = gone."""
    wanted: Dict[str, set] = {}
    for v in values:
        wanted.setdefault(v.scope_type, set()).add(as_uuid(v.scope_id))

    labels: Dict[Tuple[str, uuid.UUID], ScopeLabel] = {}
    shop_ids_to_name: set = set()
    company_ids_to_name: set = set()
    rows_by_scope: Dict[str, list] = {}
    for scope_type, ids in wanted.items():
        model = _SCOPE_MODELS.get(scope_type)
        if model is None:
            continue
        rows = db.query(model).filter(model.id.in_(list(ids))).all()
        rows_by_scope[scope_type] = rows
        for row in rows:
            if scope_type in ("area", "machine") and row.shop_id is not None:
                shop_ids_to_name.add(row.shop_id)
            if scope_type == "shop" and row.company_id is not None:
                company_ids_to_name.add(row.company_id)

    shop_names = (
        {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids_to_name))).all()}
        if shop_ids_to_name
        else {}
    )
    company_names = (
        {c.id: c.name for c in db.query(Company).filter(Company.id.in_(list(company_ids_to_name))).all()}
        if company_ids_to_name
        else {}
    )

    for scope_type, rows in rows_by_scope.items():
        for row in rows:
            if scope_type in ("area", "machine"):
                context = shop_names.get(row.shop_id)
            elif scope_type == "shop":
                context = company_names.get(row.company_id)
            else:
                context = None
            name = row.name
            # A till by its number first ("קופה מס׳ 3 · בר"): its name alone repeats
            # from shop to shop.
            pos_number = getattr(row, "pos_number", None) if scope_type == "machine" else None
            if pos_number:
                name = f"קופה מס׳ {pos_number} · {row.name}"
            labels[(scope_type, as_uuid(row.id))] = ScopeLabel(name=name, context=context)
    return labels


# ── Notify ───────────────────────────────────────────────────────────────────

NotifyTarget = Tuple[str, str]


def _targets(machines: Iterable[POSMachine]) -> List[NotifyTarget]:
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id]


def notify_targets_for_all(db: Session) -> List[NotifyTarget]:
    """Every active till — a definition is global, so it can change what any till gets."""
    return _targets(db.query(POSMachine).filter(POSMachine.is_active.is_(True)).all())


def notify_targets_for_scope(db: Session, scope_type: str, scope_id: Any) -> List[NotifyTarget]:
    """The active tills a value at this level applies to (whether or not it wins there)."""
    query = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if scope_type == "machine":
        query = query.filter(POSMachine.id == scope_id)
    elif scope_type == "area":
        query = query.filter(POSMachine.area_id == scope_id)
    elif scope_type == "shop":
        query = query.filter(POSMachine.shop_id == scope_id)
    elif scope_type == "company":
        shop_ids = [row[0] for row in db.query(Shop.id).filter(Shop.company_id == scope_id).all()]
        if not shop_ids:
            return []
        query = query.filter(POSMachine.shop_id.in_(shop_ids))
    else:
        return []
    return _targets(query.all())


def publish_parameters_notify(targets: Iterable[NotifyTarget]) -> None:
    """One Ably `settings` notify per till; it then pulls `/sync/{id}/parameters`."""
    for tenant_id, machine_id in targets:
        publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
