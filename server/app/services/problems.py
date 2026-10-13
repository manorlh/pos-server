"""
"בעיות" — one screen of what needs a manager now (P:/specs/manager-problems.md §3, §6).

`GET /problems` (app/routers/problems.py) answers in one call, in fixed groups:

* `devices` — a till offline (with unsent sales), unsent sales on a till that is online, the
  till's printer (no paper, overheated, error), a kiosk's health (offline, card terminal,
  printer, KDS, its link to the till) and a low battery;
* `z_shift` — a Z not done, a shift open past its date or too long, closed shifts awaiting a Z,
  a forced Z;
* `card` — card transmission late or failed, a terminal not answering, a card payment left
  undecided, Z-Credit gaps;
* `kitchen` — bons that did not print;
* `integrity` — a refused document, a numbering conflict, Z / shift totals gaps: the super
  admin's only (§1), never listed to anyone else.

Nothing is worked out again here — every problem is a reading an existing screen already shows:

* the open rows of the exceptions log (not "טופל", not back / resolved) of the kinds above, from
  the last `LOG_WINDOW` (a terminal that did not answer: `SHORT_WINDOW`);
* the tills' status light and flags (app/services/machine_status.py, fed exactly as the machines
  list feeds it, minus the catalog watermark no problem reads);
* the kiosks' health (app/services/kiosk_health.py, `GET /kiosks/health`'s own view);
* open low-battery alerts (app/services/battery_alerts.py);
* card payments still "לא הוכרע" (app/services/failed_payments.py);
* Z-Credit reconciliation gaps still open in the latest runs (`/zcredit-reconciliation/attention`).

**One problem, one card.** A log row and a live reading about the same thing on the same device
(a till offline, its printer, its transmission, its Z, its shift) are listed once — as the log
row, which carries "טופל". Likewise a payment or a Z-Credit gap that has a log row.

**Who sees what** is the exceptions log's `scoped()` (app/routers/exception_log.py), applied to
every source: the super admin everything, a distributor the tills they placed, a company manager
their companies' shops, a shop's people their shop, a cashier nothing (403).

Bounded: one query per source, at most `LOG_FETCH_MAX` log rows, `GROUP_LIMIT` items per group
(each group says its `total`).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.exception_alerts import ExceptionLogEntry
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)

#: The groups, in the screen's fixed order.
GROUPS: Tuple[str, ...] = ("devices", "z_shift", "card", "kitchen", "integrity")
#: Groups only a super admin is shown (§1: "שלמות נתונים").
SUPER_ADMIN_GROUPS = frozenset({"integrity"})
SEVERITIES: Tuple[str, ...] = ("high", "medium", "low")
_SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}

GROUP_LIMIT = 50
#: The log rows read: open ones from the last two weeks, at most this many.
LOG_WINDOW = timedelta(days=14)
LOG_FETCH_MAX = 1000
#: A terminal that did not answer is news for a short while; it is not a state that lasts.
SHORT_WINDOW = timedelta(days=2)
#: Z-Credit runs read (the attention badge's default).
ZCREDIT_DAYS = 14
#: Card payments still undecided, from this far back (the failed payments list's default).
PAYMENTS_WINDOW_DAYS = 30

#: Exception-log kinds → their group. Kinds another branch adds (§1/§2: `z_missing`,
#: `shift_open_overdue`, `card_transmission_overdue`, `till_printer`) are named as strings, so
#: their rows group here as soon as they exist.
KIND_GROUP: Dict[str, str] = {
    # ── devices ──
    "till_offline": "devices",
    "kiosk_offline": "devices",
    "till_printer": "devices",
    "kiosk_printer": "devices",
    "kiosk_terminal": "devices",
    "device_battery": "devices",
    # ── Z and shifts ──
    "z_missing": "z_shift",
    "shift_open_overdue": "z_shift",
    "forced_z_close": "z_shift",
    "z_forced_open_shifts": "z_shift",
    "z_forced_pending_cloud_refund": "z_shift",
    "shop_z_producer_forced": "z_shift",
    "local_shop_z_till_unsynced": "z_shift",
    "cloud_closed_shift_late_documents": "z_shift",
    # ── card ──
    "card_transmission_overdue": "card",
    "z_transmission_failed": "card",
    "failed_payment": "card",
    "card_unresolved": "card",
    "terminal_mismatch": "card",
    "card_failures": "card",
    "zcredit_recon": "card",
    # ── kitchen ──
    "bon_unprinted": "kitchen",
    # ── data integrity (the super admin's) ──
    "document_refused": "integrity",
    "document_number_conflict": "integrity",
    "z_totals_mismatch": "integrity",
    "shift_totals_mismatch": "integrity",
    "local_shop_z_mismatch": "integrity",
    "offline_z_gap": "integrity",
    "offline_z_conflict": "integrity",
}
INTEGRITY_KINDS = frozenset(k for k, g in KIND_GROUP.items() if g == "integrity")

#: What a log kind and a live reading are both about, per device (or per shop for a shop's Z):
#: when an open row of the kind is there, the reading of the same topic is not listed again.
TOPIC_OF_KIND: Dict[str, str] = {
    "till_offline": "offline",
    "kiosk_offline": "offline",
    "till_printer": "printer",
    "kiosk_printer": "printer",
    "kiosk_terminal": "terminal",
    "device_battery": "battery",
    "z_missing": "z_missing",
    "shift_open_overdue": "shift_overdue",
    "card_transmission_overdue": "transmission",
}

#: A failed payment is a problem only when the terminal failed or the result is unknown.
PROBLEM_PAYMENT_OUTCOMES = frozenset({"no_answer", "terminal_error", "unresolved"})
#: …and of those, these are momentary (the short window).
MOMENTARY_PAYMENT_OUTCOMES = frozenset({"no_answer", "terminal_error"})

#: Kiosk health parts that are a problem when they say `error` (or `warn`), and their kind.
KIOSK_PARTS: Dict[str, Tuple[str, Optional[str]]] = {
    # part key → (item kind, dedupe topic)
    "terminal": ("kiosk_terminal", "terminal"),
    "printer": ("kiosk_printer", "printer"),
    "kds": ("kiosk_kds", None),
    "tillLink": ("kiosk_till_link", None),
    "bridge": ("kiosk_bridge", None),
}

PRINTER_LABELS = {"no_paper": "אין נייר", "overheated": "המדפסת התחממה", "error": "שגיאת מדפסת"}
KIOSK_PART_LABELS = {
    "terminal": "מסוף האשראי בקיוסק",
    "printer": "המדפסת בקיוסק",
    "kds": "מסך המטבח (KDS) של הקיוסק",
    "tillLink": "החיבור של הקיוסק לקופה",
    "bridge": "גשר Windows של הקיוסק",
}
KIOSK_CODE_LABELS = {
    "unreachable": "לא עונה",
    "not_ready": "לא מוכן",
    "not_configured": "לא מוגדר",
    "none": "לא מחובר",
    "card_lock": "מסוף אחר מחובר (נעילת אשראי)",
    "card_unknown": "תשלום שלא הוכרע",
    "no_paper": "אין נייר",
    "offline": "לא מגיבה",
    "unavailable": "לא זמינה",
    "error": "שגיאה",
    "overheated": "התחממה",
    "usb_detached": "מנותקת",
    "unprinted": "בונים שלא הודפסו",
    "usb_permission": "חסר אישור USB",
    "no_screens": "אין מסך מטבח",
    "screens_offline": "מסכי המטבח לא מחוברים",
    "down": "לא מחובר",
    "not_paired": "לא מצומד",
    "not_linked": "לא מקושר",
}


# ── Scope (the exceptions log's `scoped()`, for every source) ─────────────────


@dataclass
class Reach:
    """Who the user reaches, decided exactly as `exception_log.scoped()` decides it."""

    user: User
    tenant_id: Any
    #: "all" (super admin) | "distributor" | "shops" (company manager, a shop's people) | "none".
    mode: str
    shop_ids: Any = None  # a Query of Shop.id (company manager) or a one-element list
    log_query: Any = None

    @property
    def super_admin(self) -> bool:
        return self.mode == "all"

    def machines(self, db: Session):
        """The tenant's machines in reach (a query), or None for none."""
        q = db.query(POSMachine).filter(POSMachine.tenant_id == self.tenant_id)
        if self.mode == "all":
            return q
        if self.mode == "distributor":
            return q.filter(POSMachine.distributor_id == self.user.id)
        if self.mode == "shops":
            return q.filter(POSMachine.shop_id.in_(self.shop_ids))
        return None

    def rows(self, query, shop_col, machine_col):
        """Any table with a shop and a till column, narrowed the same way."""
        if self.mode == "all":
            return query
        if self.mode == "distributor":
            mine = query.session.query(POSMachine.id).filter(POSMachine.distributor_id == self.user.id)
            return query.filter(machine_col.in_(mine))
        if self.mode == "shops":
            return query.filter(shop_col.in_(self.shop_ids))
        return None


