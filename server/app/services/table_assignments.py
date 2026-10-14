"""
"שיוך שולחנות ואזורים למלצר" (P:/specs/table-waiter-assignment.md §1–§7) — and the parameters of §8
("שולחן תפוס"), which live beside them on the tables page.

**What is assigned** (§2): a zone (every table in it, those added later too) or one table; a table's own
assignment beats its zone's. `tableAssignmentMulti` = `single`: one waiter per zone / table — a new one
replaces the last (`replaced`); `multi`: several (the first assigned is the main one).

**When it stops holding** (§6, `tableAssignmentReset`, read for the shop): `z` (the default) — the shop's Z
releases every assignment made before it (`after_z`), and anything left from an earlier business day no
longer holds; `day` — made on another calendar day (the shop's time zone) no longer holds; `never` — until
someone changes it. `tableAssignmentOnClockOut` = `release`: the waiter's clock-out releases theirs
(`on_clock_out`); their open tables stay theirs (an order's waiter is the order's).

**Rows are only ever released** (`released_at`, `released_reason`), never edited. The cloud's tills, the
dashboard and a LAN host write the same rows; a LAN host's copy merges with the cloud's as a set of rows by
id, a release final wherever it was made (`merge_report`, the mirror contract of the spec's §6).

**The tills** read the assignments in their tables state (`GET /sync/{m}/tables`, app/services/tables.py):
the `assignment` block (this till's parameters, the business day, the live rows, the waiters with their
colours) and each table's effective `assignment` ({via, posUserIds}). With `tableAssignmentMode` off nothing
of it is sent: the state is today's.

**`tableAssignmentOwner`** (§1): a table opened in the cloud's tables with no waiter named by the till is
recorded on its assigned waiter (`assigned`, the default) or on whoever opened it (`opener`).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.table_assignment import TableAssignment
from app.models.tables import DiningTable, TableZone

logger = logging.getLogger(__name__)

# ── The parameters (§1, §5, §8) ─────────────────────────────────────────────────────

MODE_KEY = "tableAssignmentMode"
UNASSIGNED_KEY = "tableAssignmentUnassigned"
OWNER_KEY = "tableAssignmentOwner"
RESET_KEY = "tableAssignmentReset"
CLOCK_OUT_KEY = "tableAssignmentOnClockOut"
MULTI_KEY = "tableAssignmentMulti"
NOTIFY_KEY = "tableAssignmentNotify"
BUSY_ENTRY_KEY = "tableBusyEntry"
BUSY_SHOW_HOLDER_KEY = "tableBusyShowHolder"

MODE_OFF, MODE_HIGHLIGHT, MODE_RESTRICT = "off", "highlight", "restrict"
MODES = (MODE_OFF, MODE_HIGHLIGHT, MODE_RESTRICT)
UNASSIGNED_OPEN, UNASSIGNED_RESTRICTED = "open", "restricted"
UNASSIGNED_OPTIONS = (UNASSIGNED_OPEN, UNASSIGNED_RESTRICTED)
OWNER_ASSIGNED, OWNER_OPENER = "assigned", "opener"
OWNER_OPTIONS = (OWNER_ASSIGNED, OWNER_OPENER)
RESET_Z, RESET_DAY, RESET_NEVER = "z", "day", "never"
RESET_OPTIONS = (RESET_Z, RESET_DAY, RESET_NEVER)
CLOCK_OUT_KEEP, CLOCK_OUT_RELEASE = "keep", "release"
CLOCK_OUT_OPTIONS = (CLOCK_OUT_KEEP, CLOCK_OUT_RELEASE)
MULTI_SINGLE, MULTI_MULTI = "single", "multi"
MULTI_OPTIONS = (MULTI_SINGLE, MULTI_MULTI)
BUSY_BLOCK, BUSY_REQUEST, BUSY_VIEW, BUSY_OFF = "block", "request", "view", "off"
BUSY_OPTIONS = (BUSY_BLOCK, BUSY_REQUEST, BUSY_VIEW, BUSY_OFF)

MODE_LABELS = {
    MODE_OFF: "כבוי — כמו היום (ברירת מחדל)",
    MODE_HIGHLIGHT: "הצגה — צבע המלצר על השולחן וסינון \"השולחנות שלי\"",
    MODE_RESTRICT: "הגבלה — מלצר פותח רק שולחן שלו או שלא שויך",
}
UNASSIGNED_LABELS = {
    UNASSIGNED_OPEN: "מותר לפתוח (ברירת מחדל)",
    UNASSIGNED_RESTRICTED: "רק באישור, כמו שולחן של מלצר אחר",
}
OWNER_LABELS = {
    OWNER_ASSIGNED: "על המלצר המשויך (ברירת מחדל)",
    OWNER_OPENER: "על מי שפתח",
}
RESET_LABELS = {
    RESET_Z: "ב-Z או בסוף יום העסקים (ברירת מחדל)",
    RESET_DAY: "בחצות",
    RESET_NEVER: "אף פעם — עד שמשנים",
}
CLOCK_OUT_LABELS = {
    CLOCK_OUT_KEEP: "השיוך נשאר (ברירת מחדל)",
    CLOCK_OUT_RELEASE: "השיוך משתחרר",
}
MULTI_LABELS = {
    MULTI_SINGLE: "מלצר אחד לשולחן (ברירת מחדל)",
    MULTI_MULTI: "כמה מלצרים לשולחן (ראשי ועוזר)",
}
BUSY_LABELS = {
    BUSY_BLOCK: "חסימה — לא נכנסים (ברירת מחדל)",
    BUSY_REQUEST: "חסימה ובקשה לצאת",
    BUSY_VIEW: "חסימה וצפייה בלבד",
    BUSY_OFF: "בלי חסימה (לא בטוח)",
}
#: What the dashboard says next to an option when it is chosen (§8: "הדשבורד מציג אזהרה").
OPTION_WARNINGS: Dict[str, Dict[str, str]] = {
    BUSY_ENTRY_KEY: {
        BUSY_OFF: (
            "לא בטוח: שני מכשירים עלולים לערוך את אותו שולחן בבת אחת. שמירה שמבוססת על גרסה ישנה עדיין "
            "נדחית, אבל העובד יצטרך לטעון מחדש ולהזין שוב. מומלץ להשאיר «חסימה»."
        ),
    },
}

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
_SHOP_LEVEL = "נקרא לפי הסניף (ערך ברמת נקודת מכירה או קופה לא נחשב)."

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=MODE_KEY,
        label="שיוך שולחנות למלצרים",
        value_type="enum",
        enum_options=MODES,
        enum_labels=MODE_LABELS,
        default_value=MODE_OFF,
        description=(
            "שיוך מראש של אזורים ושולחנות למלצר, לפני שהשולחן נפתח (\"דנה: גינה, שולחנות 1–10\"). "
            f"«{MODE_LABELS[MODE_OFF]}». "
            f"«{MODE_LABELS[MODE_HIGHLIGHT]}» — כל מלצר עדיין פותח כל שולחן פנוי. "
            f"«{MODE_LABELS[MODE_RESTRICT]}» — שולחן ששויך למלצר אחר נחשב \"של מלצר אחר\" ודורש את ההרשאה "
            "\"עבודה על שולחן של מלצר אחר\" (קוד מנהל למלצר). שיוך של שולחן גובר על שיוך של אזור. "
            "משייכים בקופה (\"שיוך מלצרים\", בהרשאה \"שיוך שולחנות למלצרים\") או בדשבורד בשולחנות פתוחים. "
            + _LEVELS
        ),
    ),
    dict(
        key=UNASSIGNED_KEY,
        label="שיוך מלצרים — שולחן שלא שויך",
        value_type="enum",
        enum_options=UNASSIGNED_OPTIONS,
        enum_labels=UNASSIGNED_LABELS,
        default_value=UNASSIGNED_OPEN,
        description=(
            "במצב «הגבלה»: האם מלצר פותח לבד שולחן שלא שויך לאף אחד. "
            f"«{UNASSIGNED_LABELS[UNASSIGNED_OPEN]}». "
            f"«{UNASSIGNED_LABELS[UNASSIGNED_RESTRICTED]}» — דורש \"עבודה על שולחן של מלצר אחר\". "
            + _LEVELS
        ),
    ),
    dict(
        key=OWNER_KEY,
        label="שיוך מלצרים — על מי נרשמת ההזמנה",
        value_type="enum",
        enum_options=OWNER_OPTIONS,
        enum_labels=OWNER_LABELS,
        default_value=OWNER_ASSIGNED,
        description=(
            "מנהל או מלצר אחר פותח שולחן ששויך לדנה: "
            f"«{OWNER_LABELS[OWNER_ASSIGNED]}» — ההזמנה (המכירות והטיפים) נרשמת על דנה. "
            f"«{OWNER_LABELS[OWNER_OPENER]}» — על מי שפתח. בכל מקרה הקופה מציגה למי ההזמנה נרשמת. "
            + _LEVELS
        ),
    ),
    dict(
        key=RESET_KEY,
        label="שיוך מלצרים — מתי השיוך מתאפס",
        value_type="enum",
        enum_options=RESET_OPTIONS,
        enum_labels=RESET_LABELS,
        default_value=RESET_Z,
        description=(
            f"«{RESET_LABELS[RESET_Z]}» — Z של הסניף משחרר את כל השיוכים שנעשו לפניו, ושיוך מיום עסקים "
            f"קודם כבר לא חל. «{RESET_LABELS[RESET_DAY]}» — שיוך מיום אחר (לפי שעון הסניף) כבר לא חל. "
            f"«{RESET_LABELS[RESET_NEVER]}» — השיוך קבוע. אפשר תמיד \"העתק שיוך מאתמול\" או \"מהמשמרת "
            "הקודמת\". " + _SHOP_LEVEL
        ),
    ),
    dict(
        key=CLOCK_OUT_KEY,
        label="שיוך מלצרים — ביציאה בנוכחות",
        value_type="enum",
        enum_options=CLOCK_OUT_OPTIONS,
        enum_labels=CLOCK_OUT_LABELS,
        default_value=CLOCK_OUT_KEEP,
        description=(
            "כשהמלצר יוצא במערכת הנוכחות (בקופה, או מנהל שסוגר לו משמרת). "
            f"«{CLOCK_OUT_LABELS[CLOCK_OUT_KEEP]}». «{CLOCK_OUT_LABELS[CLOCK_OUT_RELEASE]}» — השולחנות "
            "הפתוחים שלו נשארים שלו; רק השיוך מראש משתחרר. " + _SHOP_LEVEL
        ),
    ),
    dict(
        key=MULTI_KEY,
        label="שיוך מלצרים — כמה מלצרים לשולחן",
        value_type="enum",
        enum_options=MULTI_OPTIONS,
        enum_labels=MULTI_LABELS,
        default_value=MULTI_SINGLE,
        description=(
            f"«{MULTI_LABELS[MULTI_SINGLE]}» — שיוך חדש מחליף את הקודם. «{MULTI_LABELS[MULTI_MULTI]}» — "
            "השיוך הראשון הוא המלצר הראשי (עליו נרשמת ההזמנה), השאר עוזרים. " + _SHOP_LEVEL
        ),
    ),
    dict(
        key=NOTIFY_KEY,
        label="שיוך מלצרים — התראות למלצר המשויך",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל: המלצר המשויך מקבל במכשיר שבו הוא מחובר \"מוכן להגשה\" מה-KDS לשולחן שלו, ו\"שולחן "
            "מתעכב\" (לפי \"מפת שולחנות — 'מתעכב' אחרי\"). עם \"עובד מחובר בקופה אחת בלבד\" זה מכשיר אחד; "
            "בלי — כל מכשיר שהמלצר מחובר בו. שולחן בלי שיוך — אין התראה. " + _SHOP_LEVEL
        ),
    ),
    dict(
        key=BUSY_ENTRY_KEY,
        label="שולחן תפוס — כניסה לשולחן שפתוח במכשיר אחר",
        value_type="enum",
        enum_options=BUSY_OPTIONS,
        enum_labels=BUSY_LABELS,
        default_value=BUSY_BLOCK,
        description=(
            "מה קורה כשנכנסים לשולחן שמלצר אחר יושב עליו במכשיר אחר. "
            f"«{BUSY_LABELS[BUSY_BLOCK]}» — ההודעה מציגה את המכשיר ואת העובד: \"שולחן 12 תפוס: קופה 3 (בר) · "
            "דנה, מאז 20:14\"; \"שחרור באישור מנהל\" נשאר. "
            f"«{BUSY_LABELS[BUSY_REQUEST]}» — ובנוסף \"בקש מדנה לצאת\": המכשיר של דנה מציג את הבקשה עם \"שמור "
            "וצא\" ו\"התעלם\" (לא באמצע תשלום). "
            f"«{BUSY_LABELS[BUSY_VIEW]}» — ובנוסף \"צפייה בלבד\": ההזמנה נפתחת לקריאה בלי לנעול. "
            f"«{BUSY_LABELS[BUSY_OFF]}» — לא נחסמים: שני מכשירים עלולים לערוך את אותו שולחן בבת אחת. "
            + _LEVELS
        ),
    ),
    dict(
        key=BUSY_SHOW_HOLDER_KEY,
        label="שולחן תפוס — הצגת המכשיר והעובד",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל): על שולחן שפתוח במכשיר אחר מוצגים המכשיר וראשי התיבות של העובד "
            "(\"ק3 · ד.כ\"), בתפריט השולחן השם המלא, ובדשבורד בשולחנות פתוחים \"פתוח כעת: קופה 3 · דנה\". "
            "השם הוא העובד שמחובר כרגע במכשיר, ומתעדכן בהחלפת עובד. " + _LEVELS
        ),
    ),
)

#: The keys, in the order the dashboard lists them.
LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
#: The tables page's group of these ("הגדרות שולחנות"): app/services/table_restore.py `_page_groups`.
PAGE_GROUP = "waiters"
PAGE_GROUP_LABEL = "שיוך מלצרים ושולחן תפוס"
_ENUMS: Dict[str, Tuple[str, ...]] = {
    MODE_KEY: MODES,
    UNASSIGNED_KEY: UNASSIGNED_OPTIONS,
    OWNER_KEY: OWNER_OPTIONS,
    RESET_KEY: RESET_OPTIONS,
    CLOCK_OUT_KEY: CLOCK_OUT_OPTIONS,
    MULTI_KEY: MULTI_OPTIONS,
    BUSY_ENTRY_KEY: BUSY_OPTIONS,
}
#: The keys whose value is checked beyond its type (`clean_value`): the codes the till knows.
VALIDATED_KEYS = frozenset(_ENUMS)


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key`, or ValueError: only the codes the till knows."""
    if value is None or key not in _ENUMS:
        return value
    if value not in _ENUMS[key]:
        raise ValueError(f"{key} must be one of {', '.join(_ENUMS[key])}")
    return value


