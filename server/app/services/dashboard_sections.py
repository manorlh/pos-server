"""
"הרשאות דשבורד": the sections ("לשוניות") of the cloud dashboard, and which API route belongs
to which section.

Two tables, both read by the enforcement in app/services/dashboard_access.py:

* `SECTIONS` — the catalogue the super admin grants from, one entry per group of dashboard
  pages (the dashboard's copy is client/src/lib/dashboardAccess.ts; a test keeps the ids equal).
* `ROUTE_RULES` — every dashboard API route, by method and path, mapped to the section(s) it
  serves and the level it needs (a read is "view", a write is "edit", unless the rule says
  otherwise — a POST that only previews is a read). First match wins, so the specific rules
  come before the catch-alls of their prefix.

Besides sections, a route can be:

* `SELF` — about the caller themselves (`/users/me`, `/tenants/mine`): always allowed.
* `REFERENCE` — the look-ups every page leans on (the org tree for the scope bar). Allowed to
  anyone signed in; the rows are still the caller's own (role + org scope), not everyone's.
* `TILL` — a till's own paths (`/sync/{machine_id}/…`) that also accept a dashboard token. The
  dashboard never calls them; a restricted dashboard user is refused.
* `SUPER_ADMIN` — the super admin's own (checked by the route). A restricted user is refused.
* `ANY_EDIT` — a utility any editor needs (uploading an image): allowed with edit on any section.

Nothing here widens anything: a section grant only lets the route's own role and org checks
run; it never replaces them. tests/test_dashboard_access.py walks `app.routes` — a dashboard
route with no rule fails the build, and the whole route → section map is pinned in
tests/fixtures/dashboard_route_sections.txt, so a route cannot land in a section unnoticed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, List, Optional, Tuple

VIEW = "view"
EDIT = "edit"
LEVELS = (VIEW, EDIT)


@dataclass(frozen=True)
class Section:
    id: str
    #: The name the super admin sees ("לשונית").
    label: str
    #: What it covers, for the permissions dialog.
    hint: str
    #: The dashboard pages (hrefs) this section opens — the dashboard keeps the same list.
    pages: Tuple[str, ...]


SECTIONS: Tuple[Section, ...] = (
    Section(
        "reports", "דוחות",
        "סקירה, דוחות מכירות, עסקאות, תובנות, התאמות, שידורים, אירועים, חריגים, יומן חריגות, מגירת "
        "מזומן ודוח למס הכנסה. עריכה: אירועים, סקירת חריגים וטיפול ביומן, עלויות מוצרים, זיכוי מרחוק וזיכוי "
        "באשראי מהענן.",
        (
            "/dashboard", "/dashboard/live-items", "/dashboard/compare", "/dashboard/insights",
            "/dashboard/insights/kiosks", "/dashboard/transactions", "/dashboard/day-summary",
            "/dashboard/all-in-one", "/dashboard/reconciliation", "/dashboard/transmissions",
            "/dashboard/events", "/dashboard/offline-transactions", "/dashboard/product-sales",
            "/dashboard/cashier-sales", "/dashboard/area-sales", "/dashboard/tips",
            "/dashboard/sales-by-payment", "/dashboard/card-brands", "/dashboard/promotions-report",
            "/dashboard/menu-reports", "/dashboard/hourly-sales", "/dashboard/department-sales",
            "/dashboard/document-sequence", "/dashboard/cash-variance", "/dashboard/exceptions",
            "/dashboard/exceptions-log", "/dashboard/cash-drawer", "/dashboard/tax-reports",
        ),
    ),
    Section(
        "z", "זדים ומשמרות",
        "משמרות ודוחות Z. עריכה: הפקת Z, סגירת משמרת, שידור עסקאות, זיכוי מרחוק וזיכוי באשראי מהענן.",
        ("/dashboard/shifts", "/dashboard/z-reports/new", "/dashboard/z-reports"),
    ),
    Section(
        "products", "מוצרים וקטלוג",
        "מוצרים, קטגוריות, תוספות, אפסייל, תפריטים, מבחר לסניף, ייבוא ושידור תפריט לקופות.",
        (
            "/dashboard/products", "/dashboard/categories", "/dashboard/modifiers", "/dashboard/upsells",
            "/dashboard/menus", "/dashboard/assortment",
        ),
    ),
    Section("stock", "מלאי", "רמות מלאי, קבלת סחורה, ספירה ותיקונים.", ("/dashboard/stock",)),
    Section("vouchers", "שוברים", "שוברי הנחה בקטלוג.", ("/dashboard/vouchers",)),
    Section("prepaid_vouchers", "שוברי הפקה", "שוברים לצוותי הפקה, מומשים בקופות ב-QR.", ("/dashboard/prepaid-vouchers",)),
    Section("promotions", "מבצעים", "הגדרת מבצעים לקופות.", ("/dashboard/promotions",)),
    Section("customers", "לקוחות ומועדון", "מועדון לקוחות, חברים ולקוחות.", ("/dashboard/club",)),
    Section("notifications", "הודעות SMS", "יומן הודעות, תבניות וחשבון 019.", ("/dashboard/notifications",)),
    Section("till_messages", "הודעות לקופות", "הודעה שכל קופה צריכה לאשר.", ("/dashboard/till-messages",)),
    Section(
        "exception_alerts", "התראות SMS על חריגות",
        "חוקי ההתראה על חריגות לפי חברה / סניף (מחזיקים מספרי טלפון של עובדים), הודעת בדיקה וההיסטוריה. "
        "יומן החריגות עצמו הוא דוח.",
        ("/dashboard/exception-alerts",),
    ),
    Section(
        "organization", "חברות וסניפים",
        "הקמה ועריכה של חברות, סניפים ועמדות (הרשימות עצמן גלויות לכולם לבחירת היקף).",
        ("/dashboard/companies", "/dashboard/shops"),
    ),
    Section(
        "devices", "מכשירים",
        "קופות ומכשירים: צימוד, העברה, הסרה, הפעלה מחדש, תצורת עבודה, קופה ראשית ורשת מקומית.",
        ("/dashboard/machines",),
    ),
    Section("tables", "שולחנות", "אזורים, שולחנות, הזמנות ודוח שולחנות.", ("/dashboard/tables",)),
    Section("kiosks", "קיוסקים", "קיוסקים, הגדרותיהם ותקינות מכשירים.", ("/dashboard/kiosks", "/dashboard/kiosks/health")),
    Section("till_design", "עיצוב קופה", "מסכי ההזמנה של הקופות.", ("/dashboard/till-design",)),
    Section("kds", "KDS ותצורת עבודה", "מסכי מטבח ותצורת עבודה לעמדה.", ("/dashboard/kds", "/dashboard/workflow")),
    Section("printers", "מדפסות מטבח", "מדפסות מטבח / בר ומה מודפס איפה.", ("/dashboard/kitchen-printers",)),
    Section(
        "till_settings", "הגדרות קופות",
        "הגדרות הקופות לפי רמה (ארגון, חברה, סניף, עמדה, קופה): אמצעי תשלום, חריגים, מצב הדרכה "
        "ופרמטרי מגירת המזומן.",
        ("/dashboard/payment-methods", "/dashboard/exception-settings"),
    ),
    Section(
        "pos_users", "קופאים (POS)", "עובדי הקופה, קודי PIN, מי מחובר איפה ותפקידים והרשאות בקופה.",
        ("/dashboard/pos-users", "/dashboard/till-roles"),
    ),
    Section("attendance", "נוכחות עובדים", "מי במשמרת, דוח נוכחות ותיקונים.", ("/dashboard/attendance",)),
    Section("users", "משתמשי דשבורד", "משתמשי הענן של הארגון.", ("/dashboard/users",)),
    Section("branding", "מיתוג", "לוגו, צבעים וכותרת קבלה.", ("/dashboard/branding",)),
    Section(
        "accounting", "הנהלת חשבונות", "ייצוא להנהלת חשבונות ומיפוי חשבונות.",
        ("/dashboard/accounting-export", "/dashboard/accounting-settings"),
    ),
)

SECTION_IDS: FrozenSet[str] = frozenset(s.id for s in SECTIONS)
SECTION_BY_ID: Dict[str, Section] = {s.id: s for s in SECTIONS}

#: "מנהל ארגון" — what a new dashboard user gets until the super admin opens more (the owner,
#: 07.10.2026: "כברירת מחדל צריך להיות לו: דוחות, מוצרים וזדים").
ORG_MANAGER_TEMPLATE = "org_manager"
ORG_MANAGER_LABEL = "מנהל ארגון"
ORG_MANAGER_SECTIONS: Dict[str, str] = {"reports": VIEW, "products": EDIT, "z": VIEW}

#: "גישה מלאה לפי תפקיד" — the role decides, as before profiles existed.
FULL_TEMPLATE = "full"
FULL_LABEL = "גישה מלאה לפי תפקיד"

BUILTIN_TEMPLATES = {
    ORG_MANAGER_TEMPLATE: {"label": ORG_MANAGER_LABEL, "sections": ORG_MANAGER_SECTIONS, "fullAccess": False},
    FULL_TEMPLATE: {"label": FULL_LABEL, "sections": {}, "fullAccess": True},
}


def clean_sections(raw) -> Dict[str, str]:
    """Only known sections at a known level; anything else is dropped (never kept, never 500)."""
    out: Dict[str, str] = {}
    if isinstance(raw, dict):
        for key, level in raw.items():
            if key in SECTION_IDS and level in LEVELS:
                out[key] = level
    return dict(sorted(out.items()))


def level_allows(granted: Optional[str], needed: str) -> bool:
    """Edit includes view."""
    if granted == EDIT:
        return True
    return granted == VIEW and needed == VIEW


# ── Route rules ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RouteRule:
    #: "section" | "self" | "reference" | "till" | "super_admin" | "any_edit" | "unmapped"
    kind: str
    sections: Tuple[str, ...] = ()
    #: None = by method (GET/HEAD/OPTIONS view, anything else edit).
    level: Optional[str] = None

    def needed_level(self, method: str) -> str:
        if self.level is not None:
            return self.level
        return VIEW if method.upper() in ("GET", "HEAD", "OPTIONS") else EDIT

    def describe(self, method: str) -> str:
        if self.kind != "section":
            return self.kind
        return f"{'|'.join(self.sections)}:{self.needed_level(method)}"


def S(*sections: str, level: Optional[str] = None) -> RouteRule:
    unknown = set(sections) - SECTION_IDS
    if unknown or not sections:
        raise ValueError(f"unknown section(s) {sorted(unknown)}")
    return RouteRule("section", tuple(sections), level)


SELF = RouteRule("self")
REFERENCE = RouteRule("reference")
TILL = RouteRule("till")
SUPER_ADMIN = RouteRule("super_admin")
ANY_EDIT = RouteRule("any_edit")
UNMAPPED = RouteRule("unmapped")

_ALL = "*"
_GET = "GET"

#: (methods, path pattern, rule). Patterns are the route's path after the API prefix: `{}` is
#: one path parameter, `*` is anything (including nothing). First match wins.
ROUTE_RULES: List[Tuple[str, str, RouteRule]] = [
    # ── The caller themselves ──
    (_ALL, "/users/me", SELF),
    (_ALL, "/users/me/*", SELF),
    (_GET, "/auth/me", SELF),
    (_GET, "/tenants/mine", SELF),
    (_GET, "/dashboard-access/me", SELF),
    # The role narrowing the sidebar reads ("הרשאות" per role).
    (_GET, "/system/access", SELF),
    # ── A till's own paths, which also accept a dashboard token ──
    (_ALL, "/sync/*", TILL),
    (_ALL, "/reports/{}/shop-transactions", TILL),
    # ── The super admin's own, checked by the route ──
    ("PUT", "/system/access", SUPER_ADMIN),
    ("PUT", "/system/dealer-types", SUPER_ADMIN),
    ("PUT", "/system/open-format", SUPER_ADMIN),
    (_GET, "/notifications/mock-inbox", SUPER_ADMIN),
    ("POST", "/notifications/worker/run-once", SUPER_ADMIN),
    ("PUT", "/shops/{}/work-types", SUPER_ADMIN),
    # Permissions of the users one manages: the users section (and only what one holds — the router).
    (_ALL, "/dashboard-access/users*", S("users")),
    (_GET, "/dashboard-access/catalog", S("users")),
    (_GET, "/dashboard-access/templates", S("users")),
    (_ALL, "/dashboard-access/*", SUPER_ADMIN),
    # ── Look-ups: the org tree every page's scope bar reads ──
    (_GET, "/companies", REFERENCE),
    (_GET, "/companies/{}", REFERENCE),
    (_GET, "/shops", REFERENCE),
    (_GET, "/shops/{}", REFERENCE),
    (_GET, "/shops/{}/areas", REFERENCE),
    (_GET, "/machines", REFERENCE),
    (_GET, "/machines/search", REFERENCE),
    (_GET, "/machines/{}", REFERENCE),
    (_GET, "/system/dealer-types", REFERENCE),
    (_GET, "/system/open-format", REFERENCE),
    # ── Accounting ──
    ("POST", "/accounting/preview", S("accounting", level=VIEW)),
    (_ALL, "/accounting/*", S("accounting")),
    # ── Till app versions (the rest is the super admin's, by its dependency) ──
    (_GET, "/app-releases/rollout", S("devices", "reports", level=VIEW)),
    (_GET, "/app-releases/windows/*", S("kiosks", "devices", level=VIEW)),
    # ── Points of sale (areas) ──
    (_ALL, "/areas/{}/settings", S("till_settings")),
    (_ALL, "/areas/*", S("organization")),
    ("POST", "/shops/{}/areas", S("organization")),
    # ── Attendance ──
    (_GET, "/attendance/shifts/{}", S("attendance", "z", level=VIEW)),
    (_ALL, "/attendance/*", S("attendance")),
    # ── Catalog ──
    (_GET, "/availability/reopens", S("products")),
    (_ALL, "/catalog-import/*", S("products")),
    (_ALL, "/catalog-menus*", S("products")),
    (_ALL, "/catalog/*", S("products")),
    (_ALL, "/categories*", S("products")),
    (_ALL, "/demo-menu/*", S("products")),
    (_GET, "/menu-broadcast/*", S("products")),
    (_ALL, "/menu/*", S("products")),
    ("POST", "/products/availability-summary", S("products", level=VIEW)),
    ("POST", "/products/shop-scope/preview", S("products", level=VIEW)),
    (_ALL, "/products/{}/kitchen-printers*", S("products", "printers")),
    (_ALL, "/products*", S("products")),
    (_GET, "/vouchers*", S("vouchers", "products", level=VIEW)),
    (_ALL, "/vouchers*", S("vouchers")),
    (_ALL, "/prepaid-vouchers/*", S("prepaid_vouchers")),
    (_ALL, "/promotions*", S("promotions")),
    # ── Z and shifts ──
    (_GET, "/close-day-requests/{}", S("z")),
    ("POST", "/machines/close-day", S("z")),
    (_ALL, "/shift-close-requests/*", S("z")),
    (_GET, "/shifts*", S("z")),
    (_ALL, "/till-z-requests*", S("z")),
    (_ALL, "/transmit-requests/*", S("z")),
    (_ALL, "/z-reports*", S("z")),
    (_ALL, "/z-runs*", S("z")),
    (_GET, "/report-center/*", S("reports", "z")),
    (_ALL, "/remote-credits*", S("reports", "z")),
    # "זיכוי באשראי מהענן (Z-Credit)": the same people as a remote credit.
    (_ALL, "/cloud-card-refunds*", S("reports", "z")),
    (_GET, "/failed-payments", S("reports", "z", level=VIEW)),
    # ── Customers, club, messages ──
    (_ALL, "/club*", S("customers")),
    (_ALL, "/customers*", S("customers")),
    (_ALL, "/notifications*", S("notifications")),
    (_ALL, "/till-messages*", S("till_messages")),
    # ── Companies (the look-ups are above) ──
    (_GET, "/companies/parent-options", S("organization")),
    (_GET, "/companies/{}/dealer-turnover", S("organization", "reports", level=VIEW)),
    (_ALL, "/companies/{}/menu-broadcast*", S("products")),
    (_ALL, "/companies/{}/settings", S("till_settings")),
    # "תפקידים והרשאות" (till users' roles) — the till users' section; the drawer's parameters
    # are till settings (read on the roles page by its viewers too).
    (_ALL, "/companies/{}/till-roles*", S("pos_users")),
    (_GET, "/companies/{}/till-drawer-params", S("till_settings", "pos_users", level=VIEW)),
    (_ALL, "/companies/{}/till-drawer-params", S("till_settings")),
    (_ALL, "/companies*", S("organization")),
    # ── Reports ──
    (_GET, "/dashboard/*", S("reports")),
    # "מגירת מזומן": drawer openings, cash movements, a shift's drawer timeline (from the shift).
    (_GET, "/cash-drawer/shifts/{}/timeline", S("reports", "z", level=VIEW)),
    (_GET, "/cash-drawer/*", S("reports")),
    (_GET, "/till-permissions/catalogue", S("pos_users", level=VIEW)),
    (_ALL, "/exceptions/rules", S("till_settings")),
    (_ALL, "/exceptions*", S("reports")),
    # "יומן חריגות": a report (marking "טופל" is a report action, like reviewing exceptions);
    # its SMS alert rules hold staff phone numbers and send messages — their own section.
    (_ALL, "/exception-log*", S("reports", "exception_alerts")),
    (_ALL, "/exception-alerts/*", S("exception_alerts")),
    (_GET, "/insights/kiosks", S("reports", "kiosks", level=VIEW)),
    ("PUT", "/insights/product-costs/{}", S("reports", "products", level=EDIT)),
    (_GET, "/insights*", S("reports")),
    (_ALL, "/report-events*", S("reports")),
    (_GET, "/reports/discounts", S("reports", "promotions")),
    (_GET, "/reports/promotions", S("reports", "promotions")),
    (_GET, "/reports/upsells", S("reports", "products")),
    (_GET, "/reports/menu-sales", S("reports", "products")),
    (_GET, "/reports/meal-sales", S("reports", "products")),
    (_GET, "/reports/modifier-sales", S("reports", "products")),
    (_GET, "/reports/*", S("reports")),
    (_GET, "/transactions*", S("reports")),
    # ── Images (product photos, kiosk media, club landing…): an editor of anything ──
    ("POST", "/images/branding", S("branding")),
    (_ALL, "/images/*", ANY_EDIT),
    # ── Kitchen, KDS, kiosks, design ──
    (_GET, "/kds/shops/{}", S("kds", "devices", level=VIEW)),
    (_ALL, "/kds/*", S("kds")),
    ("POST", "/workflow/config/preview", S("kds", level=VIEW)),
    (_ALL, "/workflow/*", S("kds")),
    (_ALL, "/kitchen-station*", S("printers", "kds")),
    (_ALL, "/printers/*", S("printers")),
    (_ALL, "/kiosks*", S("kiosks")),
    (_ALL, "/till-design/*", S("till_design")),
    # ── Devices ──
    ("POST", "/device-management/*", S("devices")),
    (_ALL, "/pairing/*", S("devices")),
    (_GET, "/payment-integration/context", S("till_settings", "devices", "organization", level=VIEW)),
    # "מכשירי תשלום": a shop's card terminals, set on the till-settings page.
    (_ALL, "/payment-devices/*", S("till_settings")),
    (_GET, "/machines/unassigned", S("devices")),
    (_GET, "/machines/document-prefix-conflicts", S("devices", "reports", level=VIEW)),
    (_GET, "/machines/{}/document-prefix", S("devices", "reports", level=VIEW)),
    ("POST", "/machines/terminal-number/force", S("till_settings", "devices")),
    (_ALL, "/machines/{}/settings", S("till_settings", "devices")),
    # The till's settings dialog lists the payment devices it may default to.
    (_GET, "/machines/{}/payment-devices", S("till_settings", "devices", level=VIEW)),
    (_ALL, "/machines/{}/catalog", S("products")),
    ("POST", "/machines/{}/close-shift", S("z")),
    ("POST", "/machines/{}/shifts/{}/administrative-close", S("z")),
    (_ALL, "/machines/{}/support-z", S("z")),
    ("POST", "/machines/{}/till-z", S("z")),
    ("POST", "/machines/{}/trading-day/*", S("z")),
    (_GET, "/machines/{}/transmissions*", S("z", "reports", level=VIEW)),
    (_GET, "/machines/{}/untransmitted", S("z", "reports", level=VIEW)),
    # "תצורת עבודה למכשיר", and the add-device dialog's step for a device still to pair.
    (_ALL, "/machines/{}/work-config", S("devices")),
    ("POST", "/machines/{}/transmit", S("z")),
    (_ALL, "/machines/*", S("devices")),
    # ── A shop's own sub-resources (the shop itself is a look-up, above) ──
    (_ALL, "/shops/{}/kitchen-stations/*", S("printers")),
    ("PUT", "/shops/{}/local-network", S("devices")),
    (_ALL, "/shops/{}/local-shop-z*", S("z")),
    (_ALL, "/shops/{}/main-till", S("devices")),
    (_GET, "/shops/{}/work-config", S("devices")),
    (_ALL, "/shops/{}/menu-broadcast*", S("products")),
    (_GET, "/shops/{}/next-register-number", S("devices", "organization", level=VIEW)),
    (_ALL, "/shops/{}/pos-users*", S("pos_users")),
    (_ALL, "/shops/{}/user-sessions*", S("pos_users")),
    (_ALL, "/shops/{}/printer-routing/products/*", S("products", "printers")),
    (_ALL, "/shops/{}/printer-routing/categories*", S("products", "printers")),
    (_ALL, "/shops/{}/printer-scan", S("printers", "products")),
    (_ALL, "/shops/{}/print*", S("printers")),
    (_ALL, "/shops/{}/till-local-printers", S("printers")),
    (_ALL, "/shops/{}/product-catalog-candidates", S("products")),
    (_ALL, "/shops/{}/product-overrides*", S("products")),
    (_ALL, "/shops/{}/settings", S("till_settings")),
    (_GET, "/shops/{}/payment-devices", S("till_settings", "devices", level=VIEW)),
    (_ALL, "/shops/{}/payment-devices", S("till_settings")),
    (_ALL, "/shops/{}/training-mode*", S("till_settings")),
    (_ALL, "/shops/{}/shop-z-*", S("z")),
    (_ALL, "/shops/{}/stock*", S("stock")),
    ("POST", "/shops/{}/till-z", S("z")),
    (_GET, "/shops/{}/tips/report", S("reports")),
    (_GET, "/shops/{}/work-types", S("products", "till_settings", level=VIEW)),
    (_GET, "/shops/{}/z-candidates", S("z")),
    (_ALL, "/shops/{}/z-mode", S("z")),
    (_ALL, "/shops/{}/z-participation", S("z")),
    (_ALL, "/shops*", S("organization")),
    # ── Tables ──
    (_GET, "/tables/live", S("tables", "reports", level=VIEW)),
    (_GET, "/tables/report", S("tables", "reports", level=VIEW)),
    (_GET, "/tables/meals-report", S("tables", "reports", level=VIEW)),
    (_ALL, "/tables/*", S("tables")),
    # ── Organizations (tenants) ──
    (_ALL, "/tenants/{}/settings", S("till_settings")),
    (_ALL, "/tenants*", S("organization")),
    # ── Dashboard users ──
    (_ALL, "/users*", S("users")),
]


def _compile(pattern: str) -> "re.Pattern[str]":
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("{}", i):
            out.append(r"\{[^/}]+\}")
            i += 2
        elif pattern[i] == "*":
            out.append(".*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


_COMPILED: List[Tuple[FrozenSet[str], "re.Pattern[str]", RouteRule, int]] = [
    (frozenset() if methods == _ALL else frozenset(methods.split(",")), _compile(pattern), rule, index)
    for index, (methods, pattern, rule) in enumerate(ROUTE_RULES)
]


def rule_index_for(method: str, path: str) -> Optional[int]:
    """Index in `ROUTE_RULES` of the rule for (method, path-after-prefix), or None."""
    method = "GET" if method.upper() == "HEAD" else method.upper()
    for methods, regex, _rule, index in _COMPILED:
        if methods and method not in methods:
            continue
        if regex.match(path):
            return index
    return None


def rule_for(method: str, path: str) -> RouteRule:
    index = rule_index_for(method, path)
    return UNMAPPED if index is None else ROUTE_RULES[index][2]


def catalogue() -> List[dict]:
    """The sections as the dashboard's permissions dialog shows them."""
    return [{"id": s.id, "label": s.label, "hint": s.hint, "pages": list(s.pages)} for s in SECTIONS]


def sections_summary(sections: Iterable[Tuple[str, str]]) -> List[dict]:
    return [{"id": sid, "label": SECTION_BY_ID[sid].label, "level": lvl} for sid, lvl in sections if sid in SECTION_BY_ID]