def reach_for(db: Session, user: User, tenant_id: Any) -> Reach:
    """403 for a cashier (as the log); the log's own query for the log rows."""
    from app.routers.exception_log import scoped
    from app.services.company_hierarchy import visible_shop_ids
    from app.services.permission_matrix import SHOP_SCOPED_ROLES

    log_query = scoped(db, user, tenant_id)  # raises 403 for a cashier
    if user.role == UserRole.SUPER_ADMIN:
        mode, shops = "all", None
    elif user.role == UserRole.DISTRIBUTOR:
        mode, shops = "distributor", None
    elif user.role == UserRole.COMPANY_MANAGER and user.company_id:
        mode, shops = "shops", visible_shop_ids(db, user)
    elif user.role in SHOP_SCOPED_ROLES and user.shop_id:
        mode, shops = "shops", [user.shop_id]
    else:
        mode, shops = "none", None
    return Reach(user=user, tenant_id=tenant_id, mode=mode if log_query is not None else "none",
                 shop_ids=shops, log_query=log_query)


# ── Items ────────────────────────────────────────────────────────────────────


@dataclass
class Item:
    id: str
    kind: str
    group: str
    severity: str
    since: Optional[datetime]
    title: str
    detail: Optional[str] = None
    link: Optional[str] = None
    company_id: Any = None
    shop_id: Any = None
    machine_id: Any = None
    entry: Optional[ExceptionLogEntry] = None
    amount: Optional[float] = None
    #: A plain date (a business day) when the problem dates from a day rather than a moment.
    since_date: Optional[date] = None


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _utc(value)
    return value.isoformat() if value is not None else None


