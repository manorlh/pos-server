"""
"תחום שולחנות" — who sees which tables (P:/specs/table-scope.md §1–§5, §7, §9–§10, §14; the owner's decisions of
16.10, §13: the device's and the employee's scopes cut each other, outside the scope is hidden, the unassigned table
follows `tableAssignmentUnassigned`, `TABLES.SEE_ALL` is allowed for the supervisor and the manager and on a
manager's code for the others).

**A scope** is a set of zones (with every table in them, those added later too) and single tables:
`{"zoneIds": [...], "tableIds": [...]}`. Null — no scope: everything, as today (the default everywhere). Ids of
zones or tables archived since are dropped when it is read (`resolve`); a scope left empty sees nothing.

* **The device's** (`pos_machines.table_scope`, set on the device's page): narrows what its point of sale shows —
  the cloud sends it nothing else (`app/services/tables.py _compose`); the LAN host gets everything and every
  device's scope, and narrows each device itself (§7).
* **The employee's** (`pos_users.table_scope`, their card) — and, with `tableAssignmentScope` on, their live
  assignments (their union, §3); a table nobody is assigned to is in it under `tableAssignmentUnassigned` = open.
  Sent with the state (`scope.users`); the till narrows the floor itself (an employee switch without the
  network), the cloud refuses a write outside it.
* **Both** — what is in both (§4). `TABLES.SEE_ALL` allowed: the employee's does not hold, and "כל השולחנות" lifts
  the device's too (`?scope=all`). Approved (a manager's code): one action, recorded as `scope_override`.

The rule is one per language, pinned by tests/fixtures/table_scope_golden.json (pos-android domain/TableScope.kt).
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ── The parameters (§3, §5, §6.4) ─────────────────────────────────────────────────────

#: "כל השולחנות, מעבר לתחום" (§4): allowed — the employee's scope does not hold and "כל השולחנות" lifts the
#: device's; approval — a manager's code for one action (`scope_override`).
SEE_ALL = "TABLES.SEE_ALL"

ASSIGNMENT_SCOPE_KEY = "tableAssignmentScope"
OUTSIDE_KEY = "tableScopeOutside"
TERM_KEY = "tableTerm"

OUTSIDE_HIDE, OUTSIDE_DIM = "hide", "dim"
OUTSIDE_OPTIONS = (OUTSIDE_HIDE, OUTSIDE_DIM)
OUTSIDE_LABELS = {
    OUTSIDE_HIDE: "מוסתר (ברירת מחדל)",
    OUTSIDE_DIM: "מוצג באפור, בלי פרטים",
}
TERM_DEFAULT = "שולחן"
TERM_MAX = 10

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=ASSIGNMENT_SCOPE_KEY,
        label="מלצר רואה רק את מה ששויך לו",
        value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, השיוכים של היום (\"שיוך מלצרים\") הם חלק מהתחום של המלצר: הוא רואה במסך השולחנות רק את "
            "השולחנות והאזורים ששויכו לו, ואת אלה שבתחום הקבוע בכרטיס העובד. לכל עובד בלי ההרשאה \"כל השולחנות, "
            "מעבר לתחום\" יש אז תחום, גם אם לא שויך לו כלום. שולחן שלא שויך לאף אחד: לפי \"שיוך מלצרים — שולחן "
            "שלא שויך\" (מותר לפתוח — כולם רואים אותו; רק באישור — רק מי שמורשה לראות הכול). דורש ששיוך השולחנות "
            "למלצרים פעיל; מומלץ «הגבלה», כך שגם קופה ישנה לפחות חוסמת פתיחה. " + _LEVELS
        ),
    ),
    dict(
        key=OUTSIDE_KEY,
        label="שולחן מחוץ לתחום",
        value_type="enum",
        enum_options=OUTSIDE_OPTIONS,
        enum_labels=OUTSIDE_LABELS,
        default_value=OUTSIDE_HIDE,
        description=(
            "מה הקופה מציגה משולחן שמחוץ לתחום (של המכשיר או של העובד). "
            f"«{OUTSIDE_LABELS[OUTSIDE_HIDE]}» — לא מצויר, ולשונית בלי שולחן בתחום לא מוצגת. "
            f"«{OUTSIDE_LABELS[OUTSIDE_DIM]}» — מצויר באפור במקומו במפה, בלי הזמנה, סכום ומלצר, ואי אפשר ללחוץ "
            "עליו — עוזר להתמצא במפה. " + _LEVELS
        ),
    ),
    dict(
        key=TERM_KEY,
        label="המילה לפני המספר: שולחן / תא / …",
        value_type="string",
        default_value=TERM_DEFAULT,
        description=(
            "המילה שלפני מספר השולחן בבון למטבח, בחשבון, בשורת השולחן בחשבונית, בהתראות ובהודעות בקופה — "
            "למשל \"תא\" במקום \"שולחן\" (\"תא 3B\"). עד 10 תווים. לא משנה את המסמך הפיסקלי, רק את הטקסט של "
            "שורת השולחן. " + _LEVELS
        ),
    ),
)

LEVEL_KEYS: Tuple[str, ...] = tuple(spec["key"] for spec in PARAMETER_SPECS)
#: The tables page's group of these (app/services/table_restore.py `_page_groups`).
PAGE_GROUP = "scope"
PAGE_GROUP_LABEL = "תחום שולחנות ו\"תא\" במקום \"שולחן\""
VALIDATED_KEYS = frozenset({OUTSIDE_KEY, TERM_KEY})


def clean_value(key: str, value: Any) -> Any:
    """The value the till gets for `key`, or ValueError."""
    if value is None:
        return None
    if key == OUTSIDE_KEY:
        if value not in OUTSIDE_OPTIONS:
            raise ValueError(f"{OUTSIDE_KEY} must be one of {', '.join(OUTSIDE_OPTIONS)}")
        return value
    if key == TERM_KEY:
        if not isinstance(value, str):
            raise ValueError(f"{TERM_KEY} must be text")
        text = " ".join(value.split())
        if not text:
            raise ValueError(f"{TERM_KEY} must not be empty")
        if len(text) > TERM_MAX:
            raise ValueError(f"{TERM_KEY} is at most {TERM_MAX} characters")
        return text
    return value


def outside_of(params: Optional[Mapping[str, Any]]) -> str:
    value = (params or {}).get(OUTSIDE_KEY)
    return value if value in OUTSIDE_OPTIONS else OUTSIDE_HIDE


def term_of(params: Optional[Mapping[str, Any]]) -> str:
    value = (params or {}).get(TERM_KEY)
    if isinstance(value, str) and value.strip():
        return " ".join(value.split())[:TERM_MAX]
    return TERM_DEFAULT


def from_assignment(params: Optional[Mapping[str, Any]]) -> bool:
    """`tableAssignmentScope` on — and the assignment on, without which there is nothing to take it from."""
    from app.services import table_assignments as TAS

    params = params or {}
    return params.get(ASSIGNMENT_SCOPE_KEY) is True and TAS.config_of(params).on


# ── The capabilities a till's build says (its heartbeat's `capabilities`) ──────────────

#: The till hides what is outside its scope and lets the LAN host narrow each device (`scope` block).
CAPABILITY_SCOPE = "table_scope_v1"
#: The till reads `label`: without it a labelled table reaches it as its name ("3B", `labelOnly`) — §6.5.
CAPABILITY_LABELS = "table_labels_v1"


def capabilities_of(machine: Any) -> Set[str]:
    words = list(getattr(machine, "capabilities", None) or [])
    reported = getattr(machine, "reported_capabilities", None) or {}
    if isinstance(reported, dict):
        words += list(reported.get("list") or [])
    return {str(w) for w in words}


def capable(machine: Any, capability: str) -> bool:
    return capability in capabilities_of(machine)


# ── A scope ────────────────────────────────────────────────────────────────────────

#: At most this many ids of each kind (a shop of 500 tables fits many times over).
IDS_MAX = 2000
INVALID = "table_scope_invalid"


class ScopeError(ValueError):
    """A scope the API refuses (422 `table_scope_invalid` with `reason`)."""

    def __init__(self, reason: str, **extra: Any):
        super().__init__(reason)
        self.reason = reason
        self.extra = extra


def _ids(value: Any, what: str) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise ScopeError(f"{what}_not_a_list")
    out: List[str] = []
    for item in value:
        try:
            ident = str(uuid.UUID(str(item)))
        except (TypeError, ValueError, AttributeError):
            raise ScopeError(f"{what}_bad_id", id=str(item))
        if ident not in out:
            out.append(ident)
    if len(out) > IDS_MAX:
        raise ScopeError(f"{what}_too_many")
    return out


def clean_scope(value: Any) -> Optional[Dict[str, List[str]]]:
    """`{"zoneIds", "tableIds"}` as stored (each id once, canonical), or None — no scope. ScopeError otherwise."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ScopeError("not_an_object")
    zones = _ids(value.get("zoneIds", value.get("zone_ids")), "zone_ids")
    tables = _ids(value.get("tableIds", value.get("table_ids")), "table_ids")
    return {"zoneIds": zones, "tableIds": tables}


