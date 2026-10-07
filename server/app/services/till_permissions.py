"""
Till users' roles and permissions ("תפקידים והרשאות", docs/SPEC_ROLES_PERMISSIONS.md).

**What this module is.** The one catalogue of what a person signed in at a till may do
(`PERMISSIONS`), the built-in roles a company starts with (`BUILTIN_ROLES`) and their
default matrices (`DEFAULTS`), and the pure function that turns a role, a user's own
overrides and the catalogue into the *effective* answer the till gets on its roster
(`effective_permissions`). The database side (roles per company, assignment, audit) is
`app/services/till_roles.py`; the dashboard's permission grid for *cloud* accounts is
`app/services/permission_matrix.py`, which is a different thing and is not touched here.

**Tri-state.** Every permission is `allow` (מותר — alone), `approval` (דורש אישור מנהל —
a single-action manager override, the requester and the approver both recorded, the
signed-in user never switched) or `deny` (אסור — not offered; no override either).

**Limits.** Some permissions carry a limit (`LimitSpec`): a discount up to X% alone, a
cash out up to ₪X alone. Above the limit an `allow` behaves as `approval`, and the
approver must be someone whose own `allow` covers the amount — which is how "up to ₪200 a
shift supervisor approves, above it a manager" is expressed (spec §7).

**Inheritance, most specific first** (field by field, per permission):

    the user's own override → the role's own value → the role's template → deny

A role's template is its built-in key (`cashier`, `manager`…) or, for a custom role, the
built-in it was created from (`base_key`; a blank custom role starts from `cashier`).
A permission added to the catalogue later therefore gets a sensible value in every role
without a migration, and an unknown code is never granted.

**Wire contract.** Permission codes are sent to tills and stored in role rows: add new
codes, never rename or repurpose one. `Scope` strings (elevation) map onto codes through
`SCOPE_PERMISSIONS`; older tills keep reading the legacy `role` (`cashier` /
`shop_manager`), which every role still carries (`legacy_role_for`).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, Optional, Tuple

ALLOW = "allow"
APPROVAL = "approval"
DENY = "deny"
STATES: Tuple[str, ...] = (ALLOW, APPROVAL, DENY)
STATE_LABELS = {ALLOW: "מותר", APPROVAL: "דורש אישור מנהל", DENY: "אסור"}

#: Kinds of till device a permission concerns (informational for the dashboard; the till
#: ignores what does not apply to it — a handheld has no cash drawer).
DEVICE_TILL = "till"
DEVICE_TABLET = "tablet"
DEVICE_MOBILE = "mobile"
DEVICES: Tuple[str, ...] = (DEVICE_TILL, DEVICE_TABLET, DEVICE_MOBILE)
DEVICE_LABELS = {DEVICE_TILL: "קופה", DEVICE_TABLET: "טאבלט", DEVICE_MOBILE: "קופה ניידת"}
_ALL = DEVICES
_FIXED = (DEVICE_TILL, DEVICE_TABLET)

GROUPS: Tuple[Tuple[str, str], ...] = (
    ("sale", "מכירה"),
    ("tables", "שולחנות"),
    ("shift", "משמרת, Z ודוחות"),
    ("drawer", "מגירת מזומן ותנועות מזומן"),
    ("admin", "ניהול בקופה"),
)


@dataclass(frozen=True)
class LimitSpec:
    key: str
    label: str
    #: percent | amount
    unit: str
    minimum: float = 0
    maximum: float = 1_000_000


@dataclass(frozen=True)
class PermissionSpec:
    code: str
    label: str
    group: str
    description: str
    devices: Tuple[str, ...] = _ALL
    limits: Tuple[LimitSpec, ...] = ()
    #: The elevation scope (wire string) this permission answers for, if any.
    scope: Optional[str] = None


_MAX_PERCENT = LimitSpec("maxPercent", "עד % ללא אישור", "percent", 0, 100)
_MAX_AMOUNT = LimitSpec("maxAmount", "עד סכום (₪) ללא אישור", "amount", 0, 1_000_000)

# fmt: off
PERMISSIONS: Tuple[PermissionSpec, ...] = (
    # ── מכירה ──
    PermissionSpec("SELL", "מכירה מהירה", "sale",
                   "פתיחת הזמנה מהירה במסך המכירה, הוספת פריטים וסגירת עסקה (לא דרך שולחן)."),
    PermissionSpec("CALCULATOR.USE", "מחשבון — מכירה בסכום חופשי", "sale",
                   "לשונית \"מחשבון\" במסך המכירה: כל סכום שמוקלד נמכר כשורה של הפריט הכללי של הקטלוג "
                   "(מכירה בסכום חופשי, בלי לבחור מוצר)."),
    PermissionSpec("PRICE_OVERRIDE", "הקלדת מחיר לפריט במחיר פתוח", "sale",
                   "הוספת מוצר שמוגדר \"מחיר פתוח\" עם מחיר שהעובד מקליד."),
    PermissionSpec("DISCOUNT", "הנחה (סל / שורה)", "sale",
                   "הנחת סל או הנחת שורה, וגם פתיחת ארוחת צוות / מנהל בשולחן. מעל האחוז שהוגדר נדרש אישור "
                   "של מי שמותר לו אחוז כזה.", limits=(_MAX_PERCENT,), scope="discount"),
    PermissionSpec("LINE_VOID", "ביטול שורה", "sale",
                   "הסרת שורה שכבר נוספה להזמנה (לפני תשלום / לפני שליחה למטבח). נרשם כאירוע קופה."),
    PermissionSpec("OTH", "על חשבון הבית (OTH)", "sale",
                   "מתן פריט על חשבון הבית, עם סיבה. כשהפרמטר \"OTH — באישור מנהל\" כבוי, \"דורש אישור\" "
                   "נחשב \"מותר\" (כמו היום)."),
    PermissionSpec("REFUND", "זיכוי / החזר", "sale",
                   "זיכוי מסמך או החזר בסל (כולל החזר מזומן). מעל הסכום שהוגדר נדרש אישור.",
                   limits=(_MAX_AMOUNT,), scope="refund"),
    PermissionSpec("REPRINT", "הדפסה חוזרת", "sale",
                   "הדפסה חוזרת של חשבון / בונים בשולחן.", scope="table:reprint"),
    # ── שולחנות ──
    PermissionSpec("TABLES.USE", "מודול שולחנות", "tables",
                   "כניסה למסך השולחנות, פתיחת שולחן ועבודה עליו."),
    PermissionSpec("TABLES.OPEN_OTHERS", "עבודה על שולחן של מלצר אחר", "tables",
                   "כניסה לשולחן שפתח (או משויך ל) מלצר אחר."),
    PermissionSpec("TABLE_CANCEL", "ביטול שולחן", "tables",
                   "ביטול הזמנה פתוחה של שולחן, עם סיבה.", scope="table:cancel"),
    PermissionSpec("TABLE_VOID", "ביטול פריט שנשלח למטבח", "tables",
                   "הורדת פריטים שכבר נשלחו למטבח.", scope="table:void"),
    PermissionSpec("TABLE_RESTORE", "שחזור שולחן", "tables",
                   "החזרת שולחן שנסגר / בוטל.", scope="table:restore"),
    PermissionSpec("TABLE_UNLOCK", "שחרור נעילת שולחן", "tables",
                   "שחרור שולחן שקופה אחרת נעלה, או השתלטות על קופה מארחת.", scope="table:unlock"),
    # ── משמרת ודוחות ──
    PermissionSpec("SHIFT_OPEN", "פתיחת משמרת", "shift", "פתיחת משמרת קופה עם קרן פתיחה."),
    PermissionSpec("SHIFT_CLOSE", "סגירת משמרת", "shift",
                   "סגירת משמרת וספירת קופה (X סוגר).", scope="shift:close"),
    PermissionSpec("X", "דוח X", "shift", "הצגה והדפסה של דוח X ביניים למשמרת."),
    PermissionSpec("Z", "סגירת Z בקופה", "shift",
                   "סגירת יום (Z) מהקופה, במצב \"Z לכל קופה\".", scope="day:close"),
    PermissionSpec("TRANSMIT", "שידור עסקאות אשראי", "shift",
                   "שידור ידני של עסקאות האשראי לשב\"א ופעולות מצב לא מקוון של המסוף.", scope="transmit"),
    PermissionSpec("VIEW_REPORTS", "דוחות בקופה", "shift",
                   "תפריט \"דוחות\" בקופה: מכירות מוצרים, עובדים, שולחנות, טיפים והיסטוריית משמרות."),
    # ── מגירת מזומן (spec §2) ──
    PermissionSpec("CASH_DRAWER.OPEN_ON_CASH_SALE", "פתיחה בעסקת מזומן", "drawer",
                   "פתיחה אוטומטית אחרי שתשלום המזומן נרשם והעסקה הושלמה.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.OPEN_MANUALLY", "פתיחה ידנית", "drawer",
                   "\"פתח מגירה\" בלי עסקה, עם סיבה.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.OPEN_FOR_CHANGE", "פריטת כסף / מתן עודף", "drawer",
                   "פתיחה ידנית לפריטת כסף או למתן עודף.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.CASH_IN", "הכנסת מזומן (Cash In)", "drawer",
                   "הכנסת מזומן למגירה — מגדילה את היתרה הצפויה.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.CASH_OUT", "הוצאת מזומן (Cash Out)", "drawer",
                   "הוצאת מזומן מהמגירה — מקטינה את היתרה הצפויה. מעל הסכום שהוגדר נדרש אישור.",
                   devices=_FIXED, limits=(_MAX_AMOUNT,)),
    PermissionSpec("CASH_DRAWER.DEPOSIT", "הפקדה / ריקון חלקי", "drawer",
                   "הפקדה או ריקון חלקי של המגירה — נשמרת בנפרד מ-Cash Out.", devices=_FIXED,
                   limits=(_MAX_AMOUNT,)),
    PermissionSpec("CASH_DRAWER.COUNT", "ספירת מגירה", "drawer",
                   "פתיחה לצורך ספירת מגירה (ספירה רגילה — היתרה הצפויה מוצגת).", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.BLIND_COUNT", "ספירה עיוורת (Blind Count)", "drawer",
                   "ספירה בלי לראות את היתרה הצפויה; הצפוי והפער מוצגים רק אחרי אישור הסכום. "
                   "כשהפרמטר \"הפעל Blind Count\" מופעל, כל ספירה (כולל בסגירת משמרת) היא עיוורת "
                   "ונבדקת לפי הרשאה זו.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.OPEN_FOR_TEST", "בדיקה טכנית", "drawer",
                   "פתיחת המגירה לבדיקת חומרה (אבחון / מדפסות).", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.APPROVE_OPEN", "אישור פעולת מגירה לעובד אחר", "drawer",
                   "רשאי לאשר (Manager Override) פעולת מגירה / מזומן של עובד אחר.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.OPEN_AFTER_CLOSE", "פתיחה לאחר סגירת קופה / Z", "drawer",
                   "פתיחת מגירה כשאין משמרת פתוחה (אחרי סגירה / Z). תמיד נרשמת כחריגה.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.VIEW_LOG", "צפייה בלוג פתיחות", "drawer",
                   "יומן פתיחות המגירה בקופה.", devices=_FIXED),
    PermissionSpec("CASH_DRAWER.VIEW_CASH_MOVEMENTS", "צפייה בתנועות מזומן", "drawer",
                   "תנועות המזומן במשמרת והיתרה הצפויה.", devices=_FIXED),
    # ── ניהול בקופה ──
    PermissionSpec("CATALOG_WRITE", "עריכת קטלוג מהקופה", "admin",
                   "עריכת מוצרים, עיצוב מסך, נעילת מוצר, שמות שולחנות ומפה, מדפסות ומסופון.",
                   scope="catalog:write"),
    PermissionSpec("ATTENDANCE_MANAGE", "נוכחות — אישור מנהל", "admin",
                   "יציאה ממשמרת עם שולחנות פתוחים / סיום משמרת שדורש אישור מנהל.",
                   scope="attendance:manage"),
    PermissionSpec("USER_SESSION_RELEASE", "שחרור עובד מחובר בקופה אחרת", "admin",
                   "שחרור עובד שמחובר בקופה אחרת כדי שיתחבר כאן.", scope="user-session:release"),
    PermissionSpec("CARD_UNRESOLVED", "עסקת אשראי לא ידועה — סימון כלא אושרה", "admin",
                   "\"סמן כלא אושר והמשך\" בעסקת אשראי שתוצאתה לא ידועה.", scope="card:unresolved"),
    PermissionSpec("KIOSK_CONTROL", "שליטה בקיוסק", "admin",
                   "נעילה למכירה / פתיחה אוטומטית של קיוסק שהקופה שולטת בו.", devices=_FIXED,
                   scope="kiosk:control"),
    PermissionSpec("KIOSK_UNLOCK", "יציאה מנעילת קופה (קיוסק)", "admin",
                   "יציאה ממצב נעילה לתחזוקה.", scope="kiosk:unlock"),
)
# fmt: on

PERMISSIONS_BY_CODE: Dict[str, PermissionSpec] = {p.code: p for p in PERMISSIONS}
CODES: Tuple[str, ...] = tuple(PERMISSIONS_BY_CODE)

#: Elevation scope (wire) → permission code. Includes the scopes only the till knows.
SCOPE_PERMISSIONS: Dict[str, str] = {p.scope: p.code for p in PERMISSIONS if p.scope}


# ── Built-in roles ─────────────────────────────────────────────────────────────

WAITER = "waiter"
CASHIER = "cashier"
SUPERVISOR = "supervisor"
MANAGER = "manager"
#: Today's two till roles, kept exactly as they behave now: every existing till user is
#: on one of these until a manager moves them (spec "migration", §SPEC 6).
LEGACY_CASHIER = "legacy_cashier"
LEGACY_MANAGER = "legacy_manager"

LEGACY_FOR_ROLE = {"cashier": LEGACY_CASHIER, "shop_manager": LEGACY_MANAGER}
#: "החל ברירות מחדל לפי האפיון": where the legacy roles' users go.
SPEC_ROLE_FOR_LEGACY = {LEGACY_CASHIER: CASHIER, LEGACY_MANAGER: MANAGER}


@dataclass(frozen=True)
class BuiltinRole:
    key: str
    name: str
    description: str
    sort_order: int
    legacy: bool = False


BUILTIN_ROLES: Tuple[BuiltinRole, ...] = (
    BuiltinRole(WAITER, "מלצר", "עבודה בשולחנות ומכירה; פעולות מגירה ידניות באישור, ללא הוצאת מזומן.", 10),
    BuiltinRole(CASHIER, "קופאי", "מכירה, שולחנות ותשלומים; פעולות כסף רגישות באישור מנהל.", 20),
    BuiltinRole(SUPERVISOR, "אחמ״ש", "אחראי משמרת: מאשר פעולות לעובדים, Cash Out עד הסף, ללא עריכת קטלוג.", 30),
    BuiltinRole(MANAGER, "מנהל", "כל ההרשאות.", 40),
    BuiltinRole(LEGACY_CASHIER, "קופאי (הרשאות קודמות)",
                "בדיוק כמו קופאי לפני המעבר לתפקידים: הכול מותר מלבד הפעולות שדרשו אישור מנהל.", 90, legacy=True),
    BuiltinRole(LEGACY_MANAGER, "מנהל חנות (הרשאות קודמות)",
                "בדיוק כמו מנהל חנות לפני המעבר לתפקידים: הכול מותר.", 91, legacy=True),
)
BUILTIN_BY_KEY: Dict[str, BuiltinRole] = {r.key: r for r in BUILTIN_ROLES}
SPEC_ROLE_KEYS: Tuple[str, ...] = (WAITER, CASHIER, SUPERVISOR, MANAGER)

#: What `TillAuthority.SENIOR_MAY_ACT_ALONE` gated for a cashier before roles existed —
#: the permissions a legacy cashier needs approval for (OTH rode on the discount scope).
LEGACY_APPROVAL_CODES: FrozenSet[str] = frozenset({
    "REFUND", "DISCOUNT", "OTH", "CATALOG_WRITE", "TRANSMIT", "TABLE_CANCEL", "TABLE_UNLOCK",
    "REPRINT", "TABLE_VOID", "TABLE_RESTORE", "USER_SESSION_RELEASE", "KIOSK_UNLOCK",
    "KIOSK_CONTROL", "ATTENDANCE_MANAGE", "CARD_UNRESOLVED",
})
#: Approving for others was a shop manager's alone.
LEGACY_CASHIER_DENIED: FrozenSet[str] = frozenset({"CASH_DRAWER.APPROVE_OPEN"})


def _matrix(**states: str) -> Dict[str, str]:
    return dict(states)


A, P, D = ALLOW, APPROVAL, DENY

# fmt: off
#: code → (waiter, cashier, supervisor, manager). The drawer rows are the spec's §3 matrix.
_SPEC_MATRIX: Dict[str, Tuple[str, str, str, str]] = {
    "SELL":                              (A, A, A, A),
    "CALCULATOR.USE":                    (D, A, A, A),
    "PRICE_OVERRIDE":                    (P, A, A, A),
    "DISCOUNT":                          (P, P, A, A),
    "LINE_VOID":                         (A, A, A, A),
    "OTH":                               (P, P, A, A),
    "REFUND":                            (D, P, A, A),
    "REPRINT":                           (P, P, A, A),
    "TABLES.USE":                        (A, A, A, A),
    "TABLES.OPEN_OTHERS":                (P, A, A, A),
    "TABLE_CANCEL":                      (P, P, A, A),
    "TABLE_VOID":                        (P, P, A, A),
    "TABLE_RESTORE":                     (D, P, A, A),
    "TABLE_UNLOCK":                      (P, P, A, A),
    "SHIFT_OPEN":                        (A, A, A, A),
    "SHIFT_CLOSE":                       (A, A, A, A),
    "X":                                 (A, A, A, A),
    "Z":                                 (D, P, A, A),
    "TRANSMIT":                          (D, P, A, A),
    "VIEW_REPORTS":                      (D, A, A, A),
    # spec §3 — פתיחה בעסקת מזומן / ידנית / פריטה / Cash Out / הפקדה / ספירה / בדיקה / אחרי Z / לוג
    "CASH_DRAWER.OPEN_ON_CASH_SALE":     (A, A, A, A),
    "CASH_DRAWER.OPEN_MANUALLY":         (P, P, A, A),
    "CASH_DRAWER.OPEN_FOR_CHANGE":       (P, P, A, A),
    "CASH_DRAWER.CASH_IN":               (D, A, A, A),
    "CASH_DRAWER.CASH_OUT":              (D, P, A, A),
    "CASH_DRAWER.DEPOSIT":               (D, P, A, A),
    "CASH_DRAWER.COUNT":                 (D, P, A, A),
    "CASH_DRAWER.BLIND_COUNT":           (D, A, A, A),
    "CASH_DRAWER.OPEN_FOR_TEST":         (D, D, P, A),
    "CASH_DRAWER.APPROVE_OPEN":          (D, D, A, A),
    "CASH_DRAWER.OPEN_AFTER_CLOSE":      (D, D, P, A),
    "CASH_DRAWER.VIEW_LOG":              (D, D, A, A),
    "CASH_DRAWER.VIEW_CASH_MOVEMENTS":   (D, D, A, A),
    "CATALOG_WRITE":                     (D, P, P, A),
    "ATTENDANCE_MANAGE":                 (P, P, A, A),
    "USER_SESSION_RELEASE":              (P, P, A, A),
    "CARD_UNRESOLVED":                   (P, P, A, A),
    "KIOSK_CONTROL":                     (D, P, A, A),
    "KIOSK_UNLOCK":                      (D, P, P, A),
}
# fmt: on

#: The spec's example (§7): a supervisor takes cash out up to ₪200 alone (and approves it
#: for others up to that); above it, a manager.
_SPEC_LIMITS: Dict[str, Dict[str, Dict[str, float]]] = {
    WAITER: {},
    CASHIER: {},
    SUPERVISOR: {
        "CASH_DRAWER.CASH_OUT": {"maxAmount": 200},
        "CASH_DRAWER.DEPOSIT": {"maxAmount": 200},
        "DISCOUNT": {"maxPercent": 30},
    },
    MANAGER: {},
}


def _legacy_cashier_states() -> Dict[str, str]:
    out: Dict[str, str] = {}
    for code in CODES:
        if code in LEGACY_APPROVAL_CODES:
            out[code] = APPROVAL
        elif code in LEGACY_CASHIER_DENIED:
            out[code] = DENY
        else:
            out[code] = ALLOW
    return out


def _spec_states(index: int) -> Dict[str, str]:
    return {code: _SPEC_MATRIX[code][index] for code in CODES}


DEFAULTS: Dict[str, Dict[str, str]] = {
    WAITER: _spec_states(0),
    CASHIER: _spec_states(1),
    SUPERVISOR: _spec_states(2),
    MANAGER: _spec_states(3),
    LEGACY_CASHIER: _legacy_cashier_states(),
    LEGACY_MANAGER: {code: ALLOW for code in CODES},
}
DEFAULT_LIMITS: Dict[str, Dict[str, Dict[str, float]]] = {
    **_SPEC_LIMITS,
    LEGACY_CASHIER: {},
    LEGACY_MANAGER: {},
}

#: The template of a blank custom role.
CUSTOM_TEMPLATE = CASHIER


# ── Validation ─────────────────────────────────────────────────────────────────


class PermissionValueError(ValueError):
    """A state, code or limit the catalogue does not accept. Message is safe to show."""


def clean_states(payload: Any, *, allow_unknown: bool = False) -> Dict[str, str]:
    """`{code: state}` validated; unknown codes refused (or dropped with `allow_unknown`)."""
    if payload is None:
        return {}
    if not isinstance(payload, Mapping):
        raise PermissionValueError("permissions must be an object")
    out: Dict[str, str] = {}
    for code, state in payload.items():
        if code not in PERMISSIONS_BY_CODE:
            if allow_unknown:
                continue
            raise PermissionValueError(f"unknown permission {code!r}")
        if state is None:
            continue
        if state not in STATES:
            raise PermissionValueError(f"{code}: state must be one of {', '.join(STATES)}")
        out[code] = state
    return out


def clean_limits(payload: Any, *, allow_unknown: bool = False) -> Dict[str, Dict[str, float]]:
    """`{code: {limitKey: number | null}}` validated; a null value means "no limit set here"."""
    if payload is None:
        return {}
    if not isinstance(payload, Mapping):
        raise PermissionValueError("limits must be an object")
    out: Dict[str, Dict[str, float]] = {}
    for code, values in payload.items():
        spec = PERMISSIONS_BY_CODE.get(code)
        if spec is None:
            if allow_unknown:
                continue
            raise PermissionValueError(f"unknown permission {code!r}")
        if values is None:
            continue
        if not isinstance(values, Mapping):
            raise PermissionValueError(f"{code}: limits must be an object")
        known = {lim.key: lim for lim in spec.limits}
        cleaned: Dict[str, float] = {}
        for key, value in values.items():
            lim = known.get(key)
            if lim is None:
                if allow_unknown:
                    continue
                raise PermissionValueError(f"{code}: unknown limit {key!r}")
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
                raise PermissionValueError(f"{code}.{key} must be a number")
            if value < lim.minimum or value > lim.maximum:
                raise PermissionValueError(f"{code}.{key} must be between {lim.minimum:g} and {lim.maximum:g}")
            cleaned[key] = int(value) if float(value).is_integer() else float(value)
        if cleaned:
            out[code] = cleaned
    return out


# ── Resolution ─────────────────────────────────────────────────────────────────


@dataclass
class EffectivePermissions:
    """What one till user may do: every catalogue code, and the limits that apply."""

    states: Dict[str, str]
    limits: Dict[str, Dict[str, float]]
    role_id: Optional[str] = None
    role_key: Optional[str] = None
    role_name: Optional[str] = None
    #: Per code, where the state came from: override | role | template.
    sources: Dict[str, str] = field(default_factory=dict)

    def state(self, code: str) -> str:
        return self.states.get(code, DENY)

    def allows(self, code: str) -> bool:
        return self.state(code) == ALLOW

    @property
    def legacy_role(self) -> str:
        return legacy_role_for(self.states)


def template_of(builtin_key: Optional[str], base_key: Optional[str]) -> str:
    """The built-in whose defaults fill what a role does not set itself."""
    for key in (builtin_key, base_key):
        if key in DEFAULTS:
            return key
    return CUSTOM_TEMPLATE


def effective_permissions(
    *,
    role_states: Optional[Mapping[str, str]] = None,
    role_limits: Optional[Mapping[str, Mapping[str, float]]] = None,
    template: str = LEGACY_CASHIER,
    overrides: Optional[Mapping[str, Any]] = None,
    role_id: Optional[str] = None,
    role_key: Optional[str] = None,
    role_name: Optional[str] = None,
) -> EffectivePermissions:
    """
    Pure: user override → role value → the role's template → deny, per code; the same
    order per limit key. Unknown codes in any input are ignored (never granted).
    """
    own_states = clean_states(role_states or {}, allow_unknown=True)
    own_limits = clean_limits(role_limits or {}, allow_unknown=True)
    ov = overrides if isinstance(overrides, Mapping) else {}
    ov_states = clean_states(ov.get("states") or {}, allow_unknown=True)
    ov_limits = clean_limits(ov.get("limits") or {}, allow_unknown=True)
    base_states = DEFAULTS.get(template, DEFAULTS[CUSTOM_TEMPLATE])
    base_limits = DEFAULT_LIMITS.get(template, {})

    states: Dict[str, str] = {}
    sources: Dict[str, str] = {}
    limits: Dict[str, Dict[str, float]] = {}
    for spec in PERMISSIONS:
        code = spec.code
        if code in ov_states:
            states[code], sources[code] = ov_states[code], "override"
        elif code in own_states:
            states[code], sources[code] = own_states[code], "role"
        else:
            states[code], sources[code] = base_states.get(code, DENY), "template"
        merged: Dict[str, float] = {}
        for lim in spec.limits:
            for layer in (ov_limits, own_limits, base_limits):
                value = (layer.get(code) or {}).get(lim.key)
                if value is not None:
                    merged[lim.key] = value
                    break
        if merged:
            limits[code] = merged
    return EffectivePermissions(
        states=states, limits=limits, role_id=role_id, role_key=role_key, role_name=role_name, sources=sources,
    )


def legacy_effective(role: Any) -> EffectivePermissions:
    """A till user with no till role yet: exactly what their legacy `role` allowed."""
    key = LEGACY_FOR_ROLE.get(_role_value(role), LEGACY_CASHIER)
    builtin = BUILTIN_BY_KEY[key]
    return effective_permissions(template=key, role_key=key, role_name=builtin.name)


def _role_value(role: Any) -> str:
    value = getattr(role, "value", role)
    return str(value or "").strip().lower()


#: What makes a role a "shop_manager" for a till that predates roles: it may do alone
#: everything such a till let a shop manager do alone. Anything less reads as a cashier
#: there — the direction to fail in.
LEGACY_SENIOR_CODES: FrozenSet[str] = LEGACY_APPROVAL_CODES


def legacy_role_for(states: Mapping[str, str]) -> str:
    """`shop_manager` or `cashier`: what an older till (reading `role` only) is told."""
    if all(states.get(code) == ALLOW for code in LEGACY_SENIOR_CODES):
        return "shop_manager"
    return "cashier"


def scopes_allowed(eff: EffectivePermissions, scopes: Iterable[str]) -> List[str]:
    """The elevation scopes (wire strings) this user may hold — those mapped to `allow`."""
    out: List[str] = []
    for scope in scopes:
        code = SCOPE_PERMISSIONS.get(str(scope))
        if code is not None and eff.allows(code) and scope not in out:
            out.append(scope)
    return out


def limit_covers(eff: EffectivePermissions, code: str, *, amount: Optional[float] = None,
                 percent: Optional[float] = None) -> bool:
    """True when `eff` may do `code` alone at this amount / percent (state allow, within limits)."""
    if not eff.allows(code):
        return False
    lim = eff.limits.get(code) or {}
    if amount is not None and lim.get("maxAmount") is not None and abs(amount) > lim["maxAmount"]:
        return False
    if percent is not None and lim.get("maxPercent") is not None and percent > lim["maxPercent"]:
        return False
    return True


# ── The catalogue as the dashboard reads it ────────────────────────────────────


def catalogue_out() -> Dict[str, Any]:
    return {
        "states": [{"key": s, "label": STATE_LABELS[s]} for s in STATES],
        "devices": [{"key": d, "label": DEVICE_LABELS[d]} for d in DEVICES],
        "groups": [{"key": k, "label": label} for k, label in GROUPS],
        "permissions": [
            {
                "code": p.code,
                "label": p.label,
                "group": p.group,
                "description": p.description,
                "devices": list(p.devices),
                "scope": p.scope,
                "limits": [
                    {"key": lim.key, "label": lim.label, "unit": lim.unit, "min": lim.minimum, "max": lim.maximum}
                    for lim in p.limits
                ],
            }
            for p in PERMISSIONS
        ],
        "builtinRoles": [
            {
                "key": r.key,
                "name": r.name,
                "description": r.description,
                "legacy": r.legacy,
                "permissions": DEFAULTS[r.key],
                "limits": DEFAULT_LIMITS.get(r.key, {}),
            }
            for r in BUILTIN_ROLES
        ],
        "specRoleKeys": list(SPEC_ROLE_KEYS),
    }