def _str(value: Any) -> Optional[str]:
    return str(value) if value is not None else None


def _details(entry: ExceptionLogEntry) -> Dict[str, Any]:
    return entry.details if isinstance(entry.details, dict) else {}


def is_open(entry: ExceptionLogEntry) -> bool:
    """Not "טופל", and not over by itself (a till / kiosk back online, a state resolved)."""
    if entry.acknowledged_at is not None:
        return False
    details = _details(entry)
    return not (details.get("backAt") or details.get("resolvedAt") or details.get("resolved") is True)


def _money(amount: Any) -> Optional[str]:
    if amount is None:
        return None
    try:
        return f"₪{float(amount):,.2f}"
    except (TypeError, ValueError):
        return None


# ── The exceptions log ───────────────────────────────────────────────────────


def _log_rows(db: Session, reach: Reach, now: datetime, *, company_ids=None, shop_id=None) -> List[ExceptionLogEntry]:
    if reach.log_query is None:
        return []
    kinds = [k for k in KIND_GROUP if reach.super_admin or k not in INTEGRITY_KINDS]
    q = reach.log_query.filter(
        ExceptionLogEntry.kind.in_(kinds),
        ExceptionLogEntry.acknowledged_at.is_(None),
        ExceptionLogEntry.occurred_at >= now - LOG_WINDOW,
    )
    if company_ids is not None:
        q = q.filter(ExceptionLogEntry.company_id.in_(company_ids))
    if shop_id is not None:
        q = q.filter(ExceptionLogEntry.shop_id == shop_id)
    rows = q.order_by(ExceptionLogEntry.occurred_at.desc(), ExceptionLogEntry.id).limit(LOG_FETCH_MAX).all()
    out = []
    for r in rows:
        if not is_open(r):
            continue
        if r.kind == "failed_payment":
            outcome = _details(r).get("outcome")
            if outcome not in PROBLEM_PAYMENT_OUTCOMES:
                continue
            if outcome in MOMENTARY_PAYMENT_OUTCOMES and _utc(r.occurred_at) < now - SHORT_WINDOW:
                continue
        out.append(r)
    return out


def _log_item(entry: ExceptionLogEntry) -> Item:
    from app.services.exception_alerts import catalog as C

    details = _details(entry)
    label = C.label_of(entry.kind)
    if entry.kind == "failed_payment":
        outcome = details.get("outcome")
        label = "תשלום באשראי לא הוכרע" if outcome == "unresolved" else "מסוף האשראי לא ענה / נכשל"
    parts = [entry.summary] if entry.summary else []
    money = _money(entry.amount)
    if money and (not entry.summary or money not in entry.summary):
        parts.append(money)
    return Item(
        id=f"log:{entry.id}",
        kind=entry.kind,
        group=KIND_GROUP[entry.kind],
        severity=entry.severity if entry.severity in _SEVERITY_RANK else "medium",
        since=_utc(entry.occurred_at),
        title=label,
        detail=" · ".join(p for p in parts if p) or None,
        link=f"/dashboard/exceptions-log?code={entry.short_code}" if entry.short_code else "/dashboard/exceptions-log",
        company_id=entry.company_id,
        shop_id=entry.shop_id,
        machine_id=entry.machine_id,
        entry=entry,
        amount=float(entry.amount) if entry.amount is not None else None,
    )


