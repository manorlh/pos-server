"""
"הוצאה אוטומטית של השלב הבא" — courses FIRE, phase 2 (P:/specs/courses-fire-v2.md §1, the contract in §5):
the cloud's part.

* **The settings.** The till parameter `autoFire` (`off` | `after_minutes` | `after_ready`, company →
  shop → point of sale → till; `off` by default) and `autoFireMinutesOverride` (1–180; none — each
  course's own `menu_courses.auto_fire_minutes`, 15 by default). Registered in
  app/services/till_parameters.py, edited on the dashboard's tables page (app/services/table_restore.py
  `page_keys`, the group `courses`). The till gets both with its parameters, and the minutes of each
  course in its menu block (`courses[].autoFireMinutes`).
* **Who fires.** One till: the till. The LAN: its host till. The cloud's tables ("שולחנות בענן",
  `source = synced`): the cloud, here, from a background pass (app/services/course_auto_fire_worker.py).
* **When** (the till computes the same, for its countdown "עיקריות יוצאות בעוד 12 דק׳"):
  - the next course is the first held one in the order's sequence (the till's
    `CourseFire.heldCourses`); one the waiter paused ("השהה", `hold`) never goes by itself;
  - the course before it is the latest one in the sequence below it among the order's live lines;
    nothing of it sent yet — no countdown;
  - `after_minutes`: the last time the kitchen got anything of the course before (`sent[*].a`, else
    the order's `sentAt`) plus the next course's minutes (`autoFireMinutesOverride`, else the course's);
  - `after_ready`: the moment every KDS task of the course before is ready (required tasks of a
    preparation station, released, with an active quantity); with none — a shop without a KDS, or
    lines that never reach one — as `after_minutes`.
* **What.** As the till's "הוצא <מנה>" (TablesRepository.send with a course), for that course's lines:
  `fired` gets the course (and `hold` loses it), its live lines are written sent (`sent`, KitchenDiff's
  bookkeeping, `a` = the fire) — a line of an item that goes without a ticket (`sendSilently`, §2)
  sent with `"s": true` and nothing printed — and a round in `log` (`auto: true`, its lines). Not
  `rounds`: a till's own fire of the same course that met this one's version must not take it for its
  own round. The order moves a version, `sentAt` and `sendCount` as a send does.
* **The kitchen.** The tickets through the cloud relay, routed as the till routes them, exactly as the
  void of a dashboard cancel (app/services/table_void_tickets.py, PR #85): the till's printers view of
  the till that worked the table, one job per printer, waiting at the print server (or the printer's
  till). The head "הוצא: <course> (אוטומטי)" (`fire`). The KDS gets a release as after a till's send.
* **Once.** The ids are the till's for the same fire: `fireRequestIdOf(order, course)` =
  UUID.nameUUIDFromBytes("fire|<order>|<course>"), the job of a printer `SendIntents.jobIdOf(seed,
  printer, "ticket")`, the KDS release `SendIntents.releaseIdOf(seed)`. A retry, or a till firing the
  same course at the same moment, is the same job and the same release. The first fire wins: the
  table's row, then the order's, are locked (never waited for) and read again before anything is
  written; a till inside the table (its lock live) is never disturbed — the course goes on the first
  pass after it leaves.
* **The log.** A table event `send` (`details.autoFire`) and a till event `course_auto_fired`
  (accepted from the tills too: the LAN host and the single till report theirs).
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ── The till parameters ───────────────────────────────────────────────────────

AUTO_FIRE_KEY = "autoFire"
OFF = "off"
AFTER_MINUTES = "after_minutes"
AFTER_READY = "after_ready"
OPTIONS = (OFF, AFTER_MINUTES, AFTER_READY)
LABELS = {
    OFF: "כבוי",
    AFTER_MINUTES: "אחרי מספר דקות",
    AFTER_READY: "כשהשלב הקודם מוכן ב-KDS",
}
MINUTES_OVERRIDE_KEY = "autoFireMinutesOverride"
MINUTES_MIN = 1
MINUTES_MAX = 180
MINUTES_DEFAULT = 15

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=AUTO_FIRE_KEY,
        label="הוצאה אוטומטית של השלב הבא",
        value_type="enum",
        enum_options=OPTIONS,
        enum_labels=LABELS,
        default_value=OFF,
        description=(
            "שלבי הגשה בשולחן (ראשונות, עיקריות…). "
            f"«{LABELS[OFF]}» (ברירת מחדל): שלב שבהמתנה יוצא רק כשהמלצר לוחץ \"הוצא\". "
            f"«{LABELS[AFTER_MINUTES]}»: השלב הבא יוצא לבד כמה דקות אחרי שהשלב הקודם יצא. הדקות נקבעות לכל שלב "
            "ב\"שלבי הגשה\", או לכל השלבים ב\"הוצאה אוטומטית: דקות לכל השלבים\". "
            f"«{LABELS[AFTER_READY]}»: השלב הבא יוצא כשה-KDS מסמן את כל המנות של השלב הקודם כמוכנות. בסניף בלי KDS "
            "ההגדרה מתנהגת כמו אחרי מספר דקות. \"השהה\" בקופה עוצר את הספירה עד \"הוצא\". "
            "מי מוציא: בקופה יחידה הקופה, ברשת מקומית הקופה המארחת, ובשולחנות בענן הענן. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=MINUTES_OVERRIDE_KEY,
        label="הוצאה אוטומטית: דקות לכל השלבים",
        value_type="integer",
        default_value=None,
        description=(
            "ריק (ברירת מחדל): כל שלב לפי הדקות שלו ב\"שלבי הגשה\" (15 אם לא נקבע). "
            f"מספר ({MINUTES_MIN}–{MINUTES_MAX}): אותן דקות לכל השלבים ברמה הזו. "
            "חל כשההוצאה האוטומטית היא «אחרי מספר דקות», וגם כשהיא «כשהשלב הקודם מוכן ב-KDS» ואין KDS."
        ),
    ),
)
#: The keys, in the order the dashboard lists them.
LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
#: The keys whose value is checked beyond its type (`clean_value`).
VALIDATED_KEYS = frozenset(LEVEL_KEYS)


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key`, or ValueError (whatever route writes it)."""
    if value is None:
        return None
    if key == AUTO_FIRE_KEY and value not in OPTIONS:
        raise ValueError(f"{AUTO_FIRE_KEY} must be one of {', '.join(OPTIONS)}")
    if key == MINUTES_OVERRIDE_KEY and not (
        isinstance(value, int) and not isinstance(value, bool) and MINUTES_MIN <= value <= MINUTES_MAX
    ):
        raise ValueError(f"{MINUTES_OVERRIDE_KEY} must be {MINUTES_MIN}–{MINUTES_MAX} minutes")
    return value


def mode_of(params: Dict[str, Any]) -> str:
    """`autoFire` as a till parameter map holds it; anything unknown is off."""
    value = params.get(AUTO_FIRE_KEY)
    return value if value in OPTIONS else OFF


def minutes_override_of(params: Dict[str, Any]) -> Optional[int]:
    value = params.get(MINUTES_OVERRIDE_KEY)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = int(value)
    return value if MINUTES_MIN <= value <= MINUTES_MAX else None


