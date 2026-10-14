"""
The board's lights as alerts (P:/specs/manager-problems.md §2): "Z לא בוצע", "משמרת פתוחה מעבר
לזמן", "שידור אשראי באיחור" and "תקלת מדפסת בקופה" — for the exceptions log and the phone
(push) alerts.

The same readings the machines page feeds the status light (app/services/machine_status.py,
app/routers/machines.py) — closed shifts no Z has taken, a shift open past its date, the card
transmission state, the printer's last report — decided by the same functions
(`date_has_passed`, `transmission_flags`, `printer_problem`), with the thresholds of each kind's
exception rule (app/services/exceptions.py, per tenant / company / shop / area / till — "הגדרות
חריגות"). A kind switched off where a till sits is neither logged nor sent there; the light on
the board does not change.

Each case is ONE `audit_exceptions` row (the ORM hooks carry it to the log and the alerts):

* `z_missing` — per till in till-Z mode, else per shop (the shop's Z; the shop's rule decides),
  per business date: closed shifts of that date no Z has taken, at least one of them with a
  document on the cloud, `hoursAfterDayEnd` hours after the day ended — the later of the local
  midnight after the date and the last of those shifts' closes — and no shift of that date or
  before still open there. Key `z_missing:<till|shop>:<id>:<date>`.
* `shift_open_overdue` — an open shift open more than `hours`; and, when the rule's `alertPastDate` is
  on, also past its business date (the board's `shift_open_past_its_date`). Off by default (the owner,
  14.10.2026 — P:/specs/owner-decisions-1410.md §3): no alert at midnight, only the hours; the board's
  light is unchanged either way. Key `shift_open_overdue:<shift>`.
* `card_transmission_overdue` — medium past `warnHours`, high past `criticalDays` (the board's
  `transmission_overdue` / `transmission_critical` with the rule's thresholds), once per till
  and level for one run since the last successful transmission. The high row closes the
  medium one.
* `till_printer` — a till with an open shift, heard from (online), whose printer reports no
  paper / overheated / an error for `minutes`, timed from the first pass that saw it (this
  process; a restart starts the minutes again). Once per fault streak (`till_printer:<till>:<n>`).

**Closing.** When the light goes out (a Z took the shifts, the shift closed, the transmission
went through, the printer is fine again) the row gets `details.resolvedAt` and is marked
reviewed with a note — the log entry mirrors it as handled (log.py `_mirror_ack`). A row a
manager already marked keeps their mark; `details.resolvedAt` is still set, so a new case is
recognised as new.

Runs from the exception alerts' background pass (worker.py), at most every `INTERVAL`.
Idempotent: the dedupe keys are unique; a second API process loses the insert race quietly.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.services import machine_status as MS

logger = logging.getLogger(__name__)

Z_MISSING = "z_missing"
SHIFT_OPEN_OVERDUE = "shift_open_overdue"
CARD_TRANSMISSION_OVERDUE = "card_transmission_overdue"
TILL_PRINTER = "till_printer"
KINDS = (Z_MISSING, SHIFT_OPEN_OVERDUE, CARD_TRANSMISSION_OVERDUE, TILL_PRINTER)

#: The background pass runs every minute; this watch at most this often.
INTERVAL = timedelta(minutes=2)
#: Open rows older than this are not looked at again (a light left on for a month is the board's).
RESOLVE_WINDOW = timedelta(days=35)
#: Closed shifts awaiting a Z from before this are history, not news (none is recorded for them).
Z_LOOKBACK_DAYS = 14

AUTO_NOTE = "נסגר אוטומטית: "

_last_run: Optional[datetime] = None
#: `till_printer`: when this process first saw each till's current fault — {machine id: (status, at)}.
_printer_since: Dict[Any, Tuple[str, datetime]] = {}


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _zone(name: Optional[str]):
    try:
        return ZoneInfo(name) if name else timezone.utc
    except Exception:  # noqa: BLE001 - an unknown zone reads as UTC, like the board
        return timezone.utc


def day_end(business_date: date, timezone_name: Optional[str]) -> datetime:
    """The local midnight after the business date, in UTC (where `date_has_passed` turns true)."""
    local = datetime.combine(business_date + timedelta(days=1), time(0, 0), tzinfo=_zone(timezone_name))
    return local.astimezone(timezone.utc)


# ── Rules ────────────────────────────────────────────────────────────────────


class _Rules:
    """The effective rule of each kind per till, or per shop (a shop's Z), cached for one pass."""

    def __init__(self, db: Session):
        self.db = db
        self._machines: Dict[Any, Dict[str, Any]] = {}
        self._shops: Dict[Any, Dict[str, Any]] = {}

    def machine(self, machine: POSMachine, kind: str):
        from app.services import exceptions as EX

        if machine.id not in self._machines:
            self._machines[machine.id] = EX.rules_for_machine(self.db, machine)
        rule = self._machines[machine.id].get(kind)
        return rule if rule is not None and rule.enabled else None

    def shop(self, shop: Shop, kind: str):
        from app.services import exceptions as EX

        if shop.id not in self._shops:
            chain = EX.chain_for(tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id)
            self._shops[shop.id] = EX.resolve_rules(EX.rules_on_chain(self.db, chain), chain)
        rule = self._shops[shop.id].get(kind)
        return rule if rule is not None and rule.enabled else None


# ── Rows ─────────────────────────────────────────────────────────────────────


def _till_name(machine: Optional[POSMachine]) -> Optional[str]:
    if machine is None:
        return None
    return f"קופה {machine.pos_number}" if machine.pos_number else (machine.name or "קופה")


def _write(
    db: Session,
    *,
    kind: str,
    key: str,
    occurred_at: datetime,
    now: datetime,
    severity: str,
    details: Dict[str, Any],
    machine: Optional[POSMachine] = None,
    shop: Optional[Shop] = None,
    shift_id: Any = None,
    amount: Any = None,
    value: Any = None,
    threshold: Any = None,
) -> Optional[AuditException]:
    if shop is None and machine is not None and machine.shop_id is not None:
        shop = db.get(Shop, machine.shop_id)
    row = AuditException(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id if machine is not None else (shop.tenant_id if shop is not None else None),
        company_id=shop.company_id if shop is not None else None,
        shop_id=shop.id if shop is not None else (machine.shop_id if machine is not None else None),
        area_id=machine.area_id if machine is not None else None,
        machine_id=machine.id if machine is not None else None,
        shift_id=shift_id,
        exception_type=kind,
        severity=severity,
        dedupe_key=key[:200],
        amount=amount,
        value=value,
        threshold=threshold,
        details={**details, "resolvedAt": None},
        occurred_at=min(occurred_at, now),
        detected_at=now,
        status="new",
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None  # already recorded (another process, an earlier pass)
    return row


def _open_rows(db: Session, kinds: Sequence[str], now: datetime) -> List[AuditException]:
    """This watch's rows whose light has not gone out yet (whatever a manager marked)."""
    rows = (
        db.query(AuditException)
        .filter(AuditException.exception_type.in_(list(kinds)), AuditException.detected_at > now - RESOLVE_WINDOW)
        .order_by(AuditException.occurred_at)
        .all()
    )
    return [r for r in rows if not (r.details or {}).get("resolvedAt")]


def resolve(row: AuditException, now: datetime, why: str) -> None:
    """The light went out: `details.resolvedAt`, and handled (unless a manager already marked it)."""
    details = dict(row.details or {})
    details["resolvedAt"] = now.isoformat()
    details["resolvedBecause"] = why
    row.details = details
    if row.status == "new":
        row.status = "reviewed"
        row.reviewed_at = now
        row.reviewed_by_user_id = None
        row.review_note = f"{AUTO_NOTE}{why}"


# ── The readings ─────────────────────────────────────────────────────────────


@dataclass
class _World:
    machines: Dict[Any, POSMachine]
    shops: Dict[Any, Shop]
    zones: Dict[Any, Optional[str]]
    open_shifts: List[Shift]

    def zone_of(self, tenant_id) -> Optional[str]:
        return self.zones.get(tenant_id)


def _world(db: Session, machine_ids: Iterable[Any], shop_ids: Iterable[Any], open_shifts: List[Shift]) -> _World:
    from app.models.tenant import Tenant

    mids = list({m for m in machine_ids if m is not None})
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(mids)).all()} if mids else {}
    sids = list({s for s in shop_ids if s is not None} | {m.shop_id for m in machines.values() if m.shop_id})
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(sids)).all()} if sids else {}
    tids = list({m.tenant_id for m in machines.values() if m.tenant_id} | {s.tenant_id for s in shops.values()})
    zones = {t.id: t.timezone for t in db.query(Tenant).filter(Tenant.id.in_(tids)).all()} if tids else {}
    return _World(machines=machines, shops=shops, zones=zones, open_shifts=open_shifts)


