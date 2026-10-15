"""
"FIRE כמו במסעדות" and "שיגור מתוזמן של פריט" (P:/specs/fire-restaurant-flow.md, P:/specs/item-scheduled-send.md;
the till contract in fire-restaurant-flow.md §8): the cloud's part, beside FIRE v2 (app/services/course_auto_fire.py).

* **The till parameters** (company → shop → point of sale → till; registered in app/services/till_parameters.py,
  edited on the dashboard's tables page with the courses' group):
  - `fireAskOnSend` — after "הזמן" / "שגר" with a course still held, ask "מתי עיקריות?" (`ask`), never (`never`:
    the shop's `autoFire`), or apply one choice without asking (`default:manual` / `default:<minutes>` /
    `default:ready` / `default:now`);
  - `fireAskMinutes` — the sheet's "בעוד X דק'" buttons ("10,15,20");
  - `fireHints` — the "how it works" card and hints: `on` / `first_time` / `off` (also a till-design field);
  - `itemScheduleMinutes` — the quick minutes of "שגר מתוזמן" ("5,10,15,20,30");
  - `itemScheduleOnClose` — a table paid / closed with a scheduled line still waiting: `ask` / `send` / `cancel`;
  - `kdsShowScheduled` — the KDS shows a scheduled line greyed ("מתוזמן 20:30") until it goes (true).
* **The order** (the till's TableExtras, kept by the cloud as the till wrote it): `fireWhen` — the table's choice
  per course; `schedule` — the scheduled lines (§8.3). Read here, pure.
* **The catalog** — `scheduleAfterMinutes` / `scheduleAfterCourseReady` on products and categories, inherited as
  a pair (product → its category → the parent…): `rule_of`.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# ── The till parameters ───────────────────────────────────────────────────────

ASK_KEY = "fireAskOnSend"
ASK_MINUTES_KEY = "fireAskMinutes"
HINTS_KEY = "fireHints"
SCHEDULE_MINUTES_KEY = "itemScheduleMinutes"
ON_CLOSE_KEY = "itemScheduleOnClose"
KDS_SCHEDULED_KEY = "kdsShowScheduled"

ASK = "ask"
NEVER = "never"
DEFAULT_PREFIX = "default:"
#: The choices of the sheet "מתי עיקריות?" a default may name (besides a number of minutes).
DEFAULT_CHOICES = ("manual", "ready", "now")
ASK_MINUTES_DEFAULT = "10,15,20"
ASK_MINUTES_MAX_ITEMS = 6
FIRE_MINUTES_MAX = 180

HINTS_OPTIONS = ("on", "first_time", "off")
HINTS_LABELS = {"on": "מוצג", "first_time": "רק בפעם הראשונה", "off": "כבוי"}

SCHEDULE_MINUTES_DEFAULT = "5,10,15,20,30"
SCHEDULE_MINUTES_MAX_ITEMS = 8
SCHEDULE_MINUTES_MAX = 600

ON_CLOSE_OPTIONS = ("ask", "send", "cancel")
ON_CLOSE_LABELS = {"ask": "לשאול", "send": "לשגר עכשיו", "cancel": "לבטל"}

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=ASK_KEY,
        label="שאלת \"מתי עיקריות?\" אחרי שיגור",
        value_type="string",
        default_value=ASK,
        description=(
            "חל כששלבי הגשה מופעלים. אחרי \"הזמן\" או \"שגר\", כשנשאר שלב בהמתנה. "
            "«ask» (ברירת מחדל): הקופה שואלת \"מתי {השלב הבא}?\": ידנית, בעוד X דקות, כשהראשונות מוכנות (כשיש KDS), או עכשיו. "
            "«never»: לא שואלים, השלב יוצא לפי \"הוצאה אוטומטית של השלב הבא\". "
            "«default:<בחירה>»: לא שואלים ומפעילים בחירה קבועה — default:manual, default:15 (דקות, 1–180), "
            "default:ready או default:now. הבחירה חלה על השולחן הזה בלבד. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
    dict(
        key=ASK_MINUTES_KEY,
        label="\"מתי עיקריות?\": כפתורי דקות",
        value_type="string",
        default_value=ASK_MINUTES_DEFAULT,
        description=(
            "הכפתורים \"בעוד X דק'\" בשאלה \"מתי עיקריות?\". מספרים מופרדים בפסיקים, "
            f"עד {ASK_MINUTES_MAX_ITEMS}, כל אחד 1–{FIRE_MINUTES_MAX}. ברירת מחדל: {ASK_MINUTES_DEFAULT}."
        ),
    ),
    dict(
        key=HINTS_KEY,
        label="הסבר לעובד: איך שלבי הגשה עובדים",
        value_type="enum",
        enum_options=HINTS_OPTIONS,
        enum_labels=HINTS_LABELS,
        default_value="on",
        description=(
            "כרטיס קצר בכניסה הראשונה של עובד לשולחן, ⓘ ליד שורה \"ממתין\" ושורת הסבר בשאלה \"מתי עיקריות?\". "
            f"«{HINTS_LABELS['on']}» (ברירת מחדל): הכל. «{HINTS_LABELS['first_time']}»: רק הכרטיס, פעם אחת לכל עובד. "
            f"«{HINTS_LABELS['off']}»: בלי הסברים. עובד יכול לבחור \"אל תציג שוב\", והבחירה נשמרת לו בענן. "
            "גם שדה בעיצוב קופה, שגובר על הפרמטר."
        ),
    ),
    dict(
        key=SCHEDULE_MINUTES_KEY,
        label="שגר מתוזמן: כפתורי דקות",
        value_type="string",
        default_value=SCHEDULE_MINUTES_DEFAULT,
        description=(
            "הכפתורים \"בעוד X דקות\" כשמתזמנים פריט (\"שגר מתוזמן\"). מספרים מופרדים בפסיקים, "
            f"עד {SCHEDULE_MINUTES_MAX_ITEMS}, כל אחד 1–{SCHEDULE_MINUTES_MAX}. ברירת מחדל: {SCHEDULE_MINUTES_DEFAULT}."
        ),
    ),
    dict(
        key=ON_CLOSE_KEY,
        label="שולחן נסגר עם פריט מתוזמן שלא יצא",
        value_type="enum",
        enum_options=ON_CLOSE_OPTIONS,
        enum_labels=ON_CLOSE_LABELS,
        default_value="ask",
        description=(
            "כשמשלמים או סוגרים שולחן לפני שפריט מתוזמן יצא. "
            f"«{ON_CLOSE_LABELS['ask']}» (ברירת מחדל): הקופה שואלת \"לשגר עכשיו / לבטל?\". "
            f"«{ON_CLOSE_LABELS['send']}»: הפריט נשלח למטבח מיד. «{ON_CLOSE_LABELS['cancel']}»: התזמון מבוטל והפריט לא יוצא."
        ),
    ),
    dict(
        key=KDS_SCHEDULED_KEY,
        label="KDS: הצגת פריטים מתוזמנים",
        value_type="boolean",
        default_value=True,
        description=(
            "פועל (ברירת מחדל): פריט מתוזמן מוצג במסך המטבח באפור, \"מתוזמן 20:30\", עד שהוא יוצא. "
            "כבוי: הפריט לא מוצג עד שהוא יוצא."
        ),
    ),
)
#: The keys, in the order the dashboard lists them.
LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
#: The keys whose value is checked beyond its type (`clean_value`).
VALIDATED_KEYS = frozenset({ASK_KEY, ASK_MINUTES_KEY, HINTS_KEY, SCHEDULE_MINUTES_KEY, ON_CLOSE_KEY})


def _is_int_text(text: str) -> bool:
    return bool(re.fullmatch(r"[0-9]{1,4}", text))


def minutes_list(value: Any, *, max_items: int, max_minutes: int, key: str) -> str:
    """"10, 15,20" → "10,15,20"; ValueError unless 1–`max_items` distinct whole minutes 1–`max_minutes`."""
    if not isinstance(value, str):
        raise ValueError(f"{key} must be minutes separated by commas")
    parts = [p.strip() for p in value.split(",")]
    if not parts or any(not _is_int_text(p) for p in parts):
        raise ValueError(f"{key} must be minutes separated by commas")
    numbers = [int(p) for p in parts]
    if not 1 <= len(numbers) <= max_items:
        raise ValueError(f"{key} takes 1–{max_items} values")
    if any(not 1 <= n <= max_minutes for n in numbers):
        raise ValueError(f"{key}: each value must be 1–{max_minutes} minutes")
    if len(set(numbers)) != len(numbers):
        raise ValueError(f"{key}: a value is repeated")
    return ",".join(str(n) for n in numbers)


def parse_ask(value: Any) -> Optional[Tuple[str, Optional[str]]]:
    """
    `fireAskOnSend` as (`ask` | `never` | `default`, the default's choice: `manual` | `ready` | `now` |
    "<minutes>"); None when it is not a valid value.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text in (ASK, NEVER):
        return text, None
    if not text.startswith(DEFAULT_PREFIX):
        return None
    choice = text[len(DEFAULT_PREFIX):].strip()
    if choice in DEFAULT_CHOICES:
        return "default", choice
    if _is_int_text(choice) and 1 <= int(choice) <= FIRE_MINUTES_MAX:
        return "default", str(int(choice))
    return None


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key`, or ValueError (whatever route writes it)."""
    if value is None:
        return None
    if key == ASK_KEY:
        parsed = parse_ask(value)
        if parsed is None:
            raise ValueError(
                f"{ASK_KEY} must be ask, never, or default:<manual | ready | now | minutes 1–{FIRE_MINUTES_MAX}>"
            )
        kind, choice = parsed
        return kind if choice is None else f"{DEFAULT_PREFIX}{choice}"
    if key == ASK_MINUTES_KEY:
        return minutes_list(value, max_items=ASK_MINUTES_MAX_ITEMS, max_minutes=FIRE_MINUTES_MAX, key=key)
    if key == SCHEDULE_MINUTES_KEY:
        return minutes_list(value, max_items=SCHEDULE_MINUTES_MAX_ITEMS, max_minutes=SCHEDULE_MINUTES_MAX, key=key)
    if key == HINTS_KEY and value not in HINTS_OPTIONS:
        raise ValueError(f"{HINTS_KEY} must be one of {', '.join(HINTS_OPTIONS)}")
    if key == ON_CLOSE_KEY and value not in ON_CLOSE_OPTIONS:
        raise ValueError(f"{ON_CLOSE_KEY} must be one of {', '.join(ON_CLOSE_OPTIONS)}")
    return value


def kds_shows_scheduled(params: Dict[str, Any]) -> bool:
    """`kdsShowScheduled`: on unless the level says false."""
    return params.get(KDS_SCHEDULED_KEY) is not False


# ── The catalog's rule ("itemScheduleRules", §8.2) ────────────────────────────

RULE_MINUTES_MAX = SCHEDULE_MINUTES_MAX


@dataclass(frozen=True)
class Rule:
    """A product's schedule: X minutes after the send, after course Y is ready, or X minutes after Y is ready."""

    minutes: Optional[int]
    course_id: Optional[str]

    @property
    def none(self) -> bool:
        return not self.minutes and self.course_id is None


def own_rule(row: Any) -> Optional[Rule]:
    """The rule a product / category row states itself; None — it inherits (both fields null)."""
    minutes = getattr(row, "schedule_after_minutes", None)
    course = getattr(row, "schedule_after_course_ready", None)
    if minutes is None and course is None:
        return None
    return Rule(minutes, str(course) if course is not None else None)


def rule_of(product: Any, categories: Dict[str, Any]) -> Optional[Rule]:
    """
    The product's rule: its own, else its category's, else the parent's… (`categories`: id → row). None —
    no rule (nothing says, or the first level that says says "none": 0 minutes and no course).
    """
    own = own_rule(product)
    category_id = getattr(product, "category_id", None)
    seen = 0
    while own is None and category_id is not None and seen < 20:
        row = categories.get(str(category_id))
        if row is None:
            break
        own = own_rule(row)
        category_id = getattr(row, "parent_id", None)
        seen += 1
    return None if own is None or own.none else own


# ── The order: the table's choice and the scheduled lines (§8.3, pure) ────────

FIRE_WHEN_KEY = "fireWhen"
SCHEDULE_KEY = "schedule"
CHOICE_MANUAL = "manual"
CHOICE_MINUTES = "minutes"
CHOICE_READY = "ready"


@dataclass(frozen=True)
class Choice:
    """"מתי עיקריות?" for one course of the table."""

    mode: str
    minutes: Optional[int]
    set_at: Optional[datetime]


def choice_of(extras: Dict[str, Any], course_id: str, parse_time) -> Optional[Choice]:
    """The table's choice for the course (`fireWhen[course]`); None — none, or one the cloud cannot read."""
    table = extras.get(FIRE_WHEN_KEY)
    raw = table.get(course_id) if isinstance(table, dict) else None
    if not isinstance(raw, dict):
        return None
    mode = raw.get("mode")
    if mode not in (CHOICE_MANUAL, CHOICE_MINUTES, CHOICE_READY):
        return None
    minutes = raw.get("minutes")
    minutes = int(minutes) if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) else None
    if mode == CHOICE_MINUTES and (minutes is None or not 0 <= minutes <= FIRE_MINUTES_MAX):
        return None
    return Choice(mode, minutes, parse_time(raw.get("setAt")))


@dataclass(frozen=True)
class Scheduled:
    """One scheduled line (`schedule[line]`)."""

    line_id: str
    schedule_id: str
    at: Optional[datetime]
    #: ("course" | "line", id) the line waits to be ready.
    after: Optional[Tuple[str, str]]
    after_minutes: int
    set_at: Optional[datetime]


def scheduled_lines(extras: Dict[str, Any], parse_time) -> Dict[str, Scheduled]:
    """The order's scheduled lines (unreadable entries left out: they never go by themselves)."""
    raw = extras.get(SCHEDULE_KEY)
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Scheduled] = {}
    for line_id, o in raw.items():
        if not isinstance(o, dict):
            continue
        sid = o.get("scheduleId")
        if not isinstance(sid, str) or not sid.strip():
            continue
        at = parse_time(o.get("scheduledAt"))
        after = None
        target = o.get("scheduleAfterReady")
        if isinstance(target, dict):
            for kind in ("course", "line"):
                if isinstance(target.get(kind), str) and target[kind].strip():
                    after = (kind, target[kind].strip())
                    break
        if (at is None) == (after is None):
            continue  # exactly one of the two
        minutes = o.get("afterMinutes")
        minutes = int(minutes) if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) else 0
        out[str(line_id)] = Scheduled(
            str(line_id), sid.strip(), at, after, max(0, min(minutes, SCHEDULE_MINUTES_MAX)),
            parse_time(o.get("setAt")),
        )
    return out


def pending_ids(extras: Dict[str, Any], parse_time) -> frozenset:
    """The lines that wait for their own time: never sent with "שגר" / a course, never "held"."""
    return frozenset(scheduled_lines(extras, parse_time))


def schedule_seed(order_id: Any, schedule_id: str) -> str:
    """The round of a scheduled send (§8.3): UUID.nameUUIDFromBytes("sched|<order>|<scheduleId>")."""
    from app.services.table_void_tickets import java_name_uuid

    return str(java_name_uuid(f"sched|{order_id}|{schedule_id}"))


def groups(entries: Iterable[Scheduled]) -> List[List[Scheduled]]:
    """The scheduled lines by `scheduleId` (one round each), in the order they come."""
    by: Dict[str, List[Scheduled]] = {}
    for e in entries:
        by.setdefault(e.schedule_id, []).append(e)
    return list(by.values())


#: Without a KDS, a line that waits for "ready" goes this long after its target went out (0 minutes given).
NO_KDS_MINUTES = 15


def due_at(
    entry: Scheduled,
    *,
    went_out: Optional[datetime],
    kds: Optional[Tuple[bool, Optional[datetime]]],
    now: datetime,
) -> Optional[datetime]:
    """
    When a scheduled line goes: its time; or when its target is ready on the KDS (+ `afterMinutes`); with no
    KDS task of the target — the target's last send (+ `afterMinutes`, 15 when 0). None: not known yet (the
    target not out, or not ready).
    """
    if entry.at is not None:
        return entry.at
    if kds is not None:
        ready, at = kds
        if not ready:
            return None
        return (at or now) + timedelta(minutes=entry.after_minutes)
    if went_out is None:
        return None
    return went_out + timedelta(minutes=entry.after_minutes or NO_KDS_MINUTES)


def kds_note(entry: Scheduled, course_names: Dict[str, str], line_names: Dict[str, str]) -> Optional[str]:
    """What a scheduled line waits for, on the KDS: "אחרי עיקריות" (None for a line with a time)."""
    if entry.after is None:
        return None
    kind, ident = entry.after
    name = (course_names if kind == "course" else line_names).get(ident) or ""
    text = f"אחרי {name}".strip() if name else "אחרי שמוכן"
    if entry.after_minutes:
        text += f" +{entry.after_minutes} דק'"
    return text[:60]


def valid_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def without(extras: Dict[str, Any], line_ids: Sequence[str]) -> None:
    """Drop the lines from `schedule` (in place); the key goes with its last line."""
    raw = extras.get(SCHEDULE_KEY)
    if not isinstance(raw, dict):
        return
    for i in line_ids:
        raw.pop(i, None)
    if not raw:
        extras.pop(SCHEDULE_KEY, None)