# ── The till's ids ────────────────────────────────────────────────────────────


def fire_seed(order_id: Any, course_id: Any) -> str:
    """The till's request id of "הוצא <course>" for the order (SendIntents.fireRequestIdOf, §5)."""
    from app.services.table_void_tickets import java_name_uuid

    return str(java_name_uuid(f"fire|{order_id}|{course_id}"))


def fire_job_id(seed: str, printer_id: Any) -> uuid.UUID:
    """The fire's ticket job for one printer (SendIntents.jobIdOf(seed, printer, "ticket"))."""
    from app.services.table_void_tickets import job_id_of

    return job_id_of(seed, printer_id, "ticket")


def fire_release_id(seed: str) -> str:
    """The fire's KDS release id (SendIntents.releaseIdOf)."""
    from app.services.table_void_tickets import java_name_uuid

    return str(java_name_uuid(f"kds-round|{seed}"))


def event_id(order_id: Any, course_id: Any) -> uuid.UUID:
    """The `course_auto_fired` till event of one fire: one row, however often it is tried."""
    from app.services.tables import _EVENT_NAMESPACE

    return uuid.uuid5(_EVENT_NAMESPACE, f"course_auto_fired:{order_id}:{course_id}")


# ── The order as the till stores it (pure) ────────────────────────────────────

#: The till's quantity epsilon (KitchenDiff.EPS).
EPS = 1e-9
#: How many rounds the send log keeps (TableExtras.ROUNDS_KEPT).
ROUNDS_KEPT = 30
#: A cart line's note the kitchen never gets (the till's VOUCHER_LINE_NOTE_PREFIX).
VOUCHER_LINE_NOTE_PREFIX = "כלול בשובר"
#: The ticket's band, after the course's name: "הוצא: עיקריות (אוטומטי)".
AUTO_SUFFIX = " (אוטומטי)"
#: Where the ticket came from, printed small, and who the KDS says released it.
SOURCE_NAME = "אוטומטי"
ACTOR_NAME = "הוצאה אוטומטית"


@dataclass(frozen=True)
class Course:
    """A line's course as the line keeps it (CourseRef): its id, its name, its place in the sequence."""

    id: str
    name: str
    order: int = 0


@dataclass(frozen=True)
class Line:
    """A table's cart line (HeldSaleCodec): what the kitchen needs of it."""

    id: str
    product_id: str
    category_id: Optional[str]
    name: str
    quantity: float
    notes: Optional[str]
    details: Optional[Dict[str, Any]]

    @property
    def course(self) -> Optional[Course]:
        c = (self.details or {}).get("course")
        if not isinstance(c, dict):
            return None
        ident = _str_or_none(c.get("id"))
        if ident is None:
            return None
        return Course(ident, str(c.get("name") or ""), _int(c.get("order")))

    @property
    def live(self) -> bool:
        return self.quantity > EPS


def _str_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if text and text != "null" else None


def _int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _object(value: Any) -> Optional[Dict[str, Any]]:
    """A JSON object, or the JSON string of one (HeldSaleCodec writes the product as a string)."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            out = json.loads(value)
        except ValueError:
            return None
        return out if isinstance(out, dict) else None
    return None


def cart_lines(cart_json: Optional[str]) -> List[Line]:
    """The cart's lines (TableCartCodec / HeldSaleCodec); unreadable: none."""
    root = _object(cart_json) if cart_json else None
    raw = (root or {}).get("lines")
    if not isinstance(raw, list):
        return []
    out: List[Line] = []
    for o in raw:
        if not isinstance(o, dict):
            continue
        product = _object(o.get("product")) or {}
        line_id = _str_or_none(o.get("id"))
        product_id = _str_or_none(product.get("id"))
        if line_id is None or product_id is None:
            continue
        details = o.get("details")
        out.append(Line(
            id=line_id,
            product_id=product_id,
            category_id=_str_or_none(product.get("categoryId")),
            name=str(product.get("name") or ""),
            quantity=_float(o.get("quantity")),
            notes=_str_or_none(o.get("notes")),
            details=details if isinstance(details, dict) else None,
        ))
    return out


def extras_of(extras_json: Optional[str]) -> Dict[str, Any]:
    """The order's kitchen bookkeeping (TableExtras) as its JSON object; unreadable: empty."""
    root = _object(extras_json) if extras_json else None
    return dict(root) if root else {}


def _strings(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(v) for v in value if v is not None and str(v) != ""]


def sent_quantities(extras: Dict[str, Any], *, paper_only: bool = False) -> Dict[str, float]:
    """
    What the kitchen has of each line (`sent`), for the lines it has any of. `paper_only`: not the
    lines marked "נשלח (בלי בון)" (`"s": true`, §2) — the kitchen never had those on paper.
    """
    sent = extras.get("sent")
    if not isinstance(sent, dict):
        return {}
    out = {}
    for line_id, s in sent.items():
        if isinstance(s, dict) and _float(s.get("q")) > EPS and not (paper_only and s.get("s") is True):
            out[str(line_id)] = _float(s.get("q"))
    return out


def fired_courses(lines: Sequence[Line], extras: Dict[str, Any]) -> Set[str]:
    """
    CourseFire.fired: those fired ("הוצא", `fired`), the first one the order has unless paused
    (`hold`), and any the kitchen already has lines of on paper (a line "נשלח (בלי בון)" fires nothing).
    """
    hold = set(_strings(extras.get("hold")))
    live = [line for line in lines if line.live]
    courses = [line.course for line in live if line.course is not None]
    first = min(courses, key=lambda c: c.order).id if courses else None
    sent = sent_quantities(extras, paper_only=True)
    out = set(_strings(extras.get("fired")))
    if first is not None and first not in hold:
        out.add(first)
    out.update(line.course.id for line in live if line.course is not None and line.id in sent)
    return out


def all_sent(line: Line, extras: Dict[str, Any]) -> bool:
    """All of the line marked sent already (a "נשלח (בלי בון)" one): nothing of it waits (CourseFire.allSent)."""
    return sent_quantities(extras).get(line.id, 0.0) >= line.quantity - EPS


def held_courses(lines: Sequence[Line], extras: Dict[str, Any]) -> List[Course]:
    """
    CourseFire.heldCourses: the order's courses not fired yet, in the sequence (ties: as they come) —
    each with something left to send (a course of lines all marked sent has nothing to fire).
    """
    fired = fired_courses(lines, extras)
    seen: Dict[str, Course] = {}
    waiting: Set[str] = set()
    for line in lines:
        course = line.course
        if not line.live or course is None:
            continue
        seen.setdefault(course.id, course)
        if not all_sent(line, extras):
            waiting.add(course.id)
    return sorted((c for c in seen.values() if c.id not in fired and c.id in waiting), key=lambda c: c.order)


def previous_course(lines: Sequence[Line], course: Course) -> Optional[Course]:
    """The latest course in the sequence below `course` among the order's live lines (ties: the first)."""
    best: Optional[Course] = None
    for line in lines:
        c = line.course
        if not line.live or c is None or c.id == course.id or c.order >= course.order:
            continue
        if best is None or c.order > best.order:
            best = c
    return best