def scope_out(value: Any) -> Optional[Dict[str, List[str]]]:
    """A stored scope as the API answers it (an unreadable one as none)."""
    try:
        return clean_scope(value)
    except ScopeError:
        return None


@dataclass(frozen=True)
class Resolved:
    """A scope read against the live floor: what is still there of it."""

    zone_ids: FrozenSet[str]
    table_ids: FrozenSet[str]

    def covers(self, table_id: Any, zone_id: Any) -> bool:
        return str(table_id) in self.table_ids or str(zone_id) in self.zone_ids

    def out(self) -> Dict[str, List[str]]:
        return {"zoneIds": sorted(self.zone_ids), "tableIds": sorted(self.table_ids)}


def resolve(raw: Any, live_zone_ids: Iterable[Any], live_table_ids: Iterable[Any]) -> Optional[Resolved]:
    """[raw] against the live zones and tables (archived ones dropped, an empty scope left empty); None — no scope."""
    clean = scope_out(raw)
    if clean is None:
        return None
    zones = {str(z) for z in live_zone_ids}
    tables = {str(t) for t in live_table_ids}
    return Resolved(
        zone_ids=frozenset(z for z in clean["zoneIds"] if z in zones),
        table_ids=frozenset(t for t in clean["tableIds"] if t in tables),
    )