def option_warnings(key: str) -> Optional[Dict[str, str]]:
    """The dashboard's warning per option of `key` (`tableBusyEntry` = off), if any."""
    warnings = OPTION_WARNINGS.get(key)
    return dict(warnings) if warnings else None


@dataclass(frozen=True)
class Config:
    """The parameters as one till (or the shop) reads them; anything unknown is its default."""

    mode: str = MODE_OFF
    unassigned: str = UNASSIGNED_OPEN
    owner: str = OWNER_ASSIGNED
    reset: str = RESET_Z
    on_clock_out: str = CLOCK_OUT_KEEP
    multi: str = MULTI_SINGLE
    notify: bool = False
    busy_entry: str = BUSY_BLOCK
    busy_show_holder: bool = True

    @property
    def on(self) -> bool:
        return self.mode != MODE_OFF


def _code(params: Dict[str, Any], key: str, default: str) -> str:
    value = params.get(key)
    return value if isinstance(value, str) and value in _ENUMS[key] else default


def config_of(params: Optional[Dict[str, Any]]) -> Config:
    params = params or {}
    return Config(
        mode=_code(params, MODE_KEY, MODE_OFF),
        unassigned=_code(params, UNASSIGNED_KEY, UNASSIGNED_OPEN),
        owner=_code(params, OWNER_KEY, OWNER_ASSIGNED),
        reset=_code(params, RESET_KEY, RESET_Z),
        on_clock_out=_code(params, CLOCK_OUT_KEY, CLOCK_OUT_KEEP),
        multi=_code(params, MULTI_KEY, MULTI_SINGLE),
        notify=params.get(NOTIFY_KEY) is True,
        busy_entry=_code(params, BUSY_ENTRY_KEY, BUSY_BLOCK),
        # On unless explicitly switched off (the owner: "מופעלת").
        busy_show_holder=params.get(BUSY_SHOW_HOLDER_KEY) is not False,
    )