def course_lines(lines: Sequence[Line], course_id: str) -> List[Line]:
    return [line for line in lines if line.live and line.course is not None and line.course.id == course_id]


def parse_time(value: Any) -> Optional[datetime]:
    """An ISO time as the till writes it ("…T18:44:00.000Z", or with an offset); naive is UTC."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def till_time(moment: datetime) -> str:
    """`moment` as the till's Clock.nowIso writes it: UTC, milliseconds, "Z"."""
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def went_out_at(lines: Sequence[Line], extras: Dict[str, Any], course_id: str, fallback: Optional[datetime]) -> Optional[datetime]:
    """
    When the kitchen last got anything of the course: the latest `a` of its live lines it has (§5);
    none of them with a time (sent by a till before `a`) — the order's last send, `fallback`.
    """
    sent = extras.get("sent") if isinstance(extras.get("sent"), dict) else {}
    times = []
    for line in course_lines(lines, course_id):
        s = sent.get(line.id)
        if isinstance(s, dict) and _float(s.get("q")) > EPS:
            moment = parse_time(s.get("a"))
            if moment is not None:
                times.append(moment)
    if times:
        return max(times)
    return fallback


@dataclass(frozen=True)
class Pending:
    """The course that would go next, and the one before it (whose lines the kitchen has)."""

    course: Course
    previous: Course
    #: The live lines of the course before that the kitchen has on paper — what `after_ready` waits on.
    previous_line_ids: Tuple[str, ...]


def next_pending(lines: Sequence[Line], extras: Dict[str, Any]) -> Optional[Pending]:
    """
    The next held course, when it may go by itself: not paused ("השהה"), with a course before it
    that the kitchen has lines of. None otherwise.
    """
    held = held_courses(lines, extras)
    if not held:
        return None
    course = held[0]
    if course.id in set(_strings(extras.get("hold"))):
        return None
    previous = previous_course(lines, course)
    if previous is None:
        return None
    sent = sent_quantities(extras)
    went = [line.id for line in course_lines(lines, previous.id) if line.id in sent]
    if not went:
        return None  # nothing of it sent (a line "נשלח (בלי בון)" counts: its course went out)
    paper = sent_quantities(extras, paper_only=True)
    return Pending(course, previous, tuple(i for i in went if i in paper))


@dataclass(frozen=True)
class Plan:
    """When the next course goes, and why."""

    pending: Pending
    #: `after_minutes` | `after_ready` — what decided (`after_ready` without KDS tasks is `after_minutes`).
    trigger: str
    minutes: int
    #: None: not yet known (the KDS has not made the course before ready).
    due_at: Optional[datetime]

    def due(self, now: datetime) -> bool:
        return self.due_at is not None and self.due_at <= now


#: The KDS's word on the course before: None — no task of it counts (no KDS); else (all ready, when).
KdsState = Optional[Tuple[bool, Optional[datetime]]]


def plan_of(
    pending: Pending,
    *,
    mode: str,
    minutes: int,
    went_out: Optional[datetime],
    now: datetime,
    kds: Callable[[Sequence[str]], KdsState] = lambda ids: None,
) -> Optional[Plan]:
    """The plan of `pending` under `autoFire` = `mode`; None when it never goes by itself."""
    if mode == AFTER_READY:
        state = kds(pending.previous_line_ids)
        if state is not None:
            ready, at = state
            return Plan(pending, AFTER_READY, minutes, (at or now) if ready else None)
    elif mode != AFTER_MINUTES:
        return None
    if went_out is None:
        return None
    return Plan(pending, AFTER_MINUTES, minutes, went_out + timedelta(minutes=minutes))


# ── The kitchen's words (KitchenMenu, ported) ─────────────────────────────────

_ALLERGEN_HE = {
    "gluten": "גלוטן", "milk": "חלב", "nuts": "אגוזים", "eggs": "ביצים", "peanuts": "בוטנים",
    "fish": "דגים", "soy": "סויה", "sesame": "שומשום", "celery": "סלרי", "mustard": "חרדל",
    "sulphites": "סולפיטים", "lupin": "תורמוס", "molluscs": "רכיכות", "crustaceans": "סרטנים",
}
_PRE_HE = {"lite": "מעט", "extra": "הרבה", "side": "בצד"}


@dataclass(frozen=True)
class KitchenItem:
    """One line for the kitchen (KitchenItem + KitchenExtras): routed by its product, then category."""

    product_id: str
    category_id: Optional[str]
    name: str
    quantity: float
    notes: Optional[str] = None
    mods: Tuple[str, ...] = field(default_factory=tuple)
    removals: Tuple[str, ...] = field(default_factory=tuple)
    important: bool = False
    allergies: Tuple[str, ...] = field(default_factory=tuple)
    seat: Optional[str] = None
    course: Optional[str] = None
    meal_name: Optional[str] = None
    refill: Optional[str] = None
    line_id: Optional[str] = None


def kitchen_text(m: Dict[str, Any]) -> str:
    """LineModifier.kitchenText: "+ גבינה", "בלי בצל", "מדיום", "הרבה גבינה ×2"."""
    kitchen_name = _str_or_none(m.get("kitchenName"))
    base = kitchen_name if kitchen_name and kitchen_name.strip() else str(m.get("name") or "")
    pre = _str_or_none(m.get("pre"))
    if pre == "side":
        with_pre = f"{base} {_PRE_HE['side']}"
    elif pre in _PRE_HE:
        with_pre = f"{_PRE_HE[pre]} {base}"
    else:
        with_pre = base
    kind = m.get("kind")
    if kind == "removal":
        text = f"בלי {with_pre}"
    elif kind == "choice":
        text = with_pre
    else:  # GroupKind.parse: anything else is an add-on
        text = f"+ {with_pre}"
    qty = max(_int(m.get("qty"), 1), 1)
    return f"{text} ×{qty}" if qty > 1 else text


def _split(mods: Any) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    rows = [m for m in mods if isinstance(m, dict)] if isinstance(mods, list) else []
    return (
        tuple(kitchen_text(m) for m in rows if m.get("kind") != "removal"),
        tuple(kitchen_text(m) for m in rows if m.get("kind") == "removal"),
    )


def seat_text(seat: Any, names: Dict[int, str]) -> Optional[str]:
    """"סועד 2" or "סועד 2 · דנה"."""
    if seat is None or isinstance(seat, bool):
        return None
    n = _int(seat, -1)
    if n < 0:
        return None
    name = (names.get(n) or "").strip()
    return f"סועד {n} · {name}" if name else f"סועד {n}"


def _allergies(codes: Any) -> Tuple[str, ...]:
    wanted = {str(c).strip().lower() for c in codes} if isinstance(codes, list) else set()
    return tuple(he for code, he in _ALLERGEN_HE.items() if code in wanted)


def _join(parts: Iterable[Optional[str]]) -> Optional[str]:
    text = " · ".join(p for p in parts if p)
    return text or None


def _note_line(d: Dict[str, Any]) -> Optional[str]:
    note_text = _str_or_none(d.get("noteText"))
    return _join(_strings(d.get("notes")) + [note_text.strip() if note_text and note_text.strip() else None])


