"""
"הגדרה מהירה לשלבי הגשה" — the courses quick setup of the dashboard's "תוספות ושינויים" → "שלבי הגשה".

The courses FIRE code (P:/specs/courses-fire-v2.md, P:/specs/fire-restaurant-flow.md) needs three things set
by hand before a table's mains are held: courses (`menu_courses`), each category's course
(`categories.course_id`, inherited product → category → parent) and the till parameter `coursesEnabled`
(off by default) at some level. The wizard does the three in one call:

* **Suggestions** (`view`) — the courses that reach the company (else three proposed: ראשונות, עיקריות,
  קינוחים, 15 minutes each), every category of the company's catalog with a suggested course key from
  its name (`suggest_key`: Hebrew / English words, a food course before a drink — "בר סלטים" is
  starters), whether its name is bread / water ("יוצא בלי בון" candidates), the levels of the company
  (company, shops, points of sale, tills) and the tab's status line: where `coursesEnabled` is on, how
  many categories reach a course and how many do not.
* **Apply** (`apply`) — in the caller's transaction: create the new courses (one of the company's of the
  same name is reused, so a second run creates nothing), set the categories' course / `sendSilently`,
  write `coursesEnabled` (and optionally `fireAskOnSend`, `autoFire`) at one level. Permission: the
  menu's (the company's courses and each changed category) and the till parameters' at that level
  (app/routers/till_roles.py `_level_access`); refused before anything is written, with a Hebrew message.
* **Undo** (`undo`) — the apply records what it changed in the company's settings JSON
  (`coursesQuickSetup`, never sent to a till: only MANAGED_SETTING_KEYS are): the courses it created,
  each category field's value before and after, each parameter's own value before and after. A re-run
  keeps the first "before". Undo restores a value only where it is still what the quick setup wrote
  (a later hand edit is kept and reported) and removes a created course only when no product, category
  or open table order names it (else kept and reported).
* **The switch** (`set_enabled`) — off clears `coursesEnabled` at every level of the company where it is
  on (everything goes to the kitchen at once, as before; the category mappings stay, inert) and
  remembers those levels; on sets them back (none remembered: the quick setup's level).
"""
from __future__ import annotations

import copy
import re
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.company import Company
from app.models.menu import MenuCourse
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User

# ── Keyword rules ─────────────────────────────────────────────────────────────

STARTERS = "starters"
MAINS = "mains"
DESSERTS = "desserts"
#: "בלי שלב — יוצא מיד": drinks, the bar, coffee.
NONE = "none"
COURSE_KEYS = (STARTERS, MAINS, DESSERTS)
SUGGESTION_KEYS = COURSE_KEYS + (NONE,)

#: In priority order: a name with a word of a food course is that course even when it also names a drink
#: ("בר סלטים" → starters, "קינוחים וקפה" → desserts).
KEYWORDS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    (STARTERS, (
        "ראשונות", "ראשונה", "פתיחים", "פתיח", "סלטים", "סלט",
        "starters", "starter", "appetizers", "appetizer", "salad", "salads",
    )),
    (MAINS, (
        "עיקריות", "עיקרית", "בשרים", "בשר", "דגים", "דג", "פסטות", "פסטה", "פיצות", "פיצה", "המבורגרים", "המבורגר",
        "mains", "main", "grill", "pizza", "pizzas", "pasta", "pastas", "burgers", "burger",
    )),
    (DESSERTS, ("קינוחים", "קינוח", "מתוקים", "desserts", "dessert", "sweets")),
    (NONE, (
        "שתייה", "שתיה", "משקאות", "משקה", "בר", "יין", "יינות", "בירה", "בירות", "קפה",
        "drinks", "drink", "beverages", "bar", "coffee", "wine", "wines", "beer", "beers",
    )),
)
#: "לחם/מים — יוצא בלי בון" (`sendSilently`, P:/specs/courses-fire-v2.md §2).
SILENT_WORDS = frozenset({"לחם", "לחמים", "מים", "bread", "water"})

#: The three courses proposed to a company none reaches, in order.
PROPOSED_COURSES: Tuple[Tuple[str, str], ...] = ((STARTERS, "ראשונות"), (MAINS, "עיקריות"), (DESSERTS, "קינוחים"))
PROPOSED_MINUTES = 15

_NIQQUD = re.compile(r"[\u0591-\u05C7]")
_QUOTES = re.compile("[\"'\u05F3\u05F4\u2018\u2019\u201C\u201D`]")
_WORD = re.compile(r"\w+", re.UNICODE)
#: The one-letter prefixes a category name puts on a word: "הסלטים", "ומשקאות", "והקינוחים".
_PREFIXES = ("וה", "ה", "ו")