def config_out(cfg: Config) -> Dict[str, Any]:
    """The `assignment` block's parameters as the till reads them."""
    return {
        "mode": cfg.mode,
        "unassigned": cfg.unassigned,
        "owner": cfg.owner,
        "reset": cfg.reset,
        "onClockOut": cfg.on_clock_out,
        "multi": cfg.multi,
        "notify": cfg.notify,
    }


def busy_out(cfg: Config) -> Dict[str, Any]:
    """The `busy` block (§8): what entering a table held by another device does here."""
    return {"entry": cfg.busy_entry, "showHolder": cfg.busy_show_holder}


def shop_config(db: Session, shop: Shop) -> Config:
    """The parameters for the shop itself (the rules the cloud applies to the shop's rows)."""
    from app.services import till_parameters as TP

    return config_of(TP.resolve_for_shop(db, shop))


# ── Clock, business day ─────────────────────────────────────────────────────────────

#: `businessDayEndHour` (feat/business-day-end; app/services/business_day.py there): when it is a
#: parameter here it is read, else the insights' 04:00.
END_HOUR_KEY = "businessDayEndHour"


def _now() -> datetime:
    """The tables' own clock (`tables._now`, which the tests move)."""
    from app.services import tables as T

    return T._now()


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = _utc(moment)
    return moment.isoformat() if moment is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def end_hour_of(params: Optional[Dict[str, Any]]) -> int:
    from app.services.insights.service import DEFAULT_DAY_START_HOUR

    value = (params or {}).get(END_HOUR_KEY)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return int(DEFAULT_DAY_START_HOUR)
    return int(min(max(int(value), 0), 12))


def business_day(moment: datetime, zone: Any, end_hour: int) -> date:
    """The local date, the day before while the local hour is before `end_hour`."""
    local = _utc(moment).astimezone(zone)
    return local.date() - timedelta(days=1) if local.hour < end_hour else local.date()


def shop_zone(db: Session, tenant_id: Any):
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    return _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))


