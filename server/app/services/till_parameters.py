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


#: "מדפסת חשבוניות" = "אוטומטי" (the default): a USB receipt printer plugged into a regular till and
#: approved prints the receipts by itself, else as "מובנית בקופה" (pos-android domain/UsbPrinterAuto.kt
#: `tillReceiptOnUsb`, docs/SPEC_KIOSK.md §14.7). Migration e9a3c7f1b5d2 adds it to existing databases.
RECEIPT_PRINTER_AUTO = "אוטומטי"

# ── Image parameters ─────────────────────────────────────────────────────────

#: The receipt logo, printed at the head of every receipt. Supersedes the branding
#: setting `brandReceiptLogoUrl`: the till prefers this when it has a value.
RECEIPT_LOGO_KEY = "receiptLogoUrl"

#: Edited on the dashboard's printers page ("מדפסות"), by shop → point of sale → till,
#: not on the till parameters page (`app/services/printers.py` `SETTING_KEYS`, and the
#: print server till of its own card).
PRINTERS_PAGE_KEYS = (
    "receiptPrinter",
    "receiptPrinterAddress",
    "receiptPrinterModel",
    "cashDrawer",
    "askBeforePrint",
    "kitchenTicketsOnSale",
    "kitchenTicketsOnTill",
    "printHostTill",
    "printerFailoverPrompt",
)


def managed_on(key: str) -> Optional[str]:
    """The dashboard tab that edits this parameter instead of the parameters page."""
    if key in PRINTERS_PAGE_KEYS:
        return "printers"
    # "תצורת עבודה לעמדה" (app/services/kds_workflow.py): the dashboard's workflow card.
    return "workflow" if key in _WORKFLOW_KEYS else None

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
    resolved = resolve_till_parameters(parameters, values, chain)
    if getattr(machine, "independent_till", False):
        # "קופה עצמאית" (app/services/independent_till.py): never a host of the shop's LAN
        # group, and tables only when set at its own level.
        from app.services.independent_till import apply_to_resolved

        resolved = apply_to_resolved(machine, parameters, values, resolved)
    else:
        # "לא משמש כשרת מקומי" (app/services/lan_server.py): never a host of the shop's LAN
        # group either — but still in it, so its tables mode stays as the shop set it.
        from app.services.lan_server import excluded_parameters, is_excluded

        if is_excluded(db, machine):
            resolved.parameters = excluded_parameters(resolved.parameters)
    # "קוד טכנאי לקיוסק" (app/services/kiosk_technician.py): never sent in clear — the till
    # gets the code's hash, salted with its own id.
    from app.services.kiosk_technician import hash_for_machine

    hash_for_machine(machine, resolved.parameters)
    # "חסימת Z כשיש משמרות פתוחות" ships with remote control's shop close (REMOTE_TILL_Z_ENABLED):
    # until then the till reads it as off, whatever is set — its local shop Z exactly as today.
    from app.services import z_shift_guard

    if z_shift_guard.KEY in resolved.parameters and not z_shift_guard.flag_on():
        resolved.parameters[z_shift_guard.KEY] = False
    return resolved


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

#: "סגירת Z ללא חיבור לענן" — read by the till, only in `zMode = till`
#: (docs/SPEC_OFFLINE_TILL_Z.md).
TILL_Z_OFFLINE_KEY = "tillZOffline"

#: "טיפ במסופון": the card terminal asks for the tip, the till records it
#: (docs/SPEC_TERMINAL_TIP.md). Read by the till only.
TERMINAL_TIP_PROMPT_KEY = "terminalTipPrompt"

#: "סגנון מפת שולחנות": how the till draws its tables' floor map. Read by the till only
#: (pos-android domain/Tables.kt `TablesMapStyle`, which reads these exact options; anything
#: else is the classic look there).
TABLES_MAP_STYLE_KEY = "tablesMapStyle"
TABLES_MAP_STYLE_CLASSIC = "קלאסי — עץ וזהב"
TABLES_MAP_STYLE_MODERN = "מודרני — נקי"
TABLES_MAP_STYLE_OPTIONS = (TABLES_MAP_STYLE_CLASSIC, TABLES_MAP_STYLE_MODERN)

#: "הצג כסאות": the chairs round each table on the till's floor map, in both looks — as
#: many as the table seats (pos-android domain/Tables.kt `TablesConfig.showChairs`; the
#: till's own "כסאות" toggle on the tables screen overrides it on that device).
TABLES_SHOW_CHAIRS_KEY = "tablesShowChairs"

#: "גודל שם שולחן": how large each table's name / number is written on the map (the till
#: reads these exact words — domain/TablePolicy.kt `TableLabelSize`; anything else is normal).
TABLES_LABEL_SIZE_KEY = "tablesLabelSize"
TABLES_LABEL_SIZES = ("קטן", "רגיל", "גדול")

#: "גודל ריבוע מוצר": the sizes, smallest first, and "as the size it falls back to".
TILE_SIZES = ("קטן מאוד", "קטן", "בינוני", "גדול")
TILE_SIZE_INHERIT = "ברירת מחדל"

#: "מסופון ברשת ללא הצפנה (HTTP)": plain HTTP to a pinpad on a private network. Read by
#: the till only (hardware/payment/net on Android).
PINPAD_ALLOW_HTTP_KEY = "pinpadAllowHttp"

#: "הזמנה מהירה — מתי לשאול": a new order starts with its details — "לקחת או לשבת?", then
#: the name — before the first item; the default (ui/sell/MenuSheetState.kt; alembic e4f6a8b0c2d4).
ORDER_DETAILS_DINING_FIRST = "בתחילת הזמנה (לשבת/לקחת ואז שם)"

#: "כפתור תשלום מהיר 1 / 2": the two quick-pay buttons under the total of the tablet's quick
#: order, in their order — the first at the start of the row (the right, in Hebrew). Read by
#: the till only (pos-android domain/QuickCash.kt, quickPayButtons). Two enums rather than one
#: ordered list: the parameter types have no ordered multi-choice.
QUICK_PAY_BUTTON_1_KEY = "quickPayButton1"
QUICK_PAY_BUTTON_2_KEY = "quickPayButton2"
QUICK_PAY_FAST_CARD = "אשראי מהיר"
QUICK_PAY_CASH_WITH_CHANGE = "מזומן עם עודף"
QUICK_PAY_FAST_CASH = "מזומן מהיר"
QUICK_PAY_CHOICES = (QUICK_PAY_FAST_CARD, QUICK_PAY_CASH_WITH_CHANGE, QUICK_PAY_FAST_CASH)

#: "התקבל מזומן" (the cash box on the tablet's order panel) is gone; its switch with it.
#: Not a built-in any more — alembic 3f8b6d2a9c41 retires an existing definition.
RETIRED_CASH_CHANGE_IN_PANEL_KEY = "cashChangeInPanel"