def words_of(name: Any) -> List[str]:
    """The words of a name: niqqud and quotes dropped, lower case."""
    text = _QUOTES.sub("", _NIQQUD.sub("", str(name or ""))).lower()
    return _WORD.findall(text)


def _forms(word: str) -> Set[str]:
    out = {word}
    for prefix in _PREFIXES:
        if word.startswith(prefix) and len(word) > len(prefix) + 1:
            out.add(word[len(prefix):])
    return out


def _has(words: Sequence[str], vocabulary: Iterable[str]) -> bool:
    vocab = set(vocabulary)
    return any(_forms(w) & vocab for w in words)


def suggest_key(name: Any) -> Optional[str]:
    """`starters` | `mains` | `desserts` | `none` (goes at once) for a category's or course's name; None: no rule."""
    words = words_of(name)
    for key, vocabulary in KEYWORDS:
        if _has(words, vocabulary):
            return key
    return None


def silent_candidate(name: Any) -> bool:
    """A bread / water category: "יוצא בלי בון" is offered for it."""
    return _has(words_of(name), SILENT_WORDS)


# ── Messages ──────────────────────────────────────────────────────────────────

PARAM_KEYS = ("coursesEnabled", "fireAskOnSend", "autoFire")
ENABLED_KEY = "coursesEnabled"
#: The till parameters this module writes, as a `table_restore.level_view` card.
_GROUPS = (("coursesQuickSetup", "שלבי הגשה", PARAM_KEYS),)
#: The company's settings JSON key of the undo record and the switch's memory.
RECORD_KEY = "coursesQuickSetup"
LEVEL_WORDS = {"company": "חברה", "shop": "סניף", "area": "נקודת מכירה", "machine": "קופה"}


def _refuse(code: int, key: str, message: str) -> HTTPException:
    return HTTPException(status_code=code, detail={"code": key, "message": message})


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _s(value: Any) -> Optional[str]:
    return str(value) if value is not None else None


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Who ───────────────────────────────────────────────────────────────────────


def company_of(db: Session, tenant_id: Any, company_id: Any) -> Company:
    from app.routers.till_roles import _company

    return _company(db, company_id, tenant_id)


def may_edit_menu(db: Session, user: User, tenant_id: Any, company: Company) -> bool:
    from app.services import menu as M

    return M.may_write_company(db, user, tenant_id, company.id)


def may_edit_params_section(db: Session, user: User) -> bool:
    """
    The dashboard section of the till parameters these routes also write: as `PUT
    /companies/{id}/table-restore-params` (tables | till_settings at edit). The routes themselves are the
    menu's (`/menu/*` → products).
    """
    from app.services import dashboard_access as DA

    access = DA.effective_access(db, user)
    return not access.restricted or access.allows("till_settings", "edit") or access.allows("tables", "edit")


def may_write_level(db: Session, user: User, company: Company, scope_type: str, scope_id: Any) -> bool:
    from app.routers.till_roles import _level_access

    if not may_edit_params_section(db, user):
        return False
    try:
        _level_access(db, company, scope_type, scope_id, user, write=True)
    except HTTPException:
        return False
    return True


def check_readable(db: Session, user: User, tenant_id: Any, company: Company) -> None:
    from app.routers.till_roles import may_read

    if may_edit_menu(db, user, tenant_id, company) or may_read(db, user, company):
        return
    raise _refuse(status.HTTP_403_FORBIDDEN, "quick_setup_forbidden", "אין לך הרשאה לצפות בשלבי ההגשה של החברה הזו.")


def _check_menu(db: Session, user: User, tenant_id: Any, company: Company) -> None:
    if not may_edit_menu(db, user, tenant_id, company):
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "quick_setup_menu_forbidden",
            f"אין לך הרשאה לערוך את התפריט (שלבי הגשה ומחלקות) של \"{company.name}\".",
        )


def _check_category(db: Session, user: User, category: Category) -> None:
    from app.services import menu as M

    try:
        M.check_target_write(db, user, category)
    except HTTPException:
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "quick_setup_category_forbidden",
            f"אין לך הרשאה לערוך את המחלקה \"{category.name}\".",
        ) from None


def _level_exists(db: Session, company: Company, scope_type: Any, scope_id: Any) -> bool:
    from app.services.cash_drawer import SCOPE_TYPES, scope_company

    if scope_type not in SCOPE_TYPES or _uuid(scope_id) is None:
        return False
    try:
        level_company, _shop = scope_company(db, scope_type, scope_id)
    except HTTPException:
        return False
    return level_company is not None and str(level_company) == str(company.id)