@dataclass
class _Ctx:
    """One shop at one moment: its rules, its time zone, today's business and calendar day."""

    db: Session
    shop: Shop
    now: datetime
    cfg: Config
    zone: Any
    today: date
    today_local: date

    @classmethod
    def of(cls, db: Session, shop: Shop, now: Optional[datetime] = None, params: Optional[Dict[str, Any]] = None):
        from app.services import till_parameters as TP

        now = _utc(now) or _now()
        params = TP.resolve_for_shop(db, shop) if params is None else params
        zone = shop_zone(db, shop.tenant_id)
        return cls(
            db=db, shop=shop, now=now, cfg=config_of(params), zone=zone,
            today=business_day(now, zone, end_hour_of(params)),
            today_local=_utc(now).astimezone(zone).date(),
        )

    def holds(self, row: TableAssignment) -> bool:
        """Whether an assignment still holds now under `tableAssignmentReset`."""
        if row.released_at is not None:
            return False
        if self.cfg.reset == RESET_NEVER:
            return True
        if self.cfg.reset == RESET_DAY:
            created = _utc(row.created_at)
            return created is None or created.astimezone(self.zone).date() == self.today_local
        return row.business_day == self.today


# ── Reading ─────────────────────────────────────────────────────────────────────────


def _unreleased(db: Session, shop_id: Any) -> List[TableAssignment]:
    return (
        db.query(TableAssignment)
        .filter(TableAssignment.shop_id == shop_id, TableAssignment.released_at.is_(None))
        .order_by(TableAssignment.created_at.asc(), TableAssignment.id.asc())
        .all()
    )


def live_rows(ctx: _Ctx) -> List[TableAssignment]:
    """The shop's assignments that hold now, oldest first."""
    return [r for r in _unreleased(ctx.db, ctx.shop.id) if ctx.holds(r)]


#: The palette waiters' colours are chosen from, by their order in the shop (`waiter_color`).
PALETTE: Tuple[str, ...] = (
    "#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2",
    "#db2777", "#65a30d", "#ea580c", "#4f46e5", "#0d9488", "#a16207",
)


def clean_color(value: Any) -> Optional[str]:
    """`#RRGGBB` lower case, or None for an empty value; ValueError otherwise."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("table colour must be #RRGGBB")
    text = value.strip()
    if not text:
        return None
    import re

    if not re.match(r"^#[0-9a-fA-F]{6}$", text):
        raise ValueError("table colour must be #RRGGBB")
    return text.lower()


def waiter_color(pos_user: PosUser, rank: int) -> str:
    """Their own colour, else the palette's by their order among the shop's employees."""
    own = getattr(pos_user, "table_color", None)
    try:
        own = clean_color(own)
    except ValueError:
        own = None
    return own or PALETTE[rank % len(PALETTE)]


def shop_users(db: Session, shop_id: Any) -> List[PosUser]:
    """Every till user of the shop (inactive ones too: a colour never moves when one leaves)."""
    rows = db.query(PosUser).filter(PosUser.shop_id == shop_id).all()
    return sorted(rows, key=lambda u: (_utc(u.created_at) or datetime.min.replace(tzinfo=timezone.utc), str(u.id)))


def colors_of(users: Sequence[PosUser]) -> Dict[str, str]:
    """posUserId → colour, for `users` as `shop_users` orders them."""
    return {str(u.id): waiter_color(u, i) for i, u in enumerate(users)}


def initials(name: Optional[str]) -> Optional[str]:
    """"דנה כהן" → "ד.כ"; "דנה" → "ד"."""
    parts = [p for p in (name or "").replace(".", " ").split() if p]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0][0]
    return f"{parts[0][0]}.{parts[-1][0]}"


def _name(pu: Optional[PosUser]) -> Optional[str]:
    from app.services.attendance import pos_user_name

    return pos_user_name(pu)


def on_shift_ids(db: Session, shop_id: Any, now: datetime) -> set:
    """The shop's staff on shift now: an open attendance shift, or signed in at one of its tills."""
    from app.models.attendance import AttendanceShift

    out = set()
    try:
        for (pid,) in (
            db.query(AttendanceShift.pos_user_id)
            .filter(AttendanceShift.shop_id == shop_id, AttendanceShift.clock_out_at.is_(None))
            .all()
        ):
            out.add(str(pid))
    except Exception:  # noqa: BLE001 - no attendance: the signed-in ones
        logger.debug("attendance of shop %s not read", shop_id)
    try:
        from app.services import user_sessions as US

        for s in US.active_sessions_for_shop(db, shop_id, now=now):
            if s.get("posUserId"):
                out.add(str(s["posUserId"]))
    except Exception:  # noqa: BLE001
        logger.debug("signed-in sessions of shop %s not read", shop_id)
    return out


def waiters_out(db: Session, shop_id: Any, now: datetime, *, users: Optional[Sequence[PosUser]] = None) -> List[Dict[str, Any]]:
    """The shop's active employees to assign, each with their colour; on shift first, then by name."""
    users = list(users) if users is not None else shop_users(db, shop_id)
    colors = colors_of(users)
    shift = on_shift_ids(db, shop_id, now)
    rows = []
    for u in users:
        if not u.is_active:
            continue
        name = _name(u)
        rows.append({
            "posUserId": str(u.id),
            "name": name,
            "initials": initials(name),
            "color": colors[str(u.id)],
            "ownColor": getattr(u, "table_color", None),
            "onShift": str(u.id) in shift,
        })
    return sorted(rows, key=lambda r: (not r["onShift"], r["name"] or ""))


def row_out(row: TableAssignment) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "zoneId": str(row.zone_id) if row.zone_id else None,
        "tableId": str(row.table_id) if row.table_id else None,
        "posUserId": str(row.pos_user_id),
        "businessDay": row.business_day.isoformat() if row.business_day else None,
        "assignedBy": row.assigned_by,
        "source": row.source,
        "createdAt": _iso(row.created_at),
        "releasedAt": _iso(row.released_at),
        "releasedReason": row.released_reason,
    }