def _quick_pay_description(which: str) -> str:
    return (
        f"{which} "
        "בהזמנה המהירה בטאבלט, מתחת לסה״כ, שני כפתורי תשלום מהיר זה לצד זה — כפתור 1 מימין, כפתור 2 "
        "משמאלו — ומתחתיהם \"תשלום\": מסך התשלום עם כל אמצעי התשלום ופיצול. "
        f"«{QUICK_PAY_FAST_CARD}» — חיוב האשראי מיד במסופון (תשלום אחד). "
        f"«{QUICK_PAY_CASH_WITH_CHANGE}» — מסך המזומן: הסכום שהתקבל והעודף. "
        f"«{QUICK_PAY_FAST_CASH}» — בדיוק הסכום לתשלום, והעסקה נסגרת מיד. "
        "כפתור שאמצעי התשלום שלו לא מותר בקופה (באמצעי התשלום, או בפרמטרים \"אשראי מהיר\" / "
        "\"מזומן מהיר\") לא מוצג, והכפתור השני תופס את כל הרוחב. אותה בחירה בשני הכפתורים — "
        "הכפתור השני מתחלף באפשרות הראשונה שלא נבחרה (לפי הסדר: "
        f"{QUICK_PAY_FAST_CARD}, {QUICK_PAY_CASH_WITH_CHANGE}, {QUICK_PAY_FAST_CASH}). "
        "לא משפיע על קופה ניידת. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
    )