# ── Tills: the status light and its flags ────────────────────────────────────


def _kiosk_ids(db: Session, machine_ids: Sequence[Any]) -> Set[Any]:
    from app.models.kiosk import KioskDevice

    if not machine_ids:
        return set()
    return {
        r[0] for r in db.query(KioskDevice.machine_id)
        .filter(KioskDevice.machine_id.in_(list(machine_ids)), KioskDevice.home_role.is_(None)).all()
    }


def _till_items(db: Session, machines: List[POSMachine], now: datetime) -> List[Tuple[Item, Optional[str]]]:
    """(item, dedupe topic) per problem the tills' own light and flags show."""
    from app.routers.machines import _awaiting_z_by_machine, _tenant_timezones
    from app.services import transmissions
    from app.services.machine_status import MachineFlag, MachineStatus, StatusInput, resolve_status
    from app.services.remote_close import pending_close_sources
    from app.services.shifts import open_shifts_for_machines

    if not machines:
        return []
    ids = [m.id for m in machines]
    open_shifts = open_shifts_for_machines(db, ids)
    pending_close = pending_close_sources(db, ids)
    awaiting = _awaiting_z_by_machine(db, ids)
    timezones = _tenant_timezones(db, machines)
    untransmitted = transmissions.untransmitted_summary(db, ids)
    latest = transmissions.latest_by_machine(db, ids)

    out: List[Tuple[Item, Optional[str]]] = []
    for m in machines:
        shift = open_shifts.get(m.id)
        awaiting_count, oldest_awaiting = awaiting.get(m.id, (0, None))
        tx = transmissions.machine_transmission(m, untransmitted.get(m.id), latest.get(m.id))
        # The machines list's own reading (app/routers/machines.py `_enrich_machine_status`).
        light = resolve_status(
            StatusInput(
                is_active=bool(m.is_active),
                pairing_status=m.pairing_status.value if hasattr(m.pairing_status, "value") else m.pairing_status,
                last_heartbeat_at=m.last_heartbeat_at,
                shift_open=shift is not None,
                business_date=shift.business_date if shift is not None else None,
                close_shift_pending=m.id in pending_close,
                oldest_awaiting_z_date=oldest_awaiting,
                timezone_name=timezones.get(m.tenant_id),
                pending_documents=m.pending_documents,
                pending_count=m.pending_count,
                pending_count_at=m.pending_count_at,
                clock_skew_ms=m.clock_skew_ms,
                battery_percent=m.battery_percent,
                mqtt_connected=m.mqtt_connected,
                transmission_pending=tx.anything_pending,
                transmission_oldest_pending_at=tx.oldest_pending_at,
                transmission_last_success_at=tx.last_transmission_at,
                transmission_tracking_started_at=tx.tracking_started_at,
                printer_status=m.printer_status,
            ),
            now=now,
        )
        base = dict(shop_id=m.shop_id, machine_id=m.id)
        pending = light.pending_documents or 0
        if light.status == MachineStatus.OFFLINE_WITH_UNSYNCED:
            out.append((Item(
                id=f"offline:{m.id}", kind="till_offline_unsynced", group="devices", severity="high",
                since=_utc(m.last_heartbeat_at), title="קופה לא מחוברת עם מכירות שלא נשלחו",
                detail=f"{pending} מסמכים ממתינים לשליחה", link=f"/dashboard/machines/{m.id}", **base,
            ), "offline"))
        elif light.status == MachineStatus.OFFLINE:
            out.append((Item(
                id=f"offline:{m.id}", kind="till_offline", group="devices", severity="high",
                since=_utc(m.last_heartbeat_at), title="קופה לא מחוברת",
                detail="המשמרת פתוחה והקופה לא מחוברת לענן", link=f"/dashboard/machines/{m.id}", **base,
            ), "offline"))
        elif light.status == MachineStatus.PENDING_SYNC:
            out.append((Item(
                id=f"pending:{m.id}", kind="pending_sync", group="devices", severity="low",
                since=_utc(m.pending_count_at), title="מכירות שעוד לא נשלחו",
                detail=f"{pending} מסמכים ממתינים לשליחה", link=f"/dashboard/machines/{m.id}", **base,
            ), None))
        flags = set(light.flags)
        if MachineFlag.PRINTER_PROBLEM in flags:
            out.append((Item(
                id=f"printer:{m.id}", kind="till_printer", group="devices", severity="medium",
                since=_utc(getattr(m, "printer_status_at", None)), title="תקלת מדפסת בקופה",
                detail=PRINTER_LABELS.get(m.printer_status) or getattr(m, "printer_message", None),
                link=f"/dashboard/machines/{m.id}", **base,
            ), "printer"))
        if MachineFlag.SHIFT_OPEN_PAST_ITS_DATE in flags and shift is not None:
            out.append((Item(
                id=f"shift:{m.id}", kind="shift_open_overdue", group="z_shift", severity="medium",
                since=_utc(shift.opened_at), title="משמרת פתוחה מעבר לתאריך שלה",
                detail=f"משמרת {shift.sequence_number}, יום עסקים {shift.business_date:%d.%m.%Y}"
                if shift.business_date else None,
                link=f"/dashboard/machines/{m.id}", **base,
            ), "shift_overdue"))
        if MachineFlag.CLOSED_SHIFTS_AWAITING_Z in flags:
            out.append((Item(
                id=f"awaitingz:{m.id}", kind="closed_shifts_awaiting_z", group="z_shift", severity="medium",
                since=None, since_date=oldest_awaiting, title="משמרות סגורות שממתינות ל-Z",
                detail=f"{awaiting_count} משמרות" + (f", הראשונה מ-{oldest_awaiting:%d.%m.%Y}" if oldest_awaiting else ""),
                link=f"/dashboard/shifts?awaitingZ=1&machine={m.id}", **base,
            ), "z_missing"))
        if MachineFlag.TRANSMISSION_OVERDUE in flags or MachineFlag.TRANSMISSION_CRITICAL in flags:
            critical = MachineFlag.TRANSMISSION_CRITICAL in flags
            count = tx.pending_count if tx.pending_count is not None else tx.untransmitted_legs
            out.append((Item(
                id=f"transmission:{m.id}", kind="card_transmission_overdue", group="card",
                severity="high" if critical else "medium",
                since=_utc(tx.oldest_pending_at or tx.last_transmission_at),
                title="שידור אשראי באיחור" + (" — קריטי" if critical else ""),
                detail=" · ".join(p for p in (
                    f"{count} עסקאות לא שודרו" if count else None,
                    _money(tx.pending_amount if tx.pending_amount is not None else tx.untransmitted_amount),
                ) if p) or None,
                link=f"/dashboard/machines/{m.id}#transmission", **base,
            ), "transmission"))
    return out