def effective(rows: Iterable[TableAssignment], tables: Iterable[Any], *, multi: str = MULTI_SINGLE,
              active: Optional[set] = None) -> Dict[str, Dict[str, Any]]:
    """
    tableId → `{via: "table" | "zone", posUserIds}` for every assigned table: its own rows, else its zone's
    (§2). `single`: the latest only; `multi`: each waiter once, the first assigned first (the main one).
    [tables]: rows with `id` and `zone_id`. [active]: the ids of waiters who may still be shown.
    """
    by_table: Dict[str, List[TableAssignment]] = {}
    by_zone: Dict[str, List[TableAssignment]] = {}
    ordered = sorted(
        (r for r in rows if active is None or str(r.pos_user_id) in active),
        key=lambda r: (_utc(r.created_at) or datetime.min.replace(tzinfo=timezone.utc), str(r.id)),
    )
    for r in ordered:
        if r.table_id is not None:
            by_table.setdefault(str(r.table_id), []).append(r)
        elif r.zone_id is not None:
            by_zone.setdefault(str(r.zone_id), []).append(r)

    def users(found: List[TableAssignment]) -> List[str]:
        if multi != MULTI_MULTI:
            return [str(found[-1].pos_user_id)]
        seen: List[str] = []
        for r in found:
            if str(r.pos_user_id) not in seen:
                seen.append(str(r.pos_user_id))
        return seen

    out: Dict[str, Dict[str, Any]] = {}
    for t in tables:
        tid, zid = str(t.id), str(getattr(t, "zone_id", None))
        if tid in by_table:
            out[tid] = {"via": "table", "posUserIds": users(by_table[tid])}
        elif zid in by_zone:
            out[tid] = {"via": "zone", "posUserIds": users(by_zone[zid])}
    return out


@dataclass(frozen=True)
class ShopAssignments:
    """The shop-wide part of the tills' state about assignments (shared between requests)."""

    business_day: Optional[str]
    rows: Tuple[Dict[str, Any], ...]
    waiters: Tuple[Dict[str, Any], ...]
    #: tableId → effective, for every live table of the shop.
    per_table: Dict[str, Dict[str, Any]]


def build_for_state(db: Session, shop: Shop, tables: Sequence[DiningTable], zones: Sequence[TableZone],
                    now: datetime) -> ShopAssignments:
    """What the tables state carries about the shop's assignments (app/services/tables.py)."""
    ctx = _Ctx.of(db, shop, now)
    live_zone_ids = {str(z.id) for z in zones}
    live_table_ids = {str(t.id) for t in tables}
    rows = [
        r for r in live_rows(ctx)
        if (r.zone_id is not None and str(r.zone_id) in live_zone_ids)
        or (r.table_id is not None and str(r.table_id) in live_table_ids)
    ]
    users = shop_users(db, shop.id)
    active = {str(u.id) for u in users if u.is_active}
    rows = [r for r in rows if str(r.pos_user_id) in active]
    waiters = waiters_out(db, shop.id, now, users=users)
    return ShopAssignments(
        business_day=ctx.today.isoformat(),
        rows=tuple(row_out(r) for r in rows),
        waiters=tuple(waiters),
        per_table=effective(rows, tables, multi=ctx.cfg.multi, active=active),
    )


def assigned_to(db: Session, table: DiningTable, *, now: Optional[datetime] = None) -> List[str]:
    """The waiters `table` is assigned to now (the main one first), [] when none."""
    shop = db.get(Shop, table.shop_id)
    if shop is None:
        return []
    ctx = _Ctx.of(db, shop, now)
    rows = [
        r for r in live_rows(ctx)
        if (r.table_id is not None and r.table_id == table.id) or (r.zone_id is not None and r.zone_id == table.zone_id)
    ]
    active = {str(u.id) for u in db.query(PosUser).filter(PosUser.shop_id == shop.id, PosUser.is_active.is_(True)).all()}
    return effective(rows, [table], multi=ctx.cfg.multi, active=active).get(str(table.id), {}).get("posUserIds", [])


def owner_for_new_order(db: Session, machine: Any, table: DiningTable, opener_id: Optional[str],
                        params: Optional[Dict[str, Any]] = None, *, cfg: Optional[Config] = None,
                        now: Optional[datetime] = None) -> Optional[Tuple[str, str]]:
    """
    `tableAssignmentOwner` (§1, §4): a table opened by someone it is not assigned to, with no waiter named
    by the till — (id, name) of the assigned waiter it is recorded on (`assigned`, assignment on); else None.
    [cfg]: the till's parameters already read.
    """
    from app.services import tables as T

    if cfg is None:
        cfg = config_of(params if params is not None else T.machine_params(db, machine))
    if not cfg.on or cfg.owner != OWNER_ASSIGNED:
        return None
    ids = assigned_to(db, table, now=now)
    if not ids or (opener_id and str(opener_id) in ids):
        return None
    pu = db.get(PosUser, _uuid(ids[0]))
    if pu is None:
        return None
    return str(pu.id), _name(pu)


# ── Writing ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Who:
    """Who assigns: a till user (at a till, or the LAN host's), or a dashboard user."""

    name: Optional[str] = None
    pos_user_id: Optional[uuid.UUID] = None
    user_id: Optional[uuid.UUID] = None
    machine_id: Optional[uuid.UUID] = None
    source: str = "till"


def _not_found(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": code})


def _conflict(code: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code, **extra})


def _target(db: Session, shop: Shop, table_id: Any, zone_id: Any) -> Tuple[Optional[DiningTable], Optional[TableZone]]:
    """The live table or zone of the shop a change names (exactly one of them); 404 / 422 otherwise."""
    if (table_id is None) == (zone_id is None):
        raise HTTPException(status_code=422, detail={"code": "target_required"})
    if table_id is not None:
        ident = _uuid(table_id)
        table = db.get(DiningTable, ident) if ident else None
        if table is None or table.shop_id != shop.id or table.archived_at is not None:
            raise _not_found("table_not_found")
        return table, None
    ident = _uuid(zone_id)
    zone = db.get(TableZone, ident) if ident else None
    if zone is None or zone.shop_id != shop.id or zone.archived_at is not None:
        raise _not_found("zone_not_found")
    return None, zone


def _waiter(db: Session, shop: Shop, pos_user_id: Any) -> PosUser:
    ident = _uuid(pos_user_id)
    pu = db.get(PosUser, ident) if ident else None
    if pu is None or not pu.is_active or str(pu.shop_id) != str(shop.id):
        raise _conflict("waiter_not_found")
    return pu


def _on_target(rows: Iterable[TableAssignment], table: Optional[DiningTable], zone: Optional[TableZone]) -> List[TableAssignment]:
    if table is not None:
        return [r for r in rows if r.table_id is not None and r.table_id == table.id]
    return [r for r in rows if r.zone_id is not None and r.zone_id == zone.id]


