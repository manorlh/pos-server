"""
The request types (§3), the settings fields and their defaults (§4), and the role keys.

**Everything here is a default** (the owner: "הכל דינמי וניתן לשינוי"): a level's own values
(`approval_policy_values`) override any field, field by field (policy.py).

**Role keys** — one vocabulary for `approverRoles`, `limits`, `onShiftOnly` and
`escalationRoles`, covering both permission systems the owner said to use:

* `till:<builtin key>` — a built-in till role ("תפקידים והרשאות בקופה": `till:manager`,
  `till:supervisor`, `till:legacy_manager`…), and `till:<uuid>` — a company's custom till role.
  Read through the approver's linked employee ("עובד מקושר").
* `dash:<UserRole>` — a dashboard role (`dash:company_manager`, `dash:shop_manager`,
  `dash:shift_supervisor`). Read from the dashboard user itself.

**Wire contract**: type keys, field names and role keys are sent to tills and stored in
policy rows — add new ones, never rename one.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

# ── Types ────────────────────────────────────────────────────────────────────

UNIT_AMOUNT = "amount"
UNIT_PERCENT = "percent"
UNIT_COUNT = "count"

#: Limit key per unit (the keys of `till_permissions.LimitSpec` / `limit_covers`).
LIMIT_KEY = {UNIT_AMOUNT: "maxAmount", UNIT_PERCENT: "maxPercent", UNIT_COUNT: "maxCount"}
LIMIT_KEYS = ("maxAmount", "maxPercent", "maxCount")

#: The default reasons (§4), editable per type and level.
DISCOUNT_REASONS = ("מנה לא טעימה", "המתנה ארוכה", "לקוח קבוע", "פיצוי על טעות", "אחר")
REFUND_REASONS = ("לקוח החזיר", "טעות הקלדה", "מנה לא יצאה", "כפל חיוב", "אחר")
DRAWER_REASONS = ("החלפת כסף", "בדיקה", "אחר")


@dataclass(frozen=True)
class RequestType:
    key: str
    label: str
    #: 1 — §3א (blocked today, waiting for a manager's code); 2 — §3ב (new blocks).
    phase: int
    #: What the limit is measured in: amount | percent | count | None (no limit).
    unit: Optional[str]
    #: What the approver sees (§3, for the settings page).
    sees: str
    #: The till permission whose existing limit is the default ceiling ("התקרה הקיימת בתפקיד").
    base_code: Optional[str] = None
    #: Elevation scopes (wire strings) the approval's grant answers for at the endpoints the
    #: cloud already gates with a manager's code (X-Elevation-Token).
    scopes: Tuple[str, ...] = ()
    reasons: Tuple[str, ...] = ()
    reason_required: bool = False
    allow_partial: bool = False
    #: The till permission an approver's linked employee must also hold at `allow` — the right
    #: to do the thing itself, beside "רשאי לאשר מרחוק" (`user_release`: USER_SESSION_RELEASE).
    approver_code: Optional[str] = None
    #: The dashboard permission ("הרשאות דשבורד" section, at edit) a dashboard-role approver must
    #: also hold, with the role it needs (eligibility.py `DASH_GATES`).
    approver_section: Optional[str] = None

    @property
    def permission_code(self) -> str:
        return f"APPROVE_REMOTE.{self.key}"


_A, _P, _C = UNIT_AMOUNT, UNIT_PERCENT, UNIT_COUNT

# fmt: off
TYPES: Tuple[RequestType, ...] = (
    # ── §3א: phase 1 ──
    RequestType("refund", "זיכוי", 1, _A, "מסמך מקורי, שורות, סכום, אמצעי החזר",
                base_code="REFUND", scopes=("refund",), reasons=REFUND_REASONS, reason_required=True,
                allow_partial=True),
    RequestType("document_cancel", "ביטול עסקה או סל", 1, _A, "סל, סכום",
                reasons=REFUND_REASONS, reason_required=True),
    RequestType("line_void", "ביטול שורה", 1, _A, "מנה, שולחן, סכום (מנה שנשלחה למטבח מסומנת)",
                reasons=REFUND_REASONS, reason_required=True),
    RequestType("table_cancel", "ביטול שולחן", 1, _A, "שולחן, מנות, סכום",
                scopes=("table:cancel",), reasons=REFUND_REASONS, reason_required=True),
    RequestType("discount_line", "הנחה על פריט", 1, _P, "פריט, אחוז או סכום",
                base_code="DISCOUNT", scopes=("discount",), reasons=DISCOUNT_REASONS, reason_required=True,
                allow_partial=True),
    RequestType("discount_basket", "הנחה על החשבון", 1, _P, "חשבון, שולחן, אחוז או סכום",
                base_code="DISCOUNT", scopes=("discount",), reasons=DISCOUNT_REASONS, reason_required=True,
                allow_partial=True),
    RequestType("price_override", "שינוי מחיר", 1, _A, "פריט, מחיר מקורי מול חדש (תקרה: ההפרש)",
                reasons=DISCOUNT_REASONS),
    RequestType("oth", "על חשבון הבית", 1, _A, "פריטים, שולחן, סכום",
                scopes=("discount",), reasons=DISCOUNT_REASONS),
    RequestType("drawer_open", "פתיחת מגירה בלי מכירה", 1, None, "קופה", reasons=DRAWER_REASONS),
    # P:/specs/bill-print-other-till.md §9ב–§9ג: the drawer of another till's printer (CASH_DRAWER.OPEN_REMOTE).
    RequestType("drawer_open_remote", "פתיחת מגירה בקופה אחרת", 1, None, "הקופה שבה תיפתח המגירה, הסיבה",
                base_code="CASH_DRAWER.OPEN_REMOTE", reasons=DRAWER_REASONS),
    RequestType("cash_out", "הוצאת מזומן או הפקדה", 1, _A, "סכום",
                base_code="CASH_DRAWER.CASH_OUT", reasons=DRAWER_REASONS, allow_partial=True),
    RequestType("shift_close", "סגירת משמרת או שידור", 1, _A, "צפוי מול נספר (תקרה: ההפרש)",
                scopes=("shift:close", "transmit")),
    RequestType("reprint", "הדפסה חוזרת", 1, None, "מסמך או שולחן"),
    RequestType("table_ops", "פעולות שולחן (שחזור, שחרור נעילה, ביטול)", 1, None, "שולחן",
                scopes=("table:unlock", "table:cancel")),
    RequestType("card_unresolved", "עסקת אשראי לא ידועה", 1, _A, "עסקה, סכום"),
    # "שחרור עובד מחובר" (P:/specs/exclusive-login-v2.md §2): an employee blocked at sign-in asks; the
    # approver must be allowed to release (till: USER_SESSION_RELEASE, dashboard: user_sessions_release).
    # The cloud fills in who is signed in where (app/services/user_sessions.py `approval_payload`); the
    # grant is spent as `X-Elevation-Token` on the till's `claim` with `force`.
    RequestType("user_release", "שחרור עובד מחובר", 1, None, "עובד, המכשיר שבו הוא מחובר ומאז מתי",
                scopes=("user-session:release",), approver_code="USER_SESSION_RELEASE",
                approver_section="user_sessions_release"),
    RequestType("z_close", "הפקת Z", 1, None, "קופה, משמרות פתוחות", scopes=("day:close",)),
    # "מצב לא מקוון לכל המסופונים" (P:/specs/nayax-deferred-all.md §1, §8.1): from the controlling till, only
    # while it is connected (offline — a manager's code, checked at the till). The approver must be allowed
    # to do it (TERMINAL_OFFLINE_ALL; a dashboard role: `terminals_offline` at edit). Nothing in the cloud
    # is gated by it — no scopes.
    RequestType("terminal_offline_all", "מצב לא מקוון לכל המסופונים", 1, None,
                "הקופה המנהלת, הפעלה או כיבוי, כמה קופות",
                base_code="TERMINAL_OFFLINE_ALL", approver_code="TERMINAL_OFFLINE_ALL",
                approver_section="terminals_offline"),
    # ── §3ב: phase 2 ──
    RequestType("refund_no_receipt", "זיכוי בלי מסמך מקורי", 2, _A, "סכום, שורות",
                base_code="REFUND", scopes=("refund",), reasons=REFUND_REASONS, reason_required=True,
                allow_partial=True),
    RequestType("refund_cash", "החזר במזומן לעסקת אשראי", 2, _A, "מסמך מקורי, סכום",
                base_code="REFUND", scopes=("refund",), reasons=REFUND_REASONS, reason_required=True,
                allow_partial=True),
    RequestType("below_cost", "מכירה מתחת למחיר העלות", 2, _A, "פריט, מחיר מול עלות (תקרה: ההפסד)",
                reasons=DISCOUNT_REASONS),
    RequestType("out_of_stock_sale", "מכירת פריט שאזל במלאי", 2, None, "פריט, מלאי"),
    RequestType("employee_meal_over", "ארוחת עובד מעל המכסה", 2, _A, "עובד, סכום, מכסה",
                reasons=DISCOUNT_REASONS),
    RequestType("house_account_over", "הקפה מעל המסגרת", 2, _A, "לקוח, סכום, מסגרת"),
    RequestType("voucher_manual", "מימוש שובר ידני", 2, _A, "שובר, סכום"),
    RequestType("club_adjust", "עדכון ידני במועדון", 2, _A, "חבר, נקודות או יתרה"),
    RequestType("table_reopen", "פתיחה מחדש של חשבון שנסגר", 2, _A, "שולחן, סכום"),
    RequestType("payment_change", "שינוי אמצעי תשלום או טיפ אחרי סגירה", 2, _A, "מסמך, לפני ואחרי"),
    RequestType("installments_over", "תשלומים מעל ברירת המחדל", 2, _C, "סכום, מספר תשלומים"),
    RequestType("manual_card", "הקלדת כרטיס ידנית", 2, _A, "סכום"),
    RequestType("after_hours_sale", "מכירה מחוץ לשעות הפעילות", 2, None, "שעה, סכום"),
    RequestType("opening_float", "עודף פתיחה שונה מהקבוע", 2, _A, "קבוע מול מוקלד (תקרה: ההפרש)",
                reasons=DRAWER_REASONS),
    RequestType("close_other_shift", "סגירת משמרת של עובד אחר", 2, None, "עובד, משמרת"),
    RequestType("tip_over", "טיפ מעל האחוז", 2, _P, "סכום, טיפ, אחוז"),
    RequestType("attendance_fix", "תיקון נוכחות", 2, None, "עובד, שעות מבוקשות (לא חוסם)"),
)
# fmt: on

TYPES_BY_KEY: Dict[str, RequestType] = {t.key: t for t in TYPES}
TYPE_KEYS: Tuple[str, ...] = tuple(TYPES_BY_KEY)
PHASE_1: Tuple[str, ...] = tuple(t.key for t in TYPES if t.phase == 1)


# ── Roles ────────────────────────────────────────────────────────────────────

TILL = "till"
DASH = "dash"
ROLE_KEY_RE = re.compile(r"^(till|dash):[A-Za-z0-9_\-]{1,64}$")

#: The dashboard roles that can be approvers, with their labels.
DASH_ROLES: Tuple[Tuple[str, str], ...] = (
    ("company_manager", "מנהל חברה"),
    ("shop_manager", "מנהל סניף"),
    ("shift_supervisor", "מנהל משמרת (אחמ״ש)"),
    ("distributor", "מפיץ"),
)
DASH_ROLE_LABELS = dict(DASH_ROLES)


def till_role_key(role_key: Optional[str], role_id: Optional[str]) -> Optional[str]:
    """The key of a till role: its built-in key, else its id (a custom role)."""
    if role_key:
        return f"{TILL}:{role_key}"
    if role_id:
        return f"{TILL}:{role_id}"
    return None


def dash_role_key(role: Any) -> str:
    return f"{DASH}:{getattr(role, 'value', role)}"


def builtin_till_roles() -> List[Dict[str, str]]:
    from app.services import till_permissions as TP

    return [{"key": f"{TILL}:{r.key}", "label": r.name, "kind": TILL} for r in TP.BUILTIN_ROLES]


def dash_roles() -> List[Dict[str, str]]:
    return [{"key": f"{DASH}:{k}", "label": label, "kind": DASH} for k, label in DASH_ROLES]


def role_label(key: str, custom: Optional[Dict[str, str]] = None) -> str:
    kind, _, ident = key.partition(":")
    if kind == DASH:
        return DASH_ROLE_LABELS.get(ident, ident)
    from app.services import till_permissions as TP

    builtin = TP.BUILTIN_BY_KEY.get(ident)
    if builtin is not None:
        return builtin.name
    return (custom or {}).get(key, ident)


# ── Fields (§4) and their defaults ───────────────────────────────────────────

METHODS = ("pin", "remote")
PICK_MODES = ("optional", "required", "off")
REASON_MODES = ("required", "optional", "off")
SHIFT_SCOPES = ("shop", "company")

DEFAULT_APPROVER_ROLES = ("till:manager", "till:legacy_manager", "dash:shop_manager", "dash:company_manager")
#: "רק במשמרת": on for a shift supervisor ("אחמ״ש", "מנהל משמרת"), off for a manager.
ON_SHIFT_DEFAULT_ROLES = frozenset({"till:supervisor", "dash:shift_supervisor"})
DEFAULT_TIMEOUT = 180
TIMEOUT_MIN, TIMEOUT_MAX = 30, 1800
ESCALATE_MIN, ESCALATE_MAX = 10, 3600
MAX_REASONS = 20
MAX_REASON_LENGTH = 60
MAX_ROLES = 40


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    #: bool | enum | int | methods | roles | strings | roleLimits | roleBools
    kind: str
    options: Tuple[str, ...] = ()
    minimum: Optional[int] = None
    maximum: Optional[int] = None
    #: The effective value may be null (int fields: off).
    nullable: bool = False


FIELDS: Tuple[FieldSpec, ...] = (
    FieldSpec("enabled", "הסוג פעיל", "bool"),
    FieldSpec("methods", "דרכי אישור", "methods", METHODS),
    FieldSpec("approverRoles", "מי מאשר", "roles"),
    FieldSpec("limits", "תקרה לכל תפקיד", "roleLimits"),
    FieldSpec("onShiftOnly", "רק במשמרת (לכל תפקיד)", "roleBools"),
    FieldSpec("onShiftScope", "מה נחשב במשמרת", "enum", SHIFT_SCOPES),
    FieldSpec("pickApprover", "בחירת מאשר", "enum", PICK_MODES),
    FieldSpec("selfApprove", "מותר לאשר בקשה של עצמך", "bool"),
    FieldSpec("reasonMode", "סיבה", "enum", REASON_MODES),
    FieldSpec("reasons", "סיבות קבועות", "strings"),
    FieldSpec("noteToManager", "הודעה אישית למנהל", "bool"),
    FieldSpec("allowPartial", "אישור חלקי (פחות מהמבוקש)", "bool"),
    FieldSpec("timeoutSeconds", "זמן המתנה (שניות)", "int", minimum=TIMEOUT_MIN, maximum=TIMEOUT_MAX),
    FieldSpec("escalateAfterSeconds", "הסלמה אחרי (שניות, 0 = כבוי)", "int", minimum=0, maximum=ESCALATE_MAX,
              nullable=True),
    FieldSpec("escalationRoles", "הסלמה אל", "roles"),
    FieldSpec("quickApprove", "אישור ישר מההתראה", "bool"),
    FieldSpec("detailsInPush", "פרטים בהתראה", "bool"),
)
FIELDS_BY_KEY: Dict[str, FieldSpec] = {f.key: f for f in FIELDS}
FIELD_KEYS: Tuple[str, ...] = tuple(FIELDS_BY_KEY)


def type_defaults(type_key: str) -> Dict[str, Any]:
    """Every field of one type at its §4 default."""
    t = TYPES_BY_KEY[type_key]
    return {
        "enabled": False,
        "methods": list(METHODS),
        "approverRoles": list(DEFAULT_APPROVER_ROLES),
        "limits": {},
        "onShiftOnly": {key: True for key in sorted(ON_SHIFT_DEFAULT_ROLES)},
        "onShiftScope": "shop",
        "pickApprover": "optional",
        "selfApprove": True,
        "reasonMode": "required" if t.reason_required else "optional",
        "reasons": list(t.reasons),
        "noteToManager": True,
        "allowPartial": t.allow_partial,
        "timeoutSeconds": DEFAULT_TIMEOUT,
        "escalateAfterSeconds": None,
        "escalationRoles": [],
        "quickApprove": False,
        "detailsInPush": True,
    }


def on_shift_only(type_policy: Dict[str, Any], role_key: str) -> bool:
    """"רק במשמרת" for one role: the policy's own word for it, else the role's default."""
    own = type_policy.get("onShiftOnly") or {}
    if isinstance(own, dict) and isinstance(own.get(role_key), bool):
        return own[role_key]
    return role_key in ON_SHIFT_DEFAULT_ROLES


# ── "סגנון האישור" (P:/specs/table-restore-payments.md §4) ────────────────────
#
# Per till permission and level: how a manager answers a permission that needs approval —
# `approve` ("אישור מנהל": the action is the employee's, the manager its approver), `takeover`
# ("מנהל מבצע": the manager does it as themselves, once, the signed-in employee unchanged), or
# `both` (the sheet offers the two). Stored beside the approval settings (`approvalStyle`:
# {code | "*": style}); "*" is a level's word for every permission it does not name.

STYLE_APPROVE = "approve"
STYLE_TAKEOVER = "takeover"
STYLE_BOTH = "both"
STYLES = (STYLE_APPROVE, STYLE_TAKEOVER, STYLE_BOTH)
DEFAULT_STYLE = STYLE_BOTH
STYLE_ALL = "*"


def style_codes() -> List[str]:
    """The till permissions a style can be set for: every one but "רשאי לאשר מרחוק" itself."""
    from app.services import till_permissions as TP

    return [c for c in TP.CODES if c not in TP.REMOTE_APPROVAL_CODES]


def style_allows(style: str, mode: str) -> bool:
    return style == STYLE_BOTH or style == mode


def catalog_json(custom_roles: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
    """What the settings page and the employee card read."""
    return {
        "levels": ["company", "shop", "area", "machine"],
        "types": [
            {"key": t.key, "label": t.label, "phase": t.phase, "limitUnit": t.unit, "sees": t.sees}
            for t in TYPES
        ],
        "roles": builtin_till_roles() + list(custom_roles or []) + dash_roles(),
        "fields": [
            {
                "key": f.key, "label": f.label, "kind": f.kind,
                **({"options": list(f.options)} if f.options else {}),
                **({"min": f.minimum} if f.minimum is not None else {}),
                **({"max": f.maximum} if f.maximum is not None else {}),
                **({"nullable": True} if f.nullable else {}),
            }
            for f in FIELDS
        ],
        "defaults": {"enabled": False, "types": {t.key: type_defaults(t.key) for t in TYPES}},
        "approvalStyle": {
            "options": list(STYLES),
            "default": DEFAULT_STYLE,
            "permissions": _style_permissions(),
        },
    }


def _style_permissions() -> List[Dict[str, Any]]:
    from app.services import till_permissions as TP

    codes = set(style_codes())
    return [
        {"code": p.code, "label": p.label, "group": p.group}
        for p in TP.PERMISSIONS if p.code in codes
    ]