# ── Kiosks: their health view ────────────────────────────────────────────────


def _kiosk_items(db: Session, user: User, tenant_id: Any, now: datetime, *, company_id=None,
                 shop_id=None) -> List[Tuple[Item, Optional[str]]]:
    """
    The kiosks' parts that need someone, from `GET /kiosks/health`'s own view (which may note a
    kiosk offline in the exceptions, as that page does — the caller commits, as that route does).
    """
    from app.services import kiosk_control, kiosk_health

    if getattr(user, "role", None) not in kiosk_control.KIOSK_ROLES:
        return []
    try:
        view = kiosk_health.health_view(db, user, tenant_id, company_id=company_id, shop_id=shop_id, now=now)
    except HTTPException:
        return []
    out: List[Tuple[Item, Optional[str]]] = []
    for row in view.get("kiosks") or []:
        if row.get("enabled") is False:
            continue
        mid = row.get("machineId")
        base = dict(shop_id=row.get("shopId"), machine_id=mid)
        link = "/dashboard/kiosks/health"
        if not row.get("online"):
            # Like a till: offline is a problem while it trades (its shift open) — a kiosk switched
            # off for the night is not. (Its hours: the `kiosk_offline` log rows, listed above.)
            if row.get("shiftOpen"):
                out.append((Item(
                    id=f"kiosk-offline:{mid}", kind="kiosk_offline", group="devices", severity="high",
                    since=_parse(row.get("lastContactAt")), title="קיוסק לא מחובר", link=link, **base,
                ), "offline"))
            continue  # its parts' last word is stale
        for part in row.get("parts") or []:
            spec = KIOSK_PARTS.get(part.get("key"))
            level = part.get("level")
            if spec is None or level not in ("error", "warn"):
                continue
            if part.get("key") == "printer" and part.get("code") == "unprinted":
                continue  # its bons are the kitchen group's (`bon_unprinted`)
            kind, topic = spec
            detail = part.get("detail") or {}
            out.append((Item(
                id=f"kiosk-{part['key']}:{mid}", kind=kind, group="devices",
                severity="medium" if level == "error" else "low",
                since=_parse(detail.get("checkedAt") or detail.get("at") or detail.get("since")),
                title=f"{KIOSK_PART_LABELS.get(part['key'], part['key'])}: "
                      f"{KIOSK_CODE_LABELS.get(part.get('code'), part.get('code') or '')}",
                link=link, **base,
            ), topic))
    return out