def digest(raw: Any) -> str:
    """A short hash of a stored scope ("" for none) — in the till's state tag (app/services/tables_state.py)."""
    clean = scope_out(raw)
    if clean is None:
        return ""
    text = json.dumps({"z": sorted(clean["zoneIds"]), "t": sorted(clean["tableIds"])}, separators=(",", ":"))
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


# ── Who sees what (the rule of §3–§4; the golden fixture pins it) ──────────────────────

ALLOW, APPROVAL, DENY = "allow", "approval", "deny"


def user_tables(
    tables: Sequence[Tuple[str, str]],
    *,
    fixed: Optional[Resolved],
    by_assignment: bool,
    assignees: Mapping[str, Sequence[str]],
    me: Iterable[str],
    unassigned_open: bool,
    see_all: str = DENY,
) -> Optional[Set[str]]:
    """
    The employee's scope over [tables] ((table id, zone id)): their fixed scope's, with [by_assignment] those
    assigned to them ([assignees] per table, [me] their ids) and — [unassigned_open] — those assigned to nobody.
    None — no scope (none fixed and not by assignment, or `TABLES.SEE_ALL` allowed).
    """
    if see_all == ALLOW or (fixed is None and not by_assignment):
        return None
    mine = {str(x) for x in me}
    out: Set[str] = set()
    for table_id, zone_id in tables:
        if fixed is not None and fixed.covers(table_id, zone_id):
            out.add(table_id)
            continue
        if by_assignment:
            given = [str(x) for x in (assignees.get(table_id) or [])]
            if any(x in mine for x in given):
                out.add(table_id)
            elif not given and unassigned_open:
                out.add(table_id)
    return out


def device_tables(tables: Sequence[Tuple[str, str]], device: Optional[Resolved]) -> Optional[Set[str]]:
    if device is None:
        return None
    return {t for t, z in tables if device.covers(t, z)}