def _check_level(db: Session, user: User, company: Company, scope_type: str, scope_id: Any) -> None:
    from app.services.cash_drawer import SCOPE_TYPES, scope_company

    if scope_type not in SCOPE_TYPES:
        raise _refuse(422, "quick_setup_bad_level", "רמה לא מוכרת (חברה, סניף, נקודת מכירה או קופה).")
    try:
        level_company, _shop = scope_company(db, scope_type, scope_id)
    except HTTPException:
        level_company = None
    if level_company is None or str(level_company) != str(company.id):
        raise _refuse(status.HTTP_404_NOT_FOUND, "quick_setup_level_not_found", "הרמה שנבחרה לא שייכת לחברה הזו.")
    if not may_write_level(db, user, company, scope_type, scope_id):
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "quick_setup_params_forbidden",
            f"אין לך הרשאה לערוך פרמטרי קופה ברמה \"{level_name(db, scope_type, scope_id)}\".",
        )


# ── The company's catalog ─────────────────────────────────────────────────────


def _chain(db: Session, company: Company) -> Set[str]:
    from app.services.company_hierarchy import ancestor_company_ids

    return {str(company.id)} | {str(c) for c in ancestor_company_ids(db, company.id)}


def _reaches(row: Any, chain: Set[str]) -> bool:
    company = getattr(row, "company_id", None)
    return company is None or str(company) in chain


def courses_of(db: Session, tenant_id: Any, company: Company, chain: Optional[Set[str]] = None) -> List[MenuCourse]:
    """The active courses the company's tills get (its own, its parents', the organization's)."""
    chain = chain if chain is not None else _chain(db, company)
    return [
        c for c in db.query(MenuCourse)
        .filter(MenuCourse.tenant_id == tenant_id, MenuCourse.is_active.is_(True))
        .order_by(MenuCourse.sort_order, MenuCourse.name)
        .all()
        if _reaches(c, chain)
    ]


def categories_of(db: Session, tenant_id: Any, company: Company, chain: Optional[Set[str]] = None) -> List[Category]:
    """The company's catalog categories, parents before their children, each level by its order."""
    chain = chain if chain is not None else _chain(db, company)
    rows = [
        c for c in db.query(Category).filter(Category.tenant_id == tenant_id, Category.is_active.is_(True)).all()
        if _reaches(c, chain)
    ]
    ids = {str(c.id) for c in rows}
    children: Dict[Optional[str], List[Category]] = {}
    for c in rows:
        parent = _s(c.parent_id)
        children.setdefault(parent if parent in ids else None, []).append(c)
    out: List[Category] = []

    def walk(parent: Optional[str]) -> None:
        for c in sorted(children.get(parent, []), key=lambda r: (r.sort_order or 0, r.name or "")):
            out.append(c)
            walk(str(c.id))

    walk(None)
    return out


def _effective(categories: Sequence[Category], course_ids: Set[str]) -> Dict[str, Optional[str]]:
    """Each category's course as the till resolves it: its own, else its parent's (a missing course is none)."""
    by_id = {str(c.id): c for c in categories}
    memo: Dict[str, Optional[str]] = {}

    def of(ident: str, seen: Set[str]) -> Optional[str]:
        if ident in memo:
            return memo[ident]
        c = by_id[ident]
        own = _s(c.course_id)
        if own in course_ids:
            value: Optional[str] = own
        else:
            parent = _s(c.parent_id)
            value = of(parent, seen | {ident}) if parent in by_id and parent not in seen else None
        memo[ident] = value
        return value

    return {ident: of(ident, set()) for ident in by_id}


# ── Levels ────────────────────────────────────────────────────────────────────


def _levels(db: Session, company: Company) -> List[Dict[str, Any]]:
    """The company's levels, as the parameters pages name them."""
    shops = db.query(Shop).filter(Shop.company_id == company.id).order_by(Shop.name).all()
    shop_ids = [s.id for s in shops]
    names = {str(s.id): s.name for s in shops}
    out = [{"scopeType": "company", "scopeId": str(company.id), "name": company.name, "shopId": None}]
    out += [{"scopeType": "shop", "scopeId": str(s.id), "name": s.name, "shopId": str(s.id)} for s in shops]
    if shop_ids:
        for a in (
            db.query(ShopArea)
            .filter(ShopArea.shop_id.in_(shop_ids), ShopArea.archived_at.is_(None))
            .order_by(ShopArea.sort_order, ShopArea.name)
            .all()
        ):
            out.append({"scopeType": "area", "scopeId": str(a.id), "name": f"{names.get(str(a.shop_id), '')} › {a.name}",
                        "shopId": str(a.shop_id)})
        for m in (
            db.query(POSMachine)
            .filter(POSMachine.shop_id.in_(shop_ids), POSMachine.is_active.is_(True))
            .order_by(POSMachine.name)
            .all()
        ):
            out.append({"scopeType": "machine", "scopeId": str(m.id),
                        "name": f"{names.get(str(m.shop_id), '')} › {m.name or m.machine_code or ''}",
                        "shopId": str(m.shop_id)})
    return out