def expand(
    product_id: str,
    category_id: Optional[str],
    name: str,
    quantity: float,
    line_notes: Optional[str],
    details: Optional[Dict[str, Any]],
    seat_names: Dict[int, str],
) -> List[KitchenItem]:
    """KitchenMenu.expand: a line as the kitchen gets it — one item, or a meal's components."""
    if details is None:
        return [KitchenItem(product_id, category_id, name, quantity, line_notes)]
    companion = details.get("companionOf") if isinstance(details.get("companionOf"), dict) else None
    if companion is not None and companion.get("kitchenPrint") is False:
        return []
    if companion is not None and companion.get("kitchenPrint") is True and str(companion.get("parentProductId") or "").strip():
        rest = {k: v for k, v in details.items() if k != "companionOf"}
        return expand(str(companion["parentProductId"]), None, name, quantity, line_notes, rest, seat_names)
    notes = _join([_note_line(details), line_notes.strip() if line_notes and line_notes.strip() else None])
    allergies = _allergies(details.get("allergies"))
    seat = seat_text(details.get("seat"), seat_names)
    course = details.get("course") if isinstance(details.get("course"), dict) else None
    course_name = str(course.get("name") or "") if course is not None and _str_or_none(course.get("id")) else None
    important = details.get("important") is True
    meal = details.get("meal") if isinstance(details.get("meal"), dict) else None
    components = [c for c in (meal or {}).get("components") or [] if isinstance(c, dict)]
    if meal is not None and components:
        out = []
        for c in components:
            mods, removals = _split(c.get("modifiers"))
            own = _join([_note_line(c), notes])
            out.append(KitchenItem(
                product_id=str(c.get("productId") or ""),
                category_id=_str_or_none(c.get("categoryId")),
                name=str(c.get("name") or ""),
                quantity=max(_int(c.get("qty"), 1), 1) * quantity,
                notes=own, mods=mods, removals=removals, important=important, allergies=allergies,
                seat=seat, course=course_name, meal_name=str(meal.get("name") or ""),
            ))
        return out
    mods, removals = _split(details.get("modifiers"))
    ref = details.get("mealRef") if isinstance(details.get("mealRef"), dict) else None
    refill = None
    meal_name = None
    if ref is not None and _str_or_none(ref.get("lineRef")):
        kind = str(ref.get("kind") or "deferred")
        if kind != "refill" or _str_or_none(ref.get("mealProductId")) is not None:
            meal_name = _str_or_none(ref.get("mealName"))
        if kind == "refill":
            number = "" if ref.get("number") is None else str(_int(ref.get("number")))
            of = "" if ref.get("of") is None else f"/{_int(ref.get('of'))}"
            refill = f"ריפיל {number}{of}".strip()
    return [KitchenItem(
        product_id, category_id, name, quantity, notes, mods=mods, removals=removals, important=important,
        allergies=allergies, seat=seat, course=course_name, meal_name=meal_name, refill=refill,
    )]


def line_notes(line: Line, extras: Dict[str, Any]) -> Optional[str]:
    """The note the kitchen gets for a line (KitchenDiff): "עוד → הערות", else the cart line's own."""
    notes = extras.get("notes") if isinstance(extras.get("notes"), dict) else {}
    own = _str_or_none(notes.get(line.id))
    if own is not None:
        return own
    text = (line.notes or "").strip()
    return text if text and not text.startswith(VOUCHER_LINE_NOTE_PREFIX) else None


def seat_names_of(extras: Dict[str, Any]) -> Dict[int, str]:
    seats = extras.get("seats") if isinstance(extras.get("seats"), dict) else {}
    out = {}
    for k, v in seats.items():
        n = _int(k, -1)
        if n >= 0 and v is not None:
            out[n] = str(v)
    return out


def items_of(line: Line, quantity: float, notes: Optional[str], seat_names: Dict[int, str]) -> List[KitchenItem]:
    """`quantity` of a line as the kitchen gets it, each item knowing its cart line."""
    return [replace(i, line_id=line.id) for i in expand(
        line.product_id, line.category_id, line.name, quantity, notes, line.details, seat_names,
    )]


def _number(value: float) -> Any:
    """A quantity as the till's org.json writes it: 2, not 2.0."""
    return int(value) if float(value).is_integer() else value


def snapshot(line: Line, seat_names: Dict[int, str]) -> Optional[str]:
    """KitchenMenu.snapshot: what the kitchen got for one unit of a dish made through the menu (`k`)."""
    if line.details is None:
        return None
    rows = []
    for i in expand(line.product_id, line.category_id, line.name, 1.0, None, line.details, seat_names):
        o: Dict[str, Any] = {"p": i.product_id, "n": i.name, "q": _number(i.quantity)}
        if i.category_id is not None:
            o["c"] = i.category_id
        if i.mods:
            o["m"] = list(i.mods)
        if i.removals:
            o["r"] = list(i.removals)
        if i.seat is not None:
            o["s"] = i.seat
        if i.course is not None:
            o["o"] = i.course
        if i.meal_name is not None:
            o["ml"] = i.meal_name
        rows.append(o)
    return json.dumps(rows, ensure_ascii=False, separators=(",", ":"))


def _clip(text: Optional[str], limit: int) -> Optional[str]:
    if text is None:
        return None
    text = str(text).strip()
    return text[:limit] if text else None


def ticket_line(item: KitchenItem) -> Dict[str, Any]:
    """The item as a ticket line (KitchenTicketLine.toDto)."""
    from app.schemas.kitchen_printers import TICKET_NOTES_MAX, TICKET_TEXT_MAX

    return {
        "productId": _clip(item.product_id, 100),
        "categoryId": _clip(item.category_id, 100),
        "name": _clip(item.name, TICKET_TEXT_MAX) or "?",
        "quantity": item.quantity,
        "notes": _clip(item.notes, TICKET_NOTES_MAX),
        "mods": [_clip(m, TICKET_TEXT_MAX) for m in item.mods[:40]] or None,
        "removals": [_clip(m, TICKET_TEXT_MAX) for m in item.removals[:40]] or None,
        "important": True if item.important else None,
        "allergies": list(item.allergies[:20]) or None,
        "seat": _clip(item.seat, TICKET_TEXT_MAX),
        "course": _clip(item.course, TICKET_TEXT_MAX),
        "mealName": _clip(item.meal_name, TICKET_TEXT_MAX),
        "refill": _clip(item.refill, TICKET_TEXT_MAX),
    }


def kds_item(line_key: str, item: KitchenItem, quantity: float) -> Dict[str, Any]:
    """KdsRelease.itemJson."""
    out: Dict[str, Any] = {
        "lineKey": line_key[:120], "productId": item.product_id[:64], "name": item.name[:200], "quantity": quantity,
    }
    if item.category_id and item.category_id.strip():
        out["categoryId"] = item.category_id[:64]
    notes = (item.notes or "").strip()
    if notes:
        out["notes"] = notes[:500]
    if item.mods:
        out["mods"] = [m[:200] for m in item.mods[:40]]
    if item.removals:
        out["removals"] = [m[:200] for m in item.removals[:40]]
    if item.allergies:
        out["allergies"] = list(item.allergies[:20])
    if item.important:
        out["important"] = True
    if item.seat is not None:
        out["seat"] = item.seat[:60]
    if item.course is not None:
        out["course"] = item.course[:60]
    if (item.meal_name or item.refill) is not None:
        out["mealName"] = (item.meal_name or item.refill)[:100]
    return out