def visible_tables(
    tables: Sequence[Tuple[str, str]],
    *,
    device: Optional[Resolved],
    fixed: Optional[Resolved] = None,
    by_assignment: bool = False,
    assignees: Optional[Mapping[str, Sequence[str]]] = None,
    me: Iterable[str] = (),
    unassigned_open: bool = True,
    see_all: str = DENY,
    all_tables: bool = False,
) -> Optional[Set[str]]:
    """
    What the employee sees on this device (§4): what is in both scopes; one alone decides when the other is none;
    None — neither has one: everything. `TABLES.SEE_ALL` allowed: theirs never holds, and [all_tables] ("כל
    השולחנות") lifts the device's.
    """
    dev = None if (see_all == ALLOW and all_tables) else device_tables(tables, device)
    user = user_tables(
        tables, fixed=fixed, by_assignment=by_assignment, assignees=assignees or {}, me=me,
        unassigned_open=unassigned_open, see_all=see_all,
    )
    if dev is None:
        return user
    if user is None:
        return dev
    return dev & user


# ── Reading from the database ──────────────────────────────────────────────────────


def live_floor(db: Session, shop_id: Any) -> Tuple[Set[str], Set[str]]:
    """The live zones' and tables' ids of a shop (a table of an archived zone is not live)."""
    from app.models.tables import DiningTable, TableZone

    zones = {
        str(z) for (z,) in db.query(TableZone.id).filter(TableZone.shop_id == shop_id, TableZone.archived_at.is_(None)).all()
    }
    tables = {
        str(t) for t, z in db.query(DiningTable.id, DiningTable.zone_id).filter(
            DiningTable.shop_id == shop_id, DiningTable.archived_at.is_(None)
        ).all()
        if str(z) in zones
    }
    return zones, tables


def live_out(db: Session, shop_id: Any, raw: Any) -> Optional[Dict[str, List[str]]]:
    """A stored scope as the dashboard reads it (§14.1): the ids archived since dropped; None — no scope."""
    clean = scope_out(raw)
    if clean is None or shop_id is None:
        return clean
    zones, tables = live_floor(db, shop_id)
    resolved = resolve(clean, zones, tables)
    return resolved.out() if resolved is not None else None


def without_archived(db: Session, shop_id: Any, scope: Optional[Dict[str, List[str]]]) -> Optional[Dict[str, List[str]]]:
    """
    [scope] as it is saved: the shop's zones and tables archived since are dropped (a scope read before an archive
    saves as it was meant); an id the shop never had stays, for `check_against` to refuse.
    """
    from app.models.tables import DiningTable, TableZone

    if scope is None or shop_id is None:
        return scope
    zones, tables = live_floor(db, shop_id)
    asked_zones = [z for z in scope["zoneIds"] if z not in zones]
    asked_tables = [t for t in scope["tableIds"] if t not in tables]
    gone_zones: Set[str] = set()
    gone_tables: Set[str] = set()
    if asked_zones:
        gone_zones = {
            str(z) for (z,) in db.query(TableZone.id).filter(
                TableZone.shop_id == shop_id, TableZone.id.in_([uuid.UUID(z) for z in asked_zones])
            ).all()
        }
    if asked_tables:
        gone_tables = {
            str(t) for (t,) in db.query(DiningTable.id).filter(
                DiningTable.shop_id == shop_id, DiningTable.id.in_([uuid.UUID(t) for t in asked_tables])
            ).all()
        }
    if not gone_zones and not gone_tables:
        return scope
    return {
        "zoneIds": [z for z in scope["zoneIds"] if z not in gone_zones],
        "tableIds": [t for t in scope["tableIds"] if t not in gone_tables],
    }


def device_scopes(db: Session, shop_id: Any) -> Tuple[Tuple[str, Any], ...]:
    """((machine id, stored scope), …) of the shop's active devices with one — for the LAN host (§7)."""
    from app.models.pos_machine import POSMachine

    return tuple(
        (str(mid), raw) for mid, raw in db.query(POSMachine.id, POSMachine.table_scope)
        .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True), POSMachine.table_scope.isnot(None))
        .order_by(POSMachine.id).all()
        if raw is not None
    )