def level_name(db: Session, scope_type: str, scope_id: Any) -> str:
    ident = _uuid(scope_id)
    model = {"company": Company, "shop": Shop, "area": ShopArea, "machine": POSMachine}.get(scope_type)
    row = db.get(model, ident) if model is not None and ident is not None else None
    name = getattr(row, "name", None) or ""
    return f"{LEVEL_WORDS.get(scope_type, scope_type)} {name}".strip()


def _own_values(db: Session, key: str, scopes: Sequence[Tuple[str, str]]) -> Dict[Tuple[str, str], Any]:
    """`key`'s own value at each of `scopes` that sets one."""
    from app.models.till_parameter import TillParameter, TillParameterValue

    parameter = db.query(TillParameter).filter(TillParameter.key == key).first()
    if parameter is None or not scopes:
        return {}
    wanted = set(scopes)
    ids = list({_uuid(i) for _t, i in scopes})
    out: Dict[Tuple[str, str], Any] = {}
    for row in db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id, TillParameterValue.scope_id.in_(ids),
    ).all():
        scope = (row.scope_type, str(row.scope_id))
        if scope in wanted:
            out[scope] = row.value
    return out


def enabled_levels(db: Session, company: Company, levels: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """The company's levels that turn `coursesEnabled` on themselves."""
    levels = levels if levels is not None else _levels(db, company)
    own = _own_values(db, ENABLED_KEY, [(lv["scopeType"], lv["scopeId"]) for lv in levels])
    return [lv for lv in levels if own.get((lv["scopeType"], lv["scopeId"])) is True]


# ── The record (undo, the switch) ─────────────────────────────────────────────


def _record(company: Company) -> Dict[str, Any]:
    settings = company.settings if isinstance(company.settings, Mapping) else {}
    rec = settings.get(RECORD_KEY)
    return copy.deepcopy(dict(rec)) if isinstance(rec, Mapping) else {}


def _store(company: Company, rec: Dict[str, Any]) -> None:
    """A new dict, so the JSON column is seen as changed; `settings_updated_at` stays — no till reads it."""
    settings = dict(company.settings) if isinstance(company.settings, Mapping) else {}
    rec = {k: v for k, v in rec.items() if v}
    if rec:
        settings[RECORD_KEY] = rec
    else:
        settings.pop(RECORD_KEY, None)
    company.settings = settings


def _undo_summary(rec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    undo = rec.get("undo")
    if not isinstance(undo, Mapping):
        return None
    categories = undo.get("categories") or {}
    return {
        "appliedAt": undo.get("appliedAt"),
        "courses": len(undo.get("courses") or []),
        "categories": len(categories),
        "params": len(undo.get("params") or {}),
    }


# ── The view ──────────────────────────────────────────────────────────────────


def view(db: Session, user: User, tenant_id: Any, company: Company) -> Dict[str, Any]:
    """`GET /menu/courses/quick-setup`: the wizard's suggestions and the tab's status line."""
    from app.services.menu import course_minutes

    chain = _chain(db, company)
    courses = courses_of(db, tenant_id, company, chain)
    course_ids = {str(c.id) for c in courses}
    categories = categories_of(db, tenant_id, company, chain)
    effective = _effective(categories, course_ids)
    depth: Dict[str, int] = {}
    for c in categories:
        parent = _s(c.parent_id)
        depth[str(c.id)] = depth[parent] + 1 if parent in depth else 0
    menu_ok = may_edit_menu(db, user, tenant_id, company)
    levels = _levels(db, company)
    for lv in levels:
        lv["canEdit"] = may_write_level(db, user, company, lv["scopeType"], lv["scopeId"])
    on = enabled_levels(db, company, levels)
    rec = _record(company)
    mapped = sum(1 for c in categories if effective.get(str(c.id)))
    return {
        "companyId": str(company.id),
        "companyName": company.name,
        "canEditMenu": menu_ok,
        "courses": [
            {"id": str(c.id), "name": c.name, "sortOrder": c.sort_order or 0, "autoFireMinutes": course_minutes(c),
             "companyId": _s(c.company_id), "key": suggest_key(c.name)}
            for c in courses
        ],
        "proposedCourses": [] if courses else [
            {"key": key, "name": name, "autoFireMinutes": PROPOSED_MINUTES} for key, name in PROPOSED_COURSES
        ],
        "categories": [
            {
                "id": str(c.id),
                "name": c.name,
                "parentId": _s(c.parent_id) if _s(c.parent_id) in depth else None,
                "depth": depth[str(c.id)],
                "companyId": _s(c.company_id),
                # Its own course (one that no longer reaches the company reads as none).
                "courseId": _s(c.course_id) if _s(c.course_id) in course_ids else None,
                "effectiveCourseId": effective.get(str(c.id)),
                "sendSilently": c.send_silently,
                "suggestedKey": suggest_key(c.name),
                "silentCandidate": silent_candidate(c.name),
                "canEdit": menu_ok and _may_target(db, user, c),
            }
            for c in categories
        ],
        "levels": levels,
        "status": {
            "on": bool(on),
            "enabledAt": [{k: lv[k] for k in ("scopeType", "scopeId", "name")} for lv in on],
            "mapped": mapped,
            "unmapped": len(categories) - mapped,
            "paused": len(rec.get("paused") or []),
            "canResume": bool(rec.get("paused") or rec.get("enable")),
        },
        "undo": _undo_summary(rec),
    }


def _may_target(db: Session, user: User, category: Category) -> bool:
    from app.services import menu as M

    try:
        M.check_target_write(db, user, category)
    except HTTPException:
        return False
    return True


# ── Apply ─────────────────────────────────────────────────────────────────────


def _level_values(db: Session, scope_type: str, scope_id: Any) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """(own, inherited) of the three keys at a level."""
    from app.services import table_restore as TR

    got = TR.level_view(db, scope_type, scope_id, groups=_GROUPS)
    return dict(got["own"]), dict(got["inherited"])


def _write_param(db: Session, user: User, scope_type: str, scope_id: Any, key: str, value: Any, now: datetime) -> bool:
    """One key's own value at a level (None clears it); True when it changed. Raises `TillParameterValueError`."""
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import ensure_builtin_parameters, validate_keyed_value, validate_value, write_value

    ensure_builtin_parameters(db)
    parameter = db.query(TillParameter).filter(TillParameter.key == key).first()
    if parameter is None:  # pragma: no cover - a builtin
        return False
    stored = None
    if value is not None:
        stored = validate_keyed_value(key, validate_value(parameter.value_type, value, parameter.enum_options))
    changed = write_value(db, parameter, scope_type, _uuid(scope_id), stored, user=user, now=now)
    db.flush()
    return changed


def _same(a: Any, b: Any) -> bool:
    return a == b and type(a) is type(b)


def _note(entries: Dict[str, Any], ident: str, before: Any, after: Any, **extra: Any) -> None:
    """
    Merge one change into the undo record: the first run's "before" (and, for a parameter, whether the level
    had its own value — `had`) is kept; a change that ends where it started is dropped.
    """
    entry = entries.get(ident)
    if isinstance(entry, Mapping):
        before = entry.get("before")
        if "had" in entry:
            extra["had"] = entry["had"]
    if extra.get("had", True) and _same(before, after):
        entries.pop(ident, None)
        return
    entries[ident] = {**extra, "before": before, "after": after}


def apply(db: Session, user: User, tenant_id: Any, company: Company, body: Any) -> Dict[str, Any]:
    """
    `POST /menu/courses/quick-setup`, in the caller's transaction (the router commits or rolls back): the
    changes made, `{courses: [{id, name, created}], categories: [{id, name, field, before, after}], params:
    [{scopeType, scopeId, key, before, after}]}`. Every check runs before the first write.
    """
    from app.schemas.menu import AUTO_FIRE_MINUTES_DEFAULT
    from app.services import menu as M
    from app.services.till_parameters import TillParameterValueError

    _check_menu(db, user, tenant_id, company)
    enable = body.enable
    if enable is not None:
        _check_level(db, user, company, enable.level, enable.id)

    chain = _chain(db, company)
    reaching = {str(c.id): c for c in courses_of(db, tenant_id, company, chain)}
    own_courses = [
        c for c in db.query(MenuCourse)
        .filter(MenuCourse.tenant_id == tenant_id, MenuCourse.company_id == company.id)
        .all()
    ]
    by_name = {c.name.strip().casefold(): c for c in own_courses if c.is_active}

    # The courses: an id names one that reaches the company; a new one is matched to the company's own of the
    # same name (a second run creates nothing), else created after the company's last.
    refs: Dict[str, Optional[MenuCourse]] = {}
    to_create: List[Tuple[str, Any]] = []
    for course in body.courses:
        if course.id is not None:
            if str(course.id) not in reaching:
                raise _refuse(status.HTTP_400_BAD_REQUEST, M.UNKNOWN_COURSE, f"השלב \"{course.name}\" לא נמצא.")
            refs[str(course.id)] = reaching[str(course.id)]
            if course.ref:
                refs[course.ref] = reaching[str(course.id)]
            continue
        found = by_name.get(course.name.strip().casefold())
        ref = course.ref or course.name
        if found is not None:
            refs[ref] = found
        else:
            refs[ref] = None
            to_create.append((ref, course))

    def course_of(value: Optional[str]) -> Tuple[bool, Optional[str]]:
        """(known, the course id or a new course's ref)."""
        if value is None:
            return True, None
        if value in refs:
            return True, value
        if value in reaching:
            return True, value
        return False, None

    categories = {str(c.id): c for c in categories_of(db, tenant_id, company, chain)}
    planned: List[Tuple[Category, Dict[str, Any]]] = []
    for item in body.mapping:
        category = categories.get(str(item.category_id))
        if category is None:
            raise _refuse(status.HTTP_400_BAD_REQUEST, M.UNKNOWN_CATEGORY, "מחלקה שלא בקטלוג של החברה.")
        known, target = course_of(item.course_id)
        if not known:
            raise _refuse(status.HTTP_400_BAD_REQUEST, M.UNKNOWN_COURSE,
                          f"השלב שנבחר למחלקה \"{category.name}\" לא נמצא.")
        change: Dict[str, Any] = {"course": target}
        if "send_silently" in item.model_fields_set:
            change["silent"] = item.send_silently
        planned.append((category, change))

    def resolved(target: Optional[str]) -> Optional[str]:
        if target is None:
            return None
        row = refs.get(target) if target in refs else reaching.get(target)
        return str(row.id) if row is not None else f"new:{target}"

    # Permission on every category that changes, before anything is written.
    for category, change in planned:
        new_course = resolved(change["course"])
        if (new_course != _s(category.course_id)
                or ("silent" in change and change["silent"] != category.send_silently)):
            _check_category(db, user, category)

    now = _now()
    out: Dict[str, Any] = {"courses": [], "categories": [], "params": []}
    rec = _record(company)
    undo = rec.get("undo") if isinstance(rec.get("undo"), Mapping) else {}
    undo = dict(undo)
    created_ids: List[str] = list(undo.get("courses") or [])
    cat_entries: Dict[str, Any] = dict(undo.get("categories") or {})
    param_entries: Dict[str, Any] = dict(undo.get("params") or {})

    # 1. Courses.
    if to_create:
        last = max([c.sort_order or 0 for c in own_courses] or [-1])
        for index, (ref, course) in enumerate(to_create, start=1):
            row = MenuCourse(
                id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, name=course.name,
                sort_order=last + index, is_active=True,
                auto_fire_minutes=course.auto_fire_minutes or AUTO_FIRE_MINUTES_DEFAULT, updated_at=now,
            )
            db.add(row)
            refs[ref] = row
            created_ids.append(str(row.id))
            out["courses"].append({"id": str(row.id), "name": row.name, "created": True})
        db.flush()
    menu_changed = bool(to_create)

    # 2. Categories.
    for category, change in planned:
        ident = str(category.id)
        entry = dict(cat_entries.get(ident) or {})
        new_course = resolved(change["course"])
        if new_course != _s(category.course_id):
            before = _s(category.course_id)
            category.course_id = _uuid(new_course)
            category.updated_at = now
            _note(entry, "courseId", before, new_course)
            out["categories"].append({"id": ident, "name": category.name, "field": "courseId",
                                      "before": before, "after": new_course})
        if "silent" in change and change["silent"] != category.send_silently:
            before = category.send_silently
            category.send_silently = change["silent"]
            category.updated_at = now
            _note(entry, "sendSilently", before, change["silent"])
            out["categories"].append({"id": ident, "name": category.name, "field": "sendSilently",
                                      "before": before, "after": change["silent"]})
        if entry:
            cat_entries[ident] = entry
        else:
            cat_entries.pop(ident, None)
    if out["categories"]:
        menu_changed = True
        db.flush()
    if menu_changed:
        M.bump(db, tenant_id)

    # 3. The till parameters at the chosen level: written only where the level does not already get the value.
    targets: list = []
    if enable is not None:
        wanted: Dict[str, Any] = {ENABLED_KEY: enable.courses_enabled}
        if enable.fire_ask_on_send is not None:
            wanted["fireAskOnSend"] = enable.fire_ask_on_send
        if enable.auto_fire is not None:
            wanted["autoFire"] = enable.auto_fire
        own, inherited = _level_values(db, enable.level, enable.id)
        for key, value in wanted.items():
            had = key in own
            current = own.get(key) if had else inherited.get(key)
            if _same(current, value):
                continue
            try:
                _write_param(db, user, enable.level, enable.id, key, value, now)
            except TillParameterValueError as exc:
                raise _refuse(422, "invalid_value", f"{key}: {exc}") from None
            ref = f"{enable.level}:{enable.id}:{key}"
            _note(param_entries, ref, own.get(key) if had else None, value,
                  scopeType=enable.level, scopeId=str(enable.id), key=key, had=had)
            out["params"].append({"scopeType": enable.level, "scopeId": str(enable.id), "key": key,
                                  "before": own.get(key) if had else None, "after": value})
        from app.services.till_parameters import notify_targets_for_scope

        if out["params"]:
            targets = notify_targets_for_scope(db, enable.level, _uuid(enable.id))
        if enable.courses_enabled:
            rec["enable"] = {"scopeType": enable.level, "scopeId": str(enable.id)}
            rec.pop("paused", None)

    if out["courses"] or out["categories"] or out["params"]:
        undo.update({
            "appliedAt": now.isoformat(), "appliedBy": _s(getattr(user, "id", None)),
            "courses": created_ids, "categories": cat_entries, "params": param_entries,
        })
        rec["undo"] = undo if (created_ids or cat_entries or param_entries) else None
    _store(company, rec)
    db.flush()
    out["menuChanged"] = menu_changed
    out["notify"] = targets
    return out


# ── Undo ──────────────────────────────────────────────────────────────────────


def _references(db: Session, tenant_id: Any, course_id: str) -> Dict[str, int]:
    """What still names a course: products, categories (course or "after ready"), open table orders."""
    from sqlalchemy import or_

    from app.models.tables import TableOrder

    ident = _uuid(course_id)
    products = db.query(Product.id).filter(
        Product.tenant_id == tenant_id,
        or_(Product.course_id == ident, Product.schedule_after_course_ready == ident),
    ).count()
    categories = db.query(Category.id).filter(
        Category.tenant_id == tenant_id,
        or_(Category.course_id == ident, Category.schedule_after_course_ready == ident),
    ).count()
    like = f"%{course_id}%"
    orders = db.query(TableOrder.id).filter(
        TableOrder.tenant_id == tenant_id, TableOrder.status == "open",
        or_(TableOrder.cart_json.like(like), TableOrder.extras_json.like(like)),
    ).count()
    return {k: v for k, v in (("products", products), ("categories", categories), ("orders", orders)) if v}


def undo(db: Session, user: User, tenant_id: Any, company: Company) -> Dict[str, Any]:
    """
    `POST /menu/courses/quick-setup/undo`, in the caller's transaction: puts back what the quick setup
    changed, where it is still what the quick setup wrote. `{restored: {...}, kept: {...}}`.
    """
    from app.services import menu as M

    rec = _record(company)
    record = rec.get("undo")
    if not isinstance(record, Mapping):
        raise _refuse(status.HTTP_409_CONFLICT, "quick_setup_nothing_to_undo", "אין הגדרה מהירה לביטול.")
    _check_menu(db, user, tenant_id, company)
    # A level deleted since (its values went with it) has nothing to put back.
    params = [
        p for p in (record.get("params") or {}).values()
        if isinstance(p, Mapping) and _level_exists(db, company, p.get("scopeType"), p.get("scopeId"))
    ]
    for scope in {(p["scopeType"], p["scopeId"]) for p in params}:
        _check_level(db, user, company, *scope)
    cat_rows = {
        str(c.id): c for c in db.query(Category).filter(
            Category.tenant_id == tenant_id,
            Category.id.in_([_uuid(i) for i in (record.get("categories") or {})]),
        ).all()
    } if record.get("categories") else {}
    for ident in record.get("categories") or {}:
        if ident in cat_rows:
            _check_category(db, user, cat_rows[ident])

    now = _now()
    out: Dict[str, Any] = {
        "restored": {"categories": [], "params": [], "coursesRemoved": []},
        "kept": {"categories": [], "params": [], "courses": []},
    }
    paused = {(p.get("scopeType"), p.get("scopeId")) for p in rec.get("paused") or [] if isinstance(p, Mapping)}

    # Categories: only where the value is still the quick setup's.
    for ident, fields in (record.get("categories") or {}).items():
        category = cat_rows.get(ident)
        if category is None:
            continue
        for field, change in (fields or {}).items():
            if field == "courseId":
                current: Any = _s(category.course_id)
            elif field == "sendSilently":
                current = category.send_silently
            else:  # pragma: no cover - only these two are recorded
                continue
            row = {"id": ident, "name": category.name, "field": field}
            if current != change.get("after"):
                out["kept"]["categories"].append(row)
                continue
            if field == "courseId":
                category.course_id = _uuid(change.get("before"))
            else:
                category.send_silently = change.get("before")
            category.updated_at = now
            out["restored"]["categories"].append(row)
    db.flush()

    # Parameters: only where the level's own value is still the quick setup's (or the switch cleared it).
    targets: list = []
    for p in params:
        scope_type, scope_id, key = p["scopeType"], p["scopeId"], p["key"]
        own, _inherited = _level_values(db, scope_type, scope_id)
        current = own.get(key)
        cleared_by_switch = key == ENABLED_KEY and (scope_type, scope_id) in paused and key not in own
        row = {"scopeType": scope_type, "scopeId": scope_id, "key": key}
        if not (_same(current, p.get("after")) or cleared_by_switch):
            out["kept"]["params"].append(row)
            continue
        before = p.get("before") if p.get("had", True) else None
        if _write_param(db, user, scope_type, scope_id, key, before, now):
            from app.services.till_parameters import notify_targets_for_scope

            targets += notify_targets_for_scope(db, scope_type, _uuid(scope_id))
        out["restored"]["params"].append(row)

    # Courses it created: removed unless something still names them.
    for ident in record.get("courses") or []:
        course = db.get(MenuCourse, _uuid(ident))
        if course is None or str(course.tenant_id) != str(tenant_id):
            continue
        refs = _references(db, tenant_id, ident)
        if refs:
            out["kept"]["courses"].append({"id": ident, "name": course.name, "references": refs})
            continue
        out["restored"]["coursesRemoved"].append({"id": ident, "name": course.name})
        db.delete(course)
    db.flush()
    M.bump(db, tenant_id)
    rec.pop("undo", None)
    rec.pop("paused", None)
    rec.pop("enable", None)
    _store(company, rec)
    db.flush()
    out["notify"] = list({t: None for t in targets})
    return out


# ── The switch ────────────────────────────────────────────────────────────────


def set_enabled(db: Session, user: User, tenant_id: Any, company: Company, on: bool) -> Dict[str, Any]:
    """
    `PUT /menu/courses/enabled`, in the caller's transaction. Off: clear `coursesEnabled` wherever the
    company turns it on, remembering those levels. On: set it back at the remembered levels, else at the
    quick setup's level; neither: 409. Returns `{"levels": [...], "notify": [...]}`.
    """
    from app.services.till_parameters import notify_targets_for_scope

    rec = _record(company)
    now = _now()
    targets: list = []
    if not on:
        levels = enabled_levels(db, company)
        for lv in levels:
            _check_level(db, user, company, lv["scopeType"], lv["scopeId"])
        for lv in levels:
            _write_param(db, user, lv["scopeType"], lv["scopeId"], ENABLED_KEY, None, now)
            targets += notify_targets_for_scope(db, lv["scopeType"], _uuid(lv["scopeId"]))
        if levels:
            rec["paused"] = [{"scopeType": lv["scopeType"], "scopeId": lv["scopeId"]} for lv in levels]
            _store(company, rec)
        db.flush()
        return {"levels": [lv["scopeId"] for lv in levels], "notify": targets}

    if enabled_levels(db, company):
        return {"levels": [], "notify": []}
    known = {(lv["scopeType"], lv["scopeId"]) for lv in _levels(db, company)}
    remembered = [
        (p.get("scopeType"), p.get("scopeId")) for p in rec.get("paused") or [] if isinstance(p, Mapping)
    ]
    if not remembered and isinstance(rec.get("enable"), Mapping):
        remembered = [(rec["enable"].get("scopeType"), rec["enable"].get("scopeId"))]
    remembered = [s for s in remembered if s in known]
    if not remembered:
        raise _refuse(
            status.HTTP_409_CONFLICT, "quick_setup_no_level",
            "לא ידוע איפה להפעיל את שלבי ההגשה — הפעילו אותם בהגדרה המהירה (שלב 3) או בפרמטרי הקופה.",
        )
    for scope in remembered:
        _check_level(db, user, company, *scope)
    for scope_type, scope_id in remembered:
        _write_param(db, user, scope_type, scope_id, ENABLED_KEY, True, now)
        targets += notify_targets_for_scope(db, scope_type, _uuid(scope_id))
    rec.pop("paused", None)
    _store(company, rec)
    db.flush()
    return {"levels": [i for _t, i in remembered], "notify": targets}