@dataclass(frozen=True)
class BuiltinParameter:
    key: str
    label: str
    value_type: str
    description: str
    default_value: Any
    enum_options: Optional[Tuple[str, ...]] = None
    #: Changed by a super admin or a distributor only, whatever route writes it
    #: (`kioskTillModeEnabled` — app/services/kiosk_till_mode.py ADMIN_ONLY_KEYS).
    admin_only: bool = False


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
            "חל רק על Z ברמת סניף; Z לפי קופה אינו מושפע. "
            f"בסניף שעובד ברשת מקומית (קופה ראשית) — תמיד «{SHOP_Z_OPEN_TILLS_BLOCK}»: הקופה הראשית סוגרת "
            "את כל הקופות ברשת, ואף קופה לא נשארת בחוץ (קופה עצמאית אינה חלק מה-Z הסניפי בכלל)."
        ),
    ),
    # Read by the till (docs/SPEC_OFFLINE_TILL_Z.md); honoured only in `zMode = till`.
    BuiltinParameter(
        key=TILL_Z_OFFLINE_KEY,
        label="סגירת Z ללא חיבור לענן (Z לכל קופה)",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, קופה שעובדת במצב \"Z לכל קופה\" יכולה לסגור Z גם בלי חיבור לענן: ה-Z נבנה "
            "וממוספר בקופה, מודפס עם הסימון \"ממתין לסנכרון לענן\", ועולה לענן אוטומטית כשהחיבור "
            "חוזר. בענן הוא נבדק מול המסמכים, ופער נרשם כחריגה. שידור האשראי מתבצע לפני הסגירה "
            "(דרך המסוף, לא דרך הענן). חל רק במצב \"Z לכל קופה\" — ב-Z סניפי וב-Z לפי נקודת "
            "מכירה הפרמטר לא משפיע."
        ),
    ),
    # "דו״ח Z — גרסה 2" (app/services/z_sections.py): read by the cloud when it builds a Z and
    # by the till for its X and an offline Z; presentation only.
    BuiltinParameter(
        key="zShowPerEmployee",
        label="Z ו-X — פירוט לפי עובד",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, דו״ח ה-Z (ודו״ח ה-X בקופה) מציג גם סעיף \"לפי עובד\": לכל מלצר / קופאי — מכירות "
            "באשראי, מכירות במזומן (ואמצעי תשלום אחרים כשיש), טיפ באשראי, טיפ במזומן והסיכומים. מסמך של "
            "שולחן שייך למלצר של השולחן, כל מסמך אחר לקופאי שהפיק אותו. הסכומים לכל העובדים מתאימים "
            "לסה״כ התשלומים והטיפים בדו״ח. תצוגה בלבד — הנתונים הפיסקליים לא משתנים. ב-Z סניפי הסעיף "
            "מוצג כשהפרמטר מופעל באחת הקופות הכלולות. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
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
    # Read by the till only (pos-android system/KioskLock.kt, docs/KIOSK.md): Android's lock
    # task mode while on. The cloud stays the authority — off releases the lock at the
    # till's next sync, whatever a manager did there.
    BuiltinParameter(
        key="kioskMode",
        label="נעילת קופה (מצב קיוסק)",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, הקופה ננעלת בתוך האפליקציה: אי אפשר לצאת ממנה למסך הבית של Android, "
            "לאפליקציות אחרות, לשורת ההתראות או להגדרות המכשיר, ו\"חזור\" במסך הראשי לא סוגר אותה. "
            "במכשיר רגיל Android מבקש פעם אחת לאשר \"הצמדת אפליקציה\", ואת ההצמדה אפשר לבטל "
            "במחווה של המערכת. נעילה מלאה ושקטה — בלי שאלה ובלי דרך יציאה, והקופה כמסך הבית — "
            "דורשת הגדרה חד-פעמית של המכשיר: הגדרת הקופה כבעלת המכשיר (Device Owner) על ידי "
            "טכנאי, או הוספת הקופה לרשימת הקיוסק בניהול המכשירים של הספק (Kozen / Nayax). "
            "יציאה לתחזוקה: בתפריט הקופה \"יציאה מנעילת קופה\", באישור מנהל (קוד מנהל שנבדק בקופה, "
            "עובד גם בלי אינטרנט) — עד ההפעלה הבאה של הקופה או עד \"נעילת הקופה מחדש\". "
            "כיבוי הפרמטר משחרר את הנעילה בסנכרון הבא. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
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
    # The tablet quick order's two quick-pay buttons (read by the till only).
    BuiltinParameter(
        key=QUICK_PAY_BUTTON_1_KEY,
        label="כפתור תשלום מהיר 1 (הזמנה מהירה בטאבלט)",
        value_type="enum",
        enum_options=QUICK_PAY_CHOICES,
        default_value=QUICK_PAY_FAST_CARD,
        description=_quick_pay_description("הכפתור הראשון (מימין)."),
    ),
    BuiltinParameter(
        key=QUICK_PAY_BUTTON_2_KEY,
        label="כפתור תשלום מהיר 2 (הזמנה מהירה בטאבלט)",
        value_type="enum",
        enum_options=QUICK_PAY_CHOICES,
        default_value=QUICK_PAY_CASH_WITH_CHANGE,
        description=_quick_pay_description("הכפתור השני (משמאל)."),
    ),
    BuiltinParameter(
        key="receiptPrinter",
        label="מדפסת חשבוניות",
        value_type="enum",
        enum_options=(RECEIPT_PRINTER_AUTO, "מובנית בקופה", "רשת (IP)", "Bluetooth", "USB"),
        default_value=RECEIPT_PRINTER_AUTO,
        description=(
            "לאן הקופה מדפיסה חשבוניות, העתקים, שוברים, דוחות X / Z וחשבונות שולחן. "
            "«אוטומטי» (ברירת מחדל) — מדפסת USB שמחוברת לקופה ומאושרת מדפיסה את הקבלות לבד; "
            "בלעדיה — המדפסת של הקופה, ובקופה בלי מדפסת — מדפסת החשבוניות של הסניף "
            "(docs/SPEC_KIOSK.md §14.7; קיוסק — כמו קודם). "
            "«מובנית בקופה» — תמיד המדפסת של הקופה, גם כשמחוברת מדפסת USB. "
            "«רשת (IP)» / «Bluetooth» / «USB» — מדפסת חשבוניות חיצונית (ESC/POS), למשל SNBC BTP-880: "
            "את הכתובת קובעים ב\"מדפסת חשבוניות — כתובת\" ואת הדגם ב\"מדפסת חשבוניות — דגם\". "
            "גם קופה בלי מדפסת (MODO) מדפיסה כך. מגדירים בדרך כלל לקופה בודדת. "
            "מדפסות חשבוניות משותפות (למשל בדלפק, עם מגירה) מגדירים בדשבורד בדף \"מדפסות\" — שם אפשר גם "
            "לחבר מגירה ולקבוע לאילו קופות; בהדפסת חשבון הקופה שואלת לאן להדפיס."
            " לכל מדפסת שם (חובה) — והקופה מציגה אותו: כשיש לקופה יותר ממדפסת חשבוניות אחת (כולל "
            "המדפסת שלה), היא שואלת \"באיזו מדפסת להדפיס?\" במסמכים ובדוחות, וזוכרת את הבחירה "
            "(\"זכור לקופה הזו\"; משנים במסך \"מדפסות\" בקופה)."
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
        key="tipAutoPrompt",
        label="שאלת טיפ אוטומטית במעבר לתשלום",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): בבחירת אמצעי תשלום שמבקש טיפ (\"בקשת טיפ באמצעי התשלום\" בהגדרות), "
            "הקופה פותחת ללקוח את מסך הטיפ לבד. כבוי: מסך הטיפ לא נפתח אוטומטית — טיפ מוסיפים רק "
            "בכפתור \"טיפ\" במסך התשלום (שמופיע כל עוד אמצעי תשלום כלשהו מקבל טיפ)."
        ),
    ),
    # Read by the till (docs/SPEC_TERMINAL_TIP.md): the card terminal asks for the tip.
    BuiltinParameter(
        key=TERMINAL_TIP_PROMPT_KEY,
        label="טיפ במסופון (Agamento שואל את הלקוח)",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בתשלום באשראי המסופון (Agamento — המובנה ב-Nova 55F או מסופון Nayax ברשת) "
            "שואל את הלקוח על הטיפ, והקופה רק רושמת את הטיפ שהמסופון גבה בפועל — כטיפ באשראי של "
            "המלצר/הקופאי, ב-Z, בדוחות ובטיפים לעובד. שאלת הטיפ של הקופה (מסך הטיפ, הטיפ מראש "
            "בכפתור \"טיפ\") לא מוצגת בתשלום באשראי; במזומן היא נשארת כמו שהיא. "
            "חובה להפעיל את שאלת הטיפ גם בצד המסופון (הגדרות Nayax / המסופון) — אחרת המסופון לא "
            "ישאל והעסקה תירשם בלי טיפ. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    # Read by the till (hardware/payment/net): plain HTTP to a pinpad on the LAN.
    BuiltinParameter(
        key=PINPAD_ALLOW_HTTP_KEY,
        label="מסופון ברשת ללא הצפנה (HTTP)",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: קופה שסולקת במסופון Nayax ברשת (Agamento, SPICy) רשאית לדבר איתו ב-HTTP "
            "ללא הצפנה — רק כשכתובת המסופון ברשת פרטית (192.168.x.x, 10.x.x.x או 172.16–31.x.x). "
            "HTTPS נשאר המועדף: הקופה מנסה קודם HTTPS ועוברת ל-HTTP רק כשהמסופון לא עונה ב-TLS "
            "(או מיד, כשהכתובת נכתבה עם http://). כך עובדת גם הקופה השולחנית. כבוי (ברירת מחדל): "
            "HTTPS בלבד. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    BuiltinParameter(
        key="screenEditEnabled",
        label="עריכת מסך בקופה",
        value_type="boolean",
        default_value=True,
        description=(
            "\"עריכת מסך\" נפתחת מתפריט הקופה (ניהול ← עריכת מסך): סידור הפריטים והמחלקות בגרירה, "
            "הפיכת פריט ללא פעיל ותמונת פריט — מנהל או באישור מנהל; השמירה כמו קודם. כבוי — הכניסה "
            "לא מוצגת בתפריט. הלחיצה הארוכה על פריט נשארת לנעילת מוצר בלבד (7 שניות, אם הוגדרה)."
        ),
    ),
    BuiltinParameter(
        key="productPhotoFromTill",
        label="תמונת מוצר מהקופה",
        value_type="boolean",
        default_value=True,
        description=(
            "בעריכת המסך בקופה: צילום תמונה למוצר או בחירה מהגלריה, עם הסרת רקע כמו בענן. "
            "ההעלאה צורכת נתונים. כבוי — לא מוצג כפתור המצלמה."
        ),
    ),
    BuiltinParameter(
        key="productOrderScope",
        label="סידור פריטים בקופה — היקף",
        value_type="enum",
        enum_options=("סניף", "נקודת מכירה", "קופה", "לשאול בקופה"),
        default_value="סניף",
        description=(
            "לחיצה ארוכה על פריט בקופה פותחת \"עריכת מסך\" (מנהל או אישור מנהל): הפריטים רוטטים, גוררים "
            "אותם למקומם, ו-X הופך פריט ללא פעיל. כשלוחצים \"סיום\" הסדר נשמר: לכל הסניף, לנקודת המכירה "
            "של הקופה, לקופה עצמה — או שהקופה שואלת בכל פעם."
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
            "בתפריט הקופה; כל פתיחה ידנית נרשמת בענן כחריגה \"מגירה נפתחה ללא מכירה\". "
            "חל על מדפסת החשבוניות שבפרמטר; מגירה של מדפסת חשבוניות מדף \"מדפסות\" נפתחת תמיד בתשלום מזומן "
            "ויש לה כפתור — וכשיש לקופה כמה מגירות, היא שואלת איזו לפתוח."
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
    # "סגנון מפת שולחנות" — read by the till only (pos-android domain/Tables.kt, TablesMapStyle).
    BuiltinParameter(
        key=TABLES_MAP_STYLE_KEY,
        label="סגנון מפת שולחנות",
        value_type="enum",
        enum_options=TABLES_MAP_STYLE_OPTIONS,
        default_value=TABLES_MAP_STYLE_CLASSIC,
        description=(
            "איך מסך השולחנות בקופה נראה. «קלאסי — עץ וזהב» (ברירת המחדל): רצפת פרקט עץ, שולחנות "
            "עם צל וכיסאות עץ, מצב השולחן בטבעת צבעונית ובתווית מתחת לשולחן, והילה זהובה סביב "
            "שולחן שנבחר. «מודרני — נקי»: רצפה נקייה (אפורה עם רשת עדינה, כהה במצב לילה), שולחנות "
            "חדים עם קו דק וכיסאות בהירים, והמצב בגוון עדין ובמילה בתוך השולחן. רק המראה משתנה — "
            "כל הפעולות במסך זהות. רקע שנבחר לאזור (עץ, אריחים, נקי, בהיר, כהה או תמונה) נשמר בשני הסגנונות. "
            "ניתן לקבוע לחברה, לסניף, לנקודת מכירה או לקופה בודדת."
        ),
    ),
    # "הצג כסאות" — read by the till only (pos-android domain/Tables.kt, TablesConfig.showChairs).
    BuiltinParameter(
        key=TABLES_SHOW_CHAIRS_KEY,
        label="הצג כסאות",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל): במפת השולחנות בקופה מצוירים כסאות סביב כל שולחן — כמספר "
            "המקומות שהוגדר לשולחן (\"כסאות\" בעורך השולחנות) — בשני סגנונות המפה. כשכבוי: "
            "השולחנות בלי כסאות. בקופה אפשר להחליף זמנית מ\"תצוגה\" במסך השולחנות (הקופה זוכרת). "
            "ניתן לקבוע לחברה, לסניף, לנקודת מכירה או לקופה בודדת."
        ),
    ),
    # "גודל שם שולחן" — read by the till only (pos-android domain/TablePolicy.kt, TableLabelSize).
    BuiltinParameter(
        key=TABLES_LABEL_SIZE_KEY,
        label="גודל שם שולחן במפה",
        value_type="enum",
        enum_options=TABLES_LABEL_SIZES,
        default_value="רגיל",
        description=(
            "כמה גדול נכתב שם השולחן (או מספרו, כשאין לו שם) על השולחן במסך השולחנות בקופה. "
            "שם ארוך נחתך בשלוש נקודות."
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
        key="tablesCleaning",
        label="ניהול שולחנות — סימון \"לניקוי\" אחרי תשלום",
        value_type="boolean",
        default_value=True,
        description="שולחן ששולם מסומן במסך השולחנות \"לניקוי\" עד שמסמנים \"נוקה\" (לחיצה ארוכה) או פותחים עליו הזמנה חדשה.",
    ),
    BuiltinParameter(
        key="tablesAlertMinutes",
        label="ניהול שולחנות — זמן ישיבה: התראה (דקות)",
        value_type="integer",
        default_value=90,
        description="אחרי כמה דקות מפתיחת השולחן זמן הישיבה מוצג באדום במסך השולחנות.",
    ),
    # "סקירת שינויים לפני שידור לקופות" — app/services/menu_broadcast.py reads it per shop
    # (its own value, else its company's). The till ignores it.
    BuiltinParameter(
        key="menuBroadcastReview",
        label="סקירת שינויים לפני שידור לקופות",
        value_type="enum",
        enum_options=("אוטומטי (לפי שולחנות)", "תמיד", "אף פעם"),
        default_value="אוטומטי (לפי שולחנות)",
        description=(
            "«אוטומטי (לפי שולחנות)» — בסניף שמודול השולחנות פעיל בו (ניהול שולחנות לא «כבוי» "
            "באחת מקופותיו), שינויי תפריט בדשבורד נשמרים כטיוטה ומגיעים לקופות רק אחרי "
            "«שדר לקופות» וסקירה ואישור; בסניף בלי שולחנות — השינויים מגיעים לקופות מיד, כמו היום. "
            "«תמיד» — סקירה גם בלי שולחנות. «אף פעם» — בלי סקירה גם עם שולחנות. "
            "נקבע לסניף או לחברה (ערכים ברמת נקודת מכירה או קופה לא נחשבים). "
            "זמינות/אזל מהקופה, סדר כפתורים ותמונות מהקופה מגיעים תמיד מיד."
        ),
    ),
    BuiltinParameter(
        key="tablesAskGuests",
        label="שאלת מספר סועדים בפתיחת שולחן",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל) — פתיחת שולחן פנוי שואלת כמה סועדים יושבים בו. כשכבוי — הקופה "
            "נכנסת ישר להזמנה בלי לשאול; מספר הסועדים נשאר ריק, ואפשר לקבוע אותו אחר כך מסרגל "
            "השולחן (\"סועדים\")."
        ),
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
    # A quick order's details ("פרטי הזמנה"): take-away or eat-in, the customer's name —
    # asked on the way to payment or when the order is opened, printed on the kitchen ticket.
    BuiltinParameter(
        key="askEatInTakeAway",
        label="הזמנה מהירה — לקחת / לשבת",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בהזמנה מהירה (מכירה רגילה, לא שולחן) הקופה שואלת \"לקחת או לשבת?\" — חובה — "
            "והתשובה מודפסת בבולט בראש הבון למטבח/לבר. מתי שואלים — בפרמטר \"הזמנה מהירה — מתי לשאול\". "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    BuiltinParameter(
        key="askOrderName",
        label="הזמנה מהירה — שם לקוח",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: בהזמנה מהירה (מכירה רגילה, לא שולחן) הקופה מבקשת שם לקוח להזמנה — חובה — "
            "והשם מודפס בגדול בראש הבון למטבח/לבר, כדי לקרוא ללקוח כשההזמנה מוכנה. מתי שואלים — "
            "בפרמטר \"הזמנה מהירה — מתי לשאול\". ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    BuiltinParameter(
        key="orderDetailsAt",
        label="הזמנה מהירה — מתי לשאול (לקחת/לשבת, שם)",
        value_type="enum",
        enum_options=(ORDER_DETAILS_DINING_FIRST, "במעבר לתשלום", "בפתיחת הזמנה"),
        default_value=ORDER_DETAILS_DINING_FIRST,
        description=(
            "מתי הקופה שואלת את פרטי ההזמנה המהירה שהופעלו (\"לקחת / לשבת\", \"שם לקוח\"): "
            f"«{ORDER_DETAILS_DINING_FIRST}» (ברירת המחדל) — הזמנה חדשה נפתחת בשאלות: קודם \"לקחת או "
            "לשבת?\" ואז השם (כל אחת אם הופעלה), עוד לפני הפריט הראשון, ורק אז מתחילים להזמין; "
            "«במעבר לתשלום» — הכול בלחיצה על תשלום; «בפתיחת הזמנה» — הכול כשמוסיפים את הפריט "
            "הראשון להזמנה חדשה. בכל מקרה, הזמנה שהגיעה לתשלום בלי הפרטים נשאלת עליהם לפני התשלום."
        ),
    ),
    # "גודל ריבוע מוצר": the product tiles on the till (domain/TileSize.kt, tileSizeFor) —
    # the quick order's, and a tablet's when it has none of its own. A table's order has its
    # own chain (tablet tables → tables → medium, the approved table layout), never this one.
    BuiltinParameter(
        key="productTileSize",
        label="גודל ריבוע מוצר",
        value_type="enum",
        enum_options=TILE_SIZES,
        default_value="בינוני",
        description=(
            "גודל ריבועי המוצרים במסך המכירה (הזמנה מהירה). \"קטן מאוד\" מכניס הכי הרבה מוצרים למסך, "
            "\"גדול\" מציג את התמונה בגדול. חל גם על טאבלט, אלא אם נקבע לו גודל משלו. "
            "הזמנת שולחן אינה מושפעת ממנו — לה יש \"גודל ריבוע מוצר — שולחנות\"."
        ),
    ),
    # "צבע גופן": the till's text colour on the light theme (ui/theme/Theme.kt, textColorOfParam).
    BuiltinParameter(
        key="textColor",
        label="צבע גופן",
        value_type="enum",
        enum_options=("ברירת מחדל", "שחור", "אפור כהה", "כחול כהה", "ירוק כהה", "חום כהה", "סגול כהה"),
        default_value="ברירת מחדל",
        description=(
            "צבע הטקסט במסכי הקופה בערכת הצבע הבהירה. בערכה הכהה הקופה שומרת על הצבע שלה, "
            "כדי שהטקסט ייקרא. «ברירת מחדל» — הצבע הרגיל של המערכת."
        ),
    ),
    BuiltinParameter(
        key="productTileSizeTables",
        label="גודל ריבוע מוצר — שולחנות",
        value_type="enum",
        enum_options=(TILE_SIZE_INHERIT,) + TILE_SIZES,
        default_value=TILE_SIZE_INHERIT,
        description="גודל ריבועי המוצרים בתוך הזמנת שולחן. «ברירת מחדל» — בינוני, העיצוב המאושר של הזמנת השולחן.",
    ),
    BuiltinParameter(
        key="productTileSizeTablet",
        label="גודל ריבוע מוצר בטאבלט — הזמנה מהירה",
        value_type="enum",
        enum_options=(TILE_SIZE_INHERIT,) + TILE_SIZES,
        default_value=TILE_SIZE_INHERIT,
        description="גודל ריבועי המוצרים בהזמנה המהירה בטאבלט. «ברירת מחדל» — כמו \"גודל ריבוע מוצר\".",
    ),
    BuiltinParameter(
        key="productTileSizeTabletTables",
        label="גודל ריבוע מוצר בטאבלט — שולחנות",
        value_type="enum",
        enum_options=(TILE_SIZE_INHERIT,) + TILE_SIZES,
        default_value=TILE_SIZE_INHERIT,
        description=(
            "גודל ריבועי המוצרים בתוך הזמנת שולחן בטאבלט. «ברירת מחדל» — כמו \"גודל ריבוע מוצר — שולחנות\", "
            "ואם גם הוא לא נקבע — בינוני."
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
    # "מדפסת חלופית" (docs/SPEC_PRINT_BY_ZONE.md): read by the till's kitchen queue and its
    # receipt printer; edited on the dashboard's printers page.
    BuiltinParameter(
        key="printerFailoverPrompt",
        label="שאלה על מדפסת חלופית כשמדפסת לא זמינה",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת מחדל): כשבון לא מצליח לצאת במדפסת (המדפסת לא עונה, תקלה, שרת ההדפסות "
            "לא זמין) — הקופה שואלת מיד את העובד אם לשלוח אותו למדפסת אחרת: מדפסת מטבח/בר אחרת, "
            "מדפסת החשבוניות או המדפסת של הקופה, עם \"נסה שוב\" ו\"השאר בתור\". אפשר גם לשלוח לשם "
            "את הבונים הבאים לרבע שעה. כך גם במדפסת חשבוניות חיצונית שלא עונה. הבון מסומן \"הופנה מ:\" "
            "וההפניה נרשמת. כבוי — כמו קודם: הבון ממתין בתור ומנסה שוב, עם ההתראה האדומה."
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
            "כלל שהוגדר כ\"חלון בחירה\" (או \"בכל הזמנה\") מוצג בחלון במרכז המסך עם האפשרויות "
            "(\"האם הצעת שתייה ללקוח?\"). "
            "את ההצעות מגדירים בדשבורד תחת \"הגדלות מכירה\". כבוי — לא מוצגות הצעות, לא כרטיס ולא חלון."
        ),
    ),
    BuiltinParameter(
        key="upsellMaxPerOrder",
        label="הגדלות מכירה — עד כמה הצעות בהזמנה",
        value_type="integer",
        default_value=0,
        description=(
            "כמה הצעות (כרטיס או חלון) הקופה מציגה לכל היותר בהזמנה אחת, מכל הכללים יחד — "
            "בהזמנה מהירה ובשולחן. 0 (ברירת מחדל) — בלי הגבלה, כמו קודם; כל כלל עדיין מוצע לפי "
            "ההגדרות שלו (פעם אחת בהזמנה, עדיפות, ימים ושעות). בקיוסק המגבלה נקבעת בהגדרות הקיוסק."
        ),
    ),
    # "יעדים ותחרות" (app/services/sales_targets.py): the till's small leaderboard, off by default.
    BuiltinParameter(
        key="leaderboardEnabled",
        label="לוח מובילים ויעד בקופה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, בראש מסך המכירה מוצג שבב קטן עם התקדמות יעד הסניף להיום, ובלחיצה — לוח מובילים "
            "של העובדים בסניף היום (לפי הפרמטר \"לוח מובילים — מדד\"). היעדים נקבעים בדשבורד, בדף \"יעדים\". "
            "מתעדכן כל דקה כשיש חיבור לענן."
        ),
    ),
    BuiltinParameter(
        key="leaderboardMetric",
        label="לוח מובילים — מדד",
        value_type="enum",
        enum_options=("מכירות", "פריטי אפסייל"),
        default_value="מכירות",
        description=(
            "לפי מה מדורגים העובדים בלוח המובילים בקופה: «מכירות» — סך המכירות נטו של כל עובד היום; "
            "«פריטי אפסייל» — כמה פריטים כל עובד הוסיף מהצעות \"הגדלת מכירה\" היום."
        ),
    ),
    BuiltinParameter(
        key="modifiersAutoOpen",
        label="תוספות — חלון קופץ אוטומטי",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: לחיצה על מנה שיש לה תוספות (קבוצות תוספות בתפריט) פותחת מיד את חלון התוספות, "
            "גם כשהבחירה בהן לא חובה. מנה שיש לה רק הערות נפתחת לבד רק עם הפרמטר \"הערות — חלון קופץ "
            "אוטומטי\". כבוי (ברירת מחדל) — החלון נפתח לבד רק כשחייבים לבחור (תוספת חובה או "
            "ארוחה), ואחרת בכפתור + שעל המנה. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    BuiltinParameter(
        key="notesAutoOpen",
        label="הערות — חלון קופץ אוטומטי",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: לחיצה על מנה שהוגדרו לה הערות מהירות משלה (או לקטגוריה שלה) פותחת מיד את חלון המנה "
            "עם ההערות לבחירה. הערות שהוגדרו לכל המנות לא פותחות חלון. כבוי (ברירת מחדל) — הערה למנה "
            "מוסיפים בלחיצה על השורה בהזמנה או בכפתור + שעל המנה."
        ),
    ),
    # "הודעות לעובד על פריט" (app/services/product_alerts.py) — read by the till.
    BuiltinParameter(
        key="productAlertsEnabled",
        label="הודעות לעובד על פריט",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): פריט שהוגדרו לו \"הודעות לעובד\" בטופס המוצר (למשל \"מכיל ביצים — "
            "תעדכן לקוח!\", או אזהרת האלרגנים שלו) מציג אותן בחלון במרכז המסך כשמוסיפים אותו להזמנה, "
            "לפני שהוא נכנס. הודעה שמסומנת \"חובה לאשר\" מוסיפה את הפריט רק אחרי \"עדכנתי את הלקוח\" "
            "(\"ביטול\" לא מוסיף), והאישור — מי ומתי — נשמר על השורה ומגיע לענן. כבוי — לא מוצגות הודעות "
            "והפריט נכנס כרגיל. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    # "סימוני תזונה" (docs/SPEC_PRODUCT_DIETARY.md) on the till's own sell screen. The kiosk
    # shows them by its own settings, whatever this says.
    BuiltinParameter(
        key="showDietaryMarks",
        label="הצג סימוני תזונה בקופה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: על ריבוע המוצר במסך המכירה ובחלון המנה מוצגים סמלים קטנים של סימוני התזונה "
            "שהוגדרו בטופס המוצר (טבעוני, צמחוני, חלבי, בשרי, ללא גלוטן, חריף). כבוי (ברירת מחדל) — "
            "לא מוצגים בקופה. בקיוסק הסימונים מוצגים לפי הגדרות הקיוסק. ניתן לקבוע לפי חברה, סניף, "
            "נקודת מכירה או קופה."
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
    # "עובד מחובר בקופה אחת בלבד" — app/services/user_sessions.py reads both, and the till.
    BuiltinParameter(
        key="exclusiveUserLogin",
        label="עובד מחובר בקופה אחת בלבד",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: עובד/מלצר שמחובר בקופה אחת לא יכול להתחבר בקופה אחרת עד שיתנתק בה. "
            "בכניסה בקופה אחרת מוצגת הודעה איפה הוא מחובר ומאז מתי, ואפשר \"שחרור באישור מנהל\" "
            "(קוד מנהל; נרשם בחריגות). התנתקות, החלפת עובד ונעילה בחוסר שימוש משחררות. "
            "קופה בלי אינטרנט לא נחסמת: הכניסה מותרת והבדיקה נעשית כשהחיבור חוזר. "
            "קופה שהפסיקה לדווח משתחררת לבד אחרי \"עובד בקופה אחת — שחרור אוטומטי אחרי (דקות)\". "
            "את המחוברים כעת רואים (ומשחררים) בדשבורד בדף \"קופאים (POS)\"."
        ),
    ),
    BuiltinParameter(
        key="exclusiveUserLoginStaleMinutes",
        label="עובד בקופה אחת — שחרור אוטומטי אחרי (דקות)",
        value_type="integer",
        default_value=15,
        description=(
            "קופה שמחובר בה עובד ולא דיווחה לענן (נפלה, כבויה, בלי רשת) במשך מספר הדקות הזה — "
            "החיבור שלו בה משתחרר לבד, כך שקופה תקועה לא נועלת עובד לתמיד (2–720; ברירת מחדל 15). "
            "קופה פעילה מדווחת כל דקה."
        ),
    ),
    # "נוכחות עובדים" (app/services/attendance.py, docs/SPEC_ATTENDANCE.md) — read by the
    # till and the cloud. All four default to today's behaviour: nothing changes until set.
    BuiltinParameter(
        key="attendanceEnabled",
        label="נוכחות עובדים (שעון נוכחות)",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: אחרי הקשת קוד העובד הקופה מציגה את מצב הנוכחות שלו (\"לא במשמרת\" / \"במשמרת מ־17:02\" / "
            "\"בהפסקה\") ומציעה \"התחל משמרת\", ובתפריט מופיע \"נוכחות\": התחל משמרת, יציאה להפסקה, חזרה "
            "מהפסקה, סיום משמרת ובקשת תיקון נוכחות. הנוכחות נפרדת מההתחברות לקופה: החלפת עובד, התנתקות, "
            "נעילה בחוסר שימוש או מעבר לקופה אחרת לא מסיימים משמרת — רק \"סיום משמרת\" או סגירה של מנהל. "
            "עובד גם בלי אינטרנט (נשמר בקופה ונשלח כשהחיבור חוזר). בדשבורד: \"עובדים במשמרת\", דוח נוכחות "
            "ותיקוני נוכחות. במסך הכניסה של הקופה מופיע \"שעון נוכחות\": כל עובד מקיש את הקוד שלו ומבצע "
            "כניסה, יציאה להפסקה, חזרה מהפסקה או יציאה — בלי להיכנס לקופה ובלי הרשאת מכירה (בקופות "
            "בלבד, לא בקיוסק ולא במסך מטבח). כבוי (ברירת מחדל) — אין שינוי בקופה."
        ),
    ),
    BuiltinParameter(
        key="requireClockInBeforeLogin",
        label="נוכחות — חובה להתחיל משמרת לפני מכירה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל (יחד עם \"נוכחות עובדים\"): עובד שהקיש קוד ואינו במשמרת לא יכול למכור עד שיתחיל "
            "משמרת — הקופה מציעה \"התחל משמרת\" מיד במסך הכניסה, או יציאה. כבוי — אפשר להמשיך בלי משמרת."
        ),
    ),
    BuiltinParameter(
        key="preventClockOutWithOpenTables",
        label="נוכחות — חסימת סיום משמרת עם שולחנות פתוחים",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): מלצר שיש לו שולחנות פתוחים רואה \"לא ניתן לסיים משמרת\" עם רשימת "
            "השולחנות והסכומים, ויכול להעביר אותם לעובד אחר או לסיים באישור מנהל (נרשם בחריגות). "
            "חל גם על סגירת משמרת ע״י מנהל בדשבורד. כבוי — מוצגת אזהרה ואפשר לסיים."
        ),
    ),
    BuiltinParameter(
        key="requireManagerForClockOut",
        label="נוכחות — סיום משמרת באישור מנהל",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: \"סיום משמרת\" דורש קוד מנהל (נבדק בקופה, עובד גם בלי אינטרנט); מנהל שמסיים "
            "את המשמרת של עצמו מאשר בעצמו. המאשר נשמר עם המשמרת. כבוי (ברירת מחדל) — העובד מסיים לבד."
        ),
    ),
    # Unlike the four above, on by default: the owner's rule "חייב קוד" (09.10). It only bites
    # where "נוכחות עובדים" is on, so shops that never turned attendance on see no change.
    BuiltinParameter(
        key="attendanceRequireCodePerAction",
        label="נוכחות — קוד עובד בכל פעולה",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): כל פעולת נוכחות — כניסה, יציאה להפסקה, חזרה מהפסקה, יציאה ובקשת תיקון — "
            "דורשת את הקוד האישי של העובד ברגע הפעולה, גם מהתפריט \"נוכחות\" בתוך הקופה: העובד המחובר "
            "מקיש שוב את הקוד שלו. מנהל שפועל בשם עובד מאשר בקוד מנהל, והפעולה נרשמת עם שמו (ובחריגות). "
            "הקוד נבדק בקופה מול רשימת העובדים, כמו בכניסה לקופה, ועובד גם בלי אינטרנט; חמישה קודים "
            "שגויים נועלים לדקה, כמו בקוד מנהל. "
            "\"שעון נוכחות\" במסך הכניסה דורש קוד תמיד. כבוי — פעולה מהתפריט בתוך הקופה נעשית בלי קוד "
            "נוסף, כמו קודם. חל רק כש\"נוכחות עובדים\" מופעל."
        ),
    ),
    # OTH ("על חשבון הבית") and the club button ("מועדון לקוחות") on the order screens —
    # read by the till; the documents carry them to the cloud (exception "oth", the
    # discounts in the promotions report). All off by default: nothing changes until set.
    BuiltinParameter(
        key="othEnabled",
        label="כפתור OTH — על חשבון הבית",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: במסך ההזמנה (הזמנה מהירה ושולחן) מופיע כפתור \"OTH\", וגם בפעולות של כל שורה. "
            "בוחרים פריטים וסיבה (מהפרמטר \"OTH — סיבות\"), והפריט הופך לחינם: הנחה של 100% שמסומנת OTH, "
            "עם הסיבה ומי אישר. הפריט עדיין יוצא למטבח, מודפס בחשבונית \"OTH — סיבה\" עם המחיר המקורי ו-₪0, "
            "ואפשר לבטל אותו (באותו אישור). לא מצטבר עם הנחה אחרת על השורה ולא נספר במבצעים. "
            "כל פריט OTH נרשם בענן כחריגה \"OTH — על חשבון הבית\" ומופיע בדוח המבצעים וההנחות."
        ),
    ),
    BuiltinParameter(
        key="othRequiresManager",
        label="OTH — באישור מנהל",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): עובד שאין לו הרשאת הנחה צריך קוד מנהל כדי לתת פריט על חשבון הבית "
            "(וכדי לבטל OTH). מנהל שמחובר בקופה מאשר בעצמו. כבוי — כל עובד נותן OTH בלי אישור."
        ),
    ),
    BuiltinParameter(
        key="othReasons",
        label="OTH — סיבות",
        value_type="string",
        default_value="לקוח קבוע,פיצוי,טעימה,עובד,אחר",
        description=(
            "הסיבות שהעובד בוחר מהן כשהוא נותן פריט על חשבון הבית, מופרדות בפסיקים "
            "(למשל: לקוח קבוע,פיצוי,טעימה,עובד,אחר). הסיבה מודפסת בחשבונית ונרשמת בחריגה ובדוח."
        ),
    ),
    BuiltinParameter(
        key="clubButtonEnabled",
        label="כפתור מועדון לקוחות במסך ההזמנה",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: במסך ההזמנה (הזמנה מהירה ושולחן) מופיע כפתור \"מועדון\". לחיצה נותנת על כל ההזמנה "
            "את אחוז ההנחה הקבוע מהפרמטר \"מועדון — אחוז הנחה קבוע\" כהנחת סל \"הנחת מועדון X%\" — "
            "בלי מוצרים שלא מקבלים הנחות, וגם על פריטים שנוספים אחר כך. לחיצה נוספת מסירה. "
            "לא מצטברת עם הנחת סל ידנית (מחליפה אותה, באישור). מודפסת בחשבונית ונשלחת לענן כהנחת מועדון "
            "(עם הלקוח, אם שויך) — בדוח המבצעים וההנחות."
        ),
    ),
    BuiltinParameter(
        key="clubDiscountPercent",
        label="מועדון — אחוז הנחה קבוע",
        value_type="decimal",
        default_value=10,
        description="אחוז ההנחה שכפתור המועדון נותן על ההזמנה (למשל 10 או 12.5; בין 0 ל-100).",
    ),
    BuiltinParameter(
        key="clubRequiresCustomer",
        label="מועדון — חובה לשייך לקוח",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: לחיצה על \"מועדון\" פותחת קודם את חיפוש הלקוחות (לפי טלפון או שם), וההנחה ניתנת "
            "רק אחרי שיוך לקוח. כבוי — שיוך לקוח רשות."
        ),
    ),
)