def see_all_state(db: Session, pos_user: Any) -> str:
    """`TABLES.SEE_ALL` of a till user: allow | approval | deny (the role, their overrides)."""
    from app.services import till_roles as TR

    if pos_user is None:
        return DENY
    try:
        return TR.effective_for_pos_user(pos_user).state(SEE_ALL)
    except Exception:  # noqa: BLE001 - unreadable: nothing beyond the scope
        logger.exception("TABLES.SEE_ALL of %s not read", getattr(pos_user, "id", None))
        return DENY


def shop_user(db: Session, shop_id: Any, raw_id: Any):
    """The active till user of the shop named by [raw_id] (a UUID), else None."""
    from app.models.pos_user import PosUser

    if raw_id is None or shop_id is None:
        return None
    try:
        ident = uuid.UUID(str(raw_id).strip())
    except (TypeError, ValueError, AttributeError):
        return None
    return (
        db.query(PosUser)
        .filter(PosUser.id == ident, PosUser.shop_id == shop_id, PosUser.is_active.is_(True))
        .first()
    )


def sees_all(db: Session, machine: Any, raw_id: Any) -> bool:
    """[raw_id] is an active till user of the machine's shop whose `TABLES.SEE_ALL` is allowed."""
    user = shop_user(db, getattr(machine, "shop_id", None), raw_id)
    return user is not None and see_all_state(db, user) == ALLOW


# ── A write on a table (§5 "איפה זה נאכף", §10) ────────────────────────────────────

OUT_OF_SCOPE = "table_out_of_scope"
EVENT_OVERRIDE = "scope_override"
#: The till user who approved one action outside the scope with their code (`TABLES.SEE_ALL` allowed to them).
APPROVER_HEADER = "X-Scope-Approver"


def table_ref(table: Any) -> Dict[str, Any]:
    return {"id": str(table.id), "number": table.number, "label": getattr(table, "label", None) or None}