def kds_items(line: Line, quantity: float, notes: Optional[str], seat_names: Dict[int, str]) -> List[Dict[str, Any]]:
    """A line's KDS items, keyed "<line id>:<component index>" as every round keys them."""
    return [kds_item(f"{line.id}:{i}", item, item.quantity) for i, item in enumerate(items_of(line, quantity, notes, seat_names))]


# ── What the fire writes (pure) ───────────────────────────────────────────────


@dataclass
class FireWrite:
    """The fire of one course on one order: its bookkeeping, and what goes to the kitchen."""

    seed: str
    extras: Dict[str, Any]
    #: (line, quantity added, the kitchen's note) of every line printed and sent to the KDS.
    printed: List[Tuple[Line, float, Optional[str]]]
    #: The lines marked sent without a ticket ("יוצא בלי בון").
    silent: List[str]
    #: "הערה לשולחן" (P:/specs/live-tables-cloud.md §6.5) this round prints, now marked printed by it.
    note: Optional[str] = None


#: The table's note on its next ticket (P:/specs/live-tables-cloud.md §6.5): "הערה לשולחן: …".
TABLE_NOTE_KEY = "tableNote"
TABLE_NOTE_PREFIX = "הערה לשולחן: "


def pending_note(extras: Dict[str, Any]) -> Optional[str]:
    """The table's note when no round printed it yet (`tableNote` without `p`); None otherwise."""
    note = extras.get(TABLE_NOTE_KEY)
    if not isinstance(note, dict) or note.get("p"):
        return None
    text = _str_or_none(note.get("t"))
    return text.strip() if text and text.strip() else None


def note_notice(text: Optional[str]) -> Optional[str]:
    return f"{TABLE_NOTE_PREFIX}{text}" if text else None


def write_fire(
    order_id: Any,
    lines: Sequence[Line],
    extras: Dict[str, Any],
    course: Course,
    now: datetime,
    *,
    silent: Callable[[Line], bool] = lambda line: False,
    auto: bool = True,
) -> FireWrite:
    """
    The till's automatic "הוצא <course>" (AutoFire.fire: TableExtras.withFired, SilentSend.mark for the
    lines of an item that goes "יוצא בלי בון", then KitchenDiff for the rest of the course's lines) on a
    copy of the order's bookkeeping, and a round in the send log (`auto`; the dashboard's "הוצא" —
    `auto` false — logs it as a plain round). Nothing else of the order is sent: other lines wait for
    the waiter's "שלח" as they did. A table note no round printed yet goes with a round that prints
    something, and is marked printed by it (`tableNote.p`).
    """
    root = json.loads(json.dumps(extras))  # a deep copy: the caller's stays as read
    seed = fire_seed(order_id, course.id)
    at = till_time(now)
    seat_names = seat_names_of(root)
    sent = root.get("sent") if isinstance(root.get("sent"), dict) else {}
    root["sent"] = sent
    if not isinstance(root.get("notes"), dict):
        root["notes"] = {}
    printed: List[Tuple[Line, float, Optional[str]]] = []
    quiet: List[str] = []
    added: Dict[str, Any] = {}
    for line in course_lines(lines, course.id):
        before_row = sent.get(line.id) if isinstance(sent.get(line.id), dict) else None
        before = _float((before_row or {}).get("q"))
        delta = line.quantity - before
        note = line_notes(line, root)
        entry: Dict[str, Any] = {
            "q": _number(line.quantity), "n": line.name, "p": line.product_id, "c": line.category_id, "t": note,
        }
        k = snapshot(line, seat_names)
        if k is not None:
            entry["k"] = k
        if delta > EPS and silent(line):
            # SilentSend.mark: all of it sent, now, with no ticket — unless the kitchen has part of it on
            # paper already (its void must still reach the kitchen): then a paper line, not printed now.
            on_paper = before > EPS and (before_row or {}).get("s") is not True
            entry["a"] = at
            if not on_paper:
                entry["s"] = True
            sent[line.id] = entry
            quiet.append(line.id)
            continue
        moment = at if delta > EPS else (before_row or {}).get("a")
        if moment is not None:
            entry["a"] = moment
        if delta <= EPS and (before_row or {}).get("s") is True:
            entry["s"] = True  # "נשלח (בלי בון)" stays so until a ticket gives the kitchen more of it
        sent[line.id] = entry
        if delta > EPS:
            printed.append((line, delta, note))
            added[line.id] = _number(delta)
    fired = _strings(root.get("fired"))
    if course.id not in fired:
        fired.append(course.id)
    root["fired"] = fired
    hold = [c for c in _strings(root.get("hold")) if c != course.id]
    if hold:
        root["hold"] = hold
    else:
        root.pop("hold", None)
    note = None
    if added:
        log = [r for r in root.get("log") or [] if isinstance(r, dict) and r.get("i") != seed]
        log.append({"i": seed, "a": at, "l": added, **({"auto": True} if auto else {})})
        root["log"] = log[-ROUNDS_KEPT:]
        note = pending_note(root)
        if note is not None:
            root[TABLE_NOTE_KEY] = {**root[TABLE_NOTE_KEY], "p": seed}
    return FireWrite(seed=seed, extras=root, printed=printed, silent=quiet, note=note)


def held_after(lines: Sequence[Line], extras: Dict[str, Any]) -> List[Line]:
    """
    The lines still held at the table (CourseFire.heldLineIds — never one all sent already): the KDS
    release's complete `held` set.
    """
    fired = fired_courses(lines, extras)
    return [
        line for line in lines
        if line.live and line.course is not None and line.course.id not in fired and not all_sent(line, extras)
    ]


def encode_extras(extras: Dict[str, Any]) -> str:
    return json.dumps(extras, ensure_ascii=False, separators=(",", ":"))


# ── "יוצא בלי בון" (§2), resolved as the till resolves it ───────────────────────


def silent_products(db: Session, lines: Sequence[Line]) -> Set[str]:
    """
    The lines' products that go without a ticket (`sendSilently`): the product's own flag, else its
    category's, else the parent's… — off when none says.
    """
    from app.models.category import Category
    from app.models.product import Product

    ids = set()
    for line in lines:
        try:
            ids.add(uuid.UUID(line.product_id))
        except (TypeError, ValueError, AttributeError):
            continue
    rows = {
        str(pid): (flag, cid)
        for pid, flag, cid in db.query(Product.id, Product.send_silently, Product.category_id).filter(Product.id.in_(list(ids))).all()
    } if ids else {}
    cache: Dict[str, Optional[bool]] = {}

    def category_flag(category_id: Optional[str], depth: int = 0) -> Optional[bool]:
        if category_id is None or depth > 20:
            return None
        if category_id in cache:
            return cache[category_id]
        try:
            ident = uuid.UUID(str(category_id))
        except (TypeError, ValueError):
            return None
        row = db.query(Category.send_silently, Category.parent_id).filter(Category.id == ident).first()
        value = None
        if row is not None:
            value = row[0] if row[0] is not None else category_flag(str(row[1]) if row[1] else None, depth + 1)
        cache[category_id] = value
        return value

    out = set()
    for line in lines:
        flag, category_id = rows.get(line.product_id, (None, None))
        if flag is None:
            flag = category_flag(str(category_id) if category_id else line.category_id)
        if flag:
            out.add(line.product_id)
    return out