def _parse(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return _utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return None


# ── Batteries ────────────────────────────────────────────────────────────────


def _battery_items(db: Session, machines: List[POSMachine]) -> List[Tuple[Item, Optional[str]]]:
    from app.services import battery_alerts

    alerts = battery_alerts.open_by_machine(db, [m.id for m in machines])
    by_id = {m.id: m for m in machines}
    out: List[Tuple[Item, Optional[str]]] = []
    for machine_id, alert in alerts.items():
        m = by_id.get(machine_id)
        if m is None:
            continue
        critical = alert.severity == "critical"
        percent = alert.last_percent if alert.last_percent is not None else alert.percent
        out.append((Item(
            id=f"battery:{machine_id}", kind="device_battery", group="devices",
            severity="medium" if critical else "low", since=_utc(alert.raised_at),
            title="סוללה חלשה" + (" מאוד" if critical else ""),
            detail=f"{percent}%" if percent is not None else None,
            link="/dashboard/kiosks/health", shop_id=m.shop_id, machine_id=m.id,
        ), "battery"))
    return out


# ── Card payments still undecided ────────────────────────────────────────────


def _payment_items(db: Session, reach: Reach, now: datetime, logged: Set[str], *, company_ids=None,
                   shop_id=None) -> List[Item]:
    from app.models.failed_payment import OUTCOME_UNRESOLVED, FailedPaymentAttempt
    from app.services import failed_payments as FP

    filters = FP.Filters(
        from_date=(now - timedelta(days=PAYMENTS_WINDOW_DAYS)).date(),
        to_date=now.date(),
        outcomes=(OUTCOME_UNRESOLVED,),
        shop_id=shop_id,
    )
    query = FP.attempts_query(db, reach.tenant_id, None, filters)  # unscoped: narrowed below, as the log
    query = reach.rows(query, FailedPaymentAttempt.shop_id, FailedPaymentAttempt.machine_id) if query is not None else None
    if query is None:
        return []
    if company_ids is not None:
        query = query.filter(FailedPaymentAttempt.company_id.in_(company_ids))
    rows = query.order_by(FailedPaymentAttempt.occurred_at.desc()).limit(GROUP_LIMIT * 4).all()
    # An attempt with a log row is that row's (open: listed as it; "טופל": handled) — only an
    # attempt the log never got is listed from here.
    ids = [str(a.id) for a in rows]
    in_log = {
        r[0] for r in db.query(ExceptionLogEntry.source_id).filter(
            ExceptionLogEntry.source == "failed_payment", ExceptionLogEntry.source_id.in_(ids),
        ).all()
    } if ids else set()
    out = []
    for a in rows:
        if str(a.id) in logged or str(a.id) in in_log:
            continue
        amount = (a.amount_agorot or 0) / 100
        out.append(Item(
            id=f"payment:{a.id}", kind="payment_unresolved", group="card", severity="high",
            since=_utc(a.occurred_at), title="תשלום באשראי לא הוכרע",
            detail=" · ".join(p for p in (_money(amount), " ".join(x for x in (a.card_brand or "", a.card_last4 or "") if x) or None) if p),
            link="/dashboard/transactions?method=failed", company_id=a.company_id, shop_id=a.shop_id,
            machine_id=a.machine_id, amount=amount,
        ))
    return out


# ── Z-Credit reconciliation ──────────────────────────────────────────────────


def _zcredit_items(db: Session, reach: Reach, machines: List[POSMachine], now: datetime, logged: Set[str]) -> List[Item]:
    from app.models.zcredit_reconciliation import HARD_CATEGORIES, ZCreditReconItem, ZCreditReconRun
    from app.routers.zcredit_reconciliation import _latest
    from app.services import zcredit_reconcile as ZR

    in_reach = {str(m.id): m for m in machines}
    if not in_reach:
        return []
    since = now.date() - timedelta(days=ZCREDIT_DAYS)
    runs = [
        r for r in db.query(ZCreditReconRun).filter(
            ZCreditReconRun.tenant_id == reach.tenant_id, ZCreditReconRun.business_date >= since,
        ).all()
        if set(r.machine_ids or []) & set(in_reach)
    ]
    latest = _latest(runs)
    if not latest:
        return []
    open_items: Dict[Any, List[Any]] = {}
    for i in db.query(ZCreditReconItem).filter(
        ZCreditReconItem.run_id.in_([r.id for r in latest]),
        ZCreditReconItem.category.in_(HARD_CATEGORIES),
        ZCreditReconItem.handled_at.is_(None),
    ).all():
        if (i.machine_id is None or str(i.machine_id) in in_reach) and str(i.id) not in logged:
            open_items.setdefault(i.run_id, []).append(i)
    out = []
    for r in latest:
        machine = next((in_reach[mid] for mid in (r.machine_ids or []) if mid in in_reach), None)
        base = dict(shop_id=machine.shop_id if machine else None, machine_id=machine.id if machine else None)
        day = r.business_date
        terminal = ZR.masked(r.terminal_last4)
        items = open_items.get(r.id) or []
        if items:
            out.append(Item(
                id=f"zcredit:{r.id}", kind="zcredit_recon", group="card", severity="high",
                since=_utc(r.finished_at or r.started_at), since_date=day,
                title="פערים בהתאמת Z-Credit",
                detail=f"{len(items)} פערים · מסוף {terminal} · {day:%d.%m.%Y}",
                link="/dashboard/zcredit-reconciliation", **base,
            ))
        if r.status == "failed":
            out.append(Item(
                id=f"zcredit-failed:{r.id}", kind="zcredit_run_failed", group="card", severity="medium",
                since=_utc(r.finished_at or r.started_at), since_date=day,
                title="התאמת Z-Credit לא הושלמה",
                detail=" · ".join(p for p in (f"מסוף {terminal}", f"{day:%d.%m.%Y}", r.error_message) if p),
                link="/dashboard/zcredit-reconciliation", **base,
            ))
    return out


# ── "טופל" ───────────────────────────────────────────────────────────────────


def ack_routes(db: Session, user: User) -> Tuple[bool, bool]:
    """
    Which "טופל" this user's dashboard may use: the log's own (`PATCH /exception-log/{id}`:
    "דוחות" or "התראות SMS" at edit), or the alerts' (`POST /push/alerts/{id}/ack`: "התראות"
    at edit, a push kind only). Neither for a cashier or a shift supervisor — the routes' rules.
    """
    from app.routers.exception_log import NO_ACK_ROLES
    from app.routers.push_alerts import may_acknowledge
    from app.services import dashboard_access as DA

    if user.role in NO_ACK_ROLES:
        return False, False
    access = DA.effective_access(db, user)
    via_log = access.allows("reports", "edit") or access.allows("exception_alerts", "edit")
    return via_log, may_acknowledge(db, user)


def resolve_via(entry: Optional[ExceptionLogEntry], routes: Tuple[bool, bool]) -> Optional[str]:
    from app.services.exception_alerts.push import category_of

    if entry is None:
        return None
    via_log, via_alerts = routes
    if via_log:
        return "log"
    if via_alerts and category_of(entry) is not None:
        return "alerts"
    return None


# ── The answer ───────────────────────────────────────────────────────────────


def build(db: Session, user: User, tenant_id: Any, *, hidden: Sequence[str] = (), company_id=None,
          shop_id=None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /problems`: counts by severity (the groups shown) and every group with its items."""
    from app.models.shop import Shop
    from app.services.company_hierarchy import descendant_company_ids

    now = _utc(now) or datetime.now(timezone.utc)
    reach = reach_for(db, user, tenant_id)
    company_ids = (descendant_company_ids(db, company_id) or [company_id]) if company_id is not None else None
    groups = [g for g in GROUPS if reach.super_admin or g not in SUPER_ADMIN_GROUPS]

    # 1. The open log rows: they win over a reading of the same thing.
    rows = _log_rows(db, reach, now, company_ids=company_ids, shop_id=shop_id)
    items: List[Item] = [_log_item(r) for r in rows]
    topics: Set[Tuple[Any, str]] = set()
    shop_topics: Set[Tuple[Any, str]] = set()
    logged: Set[str] = set()
    for r in rows:
        topic = TOPIC_OF_KIND.get(r.kind)
        if topic is not None:
            if r.machine_id is not None:
                topics.add((str(r.machine_id), topic))
            elif r.shop_id is not None:
                shop_topics.add((str(r.shop_id), topic))
        if r.kind == "failed_payment" and r.source_id:
            logged.add(str(r.source_id))
    # A Z-Credit gap with a log row is that row's, open or "טופל".
    if reach.log_query is not None:
        for (details,) in reach.log_query.filter(
            ExceptionLogEntry.kind == "zcredit_recon",
            ExceptionLogEntry.occurred_at >= now - timedelta(days=ZCREDIT_DAYS + 2),
        ).with_entities(ExceptionLogEntry.details).limit(LOG_FETCH_MAX).all():
            item_id = details.get("itemId") if isinstance(details, dict) else None
            if item_id:
                logged.add(str(item_id))

    def fresh(pairs: Iterable[Tuple[Item, Optional[str]]]) -> None:
        for item, topic in pairs:
            if topic is not None and (
                (str(item.machine_id), topic) in topics or (str(item.shop_id), topic) in shop_topics
            ):
                continue
            items.append(item)

    # 2. The devices in reach.
    machines: List[POSMachine] = []
    mq = reach.machines(db)
    if mq is not None:
        mq = mq.filter(
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.shop_id.isnot(None),
        )
        if shop_id is not None:
            mq = mq.filter(POSMachine.shop_id == shop_id)
        if company_ids is not None:
            mq = mq.filter(POSMachine.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(company_ids))))
        machines = mq.all()
    kiosks = _kiosk_ids(db, [m.id for m in machines])
    tills = [m for m in machines if m.id not in kiosks and getattr(m, "is_fiscal", True) is not False]
    fresh(_till_items(db, tills, now))
    fresh(_kiosk_items(db, user, tenant_id, now, company_id=company_id if shop_id is None else None, shop_id=shop_id))
    fresh(_battery_items(db, machines))
    # 3. Card payments and Z-Credit.
    items.extend(_payment_items(db, reach, now, logged, company_ids=company_ids, shop_id=shop_id))
    items.extend(_zcredit_items(db, reach, machines, now, logged))

    # Names, in one read each.
    shop_ids = {i.shop_id for i in items if i.shop_id is not None}
    machine_ids = {i.machine_id for i in items if i.machine_id is not None}
    shops = {
        str(s.id): s for s in db.query(Shop).filter(Shop.id.in_([_as_uuid(x) for x in shop_ids])).all()
    } if shop_ids else {}
    known = {str(m.id): m for m in machines}
    missing = [_as_uuid(x) for x in machine_ids if str(x) not in known]
    if missing:
        known.update({str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(missing)).all()})

    routes = ack_routes(db, user)
    hidden_set = {g for g in hidden if g in groups}
    by_group: Dict[str, List[Item]] = {g: [] for g in groups}
    for item in items:
        if item.group in by_group:
            by_group[item.group].append(item)
    counts = {s: 0 for s in SEVERITIES}
    out_groups = []
    for g in groups:
        listed = sorted(by_group[g], key=_order)
        own = {s: 0 for s in SEVERITIES}
        for item in listed:
            own[item.severity] = own.get(item.severity, 0) + 1
        if g not in hidden_set:
            for key, n in own.items():
                counts[key] = counts.get(key, 0) + n
        out_groups.append({
            "key": g,
            "hidden": g in hidden_set,
            "total": len(listed),
            "counts": own,
            "items": [_item_json(i, shops, known, routes) for i in listed[:GROUP_LIMIT]],
        })
    return {
        "generatedAt": now.isoformat(),
        "counts": counts,
        "total": sum(counts.values()),
        "hiddenGroups": [g for g in groups if g in hidden_set],
        "groups": out_groups,
    }


def _as_uuid(value: Any):
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return value


def _order(item: Item):
    """Most severe first, then the newest."""
    moment = item.since or (
        datetime.combine(item.since_date, time.min, tzinfo=timezone.utc) if item.since_date else None
    )
    return (_SEVERITY_RANK.get(item.severity, 1), -(moment.timestamp() if moment else 0), item.id)


def _item_json(item: Item, shops: Dict[str, Any], machines: Dict[str, POSMachine], routes) -> Dict[str, Any]:
    shop = shops.get(str(item.shop_id)) if item.shop_id is not None else None
    machine = machines.get(str(item.machine_id)) if item.machine_id is not None else None
    company = item.company_id if item.company_id is not None else (shop.company_id if shop is not None else None)
    via = resolve_via(item.entry, routes)
    since = _iso(item.since) if item.since is not None else (item.since_date.isoformat() if item.since_date else None)
    return {
        "id": item.id,
        "kind": item.kind,
        "severity": item.severity,
        "companyId": _str(company),
        "shopId": _str(item.shop_id),
        "shopName": shop.name if shop is not None else None,
        "machineId": _str(item.machine_id),
        "machineName": machine.name if machine is not None else None,
        "posNumber": (machine.pos_number or None) if machine is not None else None,
        "since": since,
        "title": item.title,
        "detail": item.detail,
        "link": item.link,
        "amount": item.amount,
        "exceptionId": str(item.entry.id) if item.entry is not None else None,
        "code": item.entry.short_code if item.entry is not None else None,
        # "טופל" — a log row, through the route this user's dashboard may use.
        "resolvable": via is not None,
        "resolveVia": via,
    }


# ── Hiding groups (per user, `users.preferences`) ────────────────────────────


def known_groups(user: User) -> List[str]:
    return [g for g in GROUPS if user.role == UserRole.SUPER_ADMIN or g not in SUPER_ADMIN_GROUPS]