def refusal(table: Any, which: str) -> HTTPException:
    """403 `{code: table_out_of_scope, table: {id, number, label}, scope: device | user}`."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": OUT_OF_SCOPE, "table": table_ref(table) if table is not None else None, "scope": which},
    )


def device_scope_of(db: Session, machine: Any) -> Optional[Resolved]:
    raw = getattr(machine, "table_scope", None)
    if raw is None or getattr(machine, "shop_id", None) is None:
        return None
    zones, tables = live_floor(db, machine.shop_id)
    return resolve(raw, zones, tables)


def _params(db: Session, machine: Any, params: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    from app.services import tables as T

    return params if params is not None else T.machine_params(db, machine)


def _user_sees(db: Session, machine: Any, pos_user: Any, params_of, *, table: Any = None, zone_id: Any = None) -> bool:
    """
    [table] (or a new table of [zone_id], None — a zone still to be made) is in [pos_user]'s scope at [machine]:
    their fixed scope, and — `tableAssignmentScope` — what is assigned to them, or to nobody under `open`.
    """
    from types import SimpleNamespace

    from app.services import table_assignments as TAS

    if pos_user is None or see_all_state(db, pos_user) == ALLOW:
        return True
    raw = getattr(pos_user, "table_scope", None)
    params = params_of()
    by_assignment = from_assignment(params)
    if raw is None and not by_assignment:
        return True
    table_id = str(table.id) if table is not None else "new"
    zone = str(table.zone_id) if table is not None else (str(zone_id) if zone_id is not None else "new-zone")
    fixed = None
    if raw is not None:
        zones, tables = live_floor(db, machine.shop_id)
        fixed = resolve(raw, zones, tables)
    assignees: Dict[str, List[str]] = {}
    if by_assignment:
        probe = table if table is not None else (
            SimpleNamespace(id=uuid.uuid4(), zone_id=zone_id, shop_id=machine.shop_id) if zone_id is not None else None
        )
        assignees[table_id] = TAS.assigned_to(db, probe) if probe is not None else []
    cfg = TAS.config_of(params)
    seen = user_tables(
        [(table_id, zone)], fixed=fixed, by_assignment=by_assignment, assignees=assignees,
        me={str(pos_user.id)}, unassigned_open=cfg.unassigned == TAS.UNASSIGNED_OPEN,
    )
    return seen is None or table_id in seen


def _decide(db: Session, machine: Any, outside: Optional[str], operator: Any, approver_id: Any, action: str,
            operator_id: Any, table: Any, number: Optional[int] = None) -> Optional[Dict[str, Any]]:
    if outside is None:
        return None
    if operator is not None and see_all_state(db, operator) == ALLOW:
        return None
    approver = shop_user(db, machine.shop_id, approver_id)
    if approver is not None and see_all_state(db, approver) == ALLOW:
        from app.services import tables as T

        return {
            "action": action,
            "scope": outside,
            "approverPosUserId": str(approver.id),
            "approverName": T.approver_name(db, None, approver.id),
            "posUserId": str(operator.id) if operator is not None else (str(operator_id) if operator_id else None),
        }
    error = refusal(table, outside)
    if table is None and number is not None:
        error.detail["number"] = number
    raise error


def check_write(
    db: Session,
    machine: Any,
    table: Any,
    *,
    operator_id: Any = None,
    approver_id: Any = None,
    params: Optional[Mapping[str, Any]] = None,
    action: str = "enter",
) -> Optional[Dict[str, Any]]:
    """
    A till's write on [table] (enter, a move's or a transfer's target, a merge, a table by number): refused with
    403 `table_out_of_scope` when it is outside the device's scope or the employee's ([operator_id], the
    `X-Pos-User-Id` / the body's employee) — unless the employee may see everything (`TABLES.SEE_ALL` allowed:
    nothing recorded), or [approver_id] (`X-Scope-Approver`, who typed their code at the till) may: then the
    details of the `scope_override` event to record are returned. None — within the scope (or let through).
    """
    if table is None or getattr(machine, "shop_id", None) is None:
        return None
    outside = None
    device = device_scope_of(db, machine)
    if device is not None and not device.covers(table.id, table.zone_id):
        outside = "device"
    operator = shop_user(db, machine.shop_id, operator_id)
    if outside is None and operator is not None and not _user_sees(
        db, machine, operator, lambda: _params(db, machine, params), table=table,
    ):
        outside = "user"
    return _decide(db, machine, outside, operator, approver_id, action, operator_id, table)


def check_new(
    db: Session,
    machine: Any,
    zone: Any,
    *,
    number: Optional[int] = None,
    operator_id: Any = None,
    approver_id: Any = None,
    params: Optional[Mapping[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    "שולחן מזדמן" (§5): a table made by number in [zone] ("שולחנות מזדמנים"; None — still to be made) only within
    the scope: the zone in the device's, and in the employee's; else 403 `table_out_of_scope` (no table, the
    `number`), unless the employee may see everything or an approver who may let it through (the details).
    """
    if getattr(machine, "shop_id", None) is None:
        return None
    outside = None
    device = device_scope_of(db, machine)
    if device is not None and (zone is None or str(zone.id) not in device.zone_ids):
        outside = "device"
    operator = shop_user(db, machine.shop_id, operator_id)
    if outside is None and operator is not None and not _user_sees(
        db, machine, operator, lambda: _params(db, machine, params), zone_id=getattr(zone, "id", None),
    ):
        outside = "user"
    return _decide(db, machine, outside, operator, approver_id, "adhoc", operator_id, None, number)


# ── The tills' state: the `scope` block (§9, §14.3) ────────────────────────────────


def users_block(users: Sequence[Tuple[str, Any]], live_zones: Set[str], live_tables: Set[str]) -> List[Dict[str, Any]]:
    out = []
    for uid, raw in users:
        r = resolve(raw, live_zones, live_tables)
        if r is not None:
            out.append({"posUserId": uid, **r.out()})
    return out


def devices_block(devices: Sequence[Tuple[str, Any]], live_zones: Set[str], live_tables: Set[str]) -> List[Dict[str, Any]]:
    out = []
    for mid, raw in devices:
        r = resolve(raw, live_zones, live_tables)
        if r is not None:
            out.append({"machineId": mid, **r.out()})
    return out