# "תצורת עבודה לעמדה" and KDS (docs/SPEC_KDS.md): defined with their rules in
# app/services/kds_workflow.py, registered here like the others.
from app.services.kds_workflow import WORKFLOW_KEYS as _WORKFLOW_KEYS  # noqa: E402
from app.services.kds_workflow import WORKFLOW_PARAMETER_SPECS as _WORKFLOW_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _WORKFLOW_SPECS)

# "קוד טכנאי לקיוסק" (app/services/kiosk_technician.py): the kiosk technician screen's code.
from app.services.kiosk_technician import TECHNICIAN_PARAMETER_SPECS as _TECHNICIAN_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _TECHNICIAN_SPECS)

# "מעבר אוטומטי לנתונים ניידים" (app/services/device_identity.py): the till's cloud traffic over
# mobile data while the Wi-Fi has no internet (pos-android system/NetworkFallback.kt).
from app.services.device_identity import CELLULAR_PARAMETER_SPECS as _CELLULAR_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _CELLULAR_SPECS)

# "הדפסת עסקאות שלא הושלמו בדוח משמרת / Z" (docs/SPEC_FAILED_PAYMENTS.md): the till's paper only.
from app.services.failed_payments import FAILED_PAYMENTS_PARAMETER_SPECS as _FAILED_PAYMENTS_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _FAILED_PAYMENTS_SPECS)