def _release(rows: Iterable[TableAssignment], reason: str, at: datetime, by: Optional[str]) -> int:
    n = 0
    for r in rows:
        if r.released_at is None:
            r.released_at = at
            r.released_reason = reason
            r.released_by = by
            n += 1
    return n


def sweep(ctx: _Ctx) -> int:
    """
    Release what no longer holds — an earlier day's (`expired`), a zone or table archived since
    (`target_gone`) — before writing: a new row for the same waiter and target may then be made.
    """
    db = ctx.db
    rows = _unreleased(db, ctx.shop.id)
    n = 0
    for r in rows:
        if not ctx.holds(r):
            n += _release([r], "expired", ctx.now, None)
            continue
        target = db.get(DiningTable, r.table_id) if r.table_id is not None else db.get(TableZone, r.zone_id)
        if target is None or target.archived_at is not None:
            n += _release([r], "target_gone", ctx.now, None)
    if n:
        db.flush()
    return n


def _add(ctx: _Ctx, table: Optional[DiningTable], zone: Optional[TableZone], waiter: PosUser, who: Who,
         *, source: Optional[str] = None, row_id: Any = None, created_at: Optional[datetime] = None) -> TableAssignment:
    row = TableAssignment(
        id=_uuid(row_id) or uuid.uuid4(),
        tenant_id=ctx.shop.tenant_id,
        shop_id=ctx.shop.id,
        zone_id=zone.id if zone is not None else None,
        table_id=table.id if table is not None else None,
        pos_user_id=waiter.id,
        business_day=ctx.today,
        assigned_by=who.name,
        assigned_by_pos_user_id=who.pos_user_id,
        assigned_by_user_id=who.user_id,
        source=source or who.source,
        machine_id=who.machine_id,
        created_at=_utc(created_at) or ctx.now,
    )
    ctx.db.add(row)
    return row


def assign(ctx: _Ctx, table: Optional[DiningTable], zone: Optional[TableZone], waiter: PosUser, who: Who) -> bool:
    """One waiter on one target. False when it is so already. `single`: the others on it are replaced."""
    live = [r for r in _on_target(live_rows(ctx), table, zone)]
    if any(r.pos_user_id == waiter.id for r in live):
        if ctx.cfg.multi != MULTI_MULTI:
            _release([r for r in live if r.pos_user_id != waiter.id], "replaced", ctx.now, who.name)
        return False
    if ctx.cfg.multi != MULTI_MULTI:
        _release(live, "replaced", ctx.now, who.name)
    _add(ctx, table, zone, waiter, who)
    return True


def unassign(ctx: _Ctx, table: Optional[DiningTable], zone: Optional[TableZone], pos_user_id: Any, who: Who) -> int:
    """Release a target's assignment — one waiter's, or everyone's when none is named."""
    rows = _on_target(live_rows(ctx), table, zone)
    if pos_user_id is not None:
        ident = _uuid(pos_user_id)
        rows = [r for r in rows if r.pos_user_id == ident]
    return _release(rows, "unassigned", ctx.now, who.name)


def clear(ctx: _Ctx, who: Who, *, reason: str = "clear") -> int:
    """"נקה הכל": every assignment of the shop, released together (one moment: "המשמרת הקודמת")."""
    return _release(live_rows(ctx), reason, ctx.now, who.name)


def _flush(db: Session) -> None:
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        # Two writers at once on the same waiter and target: the other one's stands; try again.
        raise _conflict("assignment_conflict")