# ── The cloud's tables: one order ─────────────────────────────────────────────

#: The till event of an auto-fire (app/services/exceptions.py TILL_EVENT_TYPES).
EVENT_TYPE = "course_auto_fired"


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _as_utc(moment: Optional[datetime]) -> Optional[datetime]:
    from app.services.areas import as_utc

    return as_utc(moment)


def table_title(table: Any) -> str:
    """The till's tableTitle: "12", "12 · VIP", or a restored table's label alone ("ש-12")."""
    from app.services.table_void_tickets import table_title as plain

    name = (getattr(table, "name", None) or "").strip()
    if getattr(table, "label_only", False) and name:
        return name
    return plain(table.number, table.name)


ParamsCache = Dict[Any, Tuple[str, Optional[int]]]


def params_of(db: Session, machine: Any, cache: Optional[ParamsCache] = None) -> Tuple[str, Optional[int]]:
    """(`autoFire`, `autoFireMinutesOverride`) of the till; resolved once per till per pass."""
    if cache is not None and machine.id in cache:
        return cache[machine.id]
    from app.services import tables as T

    params = T.machine_params(db, machine)
    out = (mode_of(params), minutes_override_of(params))
    if cache is not None:
        cache[machine.id] = out
    return out


def course_minutes(db: Session, tenant_id: Any, course_id: str, override: Optional[int]) -> int:
    """The next course's minutes: the level's override, else the course's own (15 when it is gone)."""
    if override is not None:
        return override
    from app.models.menu import MenuCourse
    from app.services.menu import course_minutes as of_course

    ident = _uuid(course_id)
    row = (
        db.query(MenuCourse).filter(MenuCourse.id == ident, MenuCourse.tenant_id == tenant_id).first()
        if ident is not None else None
    )
    return of_course(row) if row is not None else MINUTES_DEFAULT


def kds_state_of(db: Session, order: Any) -> Callable[[Sequence[str]], KdsState]:
    """
    The KDS's word on lines of the order: None when no task of them counts for readiness (no KDS,
    a view-only order, lines no station prepares); else whether all are ready, and when the last was.
    """
    def state(line_ids: Sequence[str]) -> KdsState:
        from app.models.kds import KitchenOrder, KitchenTask
        from app.services import kds as KDS

        kitchen = (
            db.query(KitchenOrder)
            .filter(
                KitchenOrder.tenant_id == order.tenant_id,
                KitchenOrder.source == "table",
                KitchenOrder.source_ref == str(order.id),
            )
            .first()
        )
        if kitchen is None:
            return None
        wanted = set(line_ids)
        tasks = [
            t for t in db.query(KitchenTask).filter(KitchenTask.order_id == kitchen.id).all()
            if (t.line_key or "").split(":", 1)[0] in wanted
        ]
        counted = [t for t in KDS.required_tasks(tasks) if (t.target_kind or "prep") == "prep"]
        if not counted:
            return None
        if all(t.prep_state == "ready" for t in counted):
            times = [_as_utc(t.ready_at) for t in counted if t.ready_at is not None]
            return True, (max(times) if times else None)
        return False, None

    return state


@dataclass
class Evaluation:
    plan: Plan
    routing: Any
    mode: str


def evaluate(db: Session, order: Any, table: Any, now: datetime, cache: Optional[ParamsCache] = None) -> Optional[Evaluation]:
    """
    The next course of a cloud-tables order and when it goes by itself — by the parameters of the
    till that worked the table (else the one that opened it, else one of its point of sale).
    None: nothing goes by itself (off, paused, nothing before it sent, no till).
    """
    from app.services import table_void_tickets as VT

    lines = cart_lines(order.cart_json)
    extras = extras_of(order.extras_json)
    pending = next_pending(lines, extras)
    if pending is None:
        return None
    routing = VT.routing_machine(db, order, table, order.updated_machine_id)
    if routing is None:
        return None
    mode, override = params_of(db, routing, cache)
    if mode == OFF:
        return None
    minutes = course_minutes(db, order.tenant_id, pending.course.id, override)
    went_out = went_out_at(lines, extras, pending.previous.id, _as_utc(order.sent_at))
    plan = plan_of(pending, mode=mode, minutes=minutes, went_out=went_out, now=now, kds=kds_state_of(db, order))
    return Evaluation(plan, routing, mode) if plan is not None else None


def _waiter(order: Any) -> Optional[str]:
    return order.waiter_pos_user_name or order.opened_by_pos_user_name or None


def queue_fire_tickets(
    db: Session,
    order: Any,
    table: Any,
    items: List[KitchenItem],
    *,
    routing: Any,
    course: Course,
    seed: str,
    is_addition: bool,
    now: datetime,
    band: Optional[str] = None,
    notice: Optional[str] = None,
    source_name: str = SOURCE_NAME,
) -> List[Any]:
    """
    The fire's tickets through the relay, as the void of a dashboard cancel goes (table_void_tickets):
    the till's routing over its printers view, one job per printer under the till's id for this fire.
    A job already made for it is answered as it stands (a retry). [band]: the fire's words ("עיקריות
    (אוטומטי)" by default); [notice]: a band at the head (the table's note, §6.5).
    """
    return queue_table_tickets(
        db, order, table, items, routing=routing, seed=seed, is_addition=is_addition, now=now,
        # "הוצא: עיקריות (אוטומטי)" — the band the printing till draws for a fired course.
        fire=band if band is not None else f"{course.name}{AUTO_SUFFIX}",
        notice=notice, source_name=source_name,
    )