# "סוללה חלשה" (app/services/battery_alerts.py): the thresholds and the alarm, per device.
from app.services.battery_alerts import BATTERY_PARAMETER_SPECS as _BATTERY_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _BATTERY_SPECS)

# "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): print on the till, and how long a prepared one waits.
from app.services.remote_credits import REMOTE_CREDIT_PARAMETER_SPECS as _REMOTE_CREDIT_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _REMOTE_CREDIT_SPECS)

# "התראת בון שלא הודפס" (pos-android domain/UnprintedBonAlert.kt): the owner, 08.10.2026 — off by
# default; on shows the kiosk's "בון לא הודפס" pill and the till's kitchen-print banner.
BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + (
    BuiltinParameter(
        key="unprintedBonAlert",
        label="התראת בון שלא הודפס",
        value_type="boolean",
        description="הצגת התראה כשבון לא הודפס (בקיוסק ובקופה). כבוי — לא מוצגת התראה; הבון נשאר בתור ויודפס כשהמדפסת תחזור.",
        default_value=False,
    ),
)

# "עקיפת בדיקת מספר מסוף" (docs/SPEC_KIOSK.md §20.1): the card lock's terminal-number check off.
from app.services.terminal_check_bypass import BYPASS_PARAMETER_SPECS as _BYPASS_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _BYPASS_SPECS)