def apply_changes(db: Session, shop: Shop, changes: Sequence[Any], who: Who, *, clear_first: bool = False,
                  now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The assignment mode's taps, in order (`changes`: action assign | unassign, posUserId, tableId | zoneId),
    after "נקה הכל" when `clear_first`. All or nothing (the caller commits). Answers the live rows.
    """
    ctx = _Ctx.of(db, shop, now)
    sweep(ctx)
    changed = 0
    if clear_first:
        changed += clear(ctx, who)
        db.flush()
    for ch in changes:
        table, zone = _target(db, shop, getattr(ch, "table_id", None), getattr(ch, "zone_id", None))
        if getattr(ch, "action", "assign") == "unassign":
            changed += unassign(ctx, table, zone, getattr(ch, "pos_user_id", None), who)
        else:
            waiter = _waiter(db, shop, getattr(ch, "pos_user_id", None))
            changed += 1 if assign(ctx, table, zone, waiter, who) else 0
        _flush(db)
    return {"changed": changed, **state_out(ctx)}


def state_out(ctx: _Ctx) -> Dict[str, Any]:
    rows = live_rows(ctx)
    return {"businessDay": ctx.today.isoformat(), "assignments": [row_out(r) for r in rows]}


# ── "העתק שיוך מאתמול" / "מהמשמרת הקודמת" ─────────────────────────────────────────────

COPY_YESTERDAY = "yesterday"
COPY_PREVIOUS_SHIFT = "previous_shift"
#: Rows that ended because someone took them back (not because the day or the shift ended).
_REMOVED = ("unassigned", "replaced", "copy", "target_gone")
#: The resets that end a whole set at one moment (all its rows released together).
_SET_ENDS = ("z", "clear")


def _yesterday(ctx: _Ctx) -> Tuple[Optional[date], List[TableAssignment]]:
    """The latest earlier business day with assignments, and its final set."""
    from sqlalchemy import func

    db = ctx.db
    day = (
        db.query(func.max(TableAssignment.business_day))
        .filter(TableAssignment.shop_id == ctx.shop.id, TableAssignment.business_day < ctx.today)
        .scalar()
    )
    if day is None:
        return None, []
    rows = (
        db.query(TableAssignment)
        .filter(TableAssignment.shop_id == ctx.shop.id, TableAssignment.business_day == day)
        .order_by(TableAssignment.created_at.asc(), TableAssignment.id.asc())
        .all()
    )
    return day, [r for r in rows if r.released_reason not in _REMOVED]


#: The ends of a set one waiter at a time, or by the day running out.
_PIECEMEAL_ENDS = ("expired", "clock_out")


def _previous_shift(ctx: _Ctx) -> Tuple[Dict[str, Any], List[TableAssignment]]:
    """
    The set that ended last, before what holds now:

    * the rows made after the last Z / "נקה הכל" that ended one by one since — the day ran out, the
      waiters clocked out (their latest business day's);
    * else the rows that Z or "נקה הכל" released together (one moment).
    """
    from sqlalchemy import func

    db = ctx.db
    at = _utc(
        db.query(func.max(TableAssignment.released_at))
        .filter(
            TableAssignment.shop_id == ctx.shop.id,
            TableAssignment.released_reason.in_(_SET_ENDS),
            TableAssignment.released_at <= ctx.now,
        )
        .scalar()
    )
    q = db.query(TableAssignment).filter(
        TableAssignment.shop_id == ctx.shop.id, TableAssignment.released_reason.in_(_PIECEMEAL_ENDS),
    )
    if at is not None:
        q = q.filter(TableAssignment.created_at > at)
    if live_rows(ctx):
        # Today's set is still on (some waiters clocked out of it): the one before it.
        q = q.filter(TableAssignment.business_day < ctx.today)
    after = q.order_by(TableAssignment.created_at.asc(), TableAssignment.id.asc()).all()
    if after:
        day = max(r.business_day for r in after)
        return (
            {"kind": COPY_PREVIOUS_SHIFT, "endedAt": None, "businessDay": day.isoformat()},
            [r for r in after if r.business_day == day],
        )
    if at is None:
        return {"kind": COPY_PREVIOUS_SHIFT, "endedAt": None, "businessDay": None}, []
    rows = (
        db.query(TableAssignment)
        .filter(
            TableAssignment.shop_id == ctx.shop.id,
            TableAssignment.released_reason.in_(_SET_ENDS),
            TableAssignment.released_at == at,
        )
        .order_by(TableAssignment.created_at.asc(), TableAssignment.id.asc())
        .all()
    )
    day = max((r.business_day for r in rows), default=None)
    return {"kind": COPY_PREVIOUS_SHIFT, "endedAt": at.isoformat(), "businessDay": day.isoformat() if day else None}, rows


def copy_sources(ctx: _Ctx) -> Dict[str, Any]:
    """What each copy would bring now (the buttons' counts)."""
    day, rows = _yesterday(ctx)
    meta, prev = _previous_shift(ctx)
    return {
        COPY_YESTERDAY: {"businessDay": day.isoformat() if day else None, "count": len(rows)} if rows else None,
        COPY_PREVIOUS_SHIFT: {**meta, "count": len(prev)} if prev else None,
    }


def copy_from(db: Session, shop: Shop, source: str, who: Who, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    Today's assignment becomes the source's: what holds now is released (`copy`), then every row of the
    source whose zone / table and waiter are still there is made again for today. 409 `nothing_to_copy`.
    """
    ctx = _Ctx.of(db, shop, now)
    sweep(ctx)
    if source == COPY_YESTERDAY:
        day, rows = _yesterday(ctx)
        meta = {"kind": COPY_YESTERDAY, "endedAt": None, "businessDay": day.isoformat() if day else None}
    elif source == COPY_PREVIOUS_SHIFT:
        meta, rows = _previous_shift(ctx)
    else:
        raise HTTPException(status_code=422, detail={"code": "copy_source_unknown"})
    if not rows:
        raise _conflict("nothing_to_copy", source=source)
    released = clear(ctx, who, reason="copy")
    db.flush()
    made: List[TableAssignment] = []
    seen = set()
    users = {u.id: u for u in db.query(PosUser).filter(PosUser.shop_id == shop.id, PosUser.is_active.is_(True)).all()}
    # Latest first: under `single` the target's latest waiter is the one copied.
    for r in sorted(rows, key=lambda r: (_utc(r.created_at), str(r.id)), reverse=True):
        waiter = users.get(r.pos_user_id)
        table = db.get(DiningTable, r.table_id) if r.table_id is not None else None
        zone = db.get(TableZone, r.zone_id) if r.zone_id is not None else None
        target = table if table is not None else zone
        if waiter is None or target is None or target.archived_at is not None or target.shop_id != shop.id:
            continue
        key = ("t" if table is not None else "z", str(target.id))
        if (key, waiter.id) in seen or (ctx.cfg.multi != MULTI_MULTI and any(k == key for k, _ in seen)):
            continue
        seen.add((key, waiter.id))
        made.append(_add(ctx, table, zone, waiter, who, source="copy"))
    _flush(db)
    return {"copied": len(made), "released": released, "from": meta, **state_out(ctx)}


# ── The resets (§6 "מתי משתחרר") ───────────────────────────────────────────────────


def changed_after_commit(db: Session, shop_id: Any, tenant_id: Any) -> None:
    """Once `db` commits: the shop's tables version raised and its tills woken (a session of its own)."""
    from app.services import after_commit

    def go() -> None:
        from app.services import tables as T

        own = Session(bind=db.get_bind())
        try:
            T.tables_changed(own, shop_id, tenant_id=tenant_id)
        finally:
            own.close()

    after_commit.run(db, go)


def after_z(db: Session, z: Any, tills: Iterable[Any]) -> int:
    """
    The Z's hook (beside `availability_reopen.after_z`): under `tableAssignmentReset` = z, a Z that closes
    the shop's day — a shop Z, or a till's Z once no other till of the shop has a shift no Z took —
    releases every assignment made before it, at the Z's close (one moment: "המשמרת הקודמת"). Its own
    savepoint, never raising: an assignment never costs a Z.
    """
    try:
        with db.begin_nested():
            return _release_for_z(db, z, list(tills or []))
    except Exception:  # pragma: no cover - logged, the Z goes on
        logger.exception("table assignments not released after Z %s", getattr(z, "id", None))
        return 0


def _release_for_z(db: Session, z: Any, tills: List[Any]) -> int:
    from app.models.pos_machine import POSMachine
    from app.services.availability_reopen import day_end

    shop = db.get(Shop, z.shop_id) if getattr(z, "shop_id", None) else None
    if shop is None:
        return 0
    rows = _unreleased(db, shop.id)
    if not rows:
        return 0
    cfg = shop_config(db, shop)
    if cfg.reset != RESET_Z:
        return 0
    closed_at = _utc(getattr(z, "closed_at", None)) or _now()
    if getattr(z, "machine_id", None) is not None:
        # A till's own Z: the shop's day is over only once every other till's is.
        mine = {getattr(m, "id", None) for m in tills} | {z.machine_id}
        mine.discard(None)
        others = [
            m for m in db.query(POSMachine).filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True)).all()
            if m.id not in mine
        ]
        if day_end(db, shop.id, others, closed_at) is None:
            return 0
    n = _release([r for r in rows if (_utc(r.created_at) or closed_at) <= closed_at], "z", closed_at, "Z")
    if n:
        db.flush()
        changed_after_commit(db, shop.id, shop.tenant_id)
    return n


def on_clock_out(db: Session, shift: Any, at: Optional[datetime] = None, *, now: Optional[datetime] = None) -> int:
    """
    `tableAssignmentOnClockOut` = release: the waiter's clock-out (`shift`, an attendance shift just closed)
    releases their assignments made before it. Their open tables stay theirs. Never raising.
    """
    try:
        with db.begin_nested():
            shop = db.get(Shop, shift.shop_id) if getattr(shift, "shop_id", None) else None
            if shop is None:
                return 0
            ident = _uuid(shift.pos_user_id)
            rows = [r for r in _unreleased(db, shop.id) if r.pos_user_id == ident]
            if not rows:
                return 0
            if shop_config(db, shop).on_clock_out != CLOCK_OUT_RELEASE:
                return 0
            now = _utc(now) or datetime.now(timezone.utc)
            until = _utc(at) or _utc(getattr(shift, "clock_out_at", None)) or now
            n = _release([r for r in rows if (_utc(r.created_at) or until) <= until], "clock_out", now, getattr(shift, "closed_by_name", None))
            if n:
                db.flush()
                changed_after_commit(db, shop.id, shop.tenant_id)
            return n
    except Exception:  # pragma: no cover - logged, the clock-out goes on
        logger.exception("table assignments not released on clock-out of shift %s", getattr(shift, "id", None))
        return 0


# ── The LAN host's copy (§6 "במצב רשת מקומית") ─────────────────────────────────────


def merge_report(db: Session, machine: Any, rows: Sequence[Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    A LAN host's (or a single till's) assignments, merged with the cloud's as a set of rows by id: a row
    the cloud has not seen is added as it was made there (its id, its time, its business day); a row
    released there is released here (a release is final wherever it was made); nothing else of a known row
    changes. Under `single`, of two live rows on one target the latest made stands (the other `replaced`).
    A row on another shop's table, an unknown target or waiter is skipped. Answers what holds in the cloud
    now — the host's set becomes it (plus what it made since it sent this).
    """
    shop = db.get(Shop, machine.shop_id) if getattr(machine, "shop_id", None) else None
    if shop is None:
        raise _conflict("no_shop")
    ctx = _Ctx.of(db, shop, now)
    sweep(ctx)
    accepted: List[str] = []
    skipped: List[str] = []
    for item in rows:
        rid = _uuid(getattr(item, "id", None))
        if rid is None:
            continue
        row = db.get(TableAssignment, rid)
        if row is not None:
            if row.shop_id != shop.id:
                skipped.append(str(rid))
                continue
            released = _utc(getattr(item, "released_at", None))
            if released is not None and row.released_at is None:
                row.released_at = released
                row.released_reason = getattr(item, "released_reason", None) or "unassigned"
                row.released_by = getattr(item, "released_by", None)
            accepted.append(str(rid))
            continue
        try:
            table, zone = _target(db, shop, getattr(item, "table_id", None), getattr(item, "zone_id", None))
        except HTTPException:
            skipped.append(str(rid))
            continue
        pu = db.get(PosUser, _uuid(getattr(item, "pos_user_id", None)))
        if pu is None or str(pu.shop_id) != str(shop.id):
            skipped.append(str(rid))
            continue
        released = _utc(getattr(item, "released_at", None))
        created = _utc(getattr(item, "created_at", None)) or ctx.now
        live_same = [r for r in _on_target(live_rows(ctx), table, zone)]
        if released is None and any(r.pos_user_id == pu.id for r in live_same):
            # The same waiter on the same target, made on both sides: the cloud's row is the one.
            accepted.append(str(rid))
            continue
        who = Who(name=getattr(item, "assigned_by", None), pos_user_id=_uuid(getattr(item, "assigned_by_pos_user_id", None)),
                  machine_id=machine.id, source="lan")
        new = _add(ctx, table, zone, pu, who, row_id=rid, created_at=created)
        if getattr(item, "business_day", None):
            new.business_day = item.business_day
        if released is not None:
            new.released_at = released
            new.released_reason = getattr(item, "released_reason", None) or "unassigned"
            new.released_by = getattr(item, "released_by", None)
        elif ctx.cfg.multi != MULTI_MULTI:
            # Latest made stands.
            newer = [r for r in live_same if (_utc(r.created_at) or created) > created]
            if newer:
                _release([new], "replaced", ctx.now, None)
            else:
                _release(live_same, "replaced", ctx.now, None)
        _flush(db)
        accepted.append(str(rid))
    db.flush()
    return {"accepted": accepted, "skipped": skipped, **state_out(ctx)}


def host_seed_rows(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The live rows a new LAN host starts from (`GET /sync/{m}/tables/host-seed`)."""
    ctx = _Ctx.of(db, shop, now)
    return [row_out(r) for r in live_rows(ctx)]


# ── The dashboard (§3 "בדשבורד ובנייד") ────────────────────────────────────────────


def dashboard_view(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    `GET /tables/assignments`: the shop's parameters, the live rows, the waiters, the copy sources. What
    no longer holds is released first (`sweep`; the caller commits) so the copy sources count it.
    """
    ctx = _Ctx.of(db, shop, now)
    sweep(ctx)
    users = shop_users(db, shop.id)
    active = {str(u.id) for u in users if u.is_active}
    from app.services import tables as T

    zones = T.zones_for(db, shop.id, all_areas=True)
    tables = T.tables_in(db, [z.id for z in zones])
    rows = [r for r in live_rows(ctx) if str(r.pos_user_id) in active]
    return {
        "serverTime": ctx.now.isoformat(),
        "businessDay": ctx.today.isoformat(),
        "config": {**config_out(ctx.cfg), "busy": busy_out(ctx.cfg)},
        "assignments": [row_out(r) for r in rows],
        "waiters": waiters_out(db, shop.id, ctx.now, users=users),
        "tables": effective(rows, tables, multi=ctx.cfg.multi, active=active),
        "copySources": copy_sources(ctx),
    }