# ── The dashboard: setting a scope, its log ───────────────────────────────────────


def zones_seen_by(db: Session, shop_id: Any, area_id: Any) -> List[Any]:
    """The zones a device of [area_id] may be given: its point of sale's and the shop-wide ones (§2)."""
    from app.services import tables as T

    return T.zones_for(db, shop_id, area_id)


def check_against(db: Session, shop_id: Any, scope: Optional[Dict[str, List[str]]], *, area_id: Any = None,
                  any_area: bool = False) -> None:
    """
    Every id of [scope] is a live zone / table of the shop — of a zone the device sees ([area_id]) unless
    [any_area] (an employee, who may sit at any device of the shop). ScopeError otherwise.
    """
    from app.models.tables import DiningTable
    from app.services import tables as T

    if scope is None:
        return
    zones = T.zones_for(db, shop_id, all_areas=True) if any_area else T.zones_for(db, shop_id, area_id)
    zone_ids = {str(z.id) for z in zones}
    for z in scope["zoneIds"]:
        if z not in zone_ids:
            raise ScopeError("zone_not_seen", id=z)
    if scope["tableIds"]:
        rows = (
            db.query(DiningTable.id, DiningTable.zone_id)
            .filter(DiningTable.id.in_([uuid.UUID(t) for t in scope["tableIds"]]), DiningTable.shop_id == shop_id,
                    DiningTable.archived_at.is_(None))
            .all()
        )
        found = {str(t): str(z) for t, z in rows}
        for t in scope["tableIds"]:
            if t not in found or found[t] not in zone_ids:
                raise ScopeError("table_not_seen", id=t)


def record_change(db: Session, *, target_type: str, target: Any, name: Optional[str], before: Any, after: Any,
                  user: Any) -> None:
    from app.models.tables import TableScopeChange

    if scope_out(before) == scope_out(after):
        return
    db.add(TableScopeChange(
        id=uuid.uuid4(),
        tenant_id=getattr(target, "tenant_id", None),
        shop_id=getattr(target, "shop_id", None),
        target_type=target_type,
        target_id=target.id,
        target_name=(name or "")[:200] or None,
        old_value=scope_out(before),
        new_value=scope_out(after),
        user_id=getattr(user, "id", None),
        user_email=(getattr(user, "email", None) or None),
    ))


def change_out(row: Any) -> Dict[str, Any]:
    at = getattr(row, "created_at", None)
    return {
        "id": str(row.id),
        "targetType": row.target_type,
        "targetId": str(row.target_id),
        "targetName": row.target_name,
        "before": row.old_value,
        "after": row.new_value,
        "userEmail": row.user_email,
        "at": at.isoformat() if at is not None else None,
    }


def scope_tree(db: Session, shop_id: Any, *, area_id: Any = None, any_area: bool = False) -> List[Dict[str, Any]]:
    """
    "הבחירה בעץ: אזור, ובתוכו השולחנות שלו" (§2): the zones a scope may name — a device's point of sale's and the
    shop-wide ones ([any_area]: every zone of the shop, for an employee) — each with its tables in the natural order.
    """
    from app.models.shop_area import ShopArea
    from app.services import tables as T
    from app.services.table_labels import table_title

    zones = T.zones_for(db, shop_id, all_areas=True) if any_area else T.zones_for(db, shop_id, area_id)
    names = {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.shop_id == shop_id).all()}
    tables = T.tables_in(db, [z.id for z in zones])
    by_zone: Dict[Any, List[Any]] = {}
    for t in tables:
        by_zone.setdefault(t.zone_id, []).append(t)
    return [
        {
            "id": str(z.id),
            "name": z.name,
            "areaId": str(z.area_id) if z.area_id else None,
            "areaName": names.get(z.area_id) if z.area_id else None,
            "tables": [
                {
                    "id": str(t.id), "number": t.number, "label": t.label or None, "name": t.name,
                    "title": table_title(t.number, t.label, t.name, bool(t.label_only)),
                }
                for t in by_zone.get(z.id, [])
            ],
        }
        for z in zones
    ]