# "שוברי פריט" (app/services/item_ticket.py): the device's item tickets, above each product's setting.
from app.services.item_ticket import ITEM_TICKET_PARAMETER_SPECS as _ITEM_TICKET_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _ITEM_TICKET_SPECS)

# "מגירת מזומן" (app/services/cash_drawer.py, docs/SPEC_ROLES_PERMISSIONS.md): the drawer's
# management parameters (spec §17), edited on the roles page per company → shop → area → till.
from app.services.cash_drawer import CASH_DRAWER_PARAMETER_SPECS as _CASH_DRAWER_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _CASH_DRAWER_SPECS)

# "חסימת אשראי כשיש תשלום לא מוכרע" (app/services/card_lock.py): what an unresolved card payment blocks.
from app.services.card_lock import CARD_LOCK_PARAMETER_SPECS as _CARD_LOCK_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _CARD_LOCK_SPECS)

# "חסימת Z כשיש משמרות פתוחות" (app/services/z_shift_guard.py): no shop Z while a till's shift is open.
from app.services.z_shift_guard import PARAMETER_SPECS as _Z_SHIFT_GUARD_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _Z_SHIFT_GUARD_SPECS)

# "התאמת אשראי מול Z-Credit" (app/services/zcredit_reconcile.py): on / off and the nightly run time.
from app.services.zcredit_reconcile import PARAMETER_SPECS as _ZCREDIT_RECON_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _ZCREDIT_RECON_SPECS)