def queue_table_tickets(
    db: Session,
    order: Any,
    table: Any,
    items: List[KitchenItem],
    *,
    routing: Any,
    seed: str,
    is_addition: bool,
    now: datetime,
    fire: Optional[str] = None,
    notice: Optional[str] = None,
    source_name: str = SOURCE_NAME,
) -> List[Any]:
    """
    A table's tickets through the relay (a fire, the dashboard's reprint or rush — P:/specs/
    live-tables-cloud.md §6.6): the till's routing over the printers view of the till that worked the
    table, one job per printer under `jobIdOf(seed, printer, "ticket")`. A job already made for it is
    answered as it stands (a retry). [fire]: the "הוצא: …" band; [notice]: the band at the head
    ("הדפסה חוזרת", "זרז!", the table's note).
    """
    from app.models.printers import KitchenPrinter, KitchenPrintJob
    from app.models.tables import TableZone
    from app.schemas.kitchen_printers import TICKET_LINES_MAX, TICKET_TEXT_MAX, TicketIn
    from app.services import printers as K
    from app.services import table_void_tickets as VT

    config = K.sync_payload(db, routing)
    zone_id = str(table.zone_id) if table.zone_id is not None else None
    routed = VT.route(VT._current_categories(db, items), config, zone_id)
    if not routed:
        return []
    printers = {
        str(p.id): p
        for p in db.query(KitchenPrinter).filter(KitchenPrinter.id.in_([uuid.UUID(pid) for pid, _ in routed])).all()
    }
    zone = db.get(TableZone, table.zone_id) if table.zone_id is not None else None
    guests = order.guests if order.guests is not None and 0 <= order.guests <= 10_000 else None
    head = {
        "source": "table",
        "tableName": _clip(table_title(table), TICKET_TEXT_MAX),
        "zoneName": _clip(zone.name, TICKET_TEXT_MAX) if zone is not None else None,
        "guests": guests,
        "waiterName": _clip(_waiter(order), TICKET_TEXT_MAX),
        "createdAt": now.isoformat(),
        "isAddition": is_addition,
        "orderRef": str(order.id)[:8],
        "sourceName": _clip(source_name, TICKET_TEXT_MAX),
    }
    if fire:
        head["fire"] = _clip(fire, TICKET_TEXT_MAX)
    if notice:
        head["notice"] = _clip(notice, TICKET_TEXT_MAX)
    print_host = K.print_host_of_shop(db, order.shop_id)
    jobs: List[Any] = []
    for pid, its in routed:
        printer = printers.get(pid)
        if printer is None:
            continue
        job_id = fire_job_id(seed, pid)
        existing = db.get(KitchenPrintJob, job_id)
        if existing is not None:
            jobs.append(existing)
            continue
        target = VT.void_target(printer, print_host, routing)
        if target is None:
            logger.warning("ticket of table order %s: printer %s has no till to print it", order.id, pid)
            continue
        if len(its) > TICKET_LINES_MAX:
            logger.warning(
                "ticket of table order %s: %d lines on %s, the first %d sent", order.id, len(its), pid, TICKET_LINES_MAX,
            )
        ticket = TicketIn.model_validate({**head, "lines": [ticket_line(i) for i in its[:TICKET_LINES_MAX]]})
        job = KitchenPrintJob(
            id=job_id,
            tenant_id=printer.tenant_id,
            shop_id=printer.shop_id,
            printer_id=printer.id,
            printer_name=printer.name,
            kind="ticket",
            target_machine_id=target,
            source_machine_id=None,
            created_by_user_id=None,
            status="pending",
            payload=ticket.model_dump(by_alias=True),
            created_at=now,
            expires_at=now + K.JOB_TTL,
        )
        db.add(job)
        jobs.append(job)
    db.flush()
    return jobs


def _own_note(line: Line) -> Optional[str]:
    """A held line's note as KitchenMenu.of reads it: the cart line's own (a voucher's mark left out)."""
    text = (line.notes or "").strip()
    return text if text and not text.startswith(VOUCHER_LINE_NOTE_PREFIX) else None


def release_to_kds(
    db: Session, order: Any, table: Any, routing: Any, write: FireWrite, lines: Sequence[Line], now: datetime,
    *, actor_name: str = ACTOR_NAME,
) -> Optional[Dict[str, Any]]:
    """
    The fire on the kitchen screens, as a till's send releases it (KdsBridge.prepareTableRelease):
    the course's lines, the lines still held (the complete set), under the fire's release id.
    """
    from app.models.kds import KitchenOrder
    from app.models.pos_machine import POSMachine
    from app.models.tables import TableZone
    from app.schemas.kds import TEXT_MAX, KdsReleaseIn
    from app.services import kds as KDS

    seat_names = seat_names_of(write.extras)
    items = [i for line, qty, note in write.printed for i in kds_items(line, qty, note, seat_names)]
    if not items:
        return None
    held = [
        i for line in held_after(lines, write.extras)
        for i in kds_items(line, line.quantity, _own_note(line), seat_names)
    ]
    kitchen = (
        db.query(KitchenOrder)
        .filter(
            KitchenOrder.tenant_id == order.tenant_id,
            KitchenOrder.source == "table",
            KitchenOrder.source_ref == str(order.id),
        )
        .first()
    )
    owner = db.get(POSMachine, kitchen.machine_id) if kitchen is not None and kitchen.machine_id is not None else None
    if owner is None or str(owner.shop_id) != str(order.shop_id):
        owner = routing
    zone = db.get(TableZone, table.zone_id) if table.zone_id is not None else None
    title = table_title(table)
    waiter = _waiter(order)
    body = KdsReleaseIn.model_validate({
        "id": fire_release_id(write.seed),
        "source": "table",
        "sourceRef": str(order.id),
        "trigger": "send",
        "paid": False,
        "occurredAt": now,
        "displayRef": title[:60],
        "tableRef": title[:60],
        "zoneName": zone.name[:100] if zone is not None and zone.name else None,
        "guests": order.guests if order.guests is not None and 0 <= order.guests <= 10_000 else None,
        "waiterName": waiter[:TEXT_MAX] if waiter else None,
        "actorName": (actor_name or ACTOR_NAME)[:TEXT_MAX],
        "items": items,
        "held": held,
        "noteUpdates": [],
    })
    return KDS.release(db, owner, body)


def record_till_event(db: Session, machine: Any, order: Any, plan: Plan, now: datetime, lines: int) -> None:
    """`course_auto_fired` (§1 "יומן"), as a till event of the till that worked the table. Never fails the fire."""
    from app.models.audit_exception import TillEvent

    ident = event_id(order.id, plan.pending.course.id)
    try:
        with db.begin_nested():
            if db.get(TillEvent, ident) is not None:
                return
            db.add(TillEvent(
                id=ident,
                tenant_id=machine.tenant_id,
                machine_id=machine.id,
                shop_id=order.shop_id,
                area_id=getattr(machine, "area_id", None),
                shift_id=None,
                event_type=EVENT_TYPE,
                occurred_at=now,
                pos_user_id=None,
                amount=None,
                transaction_id=None,
                details={
                    "source": "cloud",
                    "orderId": str(order.id),
                    "tableNumber": order.table_number,
                    "tableName": order.table_name,
                    "courseId": plan.pending.course.id,
                    "courseName": plan.pending.course.name,
                    "previousCourseId": plan.pending.previous.id,
                    "previousCourseName": plan.pending.previous.name,
                    "trigger": plan.trigger,
                    "minutes": plan.minutes,
                    "lines": lines,
                },
                received_at=now,
            ))
            db.flush()
    except Exception:  # noqa: BLE001 - the log is never worth the fire
        logger.exception("course_auto_fired of table order %s not recorded", order.id)