# ── Shift open past its time ─────────────────────────────────────────────────


def scan_shifts(db: Session, rules: _Rules, world: _World, now: datetime) -> int:
    changed = 0
    open_ids = set()
    for shift in world.open_shifts:
        open_ids.add(shift.id)
        machine = world.machines.get(shift.machine_id)
        if machine is None or not machine.is_active:
            continue
        rule = rules.machine(machine, SHIFT_OPEN_OVERDUE)
        if rule is None:
            continue
        hours = int(rule.params.get("hours") or 16)
        opened = _utc(shift.opened_at)
        zone = world.zone_of(machine.tenant_id)
        # "התראה גם כשהמשמרת עוברת את התאריך שלה": off by default — the hours alone.
        past_date = rule.params.get("alertPastDate") is True and MS.date_has_passed(
            shift.business_date, zone, now=now
        )
        too_long = opened is not None and now - opened > timedelta(hours=hours)
        if not (past_date or too_long):
            continue
        moments = []
        if too_long:
            moments.append(opened + timedelta(hours=hours))
        if past_date:
            moments.append(day_end(shift.business_date, zone))
        open_hours = int((now - opened).total_seconds() // 3600) if opened is not None else None
        till = _till_name(machine)
        number = f" {shift.sequence_number}" if shift.sequence_number is not None else ""
        summary = (
            f"{till}: משמרת{number} פתוחה {open_hours} שעות"
            if too_long and open_hours is not None
            else f"{till}: משמרת{number} פתוחה מעבר לתאריך שלה ({shift.business_date.strftime('%d.%m')})"
        )
        if _write(
            db, kind=SHIFT_OPEN_OVERDUE, key=f"{SHIFT_OPEN_OVERDUE}:{shift.id}", occurred_at=min(moments), now=now,
            severity="medium", machine=machine, shift_id=shift.id, value=open_hours, threshold=hours,
            details={
                "summary": summary,
                "reason": "hours" if too_long else "past_date",
                "businessDate": shift.business_date.isoformat(),
                "openedAt": opened.isoformat() if opened else None,
                "sequenceNumber": shift.sequence_number,
            },
        ) is not None:
            changed += 1
    for row in _open_rows(db, (SHIFT_OPEN_OVERDUE,), now):
        if row.shift_id not in open_ids:
            resolve(row, now, "המשמרת נסגרה")
            changed += 1
    return changed


# ── Z not made ───────────────────────────────────────────────────────────────


def _awaiting(db: Session, now: datetime) -> List[Shift]:
    """Closed shifts no Z has taken (the board's `closed_shifts_awaiting_z` query), recent ones."""
    return (
        db.query(Shift)
        .filter(
            Shift.status == ShiftStatus.CLOSED,
            Shift.z_report_id.is_(None),
            # As far back as an open row may be (RESOLVE_WINDOW): its shifts decide whether it closes.
            Shift.business_date >= (now - RESOLVE_WINDOW - timedelta(days=1)).date(),
        )
        .all()
    )


def _z_groups(awaiting: Sequence[Shift], world: _World) -> Dict[Tuple[str, Any, date], List[Shift]]:
    """(till | shop, its id, business date) → the shifts awaiting that Z: per till in till-Z mode, else per shop."""
    from app.services.till_z import Z_MODE_TILL, z_mode_of

    groups: Dict[Tuple[str, Any, date], List[Shift]] = {}
    for shift in awaiting:
        machine = world.machines.get(shift.machine_id)
        if machine is not None and z_mode_of(machine) == Z_MODE_TILL:
            key = ("till", machine.id, shift.business_date)
        elif shift.shop_id is not None:
            key = ("shop", shift.shop_id, shift.business_date)
        else:
            continue
        groups.setdefault(key, []).append(shift)
    return groups


def _blocked_by_open(scope: str, ident: Any, day: date, world: _World) -> bool:
    """A shift of that date (or before) still open there: the day is not over yet."""
    for shift in world.open_shifts:
        here = shift.machine_id == ident if scope == "till" else shift.shop_id == ident
        if here and shift.business_date <= day:
            return True
    return False


def scan_z(db: Session, rules: _Rules, world: _World, awaiting: Sequence[Shift], now: datetime) -> int:
    from app.services.close_progress import documents_on_cloud

    changed = 0
    groups = _z_groups(awaiting, world)
    documents = documents_on_cloud(db, [s.id for s in awaiting]) if awaiting else {}
    for (scope, ident, day), shifts in groups.items():
        if scope == "till":
            machine = world.machines.get(ident)
            shop = world.shops.get(machine.shop_id) if machine is not None else None
            if machine is None or not machine.is_active:
                continue
            rule = rules.machine(machine, Z_MISSING)
            tenant_id = machine.tenant_id
        else:
            machine = None
            shop = world.shops.get(ident)
            if shop is None:
                continue
            rule = rules.shop(shop, Z_MISSING)
            tenant_id = shop.tenant_id
        if rule is None or day < (now - timedelta(days=Z_LOOKBACK_DAYS)).date():
            continue
        zone = world.zone_of(tenant_id)
        if not MS.date_has_passed(day, zone, now=now):
            continue
        if not any(documents.get(s.id) for s in shifts):
            continue  # nothing sold: no Z is made for nothing
        if _blocked_by_open(scope, ident, day, world):
            continue
        hours = int(rule.params.get("hoursAfterDayEnd") or 0)
        closes = [_utc(s.closed_at or s.close_accepted_at) for s in shifts]
        ended = max([day_end(day, zone)] + [c for c in closes if c is not None])
        due = ended + timedelta(hours=hours)
        if now < due:
            continue
        when = day.strftime("%d.%m")
        summary = (
            f"{_till_name(machine)}: Z לא בוצע ליום {when}" if scope == "till"
            else f"Z סניפי לא בוצע ליום {when}"
        )
        if _write(
            db, kind=Z_MISSING, key=f"{Z_MISSING}:{scope}:{ident}:{day.isoformat()}", occurred_at=due, now=now,
            severity="high", machine=machine, shop=shop, threshold=hours,
            value=int((now - ended).total_seconds() // 3600),
            details={
                "summary": summary,
                "scope": scope,
                "businessDate": day.isoformat(),
                "shiftCount": len(shifts),
                "shiftIds": [str(s.id) for s in shifts[:20]],
                "dayEndedAt": ended.isoformat(),
            },
        ) is not None:
            changed += 1
    pending = {(scope, str(ident), day.isoformat()) for (scope, ident, day) in groups}
    for row in _open_rows(db, (Z_MISSING,), now):
        details = row.details or {}
        scope = details.get("scope")
        ident = row.machine_id if scope == "till" else row.shop_id
        if (scope, str(ident), details.get("businessDate")) not in pending:
            resolve(row, now, "ה-Z בוצע")
            changed += 1
    return changed


# ── Card transmission ────────────────────────────────────────────────────────


def _became(moments: Iterable[Optional[datetime]], after: timedelta) -> Optional[datetime]:
    out = [m + after for m in moments if m is not None]
    return min(out) if out else None


def scan_transmissions(db: Session, rules: _Rules, now: datetime) -> int:
    from app.services import transmissions as T

    changed = 0
    machines = (
        db.query(POSMachine)
        .filter(
            POSMachine.is_active.is_(True),
            (POSMachine.transmission_tracking_started_at.isnot(None)) | (POSMachine.transmission_reported_at.isnot(None)),
        )
        .all()
    )
    ids = [m.id for m in machines]
    untransmitted = T.untransmitted_summary(db, ids) if ids else {}
    latest = T.latest_by_machine(db, ids) if ids else {}
    levels: Dict[Any, Optional[str]] = {}
    for machine in machines:
        state = T.machine_transmission(machine, untransmitted.get(machine.id), latest.get(machine.id))
        rule = rules.machine(machine, CARD_TRANSMISSION_OVERDUE)
        warn = timedelta(hours=int((rule.params.get("warnHours") if rule else None) or 24))
        critical_after = timedelta(days=int((rule.params.get("criticalDays") if rule else None) or 4))
        data = MS.StatusInput(
            transmission_pending=state.anything_pending,
            transmission_oldest_pending_at=state.oldest_pending_at,
            transmission_last_success_at=state.last_transmission_at,
            transmission_tracking_started_at=state.tracking_started_at,
        )
        flags = MS.transmission_flags(data, now=now, overdue_after=warn, critical_after=critical_after)
        level = (
            "high" if MS.MachineFlag.TRANSMISSION_CRITICAL in flags
            else "medium" if MS.MachineFlag.TRANSMISSION_OVERDUE in flags
            else None
        )
        levels[machine.id] = level
        if level is None or rule is None:
            continue
        oldest = _utc(state.oldest_pending_at)
        success_ref = _utc(state.last_transmission_at) or _utc(state.tracking_started_at)
        if level == "high":
            occurred = _became([oldest if oldest is not None else success_ref], critical_after)
        else:
            occurred = _became([oldest, success_ref], warn)
        anchor = success_ref.strftime("%Y%m%dT%H%M%S") if success_ref is not None else "none"
        amount = state.pending_amount if state.pending_amount is not None else state.untransmitted_amount
        count = state.pending_count if state.pending_count is not None else state.untransmitted_legs
        age_from = oldest or success_ref
        hours_late = int((now - age_from).total_seconds() // 3600) if age_from is not None else None
        till = _till_name(machine)
        summary = f"{till}: שידור אשראי באיחור" + (f" ({hours_late} שעות)" if hours_late is not None else "")
        if level == "high":
            summary += " — קרוב לסירוב חברות האשראי"
        row = _write(
            db, kind=CARD_TRANSMISSION_OVERDUE, key=f"{CARD_TRANSMISSION_OVERDUE}:{machine.id}:{level}:{anchor}",
            occurred_at=occurred or now, now=now, severity=level, machine=machine, amount=amount,
            value=hours_late, threshold=(critical_after.days * 24 if level == "high" else int(warn.total_seconds() // 3600)),
            details={
                "summary": summary,
                "level": level,
                "pendingCount": count,
                "oldestPendingAt": oldest.isoformat() if oldest else None,
                "lastSuccessAt": _utc(state.last_transmission_at).isoformat() if state.last_transmission_at else None,
                "lastError": state.last_error,
            },
        )
        if row is not None:
            changed += 1
            if level == "high":
                for older in _open_rows(db, (CARD_TRANSMISSION_OVERDUE,), now):
                    if older.machine_id == machine.id and older.id != row.id and older.severity == "medium":
                        resolve(older, now, "עבר לחומרה גבוהה")
                        changed += 1
    for row in _open_rows(db, (CARD_TRANSMISSION_OVERDUE,), now):
        level = levels.get(row.machine_id, None)
        if level is None or (row.severity == "high" and level != "high"):
            resolve(row, now, "השידור בוצע")
            changed += 1
    return changed


# ── The till's printer ───────────────────────────────────────────────────────

PRINTER_WORDS = {"no_paper": "אין נייר במדפסת", "overheated": "המדפסת התחממה", "error": "שגיאת מדפסת"}


def scan_printers(db: Session, rules: _Rules, world: _World, now: datetime) -> int:
    from app.models.kiosk import KioskDevice

    changed = 0
    kiosks = {r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).all()}
    trading = {s.machine_id for s in world.open_shifts}
    faulty = set()
    for machine_id in trading:
        machine = world.machines.get(machine_id)
        if machine is None or not machine.is_active or machine.id in kiosks:
            continue
        if not MS.printer_problem(machine.printer_status) or not MS.is_online(machine.last_heartbeat_at, now=now):
            continue
        faulty.add(machine.id)
        seen = _printer_since.get(machine.id)
        if seen is None or seen[0] != machine.printer_status:
            # A fault seen by this process for the first time starts its minutes now; another fault
            # right after it (no paper, then an error) is the same streak.
            started = seen[1] if seen is not None else now
            _printer_since[machine.id] = (machine.printer_status, started)
            seen = _printer_since[machine.id]
        rule = rules.machine(machine, TILL_PRINTER)
        if rule is None:
            continue
        minutes = int(rule.params.get("minutes") or 3)
        if now - seen[1] < timedelta(minutes=minutes):
            continue
        if any(r.machine_id == machine.id for r in _open_rows(db, (TILL_PRINTER,), now)):
            continue  # this streak is recorded
        streak = (
            db.query(AuditException.id)
            .filter(AuditException.exception_type == TILL_PRINTER, AuditException.machine_id == machine.id)
            .count()
            + 1
        )
        what = PRINTER_WORDS.get(machine.printer_status, "תקלת מדפסת")
        if machine.printer_error_code is not None and machine.printer_status == "error":
            what += f" (קוד {machine.printer_error_code})"
        if _write(
            db, kind=TILL_PRINTER, key=f"{TILL_PRINTER}:{machine.id}:{streak}", occurred_at=seen[1], now=now,
            severity="medium", machine=machine, threshold=minutes,
            value=int((now - seen[1]).total_seconds() // 60),
            details={
                "summary": f"{_till_name(machine)}: {what}",
                "printerStatus": machine.printer_status,
                "printerErrorCode": machine.printer_error_code,
                "printerMessage": machine.printer_message,
                "since": seen[1].isoformat(),
            },
        ) is not None:
            changed += 1
    for machine_id in [m for m in _printer_since if m not in faulty]:
        _printer_since.pop(machine_id, None)
    for row in _open_rows(db, (TILL_PRINTER,), now):
        machine = world.machines.get(row.machine_id) or (db.get(POSMachine, row.machine_id) if row.machine_id else None)
        if machine is None or not MS.printer_problem(machine.printer_status):
            resolve(row, now, "המדפסת חזרה לפעול")
            changed += 1
    return changed


# ── One pass ─────────────────────────────────────────────────────────────────


def scan(db: Session, *, now: Optional[datetime] = None) -> int:
    """Every kind once: new cases recorded, gone ones closed. Returns rows written or changed. Caller commits."""
    now = _utc(now) or datetime.now(timezone.utc)
    open_shifts = db.query(Shift).filter(Shift.status == ShiftStatus.OPEN).all()
    awaiting = _awaiting(db, now)
    world = _world(
        db,
        [s.machine_id for s in open_shifts] + [s.machine_id for s in awaiting],
        [s.shop_id for s in awaiting] + [s.shop_id for s in open_shifts],
        open_shifts,
    )
    rules = _Rules(db)
    changed = 0
    for name, job in (
        ("shift", lambda: scan_shifts(db, rules, world, now)),
        ("z", lambda: scan_z(db, rules, world, awaiting, now)),
        ("transmission", lambda: scan_transmissions(db, rules, now)),
        ("printer", lambda: scan_printers(db, rules, world, now)),
    ):
        try:
            with db.begin_nested():
                changed += job()
        except Exception:  # noqa: BLE001 - one kind's failure never stops the others
            logger.exception("status watch: %s failed", name)
    db.flush()
    return changed


def due(now: Optional[datetime] = None) -> bool:
    """Whether the background pass should run the watch now (at most every INTERVAL)."""
    global _last_run
    now = _utc(now) or datetime.now(timezone.utc)
    if _last_run is not None and now - _last_run < INTERVAL:
        return False
    _last_run = now
    return True


__all__ = ["KINDS", "scan", "resolve", "due", "day_end"]