# Held sales at a close (app/services/held_sales_close.py): "סגירה עם מכירות מושהות" (off),
# "ביטול מכירות מושהות מהענן בסגירה מרחוק" (on), "סגירה מרחוק גם עם עגלה פתוחה" (off).
from app.services.held_sales_close import PARAMETER_SPECS as _HELD_SALES_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _HELD_SALES_SPECS)

# "זיכוי באשראי מהענן (Z-Credit)" (app/services/cloud_refund_z_gate.py, SPEC_REMOTE_CREDIT.md §11.8):
# offered per layer, which shift its credit note lands in, and "חובה לפני ה-Z הבא".
from app.services.cloud_refund_z_gate import PARAMETER_SPECS as _CLOUD_REFUND_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _CLOUD_REFUND_SPECS)

# "נעילת הקופה לנקודת המכירה שלה" (app/services/area_lock.py, docs/SPEC_AREA_LOCK.md): a till in an
# area sees and acts on its area's data only. Default on; no effect on a till without an area.
from app.services.area_lock import AREA_LOCK_PARAMETER_SPECS as _AREA_LOCK_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _AREA_LOCK_SPECS)


# "מצב עבודה: קיוסק / קופה" and "כיוון מסך" (app/services/kiosk_till_mode.py): the owner's gate (admin
# only), the idle return, the manager's code, the kiosk's orientation lock.
from app.services.kiosk_till_mode import PARAMETER_SPECS as _KIOSK_TILL_MODE_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _KIOSK_TILL_MODE_SPECS)