def fire_course(
    db: Session,
    order: Any,
    table: Any,
    routing: Any,
    course: Course,
    now: datetime,
    *,
    auto: bool = True,
    band: Optional[str] = None,
    source_name: str = SOURCE_NAME,
    actor_name: str = ACTOR_NAME,
) -> Optional[Dict[str, Any]]:
    """
    "הוצא <course>" on rows the caller locked and read again — the cloud's auto-fire (`apply_fire`) and
    the dashboard's "הוצא" (app/services/table_actions.py, `auto` false): the order's bookkeeping and
    version, the tickets (with the table's note when one waits, §6.5), the KDS. In the caller's
    transaction (it commits) and without its logs. None: nothing of the course left to send.
    """
    from app.services import kds_workflow as WF
    from app.services import table_void_tickets as VT

    lines = cart_lines(order.cart_json)
    extras = extras_of(order.extras_json)
    quiet = silent_products(db, course_lines(lines, course.id))
    write = write_fire(order.id, lines, extras, course, now, silent=lambda line: line.product_id in quiet, auto=auto)
    if not write.printed and not write.silent:
        return None  # nothing of it left to send (AutoFire.fire: skipped)
    is_addition = (order.send_count or 0) > 0
    order.extras_json = encode_extras(write.extras)
    order.version = (order.version or 0) + 1
    order.sent_at = now
    order.send_count = (order.send_count or 0) + 1
    order.updated_at = now
    order.cloud_updated_at = now
    # Never a till's request id: a till's own "הוצא" of the course is not answered as this one.
    order.last_request_id = None
    db.flush()

    seat_names = seat_names_of(write.extras)
    items = [i for line, qty, note in write.printed for i in items_of(line, qty, note, seat_names)]
    prints = VT.prints_tickets(WF.config_for_machine(db, routing))
    jobs: List[Any] = []
    if items and prints:
        jobs = queue_fire_tickets(
            db, order, table, items, routing=routing, course=course, seed=write.seed, is_addition=is_addition, now=now,
            band=band, notice=note_notice(write.note), source_name=source_name,
        )
    kds: Optional[Dict[str, Any]] = None
    kds_error = False
    if write.printed:
        try:
            with db.begin_nested():
                kds = release_to_kds(db, order, table, routing, write, lines, now, actor_name=actor_name)
        except Exception:  # noqa: BLE001 - the paper went; a KDS-only kitchen waits for the next pass
            logger.exception("fire of table order %s: the KDS release failed", order.id)
            if not prints:
                raise
            kds_error = True
    return {
        "orderId": str(order.id),
        "tableId": str(order.table_id),
        "courseId": course.id,
        "courseName": course.name,
        "fireId": write.seed,
        "printedLines": [line.id for line, _q, _n in write.printed],
        "silentLines": list(write.silent),
        "jobs": [str(j.id) for j in jobs],
        "kds": kds,
        "kdsError": kds_error,
        "version": order.version,
        "note": write.note,
        "_jobs": jobs,
    }


def apply_fire(db: Session, order: Any, table: Any, found: Evaluation, now: datetime) -> Optional[Dict[str, Any]]:
    """
    The fire, on rows the caller locked and read again: the order's bookkeeping and version, the
    tickets, the KDS, the logs. In the caller's transaction (it commits). None: nothing to send.
    """
    from app.services import tables as T

    plan, routing = found.plan, found.routing
    course = plan.pending.course
    out = fire_course(db, order, table, routing, course, now)
    if out is None:
        return None
    T.record_event(
        db, "send", table, order, now=now,
        details={
            "autoFire": True, "courseId": course.id, "courseName": course.name, "trigger": plan.trigger,
            "minutes": plan.minutes, "fireId": out["fireId"],
        },
    )
    record_till_event(db, routing, order, plan, now, len(out["printedLines"]) + len(out["silentLines"]))
    out["trigger"] = plan.trigger
    return out


def fire_if_due(
    db: Session, order_id: Any, *, now: Optional[datetime] = None, cache: Optional[ParamsCache] = None,
) -> Optional[Dict[str, Any]]:
    """
    One cloud-tables order: its next course fired when it is due, once. A first look without locks;
    then the table's row and the order's are locked and read again — a till inside the table (its lock
    live), an order closed or moved on meanwhile, or a course no longer due: nothing. Never waits for a
    lock (`SKIP LOCKED`): a row a till's write holds now is left to the next pass, so the pass can
    neither hold up a till's save or payment nor deadlock with it (a save locks the table, then the
    order; a payment the order, then the table). A till's save that comes after the fire waits for it on
    the table's row and then finds the order's version moved (409, its reload sees the course fired).
    Commits a fire, then wakes the shop's tills and the printing ones. None when nothing was fired.
    """
    from app.models.tables import DiningTable, TableOrder
    from app.services import printers as K
    from app.services import table_void_tickets as VT
    from app.services import tables as T

    now = now or datetime.now(timezone.utc)
    ident = _uuid(order_id)
    order = db.get(TableOrder, ident) if ident is not None else None
    if order is None or order.status != "open" or order.source != "synced":
        return None
    table = db.get(DiningTable, order.table_id)
    if table is None:
        return None
    found = evaluate(db, order, table, now, cache)
    if found is None or not found.plan.due(now):
        db.rollback()
        return None
    table = (
        db.query(DiningTable).filter(DiningTable.id == order.table_id)
        .with_for_update(skip_locked=True).populate_existing().one_or_none()
    )
    if table is None or T.lock_live(table, now):
        db.rollback()
        return None
    order = (
        db.query(TableOrder).filter(TableOrder.id == ident)
        .with_for_update(skip_locked=True).populate_existing().one_or_none()
    )
    if order is None or order.status != "open" or order.source != "synced":
        db.rollback()
        return None
    again = evaluate(db, order, table, now, cache)
    if again is None or not again.plan.due(now) or again.plan.pending.course != found.plan.pending.course:
        db.rollback()
        return None
    out = apply_fire(db, order, table, again, now)
    if out is None:
        db.rollback()
        return None
    jobs = out.pop("_jobs")
    printing = VT.notify_targets(db, VT.tickets_out(db, jobs, now)) if jobs else []
    shop_id, tenant_id, table_id = order.shop_id, order.tenant_id, str(order.table_id)
    db.commit()
    logger.info(
        "auto-fired course %s of table order %s (%s, %d lines, %d jobs)",
        out["courseId"], out["orderId"], out["trigger"], len(out["printedLines"]), len(out["jobs"]),
    )
    T.tables_changed(db, shop_id, tenant_id=tenant_id, table_id=table_id)
    if printing:
        K.publish_job_notify(printing)
    return out


def candidates(db: Session) -> List[Any]:
    """The open cloud-tables orders that may have a course to fire: sent before, with courses."""
    from app.models.tables import TableOrder

    return [
        row[0]
        for row in db.query(TableOrder.id)
        .filter(
            TableOrder.status == "open",
            TableOrder.source == "synced",
            TableOrder.send_count > 0,
            TableOrder.cart_json.isnot(None),
            TableOrder.extras_json.isnot(None),
            TableOrder.cart_json.like('%"course"%'),
        )
        .all()
    ]


def run_pass(db: Session, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Every candidate once; one order's failure never stops the others. The fires made."""
    now = now or datetime.now(timezone.utc)
    cache: ParamsCache = {}
    ids = candidates(db)
    db.rollback()
    fired: List[Dict[str, Any]] = []
    for order_id in ids:
        try:
            out = fire_if_due(db, order_id, now=now, cache=cache)
        except Exception:  # noqa: BLE001 - the next pass tries it again (its ids make that safe)
            db.rollback()
            logger.exception("auto-fire of table order %s failed", order_id)
            continue
        if out is not None:
            fired.append(out)
    return fired