# "כפיית סגירה מרחוק כברירת מחדל" (app/services/remote_close_force.py): remote control's close or Z
# forced from the moment the manager sends it (on); off waits for rest as before.
from app.services.remote_close_force import PARAMETER_SPECS as _REMOTE_FORCE_SPECS  # noqa: E402

BUILTIN_PARAMETERS = BUILTIN_PARAMETERS + tuple(BuiltinParameter(**spec) for spec in _REMOTE_FORCE_SPECS)

#: Parameters a super admin or a distributor alone may change (BuiltinParameter.admin_only).
ADMIN_ONLY_KEYS = frozenset(spec.key for spec in BUILTIN_PARAMETERS if spec.admin_only)


def validate_keyed_value(key: str, value: Any) -> Any:
    """A value checked for what its key needs beyond its type (`technicianCode`: 4–8 digits)."""
    from app.services import kiosk_technician, kiosk_till_mode

    if key in (kiosk_till_mode.IDLE_KEY, kiosk_till_mode.ORIENTATION_KEY):
        try:
            return kiosk_till_mode.clean_value(key, value)
        except ValueError as exc:
            raise TillParameterValueError(str(exc)) from exc

    if key == kiosk_technician.TECHNICIAN_CODE_KEY and value is not None:
        try:
            return kiosk_technician.clean_code(value)
        except kiosk_technician.TechnicianCodeError as exc:
            raise TillParameterValueError(str(exc)) from exc
    from app.services import zcredit_reconcile

    if key == zcredit_reconcile.PARAM_TIME and value is not None:
        try:
            return zcredit_reconcile.validate_time(value)
        except ValueError as exc:
            raise TillParameterValueError(str(exc)) from exc
    return value


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
